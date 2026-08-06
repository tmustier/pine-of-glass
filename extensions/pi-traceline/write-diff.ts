// Write pre-image snapshots and diff-stat parsing for traceline's `+N -M` inline
// mutation qualifiers (design language §9.5). Pi's edit tool reports a diff (or a
// streaming preview) directly; the write tool does not, so traceline captures the
// file's pre-image just before the write lands and computes the stats itself.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { stripAnsi } from "../_lib/ansi.ts";
import type { ToolRowDataLike } from "../_lib/chat.ts";

export type DiffStats = { added: number; removed: number };

const LCS_CELL_LIMIT = 200_000;

type WriteInput = { path: string; content: string; cwd: string };
type WriteSnapshot = WriteInput & { stats: DiffStats | undefined };

const pendingWriteSnapshots = new Map<string, WriteSnapshot>();

// Expects pre-normalized line endings (diffStatsFromContents normalizes once).
function splitDiffLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function boundedLcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length * b.length > LCS_CELL_LIMIT) return 0;

  let previous = new Array<number>(b.length + 1).fill(0);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    // No reset after the swap: index 0 is never written (both arrays start zeroed)
    // and every other cell is overwritten before the next row reads it.
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

export function diffStatsFromContents(oldContent: string, newContent: string): DiffStats | undefined {
  const oldNormalized = normalizeLineEndings(oldContent);
  const newNormalized = normalizeLineEndings(newContent);
  if (oldNormalized === newNormalized) return undefined;

  const oldLines = splitDiffLines(oldNormalized);
  const newLines = splitDiffLines(newNormalized);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const oldMiddle = oldLines.slice(start, oldEnd);
  const newMiddle = newLines.slice(start, newEnd);
  const unchangedMiddle = boundedLcsLength(oldMiddle, newMiddle);
  const stats = {
    added: Math.max(0, newMiddle.length - unchangedMiddle),
    removed: Math.max(0, oldMiddle.length - unchangedMiddle),
  };
  return stats.added > 0 || stats.removed > 0 ? stats : undefined;
}

function writeInputFromArgs(args: ToolRowDataLike["args"], cwd: string): WriteInput | undefined {
  const path = args?.path ?? args?.file_path;
  const content = args?.content;
  return typeof path === "string" && typeof content === "string" ? { path, content, cwd } : undefined;
}

function writeInput(comp: ToolRowDataLike | undefined): WriteInput | undefined {
  if (comp?.toolName !== "write") return undefined;
  const cwd = typeof comp.cwd === "string" && comp.cwd.length > 0 ? comp.cwd : process.cwd();
  return writeInputFromArgs(comp.args, cwd);
}

function readWriteOldContent(input: WriteInput): string {
  try {
    return readFileSync(resolve(input.cwd, input.path), "utf8");
  } catch {
    return "";
  }
}

function writeSnapshot(comp: ToolRowDataLike | undefined): WriteSnapshot | undefined {
  if (!comp) return undefined;
  let snapshot = comp.__tracelineWriteSnapshot as WriteSnapshot | undefined;
  if (!snapshot && typeof comp.toolCallId === "string") {
    snapshot = pendingWriteSnapshots.get(comp.toolCallId);
    if (snapshot) {
      comp.__tracelineWriteSnapshot = snapshot;
      pendingWriteSnapshots.delete(comp.toolCallId);
    }
  }
  return snapshot;
}

function sameWriteInput(a: WriteInput | undefined, b: WriteInput | undefined): boolean {
  return !!a && !!b && a.path === b.path && a.cwd === b.cwd && a.content === b.content;
}

export function captureWriteCallSnapshot(
  toolCallId: string,
  args: ToolRowDataLike["args"],
  cwd: string,
): void {
  pendingWriteSnapshots.delete(toolCallId);
  const input = writeInputFromArgs(args, cwd);
  if (!input) return;
  const oldContent = readWriteOldContent(input);
  pendingWriteSnapshots.set(toolCallId, {
    ...input,
    stats: diffStatsFromContents(oldContent, input.content),
  });
}

export function clearWriteCallSnapshots(): void {
  pendingWriteSnapshots.clear();
}

export function writeDiffStats(comp: ToolRowDataLike | undefined): DiffStats | undefined {
  const input = writeInput(comp);
  const snapshot = writeSnapshot(comp);
  if (!sameWriteInput(snapshot, input)) return undefined;
  return snapshot?.stats;
}

function diffTextFromComp(comp: ToolRowDataLike | undefined): string | undefined {
  const details = comp?.result?.details;
  if (typeof details?.diff === "string") return details.diff;
  if (typeof details?.patch === "string") return details.patch;

  // Pi's edit renderer computes a diff preview before the tool has settled. The preview
  // lives on the call renderer component, so collapsed rows can show `+N -M` while the
  // mutation is still pending, then switch to the result-backed diff once available.
  const preview = comp?.callRendererComponent?.preview;
  if (preview && typeof preview === "object" && !("error" in preview) && typeof preview.diff === "string") {
    return preview.diff;
  }
  return undefined;
}

export function diffStatsFromText(diff: string | undefined): DiffStats | undefined {
  if (!diff) return undefined;
  let added = 0;
  let removed = 0;
  for (const rawLine of diff.split(/\r?\n/)) {
    const line = stripAnsi(rawLine);
    if (line.startsWith("+++") || line.startsWith("---")) continue; // unified-patch file headers
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return added > 0 || removed > 0 ? { added, removed } : undefined;
}

// Parsing a diff is O(its length), and the block's shared fact columns (§9.7) ask
// every row for stats on every frame — so the parse caches per row against the diff
// text's identity. A settled row hits the reference-equality fast path; a streaming
// edit's changing preview text misses and re-parses. The write-snapshot fallback
// stays uncached: it is a handful of reference compares.
const diffTextStatsCache = new WeakMap<object, { text: string; stats: DiffStats | undefined }>();

export function mutationDiffStats(comp: ToolRowDataLike): DiffStats | undefined {
  const text = diffTextFromComp(comp);
  if (text === undefined) return writeDiffStats(comp);
  const cached = diffTextStatsCache.get(comp);
  if (cached && cached.text === text) return cached.stats ?? writeDiffStats(comp);
  const stats = diffStatsFromText(text);
  diffTextStatsCache.set(comp, { text, stats });
  return stats ?? writeDiffStats(comp);
}

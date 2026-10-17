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
  let unchangedMiddle = 0;
  if (oldMiddle.length > 0 && newMiddle.length > 0 && oldMiddle.length * newMiddle.length <= LCS_CELL_LIMIT) {
    let previous = Array.from({ length: newMiddle.length + 1 }, () => 0);
    let current = Array.from({ length: newMiddle.length + 1 }, () => 0);
    for (let i = 1; i <= oldMiddle.length; i++) {
      for (let j = 1; j <= newMiddle.length; j++) {
        current[j] = oldMiddle[i - 1] === newMiddle[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
      }
      // No reset after the swap: index 0 is never written (both arrays start zeroed)
      // and every other cell is overwritten before the next row reads it.
      [previous, current] = [current, previous];
    }
    unchangedMiddle = previous[newMiddle.length]!;
  }
  const stats = {
    added: newMiddle.length - unchangedMiddle,
    removed: oldMiddle.length - unchangedMiddle,
  };
  return stats.added > 0 || stats.removed > 0 ? stats : undefined;
}

function writeInputFromArgs(args: ToolRowDataLike["args"], cwd: string): WriteInput | undefined {
  const path = args?.path ?? args?.file_path;
  const content = args?.content;
  return typeof path === "string" && typeof content === "string" ? { path, content, cwd } : undefined;
}

export function captureWriteCallSnapshot(
  toolCallId: string,
  args: ToolRowDataLike["args"],
  cwd: string,
): void {
  pendingWriteSnapshots.delete(toolCallId);
  const input = writeInputFromArgs(args, cwd);
  if (!input) return;
  let oldContent = "";
  try {
    oldContent = readFileSync(resolve(input.cwd, input.path), "utf8");
  } catch {
    // A new or unreadable file has no available pre-image.
  }
  pendingWriteSnapshots.set(toolCallId, {
    ...input,
    stats: diffStatsFromContents(oldContent, input.content),
  });
}

export function clearWriteCallSnapshots(): void {
  pendingWriteSnapshots.clear();
}

export function writeDiffStats(comp: ToolRowDataLike | undefined): DiffStats | undefined {
  if (comp?.toolName !== "write") return undefined;
  const cwd = typeof comp.cwd === "string" && comp.cwd.length > 0 ? comp.cwd : process.cwd();
  const input = writeInputFromArgs(comp.args, cwd);
  // SAFETY: this module alone writes the row slot, from its typed pre-write capture.
  // The slot persists across reloads while the row keeps the same identity.
  let snapshot = comp.__tracelineWriteSnapshot as WriteSnapshot | undefined;
  if (!snapshot && typeof comp.toolCallId === "string") {
    snapshot = pendingWriteSnapshots.get(comp.toolCallId);
    if (snapshot) {
      comp.__tracelineWriteSnapshot = snapshot;
      pendingWriteSnapshots.delete(comp.toolCallId);
    }
  }
  if (!snapshot || !input || snapshot.path !== input.path || snapshot.cwd !== input.cwd || snapshot.content !== input.content) return undefined;
  return snapshot.stats;
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
  const details = comp?.result?.details;
  let text: string | undefined;
  if (typeof details?.diff === "string") text = details.diff;
  else if (typeof details?.patch === "string") text = details.patch;
  else {
    // Pi's edit renderer computes a diff preview before the tool has settled. The preview
    // lives on the call renderer component, so collapsed rows can show `+N -M` while the
    // mutation is still pending, then switch to the result-backed diff once available.
    const preview = comp?.callRendererComponent?.preview;
    if (preview && typeof preview === "object" && !("error" in preview) && typeof preview.diff === "string") {
      text = preview.diff;
    }
  }
  if (text === undefined) return writeDiffStats(comp);
  const cached = diffTextStatsCache.get(comp);
  if (cached && cached.text === text) return cached.stats ?? writeDiffStats(comp);
  const stats = diffStatsFromText(text);
  diffTextStatsCache.set(comp, { text, stats });
  return stats ?? writeDiffStats(comp);
}

// Loss-aware grouping for Traceline's two repetition folds. This module owns only
// membership and aggregation; index.ts keeps the family rendering grammar.
import {
  isAssistantRow,
  isToolRow,
  resultTextCharCount,
  type ToolRowDataLike,
  type ToolRowLike,
} from "../_lib/chat.ts";

export type FoldRun = { rows: ToolRowLike[]; index: number };

export function combinedResultChars(rows: ToolRowDataLike[]): number | undefined {
  let total: number | undefined;
  for (const row of rows) {
    const chars = resultTextCharCount(row);
    if (chars !== undefined) total = (total ?? 0) + chars;
  }
  return total;
}

type ReadFileGroup = { rows: ToolRowLike[]; breakout: boolean };

export function adjacentReadGroups(rows: ToolRowLike[]): Array<{ path: string; rows: ToolRowLike[] }> {
  const grouped: { path: string; rows: ToolRowLike[] }[] = [];
  for (const row of rows) {
    const path = String(row.args?.path ?? "");
    const last = grouped[grouped.length - 1];
    if (last && last.path === path) last.rows.push(row);
    else grouped.push({ path, rows: [row] });
  }
  return grouped;
}

function readFileGroups(rows: ToolRowLike[], warningChars: number): ReadFileGroup[] {
  return adjacentReadGroups(rows).map((group) => ({
    rows: group.rows,
    breakout: (combinedResultChars(group.rows) ?? 0) >= warningChars,
  }));
}

export function groupedReadRun(run: FoldRun, warningChars: number): FoldRun | undefined {
  const units: { rows: ToolRowLike[]; start: number; breakout: boolean }[] = [];
  let offset = 0;
  for (const group of readFileGroups(run.rows, warningChars)) {
    const open = units[units.length - 1];
    if (!group.breakout && open && !open.breakout) open.rows.push(...group.rows);
    else units.push({ rows: [...group.rows], start: offset, breakout: group.breakout });
    offset += group.rows.length;
  }
  const unit = units.find((candidate) =>
    run.index >= candidate.start && run.index < candidate.start + candidate.rows.length
  );
  if (!unit || unit.rows.length < 2) return undefined;
  return { rows: unit.rows, index: run.index - unit.start };
}

function assistantStepRows(comp: ToolRowLike, siblings: unknown[]): ToolRowLike[] | undefined {
  const id = typeof comp.toolCallId === "string" ? comp.toolCallId : undefined;
  if (!id) return undefined;
  for (const sibling of siblings) {
    if (!isAssistantRow(sibling)) continue;
    const content = sibling.lastMessage?.content;
    if (!Array.isArray(content)) continue;
    const ids = content.flatMap((block: unknown) => {
      if (!block || typeof block !== "object") return [];
      const call = block as { type?: unknown; id?: unknown };
      return call.type === "toolCall" && typeof call.id === "string" ? [call.id] : [];
    });
    if (!ids.includes(id)) continue;
    const stepIds = new Set(ids);
    return siblings.filter(
      (row): row is ToolRowLike =>
        isToolRow(row) && typeof row.toolCallId === "string" && stepIds.has(row.toolCallId),
    );
  }
  return undefined;
}

// Pi's durable toolCallId link scopes the fold. Adjacency alone would merge sequential
// assistant steps whose compact MCP rows happen to look the same.
export function groupedRepetitionRun(
  comp: ToolRowLike,
  siblings: unknown[],
  keyOf: (row: ToolRowLike) => string | undefined,
): FoldRun | undefined {
  const key = keyOf(comp);
  const step = key ? assistantStepRows(comp, siblings) : undefined;
  if (!key || !step) return undefined;
  const self = step.indexOf(comp);
  if (self < 0) return undefined;
  let start = self;
  let end = self + 1;
  while (start > 0 && step[start - 1]?.expanded !== true) start--;
  while (end < step.length && step[end]?.expanded !== true) end++;
  const rows = step.slice(start, end).filter((row) => keyOf(row) === key);
  if (rows.length < 2) return undefined;
  return { rows, index: rows.indexOf(comp) };
}

export function foldedStatus(
  rows: ToolRowDataLike[],
  statusOf: (row: ToolRowDataLike) => "success" | "running" | "error",
): "success" | "running" | "error" {
  if (rows.some((row) => statusOf(row) === "error")) return "error";
  if (rows.some((row) => statusOf(row) === "running")) return "running";
  return "success";
}

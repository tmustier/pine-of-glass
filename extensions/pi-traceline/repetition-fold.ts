import {
  isAssistantRow,
  isToolRow,
  resultTextCharCount,
  type ToolRowDataLike,
  type ToolRowLike,
} from "../_lib/chat.ts";

type FoldRun = { rows: ToolRowLike[]; index: number };

function assign(plan: Map<ToolRowLike, FoldRun>, rows: ToolRowLike[]): void {
  if (rows.length > 1) rows.forEach((row, index) => plan.set(row, { rows, index }));
}

/** Partition each maximal read run once; every member then has an O(1) lookup. */
export function readPlan(
  block: ToolRowLike[], warning: number, find: (row: ToolRowLike) => FoldRun | undefined,
): Map<ToolRowLike, FoldRun> {
  const plan = new Map<ToolRowLike, FoldRun>();
  const visited = new Set<ToolRowLike>();
  for (const row of block) {
    if (visited.has(row)) continue;
    const run = find(row);
    if (!run) { visited.add(row); continue; }
    run.rows.forEach((member) => visited.add(member));
    let unit: ToolRowLike[] = [];
    for (const group of adjacentReadGroups(run.rows)) {
      if ((combinedResultChars(group.rows) ?? 0) >= warning) {
        assign(plan, unit); unit = [];
        assign(plan, group.rows);
      } else unit.push(...group.rows);
    }
    assign(plan, unit);
  }
  return plan;
}

/** Repetition is assistant-step scoped; expanded rows partition that step. */
export function repetitionPlan(
  step: ToolRowLike[], keyOf: (row: ToolRowLike) => string | undefined,
): Map<ToolRowLike, FoldRun> {
  const plan = new Map<ToolRowLike, FoldRun>();
  let groups = new Map<string, ToolRowLike[]>();
  const flush = () => { for (const rows of groups.values()) assign(plan, rows); groups = new Map(); };
  for (const row of step) {
    if (row.expanded === true) { flush(); continue; }
    const key = keyOf(row);
    if (key === undefined) continue;
    const rows = groups.get(key);
    if (rows) rows.push(row); else groups.set(key, [row]);
  }
  flush();
  return plan;
}

export function combinedResultChars(rows: ToolRowDataLike[]): number | undefined {
  let total: number | undefined;
  for (const row of rows) {
    const chars = resultTextCharCount(row);
    if (chars !== undefined) total = (total ?? 0) + chars;
  }
  return total;
}

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

export function groupedReadRun(run: FoldRun, warningChars: number): FoldRun | undefined {
  return readPlan(run.rows, warningChars, () => run).get(run.rows[run.index]!);
}

function assistantStepRows(comp: ToolRowLike, siblings: unknown[]): ToolRowLike[] | undefined {
  const id = typeof comp.toolCallId === "string" ? comp.toolCallId : undefined;
  if (!id) return undefined;
  for (const sibling of siblings) {
    if (!isAssistantRow(sibling)) continue;
    const content = sibling.lastMessage?.content;
    if (!Array.isArray(content)) continue;
    const stepIds = new Set<string>();
    for (const block of content) {
      const call = block && typeof block === "object" ? block as { type?: unknown; id?: unknown } : undefined;
      if (call?.type === "toolCall" && typeof call.id === "string") stepIds.add(call.id);
    }
    if (!stepIds.has(id)) continue;
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
  const step = assistantStepRows(comp, siblings);
  if (!step) return undefined;
  return repetitionPlan(step, keyOf).get(comp);
}

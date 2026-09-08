import type { ToolRowLike } from "../_lib/chat.ts";
import { adjacentReadGroups, combinedResultChars } from "./repetition-fold.ts";

type Run = { rows: ToolRowLike[]; index: number };
function assign(plan: Map<ToolRowLike, Run>, rows: ToolRowLike[]): void {
  if (rows.length > 1) rows.forEach((row, index) => plan.set(row, { rows, index }));
}

/** Partition each maximal read run once; every member then has an O(1) lookup. */
export function readPlan(
  block: ToolRowLike[], warning: number, find: (row: ToolRowLike) => Run | undefined,
): Map<ToolRowLike, Run> {
  const plan = new Map<ToolRowLike, Run>();
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
): Map<ToolRowLike, Run> {
  const plan = new Map<ToolRowLike, Run>();
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

import { isAssistantRow, isToolRow, type ContainerLike, type AssistantRowLike, type ToolRowLike } from "../_lib/chat.ts";
import type { TraceRenderCache } from "./render-cache.ts";
import { isEmptyConnector } from "./connectors.ts";

type Step = { assistant: object; rows: ToolRowLike[] };
type Index = {
  source: unknown[]; length: number; dirty: boolean;
  lastAssistant?: AssistantRowLike;
  positions: Map<unknown, number>; blocks: Map<ToolRowLike, ToolRowLike[]>; steps: Map<ToolRowLike, Step>;
};

/** Cheap topology is rebuilt once per membership change, never once per rendered row.
 * Unchanged group arrays retain identity so their cached plans survive tail appends.
 */
export class TraceTopology {
  private indexes = new WeakMap<ContainerLike, Index>();
  private cache: TraceRenderCache;
  private empty: (row: unknown) => boolean;
  constructor(cache: TraceRenderCache, empty: (row: unknown) => boolean) {
    this.cache = cache;
    this.empty = empty;
  }

  changed(chat: ContainerLike): void {
    const index = this.indexes.get(chat);
    if (index) index.dirty = true;
  }

  prepare(chat: ContainerLike): Index {
    const old = this.indexes.get(chat);
    if (old && !old.dirty && old.source === chat.children && old.length === chat.children.length) return old;
    const next: Index = { source: chat.children, length: chat.children.length, dirty: false,
      positions: new Map(), blocks: new Map(), steps: new Map() };
    const groups: ToolRowLike[][] = [];
    let block: ToolRowLike[] = [];
    const byId = new Map<string, ToolRowLike>();
    const assistants: object[] = [];
    for (let i = 0; i < chat.children.length; i++) {
      const row = chat.children[i];
      next.positions.set(row, i);
      if (isToolRow(row)) {
        if (typeof row.toolCallId === "string") byId.set(row.toolCallId, row);
        if (row.expanded === true) { if (block.length) groups.push(block); block = []; }
        else block.push(row);
      } else {
        if (isAssistantRow(row)) { assistants.push(row); next.lastAssistant = row; }
        if (!this.empty(row)) { if (block.length) groups.push(block); block = []; }
      }
    }
    if (block.length) groups.push(block);
    const retained = new Set<object>();
    for (const rows of groups) {
      const previous = old?.blocks.get(rows[0]!);
      const stable = previous && equalRows(previous, rows) ? previous : rows;
      retained.add(stable);
      for (const row of stable) next.blocks.set(row, stable);
    }
    for (const assistant of assistants) {
      if (!isAssistantRow(assistant)) continue;
      const content = assistant.lastMessage?.content;
      if (!Array.isArray(content)) continue;
      const rows: ToolRowLike[] = [];
      for (const item of content) {
        if (item?.type === "toolCall" && typeof item.id === "string") {
          const row = byId.get(item.id);
          if (row) rows.push(row);
        }
      }
      rows.sort((a, b) => next.positions.get(a)! - next.positions.get(b)!);
      if (!rows.length) continue;
      const previous = old?.steps.get(rows[0]!);
      const step = previous?.assistant === assistant && equalRows(previous.rows, rows)
        ? previous : { assistant, rows };
      retained.add(step.rows);
      for (const row of rows) next.steps.set(row, step);
    }
    if (old) {
      for (const token of new Set([...old.blocks.values(), ...[...old.steps.values()].map((step) => step.rows)])) {
        if (!retained.has(token)) this.cache.dirty(token);
      }
    }
    this.indexes.set(chat, next);
    return next;
  }

  block(chat: ContainerLike, row: ToolRowLike): ToolRowLike[] {
    const rows = this.prepare(chat).blocks.get(row) ?? [row];
    this.cache.depend(rows);
    return rows;
  }

  step(chat: ContainerLike, row: ToolRowLike): Step | undefined {
    const step = this.prepare(chat).steps.get(row);
    if (step) { this.cache.depend(step.rows); this.cache.depend(step.assistant); }
    return step;
  }
}

export function uncachedBlockRows(sibs: unknown[], index: number): ToolRowLike[] {
  const breaks = (row: unknown) => isToolRow(row) ? row.expanded === true : !isEmptyConnector(row);
  let start = index;
  while (start > 0 && !breaks(sibs[start - 1])) start--;
  const rows: ToolRowLike[] = [];
  for (let i = start; i < sibs.length && !breaks(sibs[i]); i++) {
    const row = sibs[i];
    if (isToolRow(row)) rows.push(row);
  }
  return rows;
}

function equalRows(a: ToolRowLike[], b: ToolRowLike[]): boolean {
  return a.length === b.length && a.every((row, index) => row === b[index]);
}

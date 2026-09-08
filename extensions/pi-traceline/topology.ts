import { isAssistantRow, isToolRow, type ContainerLike, type AssistantRowLike, type ToolRowDataLike, type ToolRowLike } from "../_lib/chat.ts";
import type { TraceRenderCache } from "./render-cache.ts";

export function isExpandedToolRow(row: unknown): boolean { return isToolRow(row) && row.expanded === true; }

export function isEmptyConnector(row: unknown): boolean {
  if (!isAssistantRow(row)) return false;
  const content = row.lastMessage?.content;
  if (!Array.isArray(content)) return true;
  return !content.some((block: unknown) => {
    if (!block || typeof block !== "object") return false;
    const b = block as { type?: unknown; text?: unknown; thinking?: unknown };
    return (b.type === "text" && typeof b.text === "string" && b.text.trim()) ||
      (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim());
  });
}

export function isCollapsedThinkingRow(row: unknown): boolean {
  if (!isAssistantRow(row) || row.hideThinkingBlock !== true) return false;
  const content = row.lastMessage?.content;
  if (!Array.isArray(content)) return false;
  let hasThinking = false;
  for (const block of content) {
    if (block?.type === "text" && block.text?.trim()) return false;
    if (block?.type === "thinking" && block.thinking?.trim()) hasThinking = true;
  }
  return hasThinking;
}

type Step = { assistant: object; rows: ToolRowLike[] };
type BashLink = { previous: ToolRowLike | undefined };
type Index = {
  source: unknown[]; length: number; dirty: boolean;
  lastAssistant?: AssistantRowLike;
  bashLinks: Map<ToolRowDataLike, BashLink>;
  positions: Map<unknown, number>; blocks: Map<ToolRowLike, ToolRowLike[]>; steps: Map<ToolRowLike, Step>;
};

/** Cheap topology is rebuilt once per membership change, never once per rendered row.
 * Unchanged group arrays retain identity so their cached plans survive tail appends.
 */
export class TraceTopology {
  private indexes = new WeakMap<ContainerLike, Index>();
  private cache: TraceRenderCache;
  constructor(cache: TraceRenderCache) { this.cache = cache; }

  changed(chat: ContainerLike): void {
    const index = this.indexes.get(chat);
    if (index) index.dirty = true;
  }

  prepare(chat: ContainerLike): Index {
    const old = this.indexes.get(chat);
    if (old && !old.dirty && old.source === chat.children && old.length === chat.children.length) return old;
    const next: Index = { source: chat.children, length: chat.children.length, dirty: false,
      positions: new Map(), blocks: new Map(), steps: new Map(), bashLinks: new Map() };
    const groups: ToolRowLike[][] = [];
    let block: ToolRowLike[] = [];
    const byId = new Map<string, ToolRowLike>();
    const assistants: AssistantRowLike[] = [];
    let previousBash: ToolRowLike | undefined;
    for (let i = 0; i < chat.children.length; i++) {
      const row = chat.children[i];
      next.positions.set(row, i);
      if (isToolRow(row)) {
        const previousLink = old?.bashLinks.get(row);
        next.bashLinks.set(row, previousLink && previousLink.previous === previousBash ? previousLink : { previous: previousBash });
        if (row.toolName === "bash") previousBash = row;
        if (typeof row.toolCallId === "string") byId.set(row.toolCallId, row);
        if (row.expanded === true) { if (block.length) groups.push(block); block = []; }
        else block.push(row);
      } else {
        const empty = isEmptyConnector(row);
        if (!empty && !isCollapsedThinkingRow(row)) previousBash = undefined;
        if (isAssistantRow(row)) { assistants.push(row); next.lastAssistant = row; }
        if (!empty) { if (block.length) groups.push(block); block = []; }
      }
    }
    if (block.length) groups.push(block);
    const retained = new Set<object>(next.bashLinks.values());
    for (const rows of groups) {
      const previous = old?.blocks.get(rows[0]!);
      const stable = previous && equalRows(previous, rows) ? previous : rows;
      retained.add(stable);
      for (const row of stable) next.blocks.set(row, stable);
    }
    for (const assistant of assistants) {
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
      for (const token of new Set<object>([...old.bashLinks.values(), ...old.blocks.values(), ...[...old.steps.values()].map((step) => step.rows)])) {
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

  previousBash(chat: ContainerLike, row: ToolRowDataLike): ToolRowLike | undefined {
    const link = this.prepare(chat).bashLinks.get(row);
    if (link) { this.cache.depend(link); this.cache.depend(link.previous); }
    return link?.previous;
  }

  step(chat: ContainerLike, row: ToolRowLike): Step | undefined {
    const step = this.prepare(chat).steps.get(row);
    if (step) { this.cache.depend(step.rows); this.cache.depend(step.assistant); }
    return step;
  }
}

function equalRows(a: ToolRowLike[], b: ToolRowLike[]): boolean {
  return a.length === b.length && a.every((row, index) => row === b[index]);
}

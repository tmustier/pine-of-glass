import type { AssistantRowDataLike, AssistantRowPrototypeLike, ContainerLike, ToolRowDataLike } from "../_lib/chat.ts";
import type { TraceRenderCache } from "./render-cache.ts";
import { isEmptyConnector, isCollapsedThinkingRow } from "./topology.ts";

const objectKeys = new WeakMap<object, number>();
let nextObjectKey = 1;
export function objectCacheKey(value: object | undefined): string {
  if (!value) return "none";
  let key = objectKeys.get(value);
  if (!key) objectKeys.set(value, key = nextObjectKey++);
  return String(key);
}

export function cachedIntrinsic<T>(cache: TraceRenderCache, key: string, compute: (row: ToolRowDataLike) => T) {
  return (row: ToolRowDataLike | undefined): T | undefined => row ? cache.memo(row, key, () => compute(row)) : undefined;
}

export function installAssistantCacheHook(
  proto: AssistantRowPrototypeLike, beforeRender: (row: AssistantRowDataLike) => void,
  dirty: (row: AssistantRowDataLike) => void,
): void {
  const original = (proto.__tracelineOriginalAssistantRender ?? proto.render)!;
  proto.__tracelineOriginalAssistantRender = original;
  const fingerprints = new WeakMap<AssistantRowDataLike, string>();
  const changed = (row: AssistantRowDataLike) => {
    const content = row.lastMessage?.content;
    const ids = Array.isArray(content) ? content.filter((block) => block?.type === "toolCall").map((block) => block.id) : [];
    const fingerprint = JSON.stringify([row.hideThinkingBlock, isEmptyConnector(row), isCollapsedThinkingRow(row), ids]);
    if (fingerprints.get(row) !== fingerprint) { fingerprints.set(row, fingerprint); dirty(row); }
  };
  proto.render = function (this: AssistantRowDataLike, width: number) {
    if (!fingerprints.has(this)) changed(this);
    beforeRender(this); return original.call(this, width);
  };
  const update = proto.__tracelineOriginalUpdateContent ?? proto.updateContent;
  proto.__tracelineOriginalUpdateContent = update;
  proto.updateContent = function (this: AssistantRowDataLike, ...args: unknown[]) {
    const result = update.apply(this, args);
    changed(this);
    return result;
  };
}

// Rebind on reload. Watch addChild because appendEntry emits no extension event.
export function installContainerCacheHooks(
  cache: TraceRenderCache, chat: ContainerLike, changed: () => void, added: (child: unknown) => void = () => {},
): void {
  if (chat.__tracelineCachePatched) { Object.assign(chat.__tracelineCachePatched, { changed, added }); return; }
  const binding = { changed, added };
  if (typeof chat.addChild === "function") {
    const original = chat.addChild.bind(chat);
    chat.addChild = (child: unknown) => { const result = original(child); binding.changed(); binding.added(child); return result; };
  }
  if (typeof chat.removeChild === "function") {
    const original = chat.removeChild.bind(chat);
    chat.removeChild = (child: unknown) => { cache.dirty(child); const result = original(child); binding.changed(); return result; };
  }
  if (typeof chat.clear === "function") {
    const original = chat.clear.bind(chat);
    chat.clear = () => {
      for (const child of chat.children) cache.dirty(child);
      const result = original(); binding.changed(); return result;
    };
  }
  chat.__tracelineCachePatched = binding;
}

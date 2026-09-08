import type { AssistantRowDataLike, AssistantRowPrototypeLike, ContainerLike, ToolRowDataLike, ToolRowLike } from "../_lib/chat.ts";
import { installTraceMouse, type TraceMouseHost, type TraceMousePrototype } from "./click.ts";
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

export function installCachedTraceMouse(
  proto: TraceMousePrototype, cache: TraceRenderCache, host: TraceMouseHost, topologyChanged: () => void,
): void {
  const original = proto.__tracelineOriginalUpdateDisplay ?? proto.updateDisplay;
  proto.__tracelineOriginalUpdateDisplay = original;
  const expansions = new WeakMap<ToolRowLike, unknown>();
  proto.updateDisplay = function (this: ToolRowLike, ...args: unknown[]) {
    cache.dirty(this);
    if (expansions.get(this) !== this.expanded) { topologyChanged(); expansions.set(this, this.expanded); }
    return original.apply(this, args);
  };
  installTraceMouse(proto, host);
}

export function installAssistantCacheHook(
  proto: AssistantRowPrototypeLike, beforeRender: (row: AssistantRowDataLike) => void,
  dirty: (row: AssistantRowDataLike) => void,
): void {
  const original = (proto.__tracelineOriginalAssistantRender ?? proto.render)!;
  proto.__tracelineOriginalAssistantRender = original;
  const structureKeys = new WeakMap<AssistantRowDataLike, string>();
  const changed = (row: AssistantRowDataLike) => {
    const content = row.lastMessage?.content;
    const ids = Array.isArray(content) ? content.filter((block) => block?.type === "toolCall").map((block) => block.id) : [];
    const structureKey = JSON.stringify([row.hideThinkingBlock, isEmptyConnector(row), isCollapsedThinkingRow(row), ids]);
    if (structureKeys.get(row) !== structureKey) { structureKeys.set(row, structureKey); dirty(row); }
  };
  proto.render = function (this: AssistantRowDataLike, width: number) {
    if (!structureKeys.has(this)) changed(this);
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

/** Rebind the callback on reload without stacking wrappers on the live container. */
export function installContainerCacheHooks(cache: TraceRenderCache, chat: ContainerLike, changed: () => void): void {
  if (chat.__tracelineCachePatched) { chat.__tracelineCachePatched.changed = changed; return; }
  const binding = { changed };
  if (typeof chat.addChild === "function") {
    const original = chat.addChild.bind(chat);
    chat.addChild = (child: unknown) => { const result = original(child); binding.changed(); return result; };
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

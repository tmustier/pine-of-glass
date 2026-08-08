import type { Component } from "@earendil-works/pi-tui";
import { stripAnsi } from "../_lib/ansi.ts";
import { findContainerBy, isResourceRow, type ContainerLike } from "../_lib/chat.ts";

export type ContextimateTui = {
  children?: unknown[];
  requestRender?: (force?: boolean) => void;
};

export type PrefixBlock = Component & {
  __piContextimateBlock: true;
};

function renderPlain(component: Component, width = 120): string {
  try {
    return stripAnsi(component.render(width).join("\n"));
  } catch {
    return "";
  }
}

function isPrefixBlock(component: unknown): component is PrefixBlock {
  return !!component && typeof component === "object" && (component as { __piContextimateBlock?: boolean }).__piContextimateBlock === true;
}

function isResourceComponent(component: unknown): boolean {
  return !isPrefixBlock(component) && isResourceRow(component);
}

function isBlankComponent(component: Component): boolean {
  return renderPlain(component, 80).trim().length === 0;
}

function findResourceChatContainer(node: unknown): ContainerLike | undefined {
  return findContainerBy(node, (children) => children.some((child) => isResourceComponent(child)));
}

export function collectContainers(node: unknown, seen = new Set<unknown>(), out: ContainerLike[] = []): ContainerLike[] {
  if (!node || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  const children = (node as { children?: unknown[] }).children;
  if (!Array.isArray(children)) return out;
  out.push(node as ContainerLike);
  for (const child of children) collectContainers(child, seen, out);
  return out;
}

export function prefixBlockLocations(node: unknown): Array<{ container: ContainerLike; block: PrefixBlock }> {
  const locations: Array<{ container: ContainerLike; block: PrefixBlock }> = [];
  for (const container of collectContainers(node)) {
    for (const child of container.children) {
      if (isPrefixBlock(child)) locations.push({ container, block: child });
    }
  }
  return locations;
}

export function removeExistingPrefixBlocks(node: unknown): number {
  let removed = 0;
  for (const container of collectContainers(node)) {
    for (let index = container.children.length - 1; index >= 0; index--) {
      if (!isPrefixBlock(container.children[index])) continue;
      container.children.splice(index, 1);
      removed++;
    }
  }
  return removed;
}

function insertionIndexAfterResourceList(chat: ContainerLike): number {
  let index = -1;
  for (let i = 0; i < chat.children.length; i++) {
    if (!isResourceComponent(chat.children[i])) continue;
    index = i;
    if (i + 1 < chat.children.length && isBlankComponent(chat.children[i + 1] as Component)) index = i + 1;
  }
  return index;
}

export function findContextBlockTarget(
  tui: ContextimateTui | undefined,
  cached: ContainerLike | undefined,
): ContainerLike | undefined {
  if (!tui) return undefined;
  const liveContainers = collectContainers(tui);
  return (
    findResourceChatContainer(tui) ??
    findContainerBy(tui, (children) => children.some((child) => isPrefixBlock(child))) ??
    (cached && liveContainers.includes(cached) ? cached : undefined)
  );
}

export function reconcileContextBlockTree(root: unknown, target: ContainerLike, block: PrefixBlock): boolean {
  const locations = prefixBlockLocations(root);
  if (locations.length === 1 && locations[0]?.container === target && locations[0].block === block) return false;

  removeExistingPrefixBlocks(root);
  const insertAfter = insertionIndexAfterResourceList(target);
  const insertAt = insertAfter >= 0 ? insertAfter + 1 : 0;
  target.children.splice(insertAt, 0, block);
  return true;
}

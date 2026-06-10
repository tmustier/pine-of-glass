// Shared structural detection of pi's chat tree. All detection is duck-typed
// against extension-visible component shapes and contract-tested against the
// installed pi (tests/contract/pi-internals.test.ts), never imported from
// pi internals — that is what lets the family survive `pi update`.

/** A tool execution row: has setExpanded() and a toolName property. */
export function isToolRow(component: unknown): boolean {
  if (!component || typeof component !== "object") return false;
  const c = component as { render?: unknown; setExpanded?: unknown };
  if (c.constructor?.name === "ToolExecutionComponent") return true;
  return typeof c.render === "function" && typeof c.setExpanded === "function" && "toolName" in c;
}

/** An assistant message row: carries the hideThinkingBlock toggle. */
export function isAssistantRow(component: unknown): boolean {
  const c = component as { setHideThinkingBlock?: unknown; hideThinkingBlock?: unknown };
  return !!c && typeof c.setHideThinkingBlock === "function" && typeof c.hideThinkingBlock === "boolean";
}

export interface ContainerLike {
  children: unknown[];
  addChild?: (child: unknown) => void;
}

/** Depth-first search for the container whose direct children satisfy `predicate`. */
export function findContainerBy(
  node: unknown,
  predicate: (children: unknown[]) => boolean,
  seen = new Set<unknown>(),
): ContainerLike | undefined {
  if (!node || typeof node !== "object" || seen.has(node)) return undefined;
  seen.add(node);
  const children = (node as { children?: unknown[] }).children;
  if (Array.isArray(children)) {
    if (predicate(children)) return node as unknown as ContainerLike;
    for (const child of children) {
      const found = findContainerBy(child, predicate, seen);
      if (found) return found;
    }
  }
  return undefined;
}

/** pi's chat container: the one whose direct children include the chat rows. */
export function findChatContainer(node: unknown): ContainerLike | undefined {
  return findContainerBy(node, (children) => children.some((c) => isToolRow(c) || isAssistantRow(c)));
}

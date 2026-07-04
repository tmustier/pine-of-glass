// Shared structural detection of pi's chat tree. All detection is duck-typed
// against extension-visible component shapes and contract-tested against the
// installed pi (tests/contract/pi-internals.test.ts), never imported from
// pi internals — that is what lets the family survive `pi update`.
import { stripAnsi } from "./ansi.ts";

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

// The startup resource listing pi renders at session start: leaf ExpandableText
// sections whose first line is a [Section] header. Since pi 0.80 it lives in a
// loadedResourcesContainer rendered immediately before the chat container, making it
// the one reliable pre-rows landmark for finding that container in a fresh session
// (the welcome/changelog block is gated on updates). Same seam pi-contextimate has
// anchored on since v1.
export const RESOURCE_HEADER_RE = /^\s*\[(Context|Skills|Prompts|Extensions|Themes)\]/m;

/** A single startup resource section: a leaf component whose render carries a [Section] header. */
export function isResourceRow(component: unknown): boolean {
  const c = component as { render?: (width: number) => string[]; children?: unknown };
  if (!c || typeof c.render !== "function" || Array.isArray(c.children)) return false;
  try {
    return RESOURCE_HEADER_RE.test(stripAnsi(c.render(200).join("\n")));
  } catch {
    return false;
  }
}

/**
 * In pi 0.80.x, loaded resources moved out of chatContainer into a sibling
 * loadedResourcesContainer that is rendered immediately before chatContainer. Use that
 * ordering as the fresh-session fallback when there are no assistant/tool rows yet.
 */
function findChatContainerAfterResourceContainer(node: unknown, seen = new Set<unknown>()): ContainerLike | undefined {
  if (!node || typeof node !== "object" || seen.has(node)) return undefined;
  seen.add(node);

  const children = (node as { children?: unknown[] }).children;
  if (!Array.isArray(children)) return undefined;

  for (let i = 0; i < children.length - 1; i++) {
    const child = children[i];
    const next = children[i + 1];
    if (child && typeof child === "object" && next && typeof next === "object") {
      const childChildren = (child as { children?: unknown[] }).children;
      const nextChildren = (next as { children?: unknown[] }).children;
      if (Array.isArray(childChildren) && Array.isArray(nextChildren) && childChildren.some((c) => isResourceRow(c))) {
        return next as ContainerLike;
      }
    }
  }

  for (const child of children) {
    const found = findChatContainerAfterResourceContainer(child, seen);
    if (found) return found;
  }
  return undefined;
}

/** pi's chat container: the one whose direct children include the chat rows — or, in a
 * fresh session with no rows yet, the empty sibling immediately after the startup
 * resource listing (pi 0.80+). */
export function findChatContainer(node: unknown): ContainerLike | undefined {
  return (
    findContainerBy(node, (children) => children.some((c) => isToolRow(c) || isAssistantRow(c))) ??
    findChatContainerAfterResourceContainer(node)
  );
}

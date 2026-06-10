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

// The startup resource listing pi renders into the chat container at session start:
// leaf ExpandableText sections whose first line is a [Section] header. This is the
// chat container's only reliable pre-rows tenant (the welcome/changelog block is
// gated on updates), and the same seam pi-contextimate has anchored on since v1.
const RESOURCE_HEADER_RE = /^\s*\[(Context|Skills|Prompts|Extensions|Themes)\]/m;

function isResourceRow(component: unknown): boolean {
  const c = component as { render?: (width: number) => string[]; children?: unknown };
  if (!c || typeof c.render !== "function" || Array.isArray(c.children)) return false;
  try {
    return RESOURCE_HEADER_RE.test(stripAnsi(c.render(200).join("\n")));
  } catch {
    return false;
  }
}

/** pi's chat container: the one whose direct children include the chat rows — or, in a
 * fresh session with no rows yet, the startup resource listing. */
export function findChatContainer(node: unknown): ContainerLike | undefined {
  return (
    findContainerBy(node, (children) => children.some((c) => isToolRow(c) || isAssistantRow(c))) ??
    findContainerBy(node, (children) => children.some((c) => isResourceRow(c)))
  );
}

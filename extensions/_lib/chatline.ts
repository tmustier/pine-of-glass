// Anchored chat scrollback lines, shared by the family (cachemire, meantime).
//
// ctx.ui.notify force-dims and replaces consecutive status lines, so forensic family
// lines are appended straight to pi's chat container (found structurally via chat.ts).
//
// Persistence: pi rebuilds that container from session messages on several events
// (Ctrl+T's reasoning toggle, compaction, tree navigation): chatContainer.clear() plus
// a re-render drops every raw appended child, including pi's own status lines. Status
// lines are flotsam; family lines are forensic records, so each one is tracked with a
// durable anchor: the nearest preceding child with rebuild-stable identity (a tool
// row's toolCallId, or a message component's role#timestamp) plus the count of unkeyed
// children between anchor and line, and re-attached after every rebuild. When a rebuild
// no longer contains the anchor (compaction, branch navigation), the context the line
// annotated is gone, so it is dropped rather than re-attached misleadingly.
//
// Extracted from pi-cachemire (upstream-candidates.md entry 3: multiple extensions
// re-deriving this workaround is the evidence the seam deserves one implementation).

import { Spacer, Text } from "@earendil-works/pi-tui";
import { stripAnsi } from "./ansi.ts";
import { isJsonObject } from "./boundary.ts";
import { findChatContainer, type ContainerLike } from "./chat.ts";

export interface AnchoredLine<C = unknown> {
  spacer: C;
  text: C;
  /** Durable key of the nearest preceding keyed child; undefined = anchored to chat start. */
  anchorKey?: string;
  /** Unkeyed, non-family children between the anchor and this line's spacer. */
  gap: number;
}

export function childAnchorKey(child: unknown): string | undefined {
  const c = child as { toolCallId?: unknown; lastMessage?: { role?: unknown; timestamp?: unknown } } | undefined;
  if (typeof c?.toolCallId === "string") return `tool#${c.toolCallId}`;
  const message = c?.lastMessage;
  if (typeof message?.role === "string" && message.timestamp !== undefined) {
    return `${message.role}#${message.timestamp}`;
  }
  return undefined;
}

export function anchorForAppend(children: unknown[], anchored: AnchoredLine[]): { anchorKey?: string; gap: number } {
  const ours = new Set(anchored.flatMap((line) => [line.spacer, line.text]));
  let gap = 0;
  for (let i = children.length - 1; i >= 0; i--) {
    const key = childAnchorKey(children[i]);
    if (key !== undefined) return { anchorKey: key, gap };
    if (!ours.has(children[i])) gap++;
  }
  return { gap };
}

/** Re-insert tracked lines into a rebuilt children array (mutated in place). Returns the
 * survivors; lines whose anchor vanished are dropped. Idempotent: lines still present
 * (e.g. the hook fired without a rebuild) are left where they are. */
export function reattachAnchored(children: unknown[], anchored: AnchoredLine[]): AnchoredLine[] {
  const ours = new Set(anchored.flatMap((line) => [line.spacer, line.text]));
  const survivors: AnchoredLine[] = [];
  for (const line of anchored) {
    if (children.includes(line.text)) {
      survivors.push(line);
      continue;
    }
    let index = 0;
    if (line.anchorKey !== undefined) {
      const at = children.findIndex((child) => childAnchorKey(child) === line.anchorKey);
      if (at === -1) continue;
      index = at + 1;
    }
    // Walk the gap (skipping lines of ours already re-inserted, which don't count), then
    // past any of ours sitting exactly at the target so append order is preserved.
    let remaining = line.gap;
    while (index < children.length && (ours.has(children[index]) || remaining-- > 0)) index++;
    children.splice(index, 0, line.spacer, line.text);
    survivors.push(line);
  }
  return survivors;
}

/** The mutable state one extension keeps for its anchored lines. The extension owns the
 * object (usually inside its globalThis state), the helpers mutate it in place. */
export interface ChatLineHost {
  tui?: { requestRender?: (force?: boolean) => void };
  /** Cached chat container: rebuilds empty it of recognizable rows, but the instance
   * lives for the whole interactive session, so the first find stays valid. */
  chat?: ContainerLike;
  /** Chat lines this extension appended, with anchors for re-attachment. */
  anchored: AnchoredLine[];
  /** Degradation path when the chat container seam is unavailable. */
  notifyFallback?: (plainText: string) => void;
}

const CHAT_CLEAR_HOOK_VERSION = 1;

type HookableChatContainer = ContainerLike & {
  clear?: () => unknown;
  [key: string]: unknown;
};

function isHookableChatContainer(value: unknown): value is HookableChatContainer {
  return isJsonObject(value) && Array.isArray(value.children);
}

// Wrap the chat container's clear() (instance-level, original preserved) so every
// rebuild is followed by a re-attach. The rebuild that follows clear() is synchronous;
// a microtask runs after it completes, including pi's own trailing status line, so
// anchors are matched against the final rebuilt children. Keys are namespaced per
// extension: when two family members hook the same container their wrappers chain, and
// each re-attaches only its own lines.
function ensureChatClearHook(chat: unknown, ns: string, host: ChatLineHost): void {
  if (!isHookableChatContainer(chat)) return;
  const versionKey = `__piChatline_${ns}_ClearVersion`;
  const originalKey = `__piChatline_${ns}_OriginalClear`;
  if (typeof chat.clear !== "function" || chat[versionKey] === CHAT_CLEAR_HOOK_VERSION) return;
  // SAFETY: the container's clear() is a zero-arg method; the stored original is only
  // ever what this hook put there. Contract tests pin the clear()+children seam.
  const original = (chat[originalKey] as (() => unknown) | undefined) ?? chat.clear.bind(chat);
  chat[originalKey] = original;
  chat.clear = () => {
    const result = original();
    queueMicrotask(() => {
      if (host.anchored.length === 0) return;
      host.anchored = reattachAnchored(chat.children, host.anchored);
      host.tui?.requestRender?.(true);
    });
    return result;
  };
  chat[versionKey] = CHAT_CLEAR_HOOK_VERSION;
}

/** Append one spacer+text pair to pi's chat scrollback, tracked for re-attachment
 * across rebuilds. Returns the Text (so the caller can resolve it in place), or
 * undefined when the seam degraded to the notify fallback. */
export function appendAnchoredLine(host: ChatLineHost, ns: string, text: string): Text | undefined {
  const chat = (host.tui ? findChatContainer(host.tui) : undefined) ?? host.chat;
  if (chat?.addChild) {
    host.chat = chat;
    try {
      const line = new Text(text, 1, 0);
      const spacer = new Spacer(1);
      const anchor = anchorForAppend(chat.children, host.anchored);
      chat.addChild(spacer);
      chat.addChild(line);
      host.anchored.push({ spacer, text: line, ...anchor });
      ensureChatClearHook(chat, ns, host);
      host.tui?.requestRender?.(true);
      return line;
    } catch {
      // fall through to the notify fallback — never let a chat seam break a turn
    }
  }
  host.notifyFallback?.(stripAnsi(text));
  return undefined;
}

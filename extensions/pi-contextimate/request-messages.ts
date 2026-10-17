// Request-local additions do not belong in Pi's saved conversation. Persist only their
// sizes immediately before the billed response, so forks keep the metadata with it.
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import * as sessionSdk from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { isJsonObject } from "../_lib/boundary.ts";
import { countTextContent, countToolCallContent } from "./message-size.ts";
import { conversationTextAdditions, hasMessageImages, payloadTextAdditions } from "./request-text.ts";

const ENTRY_TYPE = "contextimate-request-messages";
type ProjectedEntry = { sourceEntry: SessionEntry; messages: AgentMessage[] };
type Projection = { messages: AgentMessage[]; entries: ProjectedEntry[] };
const projectionApi: {
  buildSessionContext: typeof buildSessionContext;
  buildSessionProjection?: (entries: SessionEntry[], leafId: string | null) => Projection;
} = sessionSdk;

export function projectAccountingSession(entries: SessionEntry[], leafId: string | null): Projection {
  if (projectionApi.buildSessionProjection) return projectionApi.buildSessionProjection(entries, leafId);
  // Pi 0.86 has neither projection provenance nor context edits. Its saved assistant
  // objects are the ones buildSessionContext returns, so identity is sufficient there.
  return { messages: buildSessionContext(entries, leafId).messages,
    entries: entries.flatMap((sourceEntry) => sourceEntry.type === "message"
      ? [{ sourceEntry, messages: [sourceEntry.message] }] : []) };
}

export type RequestMessages = {
  chars: number;
  count: number;
  /** False when a saved conversation message was removed or replaced. */
  additive: boolean;
};

function messageKey(message: Message): string {
  return createHash("sha256").update(JSON.stringify({ role: message.role, content: message.content,
    toolCallId: message.role === "toolResult" ? message.toolCallId : undefined })).digest("hex");
}

function additionCounts(saved: AgentMessage[], outgoing: AgentMessage[]): RequestMessages | undefined {
  const expected = convertToLlm(saved).filter((message) => message.role !== "system").map(messageKey);
  let index = 0;
  const added: Message[] = [];
  for (const message of convertToLlm(outgoing)) {
    if (message.role === "system") continue;
    if (messageKey(message) === expected[index]) index++;
    else added.push(message);
  }
  const additive = index === expected.length;
  if (added.length === 0 && additive) return undefined;
  if (!additive) return { chars: 0, count: 0, additive: false };
  const chars = added.reduce((sum, message) => sum + countTextContent(message.content)
    + (message.role === "assistant" ? message.content.reduce((total, block) =>
      total + (block.type === "toolCall" ? countToolCallContent(block) : 0), 0) : 0), 0);
  return { chars, count: added.length, additive: true };
}

export function observeRequestMessages(pi: ExtensionAPI, markDirty: () => void): void {
  let pending: RequestMessages | undefined;
  let nonTextChars = 0;
  let requestHasImages = false;
  let request: { saved: AgentMessage[]; payload: unknown } | undefined;
  pi.on("turn_start", () => { pending = undefined; nonTextChars = 0; request = undefined; requestHasImages = false; });
  pi.on("context_with_system", (event, ctx) => {
    const saved = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
    pending = additionCounts(saved, event.messages);
    requestHasImages = hasMessageImages(event.messages);
    nonTextChars = pending?.additive ? pending.chars - conversationTextAdditions(saved, event.messages).chars : 0;
  });
  pi.on("before_provider_request", (event, ctx) => {
    request = { saved: buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
      payload: structuredClone(event.payload) };
  });
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const response = event.message;
    // A virtual selection can have a different API. The response names the physical route.
    const model = ctx.modelRegistry.find(response.provider, response.model);
    if (request && model && !requestHasImages && pending?.additive !== false) {
      const text = await payloadTextAdditions(request.saved, request.payload, model);
      if (text) pending = !text.additive ? text : text.count > 0 || nonTextChars > 0
        ? { ...text, chars: text.chars + nonTextChars, count: Math.max(text.count, pending?.count ?? 0) }
        : undefined;
    }
    request = undefined;
    const counts = pending;
    pending = undefined;
    // Pi persists the assistant after message_end handlers. Its metadata is therefore
    // on its parent path, including when /tree or a fork selects the response itself.
    if (counts && response.stopReason !== "error" && response.stopReason !== "aborted") {
      pi.appendEntry(ENTRY_TYPE, { version: 1, ...counts });
      markDirty();
    }
  });
}

function parseCounts(data: unknown): RequestMessages | undefined {
  if (!isJsonObject(data)) return undefined;
  const { version, chars, count, additive } = data;
  if (version !== 1 || typeof additive !== "boolean"
    || typeof chars !== "number" || !Number.isSafeInteger(chars) || chars < 0
    || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined;
  return { chars, count, additive };
}

/** Projection provenance keeps counts attached when context edits clone a response. */
export function readRequestMessages(entries: SessionEntry[], leafId: string | null, projection: ProjectedEntry[]): Map<AssistantMessage, RequestMessages> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const afterCompaction = new Set<string>();
  let id = leafId;
  while (id !== null) {
    const entry = byId.get(id);
    if (!entry || entry.type === "compaction") break;
    afterCompaction.add(id);
    id = entry.parentId;
  }
  const counts = new Map<AssistantMessage, RequestMessages>();
  for (const { sourceEntry, messages } of projection) {
    if (sourceEntry.type !== "message" || sourceEntry.message.role !== "assistant") continue;
    let parent = sourceEntry.parentId === null ? undefined : byId.get(sourceEntry.parentId);
    while (parent && parent.type !== "message" && parent.type !== "compaction") {
      if (parent.type === "custom" && parent.customType === ENTRY_TYPE) {
        const record = parseCounts(parent.data);
        if (record) for (const message of messages) {
          if (message.role === "assistant") counts.set(message, afterCompaction.has(sourceEntry.id)
            ? record : { chars: 0, count: 0, additive: false });
        }
        break;
      }
      parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
    }
  }
  return counts;
}

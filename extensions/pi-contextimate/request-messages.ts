// Persist sizes before the billed response, never the request-local text itself.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import * as sessionSdk from "@earendil-works/pi-coding-agent";
import { buildSessionContext, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { isJsonObject } from "../_lib/boundary.ts";
import { measureRequestMessages, payloadTextAdditions, type RequestMessages } from "./request-text.ts";

const ENTRY_TYPE = "contextimate-request-messages";

export function observeRequestMessages(pi: ExtensionAPI, markDirty: () => void): void {
  let request: (ReturnType<typeof measureRequestMessages> & { saved: AgentMessage[]; payload?: unknown }) | undefined;
  pi.on("turn_start", () => { request = undefined; });
  pi.on("context_with_system", (event, ctx) => {
    const saved = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
    request = { saved, ...measureRequestMessages(saved, event.messages) };
  });
  pi.on("before_provider_request", (event) => {
    if (request) request.payload = structuredClone(event.payload);
  });
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant" || !request) return;
    const { saved, payload, nonTextChars, hasImages } = request;
    let { counts } = request;
    request = undefined;
    const response = event.message;
    if (response.stopReason === "error" || response.stopReason === "aborted") return;
    // A virtual selection can have a different API; the response names the physical route.
    const model = ctx.modelRegistry.find(response.provider, response.model);
    if (model && !hasImages && counts?.additive !== false) {
      const text = await payloadTextAdditions(saved, payload, model);
      if (text) {
        if (!text.additive) counts = text;
        else counts = text.chars > 0 || counts
          ? { additive: true, chars: text.chars + nonTextChars } : undefined;
      }
    }
    // Pi saves the assistant after message_end. Metadata stays on its parent path
    // even when /tree or a fork selects the response itself.
    if (counts) {
      pi.appendEntry(ENTRY_TYPE, { version: 1, ...counts });
      markDirty();
    }
  });
}

/** Return projected messages with request counts attached to their billed responses. */
export function accountingSession(entries: SessionEntry[], leafId: string | null) {
  // Pi 0.86 has no context edits or projection provenance; object identity suffices.
  const projection = sessionSdk.buildSessionProjection?.(entries, leafId) ?? {
    messages: buildSessionContext(entries, leafId).messages,
    entries: entries.flatMap((sourceEntry) => sourceEntry.type === "message"
      ? [{ sourceEntry, messages: [sourceEntry.message] }] : []),
  };
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const afterCompaction = new Set<string>();
  let id = leafId;
  while (id !== null) {
    const entry = byId.get(id);
    if (!entry || entry.type === "compaction") break;
    afterCompaction.add(id);
    id = entry.parentId;
  }
  const requestMessages = new Map<AssistantMessage, RequestMessages>();
  for (const { sourceEntry, messages } of projection.entries) {
    if (sourceEntry.type !== "message" || sourceEntry.message.role !== "assistant") continue;
    let parent = sourceEntry.parentId === null ? undefined : byId.get(sourceEntry.parentId);
    while (parent && parent.type !== "message" && parent.type !== "compaction") {
      if (parent.type !== "custom" || parent.customType !== ENTRY_TYPE) {
        parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
        continue;
      }
      const data = parent.data;
      if (isJsonObject(data) && data.version === 1) {
        let counts: RequestMessages | undefined;
        if (data.additive === false || !afterCompaction.has(sourceEntry.id)) counts = { additive: false };
        else if (data.additive === true
          && typeof data.chars === "number" && Number.isSafeInteger(data.chars) && data.chars >= 0) {
          counts = { additive: true, chars: data.chars };
        }
        if (counts) for (const message of messages) {
          if (message.role === "assistant") requestMessages.set(message, counts);
        }
      }
      break;
    }
  }
  return { messages: projection.messages, requestMessages };
}

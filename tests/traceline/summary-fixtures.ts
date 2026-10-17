// A registered provider for SDK-hosted summary tests. No request leaves the process.
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GistKind } from "../../extensions/pi-traceline/summaries.ts";
import { assistantMessage } from "../helpers.ts";

export const PROVIDER = "pog-summaries";
export type Asked = { kind: GistKind; text: string };
export const REPORTED_USAGE: Usage = {
  input: 1200, output: 40, cacheRead: 300, cacheWrite: 0, totalTokens: 1540,
  cost: { input: 0.012, output: 0.0004, cacheRead: 0.0003, cacheWrite: 0, total: 0.0127 },
};

/** Report usage and answer every item, or return the supplied reply/failure after a delay. */
export function summaryModel(pi: ExtensionAPI, asked: Asked[][], reply?: string | Error, delay = 0, usage: Usage = REPORTED_USAGE): void {
  pi.registerProvider(PROVIDER, {
    baseUrl: "http://127.0.0.1:9",
    apiKey: "fixture-never-sent",
    api: "openai-completions",
    models: [{ id: "gist", name: "Gist", reasoning: false, input: ["text"], cost: { input: 10, output: 10, cacheRead: 1, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 }],
    streamSimple: (_model, context) => {
      const user = context.messages.find((message) => message.role === "user");
      assert.ok(user && typeof user.content === "string", "summaries send one JSON text message");
      const items: (Asked & { id: string })[] = JSON.parse(user.content);
      asked.push(items.map(({ kind, text }) => ({ kind, text })));
      if (reply instanceof Error) throw reply;
      const gists = Object.fromEntries(items.map(({ id }) => [id, `gist ${asked.flat().length - items.length + Number(id)}`]));
      const message = assistantMessage([{ type: "text", text: reply ?? JSON.stringify(gists) }], { provider: PROVIDER, model: "gist", api: "openai-completions", usage });
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      }, delay);
      return stream;
    },
  });
}

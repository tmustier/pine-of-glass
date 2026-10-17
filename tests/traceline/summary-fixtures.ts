// A registered provider for SDK-hosted summary tests. No request leaves the process.
import { createAssistantMessageEventStream, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assistantMessage } from "../helpers.ts";

export const PROVIDER = "pog-summaries";
export type Asked = { kind: string; text: string };
export const REPORTED_USAGE: Usage = {
  input: 1200, output: 40, cacheRead: 300, cacheWrite: 0, totalTokens: 1540,
  cost: { input: 0.012, output: 0.0004, cacheRead: 0.0003, cacheWrite: 0, total: 0.0127 },
};

/** Report usage and answer every item, or return the supplied reply/failure after a delay. */
export function summaryModel(asked: Asked[][], reply?: string | Error, delay = 0, usage: Usage = REPORTED_USAGE) {
  return (pi: ExtensionAPI) => pi.registerProvider(PROVIDER, {
    baseUrl: "http://127.0.0.1:9",
    apiKey: "fixture-never-sent",
    api: "openai-completions",
    models: [{ id: "gist", name: "Gist", reasoning: false, input: ["text"], cost: { input: 10, output: 10, cacheRead: 1, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 }],
    streamSimple: (_model, context) => {
      const user = context.messages.find((message) => message.role === "user");
      const content = user?.role === "user" ? user.content : "";
      const items: { id: string; kind: string; text: string }[] = JSON.parse(typeof content === "string" ? content : content.map((block) => (block.type === "text" ? block.text : "")).join(""));
      asked.push(items.map(({ kind, text }) => ({ kind, text })));
      if (reply instanceof Error) throw reply;
      const gists = Object.fromEntries(items.map(({ id }) => [id, `gist ${asked.flat().length - items.length + Number(id)}`]));
      const message: AssistantMessage = assistantMessage([{ type: "text", text: reply ?? JSON.stringify(gists) }], { provider: PROVIDER, model: "gist", api: "openai-completions", usage });
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

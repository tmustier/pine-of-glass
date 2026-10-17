import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import piCachemire from "../../extensions/pi-cachemire/index.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

export const ANTHROPIC: Model<"anthropic-messages"> = {
  id: "claude-opus-4-8", name: "Claude Opus", provider: "anthropic", api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"],
  cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  contextWindow: 200_000, maxTokens: 8_000,
};

export const OPENAI: Model<"openai-responses"> = {
  ...ANTHROPIC, id: "gpt-5.4", name: "GPT-5.4", provider: "openai", api: "openai-responses",
  baseUrl: "https://api.openai.com/v1", reasoning: true,
};

export function billed(model: Pick<Model<string>, "provider" | "id" | "api">, input: number, cacheRead: number, cacheWrite = 0): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text: "answer" }],
    provider: model.provider, model: model.id, api: model.api, stopReason: "stop", timestamp: Date.now(),
    usage: {
      input, cacheRead, cacheWrite, output: 10, totalTokens: input + cacheRead + cacheWrite + 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export function payload(messages: string[], tools?: unknown[]) {
  return {
    model: ANTHROPIC.id,
    system: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral" } }],
    messages: messages.map((text) => ({ role: "user", content: [{ type: "text", text }] })),
    ...(tools ? { tools } : {}),
  };
}

export async function hostCachemire(options: Omit<Parameters<typeof hostExtension>[1], "project"> = {}) {
  const project = new IsolatedProject();
  const agentDir = join(project.home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(Object.fromEntries(
    ["anthropic", "openai"].map((provider) => [provider, { type: "api_key", key: "fixture" }]),
  )));
  try {
    const host = await hostExtension(piCachemire, { project, model: ANTHROPIC, ...options });
    return {
      ...host,
      async dispose() {
        try { await host.dispose(); } finally { project.dispose(); }
      },
    };
  } catch (error) {
    project.dispose();
    throw error;
  }
}

export type CachemireHost = Awaited<ReturnType<typeof hostCachemire>>;

export async function request(host: CachemireHost, body: unknown): Promise<void> {
  await host.session.extensionRunner.emitContext([]);
  await host.session.extensionRunner.emitBeforeProviderRequest(body);
}

export async function finish(host: CachemireHost, message: AssistantMessage): Promise<string> {
  await host.session.extensionRunner.emitMessageEnd({ type: "message_end", message });
  const messageEntryId = host.session.sessionManager.appendMessage(message);
  await host.session.extensionRunner.emitBoundary({
    type: "turn_end", turnIndex: 0, message, toolResults: [], messageEntryId, toolResultEntryIds: [], outcome: "completed",
  }, () => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false }));
  return messageEntryId;
}

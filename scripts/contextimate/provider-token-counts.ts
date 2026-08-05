import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { isJsonObject, type JsonObject, type JsonValue } from "../../extensions/_lib/boundary.ts";

export type PayloadKind = "anthropic" | "openai-responses" | "openai-chat" | "google" | "bedrock";

export type BuildOptions = {
  model?: string;
  tools?: string[];
};

export type CountRequest = {
  id: string;
  label: string;
  body: JsonObject;
  chars?: number;
};

export type CountSummary = {
  rows: Array<{
    id: string;
    label: string;
    tokens: number;
    marginal?: number;
    netTokens?: number;
    chars?: number;
    charsPerToken?: number;
  }>;
  toolOverhead?: number;
  suggestedHeuristic: { textDenominator?: number; toolDenominator?: number };
};

type Provider = {
  kinds: PayloadKind[];
  method: string;
  build(payload: JsonObject, options?: BuildOptions): CountRequest[];
  full?: (payload: JsonObject, options?: BuildOptions) => CountRequest;
  execute(body: JsonObject): Promise<number>;
};

const MINIMAL_MESSAGES: JsonValue[] = [{ role: "user", content: "hi" }];
const MINIMAL_RESPONSES_INPUT: JsonValue[] = [{ role: "user", content: [{ type: "input_text", text: "hi" }] }];
const MINIMAL_GOOGLE_CONTENTS: JsonValue[] = [{ role: "user", parts: [{ text: "hi" }] }];
const MINIMAL_BEDROCK_MESSAGES: JsonValue[] = [{ role: "user", content: [{ text: "hi" }] }];

function modelId(payload: JsonObject, override?: string): string {
  const model = override ?? payload.model ?? payload.modelId;
  if (typeof model !== "string") throw new Error("payload has no model; pass --model");
  return model;
}

function requireArray(payload: JsonObject, key: string): JsonValue[] {
  const value = payload[key];
  if (!Array.isArray(value)) throw new Error(`payload has no ${key} array`);
  return value;
}

function toolName(tool: JsonValue): string | undefined {
  if (!isJsonObject(tool)) return undefined;
  if (typeof tool.name === "string") return tool.name;
  if (isJsonObject(tool.function) && typeof tool.function.name === "string") return tool.function.name;
  if (isJsonObject(tool.toolSpec) && typeof tool.toolSpec.name === "string") return tool.toolSpec.name;
  return undefined;
}

function selectTools(value: JsonValue | undefined, names?: string[]): JsonValue[] {
  const tools = Array.isArray(value) ? value : [];
  if (!names?.length) return tools;
  const wanted = new Set(names);
  return tools.filter((tool) => wanted.has(toolName(tool) ?? ""));
}

function jsonChars(value: JsonValue): number {
  return typeof value === "string" ? value.length : JSON.stringify(value).length;
}

function textChars(value: JsonValue): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + textChars(item), 0);
  if (!isJsonObject(value)) return 0;
  if (typeof value.text === "string") return value.text.length;
  if (typeof value.content === "string") return value.content.length;
  if (Array.isArray(value.content)) return textChars(value.content);
  if (Array.isArray(value.parts)) return textChars(value.parts);
  return 0;
}

function toolRequests(
  tools: JsonValue[],
  body: (tools: JsonValue[]) => JsonObject,
  chars: (tools: JsonValue[]) => number = jsonChars,
): CountRequest[] {
  if (tools.length === 0) return [];
  return [
    { id: "tools", label: `all tools (${tools.length})`, body: body(tools), chars: chars(tools) },
    ...tools.map((tool, index) => {
      const name = toolName(tool) ?? `unnamed-${index + 1}`;
      return { id: `tool:${name}`, label: `tool ${name}`, body: body([tool]), chars: chars([tool]) };
    }),
  ];
}

export function detectPayloadKind(payload: unknown): PayloadKind | undefined {
  if (!isJsonObject(payload)) return undefined;
  if (typeof payload.modelId === "string" && Array.isArray(payload.messages)) return "bedrock";
  if (Array.isArray(payload.contents) && isJsonObject(payload.config)) return "google";
  if (Array.isArray(payload.input) || typeof payload.instructions === "string") return "openai-responses";
  if (!Array.isArray(payload.messages)) return undefined;
  if (payload.system !== undefined || (Array.isArray(payload.tools) && payload.tools.some((tool) => isJsonObject(tool) && "input_schema" in tool))) {
    return "anthropic";
  }
  return "openai-chat";
}

export function parsePayloadFile(text: string): { kind: PayloadKind; payload: JsonObject } {
  const trimmed = text.trim();
  const candidates: unknown[] = trimmed.startsWith("{") && !trimmed.includes("\n{")
    ? [JSON.parse(trimmed)]
    : trimmed.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  for (const candidate of candidates) {
    const kind = detectPayloadKind(candidate);
    if (kind && isJsonObject(candidate)) return { kind, payload: candidate };
  }
  throw new Error("no recognizable provider payload found");
}

export function buildAnthropicRequests(payload: JsonObject, options: BuildOptions = {}): CountRequest[] {
  const model = modelId(payload, options.model);
  const tools = selectTools(payload.tools, options.tools);
  const baseline = { model, messages: MINIMAL_MESSAGES };
  const requests: CountRequest[] = [{ id: "baseline", label: "baseline", body: baseline }];
  if (payload.system !== undefined) {
    requests.push({ id: "system", label: "system prompt", body: { ...baseline, system: payload.system }, chars: textChars(payload.system) });
  }
  requests.push(...toolRequests(tools, (selected) => ({ ...baseline, tools: selected })));
  if (payload.system !== undefined && tools.length > 0) {
    requests.push({ id: "full", label: "system and tools", body: { ...baseline, system: payload.system, tools } });
  }
  return requests;
}

export function buildAnthropicFullRequest(payload: JsonObject, options: BuildOptions = {}): CountRequest {
  const body: JsonObject = { model: modelId(payload, options.model), messages: requireArray(payload, "messages") };
  // The count endpoint omits generation-only fields and request metadata.
  for (const key of ["system", "tools", "tool_choice", "thinking", "output_config"] as const) {
    if (payload[key] !== undefined) body[key] = payload[key];
  }
  return { id: "captured", label: "captured request", body };
}

function openAISystemItems(payload: JsonObject): JsonValue[] {
  return requireArray(payload, "input").filter(
    (item) => isJsonObject(item) && (item.role === "system" || item.role === "developer"),
  );
}

export function buildOpenAIRequests(payload: JsonObject, options: BuildOptions = {}): CountRequest[] {
  const model = modelId(payload, options.model);
  const system = openAISystemItems(payload);
  const tools = selectTools(payload.tools, options.tools);
  const baseline = { model, input: MINIMAL_RESPONSES_INPUT };
  const requests: CountRequest[] = [{ id: "baseline", label: "baseline", body: baseline }];
  if (system.length > 0) {
    requests.push({ id: "system", label: "system input", body: { ...baseline, input: [...system, ...MINIMAL_RESPONSES_INPUT] }, chars: textChars(system) });
  }
  requests.push(...toolRequests(tools, (selected) => ({ ...baseline, tools: selected })));
  if (system.length > 0 && tools.length > 0) {
    requests.push({ id: "full", label: "system and tools", body: { ...baseline, input: [...system, ...MINIMAL_RESPONSES_INPUT], tools } });
  }
  return requests;
}

export function buildOpenAIFullRequest(payload: JsonObject, options: BuildOptions = {}): CountRequest {
  const body: JsonObject = { model: modelId(payload, options.model), input: requireArray(payload, "input") };
  // The count endpoint accepts this subset of the fields emitted by Pi's Responses adapter.
  for (const key of ["tools", "tool_choice", "reasoning"] as const) {
    if (payload[key] !== undefined) body[key] = payload[key];
  }
  return { id: "captured", label: "captured request", body };
}

function googleRequest(
  payload: JsonObject,
  contents: JsonValue[],
  modelOverride?: string,
  system?: JsonValue,
  tools?: JsonValue[],
  includeGenerationConfig = false,
): JsonObject {
  const config = isJsonObject(payload.config) ? payload.config : {};
  const model = modelId(payload, modelOverride).replace(/^models\//, "");
  const request: JsonObject = {
    model: `models/${model}`,
    contents,
    ...(system !== undefined && { systemInstruction: system }),
    ...(tools?.length && { tools }),
    ...(tools?.length && config.toolConfig !== undefined && { toolConfig: config.toolConfig }),
  };
  if (includeGenerationConfig) {
    const { systemInstruction: _system, tools: _tools, toolConfig: _toolConfig, abortSignal: _abort, ...generationConfig } = config;
    if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
  }
  return request;
}

export function buildGoogleRequests(payload: JsonObject, options: BuildOptions = {}): CountRequest[] {
  const config = isJsonObject(payload.config) ? payload.config : {};
  const declarations = Array.isArray(config.tools)
    ? config.tools.flatMap((tool) => isJsonObject(tool) && Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations : [])
    : [];
  const tools = selectTools(declarations, options.tools);
  const wrapTools = (selected: JsonValue[]): JsonValue[] => [{ functionDeclarations: selected }];
  const baseline = googleRequest(payload, MINIMAL_GOOGLE_CONTENTS, options.model);
  const requests: CountRequest[] = [{ id: "baseline", label: "baseline", body: { generateContentRequest: baseline } }];
  if (config.systemInstruction !== undefined) {
    requests.push({
      id: "system",
      label: "system instruction",
      body: { generateContentRequest: googleRequest(payload, MINIMAL_GOOGLE_CONTENTS, options.model, config.systemInstruction) },
      chars: textChars(config.systemInstruction),
    });
  }
  requests.push(...toolRequests(
    tools,
    (selected) => ({ generateContentRequest: googleRequest(payload, MINIMAL_GOOGLE_CONTENTS, options.model, undefined, wrapTools(selected)) }),
    (selected) => jsonChars({ functionDeclarations: selected }),
  ));
  if (config.systemInstruction !== undefined && tools.length > 0) {
    requests.push({
      id: "full",
      label: "system and tools",
      body: {
        generateContentRequest: googleRequest(payload, MINIMAL_GOOGLE_CONTENTS, options.model, config.systemInstruction, wrapTools(tools)),
      },
    });
  }
  return requests;
}

export function buildGoogleFullRequest(payload: JsonObject, options: BuildOptions = {}): CountRequest {
  const config = isJsonObject(payload.config) ? payload.config : {};
  return {
    id: "captured",
    label: "captured request",
    body: {
      generateContentRequest: googleRequest(
        payload,
        requireArray(payload, "contents"),
        options.model,
        config.systemInstruction,
        selectTools(config.tools),
        true,
      ),
    },
  };
}

export function buildVertexRequests(payload: JsonObject, options: BuildOptions = {}): CountRequest[] {
  return buildGoogleRequests(payload, options).map((request) => ({
    ...request,
    body: isJsonObject(request.body.generateContentRequest) ? request.body.generateContentRequest : request.body,
  }));
}

export function buildVertexFullRequest(payload: JsonObject, options: BuildOptions = {}): CountRequest {
  const request = buildGoogleFullRequest(payload, options);
  return {
    ...request,
    body: isJsonObject(request.body.generateContentRequest) ? request.body.generateContentRequest : request.body,
  };
}

export function buildBedrockRequests(payload: JsonObject, options: BuildOptions = {}): CountRequest[] {
  const modelIdValue = modelId(payload, options.model);
  const toolConfig = isJsonObject(payload.toolConfig) ? payload.toolConfig : {};
  const tools = selectTools(toolConfig.tools, options.tools);
  const converse = (system?: JsonValue, selectedTools: JsonValue[] = []): JsonObject => ({
    messages: MINIMAL_BEDROCK_MESSAGES,
    ...(system !== undefined && { system }),
    ...(selectedTools.length > 0 && { toolConfig: { ...toolConfig, tools: selectedTools } }),
  });
  const countBody = (input: JsonObject): JsonObject => ({ modelId: modelIdValue, input: { converse: input } });
  const requests: CountRequest[] = [{ id: "baseline", label: "baseline", body: countBody(converse()) }];
  if (payload.system !== undefined) {
    requests.push({ id: "system", label: "system prompt", body: countBody(converse(payload.system)), chars: textChars(payload.system) });
  }
  requests.push(...toolRequests(tools, (selected) => countBody(converse(undefined, selected))));
  if (payload.system !== undefined && tools.length > 0) {
    requests.push({ id: "full", label: "system and tools", body: countBody(converse(payload.system, tools)) });
  }
  return requests;
}

export function buildBedrockFullRequest(payload: JsonObject, options: BuildOptions = {}): CountRequest {
  const converse: JsonObject = { messages: requireArray(payload, "messages") };
  for (const key of ["system", "toolConfig", "additionalModelRequestFields"] as const) {
    if (payload[key] !== undefined) converse[key] = payload[key];
  }
  return {
    id: "captured",
    label: "captured request",
    body: { modelId: modelId(payload, options.model), input: { converse } },
  };
}

function systemMessages(payload: JsonObject): JsonValue[] {
  return requireArray(payload, "messages").filter((message) => isJsonObject(message) && message.role === "system");
}

export function buildKimiRequests(payload: JsonObject, options: BuildOptions = {}): CountRequest[] {
  const model = modelId(payload, options.model);
  const messages = systemMessages(payload);
  const requests: CountRequest[] = [{ id: "baseline", label: "baseline", body: { model, messages: MINIMAL_MESSAGES } }];
  if (messages.length > 0) {
    requests.push({
      id: "system",
      label: "system messages",
      body: { model, messages: [...messages, ...MINIMAL_MESSAGES] },
      chars: textChars(messages),
    });
  }
  return requests;
}

export function buildZaiRequests(payload: JsonObject, options: BuildOptions = {}): CountRequest[] {
  const model = modelId(payload, options.model);
  const messages = systemMessages(payload);
  const tools = selectTools(payload.tools, options.tools);
  const baseline = { model, messages: MINIMAL_MESSAGES };
  const requests: CountRequest[] = [{ id: "baseline", label: "baseline", body: baseline }];
  if (messages.length > 0) {
    requests.push({
      id: "system",
      label: "system messages",
      body: { model, messages: [...messages, ...MINIMAL_MESSAGES] },
      chars: textChars(messages),
    });
  }
  requests.push(...toolRequests(tools, (selected) => ({ ...baseline, tools: selected })));
  if (messages.length > 0 && tools.length > 0) {
    requests.push({ id: "full", label: "system and tools", body: { model, messages: [...messages, ...MINIMAL_MESSAGES], tools } });
  }
  return requests;
}

export function summarizeCounts(requests: CountRequest[], counts: Record<string, number>): CountSummary {
  const baseline = counts.baseline ?? 0;
  const individualTools = requests.filter((request) => request.id.startsWith("tool:"));
  const toolOverhead = individualTools.length >= 2 && counts.tools !== undefined
    ? Math.max(0, Math.round((individualTools.reduce((sum, request) => sum + counts[request.id] - baseline, 0) - (counts.tools - baseline)) / (individualTools.length - 1)))
    : undefined;
  const rows = requests.map(({ id, label, chars }) => {
    const tokens = counts[id];
    const marginal = id === "baseline" ? undefined : tokens - baseline;
    const netTokens = marginal !== undefined && toolOverhead !== undefined && id.startsWith("tool")
      ? Math.max(0, marginal - toolOverhead)
      : marginal;
    return {
      id,
      label,
      tokens,
      marginal,
      netTokens,
      chars,
      charsPerToken: chars !== undefined && netTokens ? chars / netTokens : undefined,
    };
  });
  const system = rows.find((row) => row.id === "system")?.charsPerToken;
  const tools = rows.find((row) => row.id === "tools")?.charsPerToken;
  return {
    rows,
    toolOverhead,
    suggestedHeuristic: {
      ...(system && { textDenominator: Number(system.toFixed(2)) }),
      ...(tools && { toolDenominator: Number(tools.toFixed(2)) }),
    },
  };
}

async function postJson(url: string, body: JsonObject, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(`${response.status} from ${url}: ${JSON.stringify(data)}`);
  return data;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name} before using --live`);
  return value;
}

function anthropicHeaders(): Record<string, string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  try {
    const auth: unknown = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"));
    const entry = isJsonObject(auth) && isJsonObject(auth.anthropic) ? auth.anthropic : undefined;
    if (entry && typeof entry.access === "string" && (typeof entry.expires !== "number" || entry.expires > Date.now())) {
      return { authorization: `Bearer ${entry.access}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" };
    }
  } catch {
    // The credential error below is more useful than a missing or malformed local auth-file error.
  }
  throw new Error("set ANTHROPIC_API_KEY or refresh the Anthropic login in Pi");
}

function numberField(data: unknown, key: string, provider: string): number {
  if (isJsonObject(data) && typeof data[key] === "number") return data[key];
  throw new Error(`${provider} returned no ${key}`);
}

export function geminiCountUrl(body: JsonObject): string {
  const request = isJsonObject(body.generateContentRequest) ? body.generateContentRequest : undefined;
  const model = typeof request?.model === "string" ? request.model.replace(/^models\//, "") : undefined;
  if (!model) throw new Error("Gemini count request has no model");
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`;
}

export function vertexCountRequest(body: JsonObject, project: string, location: string): { url: string; body: JsonObject } {
  const model = typeof body.model === "string" ? body.model.replace(/^models\//, "") : undefined;
  if (!model) throw new Error("Vertex count request has no model");
  const resource = `projects/${project}/locations/${location}/publishers/google/models/${model}`;
  let host = `${location}-aiplatform.googleapis.com`;
  if (location === "global") host = "aiplatform.googleapis.com";
  else if (location === "us" || location === "eu") host = `aiplatform.${location}.rep.googleapis.com`;
  const { model: _model, toolConfig: _toolConfig, ...countable } = body;
  return {
    url: `https://${host}/v1/${resource}:countTokens`,
    body: countable,
  };
}

export const DEFAULT_PROVIDER_BY_KIND: Partial<Record<PayloadKind, string>> = {
  anthropic: "anthropic",
  "openai-responses": "openai",
  google: "google",
  bedrock: "bedrock",
};

export const PROVIDERS: Record<string, Provider> = {
  anthropic: {
    kinds: ["anthropic"],
    method: "Messages count_tokens",
    build: buildAnthropicRequests,
    full: buildAnthropicFullRequest,
    async execute(body) {
      const data = await postJson("https://api.anthropic.com/v1/messages/count_tokens", body, anthropicHeaders());
      return numberField(data, "input_tokens", "Anthropic");
    },
  },
  openai: {
    kinds: ["openai-responses"],
    method: "Responses input_tokens",
    build: buildOpenAIRequests,
    full: buildOpenAIFullRequest,
    async execute(body) {
      const data = await postJson("https://api.openai.com/v1/responses/input_tokens", body, { authorization: `Bearer ${requiredEnv("OPENAI_API_KEY")}` });
      return numberField(data, "input_tokens", "OpenAI");
    },
  },
  google: {
    kinds: ["google"],
    method: "Gemini countTokens",
    build: buildGoogleRequests,
    full: buildGoogleFullRequest,
    async execute(body) {
      const data = await postJson(geminiCountUrl(body), body, {
        "x-goog-api-key": process.env.GEMINI_API_KEY ?? requiredEnv("GOOGLE_API_KEY"),
      });
      return numberField(data, "totalTokens", "Gemini");
    },
  },
  vertex: {
    kinds: ["google"],
    method: "Vertex countTokens",
    build: buildVertexRequests,
    full: buildVertexFullRequest,
    async execute(body) {
      const project = requiredEnv("GOOGLE_CLOUD_PROJECT");
      const location = requiredEnv("GOOGLE_CLOUD_LOCATION");
      const request = vertexCountRequest(body, project, location);
      const data = await postJson(request.url, request.body, {
        authorization: `Bearer ${requiredEnv("GOOGLE_CLOUD_ACCESS_TOKEN")}`,
      });
      return numberField(data, "totalTokens", "Vertex");
    },
  },
  bedrock: {
    kinds: ["bedrock"],
    method: "Bedrock CountTokens",
    build: buildBedrockRequests,
    full: buildBedrockFullRequest,
    async execute(body) {
      const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      if (!region) throw new Error("set AWS_REGION before using --live");
      // SAFETY: Pi-ai owns this SDK dependency. The installed Pi contract and manual live path pin these two constructors.
      const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-ai"));
      const sdk = requireFromPi("@aws-sdk/client-bedrock-runtime") as {
        BedrockRuntimeClient: new (config: { region: string }) => { send(command: unknown): Promise<{ inputTokens?: number }> };
        CountTokensCommand: new (input: JsonObject) => unknown;
      };
      const client = new sdk.BedrockRuntimeClient({ region });
      const response = await client.send(new sdk.CountTokensCommand(body));
      if (typeof response.inputTokens !== "number") throw new Error("Bedrock returned no inputTokens");
      return response.inputTokens;
    },
  },
  kimi: {
    kinds: ["openai-chat"],
    method: "Kimi estimate-token-count for messages",
    build: buildKimiRequests,
    async execute(body) {
      const data = await postJson("https://api.moonshot.ai/v1/tokenizers/estimate-token-count", body, {
        authorization: `Bearer ${requiredEnv("MOONSHOT_API_KEY")}`,
      });
      if (isJsonObject(data) && isJsonObject(data.data) && typeof data.data.total_tokens === "number") return data.data.total_tokens;
      throw new Error("Kimi returned no data.total_tokens");
    },
  },
  zai: {
    kinds: ["openai-chat"],
    method: "Z.AI tokenizer for messages and tools",
    build: buildZaiRequests,
    async execute(body) {
      const data = await postJson("https://api.z.ai/api/paas/v4/tokenizer", body, {
        authorization: `Bearer ${requiredEnv("ZAI_API_KEY")}`,
      });
      if (isJsonObject(data) && isJsonObject(data.usage) && typeof data.usage.total_tokens === "number") return data.usage.total_tokens;
      throw new Error("Z.AI returned no usage.total_tokens");
    },
  },
};

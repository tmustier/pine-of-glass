// Provider-shaped tool payloads and token estimators shared by the family.

import { isJsonObject, type JsonValue } from "./boundary.ts";
import { estimateCharsAsTokens, type HeuristicNumbers } from "./heuristics.ts";

/** The slice of a tool definition the estimators need; contextimate's ToolSummary
 * satisfies it structurally. */
export type ToolShape = {
  name: string;
  description: string;
  schema: unknown;
};

// Character fragments of OpenAI tool-schema summaries tokenize denser than prose;
// see estimateOpenAIFunctionToolTokens for the ablation this constant came from.
export const OPENAI_TOOL_TEXT_FRAGMENT_DENOMINATOR = 6.6;

// --- JSON schema readers shared by the tool estimators -----------------------------------

function trimFinalPeriod(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1) : text;
}

export function getSchemaProperties(schema: unknown): Record<string, unknown> {
  if (!isJsonObject(schema) || !isJsonObject(schema.properties)) return {};
  return schema.properties;
}

export function schemaPropertyType(property: unknown): string {
  if (!isJsonObject(property)) return "object";
  if (typeof property.type === "string") return property.type;
  if (Array.isArray(property.type)) return property.type.filter((entry): entry is string => typeof entry === "string").join("|");
  if (property.anyOf) return "anyOf";
  if (property.oneOf) return "oneOf";
  if (property.allOf) return "allOf";
  return "object";
}

export function schemaPropertyDescription(property: unknown): string {
  if (!isJsonObject(property)) return "";
  return typeof property.description === "string" ? trimFinalPeriod(property.description) : "";
}

function schemaPropertyEnum(property: unknown): JsonValue[] {
  if (!isJsonObject(property) || !Array.isArray(property.enum)) return [];
  return property.enum;
}

export function schemaArrayItemProperties(property: unknown): Record<string, unknown> {
  if (!isJsonObject(property)) return {};
  return getSchemaProperties(property.items);
}

export function getSchemaRequired(schema: unknown): string[] {
  if (!isJsonObject(schema) || !Array.isArray(schema.required)) return [];
  return schema.required.filter((entry): entry is string => typeof entry === "string");
}

export function arrayItemsSchema(property: unknown): unknown {
  return isJsonObject(property) ? property.items : undefined;
}

export function safeMinifiedJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

// --- provider tool payload shapes ---------------------------------------------------------

export function openAIResponsesToolPayload(tool: ToolShape): unknown {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.schema,
    strict: null,
  };
}

export function toolPayloadForShape(tool: ToolShape & { promptGuidelines?: string[] }, shape: string): unknown {
  switch (shape) {
    case "openai-chat":
    case "openai-completions":
    case "mistral":
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.schema,
          strict: null,
        },
      };
    case "anthropic":
      return { name: tool.name, description: tool.description, input_schema: tool.schema };
    case "gemini":
    case "google":
    case "vertex":
      return { name: tool.name, description: tool.description, parametersJsonSchema: tool.schema };
    case "bedrock":
      return {
        toolSpec: {
          name: tool.name,
          description: tool.description,
          inputSchema: { json: tool.schema },
        },
      };
    case "raw-schema":
      return {
        name: tool.name,
        description: tool.description,
        parameters: tool.schema,
        promptGuidelines: tool.promptGuidelines ?? [],
      };
    default:
      return openAIResponsesToolPayload(tool);
  }
}

export function aggregateToolPayloadForShape(tools: Array<ToolShape & { promptGuidelines?: string[] }>, shape: string): unknown {
  if (shape === "gemini" || shape === "google" || shape === "vertex") {
    return {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.schema,
      })),
    };
  }
  return tools.map((tool) => toolPayloadForShape(tool, shape));
}

export function toolPayloadLabel(shape: string): string {
  switch (shape) {
    case "openai-responses":
    case "openai-codex-responses":
      return "OpenAI Responses tool payload";
    case "openai-chat":
    case "openai-completions":
    case "mistral":
      return "OpenAI Chat tool payload";
    case "anthropic":
      return "Anthropic tool payload";
    case "gemini":
    case "google":
    case "vertex":
      return "Gemini/Vertex tool payload";
    case "bedrock":
      return "Bedrock tool payload";
    case "raw-schema":
      return "Raw tool schema payload";
    default:
      return `Unknown tool shape ${shape}; OpenAI Responses fallback`;
  }
}

// --- OpenAI cookbook-style tool formula ---------------------------------------------------

function estimateOpenAIToolTextTokens(text: string): number {
  return estimateCharsAsTokens(text.length, OPENAI_TOOL_TEXT_FRAGMENT_DENOMINATOR);
}

export function estimateOpenAIToolDefinitionTokens(tool: ToolShape): number {
  let tokens = 7;
  tokens += estimateOpenAIToolTextTokens(`${tool.name}:${trimFinalPeriod(tool.description)}`);
  const propertyEntries = Object.entries(getSchemaProperties(tool.schema));
  if (propertyEntries.length > 0) tokens += 3;
  for (const [propertyName, property] of propertyEntries) tokens += estimateOpenAIPropertyTokens(propertyName, property);
  return tokens;
}

function estimateOpenAIPropertyTokens(propertyName: string, property: unknown): number {
  const propInit = 3;
  const propKey = 3;
  const enumInit = -3;
  const enumItem = 3;

  let tokens = propKey;
  const enumValues = schemaPropertyEnum(property);
  if (enumValues.length > 0) {
    tokens += enumInit;
    for (const enumValue of enumValues) tokens += enumItem + estimateOpenAIToolTextTokens(String(enumValue));
  }
  tokens += estimateOpenAIToolTextTokens(`${propertyName}:${schemaPropertyType(property)}:${schemaPropertyDescription(property)}`);

  const nestedEntries = Object.entries(getSchemaProperties(property));
  if (nestedEntries.length > 0) {
    tokens += propInit;
    for (const [nestedName, nestedProperty] of nestedEntries) tokens += estimateOpenAIPropertyTokens(nestedName, nestedProperty);
  }

  const itemEntries = Object.entries(schemaArrayItemProperties(property));
  if (itemEntries.length > 0) {
    tokens += propInit;
    for (const [itemName, itemProperty] of itemEntries) tokens += estimateOpenAIPropertyTokens(itemName, itemProperty);
  }

  return tokens;
}

export function estimateOpenAIFunctionToolTokens(tools: ToolShape[]): number {
  // OpenAI's public token-counting docs say exact tool counts need the Responses
  // input-token endpoint. For no-API-call startup estimates, use the older
  // cookbook/tiktoken-style schema-summary formula: model-specific constants plus
  // name/description/property summaries, not raw schema JSON. Current public
  // tiktoken maps GPT-5 and GPT-4o families to o200k_base, so use the GPT-4o/GPT-5
  // family constants. A synthetic schema ablation found chars/6.6 over these schema
  // text fragments, plus recursive nested property counting, beats raw schema-char
  // denominators on held-out mixed schemas while remaining dependency-free.
  let tokens = 0;
  for (const tool of tools) tokens += estimateOpenAIToolDefinitionTokens(tool);
  if (tools.length > 0) tokens += 12;
  return tokens;
}

/** Total estimated tokens for a tool list under a family heuristic: the cookbook
 * formula where it applies, the shaped-payload char ratio everywhere else. */
export function estimateToolListTokens(
  tools: Array<ToolShape & { promptGuidelines?: string[] }>,
  heuristic: Pick<HeuristicNumbers, "toolNumerator" | "toolDenominator">,
): number {
  if (tools.length === 0) return 0;
  if (heuristic.toolNumerator === "openai-cookbook") return estimateOpenAIFunctionToolTokens(tools);
  const content = safeMinifiedJson(aggregateToolPayloadForShape(tools, heuristic.toolNumerator));
  return estimateCharsAsTokens(content.length, heuristic.toolDenominator);
}

// Provider tool payload formats and token estimators shared by the family.

import assert from "node:assert/strict";

import { isJsonObject, type JsonFields } from "./boundary.ts";
import { estimateCharsAsTokens, type HeuristicNumbers } from "./heuristics.ts";

/** The slice of a tool definition the estimators need; contextimate's ToolSummary
 * satisfies it structurally. */
export type ToolDefinition = {
  name: string;
  description: string;
  schema: unknown;
};

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

// --- provider tool payload formats ---------------------------------------------------------

export function openAIResponsesToolPayload(tool: ToolDefinition): unknown {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.schema,
    strict: null,
  };
}

/** `format` is a `toolNumerator` name; `openai-cookbook` and unknown names take the
 * OpenAI Responses payload. */
export function toolPayload(tool: ToolDefinition & { promptGuidelines?: string[] }, format: string): unknown {
  switch (format) {
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
    case "pi-messages":
      return { name: tool.name, description: tool.description, parameters: tool.schema };
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

export function aggregateToolPayload(tools: Array<ToolDefinition & { promptGuidelines?: string[] }>, format: string): unknown {
  if (format === "gemini" || format === "google" || format === "vertex") {
    return {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.schema,
      })),
    };
  }
  return tools.map((tool) => toolPayload(tool, format));
}

export function toolPayloadLabel(format: string): string {
  switch (format) {
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
    case "pi-messages":
      return "Pi Messages tool payload";
    case "raw-schema":
      return "Raw tool schema payload";
    default:
      return `Unknown tool payload format ${format}; OpenAI Responses fallback`;
  }
}

// --- OpenAI tool render -------------------------------------------------------------------

// OpenAI shows the model each function as a TypeScript-style declaration rather than JSON;
// docs/pi-contextimate.md records the provider counts this render was checked against.
const OPENAI_TOOL_BLOCK_TOKENS = 16;
const TYPESCRIPT_PRIMITIVES = new Map([["string", "string"], ["number", "number"], ["integer", "number"], ["boolean", "boolean"], ["null", "null"]]);
const RENDERED_KEYWORDS = new Set([
  "type", "description", "properties", "required", "items", "enum", "const", "anyOf", "oneOf",
  "default", "title", "examples", "nullable", "deprecated", "$ref", "$schema", "$defs", "definitions",
]);

// o200k_base's pre-tokenizer split. Each piece is about one token, plus one per 9 characters.
const O200K_PIECES = /[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const O200K_CHARS_PER_EXTRA_TOKEN = 9;

function renderComment(text: string): string {
  return text.split("\n").map((line) => `// ${line}\n`).join("");
}

function renderType(schema: unknown, defs: JsonFields, seen: string[]): string {
  if (!isJsonObject(schema) || Object.keys(schema).length === 0) return "any";
  if (typeof schema.$ref === "string") {
    const target = defs[schema.$ref.split("/").at(-1)!];
    return target === undefined || seen.includes(schema.$ref) ? "any" : renderType(target, defs, [...seen, schema.$ref]);
  }
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (variants) {
    return variants.map((variant) => renderType(variant, defs, seen)
      + (isJsonObject(variant) && typeof variant.description === "string" ? ` // ${variant.description}\n` : "")).join(" | ");
  }
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.type)) return schema.type.map((type) => TYPESCRIPT_PRIMITIVES.get(String(type)) ?? String(type)).join(" | ");
  if (schema.type === "object" || (schema.type === undefined && "properties" in schema)) return renderObject(schema, defs, seen);
  if (schema.type === "array") {
    const items = isJsonObject(schema.items) ? renderType(schema.items, defs, seen) : "any";
    return items.includes(" | ") ? `Array<${items}>` : `${items}[]`;
  }
  return TYPESCRIPT_PRIMITIVES.get(String(schema.type)) ?? "any";
}

function renderObject(schema: JsonFields, defs: JsonFields, seen: string[]): string {
  const properties = Object.entries(getSchemaProperties(schema));
  if (properties.length === 0) return "object";
  const required = new Set(getSchemaRequired(schema));
  let out = "{\n";
  for (const [name, value] of properties) {
    const property = isJsonObject(value) ? value : {};
    if (typeof property.title === "string") out += `// ${property.title}\n//\n`;
    if (typeof property.description === "string" && property.description) out += renderComment(property.description);
    if (Array.isArray(property.examples) && property.examples.length > 0) {
      out += `// Examples:\n${property.examples.map((example) => `// - ${JSON.stringify(example)}\n`).join("")}`;
    }
    // The provider keeps keywords it has no TypeScript form for, such as format or minimum.
    const unrendered = Object.entries(property).filter(([key]) => !RENDERED_KEYWORDS.has(key));
    out += `${name}${required.has(name) ? "" : "?"}: ${renderType(property, defs, seen)}${property.nullable === true ? " | null" : ""},`
      + ("default" in property ? ` // default: ${JSON.stringify(property.default)}` : "")
      + (unrendered.length > 0 ? ` // ${JSON.stringify(Object.fromEntries(unrendered))}` : "")
      + "\n";
  }
  return `${out}}`;
}

export function renderOpenAITool(tool: ToolDefinition): string {
  const schema = tool.schema;
  assert(isJsonObject(schema), `${tool.name} has no JSON-object parameter schema`);
  const defs = [schema.$defs, schema.definitions].find(isJsonObject) ?? {};
  const parameters = Object.keys(getSchemaProperties(schema)).length > 0 ? `_: ${renderObject(schema, defs, [])}` : "";
  return `${tool.description ? renderComment(tool.description) : ""}type ${tool.name} = (${parameters}) => any;\n\n`;
}

export function estimateOpenAIToolDefinitionTokens(tool: ToolDefinition): number {
  let tokens = 0;
  for (const [piece] of renderOpenAITool(tool).matchAll(O200K_PIECES)) tokens += 1 + Math.floor((piece.length - 1) / O200K_CHARS_PER_EXTRA_TOKEN);
  return tokens;
}

export function estimateOpenAIFunctionToolTokens(tools: ToolDefinition[]): number {
  return tools.reduce((sum, tool) => sum + estimateOpenAIToolDefinitionTokens(tool), OPENAI_TOOL_BLOCK_TOKENS);
}

/** Total estimated tokens for a tool list under a family heuristic: the OpenAI render
 * where it applies, the payload char ratio everywhere else. */
export function estimateToolListTokens(
  tools: Array<ToolDefinition & { promptGuidelines?: string[] }>,
  heuristic: Pick<HeuristicNumbers, "toolNumerator" | "toolDenominator">,
): number {
  if (tools.length === 0) return 0;
  if (heuristic.toolNumerator === "openai-cookbook") return estimateOpenAIFunctionToolTokens(tools);
  const content = safeMinifiedJson(aggregateToolPayload(tools, heuristic.toolNumerator));
  return estimateCharsAsTokens(content.length, heuristic.toolDenominator);
}

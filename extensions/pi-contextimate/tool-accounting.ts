// What tool definitions cost: the provider payload they are sent as, and a per-tool estimate.
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { estimateCharsAsTokens } from "../_lib/heuristics.ts";
import {
  aggregateToolPayload,
  arrayItemsSchema,
  estimateOpenAIFunctionToolTokens,
  estimateOpenAIToolDefinitionTokens,
  getSchemaProperties,
  getSchemaRequired,
  renderOpenAITool,
  safeMinifiedJson,
  schemaArrayItemProperties,
  schemaPropertyDescription,
  schemaPropertyType,
  toolPayload,
  toolPayloadLabel,
} from "../_lib/tool-payloads.ts";
import { SEP } from "../_lib/style.ts";
import type { ResolvedHeuristic } from "./heuristic-config.ts";

export type ToolSummary = {
  name: string;
  description: string;
  source: string;
  schema: unknown;
  promptGuidelines: string[];
};

export type ToolField = {
  name: string;
  type: string;
  required: boolean;
  description: string;
  depth: number;
};

export type ToolExpanded = {
  name: string;
  tokens: number;
  source: string;
  description: string;
  fields: ToolField[];
};

type ToolNumeratorResult = {
  label: string;
  content: string;
  chars: number;
  /** Present only for the OpenAI tool render; ratio numerators divide chars instead. */
  tokens?: number;
};

type ToolDisplayEstimate = {
  tokens: number;
  chars: number;
};

// Provenance short form (design language §8): the local defining path *is* the
// audit trail, and the origin URL / package ref / `top-level` decorations duplicate
// it, so the label is `scope · path` (falling back to the loader source when no path
// exists) and builtins collapse to one word. Pi keeps the full SourceInfo.
export function sourceInfoLabel(tool: ToolInfo): string {
  const sourceInfo = tool.sourceInfo;
  if (sourceInfo.source === "builtin") return "builtin";
  const where = sourceInfo.path ?? sourceInfo.source;
  return [sourceInfo.scope, where].filter(Boolean).join(SEP) || "unknown";
}

export function summarizeTool(tool: ToolInfo): ToolSummary {
  return {
    name: tool.name,
    description: tool.description.trim() || "(no description)",
    source: sourceInfoLabel(tool),
    schema: tool.parameters,
    promptGuidelines: tool.promptGuidelines ?? [],
  };
}

export function buildToolNumerator(tools: ToolSummary[], heuristic: ResolvedHeuristic): ToolNumeratorResult {
  const numerator = heuristic.toolNumerator;
  if (numerator === "openai-cookbook") {
    const content = tools.map(renderOpenAITool).join("");
    return {
      label: "OpenAI tool render",
      content,
      chars: content.length,
      tokens: estimateOpenAIFunctionToolTokens(tools),
    };
  }
  const content = safeMinifiedJson(aggregateToolPayload(tools, numerator));
  return {
    label: toolPayloadLabel(numerator),
    content,
    chars: content.length,
  };
}

function collectToolFields(name: string, property: unknown, depth: number, required: boolean, out: ToolField[], maxDepth = 3): void {
  out.push({
    name,
    type: schemaPropertyType(property),
    required,
    description: schemaPropertyDescription(property),
    depth,
  });
  if (depth >= maxDepth) return;
  const nested = getSchemaProperties(property);
  if (Object.keys(nested).length > 0) {
    const requiredKeys = new Set(getSchemaRequired(property));
    for (const [childName, childProperty] of Object.entries(nested)) {
      collectToolFields(childName, childProperty, depth + 1, requiredKeys.has(childName), out, maxDepth);
    }
  }
  const itemProperties = schemaArrayItemProperties(property);
  if (Object.keys(itemProperties).length > 0) {
    const requiredKeys = new Set(getSchemaRequired(arrayItemsSchema(property)));
    for (const [childName, childProperty] of Object.entries(itemProperties)) {
      collectToolFields(childName, childProperty, depth + 1, requiredKeys.has(childName), out, maxDepth);
    }
  }
}

export function buildToolFields(schema: unknown): ToolField[] {
  const fields: ToolField[] = [];
  const requiredKeys = new Set(getSchemaRequired(schema));
  for (const [name, property] of Object.entries(getSchemaProperties(schema))) {
    collectToolFields(name, property, 0, requiredKeys.has(name), fields);
  }
  return fields;
}

export function buildToolDisplayEstimate(tool: ToolSummary, heuristic: ResolvedHeuristic): ToolDisplayEstimate {
  const numerator = heuristic.toolNumerator;
  if (numerator === "openai-cookbook") {
    return { tokens: estimateOpenAIToolDefinitionTokens(tool), chars: renderOpenAITool(tool).length };
  }
  const chars = safeMinifiedJson(toolPayload(tool, numerator)).length;
  return { tokens: estimateCharsAsTokens(chars, heuristic.toolDenominator), chars };
}

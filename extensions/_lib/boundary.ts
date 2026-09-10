// Boundary helpers for values that enter pine-of-glass from JSON, Pi internals,
// provider payloads, or other untyped seams. Keep generic uncertainty here or in
// domain-named parsers, not in rendering/core logic.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

// A shallow object check: callers still validate the fields they use.
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Unvalidated fields belong at this input boundary, never in a parsed domain contract.
export type JsonFields = { [key: string]: unknown };

export function isJsonObject(value: unknown): value is JsonFields {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function positiveNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function nonNegativeNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

// Boundary helpers for values that enter pine-of-glass from JSON, Pi internals,
// provider payloads, or other untyped seams. Keep generic uncertainty here or in
// domain-named parsers, not in rendering/core logic.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

// Shallow input inspection only. Fields remain unknown until the domain parser checks
// them. This also accepts Pi objects; it does not prove recursive JSON compatibility.
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Unvalidated fields belong at this input boundary, never in a parsed domain contract.
export type JsonFields = { [key: string]: unknown };

export function isJsonObject(value: unknown): value is JsonFields {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function jsonObjectOrEmpty(value: unknown): JsonFields {
  return isJsonObject(value) ? value : {};
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

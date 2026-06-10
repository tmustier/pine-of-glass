// Shared number grammar for the pine-of-glass extension family.
// One language across extensions: counts are raw integers below 1000, one-decimal
// k-units above (412, 1.2k, 52.3k), one-decimal M-units above a million (9.1M);
// char counts read `412 ch`.

export function compactCount(value: number): string {
  if (!Number.isFinite(value)) return "?";
  const rounded = Math.round(value);
  if (Math.abs(rounded) >= 999_950) return `${(rounded / 1_000_000).toFixed(1)}M`;
  if (Math.abs(rounded) >= 1000) return `${(rounded / 1000).toFixed(1)}k`;
  return String(rounded);
}

export function formatChars(value: number): string {
  return `${compactCount(value)} ch`;
}

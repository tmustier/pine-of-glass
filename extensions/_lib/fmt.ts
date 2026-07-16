// Shared number grammar for the pine-of-glass extension family
// (docs/design-language.md §4). One unit, everywhere: counts render in fixed
// one-decimal k-units (0.1k, 1.2k, 52.3k) so magnitudes compare down a column —
// raw integers never appear. M is the only step-up, at ≥1M, where k becomes
// unreadable (9.1M, not 9100.0k). Char counts read `0.4k ch`.

export function compactCount(value: number): string {
  if (!Number.isFinite(value)) return "?";
  const rounded = Math.round(value);
  if (Math.abs(rounded) >= 999_950) return `${(rounded / 1_000_000).toFixed(1)}M`;
  return `${(rounded / 1000).toFixed(1)}k`;
}

export function formatChars(value: number): string {
  return `${compactCount(value)} ch`;
}

/**
 * Token counts wear the estimate marker unless provider-reported: the ~/no-~
 * distinction is semantic, never stylistic (design language §4).
 */
export function formatTokens(value: number, options: { exact?: boolean } = {}): string {
  return `${options.exact ? "" : "~"}${compactCount(value)} tokens`;
}

/** Money: two decimals; three below $0.10, where the third digit is significant. */
export function formatUsd(value: number): string {
  return value >= 0.10 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
}

/** Latency durations (design language §4): below 10s the first decimal is significant
 * at first-token scale (`1.9s`, `9.6s`); from 10s the compact mixed-unit grammar
 * resumes. */
export function formatLatency(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 9.95) return `${seconds.toFixed(1)}s`;
  return formatDuration(ms);
}

/** Rates (design language §4): integer tok/s; `~` when estimated from streamed chars,
 * none when derived from provider usage. The ~/no-~ distinction is semantic. */
export function formatRate(tokensPerSecond: number, options: { exact?: boolean } = {}): string {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond < 0) return "?";
  return `${options.exact ? "" : "~"}${Math.round(tokensPerSecond)} tok/s`;
}

/** Durations: compact mixed units, no spaces — 14s, 2m41s, 9h50m. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest > 0 ? `${minutes}m${rest.toString().padStart(2, "0")}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`;
}

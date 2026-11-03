/** The token counts every Pi usage record carries. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The provider reported tokens for this response. An aborted response can still have billed some. */
export function hasBilledUsage(usage: TokenUsage): boolean {
  return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0;
}

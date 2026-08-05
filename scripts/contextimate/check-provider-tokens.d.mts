// Type surface for check-provider-tokens.mjs (consumed by the test suite and by anyone
// extending the PROVIDERS registry).

export type PayloadKind = "anthropic" | "openai-responses";

export interface CountRequest {
  id: string;
  label: string;
  body: Record<string, unknown> & {
    model?: string;
    system?: unknown;
    instructions?: string;
    tools?: unknown[];
    messages?: unknown[];
    input?: unknown[];
    max_tokens?: number;
    max_output_tokens?: number;
    output_config?: unknown;
    cache_control?: unknown;
    store?: boolean;
  };
}

export interface SummaryRow {
  id: string;
  label: string;
  tokens?: number;
  marginal?: number;
  netTokens?: number;
  chars?: number;
  charsPerToken?: number;
}

export interface CountSummary {
  rows: SummaryRow[];
  toolOverhead?: number;
}

export interface BuildOptions {
  tools?: string[];
  model?: string;
}

export interface ExecuteOptions {
  apiKey?: string;
  oauthToken?: string;
  fetchImpl?: (url: string, init: unknown) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;
}

export interface ProviderEntry {
  detect(kind: PayloadKind | undefined): boolean;
  build(payload: Record<string, unknown>, options?: BuildOptions): CountRequest[];
  exact?: (payload: Record<string, unknown>, options?: BuildOptions) => CountRequest;
  api?: string;
  exactSource?: string;
  cost: string;
  env: string;
  resolveCredential(): { apiKey?: string; oauthToken?: string } | undefined;
  credentialHint: string;
  execute(body: CountRequest["body"], options: ExecuteOptions): Promise<number | undefined>;
}

export function detectPayloadKind(payload: unknown): PayloadKind | undefined;
export function jsonSha256(value: unknown): string;
export function parsePayloadFile(text: string): { kind: PayloadKind; payload: Record<string, unknown> };
export function buildAnthropicExactCountRequest(payload: Record<string, unknown>, options?: BuildOptions): CountRequest;
export function buildAnthropicCountRequests(payload: Record<string, unknown>, options?: BuildOptions): CountRequest[];
export function buildOpenAIResponsesProbes(payload: Record<string, unknown>, options?: BuildOptions): CountRequest[];
export function computeToolOverhead(requests: CountRequest[], counts: Record<string, number | undefined>): number | undefined;
export function summarizeCounts(requests: CountRequest[], counts: Record<string, number | undefined>): CountSummary;
export function suggestDenominators(summary: CountSummary): { textDenominator?: number; toolDenominator?: number };
export const PROVIDERS: Record<string, ProviderEntry>;

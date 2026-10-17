// pi-meantime feature gate and tuning config. The family convention is user-level
// `~/.pi/agent/pi-meantime.json`, then project-level `<cwd>/.pi/pi-meantime.json`.

import { booleanValue, isJsonObject, positiveNumberValue } from "../_lib/boundary.ts";

export interface MeantimeConfig {
  /** Feature flag: the extension registers no runtime surface unless explicitly enabled. */
  enabled: boolean;
  widget: boolean;
  notices: boolean;
  /** Slow start: ttft ≥ factor × rolling median, and ≥ the absolute floor. */
  slowStartFactor: number;
  slowStartFloorMs: number;
  /** Slow stream: rate ≤ median ÷ factor, on calls with enough output to matter. */
  slowStreamFactor: number;
  slowStreamMinTokens: number;
  /** Resolved samples required before any baseline claim (short sessions stay silent). */
  baselineMinCalls: number;
  /** Uncached prompt tokens needed to name prefill as a slow-start cause. */
  prefillCauseTokens: number;
}

export const DEFAULT_CONFIG: MeantimeConfig = {
  enabled: false,
  widget: true,
  notices: true,
  slowStartFactor: 3,
  slowStartFloorMs: 5_000,
  slowStreamFactor: 3,
  slowStreamMinTokens: 300,
  baselineMinCalls: 3,
  prefillCauseTokens: 20_000,
};

export function parseMeantimeConfig(value: unknown): Partial<MeantimeConfig> {
  if (!isJsonObject(value)) return {};
  const config: Partial<MeantimeConfig> = {};
  for (const key of ["enabled", "widget", "notices"] as const) {
    const parsed = booleanValue(value[key]);
    if (parsed !== undefined) config[key] = parsed;
  }
  for (const key of ["slowStartFactor", "slowStartFloorMs", "slowStreamFactor"] as const) {
    const parsed = positiveNumberValue(value[key]);
    if (parsed !== undefined) config[key] = parsed;
  }
  for (const key of ["slowStreamMinTokens", "baselineMinCalls", "prefillCauseTokens"] as const) {
    const parsed = positiveNumberValue(value[key]);
    if (parsed !== undefined) config[key] = Math.floor(parsed);
  }
  return config;
}

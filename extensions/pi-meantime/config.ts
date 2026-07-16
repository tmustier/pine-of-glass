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
  const enabled = booleanValue(value.enabled);
  const widget = booleanValue(value.widget);
  const notices = booleanValue(value.notices);
  const slowStartFactor = positiveNumberValue(value.slowStartFactor);
  const slowStartFloorMs = positiveNumberValue(value.slowStartFloorMs);
  const slowStreamFactor = positiveNumberValue(value.slowStreamFactor);
  const slowStreamMinTokens = positiveNumberValue(value.slowStreamMinTokens);
  const baselineMinCalls = positiveNumberValue(value.baselineMinCalls);
  const prefillCauseTokens = positiveNumberValue(value.prefillCauseTokens);
  if (enabled !== undefined) config.enabled = enabled;
  if (widget !== undefined) config.widget = widget;
  if (notices !== undefined) config.notices = notices;
  if (slowStartFactor !== undefined) config.slowStartFactor = slowStartFactor;
  if (slowStartFloorMs !== undefined) config.slowStartFloorMs = slowStartFloorMs;
  if (slowStreamFactor !== undefined) config.slowStreamFactor = slowStreamFactor;
  if (slowStreamMinTokens !== undefined) config.slowStreamMinTokens = Math.floor(slowStreamMinTokens);
  if (baselineMinCalls !== undefined) config.baselineMinCalls = Math.floor(baselineMinCalls);
  if (prefillCauseTokens !== undefined) config.prefillCauseTokens = Math.floor(prefillCauseTokens);
  return config;
}

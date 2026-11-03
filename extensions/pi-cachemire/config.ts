// Cachemire's family config: user-level `~/.pi/agent/pi-cachemire.json`, then project-level
// `<cwd>/.pi/pi-cachemire.json`.
import { booleanValue, isJsonObject, positiveNumberValue } from "../_lib/boundary.ts";
import { configPaths, readJsonConfig } from "../_lib/config.ts";
import type { CachemireConfig } from "./types.ts";

const DEFAULT_CONFIG: CachemireConfig = {
  debug: false, // agent-default (not a user rule): 2026-09-24
  widget: true,
  turnSummary: true,
  turnSummaryMinCalls: 1, // every turn: a single-call turn omitting the line felt inconsistent
  missWarnings: true,
  missWarnUsd: 0.05,
  missWarnTokens: 20_000,
};

export function readConfig(): CachemireConfig {
  return configPaths("pi-cachemire", process.cwd()).reduce((config, filePath) => {
    const parsed = readJsonConfig(filePath, (value): Partial<CachemireConfig> => {
      if (!isJsonObject(value)) return {};
      const next: Partial<CachemireConfig> = {};
      const debug = booleanValue(value.debug);
      const widget = booleanValue(value.widget);
      const turnSummary = booleanValue(value.turnSummary);
      const turnSummaryMinCalls = positiveNumberValue(value.turnSummaryMinCalls);
      const missWarnings = booleanValue(value.missWarnings);
      const missWarnUsd = positiveNumberValue(value.missWarnUsd);
      const missWarnTokens = positiveNumberValue(value.missWarnTokens);
      if (debug !== undefined) next.debug = debug;
      if (widget !== undefined) next.widget = widget;
      if (turnSummary !== undefined) next.turnSummary = turnSummary;
      if (turnSummaryMinCalls !== undefined) next.turnSummaryMinCalls = Math.floor(turnSummaryMinCalls);
      if (missWarnings !== undefined) next.missWarnings = missWarnings;
      if (missWarnUsd !== undefined) next.missWarnUsd = missWarnUsd;
      if (missWarnTokens !== undefined) next.missWarnTokens = Math.floor(missWarnTokens);
      return next;
    });
    return Object.assign(config, parsed);
  }, { ...DEFAULT_CONFIG });
}

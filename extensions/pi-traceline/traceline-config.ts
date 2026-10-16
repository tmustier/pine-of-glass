// Traceline's family config (design language §6, §9.13, §9.14): the size thresholds,
// the drill shortcut and the ledger reveal policy, parsed at the boundary.
import { isJsonObject, positiveNumberValue, stringValue } from "../_lib/boundary.ts";

export type TracelineConfig = {
  sizeWarningChars?: number;
  sizeErrorChars?: number;
  drillKey?: string;
  revealLedgers?: boolean;
  ledgerMaxLines?: number;
};

export function parseTracelineConfig(value: unknown): TracelineConfig {
  if (!isJsonObject(value)) return {};
  const sizeWarningChars = positiveNumberValue(value.sizeWarningChars);
  const sizeErrorChars = positiveNumberValue(value.sizeErrorChars);
  const drillKey = stringValue(value.drillKey);
  const ledgerMaxLines = positiveNumberValue(value.ledgerMaxLines);
  const config: TracelineConfig = {};
  if (sizeWarningChars !== undefined) config.sizeWarningChars = Math.floor(sizeWarningChars);
  if (sizeErrorChars !== undefined) config.sizeErrorChars = Math.floor(sizeErrorChars);
  if (drillKey !== undefined && drillKey.length > 0) config.drillKey = drillKey;
  if (typeof value.revealLedgers === "boolean") config.revealLedgers = value.revealLedgers;
  if (ledgerMaxLines !== undefined) config.ledgerMaxLines = Math.floor(ledgerMaxLines);
  return config;
}

/** Whether composed rows start with their ledger shown, and the folded line count past which they do not (§9.14). */
export type LedgerPolicy = { reveal: boolean; maxLines: number };
export const DEFAULT_LEDGER_POLICY: LedgerPolicy = { reveal: true, maxLines: 12 }; // agent-default (not a user rule): 2026-10-20

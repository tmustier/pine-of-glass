// Summary request accounting (design language §9.15), separate from Pi's own total.
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isJsonObject } from "../_lib/boundary.ts";
import { formatUsd } from "../_lib/fmt.ts";

export const SUMMARY_ENTRY = "traceline-summary";
export const SUMMARY_USAGE_ENTRY = "traceline-summary-usage";

export type SummaryUsageRecord = { requestId: string; model: string; items: number } & (
  | { phase: "started" }
  | { phase: "reported"; usage: Usage; stopReason: AssistantMessage["stopReason"] }
);

/** Restore request costs from the whole session, without treating missing usage as zero. */
export function summaryCostStatus(entries: readonly SessionEntry[]): string | undefined {
  const requests = new Map<string, number | undefined>();
  let cost: number | undefined;
  let unknown = false;
  for (const entry of entries) {
    if (entry.type !== "custom" || !isJsonObject(entry.data)) continue;
    const data = entry.data;
    if (entry.customType === SUMMARY_USAGE_ENTRY) {
      if (typeof data.requestId !== "string" || !data.requestId || (data.phase !== "started" && data.phase !== "reported")) continue;
      if (!requests.has(data.requestId)) requests.set(data.requestId, undefined);
      if (data.phase === "reported" && isJsonObject(data.usage) && isJsonObject(data.usage.cost)) {
        const total = data.usage.cost.total;
        if (typeof total === "number" && Number.isFinite(total) && total >= 0) requests.set(data.requestId, total);
      }
    } else if (entry.customType === SUMMARY_ENTRY) {
      if (typeof data.requestId === "string" && data.requestId) {
        if (!requests.has(data.requestId)) requests.set(data.requestId, undefined);
      } else {
        // Old entries contain only the shares of replies that yielded a gist.
        // Their sum is known, but cannot prove the session's full summary cost.
        unknown = true;
        if (typeof data.cost === "number" && Number.isFinite(data.cost) && data.cost >= 0) {
          cost = (cost ?? 0) + data.cost;
        }
      }
    }
  }
  if (requests.size === 0 && !unknown) return undefined;
  for (const total of requests.values()) {
    if (total === undefined) unknown = true;
    else cost = (cost ?? 0) + total;
  }
  if (cost === undefined) return "summaries cost unknown (extra)";
  let amount = formatUsd(cost);
  // Keep a positive charge visible below the family money grammar's precision.
  if (cost > 0 && amount === "$0.000") amount = "<$0.001";
  return `summaries ${amount} extra${unknown ? " + unknown" : ""}`;
}

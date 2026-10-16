// Thinking-effort changes and the cache. Two sources decide whether an effort change
// is cache-key material on a route: the static wire contract (Pi's catalogue flag or a
// verified direct route) and, once a change has been billed, the usage itself.
// Cachemire reads a request only at its own hook position; a later-loaded extension or
// an extension-registered provider can transform it afterwards (Pi documents this), so
// the billed verdict outranks both the contract and the send-time payload.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isJsonObject, type JsonFields, nonNegativeNumberValue, stringValue } from "../_lib/boundary.ts";
import type { CallClassification, ThinkingEvidence, UsageLike } from "./types.ts";

type RouteIdentity = {
	provider: string;
	model: string;
	api: string;
};

export interface ThinkingRoute extends RouteIdentity {
	appendOnlyEffort: boolean;
}

/** What this process has billed on one route: every wire effort ever billed there,
 * and the most recent effort-change verdict. */
interface RouteThinkingRecord {
	billedEfforts: Set<string>;
	verdict?: ThinkingEvidence;
}

/** Per route, for the life of this Pi process: the route's behaviour belongs to the
 * provider and extension stack, not to a session. */
export type ThinkingEvidenceLedger = Map<string, RouteThinkingRecord>;

export function thinkingRoute(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): ThinkingRoute | undefined {
	const { model } = ctx;
	if (!model) return undefined;
	const flagged = model.compat !== undefined && "supportsMidConvoEffort" in model.compat &&
		model.compat.supportsMidConvoEffort === true;
	// Pi disables effort updates on its direct OpenAI endpoint with ChatGPT sign-in.
	const chatGPT = model.provider === "openai" && model.baseUrl === "https://api.openai.com/v1" &&
		ctx.modelRegistry.isUsingOAuth(model);
	return {
		provider: model.provider,
		model: model.id,
		api: model.api,
		appendOnlyEffort: flagged && (model.api === "anthropic-messages" ||
			(model.api === "openai-responses" && !chatGPT)),
	};
}

function routeKey(route: RouteIdentity): string {
	return `${route.provider}/${route.api}/${route.model}`;
}

function routeRecord(ledger: ThinkingEvidenceLedger, route: RouteIdentity): RouteThinkingRecord {
	const key = routeKey(route);
	const existing = ledger.get(key);
	if (existing) return existing;
	const created: RouteThinkingRecord = { billedEfforts: new Set() };
	ledger.set(key, created);
	return created;
}

export function wireThinkingEffort(
	map: Partial<Record<string, string | null>> | undefined,
	level: string,
): string {
	if (level === "off") return "off";
	const mapped = map?.[level];
	if (typeof mapped === "string") return mapped;
	if (level === "minimal" || level === "low") return "low";
	if (level === "medium" || level === "high") return level;
	return "high";
}

/** The most recent billed verdict on the exact route wins over the contract either way. */
export function thinkingChangesPreserveCache(
	route: ThinkingRoute | undefined,
	ledger?: ThinkingEvidenceLedger,
): boolean {
	if (!route) return false;
	const verdict = ledger?.get(routeKey(route))?.verdict;
	// The exact Fable fallback covers stale overrides that shadow Pi's catalogue flag.
	return verdict?.held ?? (route.appendOnlyEffort ||
		(route.api === "anthropic-messages" && route.provider === "anthropic" && route.model === "claude-fable-5-1"));
}

export function thinkingChangeInvalidatesCache(
	route: ThinkingRoute | undefined,
	map: Partial<Record<string, string | null>> | undefined,
	previousLevel: string | undefined,
	nextLevel: string | undefined,
	ledger?: ThinkingEvidenceLedger,
): boolean {
	if (previousLevel === undefined || nextLevel === undefined) return false;
	const previousEffort = wireThinkingEffort(map, previousLevel);
	const nextEffort = wireThinkingEffort(map, nextLevel);
	return (
		previousEffort !== nextEffort &&
		(!thinkingChangesPreserveCache(route, ledger) || previousEffort === "off" || nextEffort === "off")
	);
}

export interface BilledThinkingChange {
	map: Partial<Record<string, string | null>> | undefined;
	/** Level at the previous billed call and at this one. */
	lastCallLevel: string | undefined;
	currentLevel: string | undefined;
	/** The two calls do not share a prefix to compare: model switch or compaction. */
	incomparable: boolean;
	classification: CallClassification;
	/** Send-time forensics named the thinking wire change as the first divergence. */
	thinkingNamedAtSend: boolean;
	/** The previous window still promised a warm entry at request time; without that
	 * promise a miss may be ordinary expiry and proves nothing about effort. */
	warmPromised: boolean;
	usage: UsageLike;
	expectedRead: number;
}

/**
 * Books one billed call on its route and returns the verdict it carries, if any. A hit
 * on an effort the route has never billed before is evidence that the route keeps its
 * prefix: a hit on a previously billed effort proves nothing, because providers keep a
 * cache entry per effort and a return within retention reads that entry back. A miss
 * counts against the route only when the payload showed the effort change, nothing
 * else was named, and the window still promised a warm entry. Turning thinking on or
 * off stays a distinct mutation and never produces evidence.
 */
export function recordBilledThinking(
	ledger: ThinkingEvidenceLedger,
	route: ThinkingRoute,
	change: BilledThinkingChange,
): ThinkingEvidence | undefined {
	const record = routeRecord(ledger, route);
	const to = change.currentLevel === undefined ? undefined : wireThinkingEffort(change.map, change.currentLevel);
	const billedBefore = to !== undefined && record.billedEfforts.has(to);
	if (to !== undefined) record.billedEfforts.add(to);
	if (change.incomparable || change.lastCallLevel === undefined || to === undefined) return undefined;
	const from = wireThinkingEffort(change.map, change.lastCallLevel);
	if (from === to || from === "off" || to === "off") return undefined;
	const hit = change.classification.kind === "hit";
	if (hit && billedBefore) return undefined;
	if (!hit && (change.classification.kind === "cold" || !change.thinkingNamedAtSend || !change.warmPromised)) return undefined;
	const verdict = { from, to, cacheRead: change.usage.cacheRead, expectedRead: change.expectedRead, held: hit };
	record.verdict = verdict;
	return verdict;
}

// Longest known retention (OpenAI extended). Importing retention.ts here would cycle.
const EFFORT_MEMORY_MS = 24 * 60 * 60 * 1000;

/**
 * Replays the active path's persisted `thinking_level_change` entries: seeds the route
 * with the efforts billed there recently, so a return to one of them in this process is
 * not mistaken for fresh evidence, and returns the level the path's last billed call
 * used, which is what the next call's effort change is measured from. Pi restores
 * neither on a branch switch, so this runs on every path change, not only at start.
 */
export function restoreBilledThinking(
	ledger: ThinkingEvidenceLedger,
	entries: readonly unknown[],
	leafId: string | null,
	model: ExtensionContext["model"],
	now: number,
): string | undefined {
	if (!model || leafId === null) return undefined;
	const route: RouteIdentity = { provider: model.provider, model: model.id, api: model.api };
	const byId = new Map<string, JsonFields>();
	for (const entry of entries) {
		if (isJsonObject(entry) && typeof entry.id === "string") byId.set(entry.id, entry);
	}
	const path: JsonFields[] = [];
	for (let id: string | undefined = leafId; id !== undefined; id = stringValue(path.at(-1)?.parentId)) {
		const entry = byId.get(id);
		if (!entry) break;
		path.push(entry);
	}
	const record = routeRecord(ledger, route);
	let level: string | undefined;
	let lastBilledLevel: string | undefined;
	for (const entry of path.reverse()) {
		if (entry.type === "thinking_level_change") {
			level = stringValue(entry.thinkingLevel);
			continue;
		}
		if (entry.type !== "message" || !isJsonObject(entry.message) || entry.message.role !== "assistant") continue;
		lastBilledLevel = level;
		const { message } = entry;
		if (message.provider !== route.provider || message.api !== route.api || message.model !== route.model) continue;
		const at = nonNegativeNumberValue(message.timestamp);
		if (level === undefined || at === undefined || now - at > EFFORT_MEMORY_MS) continue;
		record.billedEfforts.add(wireThinkingEffort(model.thinkingLevelMap, level));
	}
	return lastBilledLevel;
}

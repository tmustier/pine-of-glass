// Thinking-effort changes and the cache. Two sources decide whether an effort change
// is cache-key material on a route: the static wire contract (Pi's catalogue flag or a
// verified direct route) and, once a change has been billed, the usage itself.
// Cachemire reads a request only at its own hook position; a later-loaded extension or
// an extension-registered provider can transform it afterwards (Pi documents this), so
// the billed verdict outranks both the contract and the send-time payload.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isJsonObject, type JsonFields, nonNegativeNumberValue, stringValue } from "../_lib/boundary.ts";
import type { CallClassification, ThinkingEvidence, UsageLike } from "./types.ts";

export interface ThinkingRoute {
	provider: string;
	model: string;
	api: string;
	supportsMidConvoEffort: boolean;
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

type ActiveModel = NonNullable<ExtensionContext["model"]>;

export function thinkingRoute(model: ExtensionContext["model"]): ThinkingRoute | undefined {
	return model && routeOf(model);
}

function routeOf(model: ActiveModel): ThinkingRoute {
	return {
		provider: model.provider,
		model: model.id,
		api: model.api,
		supportsMidConvoEffort:
			isJsonObject(model.compat) && model.compat.supportsMidConvoEffort === true,
	};
}

function routeKey(route: ThinkingRoute): string {
	return `${route.provider}/${route.api}/${route.model}`;
}

function routeRecord(ledger: ThinkingEvidenceLedger, route: ThinkingRoute): RouteThinkingRecord {
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

// The static contract. The exact-model fallback covers stale local overrides that
// shadow Pi's catalogue flag; direct Pi 0.85.1 calls retained full message-heavy
// prefixes on both effort changes.
function contractPreservesCache(route: ThinkingRoute): boolean {
	if (route.api !== "anthropic-messages") return false;
	return (
		route.supportsMidConvoEffort ||
		(route.provider === "anthropic" && route.model === "claude-fable-5-1")
	);
}

/** The most recent billed verdict on the exact route wins over the contract either way. */
export function thinkingChangesPreserveCache(
	route: ThinkingRoute | undefined,
	ledger?: ThinkingEvidenceLedger,
): boolean {
	if (!route) return false;
	const verdict = ledger?.get(routeKey(route))?.verdict;
	return verdict ? verdict.held : contractPreservesCache(route);
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
	/** A retention window also closed, so a miss proves nothing about effort. */
	windowExpired: boolean;
	usage: UsageLike;
	expectedRead: number;
}

/**
 * Books one billed call on its route and returns the verdict it carries, if any. A hit
 * on an effort the route has never billed before is evidence that the route keeps its
 * prefix: a hit on a previously billed effort proves nothing, because providers keep a
 * cache entry per effort and a return within retention reads that entry back. A miss
 * counts against the route only when the payload showed the effort change and nothing
 * else (expiry, another named mutation) explains it. Turning thinking on or off stays
 * a distinct mutation and never produces evidence.
 */
export function recordBilledThinking(
	ledger: ThinkingEvidenceLedger,
	route: ThinkingRoute,
	change: BilledThinkingChange,
): ThinkingEvidence | undefined {
	const record = routeRecord(ledger, route);
	const verdict = thinkingVerdict(change, record.billedEfforts);
	if (change.currentLevel !== undefined) {
		record.billedEfforts.add(wireThinkingEffort(change.map, change.currentLevel));
	}
	if (verdict) record.verdict = verdict;
	return verdict;
}

/** The longest retention Cachemire knows (OpenAI extended, `OPENAI_EXTENDED_WINDOW` in
 * retention.ts, which this module cannot import without a cycle; a test pins the two):
 * an effort billed within it may still have a warm entry when a later process returns. */
export const EFFORT_MEMORY_MS = 24 * 60 * 60 * 1000;

/**
 * Seeds the active route with the efforts a resumed session billed recently, walking
 * Pi's persisted `thinking_level_change` entries along the active path, so a return to
 * one of them in this process is not mistaken for fresh evidence.
 */
export function rememberBilledEfforts(
	ledger: ThinkingEvidenceLedger,
	entries: readonly unknown[],
	leafId: string | null,
	model: ExtensionContext["model"],
	now: number,
): void {
	if (!model || leafId === null) return;
	const route = routeOf(model);
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
	for (const entry of path.reverse()) {
		if (entry.type === "thinking_level_change") {
			level = stringValue(entry.thinkingLevel);
			continue;
		}
		if (entry.type !== "message" || !isJsonObject(entry.message) || entry.message.role !== "assistant") continue;
		const { message } = entry;
		if (message.provider !== route.provider || message.api !== route.api || message.model !== route.model) continue;
		const at = nonNegativeNumberValue(message.timestamp);
		if (level === undefined || at === undefined || now - at > EFFORT_MEMORY_MS) continue;
		record.billedEfforts.add(wireThinkingEffort(model.thinkingLevelMap, level));
	}
}

function thinkingVerdict(
	change: BilledThinkingChange,
	billedEfforts: ReadonlySet<string>,
): ThinkingEvidence | undefined {
	if (change.incomparable || change.lastCallLevel === undefined || change.currentLevel === undefined) {
		return undefined;
	}
	const from = wireThinkingEffort(change.map, change.lastCallLevel);
	const to = wireThinkingEffort(change.map, change.currentLevel);
	if (from === to || from === "off" || to === "off") return undefined;
	const verdict = { from, to, cacheRead: change.usage.cacheRead, expectedRead: change.expectedRead };
	if (change.classification.kind === "hit") return billedEfforts.has(to) ? undefined : { ...verdict, held: true };
	if (change.classification.kind === "cold") return undefined;
	return change.thinkingNamedAtSend && !change.windowExpired ? { ...verdict, held: false } : undefined;
}

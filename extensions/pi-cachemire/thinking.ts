export interface ThinkingRoute {
	provider: string;
	model: string;
	api: string;
	supportsMidConvoEffort: boolean;
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

export function thinkingChangesPreserveCache(route: ThinkingRoute | undefined): boolean {
	if (route?.api !== "anthropic-messages") return false;
	// The exact-model fallback covers stale local overrides that shadow Pi's catalogue
	// flag. Direct Pi 0.85.1 calls retained full message-heavy prefixes on both changes.
	return (
		route.supportsMidConvoEffort ||
		(route.provider === "anthropic" && route.model === "claude-fable-5-1")
	);
}

export function thinkingChangeInvalidatesCache(
	route: ThinkingRoute | undefined,
	map: Partial<Record<string, string | null>> | undefined,
	previousLevel: string | undefined,
	nextLevel: string | undefined,
): boolean {
	if (previousLevel === undefined || nextLevel === undefined) return false;
	const previousEffort = wireThinkingEffort(map, previousLevel);
	const nextEffort = wireThinkingEffort(map, nextLevel);
	return (
		previousEffort !== nextEffort &&
		(!thinkingChangesPreserveCache(route) || previousEffort === "off" || nextEffort === "off")
	);
}

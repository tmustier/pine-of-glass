// Vocabulary layers (design language §9.10): the built-ins, then layers other extensions
// send on Pi's event bus, then the user's pi-traceline.json, then the project's unless
// the user told Pi not to trust the project.
// A layer adds entries, replaces them by id, or turns them off. A problem leaves out only
// what it touches and is notified once, naming its layer.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isJsonObject } from "../_lib/boundary.ts";
import { configPaths } from "../_lib/config.ts";
import { BUILT_IN_ENTRIES, parseVocabulary, useVocabulary, type ParsedVocabulary, type VocabularyEntry } from "./records.ts";

/** The event-bus channel another extension sends its layer on. */
export const VOCABULARY_CHANNEL = "traceline:vocabulary";

/** One layer as its source wrote it. `unreadable` reports a layer that could not be read at all. */
export type VocabularyLayer = { source: string; vocabulary?: unknown; disableVocabulary?: unknown; unreadable?: string };

/** Apply layers in order over the built-ins. Every problem names its layer. */
export function layerVocabulary(layers: readonly VocabularyLayer[]): ParsedVocabulary {
  const entries = new Map<string, VocabularyEntry>(BUILT_IN_ENTRIES.map((entry) => [entry.id, entry]));
  const known = new Set(entries.keys());
  const problems: string[] = [];
  for (const { source, vocabulary, disableVocabulary, unreadable } of layers) {
    const report = (problem: string) => problems.push(`${source}: ${problem}`);
    if (unreadable) report(unreadable);
    const parsed = vocabulary === undefined ? { entries: [], problems: [] } : parseVocabulary(vocabulary);
    for (const entry of parsed.entries) known.add(entry.id);
    if (disableVocabulary !== undefined) {
      const ids = Array.isArray(disableVocabulary) && disableVocabulary.every((id) => typeof id === "string") ? disableVocabulary : undefined;
      if (!ids) report("disableVocabulary must list entry ids");
      for (const id of ids ?? []) {
        if (known.has(id)) entries.delete(id);
        else report(`disableVocabulary names no entry: ${id}`);
      }
    }
    parsed.problems.forEach(report);
    for (const entry of parsed.entries) entries.set(entry.id, entry);
  }
  return { entries: [...entries.values()], problems };
}

const fromHome = (path: string) => (path.startsWith(`${homedir()}${sep}`) ? `~/${relative(homedir(), path)}` : path);

function fileLayer(path: string, source: string, trusted: boolean): VocabularyLayer[] {
  if (!existsSync(path)) return [];
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return [{ source, unreadable: `is not valid JSON (${error instanceof Error ? error.message : String(error)})` }];
  }
  if (!isJsonObject(value) || (value.vocabulary === undefined && value.disableVocabulary === undefined)) return [];
  if (!trusted) return [{ source, unreadable: "left out: you told Pi not to trust this project" }];
  return [{ source, vocabulary: value.vocabulary, disableVocabulary: value.disableVocabulary }];
}

/**
 * Keep traceline's vocabulary current while `owns()`: config files at session start, an
 * extension's layer whenever it arrives. `changed` runs after every change so rows re-render.
 */
export function installVocabulary(pi: ExtensionAPI, owns: () => boolean, changed: () => void): void {
  const sent = new Map<string, VocabularyLayer>();
  let files: VocabularyLayer[] = [];
  let notify: ((message: string) => void) | undefined;
  const notified = new Set<string>();
  const apply = () => {
    const { entries, problems } = layerVocabulary([...sent.values(), ...files]);
    useVocabulary(entries);
    changed();
    const fresh = problems.filter((problem) => !notified.has(problem));
    if (!notify || fresh.length === 0) return;
    for (const problem of fresh) notified.add(problem);
    notify(`traceline vocabulary left out:\n${fresh.join("\n")}`);
  };
  pi.events.on(VOCABULARY_CHANNEL, (data) => {
    const source = isJsonObject(data) && typeof data.source === "string" && data.source ? data.source : undefined;
    if (!isJsonObject(data) || !source) sent.set("", { source: VOCABULARY_CHANNEL, unreadable: "a layer needs a source name" });
    else sent.set(source, { source, vocabulary: data.vocabulary, disableVocabulary: data.disableVocabulary });
    if (owns()) apply();
  });
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (!owns()) return;
    const [user, project] = configPaths("pi-traceline", ctx.cwd);
    files = [...fileLayer(user!, fromHome(user!), true), ...fileLayer(project!, relative(ctx.cwd, project!), ctx.isProjectTrusted())];
    notify = ctx.hasUI ? (message) => ctx.ui.notify(message, "warning") : undefined;
    apply();
  });
  pi.on("session_shutdown", () => {
    notify = undefined;
  });
}

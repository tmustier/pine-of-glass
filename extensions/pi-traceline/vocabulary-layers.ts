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
import { BUILT_IN_ENTRIES, parseVocabulary, useVocabulary, type VocabularyEntry } from "./records.ts";

/** The event-bus channel another extension sends its layer on. */
export const VOCABULARY_CHANNEL = "traceline:vocabulary";

type VocabularyLayer = { source: string; entries: VocabularyEntry[]; disabled: string[]; problems: string[] };

function parseLayer(source: string, value: unknown): VocabularyLayer {
  const { vocabulary, disableVocabulary } = isJsonObject(value) ? value : {};
  const parsed = vocabulary === undefined ? { entries: [], problems: [] } : parseVocabulary(vocabulary);
  if (disableVocabulary === undefined) return { source, ...parsed, disabled: [] };
  if (Array.isArray(disableVocabulary) && disableVocabulary.every((id) => typeof id === "string")) {
    return { source, ...parsed, disabled: disableVocabulary };
  }
  return { source, ...parsed, disabled: [], problems: ["disableVocabulary must list entry ids", ...parsed.problems] };
}

function fileLayer(path: string, source: string, trusted: boolean): VocabularyLayer[] {
  if (!existsSync(path)) return [];
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return [{ source, entries: [], disabled: [], problems: [`is not valid JSON (${error instanceof Error ? error.message : String(error)})`] }];
  }
  if (!isJsonObject(value) || (value.vocabulary === undefined && value.disableVocabulary === undefined)) return [];
  if (!trusted) return [{ source, entries: [], disabled: [], problems: ["left out: you told Pi not to trust this project"] }];
  return [parseLayer(source, value)];
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
    const entries = new Map(BUILT_IN_ENTRIES.map((entry) => [entry.id, entry]));
    const known = new Set(entries.keys());
    const problems: string[] = [];
    for (const layer of [...sent.values(), ...files]) {
      for (const entry of layer.entries) known.add(entry.id);
      for (const id of layer.disabled) {
        if (known.has(id)) entries.delete(id);
        else problems.push(`${layer.source}: disableVocabulary names no entry: ${id}`);
      }
      problems.push(...layer.problems.map((problem) => `${layer.source}: ${problem}`));
      for (const entry of layer.entries) entries.set(entry.id, entry);
    }
    useVocabulary([...entries.values()]);
    changed();
    const fresh = problems.filter((problem) => !notified.has(problem));
    if (!notify || fresh.length === 0) return;
    for (const problem of fresh) notified.add(problem);
    notify(`traceline vocabulary left out:\n${fresh.join("\n")}`);
  };
  pi.events.on(VOCABULARY_CHANNEL, (data) => {
    const source = isJsonObject(data) && typeof data.source === "string" && data.source ? data.source : undefined;
    if (!source) sent.set("", { source: VOCABULARY_CHANNEL, entries: [], disabled: [], problems: ["a layer needs a source name"] });
    else sent.set(source, parseLayer(source, data));
    if (owns()) apply();
  });
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (!owns()) return;
    const [user, project] = configPaths("pi-traceline", ctx.cwd);
    const userSource = user!.startsWith(`${homedir()}${sep}`) ? `~/${relative(homedir(), user!)}` : user!;
    files = [...fileLayer(user!, userSource, true), ...fileLayer(project!, relative(ctx.cwd, project!), ctx.isProjectTrusted())];
    notify = ctx.hasUI ? (message) => ctx.ui.notify(message, "warning") : undefined;
    apply();
  });
  pi.on("session_shutdown", () => {
    notify = undefined;
  });
}

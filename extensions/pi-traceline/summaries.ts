// Summaries (design language §9.15, experimental): gists of cut commands and thinking.
// Off unless the user's own config enables them; cached gists live in session entries.
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isJsonObject } from "../_lib/boundary.ts";
import { configPaths, readJsonConfig } from "../_lib/config.ts";

export type GistKind = "command" | "thinking";
/** The custom entry each gist is stored in: `{ key, gist, model, cost }`. */
export const SUMMARY_ENTRY = "traceline-summary";
const DEFAULT_MODEL = "openai-codex/gpt-6-luna";
// agent-default (not a user rule): 2026-10-18. Batches of up to 8 items, gathered for
// 250 ms; at most 4000 characters of each item and 120 of each gist.
const BATCH = 8;
const GATHER_MS = 250;
const INPUT_MAX = 4000;
const GIST_MAX = 120;

const SYSTEM = `You write gists for the transcript of a coding agent, so a reader skimming it knows what a line holds without reading it. You get a JSON list of items, each with an id, a kind and its text. Reply with one JSON object mapping every id to its gist.

A gist is at most 60 characters, plain words, lowercase, no full stop, no quotes.
- kind "command" is a shell command: say what it does, verb first, present tense, naming what it acts on ("lints, type-checks and commits slack-bridge"). Do not claim it worked.
- kind "thinking" is the agent's reasoning: say what it works out or decides ("checks whether the push landed before merging").`;

type Item = { key: string; kind: GistKind; text: string };
type Summarize = (kind: GistKind, text: string, settled: boolean) => string | undefined;
let summarize: Summarize | undefined;

/** Return a cached gist, or queue settled text for the next batch when enabled. */
export function gistFor(kind: GistKind, text: string, settled: boolean): string | undefined {
  return summarize?.(kind, text, settled);
}

/** Install summaries for the TUI owner's sessions; headless children leave them alone. */
export function installSummaries(pi: ExtensionAPI, owns: () => boolean, changed: () => void): void {
  let stop: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (!owns()) return;
    stop?.();
    const name = readJsonConfig(configPaths("pi-traceline", ctx.cwd)[0]!, (value) => {
      const summaries = isJsonObject(value) ? value.summaries : undefined;
      if (summaries === true) return DEFAULT_MODEL;
      return isJsonObject(summaries) && typeof summaries.model === "string" ? summaries.model : undefined;
    });
    if (!name) return;
    const [provider, ...id] = name.split("/");
    const model = ctx.modelRegistry.find(provider!, id.join("/"));
    if (!model) {
      if (ctx.hasUI) ctx.ui.notify(`traceline summaries are off: no model ${name}`, "warning");
      return;
    }
    const gists = new Map<string, string | undefined>();
    const waiting: Item[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let asking = false;
    let stopped = false;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== SUMMARY_ENTRY || !isJsonObject(entry.data)) continue;
      const { key, gist } = entry.data;
      if (typeof key === "string" && typeof gist === "string") gists.set(key, gist);
    }
    const gather = (): void => {
      if (stopped || timer || asking || waiting.length === 0) return;
      timer = setTimeout(async () => {
        timer = undefined;
        const batch = waiting.splice(0, BATCH);
        asking = true;
        try {
          const items = batch.map(({ kind, text }, index) => ({ id: String(index + 1), kind, text }));
          let value: unknown;
          let cost: number;
          try {
            const answer = await ctx.modelRegistry.streamSimple(model, {
              systemPrompt: SYSTEM,
              messages: [{ role: "user", content: JSON.stringify(items), timestamp: Date.now() }],
            }, { reasoning: "low" }).result();
            if (stopped) return;
            const text = answer.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
            value = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
            cost = answer.usage.cost.total / batch.length;
          } catch {
            // A failed request or unreadable reply answers nothing; do not ask again.
            return;
          }
          if (!isJsonObject(value)) return;
          let added = false;
          for (const [index, { key }] of batch.entries()) {
            const raw = value[String(index + 1)];
            if (typeof raw !== "string" || !raw.trim()) continue;
            const gist = raw.replace(/\s+/g, " ").trim().slice(0, GIST_MAX);
            gists.set(key, gist);
            pi.appendEntry(SUMMARY_ENTRY, { key, gist, model: `${model.provider}/${model.id}`, cost });
            added = true;
          }
          if (added) changed();
        } finally {
          asking = false;
          gather();
        }
      }, GATHER_MS);
    };
    summarize = (kind, text, settled) => {
      const key = `${kind}:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
      if (settled && !gists.has(key)) {
        gists.set(key, undefined);
        waiting.push({ key, kind, text: text.slice(0, INPUT_MAX) });
        gather();
      }
      return gists.get(key);
    };
    stop = () => {
      stopped = true;
      clearTimeout(timer);
      summarize = undefined;
      stop = undefined;
    };
  });
  pi.on("session_shutdown", () => stop?.());
}

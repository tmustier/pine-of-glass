// Summaries (design language §9.15, experimental): a model's gist of what a trace row had
// to leave out, a cut or wrapped bash command or a cut thinking preview. Off unless the
// user's own pi-traceline.json turns it on. Renderers ask for gists of settled text;
// requests go out in batches, and each gist is stored in the session as a custom entry
// keyed by a hash of its text, so a replayed session reads it back and asks for nothing.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isJsonObject } from "../_lib/boundary.ts";
import { configPaths } from "../_lib/config.ts";

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

const gists = new Map<string, string>();
const unanswered = new Set<string>();
const waiting = new Map<string, Item>();
let ask: ((batch: Item[]) => Promise<void>) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let asking = false;
// Bumped whenever summaries stop, so a reply for an ended session is dropped.
let generation = 0;

const keyOf = (kind: GistKind, text: string) => `${kind}:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;

/**
 * The gist of `text` when summaries are on and it has one. Settled text without one is
 * asked for in the next batch; the row renders as it would without summaries meanwhile.
 */
export function gistFor(kind: GistKind, text: string, settled: boolean): string | undefined {
  if (!ask) return undefined;
  const key = keyOf(kind, text);
  const gist = gists.get(key);
  if (gist === undefined && settled && !unanswered.has(key)) {
    unanswered.add(key);
    waiting.set(key, { key, kind, text: text.slice(0, INPUT_MAX) });
    gather();
  }
  return gist;
}

function gather(): void {
  if (!timer && !asking && waiting.size > 0) timer = setTimeout(() => void send(), GATHER_MS);
}

async function send(): Promise<void> {
  timer = undefined;
  const batch = [...waiting.values()].slice(0, BATCH);
  for (const { key } of batch) waiting.delete(key);
  if (!ask || batch.length === 0) return;
  asking = true;
  try {
    await ask(batch);
  } finally {
    asking = false;
    gather();
  }
}

function stop(): void {
  generation++;
  if (timer) clearTimeout(timer);
  timer = undefined;
  ask = undefined;
  gists.clear();
  unanswered.clear();
  waiting.clear();
}

/** The summary model the user's own file names: `"summaries": true` or `{ "model": "provider/id" }`. */
function configuredModel(cwd: string): string | undefined {
  const [user] = configPaths("pi-traceline", cwd);
  if (!user || !existsSync(user)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(user, "utf8"));
    const summaries = isJsonObject(value) ? value.summaries : undefined;
    if (summaries === true) return DEFAULT_MODEL;
    return isJsonObject(summaries) && typeof summaries.model === "string" ? summaries.model : undefined;
  } catch {
    return undefined;
  }
}

function readGists(text: string, batch: Item[]): Map<string, string> {
  const found = new Map<string, string>();
  try {
    const value: unknown = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    if (!isJsonObject(value)) return found;
    batch.forEach(({ key }, index) => {
      const gist = value[String(index + 1)];
      if (typeof gist === "string" && gist.trim()) found.set(key, gist.replace(/\s+/g, " ").trim().slice(0, GIST_MAX));
    });
  } catch {
    // A reply that is not JSON answers nothing; those items are not asked for again.
  }
  return found;
}

function asker(pi: ExtensionAPI, ctx: ExtensionContext, model: Model<Api>, changed: () => void): (batch: Item[]) => Promise<void> {
  const mine = generation;
  return async (batch) => {
    const items = batch.map(({ kind, text }, index) => ({ id: String(index + 1), kind, text }));
    const stream = ctx.modelRegistry.streamSimple(model, {
      systemPrompt: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(items), timestamp: Date.now() }],
    }, { reasoning: "low" });
    const answer = await stream.result().catch(() => undefined);
    if (!answer || generation !== mine) return;
    const text = answer.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    const found = readGists(text, batch);
    const cost = answer.usage.cost.total / batch.length;
    for (const [key, gist] of found) {
      gists.set(key, gist);
      pi.appendEntry(SUMMARY_ENTRY, { key, gist, model: `${model.provider}/${model.id}`, cost });
    }
    if (found.size > 0) changed();
  };
}

/**
 * Turn summaries on for each session the TUI owner starts, when the user's file asks for
 * them, reading back the gists the session already holds. `changed` runs when gists arrive.
 */
export function installSummaries(pi: ExtensionAPI, owns: () => boolean, changed: () => void): void {
  pi.on("session_start", (_event, ctx) => {
    stop();
    const name = owns() ? configuredModel(ctx.cwd) : undefined;
    if (!name) return;
    const [provider, ...id] = name.split("/");
    const model = ctx.modelRegistry.find(provider ?? "", id.join("/"));
    if (!model) {
      if (ctx.hasUI) ctx.ui.notify(`traceline summaries are off: no model ${name}`, "warning");
      return;
    }
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== SUMMARY_ENTRY || !isJsonObject(entry.data)) continue;
      const { key, gist } = entry.data;
      if (typeof key === "string" && typeof gist === "string") gists.set(key, gist);
    }
    ask = asker(pi, ctx, model, changed);
  });
  pi.on("session_shutdown", () => stop());
}

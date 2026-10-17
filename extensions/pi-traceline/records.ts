import assert from "node:assert/strict";
import { stripAnsi } from "../_lib/ansi.ts";
import { isJsonObject } from "../_lib/boundary.ts";
import type { ToolResultLike, ToolRowDataLike } from "../_lib/chat.ts";
import { commandKey, readShell, type ShellCommand, type ShellWord } from "./record-shell.ts";
import { BUILT_IN_VOCABULARY } from "./vocabulary.ts";

// Records of consequence (design language §9.10): vocabulary entries are plain data
// (vocabulary.ts), parsed here at the boundary, and an entry loads only when its examples
// hold. What a pattern cannot say is code that belongs to a built-in entry. Layering
// lives in vocabulary-layers.ts; rendering stays in index.ts because it depends on live
// theme ink and row fitting.
export type RecordTone = "success" | "warning";
/** Which of §9.10's evidence sources produced the fact. */
export type RecordEvidence = "output" | "state" | "quiet";
/** `by`: the keys (record-shell.ts) of the commands that earned it; the fitter keeps them readable (§9.8). */
export type RecordFact = { verb: string; datum: string; at: number; tone: RecordTone; opaque: boolean; evidence: RecordEvidence; by: string[] };

/** A vocabulary entry as written (§9.10): plain data, the shape a JSON file would hold. */
export type VocabularyEntryInput = {
  id: string;
  commands: string[];
  requires?: string[];
  unless?: string[];
  records?: { output: string; verb: string; datum: string; tone?: RecordTone; opaque?: boolean }[];
  examples: { command: string; output: string; error?: boolean; records: string[] }[];
};
type Options = { long: string[]; short: string };
type RecordRule = { pattern: RegExp; verb: string; datum: string; tone: RecordTone; opaque: boolean };
export type VocabularyEntry = {
  id: string;
  commands: [string, ...string[]][];
  requires: Options | undefined;
  unless: Options;
  records: RecordRule[];
  examples: VocabularyEntryInput["examples"];
  /** Only built-in entries carry code (§9.10). */
  code: EntryCode | undefined;
};

export type ParsedVocabulary = { entries: VocabularyEntry[]; problems: string[] };

type Operation = { args: ShellWord[]; command: ShellCommand };
/** What a pattern cannot say about an entry: an extra qualification, a datum the command qualifies, a non-output evidence source. */
type EntryCode = { qualifies?: (args: ShellWord[]) => boolean; datum?: (datum: string, ops: Operation[]) => string; fallback?: "merge" | "worktree" };

// --- invocations -------------------------------------------------------------------

// git's global options sit between `git` and its subcommand; VALUE options take the next word.
const GIT_GLOBAL_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const GIT_GLOBAL_FLAG = /^(?:--no-pager|-P|-p|--paginate|--bare|--no-replace-objects|--literal-pathspecs|--no-optional-locks|--(?:git-dir|work-tree|namespace|exec-path|config-env)=.*)$/;

function operationArgs(command: ShellCommand, path: readonly [string, ...string[]]): ShellWord[] | undefined {
  const { head, args: words } = command;
  if (!head.literal || head.text !== path[0]) return undefined;
  let i = 0;
  if (path[0] === "git") {
    while (i < words.length && (GIT_GLOBAL_VALUE.has(words[i]!.text) || GIT_GLOBAL_FLAG.test(words[i]!.text))) {
      i += GIT_GLOBAL_VALUE.has(words[i]!.text) ? 2 : 1;
    }
  }
  for (const part of path.slice(1)) {
    if (words[i]?.text !== part) return undefined;
    i++;
  }
  return words.slice(i);
}

/** Options before `--`: long names exactly or as `--name=value`, short letters anywhere in a cluster. */
function hasOption(args: ShellWord[], long: readonly string[], short = ""): boolean {
  for (const { text } of args) {
    if (text === "--") return false;
    if (long.some((name) => text === name || text.startsWith(`${name}=`))) return true;
    if (short && /^-[A-Za-z]+$/.test(text) && text.slice(1).split("").some((letter) => short.includes(letter))) return true;
  }
  return false;
}

function positionals(args: ShellWord[], valueOptions: ReadonlySet<string>): ShellWord[] {
  const found: ShellWord[] = [];
  for (let i = 0; i < args.length; i++) {
    const { text } = args[i]!;
    if (text === "--") return [...found, ...args.slice(i + 1)];
    if (!text.startsWith("-") || text === "-") found.push(args[i]!);
    else if (valueOptions.has(text)) i++;
  }
  return found;
}

// --- gh pull requests ----------------------------------------------------------------

const GH_PR_VALUE_OPTIONS = new Set(["--author-email", "--body", "--body-file", "--match-head-commit", "--repo", "--subject", "-A", "-b", "-F", "-R", "--jq", "--json", "--template", "-q", "-t"]);

/** A PR the command names explicitly: its number, and its repository when the command says. */
type PrTarget = { number: string; repo: string | undefined };

function prTarget(args: ShellWord[]): PrTarget | undefined {
  const [first] = positionals(args, GH_PR_VALUE_OPTIONS);
  if (!first?.literal) return undefined;
  const url = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\b/.exec(first.text);
  const number = url?.[2] ?? /^#?(\d+)$/.exec(first.text)?.[1];
  if (!number) return undefined;
  const i = args.findIndex(({ text }) => text === "--repo" || text === "-R");
  const option = i >= 0 ? args[i + 1]?.text : args.find(({ text }) => text.startsWith("--repo="))?.text.slice("--repo=".length);
  return { number, repo: (option ?? url?.[1])?.toLowerCase() };
}

// --- the vocabulary ------------------------------------------------------------------

const OPTION = /^(?:--[A-Za-z0-9][\w-]*|-[A-Za-z])$/;
const PLACEHOLDER = /\{(\w+)\}/g;

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function optionSet(value: unknown, field: string): Options {
  const options = value === undefined ? [] : stringList(value);
  if (!options || options.some((option) => !OPTION.test(option))) throw new Error(`${field} must list options such as --dry-run or -n`);
  return { long: options.filter((option) => option.startsWith("--")), short: options.filter((option) => !option.startsWith("--")).map((option) => option[1]).join("") };
}

const listed = (records: string[]) => (records.length ? records.join(", ") : "nothing");

/**
 * Parse vocabulary entries at the boundary (§9.10). An entry with any problem, a failing
 * example included, is left out whole and reported, so one bad entry never takes the
 * others down. Only the built-ins pass `code`.
 */
export function parseVocabulary(value: unknown, code: ReadonlyMap<string, EntryCode> = new Map()): ParsedVocabulary {
  if (!Array.isArray(value)) return { entries: [], problems: ["vocabulary must be a list of entries"] };
  const entries: VocabularyEntry[] = [];
  const problems: string[] = [];
  value.forEach((item: unknown, index) => {
    const id = isJsonObject(item) && typeof item.id === "string" && item.id ? item.id : undefined;
    try {
      if (!isJsonObject(item) || !id) throw new Error("needs an id");
      if (entries.some((entry) => entry.id === id)) throw new Error("repeats an earlier id");
      const commands = stringList(item.commands)?.map((command) => command.trim().split(/\s+/));
      if (!commands?.length || commands.some((path) => !path[0])) throw new Error("needs commands such as \"git push\"");
      if (item.records !== undefined && !Array.isArray(item.records)) throw new Error("records must be a list");
      if (!Array.isArray(item.examples) || item.examples.length === 0) throw new Error("needs examples");
      const entry: VocabularyEntry = {
        id,
        commands: commands.map((path) => [path[0]!, ...path.slice(1)]),
        requires: item.requires === undefined ? undefined : optionSet(item.requires, "requires"),
        unless: optionSet(item.unless, "unless"),
        records: (item.records ?? []).map((value: unknown): RecordRule => {
          if (!isJsonObject(value) || typeof value.output !== "string" || typeof value.verb !== "string" || !value.verb || typeof value.datum !== "string") {
            throw new Error("each record needs output, verb and datum strings");
          }
          const pattern = new RegExp(value.output, "gm");
          const groups = new Set([...value.output.matchAll(/\(\?<(\w+)>/g)].map((m) => m[1]));
          const missing = [...value.datum.matchAll(PLACEHOLDER)].map((m) => m[1]!).find((name) => !groups.has(name));
          if (missing) throw new Error(`datum {${missing}} names no group in its output pattern`);
          if (value.tone !== undefined && value.tone !== "success" && value.tone !== "warning") throw new Error("tone must be success or warning");
          if (value.opaque !== undefined && typeof value.opaque !== "boolean") throw new Error("opaque must be true or false");
          return { pattern, verb: value.verb, datum: value.datum, tone: value.tone ?? "success", opaque: value.opaque ?? false };
        }),
        examples: item.examples.map((value: unknown) => {
          if (!isJsonObject(value)) throw new Error("each example needs command, output and records");
          const records = stringList(value.records);
          if (typeof value.command !== "string" || typeof value.output !== "string" || !records || (value.error !== undefined && typeof value.error !== "boolean")) {
            throw new Error("each example needs command, output and records");
          }
          return { command: value.command, output: value.output, error: value.error === true, records };
        }),
        code: code.get(id),
      };
      if (!entry.examples.some(({ records }) => records.length > 0)) throw new Error("needs an example that yields a record");
      for (const [index, { command, output, error, records }] of entry.examples.entries()) {
        const yields = factsFor([entry], command, `${output}\n`, error !== true).map(({ verb, datum }) => `${verb} ${datum}`);
        if (yields.join("\n") !== records.join("\n")) throw new Error(`example ${index + 1} should yield ${listed(records)} but yields ${listed(yields)}`);
      }
      entries.push(entry);
    } catch (error) {
      problems.push(`${id ?? `entry ${index + 1}`}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { entries, problems };
}

const GIT_PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);

// What a pattern cannot say (§9.10), attached to the built-in entry of that id: an extra
// qualification, a datum the command qualifies, and the observed-state and quiet-success
// sources. A layer that replaces the entry replaces it with data only.
const CODE = new Map<string, EntryCode>([
  ["git.push.delete", {
    qualifies: (args) => hasOption(args, ["--delete"], "d") || positionals(args, GIT_PUSH_VALUE_OPTIONS).slice(1).some(({ text }) => text.startsWith(":")),
    datum: (ref, ops) => {
      const remotes = new Set(ops.map((op) => positionals(op.args, GIT_PUSH_VALUE_OPTIONS)[0]).map((word) => (word?.literal ? word.text : undefined)));
      const [remote] = remotes.size === 1 ? [...remotes] : [undefined];
      return remote ? `${remote}/${ref}` : ref;
    },
  }],
  ["git.worktree.remove", { fallback: "worktree" }],
  ["gh.pr.merge", { fallback: "merge" }],
  ["gh.release.create", {
    datum: (tag) => {
      try {
        return decodeURIComponent(tag);
      } catch {
        return tag;
      }
    },
  }],
]);

export function resultText(comp: ToolRowDataLike | undefined): string {
  const content = comp?.result?.content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") out += `${block.text}\n`;
  }
  return out;
}

function factsFor(entries: readonly VocabularyEntry[], command: string, text: string, cleanExit: boolean): RecordFact[] {
  const out = stripAnsi(text);
  const script = readShell(command);
  const trimmed = out.trim();
  return entries.flatMap((entry): RecordFact[] => {
    const invocations = (commands: ShellCommand[]): Operation[] => commands.flatMap((command) =>
      entry.commands.flatMap((path) => {
        const args = operationArgs(command, path);
        if (!args || (entry.requires && !hasOption(args, entry.requires.long, entry.requires.short))) return [];
        if (hasOption(args, entry.unless.long, entry.unless.short) || entry.code?.qualifies?.(args) === false) return [];
        return [{ args, command }];
      }));
    const ops = invocations(script.commands);
    const all = [...ops, ...invocations(script.nested)];
    if (all.length === 0) return [];
    const by = all.map(({ command }) => commandKey(command));
    const output = entry.records.flatMap((rule) => [...out.matchAll(rule.pattern)].flatMap((match): RecordFact[] => {
      let complete = true;
      const datum = rule.datum.replace(PLACEHOLDER, (_, name: string) => {
        const value = match.groups?.[name];
        if (value === undefined) complete = false;
        return value ?? "";
      });
      return complete ? [{ verb: rule.verb, datum: entry.code?.datum?.(datum, all) ?? datum, at: match.index, tone: rule.tone, opaque: rule.opaque, evidence: "output", by }] : [];
    }));
    const fallback = entry.code?.fallback;
    if (output.length || !fallback) return output;

    if (fallback === "merge" && trimmed !== "(no output)") {
      let merged = /^MERGED(?:\s+[0-9a-f]{7,40})?$/.test(trimmed);
      if (trimmed.startsWith("{")) {
        try {
          const state: unknown = JSON.parse(trimmed);
          merged = isJsonObject(state) && state.state === "MERGED";
        } catch {
          return [];
        }
      }
      if (!merged) return [];
      const targeted = ops.flatMap((op) => {
        const target = prTarget(op.args);
        return target ? [{ op, target }] : [];
      });
      if (targeted.length !== 1) return [];
      const { op, target } = targeted[0]!;
      for (const command of script.commands.slice(script.commands.indexOf(op.command) + 1)) {
        if (command.before === "||") break;
        const view = operationArgs(command, ["gh", "pr", "view"]);
        const viewed = view && prTarget(view);
        const sameRepo = viewed?.repo === undefined || target.repo === undefined || viewed.repo === target.repo;
        const hasState = view?.some(({ text }, i) =>
          (text === "--json" ? view[i + 1]?.text : text.startsWith("--json=") ? text.slice("--json=".length) : undefined)?.split(",").includes("state"));
        if (viewed?.number === target.number && sameRepo && hasState) {
          return [{ verb: "merged", datum: `PR #${target.number}`, at: out.indexOf(trimmed), tone: "success", opaque: false, evidence: "state", by }];
        }
        if (["cd", "pushd", "popd"].includes(command.head.text)) break;
      }
      return [];
    }

    if (!cleanExit || trimmed !== "(no output)" || ops.length !== 1) return [];
    const op = ops[0]!;
    if (op.command !== script.statusOwner) return [];
    if (fallback === "worktree") {
      const [path] = positionals(op.args, new Set());
      return path?.literal ? [{ verb: "removed worktree", datum: path.text, at: 0, tone: "success", opaque: false, evidence: "quiet", by }] : [];
    }
    const target = prTarget(op.args);
    return target && !hasOption(op.args, ["--auto", "--disable-auto"])
      ? [{ verb: "merged", datum: `PR #${target.number}`, at: 0, tone: "success", opaque: false, evidence: "quiet", by }]
      : [];
  }).sort((a, b) => a.at - b.at);
}

const BUILT_IN = parseVocabulary(BUILT_IN_VOCABULARY, CODE);
assert.equal(BUILT_IN.problems.length, 0, `traceline's built-in vocabulary is invalid: ${BUILT_IN.problems.join("; ")}`);
assert([...CODE.keys()].every((id) => BUILT_IN.entries.some((entry) => entry.id === id)), "traceline record code names no vocabulary entry");
/** The built-in entries, examples included and checked: the first layer of every vocabulary. */
export const BUILT_IN_ENTRIES: readonly VocabularyEntry[] = BUILT_IN.entries;

let active: readonly VocabularyEntry[] = BUILT_IN_ENTRIES;
// Facts depend only on the row's own command+result and the active vocabulary, so they
// cache against the result object identity until the vocabulary changes (rows re-render
// every frame; porcelain never changes once settled).
let recordFactCache = new WeakMap<ToolRowDataLike, { result: ToolResultLike; facts: RecordFact[] }>();

/** Make `entries` the vocabulary every later recordFacts call reads (vocabulary-layers.ts). */
export function useVocabulary(entries: readonly VocabularyEntry[]): void {
  active = entries;
  recordFactCache = new WeakMap();
}

export function recordFacts(comp: ToolRowDataLike): RecordFact[] {
  if (comp.toolName !== "bash") return [];
  const command = comp.args?.command;
  const { result } = comp;
  if (typeof command !== "string" || !result) return [];
  const cached = recordFactCache.get(comp);
  if (cached && cached.result === result) return cached.facts;
  const facts = factsFor(active, command, resultText(comp), result.isError === false);
  recordFactCache.set(comp, { result, facts });
  return facts;
}

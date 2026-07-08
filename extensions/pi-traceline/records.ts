import { stripAnsi } from "../_lib/ansi.ts";
import type { ToolRowDataLike } from "../_lib/chat.ts";

// Records of consequence (design language §9.10): parse reported success evidence
// for bash rows that changed shared state. Rendering stays in index.ts because it
// depends on live theme ink and row fitting.
export type RecordTone = "success" | "warning";
export type RecordFact = { verb: string; datum: string; at: number; tone: RecordTone; opaque: boolean };

type RecordRule = { gate: RegExp; parse: (out: string, command: string) => RecordFact[] };

function toolName(comp: ToolRowDataLike | undefined): string {
  return typeof comp?.toolName === "string" && comp.toolName.length > 0 ? comp.toolName : "tool";
}

function factsFrom(
  out: string,
  pattern: RegExp,
  verb: string,
  datum: (m: RegExpMatchArray) => string,
  options: { opaque?: boolean; tone?: (m: RegExpMatchArray) => RecordTone } = {},
): RecordFact[] {
  const facts: RecordFact[] = [];
  for (const m of out.matchAll(pattern)) {
    facts.push({
      verb,
      datum: datum(m),
      at: m.index ?? 0,
      tone: options.tone?.(m) ?? "success",
      opaque: options.opaque === true,
    });
  }
  return facts;
}

function decodedTag(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const SHELL_RECORD_SEPARATORS = new Set(["&&", "||", ";", "|"]);
const GH_PR_MERGE_VALUE_OPTIONS = new Set(["--author-email", "--body", "--body-file", "--match-head-commit", "--repo", "--subject"]);
const GH_PR_MERGE_SHORT_VALUE_OPTIONS = new Set(["-A", "-b", "-F", "-R"]);
const GH_PR_VIEW_VALUE_OPTIONS = new Set(["--jq", "--json", "--repo", "--template"]);
const GH_PR_VIEW_SHORT_VALUE_OPTIONS = new Set(["-q", "-R", "-t"]);

type GhPrKind = "merge" | "view";
type GhPrCommand = { kind: GhPrKind; prNumber: string | undefined; jsonFields: Set<string>; start: number; end: number };

function shellRecordWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  const push = () => {
    if (current.length > 0) {
      words.push(current);
      current = "";
    }
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < command.length) current += command[++i]!;
      else if (ch === '"') quote = undefined;
      else current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    if (ch === "'") {
      quote = "'";
      continue;
    }
    if (ch === '"') {
      quote = '"';
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += command[++i]!;
      continue;
    }
    if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
      push();
      words.push(`${ch}${command[++i]!}`);
      continue;
    }
    if (ch === ";" || ch === "|") {
      push();
      words.push(ch);
      continue;
    }
    current += ch;
  }
  push();
  return words;
}

function prNumberFromToken(token: string): string | undefined {
  const direct = /^#?(\d+)$/.exec(token);
  if (direct) return direct[1];
  return /\/pull\/(\d+)\b/.exec(token)?.[1];
}

function commandEnd(tokens: string[], start: number): number {
  let end = start;
  while (end < tokens.length && !SHELL_RECORD_SEPARATORS.has(tokens[end]!)) end++;
  return end;
}

function optionTakesValue(kind: GhPrKind, token: string): boolean {
  const long = kind === "merge" ? GH_PR_MERGE_VALUE_OPTIONS : GH_PR_VIEW_VALUE_OPTIONS;
  const short = kind === "merge" ? GH_PR_MERGE_SHORT_VALUE_OPTIONS : GH_PR_VIEW_SHORT_VALUE_OPTIONS;
  if (token.startsWith("--")) return !token.includes("=") && long.has(token);
  return token.length === 2 && short.has(token);
}

function explicitPrNumberInGhArgs(tokens: string[], start: number, end: number, kind: GhPrKind): string | undefined {
  let skipValue = false;
  for (let i = start; i < end; i++) {
    const token = tokens[i]!;
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (token === "--") {
      const next = tokens[i + 1];
      return next && i + 1 < end ? prNumberFromToken(next) : undefined;
    }
    if (token.startsWith("-")) {
      if (optionTakesValue(kind, token)) skipValue = true;
      continue;
    }
    return prNumberFromToken(token);
  }
  return undefined;
}

function jsonFieldsForView(tokens: string[], start: number, end: number): Set<string> {
  const fields = new Set<string>();
  for (let i = start; i < end; i++) {
    const token = tokens[i]!;
    if (token === "--json" && i + 1 < end) {
      for (const field of tokens[i + 1]!.split(",")) fields.add(field);
      i++;
    } else if (token.startsWith("--json=")) {
      for (const field of token.slice("--json=".length).split(",")) fields.add(field);
    }
  }
  return fields;
}

function scanGhPrCommands(tokens: string[]): GhPrCommand[] {
  const commands: GhPrCommand[] = [];
  for (let i = 0; i <= tokens.length - 3; i++) {
    if (tokens[i] !== "gh" || tokens[i + 1] !== "pr") continue;
    const kind = tokens[i + 2];
    if (kind !== "merge" && kind !== "view") continue;
    const argsStart = i + 3;
    const end = commandEnd(tokens, argsStart);
    commands.push({
      kind,
      prNumber: explicitPrNumberInGhArgs(tokens, argsStart, end, kind),
      jsonFields: kind === "view" ? jsonFieldsForView(tokens, argsStart, end) : new Set<string>(),
      start: i,
      end,
    });
    i = end;
  }
  return commands;
}

function hasFailureBranchBetween(tokens: string[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (tokens[i] === "||") return true;
  }
  return false;
}

function verifiedMergedPrNumber(command: string): string | undefined {
  const tokens = shellRecordWords(command);
  const commands = scanGhPrCommands(tokens);
  const merges = commands.filter((cmd) => cmd.kind === "merge" && cmd.prNumber);
  if (merges.length !== 1) return undefined;
  const merge = merges[0]!;
  for (const view of commands) {
    if (view.kind !== "view" || view.prNumber !== merge.prNumber || !view.jsonFields.has("state")) continue;
    if (view.start <= merge.start || hasFailureBranchBetween(tokens, merge.end, view.start)) continue;
    return merge.prNumber;
  }
  return undefined;
}

function ghPrMergeFacts(out: string, command: string): RecordFact[] {
  const nativeFacts = factsFrom(
    out,
    /(?:Merged|Squashed and merged|Rebased and merged) pull request \S*?#(\d+)/g,
    "merged",
    (m) => `PR #${m[1]}`,
  );
  if (nativeFacts.length > 0) return nativeFacts;
  const stateMatch = /^\s*MERGED(?:\s+[0-9a-f]{7,40})?\s*$/.exec(out);
  if (!stateMatch) return [];
  const prNumber = verifiedMergedPrNumber(command);
  if (!prNumber) return [];
  return [{ verb: "merged", datum: `PR #${prNumber}`, at: stateMatch.index, tone: "success", opaque: false }];
}

// Success porcelain only. Push failures (`! [rejected] main -> main`) have neither a
// hex range nor a `[new ...]` head, so they never match; `Everything up-to-date`
// contributes nothing. A targetless PR `MERGED` state is accepted only as a
// verified merged state after one explicit same-row `gh pr merge <n>` attempt.
const RECORD_RULES: RecordRule[] = [
  {
    // `[main a4f21c9]`, `[main (root-commit) a4f21c9]`, `[detached HEAD a4f21c9]`
    gate: /\bgit\b[^|;&]*\bcommit\b/,
    // The sha is opaque audit data (§9.10): the verb wears the ink, the sha stays dim.
    parse: (out) => factsFrom(out, /^\[[^\n\]]*?([0-9a-f]{7,40})\]/gm, "committed", (m) => m[1]!, { opaque: true }),
  },
  {
    // `1c75c2a..50cf33f main -> main`, `+ ... (forced update)`, `* [new tag] ...`
    gate: /\bgit\b[^|;&]*\bpush\b/,
    parse: (out) =>
      factsFrom(
        out,
        /^\s*(?:\+?\s?[0-9a-f]+\.\.\.?[0-9a-f]+|\* \[new (?:branch|tag)\])\s+\S+\s+->\s+(\S+)/gm,
        "pushed",
        (m) => m[1]!,
        { tone: (m) => (m[0].trimStart().startsWith("+") ? "warning" : "success") },
      ),
  },
  { gate: /\bgh\s+pr\s+merge\b/, parse: ghPrMergeFacts },
  {
    gate: /\bgh\s+pr\s+close\b/,
    parse: (out) => factsFrom(out, /Closed pull request \S*?#(\d+)/g, "closed", (m) => `PR #${m[1]}`),
  },
  {
    gate: /\bgh\s+pr\s+create\b/,
    parse: (out) => factsFrom(out, /\/pull\/(\d+)\b/g, "opened", (m) => `PR #${m[1]}`),
  },
  {
    gate: /\bgh\s+issue\s+close\b/,
    parse: (out) => factsFrom(out, /Closed issue \S*?#(\d+)/g, "closed", (m) => `#${m[1]}`),
  },
  {
    gate: /\bgh\s+release\s+create\b/,
    parse: (out) => factsFrom(out, /\/releases\/tag\/([^\s/]+)/g, "released", (m) => decodedTag(m[1]!)),
  },
  {
    // npm's publish porcelain: `+ pine-of-glass@0.5.10`
    gate: /\bnpm\s+publish\b/,
    parse: (out) => factsFrom(out, /^\+ \S+@([^\s@]+)\s*$/gm, "published", (m) => m[1]!),
  },
];

function resultText(comp: ToolRowDataLike | undefined): string {
  const content = comp?.result?.content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") out += `${block.text}\n`;
  }
  return out;
}

// Facts depend only on the row's own command+result, so they cache against the result
// object identity (rows re-render every frame; porcelain never changes once settled).
const recordFactCache = new WeakMap<object, { result: unknown; facts: RecordFact[] }>();

export function recordFacts(comp: ToolRowDataLike): RecordFact[] {
  if (toolName(comp) !== "bash") return [];
  const command = comp?.args?.command;
  if (typeof command !== "string" || !comp?.result || typeof comp.result !== "object") return [];
  const cached = recordFactCache.get(comp);
  if (cached && cached.result === comp.result) return cached.facts;
  const out = stripAnsi(resultText(comp));
  const facts: RecordFact[] = [];
  if (out) {
    for (const rule of RECORD_RULES) {
      if (rule.gate.test(command)) facts.push(...rule.parse(out, command));
    }
    facts.sort((a, b) => a.at - b.at);
  }
  recordFactCache.set(comp, { result: comp.result, facts });
  return facts;
}

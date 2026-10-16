import { stripAnsi } from "../_lib/ansi.ts";
import { isJsonObject } from "../_lib/boundary.ts";
import type { ToolRowDataLike } from "../_lib/chat.ts";
import { ownsRowStatus, readShell, type ShellCommand, type ShellScript, type ShellWord } from "./record-shell.ts";

// Records of consequence (design language §9.10): a table of vocabulary entries, each
// naming its command and the evidence it accepts. Rendering stays in index.ts because
// it depends on live theme ink and row fitting.
export type RecordTone = "success" | "warning";
/** Which of §9.10's evidence sources produced the fact. */
export type RecordEvidence = "output" | "state" | "quiet";
export type RecordFact = { verb: string; datum: string; at: number; tone: RecordTone; opaque: boolean; evidence: RecordEvidence };

/** An invocation of an entry's command: its arguments and its index in the row's commands (-1 when nested). */
type Operation = { args: ShellWord[]; index: number };
type Row = { out: string; script: ShellScript; succeeded: boolean };
type QuietRecord = { verb: string; datum: string };

type Entry = {
  commands: readonly (readonly string[])[];
  /** False for an invocation that cannot change state, such as a dry run. */
  qualifies?: (args: ShellWord[]) => boolean;
  output?: (out: string, ops: Operation[]) => RecordFact[];
  state?: (row: Row, ops: Operation[]) => RecordFact[];
  /** The record a quiet success states; must cite why the CLI's exit 0 means the change happened. */
  quiet?: (op: Operation) => QuietRecord | undefined;
};

function factsFrom(
  out: string,
  pattern: RegExp,
  verb: string,
  datum: (m: RegExpMatchArray) => string,
  options: { opaque?: (m: RegExpMatchArray) => boolean; tone?: (m: RegExpMatchArray) => RecordTone } = {},
): RecordFact[] {
  return [...out.matchAll(pattern)].map((m) => ({
    verb,
    datum: datum(m),
    at: m.index ?? 0,
    tone: options.tone?.(m) ?? "success",
    opaque: options.opaque?.(m) ?? false,
    evidence: "output",
  }));
}

function decodedTag(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// --- invocations -------------------------------------------------------------------

// git's global options sit between `git` and its subcommand; VALUE options take the next word.
const GIT_GLOBAL_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const GIT_GLOBAL_FLAG = /^(?:--no-pager|-P|-p|--paginate|--bare|--no-replace-objects|--literal-pathspecs|--no-optional-locks|--(?:git-dir|work-tree|namespace|exec-path|config-env)=.*)$/;

function operationArgs(command: ShellCommand, path: readonly string[]): ShellWord[] | undefined {
  const { words } = command;
  if (!words[0]?.literal || words[0].text !== path[0]) return undefined;
  let i = 1;
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

// --- quiet success (§9.10) ---------------------------------------------------------

function quietOperation(row: Row, ops: Operation[]): Operation | undefined {
  if (!row.succeeded || row.out.trim() !== "(no output)" || ops.length !== 1) return undefined;
  return ownsRowStatus(row.script, ops[0]!.index) ? ops[0] : undefined;
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

function viewJsonFields(args: ShellWord[]): Set<string> {
  const fields = new Set<string>();
  args.forEach(({ text }, i) => {
    const list = text === "--json" ? args[i + 1]?.text : text.startsWith("--json=") ? text.slice("--json=".length) : undefined;
    for (const field of list?.split(",") ?? []) fields.add(field);
  });
  return fields;
}

function mergedStateAt(out: string): number | undefined {
  const trimmed = out.trim();
  if (/^MERGED(?:\s+[0-9a-f]{7,40})?$/.test(trimmed)) return out.indexOf(trimmed);
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const state: unknown = JSON.parse(trimmed);
    return isJsonObject(state) && state.state === "MERGED" ? out.indexOf(trimmed) : undefined;
  } catch {
    return undefined;
  }
}

// Observed state (§9.10): a later `gh pr view` of the same PR, not behind `||`, with no
// `cd` in between, whose whole output is the merged state.
function mergedPrState(row: Row, ops: Operation[]): RecordFact[] {
  const at = mergedStateAt(row.out);
  const targeted = ops.flatMap((op) => {
    const target = prTarget(op.args);
    return target ? [{ op, target }] : [];
  });
  if (at === undefined || targeted.length !== 1) return [];
  const { op, target } = targeted[0]!;
  const { commands } = row.script;
  for (let j = op.index + 1; j < commands.length; j++) {
    const between = commands.slice(op.index + 1, j + 1);
    if (between.some((command) => command.before === "||") || between.slice(0, -1).some((command) => ["cd", "pushd", "popd"].includes(command.words[0]!.text))) break;
    const view = operationArgs(commands[j]!, ["gh", "pr", "view"]);
    const viewed = view && prTarget(view);
    const sameRepo = viewed?.repo === undefined || target.repo === undefined || viewed.repo === target.repo;
    if (view && viewed?.number === target.number && sameRepo && viewJsonFields(view).has("state")) {
      return [{ verb: "merged", datum: `PR #${target.number}`, at, tone: "success", opaque: false, evidence: "state" }];
    }
  }
  return [];
}

// --- the vocabulary ------------------------------------------------------------------

const GIT_PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);
const notDryRun = (args: ShellWord[]) => !hasOption(args, ["--dry-run"]);
const notDryRunPush = (args: ShellWord[]) => !hasOption(args, ["--dry-run"], "n");

// Completion output only, unless an entry says otherwise. Push failures
// (`! [rejected] main -> main`) have neither a hex range nor a `[new ...]` head, so they
// never match; `Everything up-to-date` contributes nothing.
const ENTRIES: Entry[] = [
  {
    // `[main a4f21c9]`, `[main (root-commit) a4f21c9]`, `[detached HEAD a4f21c9]`. The sha
    // is opaque audit data (§9.10): the verb wears the ink, the sha stays dim.
    commands: [["git", "commit"]],
    qualifies: notDryRun,
    output: (out) => factsFrom(out, /^\[[^\n\]]*?([0-9a-f]{7,40})\]/gm, "committed", (m) => m[1]!, { opaque: () => true }),
  },
  {
    // `1c75c2a..50cf33f main -> main`, `+ ... (forced update)`, `* [new tag] ...`
    commands: [["git", "push"]],
    qualifies: notDryRunPush,
    output: (out) =>
      factsFrom(out, /^\s*(?:\+?\s?[0-9a-f]+\.\.\.?[0-9a-f]+|\* \[new (?:branch|tag)\])\s+\S+\s+->\s+(\S+)/gm, "pushed", (m) => m[1]!, {
        tone: (m) => (m[0].trimStart().startsWith("+") ? "warning" : "success"),
      }),
  },
  {
    // ` - [deleted]  fix`: the output names the ref, the command names the remote.
    commands: [["git", "push"]],
    qualifies: (args) => notDryRunPush(args) && (hasOption(args, ["--delete"], "d") || positionals(args, GIT_PUSH_VALUE_OPTIONS).slice(1).some(({ text }) => text.startsWith(":"))),
    output: (out, ops) => {
      const remotes = new Set(ops.map((op) => positionals(op.args, GIT_PUSH_VALUE_OPTIONS)[0]).map((word) => (word?.literal ? word.text : undefined)));
      const [remote] = remotes.size === 1 ? [...remotes] : [undefined];
      return factsFrom(out, /^\s*- \[deleted\]\s+(\S+)\s*$/gm, "deleted", (m) => (remote ? `${remote}/${m[1]}` : m[1]!));
    },
  },
  {
    commands: [["git", "branch"]],
    qualifies: (args) => hasOption(args, ["--delete"], "dD"),
    output: (out) => factsFrom(out, /^Deleted branch (\S+) \(was [0-9a-f]+\)\.$/gm, "deleted", (m) => m[1]!),
  },
  {
    commands: [["git", "checkout"], ["git", "switch"]],
    qualifies: (args) => hasOption(args, ["--create", "--force-create"], "bBcC"),
    output: (out) => factsFrom(out, /^Switched to a new branch '([^'\n]+)'$/gm, "created branch", (m) => m[1]!),
  },
  {
    // `Preparing worktree (…)` announces the work; `HEAD is now at` completes it. Git's
    // tracking note and checkout progress may sit between them; `fatal:` never does.
    commands: [["git", "worktree", "add"]],
    output: (out) =>
      factsFrom(
        out,
        /^Preparing worktree \((?:new branch '([^'\n]+)'|checking out '([^'\n]+)'|detached HEAD ([0-9a-f]+))\)\n(?:branch '[^'\n]+' set up to track [^\n]+\n|Updating files:[^\n]*\n)*HEAD is now at [0-9a-f]+/gm,
        "created worktree",
        (m) => m[1] ?? m[2] ?? m[3]!,
        { opaque: (m) => m[3] !== undefined },
      ),
  },
  {
    // `git worktree remove` prints nothing and exits 0 only once the working tree and
    // its administrative files are gone; a dirty or locked tree exits 128 (git-worktree(1)).
    commands: [["git", "worktree", "remove"]],
    quiet: (op) => {
      const [path] = positionals(op.args, new Set());
      return path?.literal ? { verb: "removed worktree", datum: path.text } : undefined;
    },
  },
  {
    // A progress line may share the line through `\r`: `Rebasing (1/1)\rSuccessfully …`.
    commands: [["git", "rebase"]],
    output: (out) => factsFrom(out, /Successfully rebased and updated refs\/heads\/(\S+?)\.(?=\s|$)/g, "rebased", (m) => m[1]!),
  },
  {
    commands: [["gh", "pr", "merge"]],
    output: (out) => factsFrom(out, /(?:Merged|Squashed and merged|Rebased and merged) pull request \S*?#(\d+)/g, "merged", (m) => `PR #${m[1]}`),
    state: mergedPrState,
    // Without a terminal, `gh pr merge` prints nothing and exits 0 once the merge API
    // call succeeds. `--auto` exits 0 having only armed a merge, and `--disable-auto`
    // having only disarmed one.
    quiet: (op) => {
      const target = prTarget(op.args);
      return target && !hasOption(op.args, ["--auto", "--disable-auto"]) ? { verb: "merged", datum: `PR #${target.number}` } : undefined;
    },
  },
  {
    commands: [["gh", "pr", "close"]],
    output: (out) => factsFrom(out, /Closed pull request \S*?#(\d+)/g, "closed", (m) => `PR #${m[1]}`),
  },
  {
    commands: [["gh", "pr", "create"]],
    qualifies: notDryRun,
    output: (out) => factsFrom(out, /\/pull\/(\d+)\b/g, "opened", (m) => `PR #${m[1]}`),
  },
  {
    commands: [["gh", "issue", "create"]],
    output: (out) => factsFrom(out, /github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)\b/g, "opened", (m) => `#${m[1]}`),
  },
  {
    commands: [["gh", "issue", "close"]],
    output: (out) => factsFrom(out, /Closed issue \S*?#(\d+)/g, "closed", (m) => `#${m[1]}`),
  },
  {
    commands: [["gh", "release", "create"]],
    output: (out) => factsFrom(out, /\/releases\/tag\/([^\s/]+)/g, "released", (m) => decodedTag(m[1]!)),
  },
  {
    // npm's publish porcelain: `+ pine-of-glass@0.5.10`
    commands: [["npm", "publish"]],
    qualifies: notDryRun,
    output: (out) => factsFrom(out, /^\+ \S+@([^\s@]+)\s*$/gm, "published", (m) => m[1]!),
  },
];

// Each source answers only when the one before it found nothing: an operation's own
// completion line, then observed state, then quiet success.
function entryFacts(entry: Entry, row: Row): RecordFact[] {
  const invocations = (commands: ShellCommand[], nested: boolean): Operation[] =>
    commands.flatMap((command, index) =>
      entry.commands.flatMap((path) => {
        const args = operationArgs(command, path);
        return args && (entry.qualifies?.(args) ?? true) ? [{ args, index: nested ? -1 : index }] : [];
      }));
  const ops = invocations(row.script.commands, false);
  const all = [...ops, ...invocations(row.script.nested, true)];
  if (all.length === 0) return [];
  // A nested command's output can reach the result; its status and order never are the row's.
  const output = entry.output?.(row.out, all) ?? [];
  if (output.length > 0 || ops.length === 0) return output;
  const state = entry.state?.(row, ops) ?? [];
  if (state.length > 0) return state;
  if (!entry.quiet) return [];
  const op = quietOperation(row, ops);
  const quiet = op && entry.quiet(op);
  return quiet ? [{ ...quiet, at: 0, tone: "success", opaque: false, evidence: "quiet" }] : [];
}

export function resultText(comp: ToolRowDataLike | undefined): string {
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
  if (comp?.toolName !== "bash") return [];
  const command = comp?.args?.command;
  if (typeof command !== "string" || !comp?.result || typeof comp.result !== "object") return [];
  const cached = recordFactCache.get(comp);
  if (cached && cached.result === comp.result) return cached.facts;
  const out = stripAnsi(resultText(comp));
  const row: Row = { out, script: readShell(command), succeeded: comp.result.isError === false };
  const facts = out ? ENTRIES.flatMap((entry) => entryFacts(entry, row)).sort((a, b) => a.at - b.at) : [];
  recordFactCache.set(comp, { result: comp.result, facts });
  return facts;
}

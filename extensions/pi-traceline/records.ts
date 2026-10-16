import { stripAnsi } from "../_lib/ansi.ts";
import { isJsonObject } from "../_lib/boundary.ts";
import type { ToolResultLike, ToolRowDataLike } from "../_lib/chat.ts";
import { readShell, type ShellCommand, type ShellWord } from "./record-shell.ts";

// Records of consequence (design language §9.10): a table of vocabulary entries, each
// naming its command and the evidence it accepts. Rendering stays in index.ts because
// it depends on live theme ink and row fitting.
export type RecordTone = "success" | "warning";
/** Which of §9.10's evidence sources produced the fact. */
export type RecordEvidence = "output" | "state" | "quiet";
export type RecordFact = { verb: string; datum: string; at: number; tone: RecordTone; opaque: boolean; evidence: RecordEvidence };

type Operation = { args: ShellWord[]; command: ShellCommand };
type Entry = {
  commands: readonly (readonly [string, ...string[]])[];
  qualifies?: (args: ShellWord[]) => boolean;
} & (
  | { output: (out: string, ops: Operation[]) => RecordFact[]; fallback?: "merge" }
  | { fallback: "worktree"; output?: never }
);

function factsFrom(
  out: string,
  pattern: RegExp,
  verb: string,
  datum: (m: RegExpExecArray) => string,
  options: { opaque?: (m: RegExpExecArray) => boolean; tone?: (m: RegExpExecArray) => RecordTone } = {},
): RecordFact[] {
  return [...out.matchAll(pattern)].map((m) => ({
    verb,
    datum: datum(m),
    at: m.index,
    tone: options.tone?.(m) ?? "success",
    opaque: options.opaque?.(m) ?? false,
    evidence: "output",
  }));
}

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
    fallback: "worktree",
  },
  {
    // A progress line may share the line through `\r`: `Rebasing (1/1)\rSuccessfully …`.
    commands: [["git", "rebase"]],
    output: (out) => factsFrom(out, /Successfully rebased and updated refs\/heads\/(\S+?)\.(?=\s|$)/g, "rebased", (m) => m[1]!),
  },
  {
    commands: [["gh", "pr", "merge"]],
    output: (out) => factsFrom(out, /(?:Merged|Squashed and merged|Rebased and merged) pull request \S*?#(\d+)/g, "merged", (m) => `PR #${m[1]}`),
    // Exit 0 means merged unless --auto or --disable-auto only changed merge settings.
    fallback: "merge",
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
    output: (out) => factsFrom(out, /\/releases\/tag\/([^\s/]+)/g, "released", (m) => {
      try {
        return decodeURIComponent(m[1]!);
      } catch {
        return m[1]!;
      }
    }),
  },
  {
    // npm's publish porcelain: `+ pine-of-glass@0.5.10`
    commands: [["npm", "publish"]],
    qualifies: notDryRun,
    output: (out) => factsFrom(out, /^\+ \S+@([^\s@]+)\s*$/gm, "published", (m) => m[1]!),
  },
];

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
const recordFactCache = new WeakMap<ToolRowDataLike, { result: ToolResultLike; facts: RecordFact[] }>();

export function recordFacts(comp: ToolRowDataLike): RecordFact[] {
  if (comp.toolName !== "bash") return [];
  const command = comp.args?.command;
  const { result } = comp;
  if (typeof command !== "string" || !result) return [];
  const cached = recordFactCache.get(comp);
  if (cached && cached.result === result) return cached.facts;
  const out = stripAnsi(resultText(comp));
  const script = readShell(command);
  const trimmed = out.trim();
  const facts = ENTRIES.flatMap((entry): RecordFact[] => {
    const invocations = (commands: ShellCommand[]): Operation[] => commands.flatMap((command) =>
      entry.commands.flatMap((path) => {
        const args = operationArgs(command, path);
        return args && (entry.qualifies?.(args) ?? true) ? [{ args, command }] : [];
      }));
    const ops = invocations(script.commands);
    const all = [...ops, ...invocations(script.nested)];
    if (all.length === 0) return [];
    const output = entry.output?.(out, all) ?? [];
    if (output.length || !entry.fallback) return output;

    if (entry.fallback === "merge" && trimmed !== "(no output)") {
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
          return [{ verb: "merged", datum: `PR #${target.number}`, at: out.indexOf(trimmed), tone: "success", opaque: false, evidence: "state" }];
        }
        if (["cd", "pushd", "popd"].includes(command.head.text)) break;
      }
      return [];
    }

    if (result.isError !== false || trimmed !== "(no output)" || ops.length !== 1) return [];
    const op = ops[0]!;
    if (op.command !== script.statusOwner) return [];
    if (entry.fallback === "worktree") {
      const [path] = positionals(op.args, new Set());
      return path?.literal ? [{ verb: "removed worktree", datum: path.text, at: 0, tone: "success", opaque: false, evidence: "quiet" }] : [];
    }
    const target = prTarget(op.args);
    return target && !hasOption(op.args, ["--auto", "--disable-auto"])
      ? [{ verb: "merged", datum: `PR #${target.number}`, at: 0, tone: "success", opaque: false, evidence: "quiet" }]
      : [];
  }).sort((a, b) => a.at - b.at);
  recordFactCache.set(comp, { result, facts });
  return facts;
}

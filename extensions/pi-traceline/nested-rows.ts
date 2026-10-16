// Composed-call rendering (design language §9.14): the z0 body of a row whose call ran
// other tools, and the ink helpers its ledger (ledger.ts) shares. Pure functions of
// theme, row data and width; parsing lives in nested-calls.ts, block policy (suffix
// reserve, size column, prefixes, the reveal default) in index.ts.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ToolRowDataLike } from "../_lib/chat.ts";
import { formatLatency } from "../_lib/fmt.ts";
import { SEP, ink, tildify, type Tone } from "../_lib/style.ts";
import { bashCrownedHeads } from "./bash-crowns.ts";
import { LINE_BREAK_MARK } from "./bash-preamble.ts";
import type { ComposedFacts, NestedCall } from "./nested-calls.ts";
import { cwdRelativePath } from "./path-rows.ts";

const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
export const PATH_VERBS = new Set(["read", "edit", "write"]);
/** Wall time earns a cell once it clears this (agent-default, not a user rule: 2026-09-30). */
const WALL_FLOOR_MS = 10_000;

export function bold(theme: Theme | undefined, tone: Tone, text: string): string {
  return ink(theme, tone, `${BOLD}${text}${BOLD_OFF}`);
}

export function dim(theme: Theme | undefined, text: string): string {
  return ink(theme, "dim", text);
}

// A namespaced tool keeps the path grammar (§9.5): `mcp__monaco__get_account` is dim
// `monaco/` apparatus and a bold `get_account` discriminator.
export function nameInk(theme: Theme | undefined, name: string, tone: Tone): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? `${dim(theme, `${match[1]}/`)}${bold(theme, tone, match[2]!)}` : bold(theme, tone, name);
}

export function flattenCommand(command: string): string {
  return tildify(
    command
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(` ${LINE_BREAK_MARK} `),
  );
}

// §9.5's treatment for one path: dim directory, bold basename, a read's warning range.
export function pathInk(theme: Theme | undefined, tone: Tone, row: ToolRowDataLike, path: string, range: string): string {
  const shown = cwdRelativePath(row, path);
  const slash = shown.lastIndexOf("/") + 1;
  return `${dim(theme, shown.slice(0, slash))}${bold(theme, tone, shown.slice(slash))}${ink(theme, "warning", range)}`;
}

// --- the z0 body ----------------------------------------------------------------------------

/** The composed row's body after the bullet: verb, count, wall, members (§9.14). The
 * member names are the story, so when the body overflows `available` the member
 * targets drop first and the names survive the cut; only then does §9.8's middle
 * truncation apply. */
export function composedBody(
  theme: Theme | undefined,
  row: ToolRowDataLike,
  facts: ComposedFacts,
  failed: boolean,
  available = Number.POSITIVE_INFINITY,
): string {
  const verbTone: Tone = failed ? "error" : "text";
  const verb = typeof row.toolName === "string" && row.toolName.length > 0 ? row.toolName : "tool";
  const cells: string[] = [];
  const n = facts.calls.length;
  cells.push(n === 0 ? "script only" : n === 1 ? "1 call" : `${n} calls`);
  if (facts.wallMs !== undefined && facts.wallMs >= WALL_FLOOR_MS) cells.push(formatLatency(facts.wallMs));
  const head = `${bold(theme, verbTone, verb)} ${dim(theme, cells.join(SEP))}`;
  const grouped = new Map<string, [NestedCall, ...NestedCall[]]>();
  for (const call of facts.calls) {
    const calls = grouped.get(call.name);
    if (calls) calls.push(call);
    else grouped.set(call.name, [call]);
  }
  const body = (targets: boolean) => {
    const summary = [...grouped].map(([name, calls]) => {
      const count = calls.length;
      const failed = calls.filter((call) => call.status === "error").length;
      const tone: Tone = failed === count ? "error" : "text";
      const cells: string[] = [];
      if (name === "bash") {
        const command = count === 1 ? flattenCommand(calls[0].args.command ?? "") : "";
        const crown = bashCrownedHeads(command)[0];
        cells.push(crown ? `${bold(theme, tone, "$")} ${bold(theme, tone, command.slice(crown.start, crown.end))}` : bold(theme, tone, "$"));
      } else {
        cells.push(nameInk(theme, name, tone));
      }
      if (count > 1) cells.push(dim(theme, `×${count}`));
      if (failed > 0) cells.push(ink(theme, "warning", `✗${failed}`));
      if (targets && PATH_VERBS.has(name)) {
        const paths = [...new Set(calls.flatMap((call) => call.args.path ?? []))];
        if (paths.length === 1 && calls[0].args.path !== undefined) {
          const ranges = name === "read" ? calls.map((call) => (call.args.range ?? "").slice(1)).filter(Boolean).join(",") : "";
          cells.push(pathInk(theme, tone, row, calls[0].args.path, ranges ? `:${ranges}` : ""));
        } else if (paths.length > 1) {
          const dirs = new Set(paths.map((path) => {
            const shown = cwdRelativePath(row, path);
            return shown.slice(0, shown.lastIndexOf("/") + 1);
          }));
          if (dirs.size === 1 && [...dirs][0]) cells.push(dim(theme, [...dirs][0]!));
        }
      }
      if (facts.wallMs !== undefined && facts.wallMs >= WALL_FLOOR_MS) {
        const slowest = Math.max(...calls.map((call) => call.durationMs ?? 0));
        if (slowest * 2 >= facts.wallMs) cells.push(dim(theme, formatLatency(slowest)));
      }
      return cells.join(" ");
    });
    return summary.length ? `${head}${dim(theme, SEP)}${summary.join(dim(theme, SEP))}` : head;
  };
  const full = body(true);
  return visibleWidth(full) <= available ? full : body(false);
}

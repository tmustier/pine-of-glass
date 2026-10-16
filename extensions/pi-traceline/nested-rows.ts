// Composed-call rendering (design language §9.14): the z0 body of a row whose call ran
// other tools, and the revealed ledger beneath it. Pure functions of theme, row data and
// width; parsing lives in nested-calls.ts, block policy (suffix reserve, size column,
// prefixes) in index.ts.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolRowDataLike } from "../_lib/chat.ts";
import { compactCount, formatLatency } from "../_lib/fmt.ts";
import {
  ELLIPSIS,
  GLYPH,
  SEP,
  ink,
  rightAlignSuffix,
  sizeTone,
  tildify,
  type SizeThresholds,
  type Tone,
} from "../_lib/style.ts";
import { bashCrownedHeads } from "./bash-crowns.ts";
import { LINE_BREAK_MARK } from "./bash-preamble.ts";
import type { ComposedFacts, NestedCall } from "./nested-calls.ts";
import { cwdRelativePath } from "./path-rows.ts";

const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const PATH_VERBS = new Set(["read", "edit", "write"]);
const STATUS_TONES = { ok: "success", error: "error", running: "running", cancelled: "dim" } as const;
/** Wall time earns a cell once it clears this (agent-default, not a user rule: 2026-09-30). */
const WALL_FLOOR_MS = 10_000;
const CHAR_SUFFIX_FLOOR = 100;
/** A ledger duration under this is ambient chrome, not a fact (agent-default, not a user rule: 2026-09-30). */
const DURATION_FLOOR_MS = 100;
/** An error's first line is capped so the line keeps its path or command (agent-default, not a user rule: 2026-09-30). */
const ERROR_CELL_COLS = 48;

function bold(theme: Theme | undefined, tone: Tone, text: string): string {
  return ink(theme, tone, `${BOLD}${text}${BOLD_OFF}`);
}

function dim(theme: Theme | undefined, text: string): string {
  return ink(theme, "dim", text);
}

// A namespaced tool keeps the path grammar (§9.5): `mcp__monaco__get_account` is dim
// `monaco/` apparatus and a bold `get_account` discriminator.
function nameInk(theme: Theme | undefined, name: string, tone: Tone): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? `${dim(theme, `${match[1]}/`)}${bold(theme, tone, match[2]!)}` : bold(theme, tone, name);
}

function flattenCommand(command: string): string {
  return tildify(
    command
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(` ${LINE_BREAK_MARK} `),
  );
}

// §9.5's treatment for one path: dim directory, bold basename, a read's warning range.
function pathInk(theme: Theme | undefined, tone: Tone, row: ToolRowDataLike, path: string, range: string): string {
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
  const tone: Tone = failed ? "error" : "text";
  const verb = typeof row.toolName === "string" && row.toolName.length > 0 ? row.toolName : "tool";
  const cells: string[] = [];
  const n = facts.calls.length;
  cells.push(n === 0 ? "script only" : n === 1 ? "1 call" : `${n} calls`);
  if (facts.wallMs !== undefined && facts.wallMs >= WALL_FLOOR_MS) cells.push(formatLatency(facts.wallMs));
  const head = `${bold(theme, tone, verb)} ${dim(theme, cells.join(SEP))}`;
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

// --- the ledger -----------------------------------------------------------------------------

const LEDGER_INDENT = "  ";
const LEDGER_NEST = "   "; // one gutter deeper than the parent's `› `
const LEDGER_RIGHT_MARGIN = 2;
const LEDGER_PREFIX_WIDTH = LEDGER_INDENT.length + 1 + LEDGER_NEST.length + 1 + 1;

/** One compact line per nested call, indented under the parent, sharing one body budget
 * and one right edge (§9.14, §9.8). */
export function ledgerLines(
  theme: Theme | undefined,
  row: ToolRowDataLike,
  facts: ComposedFacts,
  width: number,
  thresholds: SizeThresholds,
): string[] {
  const available = Math.max(1, width - LEDGER_PREFIX_WIDTH - LEDGER_RIGHT_MARGIN);
  const sizeColumnLive = facts.calls.some((call) => call.resultChars !== undefined && call.resultChars >= CHAR_SUFFIX_FLOOR);
  const suffixes = facts.calls.map((call) => {
    const cells: string[] = [];
    if (call.durationMs !== undefined && call.durationMs >= DURATION_FLOOR_MS) cells.push(dim(theme, formatLatency(call.durationMs)));
    if (call.imageFact) cells.push(dim(theme, call.imageFact));
    else if (call.resultChars !== undefined && (sizeColumnLive || call.resultChars >= CHAR_SUFFIX_FLOOR)) {
      cells.push(ink(theme, sizeTone(call.resultChars, thresholds), `${compactCount(call.resultChars)} ch`));
    }
    return cells.join(dim(theme, SEP));
  });
  const widest = Math.max(0, ...suffixes.map((suffix) => visibleWidth(suffix)));
  const reserve = widest > 0 ? widest + 2 : 0;
  const rail = dim(theme, GLYPH.rail);
  const lines = facts.calls.map((call, index) => {
    const tone: Tone = call.status === "error" ? "error" : call.status === "cancelled" ? "dim" : "text";
    let body: string;
    const command = call.name === "bash" ? call.args.command : undefined;
    if (command !== undefined) {
      const text = flattenCommand(command);
      let styled = "";
      let cursor = 0;
      for (const crown of bashCrownedHeads(text)) {
        styled += dim(theme, text.slice(cursor, crown.start));
        styled += bold(theme, tone, text.slice(crown.start, crown.end));
        cursor = crown.end;
      }
      styled += dim(theme, text.slice(cursor));
      body = `${bold(theme, tone, "$")} ${styled}`;
    } else if (PATH_VERBS.has(call.name) && call.args.path !== undefined) {
      body = `${bold(theme, tone, call.name)} ${pathInk(theme, tone, row, call.args.path, call.name === "read" ? call.args.range ?? "" : "")}`;
    } else {
      const args = call.args.text;
      body = args && args !== "{}" ? `${nameInk(theme, call.name, tone)} ${dim(theme, args)}` : nameInk(theme, call.name, tone);
    }
    if (call.status === "error" && call.error) {
      const first = call.error.split("\n").find((line) => line.trim().length > 0)?.trim();
      if (first) body += `${dim(theme, SEP)}${dim(theme, truncateToWidth(first, ERROR_CELL_COLS, ELLIPSIS))}`;
    } else if (call.status === "cancelled") {
      body += `${dim(theme, SEP)}${dim(theme, "cancelled")}`;
    }
    const bullet = ink(theme, STATUS_TONES[call.status], GLYPH.tool);
    const prefix = `${LEDGER_INDENT}${rail}${LEDGER_NEST}${bullet} `;
    const fitted = rightAlignSuffix(body, suffixes[index]!, available, theme, reserve);
    return truncateToWidth(`${prefix}${fitted}`, Math.max(1, width), ELLIPSIS);
  });
  if (!facts.complete) {
    lines.push(truncateToWidth(`${LEDGER_INDENT}${rail}${LEDGER_NEST}  ${dim(theme, "record incomplete: pi dropped calls or arguments past its cap")}`, Math.max(1, width), ELLIPSIS));
  }
  return lines;
}

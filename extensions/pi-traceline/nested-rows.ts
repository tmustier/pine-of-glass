// Composed-call rendering (design language §9.14): the z0 body of a row whose call ran
// other tools, and the revealed ledger beneath it. Pure functions of theme, row data and
// width; parsing lives in nested-calls.ts, block policy (suffix reserve, size column,
// prefixes) in index.ts.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { JsonFields } from "../_lib/boundary.ts";
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
import type { ComposedFacts, NestedCall, NestedStatus } from "./nested-calls.ts";
import { cwdRelativePath, lineRange } from "./path-rows.ts";

const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const PATH_VERBS = new Set(["read", "edit", "write"]);
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
export function splitToolName(name: string): { prefix: string; tool: string } {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { prefix: `${match[1]}/`, tool: match[2]! } : { prefix: "", tool: name };
}

function nameInk(theme: Theme | undefined, name: string, tone: Tone): string {
  const { prefix, tool } = splitToolName(name);
  return `${dim(theme, prefix)}${bold(theme, tone, tool)}`;
}

function pathOf(args: JsonFields | undefined): string | undefined {
  const path = args?.path ?? args?.file_path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

function commandOf(args: JsonFields | undefined): string | undefined {
  const command = args?.command;
  return typeof command === "string" && command.trim().length > 0 ? command : undefined;
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

function crownWord(command: string): string | undefined {
  const body = flattenCommand(command);
  const crown = bashCrownedHeads(body)[0];
  return crown ? body.slice(crown.start, crown.end) : undefined;
}

// Crowns bold, everything else at the one supporting grey (§9.3).
function inkCommand(theme: Theme | undefined, tone: Tone, command: string): string {
  const body = flattenCommand(command);
  let out = "";
  let cursor = 0;
  for (const crown of bashCrownedHeads(body)) {
    if (crown.start > cursor) out += dim(theme, body.slice(cursor, crown.start));
    out += bold(theme, tone, body.slice(crown.start, crown.end));
    cursor = crown.end;
  }
  if (cursor < body.length) out += dim(theme, body.slice(cursor));
  return out;
}

// §9.5's treatment for one path: dim directory, bold basename, a read's warning range.
function pathInk(theme: Theme | undefined, tone: Tone, row: ToolRowDataLike, call: NestedCall, ranges?: string): string {
  const path = pathOf(call.args);
  if (path === undefined) return "";
  const shown = cwdRelativePath(row, path);
  const slash = shown.lastIndexOf("/") + 1;
  const range = ranges ?? (call.name === "read" ? lineRange(call.args) : "");
  return `${dim(theme, shown.slice(0, slash))}${bold(theme, tone, shown.slice(slash))}${ink(theme, "warning", range)}`;
}

function statusTone(status: NestedStatus): Tone {
  switch (status) {
    case "ok":
      return "success";
    case "error":
      return "error";
    case "running":
      return "running";
    case "cancelled":
      return "dim";
  }
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// --- the z0 body ----------------------------------------------------------------------------

type Member = { name: string; calls: NestedCall[] };

function members(calls: NestedCall[]): Member[] {
  const out: Member[] = [];
  const byName = new Map<string, Member>();
  for (const call of calls) {
    let member = byName.get(call.name);
    if (!member) {
      member = { name: call.name, calls: [] };
      byName.set(call.name, member);
      out.push(member);
    }
    member.calls.push(call);
  }
  return out;
}

// The one target a folded member may carry (§9.14): one distinct path (paged reads
// merge their ranges), or the one directory several files share; otherwise nothing.
function memberTarget(theme: Theme | undefined, tone: Tone, row: ToolRowDataLike, member: Member): string {
  if (!PATH_VERBS.has(member.name)) return "";
  const paths = member.calls.map((call) => pathOf(call.args)).filter((path): path is string => path !== undefined);
  if (paths.length === 0) return "";
  const distinct = [...new Set(paths)];
  if (distinct.length === 1) {
    const ranges = member.name === "read"
      ? member.calls.map((call) => lineRange(call.args).slice(1)).filter(Boolean).join(",")
      : "";
    return pathInk(theme, tone, row, member.calls[0]!, ranges ? `:${ranges}` : "");
  }
  const dirs = new Set(distinct.map((path) => cwdRelativePath(row, path).slice(0, cwdRelativePath(row, path).lastIndexOf("/") + 1)));
  if (dirs.size === 1) {
    const dir = [...dirs][0]!;
    return dir ? dim(theme, dir) : "";
  }
  return "";
}

function memberInk(theme: Theme | undefined, tone: Tone, row: ToolRowDataLike, member: Member, wallMs: number | undefined, targets: boolean): string {
  const count = member.calls.length;
  const failed = member.calls.filter((call) => call.status === "error").length;
  const cells: string[] = [];
  if (member.name === "bash") {
    const crown = count === 1 ? crownWord(commandOf(member.calls[0]!.args) ?? "") : undefined;
    cells.push(crown ? `${bold(theme, tone, "$")} ${bold(theme, tone, crown)}` : bold(theme, tone, "$"));
  } else {
    cells.push(nameInk(theme, member.name, tone));
  }
  if (count > 1) cells.push(dim(theme, `×${count}`));
  if (failed > 0) cells.push(ink(theme, "warning", `✗${failed}`));
  const target = targets ? memberTarget(theme, tone, row, member) : "";
  if (target) cells.push(target);
  // The slow child is named at z0 (§9.14) when its own duration explains the wall.
  if (wallMs !== undefined && wallMs >= WALL_FLOOR_MS) {
    const slowest = Math.max(...member.calls.map((call) => call.durationMs ?? 0));
    if (slowest * 2 >= wallMs) cells.push(dim(theme, formatLatency(slowest)));
  }
  return cells.join(" ");
}

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
  const grouped = members(facts.calls);
  const body = (targets: boolean) => {
    const summary = grouped.map((member) => memberInk(theme, tone, row, member, facts.wallMs, targets));
    return summary.length ? `${head}${dim(theme, SEP)}${summary.join(dim(theme, SEP))}` : head;
  };
  const full = body(true);
  return visibleWidth(full) <= available ? full : body(false);
}

/** The suffix with the trimmed fact ahead of the size cell (§9.14). */
export function composedSuffix(theme: Theme | undefined, facts: ComposedFacts, sizeCell: string): string {
  if (!facts.trimmed) return sizeCell;
  const trimmed = ink(theme, "warning", "trimmed");
  return sizeCell ? `${trimmed}${dim(theme, SEP)}${sizeCell}` : trimmed;
}

// --- the ledger -----------------------------------------------------------------------------

const LEDGER_INDENT = "  ";
const LEDGER_NEST = "   "; // one gutter deeper than the parent's `› `
const LEDGER_RIGHT_MARGIN = 2;
const LEDGER_PREFIX_WIDTH = LEDGER_INDENT.length + 1 + LEDGER_NEST.length + 1 + 1;

function ledgerBody(theme: Theme | undefined, row: ToolRowDataLike, call: NestedCall): string {
  const tone: Tone = call.status === "error" ? "error" : call.status === "cancelled" ? "dim" : "text";
  let body: string;
  const command = call.name === "bash" ? commandOf(call.args) : undefined;
  if (command !== undefined) {
    body = `${bold(theme, tone, "$")} ${inkCommand(theme, tone, command)}`;
  } else if (PATH_VERBS.has(call.name) && pathOf(call.args) !== undefined) {
    body = `${bold(theme, tone, call.name)} ${pathInk(theme, tone, row, call)}`;
  } else {
    const args = call.args ? compactJson(call.args) : (call.argsPreview ?? "");
    body = args && args !== "{}" ? `${nameInk(theme, call.name, tone)} ${dim(theme, args)}` : nameInk(theme, call.name, tone);
  }
  if (call.status === "error" && call.error) {
    const first = call.error.split("\n").find((line) => line.trim().length > 0)?.trim();
    if (first) body += `${dim(theme, SEP)}${dim(theme, truncateToWidth(first, ERROR_CELL_COLS, ELLIPSIS))}`;
  } else if (call.status === "cancelled") {
    body += `${dim(theme, SEP)}${dim(theme, "cancelled")}`;
  }
  return body;
}

function ledgerSuffix(theme: Theme | undefined, call: NestedCall, thresholds: SizeThresholds, sizeColumnLive: boolean): string {
  const cells: string[] = [];
  if (call.durationMs !== undefined && call.durationMs >= DURATION_FLOOR_MS) cells.push(dim(theme, formatLatency(call.durationMs)));
  if (call.imageFact) cells.push(dim(theme, call.imageFact));
  else if (call.resultChars !== undefined && (sizeColumnLive || call.resultChars >= CHAR_SUFFIX_FLOOR)) {
    cells.push(ink(theme, sizeTone(call.resultChars, thresholds), `${compactCount(call.resultChars)} ch`));
  }
  return cells.join(dim(theme, SEP));
}

/** One compact line per nested call, indented under the parent, sharing one body budget
 * and one right edge (§9.14, §9.8). */
export function ledgerLines(
  theme: Theme | undefined,
  row: ToolRowDataLike,
  facts: ComposedFacts,
  width: number,
  thresholds: SizeThresholds,
): string[] {
  const available = Math.max(1, Math.max(1, width) - LEDGER_PREFIX_WIDTH - LEDGER_RIGHT_MARGIN);
  const sizeColumnLive = facts.calls.some((call) => call.resultChars !== undefined && call.resultChars >= CHAR_SUFFIX_FLOOR);
  const suffixes = facts.calls.map((call) => ledgerSuffix(theme, call, thresholds, sizeColumnLive));
  const widest = Math.max(0, ...suffixes.map((suffix) => visibleWidth(suffix)));
  const reserve = widest > 0 ? widest + 2 : 0;
  const rail = dim(theme, GLYPH.rail);
  const lines = facts.calls.map((call, index) => {
    const bullet = ink(theme, statusTone(call.status), GLYPH.tool);
    const prefix = `${LEDGER_INDENT}${rail}${LEDGER_NEST}${bullet} `;
    const fitted = rightAlignSuffix(ledgerBody(theme, row, call), suffixes[index]!, available, theme, reserve);
    return truncateToWidth(`${prefix}${fitted}`, Math.max(1, width), ELLIPSIS);
  });
  if (!facts.complete) {
    lines.push(truncateToWidth(`${LEDGER_INDENT}${rail}${LEDGER_NEST}  ${dim(theme, "record incomplete: pi dropped calls or arguments past its cap")}`, Math.max(1, width), ELLIPSIS));
  }
  return lines;
}

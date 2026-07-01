// The pine-of-glass family style — implementation of docs/design-language.md §§1–6.
// Identity lives in glyphs and layout, not colour: all ink is theme-derived through
// ink(), with raw-ANSI fallbacks only for surfaces rendered before a Theme handle
// exists and for the one tone pi's theme has no faithful role for ("running").

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { OSC_SEQUENCE, rawIndexAtVisibleIndex, stripAnsi } from "./ansi.ts";

/** Line-kind glyphs: one per line, gutter position (design language §1). */
export const GLYPH = {
  /** a tool action (one trace row) — traceline */
  tool: "\u203a", // ›
  /** a loop-economics fact (clock, notice, ledger line) — cachemire */
  econ: "\u25cd", // ◍
  /** an expandable/summarizable section header — contextimate */
  section: "\u25b8", // ▸
  /** tool-block rail — the dim left edge that fuses a run of trace rows into one block */
  rail: "\u258f", // ▏
} as const;

/** Status scale — family-shared vocabulary (design language §1). */
export const SCALE = {
  cold: "\u25cb", // ○ cold / empty
  hit: "\u25cf", // ● hit / full
  partial: "\u25d1", // ◑ partial
  miss: "\u25cc", // ◌ miss / broken
} as const;

/** The only inline fact separator (design language §5). */
export const SEP = " \u00b7 "; // ·

/**
 * Ink tones (design language §2): the neutral ramp (text/muted/dim), the status
 * tones (success/warning/error/running), and the family accent.
 */
export type Tone =
  | "text"
  | "muted"
  | "dim"
  | "success"
  | "warning"
  | "error"
  | "running"
  | "accent";

const THEME_ROLE: Partial<Record<Tone, ThemeColor>> = {
  text: "text",
  muted: "muted",
  dim: "dim",
  success: "success",
  warning: "warning",
  error: "error",
  accent: "accent",
  // "running" has no faithful theme role (accent would collide with brand/total
  // highlights; warning overloads "fading") — resolved to the ANSI-blue raw tone
  // (design language §11).
};

const RESET = "\x1b[0m";

// Raw fallbacks: basic ANSI only (widest terminal support), used when no Theme is
// available yet. "text" and "accent" fall back to uncoloured text — plain is honest
// before the theme exists.
const RAW: Record<Tone, string> = {
  text: "",
  muted: "\x1b[90m",
  dim: "\x1b[90m",
  success: "\x1b[32m",
  warning: "\x1b[33m",
  error: "\x1b[31m",
  running: "\x1b[34m",
  accent: "",
};

/** All family ink flows through here (design language §3). */
export function ink(theme: Theme | undefined, tone: Tone, text: string): string {
  if (text.length === 0) return text;
  const role = THEME_ROLE[tone];
  if (theme && role) {
    try {
      return theme.fg(role, text);
    } catch {
      // fall through to the raw tone — never let styling break a render
    }
  }
  const open = RAW[tone];
  return open ? `${open}${text}${RESET}` : text;
}

// --- panel headers (design language §5) -------------------------------------------------

/** Mode pips for a panel header: active mode accent-bold, others dim, `→` dim. */
export function panelPips(theme: Theme | undefined, modes: readonly string[], active: string): string {
  return modes
    .map((mode) => (mode === active ? ink(theme, "accent", bold(theme, mode)) : ink(theme, "dim", mode)))
    .join(ink(theme, "dim", " → "));
}

/**
 * The family panel-header form (design language §5): `[Name]` in bold accent, optional
 * mode pips, then one dim hint line carrying keybinding, scope, and the panel's
 * methodology — stated here once, never on data rows.
 */
export function panelHeader(
  theme: Theme | undefined,
  name: string,
  options: { modes?: readonly string[]; active?: string; hint?: string } = {},
): string[] {
  const brand = ink(theme, "accent", bold(theme, `[${name}]`));
  const pips = options.modes && options.active ? ` ${panelPips(theme, options.modes, options.active)}` : "";
  const lines = ["", `${brand}${pips}`];
  if (options.hint) lines.push(`  ${ink(theme, "dim", options.hint)}`);
  return lines;
}

function bold(theme: Theme | undefined, text: string): string {
  try {
    return theme?.bold ? theme.bold(text) : text;
  } catch {
    return text;
  }
}

// --- layout helpers (design language §5) -----------------------------------------------

export const ELLIPSIS = "\u2026"; // …

const MIN_HEAD_COLS = 6;
const TAIL_RATIO = 0.55;
const SNAP_WINDOW = 8;

// Replace an absolute home-directory prefix with ~ so boilerplate path heads stop eating
// width (e.g. bash `cd /Users/me/... && ...` -> `cd ~/... && ...`). OSC sequences are
// skipped: a read row's OSC 8 hyperlink carries a file:// URL containing the home path,
// and tildifying *that* would corrupt the click target. The pattern is built once —
// tildify runs for every visible row on every frame.
const TILDIFY_PATTERN = (() => {
  const home = homedir();
  if (!home) return undefined;
  return new RegExp(`${OSC_SEQUENCE.source}|${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
})();

export function tildify(text: string): string {
  if (!TILDIFY_PATTERN) return text;
  return text.replace(TILDIFY_PATTERN, (match) => (match.startsWith("\x1b") ? match : "~"));
}

function isVisibleBoundary(ch: string): boolean {
  return ch === "/" || ch === " ";
}

// ANSI-aware middle truncation that protects the *tail* of the line — the basename +
// :line-range for a path, or the operative end of a command — because that is where the
// information distinguishing one row from the next lives. The cut snaps to a nearby "/"
// or space boundary, and the ellipsis is dimmed so it reads as a UI marker rather than as
// part of the path/command. Falls back to tail truncation only when the width is too
// small to keep both ends.
export function middleTruncate(line: string, width: number, theme?: Theme): string {
  const maxWidth = Math.max(1, width);
  if (visibleWidth(line) <= maxWidth) return line;

  const vis = stripAnsi(line);
  const visLen = vis.length;
  const ellipsisWidth = visibleWidth(ELLIPSIS);
  const budget = Math.max(1, maxWidth - ellipsisWidth); // reserve columns for the ellipsis

  const maxTail = Math.min(budget - MIN_HEAD_COLS, Math.max(12, Math.floor(budget * TAIL_RATIO)));
  if (maxTail < 1) return truncateToWidth(line, maxWidth, ELLIPSIS);

  // Longest tail that fits `maxTail` and starts at a separator, so it reads as `.../seg`.
  let tailStart = -1;
  for (let i = Math.max(0, visLen - maxTail); i < visLen; i++) {
    if (isVisibleBoundary(vis[i]!)) {
      tailStart = i;
      break;
    }
  }
  if (tailStart < 0) tailStart = visLen - maxTail; // no boundary in range: keep the end

  const dimEllipsis = ink(theme, "dim", ELLIPSIS);
  const tailRaw = line.slice(rawIndexAtVisibleIndex(line, tailStart));

  let headEnd = budget - (visLen - tailStart);
  if (headEnd <= 0) return `${dimEllipsis}${tailRaw}`;

  // Snap the head back to a nearby boundary so the ellipsis lands on a clean edge: keep a
  // trailing "/" on the head side, drop a trailing space. Search from the last kept char
  // inward so keeping the "/" can never push the head past its budget.
  for (let i = headEnd - 1; i >= Math.max(0, headEnd - SNAP_WINDOW); i--) {
    if (isVisibleBoundary(vis[i]!)) {
      headEnd = vis[i] === "/" ? i + 1 : i;
      break;
    }
  }
  headEnd = Math.min(headEnd, tailStart);
  if (headEnd <= 0) return `${dimEllipsis}${tailRaw}`;

  const headRaw = line.slice(0, rawIndexAtVisibleIndex(line, headEnd));
  return `${headRaw}${RESET}${dimEllipsis}${tailRaw}`;
}

/** Quantities right (design language §5): body left, right-aligned suffix, ≥1-space gap;
 * the body middle-truncates and the suffix wins when the width is starved. */
export function rightAlignSuffix(body: string, suffix: string, width: number, theme?: Theme): string {
  const maxWidth = Math.max(1, width);
  const bodyText = body.trimEnd();
  if (!suffix) return middleTruncate(bodyText, maxWidth, theme);

  const suffixWidth = visibleWidth(suffix);
  if (suffixWidth >= maxWidth) return truncateToWidth(suffix, maxWidth, ELLIPSIS);

  const bodyWidth = Math.max(0, maxWidth - suffixWidth - 1);
  const fittedBody = bodyWidth > 0 ? middleTruncate(bodyText, bodyWidth, theme) : "";
  const gapWidth = Math.max(1, maxWidth - visibleWidth(fittedBody) - suffixWidth);
  return `${fittedBody}${" ".repeat(gapWidth)}${suffix}`;
}

// --- severity (design language §6) -------------------------------------------------------

/** Severity thresholds for tool result sizes, in chars (design language §6). */
export type SizeThresholds = { warning: number; error: number };

export const SIZE_THRESHOLDS: SizeThresholds = { warning: 10_000, error: 50_000 };

/**
 * Tone for a result-size quantity: dim below the warning threshold so healthy rows
 * stay quiet; warning/error above so ballooned outputs jump out of the column.
 */
export function sizeTone(chars: number, thresholds: SizeThresholds = SIZE_THRESHOLDS): Tone {
  if (chars >= thresholds.error) return "error";
  if (chars >= thresholds.warning) return "warning";
  return "dim";
}

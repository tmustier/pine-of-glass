// The pine-of-glass family style — implementation of docs/design-language.md §§1–6.
// Identity lives in glyphs and layout, not colour: all ink is theme-derived through
// ink(), with raw-ANSI fallbacks only for surfaces rendered before a Theme handle
// exists and for the one tone pi's theme has no faithful role for ("running").

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

/** Line-kind glyphs: one per line, gutter position (design language §1). */
export const GLYPH = {
  /** a tool action (one trace row) — traceline */
  tool: "\u203a", // ›
  /** a loop-economics fact (clock, notice, ledger line) — cachemire */
  econ: "\u25cd", // ◍
  /** an expandable/summarizable section header — contextimate */
  section: "\u25b8", // ▸
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

// Metric rows: the label / token column / dim detail grammar shared by every
// Contextimate view, the token label layout that keeps magnitudes aligned, and the
// count details those rows carry.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { compactCount } from "../_lib/fmt.ts";
import { ELLIPSIS, GLYPH, ink } from "../_lib/style.ts";

export type TokenLabelLayout = { unitWidth: number; fieldWidth: number };

function tokenIntegerWidth(tokens: number): number {
  return compactCount(tokens).split(".", 1)[0].length;
}

export function estimatedTokenLabel(tokens: number, layout: TokenLabelLayout = tokenLabelLayout([tokens])): string {
  const leftPad = " ".repeat(Math.max(0, layout.unitWidth - tokenIntegerWidth(tokens)));
  return `${leftPad}~${compactCount(tokens)}`;
}

export function estimatedTokenField(tokens: number, layout: TokenLabelLayout): string {
  return estimatedTokenLabel(tokens, layout).padEnd(layout.fieldWidth, " ");
}

export function exactTokenLabel(tokens: number, layout: TokenLabelLayout = tokenLabelLayout([tokens])): string {
  const leftPad = " ".repeat(Math.max(0, layout.unitWidth - tokenIntegerWidth(tokens)) + 1);
  return `${leftPad}${compactCount(tokens)}`;
}

export function tokenLabelLayout(tokens: number[]): TokenLabelLayout {
  const unitWidth = Math.max(0, ...tokens.map(tokenIntegerWidth));
  const rawLabels = tokens.map((token) => {
    const leftPad = " ".repeat(Math.max(0, unitWidth - tokenIntegerWidth(token)));
    return `${leftPad}~${compactCount(token)}`;
  });
  return { unitWidth, fieldWidth: Math.max(0, ...rawLabels.map((label) => label.length)) };
}

export function padLabel(label: string, width: number): string {
  // Overlong labels truncate rather than overflow: the token column is a column, and a
  // single 40-char title must not shift it (the … keeps the loss visible).
  const fitted = label.length >= width ? `${label.slice(0, Math.max(0, width - 2))}${ELLIPSIS}` : label;
  return fitted.padEnd(width, " ");
}

// One renderer for every label/tokens/detail row — section rows, session rows, and
// totals all flow through here, so alignment and grammar can never diverge.
export type MetricRow = {
  label: string;
  tokens: number;
  /** pi-reported numbers render without the ~ estimate marker. */
  exact?: boolean;
  /** total rows: accent + bold. */
  emphasis?: boolean;
  /** dim suffix, parens included, e.g. "(1.2k ch)" or "(residual)". */
  detail?: string;
  /** summary section rows open with the family ▸ glyph (design language §1). */
  section?: boolean;
};

/** One token column for a block of metric rows rendered together at one width. */
export type MetricLayout = { tokens: TokenLabelLayout; labelWidth: number; width: number };

const METRIC_LABEL_WIDTH = 42;

function metricTokenText(row: MetricRow, tokens: TokenLabelLayout): string {
  return `${row.exact ? exactTokenLabel(row.tokens, tokens) : estimatedTokenLabel(row.tokens, tokens)} tokens`;
}

// The label column keeps its roomy width while every row fits, and gives up only the
// padding a narrow terminal needs; it never cuts into the widest label.
export function metricLayout(rows: MetricRow[], tokens: TokenLabelLayout, width: number): MetricLayout {
  const widestLabel = Math.max(0, ...rows.map((row) => row.label.length + (row.section ? 2 : 0)));
  const widestRight = Math.max(0, ...rows.map((row) => metricTokenText(row, tokens).length + (row.detail ? row.detail.length + 1 : 0)));
  const floor = Math.min(METRIC_LABEL_WIDTH, widestLabel + 2);
  return { tokens, width, labelWidth: Math.min(METRIC_LABEL_WIDTH, Math.max(floor, width - 2 - widestRight)) };
}

// A row too wide for the terminal hangs its detail under the token column instead of
// letting the wrap restart at column 0 and break the column.
export function renderMetricRow(row: MetricRow, theme: Theme, layout: MetricLayout): string[] {
  const tokenText = metricTokenText(row, layout.tokens);
  const hang = row.detail !== undefined && 2 + layout.labelWidth + tokenText.length + 1 + row.detail.length > layout.width;
  const inlineDetail = row.detail && !hang ? ` ${row.detail}` : "";
  let line: string;
  if (row.emphasis) {
    line = `  ${ink(theme, "accent", theme.bold(`${padLabel(row.label, layout.labelWidth)}${tokenText}`))}${inlineDetail ? theme.fg("dim", inlineDetail) : ""}`;
  } else {
    const lead = row.section ? `${ink(theme, "accent", GLYPH.section)} ` : "";
    const labelWidth = row.section ? layout.labelWidth - 2 : layout.labelWidth; // glyph + space keep the token column aligned
    line = `  ${lead}${theme.fg("muted", padLabel(row.label, labelWidth))}${theme.fg("dim", `${tokenText}${inlineDetail}`)}`;
  }
  if (!hang || !row.detail) return [line];
  const indent = " ".repeat(2 + layout.labelWidth);
  const detailLines = wrapTextWithAnsi(row.detail, Math.max(1, layout.width - indent.length));
  return [line, ...detailLines.map((detail) => `${indent}${theme.fg("dim", detail)}`)];
}

// --- the family number grammar: `~0.5k tokens (1.2k ch ÷ 2.6)` -------------------------

export function ratioDetail(denominator: number): string {
  const value = Number.isInteger(denominator) ? String(denominator) : denominator.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `÷ ${value}`;
}

export function countDetail(chars: number, detail?: string): string {
  return `(${compactCount(chars)} ch${detail ? ` ${detail}` : ""})`;
}

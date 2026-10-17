// The three Contextimate views share token columns, session rows and tool tables.
import type { ContextUsage, Theme } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../_lib/ansi.ts";
import { compactCount } from "../_lib/fmt.ts";
import { GLYPH, SEP, ink, panelHeader } from "../_lib/style.ts";
import {
  countDetail, estimatedTokenField, estimatedTokenLabel, metricLayout,
  ratioDetail, renderMetricRow, tokenLabelLayout,
  type MetricLayout, type MetricRow, type TokenLabelLayout,
} from "./metric-rows.ts";
import type { SessionEstimate } from "./session-accounting.ts";
import {
  estimateSnapshotSession, sectionTokens, singleLine, totalTokens,
  type PrefixSnapshot, type ScanRow,
} from "./snapshot.ts";
import { renderExpandedToolsBlock } from "./tool-table.ts";

export type ViewMode = "summary" | "compact" | "expanded";

// Theme-derived accent carries the token figures, totals and filled context bar.
function accent(theme: Theme, text: string): string {
  return ink(theme, "accent", text);
}

// State methodology once in the header; data rows carry only raw sizes. Disclose
// session/tool methods here only when they differ from the text ratio.
function renderHeader(snapshot: PrefixSnapshot, mode: ViewMode, theme: Theme): string[] {
  const ctrlO = keyText("app.tools.expand") || "Ctrl+O";
  const heuristic = snapshot.heuristic;
  const sessionPart = heuristic.sessionDenominator !== heuristic.textDenominator
    ? `${SEP}session ${ratioDetail(heuristic.sessionDenominator)}`
    : "";
  const toolsPart = heuristic.toolNumerator === "openai-cookbook"
    ? `${SEP}tools: OpenAI render`
    : heuristic.toolDenominator !== heuristic.textDenominator
      ? `${SEP}tools ${ratioDetail(heuristic.toolDenominator)}`
      : "";
  return panelHeader(theme, "Contextimate", {
    modes: ["summary", "compact", "expanded"],
    active: mode,
    hint: `${ctrlO}: cycle view${SEP}model ${snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "unknown model"}${SEP}counts ch ${ratioDetail(heuristic.textDenominator)}${sessionPart}${toolsPart} (${heuristic.label})`,
  });
}

function renderExpandedNote(note: string, theme: Theme): string {
  return `    ${theme.fg("dim", note)}`;
}

// --- proportion (design language §8): "of what" — shares of the context window --------

/**
 * Integer percent of the context window; `<1%` rather than a dishonest `0%`. Shares
 * derived from estimated token counts carry the ~ marker — a wrong harness estimate
 * must not masquerade as exact (only a fully provider-backed Total request drops ~).
 */
function ctxShareLabel(tokens: number, usage: ContextUsage | undefined): string | undefined {
  if (!usage || usage.tokens === null || usage.contextWindow <= 0) return undefined;
  const percent = (tokens / usage.contextWindow) * 100;
  if (!Number.isFinite(percent) || percent < 0) return undefined;
  const rounded = Math.round(percent);
  if (rounded === 0 && tokens > 0) return "<1% ctx";
  return `~${rounded}% ctx`;
}

function harnessTokens(snapshot: PrefixSnapshot): number {
  return estimateSnapshotSession(snapshot)?.harnessTokens ?? totalTokens(snapshot);
}

function harnessDetail(snapshot: PrefixSnapshot): string {
  const share = ctxShareLabel(harnessTokens(snapshot), snapshot.contextUsage);
  return estimateSnapshotSession(snapshot)?.harnessSource === "measured"
    ? `(measured${SEP}rows ~${compactCount(totalTokens(snapshot))}${share ? `${SEP}${share}` : ""})`
    : countDetail(snapshot.sections.reduce((sum, section) => sum + section.content.length, 0), share ? `· ${share}` : undefined);
}

type SessionMetrics = { rows: MetricRow[]; estimate: SessionEstimate; bar: boolean };

function sessionMetrics(snapshot: PrefixSnapshot): SessionMetrics | undefined {
  const estimate = estimateSnapshotSession(snapshot);
  if (!snapshot.session || !estimate) return undefined;
  const sessionShare = ctxShareLabel(estimate.totalTokens, snapshot.contextUsage);
  const provenance = estimate.totalSource === "pi" ? "Pi-based" : "heuristic fallback";
  const { toolOutputChars, measuredToolOutputChars } = snapshot.session;
  const measured = measuredToolOutputChars === toolOutputChars
    ? "· measured"
    : `· ${Math.floor((measuredToolOutputChars / toolOutputChars) * 100)}% measured`;
  const rows: MetricRow[] = [
    { label: "Tool outputs", tokens: estimate.toolOutputTokens, detail: countDetail(toolOutputChars, measuredToolOutputChars > 0 ? measured : undefined) },
    { label: "Messages", tokens: estimate.messageTokens, detail: countDetail(snapshot.session.messageChars) },
  ];
  if (estimate.thinkingSummaryTokens > 0) {
    rows.push({
      label: "Thinking summaries",
      tokens: estimate.thinkingSummaryTokens,
      detail: countDetail(snapshot.session.thinkingSummaryChars),
    });
  }
  if (estimate.reasoningTokens !== undefined) {
    rows.push({
      label: "Reasoning context",
      tokens: estimate.reasoningTokens,
      exact: true,
      detail: "(provider)",
    });
  }
  rows.push(
    { label: "Unattributed", tokens: estimate.unattributedTokens, detail: "(accounting gap)" },
    {
      label: "Total session",
      tokens: estimate.totalTokens,
      emphasis: true,
      detail: sessionShare ? `(${sessionShare} · ${provenance})` : `(${provenance})`,
    },
  );
  const usage = snapshot.contextUsage;
  if (!usage || usage.tokens === null) return { rows, estimate, bar: false };
  const usageEstimated = snapshot.session.contextUsageEstimated;
  if (snapshot.preSwitchUsage) {
    // The provider-backed portion is in the old model's currency (issue #58).
    // Name it without dividing by the new window; preserve Pi's estimate marker
    // when trailing local messages have been added after that billed response.
    rows.push({
      label: "Total request",
      tokens: usage.tokens,
      exact: !usageEstimated,
      emphasis: true,
      detail: usageEstimated
        ? `(pre-switch total \u00b7 ${snapshot.preSwitchUsage.billedModel} usage + Pi est.)`
        : `(pre-switch usage \u00b7 ${snapshot.preSwitchUsage.billedModel} tokens)`,
    });
    return { rows, estimate, bar: false };
  }
  const percent = usage.percent !== null && Number.isFinite(usage.percent) ? `${usage.percent.toFixed(1)}%` : undefined;
  const window = usage.contextWindow > 0 ? compactCount(usage.contextWindow).replace(/\.0(k|M)$/, "$1") : undefined;
  rows.push({
    label: "Total request",
    tokens: usage.tokens,
    exact: !usageEstimated,
    emphasis: true,
    detail: percent && window
      ? usageEstimated ? `(${percent} · Pi est.)` : `(${percent} / ${window} ctx)`
      : usageEstimated ? "(Pi est.)" : "(Pi usage)",
  });
  return { rows, estimate, bar: true };
}

function renderSessionRows(session: SessionMetrics | undefined, snapshot: PrefixSnapshot, theme: Theme, layout: MetricLayout): string[] {
  if (!session) return [];
  const lines = ["", ...session.rows.flatMap((row) => renderMetricRow(row, theme, layout))];
  // One stacked bar under Total request: the carried part (harness + session) in accent,
  // free window dim — the half-second "how full am I?" answer.
  const usage = snapshot.contextUsage;
  if (session.bar && usage && usage.tokens !== null) {
    if (usage.contextWindow <= 0) return lines;
    const estimate = session.estimate;
    const free = Math.max(0, usage.contextWindow - usage.tokens);
    const legend =
      `harness ~${compactCount(estimate.harnessTokens)}${SEP}session ~${compactCount(estimate.totalTokens)}${SEP}free ${compactCount(free)}`;
    const room = Math.max(0, layout.width - 4 - legend.length - 2);
    const sameLine = room >= 12;
    const barWidth = Math.min(28, Math.max(12, sameLine ? room : layout.width - 4));
    const carried = Math.min(1, Math.max(0, usage.tokens / usage.contextWindow));
    const filled = Math.min(barWidth, Math.max(usage.tokens > 0 ? 1 : 0, Math.round(carried * barWidth)));
    const bar = `${accent(theme, "█".repeat(filled))}${theme.fg("dim", "▒".repeat(barWidth - filled))}`;
    lines.push(...(sameLine
      ? [`  ${bar}  ${theme.fg("dim", legend)}`]
      : [`  ${bar}`, `  ${theme.fg("dim", legend)}`]));
  }
  return lines;
}

function harnessTotalRow(snapshot: PrefixSnapshot): MetricRow {
  return { label: "Total harness", tokens: harnessTokens(snapshot), emphasis: true, detail: harnessDetail(snapshot) };
}

function summaryTokenLayout(snapshot: PrefixSnapshot): TokenLabelLayout {
  const values = [...snapshot.sections.map(sectionTokens), harnessTokens(snapshot)];
  const sessionEstimate = estimateSnapshotSession(snapshot);
  if (sessionEstimate) values.push(
    sessionEstimate.totalTokens,
    sessionEstimate.toolOutputTokens,
    sessionEstimate.messageTokens,
    sessionEstimate.thinkingSummaryTokens,
    sessionEstimate.unattributedTokens,
  );
  if (sessionEstimate?.reasoningTokens !== undefined) values.push(sessionEstimate.reasoningTokens);
  if (typeof snapshot.contextUsage?.tokens === "number") values.push(snapshot.contextUsage.tokens);
  return tokenLabelLayout(values);
}

export function renderSummary(snapshot: PrefixSnapshot, theme: Theme, width = 80): string[] {
  const lines = renderHeader(snapshot, "summary", theme);
  const harnessRows: MetricRow[] = [
    ...snapshot.sections.map((section): MetricRow => ({
      label: section.title,
      tokens: sectionTokens(section),
      detail: countDetail(section.content.length),
      section: true,
    })),
    harnessTotalRow(snapshot),
  ];
  const session = sessionMetrics(snapshot);
  const layout = metricLayout([...harnessRows, ...(session?.rows ?? [])], summaryTokenLayout(snapshot), width);
  lines.push(
    "",
    ...harnessRows.flatMap((row) => renderMetricRow(row, theme, layout)),
    ...renderSessionRows(session, snapshot, theme, layout),
  );
  lines.push(""); // panel tail spacer (design language §8)
  return lines;
}

type CompactLayout = { labelWidth: number; tokenLayout: TokenLabelLayout };

function compactLabel(label: string, width: number): string {
  if (label.length > width) return `${label.slice(0, Math.max(0, width - 1))}…`;
  return label.padEnd(width, " ");
}

function numericRowTokens(rows: ScanRow[]): number[] {
  return rows.flatMap((row) => row.inactive ? [] : [row.tokens]);
}

function renderScanRows(rows: ScanRow[], theme: Theme, width: number, layout?: CompactLayout): string[] {
  const labelWidth = layout?.labelWidth ?? Math.min(26, Math.max(...rows.map((row) => row.name.length)));
  const tokenLayout = layout?.tokenLayout ?? tokenLabelLayout(numericRowTokens(rows));
  const tokenWidth = Math.max(tokenLayout.fieldWidth, tokenLayout.unitWidth + 1, 1);
  const effectiveTokenLayout = { ...tokenLayout, fieldWidth: tokenWidth };
  const descWidth = Math.max(24, width - (4 + labelWidth + 2 + tokenWidth + 2));
  return rows.map((row) => {
    const name = compactLabel(row.name, labelWidth);
    const desc = row.desc ? singleLine(row.desc, descWidth) : "";
    const token = row.inactive
      ? "-".padStart(tokenLayout.unitWidth + 1).padEnd(tokenWidth, " ")
      : estimatedTokenField(row.tokens, effectiveTokenLayout);
    if (row.inactive) {
      return theme.fg("dim", `    ${name}  ${token}${desc ? `  ${desc}` : ""}`);
    }
    return `    ${theme.fg("text", name)}  ${accent(theme, token)}${desc ? `  ${theme.fg("dim", desc)}` : ""}`;
  });
}

export function renderCompact(snapshot: PrefixSnapshot, theme: Theme, width: number): string[] {
  const lines = renderHeader(snapshot, "compact", theme);
  const rows = snapshot.sections.flatMap((section) => section.compactRows ?? []);
  const labels = [
    ...snapshot.sections.map((section) => section.title),
    ...rows.map((row) => row.name),
    "Total harness",
  ];
  const labelWidth = Math.min(26, Math.max(0, ...labels.map((label) => label.length)));
  const tokenLayout = tokenLabelLayout([
    ...snapshot.sections.map(sectionTokens),
    ...numericRowTokens(rows),
    harnessTokens(snapshot),
  ]);
  const layout = { labelWidth, tokenLayout };
  for (const section of snapshot.sections) {
    const title = compactLabel(section.title, layout.labelWidth);
    const counts = `${estimatedTokenLabel(sectionTokens(section), layout.tokenLayout)} tokens ${countDetail(section.content.length)}`;
    lines.push("", `  ${accent(theme, GLYPH.section)} ${theme.bold(title)}  ${theme.fg("dim", counts)}`);
    if (section.compactRows && section.compactRows.length > 0) {
      lines.push(...renderScanRows(section.compactRows, theme, width, layout));
    }
  }
  const session = sessionMetrics(snapshot);
  const sessionLayout = metricLayout(session?.rows ?? [], summaryTokenLayout(snapshot), width);
  const totalLabel = compactLabel("Total harness", layout.labelWidth + 2);
  const totalToken = `${estimatedTokenLabel(harnessTokens(snapshot), layout.tokenLayout)} tokens`;
  lines.push("", `  ${accent(theme, theme.bold(`${totalLabel}  ${totalToken}`))} ${theme.fg("dim", harnessDetail(snapshot))}`,
    ...renderSessionRows(session, snapshot, theme, sessionLayout));
  lines.push(""); // panel tail spacer (design language §8)
  return lines;
}

export function renderExpanded(snapshot: PrefixSnapshot, theme: Theme, width: number): string[] {
  const lines = renderHeader(snapshot, "expanded", theme);
  const harnessRow = harnessTotalRow(snapshot);
  const session = sessionMetrics(snapshot);
  const layout = metricLayout([harnessRow, ...(session?.rows ?? [])], summaryTokenLayout(snapshot), width);
  lines.push(
    ...renderMetricRow(harnessRow, theme, layout),
    ...renderSessionRows(session, snapshot, theme, layout),
  );

  for (const section of snapshot.sections) {
    const tokens = sectionTokens(section);
    const chars = section.content.length;
    const left = `  ${theme.bold(section.title)}  ${accent(theme, `${estimatedTokenLabel(tokens)} tokens`)}`;
    const right = theme.fg("dim", `${compactCount(chars)} ch ${section.detail}`);
    const used = stripAnsi(left).length + stripAnsi(right).length;
    lines.push("", `${left}${" ".repeat(Math.max(2, Math.max(40, width) - used))}${right}`);
    const expanded = section.expanded;
    if (expanded.kind === "tools") {
      lines.push(...renderExpandedToolsBlock(expanded, theme, width));
      continue;
    }
    if (expanded.note) lines.push(renderExpandedNote(expanded.note, theme));
    if (expanded.kind === "text" && expanded.attribution) lines.push(renderExpandedNote(expanded.attribution, theme));
    if (expanded.kind === "skills") {
      lines.push("", ...renderScanRows(expanded.rows, theme, width));
    } else if (expanded.preview && expanded.preview.length > 0) {
      lines.push("", ...expanded.preview.map((line) => `    ${theme.fg("dim", singleLine(line, Math.max(24, width - 4)))}`));
    }
  }

  lines.push(""); // panel tail spacer (design language §8)
  return lines;
}

import type { Component } from "@earendil-works/pi-tui";
import type { ContextUsage, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripAnsi } from "../_lib/ansi.ts";
import {
  findContainerBy,
  isAssistantRow,
  isResourceRow,
  isToolRow,
  RESOURCE_HEADER_RE,
  type ContainerLike,
} from "../_lib/chat.ts";
import { compactCount } from "../_lib/fmt.ts";
import { type ModelSummary } from "../_lib/heuristics.ts";
import { estimateOpenAIFunctionToolTokens, estimateOpenAIToolDefinitionTokens } from "../_lib/tool-payloads.ts";
import { GLYPH, SEP, ink, panelHeader } from "../_lib/style.ts";
import {
  countDetail,
  estimatedTokenField,
  estimatedTokenLabel,
  exactTokenLabel,
  formatPercent,
  metricLayout,
  ratioDetail,
  renderMetricRow,
  tokenLabelLayout,
  type MetricLayout,
  type MetricRow,
  type TokenLabelLayout,
} from "./metric-rows.ts";
import { detectRuntimeAdditions, getPromptRemainder, parseSkillsBlock } from "./prompt-parsing.ts";
import {
  buildSessionBreakdown,
  estimateSessionBreakdown,
  type SessionBreakdown,
  type SessionEstimate,
} from "./session-accounting.ts";
import {
  type ContextimateConfig,
  type ResolvedHeuristic,
  toModelSummary,
  parseContextimateConfig,
  loadContextimateConfig,
  resolveHeuristic,
} from "./heuristic-config.ts";
import {
  type ScanRow,
  type PrefixSection,
  type PrefixSnapshot,
  tildeAll,
  singleLine,
  parseContextSections,
  runtimeAdditionsAttribution,
  buildSkillsSection,
  buildSnapshot,
  sectionTokens,
  sectionChars,
  totalTokens,
  totalChars,
} from "./snapshot.ts";
import {
  type ToolSummary,
  type ToolField,
  type ToolExpanded,
  buildToolNumerator,
  buildToolDisplayEstimate,
} from "./tool-accounting.ts";

type ViewMode = "summary" | "compact" | "expanded";

type ContextimateTui = {
  children?: unknown[];
  requestRender?: (force?: boolean) => void;
};

type ContextimateGlobal = typeof globalThis & {
  __piContextimateTui?: ContextimateTui;
  __piContextimateChat?: ContainerLike;
  __piContextimateBlock?: StartupContextComponent;
  __piContextimateMode?: ViewMode;
  __piContextimateInstallTimer?: ReturnType<typeof setTimeout>;
  __piContextimateModel?: ModelSummary;
};

const g = globalThis as ContextimateGlobal;

const DEFAULT_MODE: ViewMode = "summary";

// The family accent (design language §3): theme-derived, used sparingly — the panel
// brand, token figures, total rows, and the carried part of the context bar.
function accent(theme: Theme | undefined, text: string): string {
  return ink(theme, "accent", text);
}

function middleTruncatePath(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 3) return "…";
  const keep = width - 1;
  let tail = Math.min(Math.floor(keep * 0.5), 28);
  const slashIndex = text.lastIndexOf("/");
  if (slashIndex >= 0 && text.length - slashIndex <= Math.floor(keep * 0.6)) {
    tail = text.length - slashIndex;
  }
  const head = Math.max(1, keep - tail);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

function modelLabel(model?: ModelSummary): string {
  return model ? `${model.provider}/${model.id}` : "unknown model";
}

// Only for walking the foreign TUI component tree, whose objects we do not control.
// Snapshot building deliberately has no such guards: if pi's session callbacks throw
// (resume race), render()'s catch shows the honest "unavailable" line instead of a
// quietly zeroed panel.
function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function nextMode(mode: ViewMode): ViewMode {
  return mode === "summary" ? "compact" : mode === "compact" ? "expanded" : "summary";
}

// Methodology is stated here, once, in the dim hint line (design language §5) — data
// rows carry only raw sizes. When the session or tool method deviates from the text
// ratio, say so here (tool tokens may come from the OpenAI formula or a different
// denominator); the expanded view stays the per-section audit trail.
function methodologyHint(heuristic: ResolvedHeuristic): string {
  const sessionPart = heuristic.sessionDenominator !== heuristic.textDenominator
    ? `${SEP}session ${ratioDetail(heuristic.sessionDenominator)}`
    : "";
  const toolsPart = heuristic.toolNumerator === "openai-cookbook"
    ? `${SEP}tools: OpenAI render`
    : heuristic.toolDenominator !== heuristic.textDenominator
      ? `${SEP}tools ${ratioDetail(heuristic.toolDenominator)}`
      : "";
  return `counts ch ${ratioDetail(heuristic.textDenominator)}${sessionPart}${toolsPart} (${heuristic.label})`;
}

function renderHeader(snapshot: PrefixSnapshot, mode: ViewMode, theme: Theme): string[] {
  const ctrlO = keyText("app.tools.expand") || "Ctrl+O";
  return panelHeader(theme, "Contextimate", {
    modes: ["summary", "compact", "expanded"],
    active: mode,
    hint: `${ctrlO}: cycle view${SEP}model ${modelLabel(snapshot.model)}${SEP}${methodologyHint(snapshot.heuristic)}`,
  });
}

function joinLeftRight(left: string, right: string, width: number, gap = 2): string {
  if (!right) return left;
  const used = stripAnsi(left).length + stripAnsi(right).length;
  return `${left}${" ".repeat(Math.max(gap, width - used))}${right}`;
}

function wrapPlainText(text: string, width: number, maxLines: number): string[] {
  const max = Math.max(16, width);
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const wrapped = wrapTextWithAnsi(normalized, max);
  if (wrapped.length <= maxLines) return wrapped;
  const capped = wrapped.slice(0, maxLines);
  const last = capped[maxLines - 1] ?? "";
  // Reserve a column for the ellipsis so the capped line still fits `width`.
  capped[maxLines - 1] = last.length >= max ? `${last.slice(0, max - 1)}…` : `${last}…`;
  return capped;
}

function renderExpandedSectionHeader(section: PrefixSection, theme: Theme, width: number): string {
  const tokens = sectionTokens(section);
  const chars = sectionChars(section);
  const left = `  ${theme.bold(section.title)}  ${accent(theme, `${estimatedTokenLabel(tokens)} tokens`)}`;
  const right = theme.fg("dim", `${compactCount(chars)} ch ${section.detail}`);
  return joinLeftRight(left, right, Math.max(40, width));
}

function renderExpandedNote(note: string, theme: Theme): string {
  return `    ${theme.fg("dim", note)}`;
}

function renderExpandedPreview(lines: string[], theme: Theme, width: number): string[] {
  const max = Math.max(24, width - 4);
  return lines.map((line) => `    ${theme.fg("dim", singleLine(line, max))}`);
}

type FieldColumns = { nameCol: number; typeCol: number; hasRequired: boolean };

const fieldIndent = (depth: number) => 6 + depth * 2;

// Column layout across *all* fields in the tools block (design language §8): each
// tool used to size its own columns, so the section read as a stack of differently
// ragged mini-tables instead of one aligned table.
function toolFieldColumns(fields: ToolField[]): FieldColumns {
  return {
    nameCol: Math.min(30, Math.max(0, ...fields.map((field) => fieldIndent(field.depth) + field.name.length))),
    typeCol: Math.min(10, Math.max(0, ...fields.map((field) => field.type.length))),
    hasRequired: fields.some((field) => field.required),
  };
}

function renderToolFieldRows(fields: ToolField[], theme: Theme, width: number, columns?: FieldColumns): string[] {
  if (fields.length === 0) return [`      ${theme.fg("dim", "(no parameters)")}`];
  const { nameCol, typeCol, hasRequired } = columns ?? toolFieldColumns(fields);
  return fields.map((field) => {
    const rawName = `${" ".repeat(fieldIndent(field.depth))}${field.name}`;
    const namePart = rawName.length > nameCol ? `${rawName.slice(0, nameCol - 1)}…` : rawName.padEnd(nameCol, " ");
    const typePart = field.type.length > typeCol ? `${field.type.slice(0, typeCol - 1)}…` : field.type.padEnd(typeCol, " ");
    const reqPart = hasRequired ? (field.required ? "required" : "        ") : "";
    const prefixWidth = namePart.length + 2 + typePart.length + (hasRequired ? 2 + reqPart.length : 0);
    const descWidth = Math.max(16, width - prefixWidth - 3);
    const desc = field.description ? singleLine(field.description, descWidth) : "";
    return `${theme.fg("text", namePart)}  ${theme.fg("muted", typePart)}${hasRequired ? `  ${theme.fg("dim", reqPart)}` : ""}${desc ? `  ${theme.fg("dim", desc)}` : ""}`;
  });
}

// Tool entry header (design language §8): the name is the L0 anchor — bold — with
// the shortened provenance beside it at L3-dim, so a column of tools scans by name
// while the audit trail stays present without competing. Tokens keep the accent,
// right-aligned. When width runs out the provenance gives way before the name does.
function renderExpandedToolHeader(tool: ToolExpanded, tokenLayout: TokenLabelLayout, theme: Theme, width: number): string {
  const maxWidth = Math.max(40, width);
  const indent = "    ";
  const gap = 2;
  const token = estimatedTokenField(tool.tokens, tokenLayout);
  const labelWidth = Math.max(12, maxWidth - indent.length - gap - tokenLayout.fieldWidth);
  const name = tool.name.length > labelWidth ? middleTruncatePath(tool.name, labelWidth) : tool.name;
  const sourceRoom = labelWidth - name.length - SEP.length;
  const source = tool.source && sourceRoom >= 8 ? middleTruncatePath(tildeAll(tool.source), sourceRoom) : "";
  const plainLabel = source ? `${name}${SEP}${source}` : name;
  const used = indent.length + plainLabel.length + tokenLayout.fieldWidth;
  const styled = `${theme.fg("text", theme.bold(name))}${source ? theme.fg("dim", `${SEP}${source}`) : ""}`;
  return `${indent}${styled}${" ".repeat(Math.max(gap, maxWidth - used))}${accent(theme, token)}`;
}

function renderExpandedToolsBlock(content: { notes: string[]; tools: ToolExpanded[] }, theme: Theme, width: number): string[] {
  const out: string[] = [];
  const tokenLayout = tokenLabelLayout(content.tools.map((tool) => tool.tokens));
  const allFields = content.tools.flatMap((tool) => tool.fields);
  const columns = allFields.length > 0 ? toolFieldColumns(allFields) : undefined;
  for (const note of content.notes) {
    for (const line of wrapPlainText(note, Math.max(24, width - 4), 4)) out.push(`    ${theme.fg("dim", line)}`);
  }
  for (const tool of content.tools) {
    out.push("");
    out.push(renderExpandedToolHeader(tool, tokenLayout, theme, width));
    if (tool.description && tool.description !== "(no description)") {
      for (const line of wrapPlainText(tool.description, Math.max(24, width - 6), 3)) {
        out.push(`      ${theme.fg("dim", line)}`);
      }
    }
    out.push(...renderToolFieldRows(tool.fields, theme, width, columns));
  }
  return out;
}

function buildSessionEstimate(snapshot: PrefixSnapshot): SessionEstimate | undefined {
  if (!snapshot.session) return undefined;
  // Provider counts from before a model switch are in the old model's tokens.
  const session = snapshot.preSwitchUsage
    ? { ...snapshot.session, reasoningTokens: undefined, measuredToolOutputTokens: 0, measuredToolOutputChars: 0, firstPrompt: undefined }
    : snapshot.session;
  return estimateSessionBreakdown(session, {
    denominator: snapshot.heuristic.sessionDenominator,
    harnessTokens: totalTokens(snapshot),
    contextTokens: snapshot.preSwitchUsage ? undefined : snapshot.contextUsage?.tokens,
  });
}

// --- proportion (design language §8): "of what" — shares of the context window --------

/**
 * Integer percent of the context window; `<1%` rather than a dishonest `0%`. Shares
 * derived from estimated token counts carry the ~ marker — a wrong harness estimate
 * must not masquerade as exact (only a fully provider-backed Total request drops ~).
 */
function ctxShareLabel(tokens: number, usage: ContextUsage | undefined, options: { estimate?: boolean } = {}): string | undefined {
  if (!usage || usage.tokens === null || usage.contextWindow <= 0) return undefined;
  const percent = (tokens / usage.contextWindow) * 100;
  if (!Number.isFinite(percent) || percent < 0) return undefined;
  const rounded = Math.round(percent);
  if (rounded === 0 && tokens > 0) return "<1% ctx";
  return `${options.estimate ? "~" : ""}${rounded}% ctx`;
}

// The window is a budget label, not a measurement: 200k, not 200.0k.
function contextWindowLabel(tokens: number): string {
  return compactCount(tokens).replace(/\.0(k|M)$/, "$1");
}

function harnessTokens(snapshot: PrefixSnapshot): number {
  return buildSessionEstimate(snapshot)?.harnessTokens ?? totalTokens(snapshot);
}

function harnessDetail(snapshot: PrefixSnapshot): string {
  const share = ctxShareLabel(harnessTokens(snapshot), snapshot.contextUsage, { estimate: true });
  return buildSessionEstimate(snapshot)?.harnessSource === "measured"
    ? `(measured${SEP}rows ~${compactCount(totalTokens(snapshot))}${share ? `${SEP}${share}` : ""})`
    : countDetail(totalChars(snapshot), share ? `· ${share}` : undefined);
}

// One stacked bar under Total request: the carried part (harness + session) in accent,
// free window dim — the half-second "how full am I?" answer.
function renderContextBar(snapshot: PrefixSnapshot, estimate: SessionEstimate, theme: Theme, width: number): string[] {
  const usage = snapshot.contextUsage;
  if (!usage || usage.tokens === null || usage.contextWindow <= 0) return [];
  const free = Math.max(0, usage.contextWindow - usage.tokens);
  const legend =
    `harness ~${compactCount(estimate.harnessTokens)}${SEP}session ~${compactCount(estimate.totalTokens)}${SEP}free ${compactCount(free)}`;
  const room = Math.max(0, width - 4 - legend.length - 2);
  const sameLine = room >= 12;
  const barWidth = Math.min(28, Math.max(12, sameLine ? room : width - 4));
  const carried = Math.min(1, Math.max(0, usage.tokens / usage.contextWindow));
  const filled = Math.min(barWidth, Math.max(usage.tokens > 0 ? 1 : 0, Math.round(carried * barWidth)));
  const bar = `${accent(theme, "█".repeat(filled))}${theme.fg("dim", "▒".repeat(barWidth - filled))}`;
  return sameLine
    ? [`  ${bar}  ${theme.fg("dim", legend)}`]
    : [`  ${bar}`, `  ${theme.fg("dim", legend)}`];
}

type SessionMetrics = { rows: MetricRow[]; estimate: SessionEstimate; bar: boolean };

function sessionMetrics(snapshot: PrefixSnapshot): SessionMetrics | undefined {
  const estimate = buildSessionEstimate(snapshot);
  if (!snapshot.session || !estimate) return undefined;
  const sessionShare = ctxShareLabel(estimate.totalTokens, snapshot.contextUsage, { estimate: true });
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
  const percent = formatPercent(usage.percent);
  const window = usage.contextWindow > 0 ? contextWindowLabel(usage.contextWindow) : undefined;
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
  return [
    "",
    ...session.rows.flatMap((row) => renderMetricRow(row, theme, layout)),
    ...(session.bar ? renderContextBar(snapshot, session.estimate, theme, layout.width) : []),
  ];
}

function harnessTotalRow(snapshot: PrefixSnapshot): MetricRow {
  return { label: "Total harness", tokens: harnessTokens(snapshot), emphasis: true, detail: harnessDetail(snapshot) };
}

function summaryTokenLayout(snapshot: PrefixSnapshot): TokenLabelLayout {
  const values = [...snapshot.sections.map(sectionTokens), harnessTokens(snapshot)];
  const sessionEstimate = buildSessionEstimate(snapshot);
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

function renderSummary(snapshot: PrefixSnapshot, theme: Theme, width = 80): string[] {
  const lines = renderHeader(snapshot, "summary", theme);
  const harnessRows: MetricRow[] = [
    ...snapshot.sections.map((section): MetricRow => ({
      label: section.title,
      tokens: sectionTokens(section),
      detail: countDetail(sectionChars(section)),
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
  return rows.flatMap((row) => typeof row.tokens === "number" ? [row.tokens] : []);
}

function compactLayout(snapshot: PrefixSnapshot): CompactLayout {
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
  return { labelWidth, tokenLayout };
}

function inactiveTokenField(layout: TokenLabelLayout): string {
  return "-".padStart(Math.max(1, layout.unitWidth + 1)).padEnd(Math.max(layout.fieldWidth, layout.unitWidth + 1, 1), " ");
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
    const token = typeof row.tokens === "number"
      ? estimatedTokenField(row.tokens, effectiveTokenLayout)
      : inactiveTokenField(effectiveTokenLayout);
    if (row.inactive) {
      return theme.fg("dim", `    ${name}  ${token}${desc ? `  ${desc}` : ""}`);
    }
    return `    ${theme.fg("text", name)}  ${accent(theme, token)}${desc ? `  ${theme.fg("dim", desc)}` : ""}`;
  });
}

function renderCompactTotalRow(snapshot: PrefixSnapshot, theme: Theme, layout: CompactLayout): string {
  const label = compactLabel("Total harness", layout.labelWidth + 2);
  const token = `${estimatedTokenLabel(harnessTokens(snapshot), layout.tokenLayout)} tokens`;
  return `  ${accent(theme, theme.bold(`${label}  ${token}`))} ${theme.fg("dim", harnessDetail(snapshot))}`;
}

function renderCompact(snapshot: PrefixSnapshot, theme: Theme, width: number): string[] {
  const lines = renderHeader(snapshot, "compact", theme);
  const layout = compactLayout(snapshot);
  for (const section of snapshot.sections) {
    const title = compactLabel(section.title, layout.labelWidth);
    const counts = `${estimatedTokenLabel(sectionTokens(section), layout.tokenLayout)} tokens ${countDetail(sectionChars(section))}`;
    lines.push("", `  ${accent(theme, GLYPH.section)} ${theme.bold(title)}  ${theme.fg("dim", counts)}`);
    if (section.compactRows && section.compactRows.length > 0) {
      lines.push(...renderScanRows(section.compactRows, theme, width, layout));
    }
  }
  const session = sessionMetrics(snapshot);
  const sessionLayout = metricLayout(session?.rows ?? [], summaryTokenLayout(snapshot), width);
  lines.push("", renderCompactTotalRow(snapshot, theme, layout), ...renderSessionRows(session, snapshot, theme, sessionLayout));
  lines.push(""); // panel tail spacer (design language §8)
  return lines;
}

function renderExpanded(snapshot: PrefixSnapshot, theme: Theme, width: number): string[] {
  const lines = renderHeader(snapshot, "expanded", theme);
  const harnessRow = harnessTotalRow(snapshot);
  const session = sessionMetrics(snapshot);
  const layout = metricLayout([harnessRow, ...(session?.rows ?? [])], summaryTokenLayout(snapshot), width);
  lines.push(
    ...renderMetricRow(harnessRow, theme, layout),
    ...renderSessionRows(session, snapshot, theme, layout),
  );

  for (const section of snapshot.sections) {
    lines.push("", renderExpandedSectionHeader(section, theme, width));
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
      lines.push("", ...renderExpandedPreview(expanded.preview, theme, width));
    }
  }

  lines.push(""); // panel tail spacer (design language §8)
  return lines;
}

function wrapLines(lines: string[], width: number): string[] {
  const maxWidth = Math.max(24, width);
  const out: string[] = [];
  for (const rawLine of lines) {
    if (rawLine.length === 0) {
      out.push("");
      continue;
    }
    const wrapped = wrapTextWithAnsi(rawLine, maxWidth);
    if (wrapped.length === 0) out.push("");
    else out.push(...wrapped.map((line) => truncateToWidth(line, maxWidth, "…")));
  }
  return out;
}

class StartupContextComponent implements Component {
  readonly __piContextimateBlock = true;
  private cachedSignature?: string;
  private cachedMode?: ViewMode;
  private cachedWidth?: number;
  private cachedLines?: string[];

  // No TS parameter properties: keep the source compatible with Node's strip-only
  // type stripping so the zero-dependency test harness can import this file directly.
  private readonly snapshot: () => PrefixSnapshot;
  private readonly getTheme: () => Theme;
  private mode: ViewMode;

  constructor(snapshot: () => PrefixSnapshot, getTheme: () => Theme, mode: ViewMode) {
    this.snapshot = snapshot;
    this.getTheme = getTheme;
    this.mode = mode;
  }

  getMode(): ViewMode {
    return this.mode;
  }

  setMode(mode: ViewMode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      g.__piContextimateMode = mode;
      this.invalidate();
    }
  }

  setExpanded(_expanded: boolean): void {
    // Pi's native Ctrl+O path toggles one global boolean and calls setExpanded()
    // on every expandable chat component exactly once per toggle. Use that as
    // the single source of truth for cycling; do not also listen to raw terminal
    // input, or one keypress can advance twice.
    this.cycleMode();
  }

  cycleMode(): ViewMode {
    this.setMode(nextMode(this.mode));
    return this.mode;
  }

  render(width: number): string[] {
    try {
      const snapshot = this.snapshot();
      if (
        this.cachedLines &&
        this.cachedSignature === snapshot.signature &&
        this.cachedMode === this.mode &&
        this.cachedWidth === width
      ) {
        return this.cachedLines;
      }

      const theme = this.getTheme();
      const body = this.mode === "summary"
        ? renderSummary(snapshot, theme, width)
        : this.mode === "compact"
          ? renderCompact(snapshot, theme, width)
          : renderExpanded(snapshot, theme, width);

      this.cachedSignature = snapshot.signature;
      this.cachedMode = this.mode;
      this.cachedWidth = width;
      this.cachedLines = wrapLines(body, Math.max(20, width));
      return this.cachedLines;
    } catch {
      this.cachedSignature = "contextimate-unavailable";
      this.cachedMode = this.mode;
      this.cachedWidth = width;
      this.cachedLines = wrapLines([
        "",
        `${accent(undefined, "[Contextimate]")} unavailable while Pi finishes resuming this session`,
      ], Math.max(20, width));
      return this.cachedLines;
    }
  }

  invalidate(): void {
    this.cachedSignature = undefined;
    this.cachedMode = undefined;
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

function isPrefixBlock(component: unknown): component is StartupContextComponent {
  return !!component && typeof component === "object" && (component as { __piContextimateBlock?: boolean }).__piContextimateBlock === true;
}

// _lib/chat.ts isResourceRow, minus the panel itself: the [Contextimate] block renders
// arbitrary text the fuzzy [Section] regex must never re-anchor on.
function isResourceComponent(component: unknown): boolean {
  return !isPrefixBlock(component) && isResourceRow(component);
}

function removeExistingPrefixBlocks(chat: ContainerLike): void {
  chat.children = chat.children.filter((child) => !isPrefixBlock(child));
}

function insertionIndexAfterResourceList(chat: ContainerLike): number {
  let index = -1;
  for (let i = 0; i < chat.children.length; i++) {
    if (!isResourceComponent(chat.children[i])) continue;
    index = i;
    // SAFETY: Pi's resource container holds only TUI components.
    const next = chat.children[i + 1] as Component | undefined;
    if (next && stripAnsi(next.render(80).join("")).trim() === "") index = i + 1;
  }
  return index;
}

function isContextBlockInstalled(block: StartupContextComponent): boolean {
  return g.__piContextimateChat?.children.includes(block) === true;
}

// Pi creates the resource container once and only clears and refills it, so search until it
// is first found. Spotting resource rows means rendering components, so the search skips the
// transcript beside the list, which in a long session would cost seconds per search.
function installContextBlock(block: StartupContextComponent): boolean {
  const tui = g.__piContextimateTui;
  const chat = g.__piContextimateChat ?? findContainerBy(
    tui,
    (children) => children.some(isResourceComponent),
    (children) => children.some((child) => isToolRow(child) || isAssistantRow(child)),
  );
  if (!chat) return false;

  g.__piContextimateChat = chat;
  if (chat.children.includes(block)) return true;

  removeExistingPrefixBlocks(chat);
  const insertAfter = insertionIndexAfterResourceList(chat);
  const insertAt = insertAfter >= 0 ? insertAfter + 1 : 0;
  chat.children.splice(insertAt, 0, block);
  tui?.requestRender?.(true);
  return true;
}

function scheduleInstall(block: StartupContextComponent): void {
  if (g.__piContextimateInstallTimer) clearTimeout(g.__piContextimateInstallTimer);
  let attempts = 0;
  const attempt = () => {
    attempts++;
    if (safely(() => installContextBlock(block), false)) return;
    if (attempts < 30) {
      g.__piContextimateInstallTimer = setTimeout(attempt, 50);
    }
  };
  g.__piContextimateInstallTimer = setTimeout(attempt, 0);
}

function setMode(mode: ViewMode): void {
  g.__piContextimateMode = mode;
  g.__piContextimateBlock?.setMode(mode);
  g.__piContextimateTui?.requestRender?.(true);
}

// Test-only surface. Named exports are runtime-inert under Pi's jiti loader; this object
// exists for the repo test suites (see docs/testing.md) and is not a stable public API.
export const internals = {
  // system-prompt parsing (see prompt-parsing.ts)
  RESOURCE_HEADER_RE,
  getPromptRemainder,
  parseSkillsBlock,
  parseContextSections,
  buildSkillsSection,
  // heuristic resolution
  parseContextimateConfig,
  resolveHeuristic,
  // provider payload formats
  buildToolNumerator,
  buildToolDisplayEstimate,
  // OpenAI tool render
  estimateOpenAIToolDefinitionTokens,
  estimateOpenAIFunctionToolTokens,
  // session accounting
  buildSessionBreakdown,
  buildSessionEstimate,
  // token label layout
  tokenLabelLayout,
  estimatedTokenLabel,
  estimatedTokenField,
  exactTokenLabel,
  // proportion (design language §8)
  ctxShareLabel,
  contextWindowLabel,
  methodologyHint,
  // runtime-addition attribution (issue #9)
  detectRuntimeAdditions,
  runtimeAdditionsAttribution,
  // snapshot + renderers
  buildSnapshot,
  totalTokens,
  renderSummary,
  renderCompact,
  renderExpanded,
  stripAnsi,
};

export type {
  PrefixSnapshot,
  PrefixSection,
  ToolSummary,
  ModelSummary,
  ContextimateConfig,
  ResolvedHeuristic,
  SessionBreakdown,
};

export default function piContextimate(pi: ExtensionAPI) {
  // Snapshot building is expensive (system-prompt regex parse, JSON serialization of
  // every tool schema, a full session walk) while rendering is frequent. Rebuild only
  // after a context-changing event or a short staleness window — never per render frame.
  const SNAPSHOT_TTL_MS = 5_000;
  const cache: { value?: PrefixSnapshot; builtAt: number; dirty: boolean } = { builtAt: 0, dirty: true };
  const markDirty = () => {
    cache.dirty = true;
  };

  // Pi keeps before_agent_start rewrites (such as pi-skill-gate's filtered skill index) only
  // while a run is active, so count the prompt the latest run sent once it has one.
  let runPrompt: string | undefined;
  pi.on("turn_start", async (_event, ctx) => {
    runPrompt = ctx.getSystemPrompt();
    markDirty();
  });
  pi.on("message_end", async () => markDirty());
  pi.on("session_compact", async () => markDirty());
  // Branch checkout can change the model that billed the latest usage (issue #58).
  pi.on("session_tree", async () => markDirty());

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Restore Pi's normal header; this extension now renders below Pi's loaded-resource list.
    ctx.ui.setHeader(undefined);

    runPrompt = undefined;
    const currentMode = g.__piContextimateMode ?? DEFAULT_MODE;
    const config = loadContextimateConfig(ctx.cwd);
    g.__piContextimateModel = toModelSummary(ctx.model);
    markDirty();
    const block = new StartupContextComponent(
      () => {
        const now = Date.now();
        if (!cache.value || cache.dirty || now - cache.builtAt > SNAPSHOT_TTL_MS) {
          cache.value = buildSnapshot(
            pi,
            () => runPrompt ?? ctx.getSystemPrompt(),
            ctx.sessionManager,
            () => ctx.getContextUsage(),
            () => g.__piContextimateModel ?? toModelSummary(ctx.model),
            config,
          );
          cache.builtAt = now;
          cache.dirty = false;
        }
        return cache.value;
      },
      () => ctx.ui.theme,
      currentMode,
    );
    g.__piContextimateBlock = block;

    ctx.ui.setWidget("__pi_contextimate_capture", (tui: ContextimateTui) => {
      g.__piContextimateTui = tui;
      return {
        render: () => {
          const activeBlock = g.__piContextimateBlock;
          // Reload and navigation clear Pi's resource container and drop the panel; this
          // zero-line widget puts it back. Until the panel first attaches (quietStartup hides
          // the resource list), only session start and /contextimate search for it.
          if (activeBlock && g.__piContextimateChat && !isContextBlockInstalled(activeBlock)) scheduleInstall(activeBlock);
          return [] as string[];
        },
        invalidate: () => {},
      };
    });

    scheduleInstall(block);

  });

  pi.on("model_select", async (event, ctx) => {
    g.__piContextimateModel = toModelSummary(event.model);
    markDirty();
    g.__piContextimateBlock?.invalidate();
    if (ctx.hasUI) g.__piContextimateTui?.requestRender?.(true);
  });

  pi.on("session_shutdown", async () => {
    if (g.__piContextimateInstallTimer) clearTimeout(g.__piContextimateInstallTimer);
    g.__piContextimateInstallTimer = undefined;
  });

  pi.registerCommand("contextimate", {
    description: "Show or switch the startup [Contextimate] view (summary, compact, expanded)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const requested = args.trim().toLowerCase() as ViewMode | "";
      const mode: ViewMode = requested === "summary" || requested === "compact" || requested === "expanded"
        ? requested
        : nextMode(g.__piContextimateMode ?? g.__piContextimateBlock?.getMode() ?? DEFAULT_MODE);
      setMode(mode);
      if (g.__piContextimateBlock) scheduleInstall(g.__piContextimateBlock);
      ctx.ui.notify(`[Contextimate] view: ${mode}`, "info");
    },
  });
}

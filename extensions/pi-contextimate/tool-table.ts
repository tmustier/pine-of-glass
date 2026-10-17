// Expanded tools share one parameter table and one token column across the block.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { SEP, ink } from "../_lib/style.ts";
import { estimatedTokenField, tokenLabelLayout, type TokenLabelLayout } from "./metric-rows.ts";
import { singleLine, tildeAll, type ToolExpanded, type ToolField } from "./snapshot.ts";

function middleTruncatePath(text: string, width: number): string {
  if (text.length <= width) return text;
  const keep = width - 1;
  let tail = Math.min(Math.floor(keep * 0.5), 28);
  const slashIndex = text.lastIndexOf("/");
  if (slashIndex >= 0 && text.length - slashIndex <= Math.floor(keep * 0.6)) {
    tail = text.length - slashIndex;
  }
  const head = keep - tail;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

function wrapPlainText(text: string, width: number, maxLines: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const wrapped = wrapTextWithAnsi(normalized, width);
  if (wrapped.length <= maxLines) return wrapped;
  const capped = wrapped.slice(0, maxLines);
  const last = capped[maxLines - 1]!;
  // Reserve a column for the ellipsis so the capped line still fits `width`.
  capped[maxLines - 1] = last.length >= width ? `${last.slice(0, width - 1)}…` : `${last}…`;
  return capped;
}

type FieldColumns = { nameCol: number; typeCol: number; hasRequired: boolean };

const fieldIndent = (depth: number) => 6 + depth * 2;

// Share columns across all tools, not one ragged mini-table per tool.
function toolFieldColumns(fields: ToolField[]): FieldColumns {
  return {
    nameCol: Math.min(30, Math.max(0, ...fields.map((field) => fieldIndent(field.depth) + field.name.length))),
    typeCol: Math.min(10, Math.max(0, ...fields.map((field) => field.type.length))),
    hasRequired: fields.some((field) => field.required),
  };
}

function renderToolFieldRows(fields: ToolField[], theme: Theme, width: number, columns: FieldColumns): string[] {
  if (fields.length === 0) return [`      ${theme.fg("dim", "(no parameters)")}`];
  const { nameCol, typeCol, hasRequired } = columns;
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

// Keep names bold and tokens right-aligned. Provenance gives way before the name.
function renderExpandedToolHeader(tool: ToolExpanded, tokenLayout: TokenLabelLayout, theme: Theme, width: number): string {
  const maxWidth = Math.max(40, width);
  const indent = "    ";
  const gap = 2;
  const token = estimatedTokenField(tool.tokens, tokenLayout);
  const labelWidth = Math.max(12, maxWidth - indent.length - gap - tokenLayout.fieldWidth);
  const name = middleTruncatePath(tool.name, labelWidth);
  const sourceRoom = labelWidth - name.length - SEP.length;
  const source = tool.source && sourceRoom >= 8 ? middleTruncatePath(tildeAll(tool.source), sourceRoom) : "";
  const plainLabel = source ? `${name}${SEP}${source}` : name;
  const used = indent.length + plainLabel.length + tokenLayout.fieldWidth;
  const styled = `${theme.fg("text", theme.bold(name))}${source ? theme.fg("dim", `${SEP}${source}`) : ""}`;
  return `${indent}${styled}${" ".repeat(Math.max(gap, maxWidth - used))}${ink(theme, "accent", token)}`;
}

export function renderExpandedToolsBlock(content: { notes: string[]; tools: ToolExpanded[] }, theme: Theme, width: number): string[] {
  const out: string[] = [];
  const tokenLayout = tokenLabelLayout(content.tools.map((tool) => tool.tokens));
  const allFields = content.tools.flatMap((tool) => tool.fields);
  const columns = toolFieldColumns(allFields);
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

// Suppressing pi's Ctrl+T status line (design language §9.11).
//
// pi's toggleThinkingBlockVisibility appends a dim "Thinking blocks: hidden/visible"
// status pair (Spacer + Text) to the chat tail — a holdover from when the toggle's only
// visible effect was each thinking block collapsing to a label. With traceline loaded
// the flip is self-evident (every tool row collapses to a trace line or expands back),
// so the label is redundant noise; drop the pair inside the requestRender that
// announces it, before it ever reaches the screen. Other showStatus messages
// ("Forked to new session", …) are announcements of otherwise-invisible actions and
// pass through untouched.
import { stripAnsi } from "../_lib/ansi.ts";

const THINKING_TOGGLE_STATUS = /^Thinking blocks: (?:hidden|visible)$/;

// Pi 0.99 builds the status line lazily (ThemedText: `text` stays empty until the first
// render and `build()` supplies it), so the duck type reads the builder when the stored
// text is still blank.
export function isThinkingToggleStatusRow(comp: unknown): boolean {
  if (!comp || typeof comp !== "object") return false;
  // SAFETY: duck-typed pi-tui Text; every field is checked before use.
  const row = comp as { text?: unknown; setText?: unknown; build?: unknown };
  if (typeof row.text !== "string" || typeof row.setText !== "function") return false;
  let text = row.text;
  if (text.length === 0 && typeof row.build === "function") {
    try {
      const built: unknown = row.build.call(row);
      if (typeof built === "string") text = built;
    } catch {
      return false; // Pi seam: a builder that throws is not the status line
    }
  }
  return THINKING_TOGGLE_STATUS.test(stripAnsi(text).trim());
}

// pi's showStatus pairs the Text with a one-line Spacer; drop that too so no stray
// blank line accumulates at the chat tail.
export function isSpacerRow(comp: unknown): boolean {
  if (!comp || typeof comp !== "object") return false;
  // SAFETY: duck-typed pi-tui Spacer; every field is checked before use.
  const row = comp as { lines?: unknown; setLines?: unknown };
  return typeof row.setLines === "function" && typeof row.lines === "number" && !("text" in comp);
}

/** Drop the trailing status pair from the chat's children, if that is what ends them. */
export function suppressThinkingToggleStatus(sibs: unknown[] | undefined): boolean {
  if (!sibs || sibs.length === 0 || !isThinkingToggleStatusRow(sibs[sibs.length - 1])) return false;
  sibs.pop();
  if (sibs.length > 0 && isSpacerRow(sibs[sibs.length - 1])) sibs.pop();
  return true;
}

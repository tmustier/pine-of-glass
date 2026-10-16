import { Spacer, Text } from "@earendil-works/pi-tui";
import { stripAnsi } from "../_lib/ansi.ts";

/** Drop Pi's redundant Ctrl+T announcement, preserving other status messages (§9.11). */
export function suppressThinkingToggleStatus(children: unknown[] | undefined): boolean {
  if (!children) return false;
  const tail = children.at(-1);
  // Rendering also resolves Pi's lazy ThemedText without reaching into its private builder.
  if (!(tail instanceof Text) || !/^Thinking blocks: (?:hidden|visible)$/.test(stripAnsi(tail.render(80).join("\n")).trim())) return false;
  children.pop();
  if (children.at(-1) instanceof Spacer) children.pop();
  return true;
}

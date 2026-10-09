import type { Component, TUI } from "@earendil-works/pi-tui";
import { ThemedText, resolveText, type TextContent } from "./themed-text.ts";

/** A mounted widget whose changing clock text never changes its position in Pi's widget map. */
export class LiveWidget implements Component {
  private readonly text = new ThemedText("");
  private line = "";
  private readonly tui: Pick<TUI, "requestRender">;

  constructor(tui: Pick<TUI, "requestRender">) {
    this.tui = tui;
  }

  setLine(content: TextContent): void {
    const line = resolveText(content);
    this.text.setText(content);
    if (line === this.line) return;
    this.line = line;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

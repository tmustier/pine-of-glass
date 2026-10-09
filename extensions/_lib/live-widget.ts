import type { Component, TUI } from "@earendil-works/pi-tui";
import { ThemedText, type TextContent } from "./themed-text.ts";

/** A mounted widget whose changing clock text never changes its position in Pi's widget map. */
export class LiveWidget implements Component {
  private readonly text = new ThemedText("");
  private readonly tui: Pick<TUI, "requestRender">;

  constructor(tui: Pick<TUI, "requestRender">) {
    this.tui = tui;
  }

  setLine(content: TextContent): void {
    const previous = this.text.getText();
    this.text.setText(content);
    if (this.text.getText() !== previous) this.tui.requestRender();
  }

  render(width: number): string[] {
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

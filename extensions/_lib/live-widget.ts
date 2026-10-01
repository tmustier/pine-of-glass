import { Text, type Component, type TUI } from "@earendil-works/pi-tui";

/** A mounted widget whose changing clock text never changes its position in Pi's widget map. */
export class LiveWidget implements Component {
  private readonly text = new Text("", 1, 0);
  private line = "";
  private readonly tui: Pick<TUI, "requestRender">;

  constructor(tui: Pick<TUI, "requestRender">) {
    this.tui = tui;
  }

  setLine(line: string): void {
    if (line === this.line) return;
    this.line = line;
    this.text.setText(line);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    return this.line === "" ? [] : this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

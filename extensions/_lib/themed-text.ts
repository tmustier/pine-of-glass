import { Text } from "@earendil-works/pi-tui";

export type TextContent = string | (() => string);

/** Retains facts and reapplies their ink when Pi invalidates the component. */
export class ThemedText extends Text {
  private content: TextContent;
  private resolved?: string;

  constructor(content: TextContent) {
    super("", 1, 0);
    this.content = content;
  }

  override setText(content: TextContent): void {
    this.content = content;
    this.invalidate();
  }

  getText(): string {
    if (this.resolved === undefined) {
      this.resolved = typeof this.content === "string" ? this.content : this.content();
      super.setText(this.resolved);
    }
    return this.resolved;
  }

  override render(width: number): string[] {
    this.getText();
    return super.render(width);
  }

  override invalidate(): void {
    this.resolved = undefined;
    super.invalidate();
  }
}

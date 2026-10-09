import { Text } from "@earendil-works/pi-tui";

/** A fixed fact or a renderer that applies the current theme to fixed facts. */
export type TextContent = string | (() => string);

export function resolveText(content: TextContent): string {
  return typeof content === "string" ? content : content();
}

/** Pi invalidates components on theme changes; reapply ink before laying out text. */
export class ThemedText extends Text {
  private content: TextContent;
  private resolved = false;

  constructor(content: TextContent) {
    super("", 1, 0);
    this.content = content;
  }

  override setText(content: TextContent): void {
    this.content = content;
    this.invalidate();
  }

  override render(width: number): string[] {
    if (!this.resolved) {
      super.setText(resolveText(this.content));
      this.resolved = true;
    }
    return super.render(width);
  }

  override invalidate(): void {
    this.resolved = false;
    super.invalidate();
  }
}

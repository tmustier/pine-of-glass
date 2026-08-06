import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

export function captureTui(ui: ExtensionUIContext, key: string, onCapture: (tui: TUI) => void): void {
  ui.setWidget(key, (tui) => {
    onCapture(tui);
    return { render: () => [], invalidate() {} };
  });
  ui.setWidget(key, undefined);
}

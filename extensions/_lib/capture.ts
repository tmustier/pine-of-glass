// Shared one-shot TUI capture: pi passes the live TUI synchronously to a widget
// factory; grab it, then remove the throwaway widget so nothing is rendered.

interface WidgetHost {
  setWidget(key: string, factory: unknown): void;
}

export function captureTui(ui: WidgetHost, key: string, onCapture: (tui: unknown) => void): void {
  ui.setWidget(key, (tui: unknown) => {
    onCapture(tui);
    return { render: () => [] as string[], invalidate: () => {} };
  });
  ui.setWidget(key, undefined);
}

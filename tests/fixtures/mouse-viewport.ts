import { TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";

export function mouseViewport() {
  let onInput!: (data: string) => void;
  const noop = () => {};
  const terminal: Terminal = {
    columns: 80, rows: 24, kittyProtocolActive: false,
    start: (input) => { onInput = input; }, stop: noop, drainInput: async () => {},
    write: noop, moveBy: noop, hideCursor: noop, showCursor: noop, clearLine: noop,
    clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop,
  };
  class Viewport extends TuiAltScreen { paint() { this.doRender(); } }
  const urls: string[] = [];
  const view = new Viewport(terminal, false, undefined, { openUrl: (url) => urls.push(url), copyOnSelect: false });
  return {
    view,
    urls,
    sendInput: (data: string) => onInput(data),
    mouse: (button: number, x: number, y: number, release = false) =>
      onInput(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`),
  };
}

// SGR filtering for borrowed native rows (design language §9.6): drop the backgrounds pi
// paints behind a call, drop the foregrounds of the verb cell before re-inking it, and
// demote spans a native renderer left unstyled to the family's dim apparatus grey.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ink } from "../_lib/style.ts";

function filterSgrParams(
  text: string,
  shouldDrop: (n: number, params: string[], index: number) => number | undefined,
): string {
  return text.replace(/\x1b\[([0-9;]*)m/g, (_seq, rawParams: string) => {
    const params = rawParams === "" ? ["0"] : rawParams.split(";");
    const kept: string[] = [];
    for (let i = 0; i < params.length; i++) {
      const n = Number(params[i]);
      const skipTo = shouldDrop(n, params, i);
      if (skipTo !== undefined) {
        i = skipTo;
        continue;
      }
      kept.push(params[i]);
    }
    return kept.length ? `\x1b[${kept.join(";")}m` : "";
  });
}

export function stripSgrBackgrounds(text: string): string {
  return filterSgrParams(text, (n, params, i) => {
    if (n === 48) {
      const mode = Number(params[i + 1]);
      if (mode === 2) return i + 4; // 48;2;r;g;b
      if (mode === 5) return i + 2; // 48;5;n
      return i;
    }
    if (n === 49 || (n >= 40 && n <= 47) || (n >= 100 && n <= 107)) return i;
    return undefined;
  });
}

export function stripSgrForegrounds(text: string): string {
  return filterSgrParams(text, (n, params, i) => {
    if (n === 38) {
      const mode = Number(params[i + 1]);
      if (mode === 2) return i + 4; // 38;2;r;g;b
      if (mode === 5) return i + 2; // 38;5;n
      return i;
    }
    if (n === 39 || (n >= 30 && n <= 37) || (n >= 90 && n <= 97)) return i;
    return undefined;
  });
}

// No plain ink in native rows (design language §9.6): every span a native renderer
// leaves unstyled would render at the terminal default — prose ink inside a trace row,
// the §9.3 problem alive on grep/web_search/fetch/mcp rows. Demote such spans to
// L3-dim; spans with a deliberate foreground, and bold/faint-only spans (§9.3's
// white), pass through untouched. OSC sequences (hyperlinks, zone marks) are copied
// verbatim and never counted as text. The theme getter is passed in so the family's
// theme-derived ink (§3) applies after session_start.
const SGR_OR_OSC = /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function dimUnstyledSpans(line: string, theme?: Theme): string {
  let out = "";
  let last = 0;
  let fg = false;
  let weight = false;
  const emit = (text: string) => {
    if (!text) return;
    out += fg || weight || !/\S/.test(text) ? text : ink(theme, "dim", text);
  };
  SGR_OR_OSC.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_OR_OSC.exec(line))) {
    emit(line.slice(last, match.index));
    out += match[0];
    last = match.index + match[0].length;
    const rawParams = match[1];
    if (rawParams === undefined) continue; // OSC: no SGR state change
    const params = rawParams === "" ? ["0"] : rawParams.split(";");
    for (let i = 0; i < params.length; i++) {
      const n = Number(params[i]);
      if (n === 0) {
        fg = false;
        weight = false;
      } else if (n === 1 || n === 2) weight = true;
      else if (n === 22) weight = false;
      else if (n === 39) fg = false;
      else if (n === 38) {
        fg = true;
        i += Number(params[i + 1]) === 2 ? 4 : 2; // 38;2;r;g;b / 38;5;n
      } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) fg = true;
    }
  }
  emit(line.slice(last));
  return out;
}

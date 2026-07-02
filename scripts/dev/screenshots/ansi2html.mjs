#!/usr/bin/env node
// ANSI (SGR) → HTML for README screenshots. Faithful where freeze/termshot are not:
// dim (SGR 2) renders at reduced opacity, reverse (SGR 7) swaps fg/bg, and 39/49/22
// resets behave like a real terminal. Truecolor and the xterm-256 palette map exactly.
//
// Usage: node ansi2html.mjs <capture.txt> [--title "pi"] [--out out.html] [--cols 120]
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const title = flag("title", "");
const out = flag("out", input.replace(/\.[^.]+$/, "") + ".html");
const cols = Number(flag("cols", "0"));

// Default dark-terminal palette (xterm 16) tuned to look like pi's default theme host.
const BASE16 = [
  "#1a1b26", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
  "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#ffffff",
];
const CUBE = [0, 95, 135, 175, 215, 255];
function xterm256(n) {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const i = n - 16;
    const r = CUBE[Math.floor(i / 36)], g = CUBE[Math.floor(i / 6) % 6], b = CUBE[i % 6];
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  const v = 8 + (n - 232) * 10;
  return `#${[v, v, v].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

const DEFAULT_FG = "#c8cad0";
const DEFAULT_BG = "#15161c";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Terminals (Ghostty, iTerm2, kitty) draw block/box-drawing glyphs to fill the whole
// cell, so vertical rails connect across lines. Fonts only span their em box, which at
// line-height 1.45 leaves gaps — the rail looks disjointed. Emulate the terminal: draw
// these glyphs as full-line-height (1lh) CSS blocks in currentColor instead.
const CELL_GLYPHS = {
  "\u258f": "linear-gradient(to right,currentColor 0 12.5%,transparent 12.5%)", // ▏ left one-eighth
  "\u2502": "linear-gradient(to right,transparent 0 calc(50% - .5px),currentColor calc(50% - .5px) calc(50% + .5px),transparent calc(50% + .5px))", // │ light vertical
};
const cellGlyphHtml = (bg) =>
  `<span style="display:inline-block;width:1ch;height:1lh;vertical-align:top;background:${bg}"></span>`;
const renderGlyphs = (escaped) =>
  escaped.replace(/[\u258f\u2502]/g, (ch) => cellGlyphHtml(CELL_GLYPHS[ch]));

function render(text) {
  const state = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, reverse: false };
  let html = "";
  const openSpan = () => {
    let fg = state.fg ?? DEFAULT_FG;
    let bg = state.bg;
    if (state.reverse) [fg, bg] = [bg ?? DEFAULT_BG, fg];
    const css = [];
    if (fg !== DEFAULT_FG || bg) css.push(`color:${fg}`);
    if (bg) css.push(`background:${bg}`);
    if (state.bold) css.push("font-weight:700");
    if (state.dim) css.push("opacity:0.62");
    if (state.italic) css.push("font-style:italic");
    if (state.underline) css.push("text-decoration:underline");
    return css.length ? `<span style="${css.join(";")}">` : "<span>";
  };
  for (const rawLine of text.split("\n")) {
    // reset per line: tmux capture re-opens attributes each line
    Object.assign(state, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, reverse: false });
    let lineHtml = "";
    let visible = 0;
    const re = /\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][B0]|\r/g;
    let last = 0;
    let m;
    const emit = (chunk) => {
      if (!chunk) return;
      if (cols > 0 && visible + chunk.length > cols) chunk = chunk.slice(0, Math.max(0, cols - visible));
      if (!chunk) return;
      visible += chunk.length;
      lineHtml += openSpan() + renderGlyphs(esc(chunk)) + "</span>";
    };
    while ((m = re.exec(rawLine))) {
      emit(rawLine.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] === undefined) continue; // OSC / charset / CR: swallow
      const parts = (m[1] === "" ? "0" : m[1]).split(";").map(Number);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p === 0) Object.assign(state, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, reverse: false });
        else if (p === 1) state.bold = true;
        else if (p === 2) state.dim = true;
        else if (p === 3) state.italic = true;
        else if (p === 4) state.underline = true;
        else if (p === 7) state.reverse = true;
        else if (p === 22) { state.bold = false; state.dim = false; }
        else if (p === 23) state.italic = false;
        else if (p === 24) state.underline = false;
        else if (p === 27) state.reverse = false;
        else if (p >= 30 && p <= 37) state.fg = BASE16[p - 30];
        else if (p >= 90 && p <= 97) state.fg = BASE16[p - 90 + 8];
        else if (p === 39) state.fg = null;
        else if (p >= 40 && p <= 47) state.bg = BASE16[p - 40];
        else if (p >= 100 && p <= 107) state.bg = BASE16[p - 100 + 8];
        else if (p === 49) state.bg = null;
        else if (p === 38 || p === 48) {
          const target = p === 38 ? "fg" : "bg";
          if (parts[i + 1] === 5) { state[target] = xterm256(parts[i + 2]); i += 2; }
          else if (parts[i + 1] === 2) {
            state[target] = `#${parts.slice(i + 2, i + 5).map((v) => (v || 0).toString(16).padStart(2, "0")).join("")}`;
            i += 4;
          }
        }
      }
    }
    emit(rawLine.slice(last));
    html += lineHtml + "\n";
  }
  return html;
}

const body = render(readFileSync(input, "utf8").replace(/\n+$/, ""));
writeFileSync(
  out,
  `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#0b0c10;}
  .frame{display:inline-block;background:${DEFAULT_BG};border-radius:10px;padding:18px 22px 16px;margin:24px;
    box-shadow:0 12px 40px rgba(0,0,0,.55);border:1px solid #26283a;}
  .title{color:#5a5f78;font:500 12px/1 -apple-system,sans-serif;margin:0 0 12px 2px;display:flex;gap:8px;align-items:center;}
  .dots{display:flex;gap:6px;} .dots i{width:11px;height:11px;border-radius:50%;display:block;}
  pre{margin:0;font:13px/1.45 "JetBrains Mono","SF Mono",Menlo,monospace;color:${DEFAULT_FG};}
  </style><div class="frame"><div class="title"><span class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></span>${esc(title)}</div><pre>${body}</pre></div>`,
);
console.log(`wrote ${out}`);

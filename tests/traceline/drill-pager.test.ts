// The peek pager's fidelity surface (design language §9.13): a tool without a call
// renderer shows its complete arguments in the aligned key/value grammar; an image
// result block always shows its fact line and, on a capable terminal, atomic inline
// pixels that never render as a sliced escape sequence; kitty image ids are deleted on
// dispose. Rows are the same synthetic duck types the other suites use; the contract
// suite pins the real pi shapes (convertedImages, showImages, image result blocks).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getCapabilities, setCapabilities, type TUI } from "@earendil-works/pi-tui";

import { DrillPager } from "../../extensions/pi-traceline/drill-pager.ts";
import { argumentLines, codeContextFor, imageFactLine, textBlockLines } from "../../extensions/pi-traceline/drill-pager-content.ts";
import { internals } from "../../extensions/pi-traceline/index.ts";
import type { DrillHost, DrillState } from "../../extensions/pi-traceline/drill.ts";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";

const { setTracelineChat, stripAnsi, toolFactSuffix } = internals;

// A syntactically valid PNG header claiming the given dimensions; pi-tui reads only the
// header for dimensions and embeds the payload opaquely, so the body can be padding.
function pngBase64(widthPx: number, heightPx: number, padBytes = 64): string {
  const buffer = Buffer.alloc(24 + padBytes);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12);
  buffer.writeUInt32BE(widthPx, 16);
  buffer.writeUInt32BE(heightPx, 20);
  return buffer.toString("base64");
}

function imageRow(overrides: Partial<ToolRowLike> = {}): ToolRowLike {
  return {
    toolName: "read",
    args: { path: "/tmp/shot.png" },
    result: {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: pngBase64(100, 4000), mimeType: "image/png" },
      ],
      isError: false,
    },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    ...overrides,
  } as ToolRowLike;
}

function pagerFor(rows: ToolRowLike[], terminalRows = 16): DrillPager {
  const host: DrillHost = {
    ui: {} as DrillHost["ui"],
    theme: () => undefined,
    chatChildren: () => rows,
    requestRender: () => {},
    traceLines: () => ["trace line"],
    runRows: () => undefined,
    hiddenByFold: () => false,
    statusTone: () => "success",
    mouse: false,
  };
  const st: DrillState = { host, rows, numbers: new Map(), selected: 0, digits: "", mouseOn: false };
  const pager = new DrillPager(st);
  pager.attach({ terminal: { rows: terminalRows } } as unknown as TUI);
  return pager;
}

const originalCaps = getCapabilities();
beforeEach(() => setTracelineChat(undefined));
afterEach(() => {
  setCapabilities(originalCaps);
  setTracelineChat(undefined);
});

// --- invocation fidelity (§9.13: the arguments are the invocation) ----------------------

test("a tool without a call renderer shows its complete arguments, not a bare name", () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const note = "Renaming a session mid-run drops the sidebar selection.";
  const row = imageRow({
    toolName: "papercut",
    args: { note, context: "pine-of-glass", surface: "alt+t" },
    result: { content: [{ type: "text", text: "Recorded locally" }], isError: false },
  });
  delete (row as { callRendererComponent?: unknown }).callRendererComponent;
  const text = pagerFor([row])
    .render(80)
    .map((line) => stripAnsi(line))
    .join("\n");
  assert.match(text, /papercut/, "tool name still anchors the invocation");
  assert.ok(text.includes(`note     ${note}`), "argument keys pad to one aligned column");
  assert.ok(text.includes("context  pine-of-glass"), "every argument renders");
  assert.ok(text.includes("surface  alt+t"), "every argument renders");
});

test("argumentLines: wraps at the value column, JSON for nested values, [] for non-objects", () => {
  const lines = argumentLines(undefined, { key: "aaaa bbbb cccc dddd", nested: { a: 1 } }, 18).map((l) => stripAnsi(l));
  assert.equal(lines[0], "key     aaaa bbbb");
  assert.equal(lines[1], "        cccc dddd", "continuations hang at the value column");
  assert.equal(lines[2], 'nested  {');
  assert.match(lines[3]!, /"a": 1/, "nested objects render as indented JSON");
  assert.deepEqual(argumentLines(undefined, undefined, 80), []);
  assert.deepEqual(argumentLines(undefined, ["array"], 80), []);
  assert.deepEqual(argumentLines(undefined, {}, 80), []);
});

// --- code results (§9.13: code renders as code, ink-only) -------------------------------

test("codeContextFor claims code only when it is provable", () => {
  const row = (toolName: string, args: object) => ({ ...imageRow(), toolName, args }) as ToolRowLike;
  assert.deepEqual(codeContextFor(row("read", { path: "a/b.ts", offset: 40 })), { language: "typescript", nextLine: 40 });
  assert.deepEqual(codeContextFor(row("read", { path: "a/b.ts" })), { language: "typescript", nextLine: 1 });
  assert.equal(codeContextFor(row("read", { path: "notes.txt" })), undefined);
  assert.deepEqual(codeContextFor(row("bash", { command: "sed -n 1,120p dist/tool.js" })), {
    language: "javascript",
    nextLine: undefined,
  });
  assert.deepEqual(codeContextFor(row("bash", { command: "cat 'src/x.py'" })), { language: "python", nextLine: undefined });
  assert.equal(codeContextFor(row("bash", { command: "cat a.ts | head" })), undefined, "pipes are not provable");
  assert.equal(codeContextFor(row("bash", { command: "cat a.ts && rm b" })), undefined, "chains are not provable");
  assert.equal(codeContextFor(row("bash", { command: "echo x.ts" })), undefined, "only printers count");
  assert.equal(codeContextFor(row("papercut", { note: "x.ts" })), undefined);
});

test("code blocks: gutter counts from the offset, continuations hang with a blank gutter", () => {
  const code = { language: "typescript", nextLine: 98 };
  const text = "function alpha() {\n    return aaaa bbbb cccc dddd eeee ffff gggg hhhh;\n}\n\nconst z = 1;";
  const lines = textBlockLines(undefined, text, 40, code).map((line) => stripAnsi(line));
  assert.equal(lines[0], " 98  function alpha() {");
  assert.equal(lines[1], " 99      return aaaa bbbb cccc dddd", "numbers right-align in one gutter column");
  assert.equal(lines[2], "          eeee ffff gggg hhhh;", "continuation keeps a blank gutter and hangs under the indent");
  assert.equal(lines[3], "100  }");
  assert.equal(lines[4], "101", "blank lines stay counted");
  assert.equal(lines[5], "102  const z = 1;");
  assert.equal(code.nextLine, 103, "the counter advances across blocks of one call");
  const bashLines = textBlockLines(undefined, "const z = 1;", 40, { language: "typescript", nextLine: undefined });
  assert.equal(stripAnsi(bashLines[0]!), "const z = 1;", "a bash code result gets no gutter");
});

test("a code read renders through the pager with the language cell and gutter", () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const row = imageRow({
    toolName: "read",
    args: { path: "src/answer.ts", offset: 7 },
    result: { content: [{ type: "text", text: "const answer = 42;" }], isError: false },
  });
  const text = pagerFor([row]).render(80).map((line) => stripAnsi(line)).join("\n");
  assert.match(text, /result · success · 0\.0k ch · typescript/, "the result label names the claimed language");
  assert.match(text, /7  const answer = 42;/, "the gutter counts from the call's offset");
});

// --- image result blocks (§9.13: every block accounted for) -----------------------------

test("an image block always renders its fact line, even with no image capability", () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const fact = stripAnsi(imageFactLine(undefined, { type: "image", data: pngBase64(1044, 646), mimeType: "image/png" }));
  assert.match(fact, /^image · png · 1044×646 · 0\.1k bytes$/);
  const lines = pagerFor([imageRow()]).render(80).map((line) => stripAnsi(line));
  assert.ok(lines.some((line) => /image · png · 100×4000/.test(line)), "fact line present");
  assert.ok(!lines.some((line) => line.includes("scroll to view")), "no pixel block without capability");
});

test("inline pixels are atomic: partial visibility shows the hint, full visibility the image", () => {
  setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
  const pager = pagerFor([imageRow()]); // 16 terminal rows → 13-line viewport, tall image clamps below it
  const first = pager.render(80);
  const firstText = first.map((line) => stripAnsi(line)).join("\n");
  assert.match(firstText, /image · png · 100×4000/, "fact line above the block");
  assert.match(firstText, /\(image · scroll to view\)/, "partially visible block shows its hint");
  assert.ok(!first.some((line) => line.includes("\x1b]1337")), "no sliced escape sequence in a partial window");

  pager.scrollBy(Number.MAX_SAFE_INTEGER); // bottom: the clamped block now fits the window
  const settled = pager.render(80);
  assert.ok(settled.some((line) => line.includes("\x1b]1337")), "fully visible block renders the pixels");
  assert.ok(!settled.map((line) => stripAnsi(line)).join("\n").includes("scroll to view"), "hint yields to pixels");
});

test("showImages false suppresses pixels; kitty draws only PNG, reusing pi's conversions", () => {
  setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
  const off = pagerFor([imageRow({ showImages: false })]).render(80).map((line) => stripAnsi(line)).join("\n");
  assert.match(off, /image · png/, "the fact line stays");
  assert.ok(!off.includes("scroll to view"), "no pixel block when pi's showImages is off");

  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  const jpeg = { type: "image", data: pngBase64(100, 4000), mimeType: "image/jpeg" };
  const unconverted = imageRow({ result: { content: [jpeg], isError: false } });
  const kittyOff = pagerFor([unconverted]).render(80).map((line) => stripAnsi(line)).join("\n");
  assert.ok(!kittyOff.includes("scroll to view"), "kitty without a PNG conversion keeps the fact line only");

  const converted = imageRow({
    result: { content: [jpeg], isError: false },
    convertedImages: new Map([[0, { data: pngBase64(100, 4000), mimeType: "image/png" }]]),
  });
  const pager = pagerFor([converted]);
  pager.render(80);
  pager.scrollBy(Number.MAX_SAFE_INTEGER);
  const settled = pager.render(80);
  assert.ok(settled.some((line) => line.includes("\x1b_G")), "pi's converted PNG renders through kitty");

  // Dispose deletes every kitty id the pager allocated (§9.13 bounded lifecycle).
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    pager.dispose();
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.ok(writes.some((chunk) => chunk.includes("a=d")), "dispose emits the kitty delete sequence");
});

// --- the trace row's image what-fact (§9.7) ---------------------------------------------

test("an image-bearing read wears `png W×H` in the size cell's berth, dim", () => {
  const row = imageRow();
  setTracelineChat({ children: [row] });
  assert.equal(stripAnsi(toolFactSuffix(row)), "png 100×4000");
  const multi = imageRow({
    result: {
      content: [
        { type: "image", data: pngBase64(2, 2), mimeType: "image/png" },
        { type: "image", data: pngBase64(4, 4), mimeType: "image/png" },
      ],
      isError: false,
    },
  });
  setTracelineChat({ children: [multi] });
  assert.equal(stripAnsi(toolFactSuffix(multi)), "2 images");
});

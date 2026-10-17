// Notice rows (design language §9.15) against the installed Pi: a custom message or
// custom entry row is one trace line with reasoning hidden, the extension's own block
// at z1/z2, and a block member between tool rows.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  CustomMessageComponent,
  ToolExecutionComponent,
  createReadTool,
  initTheme,
  keyText,
  type Theme,
  type CustomEntry,
  type EntryRenderer,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { isNoticeRow, type NoticeRowLike, type NoticeRowPrototypeLike, type ToolRowLike } from "../../extensions/_lib/chat.ts";
import { internals as trace } from "../../extensions/pi-traceline/index.ts";
import type { TraceMousePrototype } from "../../extensions/pi-traceline/click.ts";
import { installNoticeRows, type NoticeRowHost } from "../../extensions/pi-traceline/notice-rows.ts";
import { assistantBefore } from "../traceline/runtime-fixtures.ts";

initTheme(undefined, false);
const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
// SAFETY: contract probes of installed Pi modules the package root does not re-export:
// the live theme instance, and CustomEntryComponent next to the exported message one.
const { theme } = await import(pathToFileURL(join(piRoot, "dist/modes/interactive/theme/theme.js")).href) as { theme: Theme };
const { CustomEntryComponent } = await import(pathToFileURL(join(piRoot, "dist/modes/interactive/components/custom-entry.js")).href) as {
  CustomEntryComponent: new (entry: CustomEntry, renderer: EntryRenderer, outputPad?: number) => Container & { setExpanded(expanded: boolean): void };
};

type CustomMessage = ConstructorParameters<typeof CustomMessageComponent>[0];

// SAFETY: the contract under test is that pi's component prototypes are patchable in
// the shape index.ts assumes; the tool-row patch takes the same route.
trace.patchToolRowPrototype(ToolExecutionComponent.prototype as unknown as TraceMousePrototype);
// The host index.ts builds from its private row grammar, rebuilt here from the
// internals it exposes; `hidden` mirrors the assistant fixture's reasoning state.
let hidden = true;
let liveChat: { children: unknown[] } | undefined;
const host: NoticeRowHost = {
  theme: () => theme,
  compact: () => hidden,
  drillActive: () => false,
  railPrefix: (bullet) => `  ${theme.fg("dim", "▏")} ${bullet} `,
  available: (width) => width - 6 - 2,
  charSuffix: (chars) => trace.charSuffix(chars),
  leadingBlank: (row) => trace.leadingBlank(row),
  changed: () => { trace.resetRenderCache(); if (liveChat) liveChat.children = [...liveChat.children]; },
};
// SAFETY: as above, the prototypes are the real classes; the type only names the seam.
installNoticeRows(CustomMessageComponent.prototype as unknown as NoticeRowPrototypeLike, host);
installNoticeRows(CustomEntryComponent.prototype as unknown as NoticeRowPrototypeLike, host);
trace.setTracelineThemeGetter(() => theme);
afterEach(() => { trace.setTracelineChat(undefined); trace.resetRenderCache(); hidden = true; });

let nextCallId = 0;
function toolRow(path: string) {
  const definition = {
    ...createReadTool("/tmp"),
    renderCall: () => new Text(`read ${path}`, 0, 0),
    renderResult: () => new Text("OUTPUT", 0, 0),
  };
  const comp = new ToolExecutionComponent("read", `call-${nextCallId++}`, { path }, {}, definition, { requestRender() {} } as never, "/tmp");
  comp.updateResult({ content: [{ type: "text", text: "x".repeat(2_000) }], isError: false });
  return comp;
}
function message(customType: string, text: string, details?: unknown): CustomMessage {
  return { role: "custom", customType, content: [{ type: "text", text }], display: true, details, timestamp: Date.now() };
}
// An extension renderer in the shape pi-subagents and pi's own [skill] block use: a
// bold label on the label colour, a status word in warning ink, the key hint collapsed.
function labelledRenderer(label: string, headline: string, status: string, body: string) {
  return (_message: unknown, options: { expanded: boolean }, t: Theme) => {
    const title = `${t.fg("customMessageLabel", t.bold(`[${label}]`))} ${t.fg("customMessageText", headline)}${t.fg("warning", status)}`;
    const lines = options.expanded ? [title, "", body] : [`${title} ${t.fg("dim", `(${keyText("app.tools.expand")} to expand)`)}`];
    return new Text(lines.join("\n"), 1, 1);
  };
}
function chat(children: unknown[], reasoningHidden = true) {
  hidden = reasoningHidden;
  const container = new Container();
  const tools = children.filter((c): c is ToolExecutionComponent => c instanceof ToolExecutionComponent);
  // SAFETY: real ToolExecutionComponents; the fixture type names the duck-typed seam.
  liveChat = { children: [assistantBefore(tools as unknown as ToolRowLike[], [], reasoningHidden), ...children] };
  trace.setTracelineChat(liveChat);
  for (const child of children) container.addChild(child as never);
  return container;
}
function asNotice(component: CustomMessageComponent): NoticeRowLike {
  const candidate: unknown = component;
  assert.ok(isNoticeRow(candidate));
  return candidate;
}
function painted(container: Container, width = 80): string[] { return container.render(width).map(trace.stripAnsi); }
function click(container: Container, text: string, x = 10, width = 80) {
  const lines = painted(container, width);
  const y = lines.findIndex((line) => line.includes(text));
  assert.ok(y >= 0, `missing ${text} in\n${lines.join("\n")}`);
  const event: TuiMouseEvent = { type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: lines.length, shift: false, alt: false, ctrl: false };
  return container.handleMouse(event);
}

test("pi's custom message and entry components are notice rows; tool and assistant rows are not", () => {
  const msg = new CustomMessageComponent(message("my-extension", "hello"), undefined);
  const entry = new CustomEntryComponent({ type: "custom", customType: "my-entry", data: {}, id: "e1", parentId: null, timestamp: "" }, () => new Text("entry", 0, 0));
  assert.ok(isNoticeRow(entry), "CustomEntryComponent must satisfy isNoticeRow");
  assert.ok(!isNoticeRow(toolRow("/a.txt")));
  assert.ok(!isNoticeRow(assistantBefore([], [], true)));
  // The expansion flag Traceline reads is the one setExpanded() writes.
  const seam = asNotice(msg);
  assert.equal(seam._expanded, false);
  msg.setExpanded(true);
  assert.equal(seam._expanded, true);
});

test("a message with an extension renderer reads as the renderer's own collapsed line, status ink kept, hint and background dropped", () => {
  const renderer = labelledRenderer("subagent", "worker ", "needs a decision", "Full question text");
  const msg = new CustomMessageComponent(message("subagent-supervisor-request", "# Worker asks\n\nlong body"), renderer, undefined, 1);
  const c = chat([toolRow("/src/a.ts"), msg, toolRow("/src/b.ts")]);
  const raw = c.render(80);
  const lines = raw.map(trace.stripAnsi);
  const row = lines.findIndex((line) => line.includes("[subagent] worker needs a decision"));
  assert.ok(row >= 0, lines.join("\n"));
  assert.ok(!lines[row]!.includes("to expand"), "the key hint is not part of the trace line");
  assert.ok(lines[row]!.startsWith("  ▏ › [subagent]"), `rail, bullet, then the label: ${JSON.stringify(lines[row])}`);
  const warning = theme.fg("warning", "x");
  assert.ok(raw[row]!.includes(`${warning.slice(0, warning.indexOf("x"))}needs a decision`), "the author's warning ink survives");
  assert.ok(!raw[row]!.includes(theme.bg("customMessageBg", "")), "the block background does not");
  assert.ok(!raw[row]!.includes(theme.fg("customMessageText", "worker ")), "non-status foregrounds demote");
  // A compact notice is a block member: no blank line on either side, and the tool
  // rows keep one fused block with one blank line in front.
  const blanks = lines.map((line, i) => [line.trim(), i] as const).filter(([line]) => line === "").map(([, i]) => i);
  assert.deepEqual(blanks, [0], `one blank before the block only:\n${lines.join("\n")}`);
  assert.ok(lines[row - 1]!.includes("a.ts") && lines[row + 1]!.includes("b.ts"));
});

test("pi's default rendering yields [customType] plus the first meaningful content line, with the char cell", () => {
  const text = "## Deploy finished\n\n**api-gateway** is live.\n" + "detail ".repeat(400);
  const msg = new CustomMessageComponent(message("deploy-bot", text), undefined);
  const c = chat([toolRow("/src/a.ts"), msg]);
  const lines = painted(c, 80);
  const row = lines.find((line) => line.includes("[deploy-bot]"));
  assert.ok(row, lines.join("\n"));
  assert.match(row, /\[deploy-bot\] Deploy finished\s+2\.8k ch$/);
});

test("details.summary wins over both the renderer and the content", () => {
  const renderer = labelledRenderer("subagent", "worker ", "completed", "body");
  const msg = new CustomMessageComponent(message("subagent-notify", "# Result", { summary: "worker finished the audit" }), renderer);
  const lines = painted(chat([msg]));
  assert.ok(lines.some((line) => line.includes("[subagent-notify] worker finished the audit")), lines.join("\n"));
});

test("a custom entry is a notice row with no char cell; its renderer line is the headline", () => {
  const renderer = (_entry: unknown, options: { expanded: boolean }, t: Theme) =>
    new Text(options.expanded ? `${t.bold("[subagent]")} reply sent to worker\n\nRequest: 1\n\nGo ahead.` : `${t.bold("[subagent]")} reply sent to worker ${t.fg("dim", "(click to expand)")}`, 1, 1);
  const entry = new CustomEntryComponent({ type: "custom", customType: "subagent-supervisor-reply", data: { message: "Go ahead." }, id: "e2", parentId: null, timestamp: "" }, renderer);
  const c = chat([toolRow("/src/a.ts"), entry, toolRow("/src/b.ts")]);
  const lines = painted(c);
  const row = lines.find((line) => line.includes("reply sent to worker"));
  assert.ok(row, lines.join("\n"));
  assert.ok(!row.trimEnd().endsWith("ch"), `an entry has no model-facing text: ${JSON.stringify(row)}`);
  assert.ok(!row.includes("to expand"));
});

test("click opens the extension's block at z1 and breaks the trace block; a click on the block collapses it", () => {
  const renderer = labelledRenderer("subagent", "worker ", "needs a decision", "Full question text");
  const msg = new CustomMessageComponent(message("subagent-supervisor-request", "body"), renderer);
  const seam = asNotice(msg);
  const c = chat([toolRow("/src/a.ts"), msg, toolRow("/src/b.ts")]);
  assert.ok(click(c, "needs a decision")?.handled);
  assert.equal(seam._expanded, true);
  let lines = painted(c);
  assert.ok(lines.some((line) => line.includes("Full question text")), `z1 shows the renderer's expanded block:\n${lines.join("\n")}`);
  const after = lines.findIndex((line) => line.includes("b.ts"));
  assert.equal(lines[after - 1]!.trim(), "", "the trace after an expanded notice starts with its own blank line");
  assert.ok(click(c, "Full question text")?.handled);
  assert.equal(seam._expanded, false);
  lines = painted(c);
  assert.ok(!lines.some((line) => line.includes("Full question text")));
});

test("Ctrl+O's global expansion and margins behave like tool rows; with reasoning visible the native block is untouched", () => {
  const renderer = labelledRenderer("subagent", "worker ", "completed", "Result body");
  const msg = new CustomMessageComponent(message("subagent-notify", "body"), renderer);
  const c = chat([toolRow("/src/a.ts"), msg]);
  const compact = painted(c);
  assert.equal(c.handleMouse({ type: "click", button: "left", x: 0, y: compact.length - 1, screenX: 0, screenY: 0, width: 80, height: compact.length, shift: false, alt: false, ctrl: false }), undefined, "the left margin is not a hit area");
  msg.setExpanded(true); // what pi's setToolsExpanded does to every expandable child
  assert.ok(painted(c).some((line) => line.includes("Result body")));
  msg.setExpanded(false);

  const visible = chat([toolRow("/src/a.ts"), msg], false);
  const rendered = visible.render(80);
  const reference = new CustomMessageComponent(message("subagent-notify", "body"), renderer).render(80);
  assert.ok(reference.some((line) => line.includes("[subagent]")));
  assert.deepEqual(rendered.slice(rendered.length - reference.length), reference, "z2 is pi's own rendering, byte for byte");
});

test("default headlines strip Markdown and skip empty lines and horizontal rules", () => {
  for (const [content, expected] of [
    ["\n\n## Deploy **finished**\n\nbody", "Deploy finished"],
    ["> - 1. `api-gateway` is [live](https://x)  now", "api-gateway is live now"],
    ["---\n\n   \nSecond paragraph", "Second paragraph"],
    ["\n  \n", ""],
  ] as const) {
    const msg = new CustomMessageComponent(message("notice", content), undefined);
    assert.equal(painted(chat([msg]))[1]?.trim(), `▏ › [notice]${expected ? ` ${expected}` : ""}`);
  }
});

test("empty or failing component renders fall back to message text", () => {
  for (const render of [() => [], () => ["  "], () => { throw new Error("renderer failed"); }]) {
    const msg = new CustomMessageComponent(message("notice", "fallback line"), () => ({ render, invalidate() {} }));
    assert.equal(painted(chat([msg]))[1]?.trim(), "▏ › [notice] fallback line");
  }
});

test("summary metadata is optional and only a non-empty string overrides the headline", () => {
  for (const details of [undefined, null, 42, "summary", { summary: 42 }, { summary: "  " }]) {
    const msg = new CustomMessageComponent(message("notice", "fallback line", details), undefined);
    assert.equal(painted(chat([msg]))[1]?.trim(), "▏ › [notice] fallback line");
  }
  const entry = new CustomEntryComponent({ type: "custom", customType: "notice", data: { summary: " saved\nthree  files " }, id: "e3", parentId: null, timestamp: "" }, () => new Text("ignored renderer", 0, 0));
  assert.equal(painted(chat([entry]))[1]?.trim(), "▏ › [notice] saved three files");
});

test("renderer headlines without a label use customType and only drop a trailing expand hint", () => {
  for (const [native, expected] of [
    ["saved 3 files (ctrl+o to expand)", "saved 3 files"],
    ["(ctrl+o to expand) is not a hint here", "(ctrl+o to expand) is not a hint here"],
  ] as const) {
    const msg = new CustomMessageComponent(message("notice", "ignored"), () => new Text(native, 0, 0));
    assert.equal(painted(chat([msg]))[1]?.trim(), `▏ › [notice] ${expected}`);
  }
});

test("message size counts string content and text blocks, not images or entry data", () => {
  const text = "x".repeat(200);
  const msg = message("notice", text);
  msg.content = text;
  assert.match(painted(chat([new CustomMessageComponent(msg, undefined)]))[1]!, /0\.2k ch$/);
  msg.content = [{ type: "text", text }, { type: "image", mimeType: "image/png", data: "" }, { type: "text", text }];
  assert.match(painted(chat([new CustomMessageComponent(msg, undefined)]))[1]!, /0\.4k ch$/);
  const entry = new CustomEntryComponent({ type: "custom", customType: "notice", data: text, id: "e4", parentId: null, timestamp: "" }, () => new Text("saved", 0, 0));
  assert.equal(painted(chat([entry]))[1]?.trim(), "▏ › [notice] saved");
});

for (const tone of ["success", "warning", "error"] as const) {
  test(`renderer ${tone} ink survives on the compact headline`, () => {
    const msg = new CustomMessageComponent(message("notice", "ignored"), (_message, _options, t) => new Text(t.fg(tone, "status"), 0, 0));
    const lines = chat([msg]).render(80);
    const sample = theme.fg(tone, "status");
    const opener = sample.slice(0, sample.indexOf("status"));
    assert.ok(lines.some((line) => line.includes(`${opener}status`)), lines.join("\n"));
  });
}

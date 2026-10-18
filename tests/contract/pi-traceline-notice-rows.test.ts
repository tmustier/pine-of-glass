import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { AssistantMessageComponent, CustomMessageComponent, ToolExecutionComponent, createReadTool, initTheme, type CustomEntry, type EntryRenderer, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { isNoticeRow } from "../../extensions/_lib/chat.ts";
import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { hostExtension, IsolatedProject, RecordedUi, type HostedExtension } from "../harness/extension-host.ts";
import { mouseViewport } from "../fixtures/mouse-viewport.ts";
import { handleThinkingToggleTerminalInput } from "../../extensions/pi-traceline/thinking-toggle.ts";
import { assistantMessage } from "../helpers.ts";
import noticeFixture from "../smoke/notice-extension.ts";

initTheme(undefined, false);
const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
// SAFETY: Pi does not export its live theme or CustomEntryComponent at the package root.
const { theme } = await import(pathToFileURL(join(piRoot, "dist/modes/interactive/theme/theme.js")).href) as { theme: Theme };
const { CustomEntryComponent } = await import(pathToFileURL(join(piRoot, "dist/modes/interactive/components/custom-entry.js")).href) as {
  CustomEntryComponent: new (entry: CustomEntry, renderer: EntryRenderer) => Container & { setExpanded(expanded: boolean): void };
};

const { view } = mouseViewport();
const chat = new Container();
const assistant = new AssistantMessageComponent(assistantMessage([]), true);
chat.addChild(assistant);
view.addChild(chat);
let project: IsolatedProject;
let hosted: HostedExtension;
let calls: Parameters<typeof assistantMessage>[0] = [];
before(async () => {
  project = new IsolatedProject();
  chat.addChild(read("/bootstrap.txt"));
  hosted = await hostExtension(noticeFixture, { project, ui: new RecordedUi(theme, view), noTools: "builtin" });
});
after(async () => {
  try { await hosted?.dispose(); }
  finally { view.stop(); project.dispose(); }
});
beforeEach(() => {
  calls = [];
  chat.clear();
  assistant.updateContent(assistantMessage([]));
  assistant.setHideThinkingBlock(true);
  chat.addChild(assistant);
});

function message(customType: string, content: ConstructorParameters<typeof CustomMessageComponent>[0]["content"], details?: unknown, renderer = hosted.session.extensionRunner.getMessageRenderer(customType)) {
  return new CustomMessageComponent({ role: "custom", customType, content, details, display: true, timestamp: 0 }, renderer);
}
function entry(data: unknown, renderer = hosted.session.extensionRunner.getEntryRenderer("fixture-reply")!) {
  return new CustomEntryComponent({ type: "custom", customType: "fixture-reply", data, id: "e1", parentId: null, timestamp: "" }, renderer);
}
function read(path: string) {
  const id = `call-${calls.length}`;
  calls.push({ type: "toolCall", id, name: "read", arguments: { path } });
  assistant.updateContent(assistantMessage(calls));
  const row = new ToolExecutionComponent("read", id, { path }, {}, createReadTool(project.dir), view, project.dir);
  row.updateResult({ content: [{ type: "text", text: "x".repeat(2_000) }], isError: false });
  return row;
}
function painted(...rows: Container[]): string[] {
  if (!chat.children.includes(assistant)) chat.addChild(assistant);
  for (const row of rows) chat.addChild(row);
  return chat.render(80).map(stripAnsi);
}

test("Pi notice detection and expansion flag match the installed components", () => {
  const msg = message("plain", "hello");
  const seam: unknown = msg;
  assert.ok(isNoticeRow(seam));
  assert.ok(isNoticeRow(entry({ message: "reply" })));
  assert.ok(!isNoticeRow(read("/a.txt")));
  assert.ok(!isNoticeRow(assistant));
  assert.equal(seam._expanded, false);
  msg.setExpanded(true);
  assert.equal(seam._expanded, true);
});

test("Ctrl+T collapses an expanded notice", () => {
  const msg = message("plain", "hello");
  const seam: unknown = msg;
  assert.ok(isNoticeRow(seam));
  chat.addChild(msg);
  msg.setExpanded(true);
  handleThinkingToggleTerminalInput("\x14", { getToolsExpanded: () => false, setToolsExpanded() {} }, () => chat.children);
  assert.equal(seam._expanded, false);
});

test("registered renderers retain status ink and lose block decoration inside a fused trace block", () => {
  painted(read("/src/a.ts"), message("fixture-request", "question"), read("/src/b.ts"));
  const raw = chat.render(80);
  const lines = raw.map(stripAnsi);
  assert.match(lines[1]!, /^  ▏ › read \/src\/a.ts\s+2\.0k ch$/);
  assert.equal(lines[2]?.trim(), "▏ › [fixture] worker needs a decision");
  assert.match(lines[3]!, /^  ▏ › read \/src\/b.ts\s+2\.0k ch$/);
  assert.equal(lines.filter((line) => line.trim() === "").length, 1);
  const notice = raw.find((line) => stripAnsi(line).includes("needs a decision"))!;
  const warning = theme.fg("warning", "needs a decision");
  assert.ok(notice.includes(warning.slice(0, warning.indexOf("needs a decision")) + "needs a decision"));
  assert.ok(!notice.includes(theme.bg("customMessageBg", "")));
  assert.ok(!notice.includes(theme.fg("customMessageText", "worker ")));
});

test("summary overrides rendering and content; entries never show a size cell", () => {
  assert.equal(painted(message("fixture-request", "# ignored", { summary: " saved\nthree  files " }))[1]?.trim(), "▏ › [fixture-request] saved three files");
  chat.clear();
  assert.equal(painted(entry({ summary: "saved three files", message: "x".repeat(5_000) }))[1]?.trim(), "▏ › [fixture-reply] saved three files");
});

test("default headlines strip Markdown and skip empty lines and horizontal rules", () => {
  for (const [content, expected] of [
    ["\n\n## Deploy **finished**\n\nbody", "Deploy finished"],
    ["> - 1. `api-gateway` is [live](https://x)  now", "api-gateway is live now"],
    ["---\n\n   \nSecond paragraph", "Second paragraph"],
    ["\n  \n", ""],
  ] as const) {
    chat.clear();
    assert.equal(painted(message("plain", content))[1]?.trim(), `▏ › [plain]${expected ? ` ${expected}` : ""}`);
  }
});

test("empty or failing renderer components fall back to message text", () => {
  for (const render of [() => [], () => ["  "], () => { throw new Error("renderer failed"); }]) {
    chat.clear();
    assert.equal(painted(message("plain", "fallback line", undefined, () => ({ render, invalidate() {} })))[1]?.trim(), "▏ › [plain] fallback line");
  }
});

test("only a non-empty summary string overrides the headline", () => {
  for (const details of [undefined, null, 42, "summary", { summary: 42 }, { summary: "  " }]) {
    chat.clear();
    assert.equal(painted(message("plain", "fallback line", details))[1]?.trim(), "▏ › [plain] fallback line");
  }
});

test("renderer headlines use customType when unlabelled and only drop trailing expand hints", () => {
  for (const [native, expected] of [
    ["saved 3 files (ctrl+o to expand)", "saved 3 files"],
    ["(ctrl+o to expand) is not a hint here", "(ctrl+o to expand) is not a hint here"],
  ] as const) {
    chat.clear();
    assert.equal(painted(message("plain", "ignored", undefined, () => new Text(native, 0, 0)))[1]?.trim(), `▏ › [plain] ${expected}`);
  }
});

test("message sizes count string content and text blocks, not images", () => {
  const text = "x".repeat(200);
  assert.match(painted(message("plain", text))[1]!, /0\.2k ch$/);
  chat.clear();
  assert.match(painted(message("plain", [{ type: "text", text }, { type: "image", mimeType: "image/png", data: "" }, { type: "text", text }]))[1]!, /0\.4k ch$/);
});

for (const tone of ["success", "warning", "error"] as const) {
  test(`renderer ${tone} ink survives on the compact headline`, () => {
    const renderer: MessageRenderer = (_message, _options, t) => new Text(t.fg(tone, "status"), 0, 0);
    painted(message("plain", "ignored", undefined, renderer));
    const sample = theme.fg(tone, "status");
    const opener = sample.slice(0, sample.indexOf("status"));
    assert.ok(chat.render(80).some((line) => line.includes(`${opener}status`)));
  });
}

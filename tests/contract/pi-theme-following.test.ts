import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import type { Model } from "@earendil-works/pi-ai";
import piCachemire from "../../extensions/pi-cachemire/index.ts";
import piMeantime from "../../extensions/pi-meantime/index.ts";
import piTraceline from "../../extensions/pi-traceline/index.ts";
import { ink } from "../../extensions/_lib/style.ts";
import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { LiveWidget } from "../../extensions/_lib/live-widget.ts";
import { appendAnchoredLine, type ChatLineHost } from "../../extensions/_lib/chatline.ts";
import { assistantMessage } from "../helpers.ts";
import { hostExtension, IsolatedProject, RecordedUi } from "../harness/extension-host.ts";
import { mouseViewport } from "../fixtures/mouse-viewport.ts";

// SAFETY: this contract probes the installed Pi theme module, not a production import.
// Both supported and current runtimes expose theme/setTheme here; terminal queries are new.
const themeModule = await import(pathToFileURL(join(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "modes/interactive/theme/theme.js",
)).href) as {
  theme: Theme;
  setTheme(name: string): { success: boolean };
  setTerminalColors?: (colors: {
    background?: { r: number; g: number; b: number };
    foreground?: { r: number; g: number; b: number };
    palette?: { r: number; g: number; b: number }[];
  }) => void;
};
const theme = themeModule.theme;
const plain = (lines: string[]) => lines.map((line) => stripAnsi(line).trimEnd());

function switchTheme(name: string, container: Container): void {
  assert.equal(themeModule.setTheme(name).success, true);
  container.invalidate(); // Pi's theme-change callback invalidates the native component tree.
}

test("stored lines, resolved notices and silent or active clocks reapply ink on native invalidation", () => {
  initTheme("dark", false);
  const container = new Container();
  container.addChild(new AssistantMessageComponent(assistantMessage([{ type: "text", text: "anchor" }])));
  const { view } = mouseViewport();
  view.addChild(container);
  const host: ChatLineHost = { tui: view, anchored: [] };
  const line = appendAnchoredLine(host, "theme", () => ink(theme, "warning", "◍ fixed fact"));
  assert.ok(line);
  const widget = new LiveWidget({ requestRender() {} });
  widget.setLine(() => ink(theme, "running", "◍ tools · 31s"));
  container.addChild(widget);
  const before = container.render(80);
  switchTheme("light", container);
  const after = container.render(80);
  assert.notDeepEqual(after, before, "stored ANSI must not survive a theme switch");
  assert.deepEqual(plain(after), plain(before), "facts, order and layout stay fixed");
  assert.ok(after.some((row) => row.includes(theme.fg("warning", "◍ fixed fact"))));
  assert.ok(after.some((row) => row.includes(theme.fg("accent", "◍ tools · 31s"))));
  line.setText(() => ink(theme, "success", "◍ resolved fact"));
  switchTheme("dark", container);
  assert.ok(line.render(80)[0]!.includes(theme.fg("success", "◍ resolved fact")));
  widget.setLine("");
  assert.deepEqual(widget.render(80), []);
  switchTheme("light", container);
  assert.deepEqual(widget.render(80), [], "theme changes cannot revive a silent clock");
});

test("replacing a line renderer with identical ink keeps the new facts renderer", () => {
  initTheme("dark", false);
  const widget = new LiveWidget({ requestRender() {} });
  let fact = "same";
  widget.setLine(() => ink(theme, "running", "same"));
  widget.render(80);
  widget.setLine(() => ink(theme, "running", fact));
  fact = "replacement";
  const container = new Container();
  container.addChild(widget);
  switchTheme("light", container);
  assert.ok(container.render(80).some((line) => line.includes(theme.fg("accent", "replacement"))));
});

const model: Model<"anthropic-messages"> = {
  id: "claude-opus-4-8", name: "Claude Opus", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"],
  cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  contextWindow: 200_000, maxTokens: 8_000,
};
test("SDK-created cache and pace ledgers recolour without rewriting historical facts", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  initTheme("dark", false);
  const project = new IsolatedProject();
  project.writeProjectConfig("pi-meantime", { enabled: true });
  const { view } = mouseViewport();
  const chat = new Container();
  chat.addChild(new AssistantMessageComponent(assistantMessage([{ type: "text", text: "anchor" }])));
  view.addChild(chat);
  const ui = new RecordedUi(theme, view);
  const host = await hostExtension((pi) => {
    piCachemire(pi);
    piMeantime(pi);
  }, { project, ui, model, reason: "new" });
  const runner = host.session.extensionRunner;
  try {
    await runner.emit({ type: "agent_start" });
    await runner.emitContext([]);
    await runner.emitBeforeProviderRequest({
      model: model.id,
      system: [{ type: "text", text: "fixture", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    mock.timers.tick(1_000);
    await runner.emitMessageEnd({ type: "message_end", message: assistantMessage(
      [{ type: "text", text: "answer" }], {
        provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
        usage: { input: 200, cacheRead: 0, cacheWrite: 100_000, output: 10, totalTokens: 100_210,
          cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } },
      },
    ) });
    await runner.emit({ type: "tool_execution_start", toolCallId: "tool", toolName: "read", args: {} });
    mock.timers.tick(4 * 60_000 + 57_000);
    await host.session.prompt("/cache");
    await host.session.prompt("/pace");
    const panels = ["Cachemire", "Meantime"].map((name) => {
      const panel = chat.children.find((child) => plain(child.render(120)).some((line) => line.includes(`[${name}]`)));
      assert.ok(panel, `${name} ledger must be visible`);
      return { panel, name, snapshot: panel.render(120) };
    });
    for (const widget of ui.widgets.values()) if (!Array.isArray(widget)) view.addChild(widget);
    const clocks = ["pi-cachemire", "pi-meantime"].map((key) => {
      const snapshot = ui.widgetLines(key, 120);
      assert.ok(snapshot, `${key} clock must be mounted`);
      assert.match(plain(snapshot).join("\n"), key === "pi-cachemire" ? /cache expires/ : /tools/);
      return { key, snapshot };
    });
    switchTheme("light", view);
    for (const { panel, name, snapshot } of panels) {
      const lines = panel.render(120);
      assert.notDeepEqual(lines, snapshot);
      assert.deepEqual(plain(lines), plain(snapshot));
      assert.ok(lines.some((line) => line.includes(theme.fg("accent", theme.bold(`[${name}]`)))));
    }
    for (const { key, snapshot } of clocks) {
      const lines = ui.widgetLines(key, 120);
      assert.ok(lines);
      assert.notDeepEqual(lines, snapshot);
      assert.deepEqual(plain(lines), plain(snapshot));
    }
    if (themeModule.setTerminalColors) {
      const palette = [0x000000, 0xaa3333, 0x33aa33, 0xaaaa33, 0x3333aa, 0xaa33aa, 0x33aaaa, 0xaaaaaa,
        0x555555, 0xff7777, 0x77ff77, 0xffff77, 0x7777ff, 0xff77ff, 0x77ffff, 0xffffff]
        .map((color) => ({ r: color >> 16, g: (color >> 8) & 255, b: color & 255 }));
      const frames: string[][] = [];
      for (const colors of [{}, { background: { r: 20, g: 20, b: 20 } },
        { background: { r: 20, g: 20, b: 20 }, palette },
        { background: { r: 245, g: 245, b: 245 }, palette }]) {
        themeModule.setTerminalColors(colors);
        switchTheme("system", view);
        for (const { panel, name, snapshot } of panels) {
          const lines = panel.render(120);
          assert.deepEqual(plain(lines), plain(snapshot));
          assert.ok(lines.some((line) => line.includes(theme.fg("accent", theme.bold(`[${name}]`)))));
        }
        frames.push(chat.render(120));
      }
      assert.notDeepEqual(frames[2], frames[3], "terminal backgrounds must recolour the existing ledgers");
    }
    // Closing the pending tool phase mutates the live call; a past /pace remains a snapshot.
    mock.timers.tick(2_000);
    await runner.emitContext([]);
    await runner.emitBeforeProviderRequest({ model: model.id, messages: [] });
    await runner.emitMessageEnd({ type: "message_end", message: assistantMessage(
      [{ type: "text", text: "later answer" }], {
        provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
        usage: { input: 300, cacheRead: 100_000, cacheWrite: 0, output: 20, totalTokens: 100_320,
          cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } },
      },
    ) });
    switchTheme("dark", view);
    for (const { panel, snapshot } of panels) assert.deepEqual(plain(panel.render(120)), plain(snapshot));
  } finally {
    themeModule.setTerminalColors?.({});
    mock.timers.reset();
    await host.dispose();
    project.dispose();
  }
});

test("SDK-mounted pending tool rows follow the theme through native invalidation", async () => {
  initTheme("dark", false);
  const project = new IsolatedProject();
  const { view } = mouseViewport();
  const chat = new Container();
  const row = new ToolExecutionComponent("read", "theme-tool", { path: "/tmp/theme.ts" }, {}, undefined, view, project.dir);
  chat.addChild(new AssistantMessageComponent(assistantMessage([
    { type: "toolCall", id: "theme-tool", name: "read", arguments: { path: "/tmp/theme.ts" } },
  ]), true));
  chat.addChild(row);
  view.addChild(chat);
  const host = await hostExtension(piTraceline, { project, ui: new RecordedUi(theme, view), model });
  try {
    const before = row.render(80);
    assert.ok(before.some((line) => line.includes(theme.fg("accent", "›"))), "pending status uses the theme accent");
    switchTheme("light", view);
    const after = row.render(80);
    assert.ok(after.some((line) => line.includes(theme.fg("accent", "›"))));
    assert.notDeepEqual(after, before);
    assert.deepEqual(plain(after), plain(before));
  } finally {
    await host.dispose();
    project.dispose();
  }
});

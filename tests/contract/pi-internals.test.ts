// Contract tests: every structural assumption pine-of-glass makes about Pi internals,
// asserted against the *installed* Pi runtime (linked via scripts/dev/link-pi-runtime.sh).
// When `pi update` breaks one of these, the failure names the dependent extension seam.
// See docs/testing.md. These deliberately use no mocks — a mock would mirror our own
// assumptions and pass forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as pi from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import * as piTui from "@earendil-works/pi-tui";

import { internals as cachemire } from "../../extensions/pi-cachemire/index.ts";
import { internals as contextimate } from "../../extensions/pi-contextimate/index.ts";
import { internals as traceline } from "../../extensions/pi-traceline/index.ts";
import { assistantMessage } from "../helpers.ts";

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");

// ---------------------------------------------------------------------------------------
// Module exports contextimate imports at load time.

test("pi exports the session/message machinery contextimate imports", () => {
  assert.equal(typeof pi.buildSessionContext, "function", "buildSessionContext gone — contextimate buildSessionBreakdown breaks");
  assert.equal(typeof pi.convertToLlm, "function", "convertToLlm gone — contextimate buildSessionBreakdown breaks");
  assert.equal(typeof pi.keyText, "function", "keyText gone — contextimate renderHeader breaks");
  assert.equal(typeof pi.initTheme, "function", "initTheme gone — contract component instantiation breaks");
});

test("convertToLlm message shape: roles and content blocks contextimate counts", () => {
  // Use Pi's current AgentMessage contract rather than the surrounding session-entry
  // shape: entry timestamps are ISO strings, but nested message timestamps are numbers.
  const timestamp = Date.UTC(2026, 5, 10, 22);
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "hi" }], timestamp },
    assistantMessage(
      [
        { type: "thinking", thinking: "pondering" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/x" } },
      ],
      { timestamp: timestamp + 1, stopReason: "toolUse" },
    ),
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "result text" }],
      isError: false,
      timestamp: timestamp + 2,
    },
  ];
  const converted = pi.convertToLlm(messages);
  assert.ok(Array.isArray(converted) && converted.length === 3, "convertToLlm must return the converted message list");
  const roles = converted.map((message: { role: string }) => message.role);
  assert.deepEqual(roles, ["user", "assistant", "toolResult"], "role names contextimate switches on");
  const assistant = converted[1] as { content: Array<{ type: string }> };
  const types = assistant.content.map((block) => block.type);
  assert.ok(types.includes("thinking"), "thinking block type renamed — session bucket split breaks");
  assert.ok(types.includes("toolCall"), "toolCall block type renamed — session bucket split breaks");
});

// ---------------------------------------------------------------------------------------
// Real system prompt vs contextimate's parsing regexes.

test("contextimate regexes parse the system prompt Pi actually builds", async () => {
  const systemPromptModule = await import(pathToFileURL(join(piRoot, "dist/core/system-prompt.js")).href) as {
    buildSystemPrompt: (options: Record<string, unknown>) => string;
  };
  assert.equal(typeof systemPromptModule.buildSystemPrompt, "function", "dist/core/system-prompt.js moved — update this contract test's deep import");

  const home = homedir();
  const prompt = systemPromptModule.buildSystemPrompt({
    cwd: tmpdir(),
    contextFiles: [
      { path: join(home, ".pi/agent/AGENTS.md"), content: "# Global\nBe precise & kind." },
      { path: join(home, "projects/demo/AGENTS.md"), content: "# Demo\nLocal rules." },
    ],
    skills: [
      {
        name: "demo-skill",
        description: "Does a demo & more",
        filePath: join(home, "skills/demo/SKILL.md"),
        baseDir: join(home, "skills/demo"),
        sourceInfo: { scope: "user", source: "auto", origin: "top-level", path: join(home, "skills/demo/SKILL.md") },
        disableModelInvocation: false,
      },
    ],
  });

  const sections = contextimate.parseContextSections(prompt, 4);
  assert.equal(sections.length, 2, "project_instructions block format drifted — contextimate context-file rows break");
  assert.equal(sections[0]!.title, "Global AGENTS.md");
  assert.ok(sections[0]!.content.includes("Be precise"), "context file content not captured");

  const { skills, section } = contextimate.buildSkillsSection(prompt, 4);
  assert.ok(section, "available_skills block format drifted — contextimate skills section breaks");
  assert.equal(skills.length, 1);
  assert.equal(skills[0]!.name, "demo-skill");
  assert.equal(skills[0]!.description, "Does a demo & more", "XML entity escaping convention changed");
  assert.ok(skills[0]!.location.endsWith("SKILL.md"));

  const remainder = contextimate.getPromptRemainder(prompt);
  assert.ok(!remainder.includes("<project_instructions"), "PROJECT_CONTEXT_RE no longer strips the context block");
  assert.ok(!remainder.includes("<available_skills>"), "AVAILABLE_SKILLS_RE no longer strips the skills block");
});

test("startup resource list still renders [Section] headers contextimate anchors on", () => {
  const source = readFileSync(join(piRoot, "dist/modes/interactive/interactive-mode.js"), "utf8");
  assert.ok(/\[\$\{name\}\]/.test(source), "resource section header no longer renders as [Name] — contextimate insertion anchor breaks");
  assert.ok(source.includes('addLoadedSection("Context"'), '"Context" section gone — RESOURCE_HEADER_RE may not match');
  assert.ok(contextimate.RESOURCE_HEADER_RE.test("[Context] some files"), "RESOURCE_HEADER_RE self-check");
});

// ---------------------------------------------------------------------------------------
// Interactive components used through Traceline's duck types.
test("real ToolExecutionComponent satisfies traceline's duck type and one-line path", () => {
  pi.initTheme(undefined, false);
  const comp = new pi.ToolExecutionComponent(
    "read",
    "tool-1",
    { path: "/tmp/contract-fixture.txt", offset: 1, limit: 20 },
    undefined,
    undefined,
    {} as never,
    tmpdir(),
  );

  assert.equal(traceline.isToolRow(comp), true, "ToolExecutionComponent no longer matches isToolRow (render/setExpanded/toolName)");
  assert.equal((comp as unknown as { toolCallId?: unknown }).toolCallId, "tool-1", "toolCallId no longer mirrors the call ID");

  const proto = Object.getPrototypeOf(comp) as { render?: unknown };
  const descriptor = Object.getOwnPropertyDescriptor(proto, "render");
  assert.ok(descriptor && (descriptor.writable ?? false), "prototype render not writable — traceline patch cannot install");

  comp.updateResult({ content: [{ type: "text", text: "hello world ".repeat(20) }], isError: false }, false);
  assert.equal(traceline.toolStatus(comp as never), "success", "result/isPartial fields drifted — status colours break");

  const line = traceline.oneLine(comp as never, 80);
  const visible = traceline.stripAnsi(line);
  assert.ok(visible.includes("read"), `one-line render lost the invocation: ${JSON.stringify(visible)}`);
  assert.ok(/\b0\.2k ch$/.test(visible.trimEnd()), `result-size suffix missing: ${JSON.stringify(visible)}`);

  const errorComp = new pi.ToolExecutionComponent(
    "read",
    "tool-error",
    { path: "/tmp/contract-fixture.txt" },
    undefined,
    undefined,
    {} as never,
    tmpdir(),
  );
  errorComp.updateResult({ content: [{ type: "text", text: "boom" }], isError: true }, false);
  assert.equal(traceline.toolStatus(errorComp as never), "error");
});

test("real ToolExecutionComponent: bash multiline render seam", () => {
  pi.initTheme(undefined, false);
  const comp = new pi.ToolExecutionComponent(
    "bash",
    "tool-2",
    { command: 'python3 -c "\nimport json\nprint(1)\n" && echo done', timeout: 70 },
    undefined,
    undefined,
    {} as never,
    tmpdir(),
  );

  const callComp = (comp as unknown as { callRendererComponent?: { render?: (w: number) => string[] } }).callRendererComponent;
  assert.ok(callComp && typeof callComp.render === "function", "bash callRendererComponent gone — one-line path falls back");
  const lines = callComp.render(10_000);
  assert.ok(lines.length >= 4, `bash call no longer renders one line per newline: ${JSON.stringify(lines)}`);
  assert.ok(traceline.stripAnsi(lines[lines.length - 1]!).includes("(timeout 70s)"), "timeout suffix moved off the last line");

  const flat = traceline.stripAnsi(traceline.oneLine(comp as never, 200));
  assert.ok(flat.includes("echo done"), `flattened bash row lost its tail: ${flat}`);
});

test("real AssistantMessageComponent preserves its tool-call link and duck type", () => {
  const component = new pi.AssistantMessageComponent(assistantMessage([
    { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/tmp/contract-fixture.txt" } },
  ]));
  assert.equal(traceline.isAssistantRow(component), true, "AssistantMessageComponent no longer matches isAssistantRow");
  const peek = component as unknown as {
    hideThinkingBlock: boolean;
    lastMessage?: { content?: Array<{ id?: unknown }> };
  };
  assert.equal(peek.lastMessage?.content?.[0]?.id, "tool-1", "assistant tool-call ID no longer links to its execution row");
  assert.equal(peek.hideThinkingBlock, false);
  component.setHideThinkingBlock(true);
  assert.equal(peek.hideThinkingBlock, true, "hideThinkingBlock no longer mirrors setHideThinkingBlock — collapse state desyncs");
});

test("adjacent thinking blocks get one native run label; traceline appends one preview", () => {
  pi.initTheme(undefined, false);
  const component = new pi.AssistantMessageComponent(assistantMessage([
    { type: "thinking", thinking: "first reasoning segment" },
    { type: "thinking", thinking: "second reasoning segment" },
  ]));
  component.setHideThinkingBlock(true);

  const native = component.render(80);
  const labelCount = (lines: string[]) =>
    lines.filter((line) => traceline.stripAnsi(line).trim() === "Thinking...").length;
  // The seam itself (issue #14 №3): Pi renders one collapsed label per adjacent
  // thinking run. A change here requires re-checking preview-to-label alignment.
  assert.equal(labelCount(native), 1, "Pi's collapsed-run label cardinality changed");

  const deduped = traceline.dedupeThinkingLabels(component as never, native, 80);
  assert.equal(labelCount(deduped), 0, "native placeholders should become trace previews");
  assert.deepEqual(
    deduped.map((line) => traceline.stripAnsi(line).trim()),
    ["", "Thinking: first reasoning segment · second reasoning segment"],
    "adjacent source blocks append without Pi's inter-label spacer",
  );

  // pi marks the message's first and last lines with OSC 133 zone marks; the dedupe must
  // never lose control sequences from dropped lines.
  const zoneMarks = (lines: string[]) => (lines.join("").match(/\x1b\]133;[^\x07\x1b]*(?:\x07|\x1b\\)/g) ?? []).length;
  assert.equal(zoneMarks(deduped), zoneMarks(native), "OSC 133 zone marks must survive the dedupe");
});

test("chat-rebuild surface family line persistence depends on", () => {
  // Ctrl+T (and compaction/navigation) rebuild the chat container from session messages:
  // clear() + re-render drops raw appended children. Cachemire and meantime re-attach their lines
  // after every clear(), anchored on durable component identity.
  const source = readFileSync(join(piRoot, "dist/modes/interactive/interactive-mode.js"), "utf8");
  assert.ok(
    /toggleThinkingBlockVisibility\(\)\s*\{[^}]*this\.chatContainer\.clear\(\)/s.test(source),
    "Ctrl+T no longer clears the chat container — re-verify whether the family clear hook is still needed/sufficient",
  );
  assert.ok(source.includes("rebuildChatFromMessages"), "rebuildChatFromMessages gone — rebuild path renamed");

  // Anchor identities: tool rows by toolCallId, assistant rows by lastMessage role#timestamp.
  pi.initTheme(undefined, false);
  const toolComp = new pi.ToolExecutionComponent("read", "tool-9", { path: "/tmp/x" }, undefined, undefined, {} as never, tmpdir());
  assert.equal(cachemire.childAnchorKey(toolComp), "tool#tool-9", "toolCallId drifted — tool-row anchors break");

  const ts = Date.UTC(2026, 5, 10, 22);
  const assistantComp = new pi.AssistantMessageComponent(
    assistantMessage([{ type: "text", text: "hi" }], { timestamp: ts }),
  );
  assert.equal(
    cachemire.childAnchorKey(assistantComp),
    `assistant#${ts}`,
    "AssistantMessageComponent.lastMessage role/timestamp drifted — assistant anchors break",
  );

  // The container instance exposes clear() and a mutable children array to hook.
  const container = new piTui.Container();
  assert.equal(typeof container.clear, "function", "Container.clear gone — clear hook cannot install");

  // Fresh-session chat detection relies on these siblings inside the mounted transcript tree.
  assert.ok(source.includes("this.documentContainer.addChild(this.loadedResourcesContainer);"), "loadedResourcesContainer no longer in transcript tree");
  assert.ok(source.includes("this.documentContainer.addChild(this.chatContainer);"), "chatContainer no longer in transcript tree");
  assert.ok(source.includes("this.documentContainer,"), "documentContainer no longer mounted in the TUI");
  assert.ok(
    source.indexOf("this.documentContainer.addChild(this.loadedResourcesContainer);") <
      source.indexOf("this.documentContainer.addChild(this.chatContainer);"),
    "loadedResourcesContainer no longer sits before chatContainer — fresh-session detection needs rework",
  );
  assert.ok(
    /addLoadedSection[\s\S]{0,400}this\.loadedResourcesContainer\.addChild\(section\)/.test(source),
    "startup resource sections no longer added to loadedResourcesContainer — pre-rows detection dies",
  );
  for (const name of ["Skills", "Prompts", "Extensions", "Themes"]) {
    assert.ok(source.includes(`"${name}"`), `startup section [${name}] renamed — RESOURCE_HEADER_RE drifts`);
  }
});

test("Ctrl+T status line: pi's showStatus tail shape traceline suppresses", () => {
  // pi's toggleThinkingBlockVisibility ends with showStatus(`Thinking blocks: …`),
  // which appends a Spacer(1) + Text pair to chatContainer. Traceline drops exactly
  // that trailing pair (design language §9.11); if the message text or the pair
  // shape drifts, the status line reappears silently — this contract names it.
  const source = readFileSync(join(piRoot, "dist/modes/interactive/interactive-mode.js"), "utf8");
  assert.ok(
    source.includes('`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`'),
    "Ctrl+T status message text drifted — THINKING_TOGGLE_STATUS no longer matches",
  );
  assert.ok(
    /showStatus\(message\)\s*\{[\s\S]{0,900}?new Spacer\(1\);[\s\S]{0,200}?new Text\(theme\.fg\("dim", message\)[\s\S]{0,300}?addChild\(spacer\);[\s\S]{0,100}?addChild\(text\);/.test(source),
    "showStatus no longer appends a Spacer + dim Text pair to the chat — suppression seam drifted",
  );

  // The real pi-tui components satisfy (and only the right one satisfies) the duck
  // types. The text is stored ANSI-styled (theme.fg("dim", message)); the duck type
  // strips ANSI, so any dim wrapper stands in for the live theme's.
  const text = new piTui.Text("\x1b[90mThinking blocks: hidden\x1b[0m", 1, 0);
  const spacer = new piTui.Spacer(1);
  assert.equal(traceline.isThinkingToggleStatusRow(text), true, "real Text no longer matches the status duck type");
  assert.equal(traceline.isSpacerRow(spacer), true, "real Spacer no longer matches the spacer duck type");
  assert.equal(traceline.isSpacerRow(text), false);
  assert.equal(traceline.isThinkingToggleStatusRow(spacer), false);
  assert.equal(
    traceline.isThinkingToggleStatusRow(new piTui.Text("\x1b[90mForked to new session\x1b[0m", 1, 0)),
    false,
    "other showStatus messages must pass through",
  );

  // End-to-end against a real Container: mimic the toggle's tail, then suppress.
  const container = new piTui.Container();
  const keep = new piTui.Text("assistant prose", 1, 0);
  container.addChild(keep);
  container.addChild(spacer);
  container.addChild(text);
  const previousChat = traceline.getTracelineChat();
  traceline.setTracelineChat(container as never);
  try {
    traceline.suppressThinkingToggleStatus();
    assert.deepEqual(container.children, [keep], "trailing Spacer + Text status pair must be removed");
  } finally {
    traceline.setTracelineChat(previousChat);
  }
});

// ---------------------------------------------------------------------------------------
// Drill mode's Pi seams (design language §9.13): the custom-UI editor swap, the overlay
// pager, and the expanded-row spacer line the number cell replaces.

test("showExtensionCustom seam: editor swap/restore + overlay close drill mode rides", () => {
  const source = readFileSync(join(piRoot, "dist/modes/interactive/interactive-mode.js"), "utf8");
  assert.ok(
    source.includes("custom: (factory, options) => this.showExtensionCustom(factory, options)"),
    "ctx.ui.custom wiring gone — drill mode cannot open its hint bar or pager",
  );
  const custom = source.slice(source.indexOf("async showExtensionCustom"));
  assert.ok(custom.includes("const savedText = this.editor.getText();"), "editor draft no longer saved — exiting drill mode would eat the user's draft");
  for (const anchor of [
    "this.editorContainer.clear();",
    "this.editorContainer.addChild(this.editor);",
    "this.editor.setText(savedText);",
    "this.ui.setFocus(this.editor);",
  ]) {
    assert.ok(custom.includes(anchor), `editor restore step gone (${anchor}) — drill exit strands the editor`);
  }
  assert.ok(custom.includes("this.ui.hideOverlay()"), "overlay close no longer hides — the pager would never leave the screen");

  const declarations = readFileSync(join(piRoot, "dist/core/extensions/types.d.ts"), "utf8");
  assert.ok(declarations.includes("registerShortcut(shortcut: KeyId"), "registerShortcut signature drifted — the alt+t entry point dies");
  assert.ok(declarations.includes("onTerminalInput(handler: TerminalInputHandler)"), "onTerminalInput gone — drill's mouse routing dies");
  assert.ok(declarations.includes("custom<T>(factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void)"), "custom factory signature drifted — hint bar and pager factories break");
});

test("foreign-chord exit seam: listeners precede focus dispatch; close() restores inline", () => {
  // Drill's foreign-chord exit (§9.13) rides two orderings inside one input dispatch:
  // the extension input listener exits the mode, pi restores the editor synchronously
  // inside showExtensionCustom's close(), and only then does tui resolve the focused
  // component — so the very same keystroke lands in the restored editor.
  const tuiRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-tui"))), "..");
  const tuiSource = readFileSync(join(tuiRoot, "dist/tui.js"), "utf8");
  const listenerLoop = tuiSource.indexOf("for (const listener of this.inputListeners)");
  const focusDispatch = tuiSource.indexOf("this.focusedComponent.handleInput(data)");
  assert.ok(listenerLoop !== -1, "input-listener loop gone — the foreign-chord hook never runs");
  assert.ok(focusDispatch !== -1, "focused-component dispatch gone — re-verify tui input routing");
  assert.ok(listenerLoop < focusDispatch, "listeners no longer run before focus dispatch — a foreign chord would hit the dead hint bar");

  const source = readFileSync(join(piRoot, "dist/modes/interactive/interactive-mode.js"), "utf8");
  const closeBody = source.slice(source.indexOf("async showExtensionCustom")).slice(0, 2_000);
  const restoreAt = closeBody.indexOf("restoreEditor();");
  const resolveAt = closeBody.indexOf("resolve(result);");
  assert.ok(restoreAt !== -1 && resolveAt !== -1, "close() body drifted — re-verify the synchronous editor restore");
  assert.ok(restoreAt < resolveAt, "close() no longer restores the editor before resolving — the flowed-through chord would land in a void");
});

test("pi-tui overlay focus restore + terminal dimensions the drill pager reads", () => {
  const tuiRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-tui"))), "..");
  const tuiSource = readFileSync(join(tuiRoot, "dist/tui.js"), "utf8");
  assert.ok(
    tuiSource.includes("preFocus: this.focusedComponent"),
    "showOverlay no longer records pre-overlay focus — closing the pager would not return keys to the hint bar",
  );
  assert.ok(
    tuiSource.includes("overlayLines.slice(0, maxHeight)"),
    "overlay no longer clips lines to maxHeight — re-verify the pager's self-windowing assumption",
  );
  const tuiDecl = readFileSync(join(tuiRoot, "dist/tui.d.ts"), "utf8");
  assert.ok(tuiDecl.includes("terminal: Terminal;"), "TUI.terminal gone — the pager loses its height source");
});

test("real expanded tool row: setExpanded mirrors .expanded and leads with a blank spacer", () => {
  pi.initTheme(undefined, false);
  const comp = new pi.ToolExecutionComponent("read", "tool-drill", { path: "/tmp/x.txt" }, undefined, undefined, {} as never, tmpdir());
  comp.updateResult({ content: [{ type: "text", text: "hello ".repeat(40) }], isError: false }, false);
  const peek = comp as unknown as { expanded?: boolean };
  assert.equal(peek.expanded ?? false, false, "rows must start collapsed");
  comp.setExpanded(true);
  assert.equal(peek.expanded, true, "expanded flag no longer mirrors setExpanded — drill pins and §9.12 z1 desync");
  assert.equal(traceline.isExpandedToolRow(comp), true, "real expanded row must match the z1 duck type");

  // The number cell rides the blank spacer line pi renders above a native row (§9.13).
  // If this softens, drill numbering on expanded rows silently degrades (row stays
  // selectable but shows no number) — this contract names the drift instead.
  const lines = comp.render(80);
  assert.ok(Array.isArray(lines) && lines.length > 1, "expanded render shape drifted");
  assert.equal(traceline.stripAnsi(lines[0] as string).trim(), "", "expanded native render no longer leads with a blank spacer line");
});

// ---------------------------------------------------------------------------------------
// Settings + ExtensionAPI declaration anchors (source-text tripwires).

test("ExtensionAPI still declares the tool surface contextimate reads", () => {
  const declarations = readFileSync(join(piRoot, "dist/core/extensions/types.d.ts"), "utf8");
  assert.ok(declarations.includes("getActiveTools(): string[]"), "getActiveTools signature drifted");
  assert.ok(declarations.includes("getAllTools(): ToolInfo[]"), "getAllTools signature drifted");
  for (const field of ["sourceInfo", "promptGuidelines"]) {
    assert.ok(declarations.includes(field), `ToolInfo.${field} gone — contextimate tool rows degrade`);
  }
});

test("thinking-level surface cachemire reads stays where it is", () => {
  const declarations = readFileSync(join(piRoot, "dist/core/extensions/types.d.ts"), "utf8");
  assert.ok(
    declarations.includes('on(event: "thinking_level_select"'),
    "thinking_level_select event gone — cachemire's proactive stale flip dies silently",
  );
  assert.ok(declarations.includes("previousLevel: ThinkingLevel"), "previousLevel gone from the event");
  // getThinkingLevel lives on the runtime API object, not the per-event ctx: the runner
  // wires it onto runtime, and createContext() never includes it. Cachemire calls
  // pi.getThinkingLevel(); if it moves to ctx-only this anchor should flag it.
  const runner = readFileSync(join(piRoot, "dist/core/extensions/runner.js"), "utf8");
  assert.ok(
    runner.includes("this.runtime.getThinkingLevel = actions.getThinkingLevel"),
    "runtime.getThinkingLevel wiring drifted — verify pi.getThinkingLevel() still works",
  );
});

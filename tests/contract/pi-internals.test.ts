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
import * as piTui from "@earendil-works/pi-tui";

import { internals as contextimate } from "../../extensions/pi-contextimate/index.ts";
import { internals as traceline } from "../../extensions/pi-traceline/index.ts";

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
  // Build a minimal real session via SessionManager in-memory mode if available;
  // otherwise convert a hand-built message list. We use convertToLlm directly on a
  // message in Pi's internal shape, mirroring buildSessionContext output structure.
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }], timestamp: new Date().toISOString() },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "pondering", thinkingSignature: undefined },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/x" } },
      ],
      timestamp: new Date().toISOString(),
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      stopReason: "toolUse",
    },
    { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "result text" }], isError: false, timestamp: new Date().toISOString() },
  ];
  const converted = pi.convertToLlm(messages as never);
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
// Real interactive components vs traceline's duck types and prototype patch points.

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

  const proto = Object.getPrototypeOf(comp) as { render?: unknown };
  const descriptor = Object.getOwnPropertyDescriptor(proto, "render");
  assert.ok(descriptor && (descriptor.writable ?? false), "prototype render not writable — traceline patch cannot install");

  comp.updateResult({ content: [{ type: "text", text: "hello world" }], isError: false }, false);
  assert.equal(traceline.toolStatus(comp), "success", "result/isPartial fields drifted — status colours break");

  const line = traceline.oneLine(comp as never, 80);
  const visible = traceline.stripAnsi(line);
  assert.ok(visible.includes("read"), `one-line render lost the invocation: ${JSON.stringify(visible)}`);
  assert.ok(/\b11 ch$/.test(visible.trimEnd()), `result-size suffix missing: ${JSON.stringify(visible)}`);

  // Error path drives the red status colour.
  comp.updateResult({ content: [{ type: "text", text: "boom" }], isError: true }, false);
  assert.equal(traceline.toolStatus(comp), "error");
});

test("real ToolExecutionComponent: bash multiline render + tool-surface seams traceline borrows", () => {
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

  // Multiline commands render one line per real newline, timeout suffix on the last —
  // the shape flattenInvocationLines + stripTimeoutSuffix assume (issue #10).
  const callComp = (comp as unknown as { callRendererComponent?: { render?: (w: number) => string[] } }).callRendererComponent;
  assert.ok(callComp && typeof callComp.render === "function", "bash callRendererComponent gone — one-line path falls back");
  const lines = callComp.render(10_000);
  assert.ok(lines.length >= 4, `bash call no longer renders one line per newline: ${JSON.stringify(lines)}`);
  assert.ok(traceline.stripAnsi(lines[lines.length - 1]!).includes("(timeout 70s)"), "timeout suffix moved off the last line");

  const flat = traceline.stripAnsi(traceline.oneLine(comp as never, 200));
  assert.ok(flat.includes("echo done"), `flattened bash row lost its tail: ${flat}`);

  // The shaded surface: contentBox.bgFn is the status-synced theme background, and its
  // output shape (open + text + bg-only close) is what shadeRow's \u0000 split parses.
  const box = (comp as unknown as { contentBox?: { bgFn?: (text: string) => string } }).contentBox;
  assert.ok(box && typeof box.bgFn === "function", "contentBox.bgFn gone — traceline rows lose the tool surface");
  const [open = "", close = ""] = box.bgFn("\u0000").split("\u0000");
  assert.ok(/^\x1b\[48;/.test(open), `theme.bg open is no longer a bg SGR prefix: ${JSON.stringify(open)}`);
  assert.equal(close, "\x1b[49m", "theme.bg no longer closes with bg-only reset — shadeRow re-assertion breaks");
  // Anything other than "self" composes through the bg-painted contentBox; rowBackground
  // only opts out on "self", so the invariant to pin is bash not being self-framed.
  const shell = (comp as unknown as { getRenderShell?: () => string }).getRenderShell?.();
  assert.ok(typeof shell === "string" && shell !== "self", `bash render shell became self-framed (${shell}) — rows lose the shade`);
  const shaded = traceline.oneLine(comp as never, 80);
  assert.ok(shaded.startsWith(open), "real row did not open on the theme tool background");
});

test("real AssistantMessageComponent satisfies traceline's assistant duck type", () => {
  const component = new pi.AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "hi" }] } as never);
  assert.equal(traceline.isAssistantRow(component), true, "AssistantMessageComponent no longer matches isAssistantRow");
  // hideThinkingBlock is declared private but traceline reads it duck-typed at runtime.
  const peek = component as unknown as { hideThinkingBlock: boolean };
  assert.equal(peek.hideThinkingBlock, false);
  component.setHideThinkingBlock(true);
  assert.equal(peek.hideThinkingBlock, true, "hideThinkingBlock no longer mirrors setHideThinkingBlock — collapse state desyncs");
});

test("TUI prototype chain still contains a patchable Container", () => {
  assert.equal(typeof piTui.Container.prototype.render, "function");
  assert.equal(piTui.Container.name, "Container", "Container class renamed — traceline findContainerPrototype breaks");
  assert.ok(piTui.TUI.prototype instanceof piTui.Container, "TUI no longer extends Container — hit-map patch finds nothing");
  const container = new piTui.Container();
  assert.ok(Array.isArray((container as unknown as { children: unknown }).children), "Container.children no longer an array");
});

// ---------------------------------------------------------------------------------------
// Settings + ExtensionAPI declaration anchors (source-text tripwires).

test("settings manager still persists hideThinkingBlock in settings.json", () => {
  const source = readFileSync(join(piRoot, "dist/core/settings-manager.js"), "utf8");
  assert.ok(source.includes("hideThinkingBlock"), "hideThinkingBlock setting renamed — traceline disk fallback breaks");
  assert.ok(source.includes('"settings.json"'), "settings filename changed — traceline disk fallback breaks");
});

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

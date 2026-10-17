// Contract tests against the installed Pi runtime. See docs/testing.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as pi from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import { isJsonObject } from "../../extensions/_lib/boundary.ts";
import { captureCallLines } from "../../extensions/pi-traceline/call-capture.ts";
import { isAssistantRow, isToolRow, type AssistantRowLike, type ToolRowLike } from "../../extensions/_lib/chat.ts";
import { isExpandedToolRow } from "../../extensions/pi-traceline/topology.ts";
import { getPromptRemainder } from "../../extensions/pi-contextimate/prompt-parsing.ts";
import { buildSnapshot } from "../../extensions/pi-contextimate/snapshot.ts";
import { internals as traceline } from "../../extensions/pi-traceline/index.ts";
import { assistantMessage } from "../helpers.ts";

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");

test("convertToLlm preserves the roles and content blocks contextimate counts", () => {
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
      role: "toolResult", toolCallId: "t1", toolName: "read",
      content: [{ type: "text", text: "result text" }], isError: false, timestamp: timestamp + 2,
    },
  ];
  const converted = pi.convertToLlm(messages);
  assert.deepEqual(converted.map((message) => message.role), ["user", "assistant", "toolResult"]);
  const assistant = converted[1]!;
  assert.equal(assistant.role, "assistant");
  assert(Array.isArray(assistant.content));
  assert.deepEqual(assistant.content.map((block) => block.type), ["thinking", "toolCall"]);
});

test("contextimate parses the system prompt Pi actually builds", async () => {
  const { buildSystemPrompt } = await import(pathToFileURL(join(piRoot, "dist/core/system-prompt.js")).href) as {
    buildSystemPrompt: (options: pi.BuildSystemPromptOptions) => string;
  };
  const home = homedir();
  const prompt = buildSystemPrompt({
    cwd: tmpdir(),
    contextFiles: [
      { path: join(home, ".pi/agent/AGENTS.md"), content: "# Global\nBe precise & kind." },
      { path: join(home, "projects/demo/AGENTS.md"), content: "# Demo\nLocal rules." },
    ],
    skills: [{
      name: "demo-skill", description: "Does a demo & more",
      filePath: join(home, "skills/demo/SKILL.md"), baseDir: join(home, "skills/demo"),
      sourceInfo: { scope: "user", source: "auto", origin: "top-level", path: join(home, "skills/demo/SKILL.md") },
      disableModelInvocation: false,
    }],
  });
  const snapshot = buildSnapshot({ getActiveTools: () => [], getAllTools: () => [] }, { systemPrompt: prompt });
  const sections = snapshot.sections.filter((section) => section.id.startsWith("context:"));
  assert.equal(sections.length, 2, "project_instructions block format drifted");
  assert.equal(sections[0]!.title, "Global AGENTS.md");
  assert.ok(sections[0]!.content.includes("Be precise"));
  assert.ok(snapshot.sections.some((section) => section.id === "skills"), "available_skills block format drifted");
  assert.equal(snapshot.skills.length, 1);
  assert.equal(snapshot.skills[0]!.name, "demo-skill");
  assert.equal(snapshot.skills[0]!.description, "Does a demo & more", "XML entity escaping changed");
  assert.ok(snapshot.skills[0]!.location.endsWith("SKILL.md"));
  const remainder = getPromptRemainder(prompt);
  for (const section of snapshot.sections.filter((section) => section.id.startsWith("context:") || section.id === "skills")) {
    assert.ok(!remainder.includes(section.content), `${section.id} block leaked into the runtime prompt row`);
  }
});

test("real tool rows render successful result sizes and errors", () => {
  pi.initTheme(undefined, false);
  const comp = new pi.ToolExecutionComponent(
    "read", "tool-1", { path: "/tmp/contract-fixture.txt", offset: 1, limit: 20 },
    undefined, undefined, {} as never, tmpdir(),
  );
  // SAFETY: Pi's private fields need a structural view; the assertion checks the seam.
  const row = comp as unknown as ToolRowLike;
  assert(isToolRow(row), "ToolExecutionComponent no longer matches isToolRow");
  assert.equal(row.toolCallId, "tool-1");
  comp.updateResult({ content: [{ type: "text", text: "hello world ".repeat(20) }], isError: false }, false);
  assert.equal(traceline.toolStatus(row), "success");
  const visible = stripAnsi(traceline.oneLine(row, 80));
  assert.ok(visible.includes("read"), visible);
  assert.match(visible.trimEnd(), /\b0\.2k ch$/);

  comp.updateResult({ content: [{ type: "text", text: "boom" }], isError: true }, false);
  assert.equal(traceline.toolStatus(row), "error");
});

test("real bash call rendering preserves multiline command tails", async () => {
  pi.initTheme(undefined, false);
  const { withBuiltInRenderers } = await import(pathToFileURL(join(piRoot, "dist/core/tools/renderers/index.js")).href) as {
    withBuiltInRenderers: (toolName: string, definition: undefined) => ConstructorParameters<typeof pi.ToolExecutionComponent>[4];
  };
  const comp = new pi.ToolExecutionComponent(
    "bash", "tool-2", { command: 'python3 -c "\nimport json\nprint(1)\n" && echo done', timeout: 70 },
    undefined, withBuiltInRenderers("bash", undefined), {} as never, tmpdir(),
  );
  const row = comp as unknown as ToolRowLike;
  assert(isToolRow(row));
  const lines = captureCallLines(row.callRendererComponent, row.args);
  assert(lines && lines.length >= 4, "bash call no longer renders one line per newline");
  assert.ok(stripAnsi(lines.at(-1)!).includes("(timeout 70s)"));
  const flat = stripAnsi(traceline.oneLine(row, 200));
  assert.ok(flat.includes("echo done"), `flattened bash row lost its tail: ${flat}`);
});

test("real assistant rows retain the tool-call link and thinking visibility", () => {
  const component = new pi.AssistantMessageComponent(assistantMessage([
    { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/tmp/contract-fixture.txt" } },
  ]));
  const row = component as unknown as AssistantRowLike;
  assert(isAssistantRow(row));
  const content = row.lastMessage?.content;
  assert(Array.isArray(content) && isJsonObject(content[0]));
  assert.equal(content[0].id, "tool-1");
  assert.equal(row.hideThinkingBlock, false);
  row.setHideThinkingBlock(true);
  assert.equal(row.hideThinkingBlock, true);
});

test("expanded native tool rows lead with the spacer used for drill numbers", () => {
  pi.initTheme(undefined, false);
  const comp = new pi.ToolExecutionComponent("read", "tool-drill", { path: "/tmp/x.txt" }, undefined, undefined, {} as never, tmpdir());
  comp.updateResult({ content: [{ type: "text", text: "hello ".repeat(40) }], isError: false }, false);
  assert.equal(isExpandedToolRow(comp), false);
  comp.setExpanded(true);
  assert(isExpandedToolRow(comp));
  const lines = comp.render(80);
  assert.ok(lines.length > 1);
  assert.equal(stripAnsi(lines[0]!).trim(), "");
});

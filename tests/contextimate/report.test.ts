// contextReport (extensions/pi-contextimate/report.ts) is the stable, plain-data view of the
// startup panel, so other extensions can record it. It must count with the user's config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Type } from "typebox";

import { contextReport, type ContextReport } from "../../extensions/pi-contextimate/report.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

test("contextReport lists sections, skills and tools, counted with the user's contextimate config", async () => {
  const project = new IsolatedProject();
  const skill = join(project.home, ".pi", "agent", "skills", "demo", "SKILL.md");
  mkdirSync(join(skill, ".."), { recursive: true });
  writeFileSync(skill, "---\nname: demo\ndescription: Shows up in the skill index\n---\nBody.\n");
  const globalRules = "# Global\nBe precise & kind.";
  const localRules = "# Local\nKeep changes small.";
  writeFileSync(join(project.home, ".pi", "agent", "AGENTS.md"), globalRules);
  writeFileSync(join(project.dir, "AGENTS.md"), localRules);
  project.writeProjectConfig("pi-contextimate", { defaults: { label: "one char per token", textDenominator: 1, toolDenominator: 1, toolNumerator: "anthropic" } });

  let report: ContextReport | undefined;
  const host = await hostExtension((pi) => {
    const tool = (name: string) => ({
      name,
      label: name,
      description: `The ${name} tool`,
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => ({ content: [{ type: "text" as const, text: "" }], details: {} }),
    });
    // Pi lists skills only while `read` is active.
    pi.registerTool(tool("read"));
    pi.registerTool(tool("unused"));
    pi.registerCommand("report", {
      handler: async (args, ctx) => {
        pi.setActiveTools(args === "none" ? [] : ["read"]);
        report = contextReport(pi, ctx);
      },
    });
  }, { project, noTools: "builtin" });
  try {
    await host.session.prompt("/report");
    assert.ok(report);

    assert.equal(report.heuristic, "one char per token");
    const system = report.sections.find((section) => section.id === "system");
    assert.ok(system && system.chars > 0);
    assert.equal(system.tokens, system.chars, "the config's textDenominator of 1 applies");
    assert.equal(report.totalTokens, report.sections.reduce((sum, section) => sum + section.tokens, 0));
    assert.deepEqual(report.sections.filter((section) => section.id.startsWith("context:")).map(({ title, chars, tokens }) => ({ title, chars, tokens })), [
      { title: "Global AGENTS.md", chars: globalRules.length, tokens: globalRules.length },
      { title: join(project.dir, "AGENTS.md"), chars: localRules.length, tokens: localRules.length },
    ]);

    assert.deepEqual(report.skills.map(({ name, location }) => ({ name, location })), [{ name: "demo", location: skill }]);
    assert.ok(report.skills[0]!.tokens > 0);

    const read = report.tools.find((tool) => tool.name === "read");
    const unused = report.tools.find((tool) => tool.name === "unused");
    assert.ok(read?.active);
    assert.ok(unused && !unused.active);
    assert.equal("tokens" in unused, false);
    // The complete Anthropic definition is 138 characters; the list adds two brackets.
    assert.equal(read.tokens, 138);
    assert.equal(report.sections.find((section) => section.id === "tools")?.tokens, 140);

    project.writeProjectConfig("pi-contextimate", { defaults: { toolNumerator: "openai-cookbook" } });
    await host.session.prompt("/report");
    const openaiRead = report.tools.find((tool) => tool.name === "read");
    assert.ok(openaiRead?.active);
    assert.equal(report.sections.find((section) => section.id === "tools")?.tokens, openaiRead.tokens + 16);

    await host.session.prompt("/report none");
    assert.deepEqual(report.skills, []);
    assert.ok(report.tools.every((tool) => !tool.active && !("tokens" in tool)));
    assert.ok(report.sections.every((section) => section.id !== "tools" && section.id !== "skills"));
  } finally {
    await host.dispose();
    project.dispose();
  }
});

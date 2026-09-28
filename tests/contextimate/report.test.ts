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
  project.writeProjectConfig("pi-contextimate", { defaults: { label: "one char per token", textDenominator: 1 } });

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
      handler: async (_args, ctx) => {
        pi.setActiveTools(["read"]);
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

    assert.deepEqual(report.skills.map(({ name, location }) => ({ name, location })), [{ name: "demo", location: skill }]);
    assert.ok(report.skills[0]!.tokens > 0);

    const byName = Object.fromEntries(report.tools.map((tool) => [tool.name, tool]));
    assert.equal(byName["read"]?.active, true);
    assert.ok((byName["read"]?.tokens ?? 0) > 0);
    assert.deepEqual({ active: byName["unused"]?.active, tokens: byName["unused"]?.tokens }, { active: false, tokens: undefined });
  } finally {
    await host.dispose();
    project.dispose();
  }
});

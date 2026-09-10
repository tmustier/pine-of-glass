// Pi emits <available_skills> only while read or bash is active. pi-codex-conversion
// swaps those tools out and re-injects the skill index per turn as a compact
// <skills_instructions> list. Pin the installed adapter's output against contextimate's
// parser; skipped when the adapter is not installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { internals as contextimate } from "../../extensions/pi-contextimate/index.ts";

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const codexConversionBuilder = join(homedir(), ".pi/agent/npm/node_modules/@howaboua/pi-codex-conversion/dist/prompt/build-system-prompt.js");

test(
  "contextimate parses the skills list the installed pi-codex-conversion builder emits",
  { skip: !existsSync(codexConversionBuilder) && "pi-codex-conversion not installed" },
  async () => {
    const pi = await import(pathToFileURL(join(piRoot, "dist/core/system-prompt.js")).href) as {
      buildSystemPrompt: (options: Record<string, unknown>) => string;
    };
    const codex = await import(pathToFileURL(codexConversionBuilder).href) as {
      buildCodexSystemPrompt: (basePrompt: string, options: Record<string, unknown>) => string;
    };
    assert.equal(typeof codex.buildCodexSystemPrompt, "function", "pi-codex-conversion builder moved — update this deep import");

    const home = homedir();
    const skills = [
      { name: "demo", description: "Does a demo & more", filePath: join(home, "skills/demo/SKILL.md") },
      { name: "quiet", description: "", filePath: join(home, "skills/quiet/SKILL.md") },
    ];
    const basePrompt = pi.buildSystemPrompt({ cwd: tmpdir(), selectedTools: ["exec_command", "apply_patch"] });
    assert.ok(!basePrompt.includes("<available_skills>"));

    for (const heavySystemPromptOverwrite of [false, true]) {
      const prompt = codex.buildCodexSystemPrompt(basePrompt, {
        skills,
        heavySystemPromptOverwrite,
        systemPromptOptions: { cwd: tmpdir(), selectedTools: ["exec_command", "apply_patch"] },
      });
      const label = heavySystemPromptOverwrite ? "heavy" : "light";
      const block = contextimate.parseSkillsBlock(prompt, 4);
      assert.ok(block, `${label}: adapter skills block format drifted — SKILLS_INSTRUCTIONS_RE misses it`);
      assert.deepEqual(
        block!.skills.map(({ name, description, location }) => ({ name, description, location })),
        [
          { name: "demo", description: "Does a demo & more", location: join(home, "skills/demo/SKILL.md") },
          { name: "quiet", description: "", location: join(home, "skills/quiet/SKILL.md") },
        ],
        `${label}: adapter entry grammar drifted — COMPACT_SKILL_RE`,
      );
      assert.ok(!contextimate.getPromptRemainder(prompt).includes("<skills_instructions>"), `${label}: block not stripped from the runtime prompt row`);
    }
  },
);

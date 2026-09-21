// Pi emits <available_skills> only while read or bash is active. pi-codex-conversion
// swaps those tools out and re-injects the skill index per turn as a compact
// <codex_skills> list. Pin the installed adapter's output against contextimate's
// parser; skipped when the adapter is not installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  BuildSystemPromptOptions,
  NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";

import { internals as contextimate } from "../../extensions/pi-contextimate/index.ts";

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const codexConversionBuilder = join(homedir(), ".pi/agent/npm/node_modules/@howaboua/pi-codex-conversion/dist/prompt/build-system-prompt.js");

test(
  "contextimate parses the skills list the installed pi-codex-conversion builder emits",
  { skip: !existsSync(codexConversionBuilder) && "pi-codex-conversion not installed" },
  async () => {
    const pi = await import(pathToFileURL(join(piRoot, "dist/core/system-prompt.js")).href) as {
      buildSystemPrompt: (options: BuildSystemPromptOptions) => string;
      normalizeBuildSystemPromptOptions: (options: BuildSystemPromptOptions) => NormalizedBuildSystemPromptOptions;
    };
    // The package manager keeps peer dependencies outside this package's ESM lookup
    // ancestry. Pi's loader supplies them at runtime; make the same installed peer
    // explicit in a temporary copy so this direct deep-import contract can execute.
    const temp = mkdtempSync(join(tmpdir(), "pog-codex-builder-"));
    const testBuilder = join(temp, "build-system-prompt.mjs");
    const piModule = pathToFileURL(join(piRoot, "dist/index.js")).href;
    writeFileSync(
      testBuilder,
      readFileSync(codexConversionBuilder, "utf8")
        .replace('"@earendil-works/pi-coding-agent"', JSON.stringify(piModule)),
    );
    type CodexBuilder = {
      prepareCodexSystemPrompt: (options: NormalizedBuildSystemPromptOptions, config: {
        skills: { name: string; description: string; filePath: string }[];
        heavySystemPromptOverwrite: boolean;
      }) => void;
    };
    let codex: CodexBuilder;
    try {
      codex = await import(pathToFileURL(testBuilder).href) as CodexBuilder;
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    assert.equal(typeof codex.prepareCodexSystemPrompt, "function", "pi-codex-conversion builder moved — update this deep import");

    const home = homedir();
    const skills = [
      { name: "demo", description: "Does a demo & more", filePath: join(home, ".pi/agent/skills/demo/SKILL.md") },
      { name: "quiet", description: "", filePath: join(home, ".pi/agent/skills/quiet/SKILL.md") },
    ];
    const options = pi.normalizeBuildSystemPromptOptions({ cwd: tmpdir(), selectedTools: ["exec_command", "apply_patch"] });
    codex.prepareCodexSystemPrompt(options, { skills, heavySystemPromptOverwrite: false });
    const prompt = pi.buildSystemPrompt(options);
    const block = contextimate.parseSkillsBlock(prompt, 4);
    assert.ok(block, "adapter skills block format drifted");
    assert.deepEqual(
      block.skills.map(({ name, description, location }) => ({ name, description, location })),
      [
        { name: "demo", description: "Does a demo & more", location: join(home, ".pi/agent/skills/demo/SKILL.md") },
        { name: "quiet", description: "", location: join(home, ".pi/agent/skills/quiet/SKILL.md") },
      ],
      "adapter entry grammar drifted",
    );
    assert.ok(!contextimate.getPromptRemainder(prompt).includes("<codex_skills>"));
  },
);

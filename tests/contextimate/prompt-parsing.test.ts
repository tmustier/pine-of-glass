// System-prompt parsing against the hand-written fixture. The contract suite separately
// proves the fixture format matches what the installed pi actually emits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";

import { internals } from "../../extensions/pi-contextimate/index.ts";
import type { ToolSummary } from "../../extensions/pi-contextimate/index.ts";
import { fakePi, fixtureSystemPrompt, anthropicModel } from "../helpers.ts";

const {
  getPromptRemainder,
  parseSkills,
  parseContextSections,
  buildSkillsSection,
  AVAILABLE_SKILLS_RE,
  detectRuntimeAdditions,
  runtimeAdditionsAttribution,
  buildSnapshot,
} = internals;

test("context sections split per file with Global AGENTS.md special-cased", () => {
  const sections = parseContextSections(fixtureSystemPrompt(), 4);
  assert.equal(sections.length, 2);
  assert.equal(sections[0]!.title, "Global AGENTS.md");
  assert.equal(sections[1]!.title, "~/projects/demo/AGENTS.md");
  assert.ok(sections[0]!.content.includes("Prefer clarity &amp; precision"));
  assert.ok(sections[1]!.content.includes("Run the demo suite"));
});

test("skills parse with XML entities unescaped and stable ordering by tokens", () => {
  const match = fixtureSystemPrompt().match(AVAILABLE_SKILLS_RE);
  assert.ok(match, "fixture must contain the available_skills block");
  const skills = parseSkills(match![0], 4);
  assert.equal(skills.length, 3);
  const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]));
  assert.equal(byName["alpha-skill"]!.description, "Handles A & B cases with a long description so it sorts first in token order for the fixture.");
  assert.equal(byName["beta-skill"]!.description, "It's the medium one.");
  assert.equal(byName["gamma"]!.location, `${homedir()}/skills/gamma/SKILL.md`);
  // Token estimate covers the full skill XML span at the given denominator.
  for (const skill of skills) {
    assert.equal(skill.tokens, Math.ceil(skill.chars / 4));
  }
});

test("skills section accounts for wrapper markup separately and sorts by tokens", () => {
  const { section, skills } = buildSkillsSection(fixtureSystemPrompt(), 4);
  assert.ok(section);
  assert.equal(section!.title, "Skill frontmatter (3)");
  const skillChars = skills.reduce((sum, skill) => sum + skill.chars, 0);
  assert.ok(section!.content.length >= skillChars, "wrapper chars must be non-negative");
  const rows = section!.compactRows!;
  assert.deepEqual(rows.map((row) => row.name), ["alpha-skill", "beta-skill", "gamma"]);
  const tokens = rows.map((row) => row.tokens!);
  assert.deepEqual([...tokens].sort((a, b) => b - a), tokens, "rows sorted by tokens desc");
});

test("prompt remainder strips project context and skills blocks entirely", () => {
  const remainder = getPromptRemainder(fixtureSystemPrompt());
  assert.ok(!remainder.includes("<project_instructions"));
  assert.ok(!remainder.includes("<available_skills>"));
  assert.ok(!remainder.includes("alpha-skill"));
  assert.ok(remainder.includes("You are a fixture harness"));
  assert.ok(remainder.includes("Current date: 2026-06-09"));
});

test("runtime-addition attribution counts only verified, deduplicated prompt text (#9)", () => {
  const remainder = getPromptRemainder(fixtureSystemPrompt());
  const summarize = (name: string, guidelines: string[]): ToolSummary => ({
    name,
    description: "",
    source: "builtin",
    parameterKeys: [],
    schema: {},
    promptGuidelines: guidelines,
  });
  const shared = "Prefer rg over grep for searching.";
  const tools = [
    summarize("read", [shared]),
    summarize("bash", [shared]), // duplicate guideline — pi dedupes, so must count once
    summarize("search", ["Vary search query phrasing across angles."]), // absent from prompt
  ];
  const additions = detectRuntimeAdditions(remainder, tools);
  assert.equal(additions.snippetCount, 2, "read + bash snippet lines are present");
  assert.equal(additions.guidelineCount, 1, "shared guideline counted once, absent one not at all");
  const expectedChars =
    "- read: Read file contents".length + 1 +
    "- bash: Execute bash commands".length + 1 +
    shared.length + 1;
  assert.equal(additions.chars, expectedChars);

  const attribution = runtimeAdditionsAttribution(additions, 4)!;
  assert.ok(attribution.includes("2 tool snippets, 1 guideline"), attribution);
  assert.ok(attribution.includes("already counted in this row"), "must not read as an extra cost");
  assert.equal(runtimeAdditionsAttribution({ chars: 0, snippetCount: 0, guidelineCount: 0 }, 4), undefined);
});

test("system section: title renamed for #9 but id stays 'system' (config/signature compat)", () => {
  const snapshot = buildSnapshot(fakePi(), () => fixtureSystemPrompt(), undefined, () => undefined, () => anthropicModel, {});
  const system = snapshot.sections[0]!;
  assert.equal(system.id, "system");
  assert.equal(system.title, "Runtime system prompt");
  assert.ok(system.expanded && system.expanded.kind === "text");
  const expanded = system.expanded as { note?: string; attribution?: string };
  assert.ok(expanded.note!.includes("assembled at runtime"));
  assert.ok(expanded.attribution!.includes("tool/extension instructions"));
});

test("prompt without context/skills blocks degrades to remainder-only", () => {
  const bare = "Just a bare prompt with no blocks.";
  assert.deepEqual(parseContextSections(bare, 4), []);
  assert.deepEqual(buildSkillsSection(bare, 4), { skills: [] });
  assert.equal(getPromptRemainder(bare), bare);
});

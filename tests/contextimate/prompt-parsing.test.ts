// System-prompt parsing against the hand-written fixture. The contract suite separately
// proves the fixture format matches what the installed pi actually emits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";

import { getPromptRemainder, parseSkillsBlock, detectRuntimeAdditions } from "../../extensions/pi-contextimate/prompt-parsing.ts";
import { fixtureSystemPrompt, fixtureCodexSystemPrompt } from "../helpers.ts";

test("skills parse with XML entities unescaped and stable ordering by tokens", () => {
  const { skills } = parseSkillsBlock(fixtureSystemPrompt(), 4)!;
  assert.equal(skills.length, 3);
  const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]));
  assert.equal(byName["alpha-skill"]!.description, "Handles A & B cases with a long description so it sorts first in token order for the fixture.");
  assert.equal(byName["beta-skill"]!.description, "It's the medium one.");
  assert.equal(byName["gamma"]!.location, `${homedir()}/.pi/agent/skills/gamma/SKILL.md`);
  // Token estimate covers the full skill XML span at the given denominator.
  for (const skill of skills) {
    assert.equal(skill.tokens, Math.ceil(skill.chars / 4));
  }
});

test("prompt remainder strips project context and skills blocks entirely", () => {
  const remainder = getPromptRemainder(fixtureSystemPrompt());
  assert.ok(!remainder.includes("<project_instructions"));
  assert.ok(!remainder.includes("<available_skills>"));
  assert.ok(!remainder.includes("<skills>"));
  assert.ok(!remainder.includes("alpha-skill"));
  assert.ok(remainder.includes("You are a fixture harness"));
  assert.ok(remainder.includes("Current date: 2026-06-09"));
});

test("runtime-addition attribution counts only verified, deduplicated prompt text (#9)", () => {
  const remainder = getPromptRemainder(fixtureSystemPrompt());
  const shared = "Prefer rg over grep for searching.";
  const tools = [
    { name: "read", promptGuidelines: [shared] },
    { name: "bash", promptGuidelines: [shared] },
    { name: "search", promptGuidelines: ["Vary search query phrasing across angles."] },
  ];
  const additions = detectRuntimeAdditions(remainder, tools);
  assert.equal(additions.snippetCount, 2, "read + bash snippet lines are present");
  assert.equal(additions.guidelineCount, 1, "shared guideline counted once, absent one not at all");
  const expectedChars =
    "- read: Read file contents".length + 1 +
    "- bash: Execute bash commands".length + 1 +
    shared.length + 1;
  assert.equal(additions.chars, expectedChars);

});

test("compact <codex_skills> list parses into the same skills row as the XML index", () => {
  const prompt = fixtureCodexSystemPrompt();
  const { skills } = parseSkillsBlock(prompt, 4)!;
  const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]));
  assert.equal(byName["beta-skill"]!.description, "It's the medium one.", "description with a trailing newline");
  assert.equal(byName["gamma"]!.description, "", "empty description");
  assert.equal(byName["gamma"]!.location, `${homedir()}/.pi/agent/skills/gamma/SKILL.md`);

  const remainder = getPromptRemainder(prompt);
  assert.ok(!remainder.includes("<codex_skills>"));
  assert.ok(remainder.includes("Current working directory"));
});

test("the adapter's <skill_catalog> tag parses the same as <codex_skills>", () => {
  const renamed = fixtureCodexSystemPrompt().replaceAll("codex_skills>", "skill_catalog>");
  assert.deepEqual(parseSkillsBlock(renamed, 4)!.skills, parseSkillsBlock(fixtureCodexSystemPrompt(), 4)!.skills);
  assert.equal(getPromptRemainder(renamed), getPromptRemainder(fixtureCodexSystemPrompt()));
});

test("a skill index moved out of Pi's wrapper still parses into the skills row", () => {
  // pi-skill-gate cuts <available_skills> out of <skills> and appends the enabled entries.
  const native = fixtureSystemPrompt();
  const alpha = native.match(/ *<skill>\s*<name>alpha-skill[\s\S]*?<\/skill>/)![0];
  const gated = `${native.replace(/\n<available_skills>[\s\S]*?<\/available_skills>\n/, "\n")}\n<available_skills>\n${alpha}\n</available_skills>\n`;
  const { skills } = parseSkillsBlock(gated, 4)!;
  assert.deepEqual(skills.map((skill) => skill.name), ["alpha-skill"]);
  assert.ok(!getPromptRemainder(gated).includes("alpha-skill"));
});

test("prompt without context/skills blocks degrades to remainder-only", () => {
  const bare = "Just a bare prompt with no blocks.";
  assert.equal(parseSkillsBlock(bare, 4), undefined);
  assert.equal(getPromptRemainder(bare), bare);
});

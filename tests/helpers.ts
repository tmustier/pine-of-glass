// Shared fixtures and helpers for the pine-of-glass test suites. See docs/testing.md.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import type { Theme, ExtensionAPI, ToolInfo, ContextUsage } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import type { ModelSummary, SessionBreakdown } from "../extensions/pi-contextimate/index.ts";

export const testsDir = dirname(fileURLToPath(import.meta.url));
export const goldensDir = join(testsDir, "fixtures", "goldens");

export function assistantMessage(
  content: AssistantMessage["content"],
  overrides: Partial<Omit<AssistantMessage, "role" | "content">> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4-8",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// Theme stub: pass-through styling so golden files contain plain text. Colour correctness
// is not under test (see docs/testing.md non-goals); structure/alignment/wording are.
export const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_color: string, text: string) => text,
} as unknown as Theme;

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

// The Ctrl+O hint in the estimator header comes from the user's live keybinding config
// (`keyText("app.tools.expand")`), which is machine-dependent. Normalize it so goldens
// are stable across machines.
export function normalizeKeyHints(text: string): string {
  return text.replace(/^(\s*)\S+(: cycle view)/gm, "$1<expand-key>$2");
}

// ---------------------------------------------------------------------------------------
// Golden comparison. Regenerate with UPDATE_GOLDENS=1; review the diff like code.
export function expectGolden(name: string, content: string): void {
  const goldenPath = join(goldensDir, name);
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  if (process.env.UPDATE_GOLDENS === "1") {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, normalized);
    return;
  }
  assert.ok(
    existsSync(goldenPath),
    `golden ${name} missing — run UPDATE_GOLDENS=1 npm test and review the new file`,
  );
  assert.equal(
    normalized,
    readFileSync(goldenPath, "utf8"),
    `golden ${name} drifted — if intentional, regenerate with UPDATE_GOLDENS=1 npm test and review the diff`,
  );
}

// ---------------------------------------------------------------------------------------
// Contextimate fixtures.

export const anthropicModel: ModelSummary = {
  provider: "anthropic",
  id: "claude-opus-4-8",
  api: "anthropic-messages",
};

export const codexModel: ModelSummary = {
  provider: "openai-codex",
  id: "gpt-5.5",
  api: "openai-codex-responses",
};

export const fixtureContextUsage: ContextUsage = {
  tokens: 64321,
  contextWindow: 200000,
  percent: 32.2,
};

export const fixtureSession: SessionBreakdown = {
  thinkingSummaryChars: 1200,
  reasoningTokens: 12000,
  toolOutputChars: 52340,
  messageChars: 8120,
  messageCount: 14,
  contextUsageEstimated: false,
  measuredToolOutputTokens: 0,
  measuredToolOutputChars: 0,
};

// Hand-written system prompt matching the format the contract suite proves pi emits.
// Includes XML entities, two context files (one the Global AGENTS.md special case), and
// three skills, so parsing + unescaping + wrapper math are all exercised.
export function fixtureSystemPrompt(): string {
  const home = homedir();
  return `You are a fixture harness for pine-of-glass tests.

Available tools:
- read: Read file contents
- bash: Execute bash commands

Guidelines:
- Prefer rg over grep for searching.

<project_context>
Project-specific instructions and guidelines:

<project_instructions path="${home}/.pi/agent/AGENTS.md">
# Global guidance
Prefer clarity &amp; precision in every reply.
</project_instructions>

<project_instructions path="${home}/projects/demo/AGENTS.md">
# Demo project
Run the demo suite before committing.
</project_instructions>
</project_context>

<skills>
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>alpha-skill</name>
    <description>Handles A &amp; B cases with a long description so it sorts first in token order for the fixture.</description>
    <location>${home}/.pi/agent/skills/alpha/SKILL.md</location>
  </skill>
  <skill>
    <name>beta-skill</name>
    <description>It&apos;s the medium one.</description>
    <location>${home}/.pi/agent/skills/beta/SKILL.md</location>
  </skill>
  <skill>
    <name>gamma</name>
    <description>Tiny.</description>
    <location>${home}/.pi/agent/skills/gamma/SKILL.md</location>
  </skill>
</available_skills>
</skills>

Current date: 2026-06-09`;
}

// The same three skills as fixtureSystemPrompt, in pi-codex-conversion's compact form.
export function fixtureCodexSystemPrompt(): string {
  const home = homedir();
  return `You are a fixture harness for pine-of-glass tests.

Guidelines:
- Prefer rg over grep for searching.

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="${home}/.pi/agent/AGENTS.md">
# Global guidance
Prefer clarity &amp; precision in every reply.
</project_instructions>

</project_context>

<codex_skills>
## Skills
### Available skills
- alpha-skill: Handles A & B cases with a long description so it sorts first in token order for the fixture. (file: ${home}/.pi/agent/skills/alpha/SKILL.md)
- beta-skill: It's the medium one.
 (file: ${home}/.pi/agent/skills/beta/SKILL.md)
- gamma:  (file: ${home}/.pi/agent/skills/gamma/SKILL.md)
### How to use skills
- Use skill when user names it or request clearly matches its description
</codex_skills>

Current working directory: ${home}/projects/demo`;
}

export const fixtureTools: ToolInfo[] = [
  {
    name: "read",
    exposure: "direct",
    description: "Read the contents of a file.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read" }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
    }),
    // read and bash share one guideline: pi dedupes repeated guidelines in the prompt,
    // and detectRuntimeAdditions must count the shared text once.
    promptGuidelines: ["Prefer rg over grep for searching."],
    sourceInfo: { scope: "temporary", source: "builtin", origin: "top-level", path: "<builtin:read>" },
  },
  {
    name: "bash",
    exposure: "direct",
    description: "Execute a bash command in the current working directory.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
    }),
    promptGuidelines: ["Prefer rg over grep for searching."],
    sourceInfo: { scope: "temporary", source: "builtin", origin: "top-level", path: "<builtin:bash>" },
  },
  {
    name: "search",
    exposure: "direct",
    description: "Search the web with one or more queries.",
    parameters: Type.Object({
      queries: Type.Array(Type.Object({
        text: Type.String({ description: "Query text" }),
        recency: Type.Optional(Type.String({ enum: ["day", "week"], description: "Recency filter" })),
      }), { description: "Queries searched in sequence" }),
      options: Type.Optional(Type.Object({
        numResults: Type.Optional(Type.Number({ description: "Results per query" })),
      }, { description: "Search options" })),
    }),
    // A guideline that is NOT present in the fixture prompt: must not be attributed.
    promptGuidelines: ["Vary search query phrasing across angles."],
    sourceInfo: { scope: "user", source: "npm:fixture-pack", origin: "package", path: `${homedir()}/.pi/agent/npm/fixture/search.ts` },
  },
  {
    name: "write",
    exposure: "direct",
    description: "Write content to a file.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to write" }),
      content: Type.String({ description: "Content to write" }),
    }),
    sourceInfo: { scope: "temporary", source: "builtin", origin: "top-level", path: "<builtin:write>" },
  },
];

export function fakePi(options: { activeTools?: string[]; tools?: ToolInfo[] } = {}): Pick<ExtensionAPI, "getActiveTools" | "getAllTools"> {
  const tools = options.tools ?? fixtureTools;
  const active = options.activeTools ?? ["read", "bash", "search"];
  return {
    getActiveTools: () => active,
    getAllTools: () => tools,
  };
}

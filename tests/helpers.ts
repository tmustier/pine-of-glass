// Shared fixtures and helpers for the pine-of-glass test suites. See docs/testing.md.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import type { Theme, ExtensionAPI, ToolInfo, ContextUsage } from "@earendil-works/pi-coding-agent";

import type { ModelSummary, SessionBreakdown } from "../extensions/pi-contextimate/index.ts";

export const testsDir = dirname(fileURLToPath(import.meta.url));
export const goldensDir = join(testsDir, "fixtures", "goldens");

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
} as ContextUsage;

export const fixtureSession: SessionBreakdown = {
  thinkingChars: 12000,
  toolOutputChars: 52340,
  messageChars: 8120,
  messageCount: 14,
};

// Hand-written system prompt matching the format the contract suite proves pi emits.
// Includes XML entities, two context files (one the Global AGENTS.md special case), and
// three skills, so parsing + unescaping + wrapper math are all exercised.
export function fixtureSystemPrompt(): string {
  const home = homedir();
  return `You are a fixture harness for pine-of-glass tests.

Tooling guidelines: use the read tool before the edit tool.

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


The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill when the task matches its description.

<available_skills>
  <skill>
    <name>alpha-skill</name>
    <description>Handles A &amp; B cases with a long description so it sorts first in token order for the fixture.</description>
    <location>${home}/skills/alpha/SKILL.md</location>
  </skill>
  <skill>
    <name>beta-skill</name>
    <description>It&apos;s the medium one.</description>
    <location>${home}/skills/beta/SKILL.md</location>
  </skill>
  <skill>
    <name>gamma</name>
    <description>Tiny.</description>
    <location>${home}/skills/gamma/SKILL.md</location>
  </skill>
</available_skills>
Current date: 2026-06-09`;
}

export const fixtureTools: ToolInfo[] = [
  {
    name: "read",
    description: "Read the contents of a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read" },
        offset: { type: "number", description: "Line number to start reading from" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
    sourceInfo: { scope: "temporary", source: "builtin", origin: "top-level", path: "<builtin:read>" },
  },
  {
    name: "bash",
    description: "Execute a bash command in the current working directory.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeout: { type: "number", description: "Timeout in seconds" },
      },
      required: ["command"],
    },
    sourceInfo: { scope: "temporary", source: "builtin", origin: "top-level", path: "<builtin:bash>" },
  },
  {
    name: "search",
    description: "Search the web with one or more queries.",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          description: "Queries searched in sequence",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "Query text" },
              recency: { type: "string", enum: ["day", "week"], description: "Recency filter" },
            },
            required: ["text"],
          },
        },
        options: {
          type: "object",
          description: "Search options",
          properties: {
            numResults: { type: "number", description: "Results per query" },
          },
        },
      },
      required: ["queries"],
    },
    sourceInfo: { scope: "user", source: "npm:fixture-pack", origin: "package", path: `${homedir()}/.pi/agent/npm/fixture/search.ts` },
  },
  {
    name: "write",
    description: "Write content to a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
    sourceInfo: { scope: "temporary", source: "builtin", origin: "top-level", path: "<builtin:write>" },
  },
] as unknown as ToolInfo[];

export function fakePi(options: { activeTools?: string[]; tools?: ToolInfo[] } = {}): ExtensionAPI {
  const tools = options.tools ?? fixtureTools;
  const active = options.activeTools ?? ["read", "bash", "search"];
  return {
    getActiveTools: () => active,
    getAllTools: () => tools,
  } as unknown as ExtensionAPI;
}

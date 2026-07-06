// Visual regression net for the one-line trace grammar (design language §10):
// a realistic scripted sequence — repeated cd preambles, a dropped set-hygiene run, a
// newline-preamble context fold, a paginated read run, healthy and ballooned outputs, a
// flattened multiline command — rendered at 80 and 120 columns.
// Colour is not under test (see docs/testing.md); structure, alignment, folding, and
// wording are. Regenerate with UPDATE_GOLDENS=1 npm test and review the diff like code.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";

import { internals } from "../../extensions/pi-traceline/index.ts";
import { expectGolden } from "../helpers.ts";

const { renderTraceRow, stripAnsi, isToolRow, dedupeThinkingLabels } = internals;

const g = globalThis as Record<string, unknown>;

function bash(command: string, options: { rendered?: string[]; chars?: number; text?: string; error?: boolean; running?: boolean } = {}) {
  return {
    toolName: "bash",
    args: { command },
    result: options.running
      ? undefined
      : { content: [{ type: "text", text: options.text ?? "x".repeat(options.chars ?? 200) }], isError: options.error === true },
    isPartial: options.running === true,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => options.rendered ?? [`$ ${command} (timeout 30s)`] },
  };
}

function read(path: string, offset: number, limit: number, chars: number) {
  return {
    toolName: "read",
    args: { path, offset, limit },
    result: { content: [{ type: "text", text: "x".repeat(chars) }], isError: false },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [`read ${path}:${offset}-${offset + limit - 1}`] },
  };
}

function mutation(toolName: string, path: string, diff: string, chars: number) {
  return {
    toolName,
    args: { path },
    result: { content: [{ type: "text", text: "x".repeat(chars) }], isError: false, details: { diff } },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [`${toolName} ${path}`] },
  };
}

function prose(text: string) {
  return {
    setHideThinkingBlock: () => {},
    hideThinkingBlock: false,
    lastMessage: { content: [{ type: "text", text }] },
    __prose: text,
  };
}

function thinking(text: string) {
  return {
    setHideThinkingBlock: () => {},
    hideThinkingBlock: true,
    hiddenThinkingLabel: "Thinking...",
    lastMessage: { content: [{ type: "thinking", thinking: text }] },
    __thinking: true,
  };
}

beforeEach(() => {
  g.__tracelineChat = undefined;
  g.__tracelineGetTheme = undefined;
});

test("one-line trace goldens at 80 and 120 columns", () => {
  const repo = `${homedir()}/projects/pine-of-glass`;
  const children = [
    prose("Let me look at the failing suite."),
    bash(`cd ${repo} && npm test 2>/dev/null | tail -5`, { chars: 1_437 }),
    thinking("Checking the typecheck before the next command.\nThe previous test output was noisy."),
    bash(`cd ${repo} && npm run typecheck`, { chars: 14_200 }),
    read(`${repo}/extensions/pi-cachemire/index.ts`, 1, 200, 18_400),
    read(`${repo}/extensions/pi-cachemire/index.ts`, 201, 200, 18_400),
    read(`${repo}/extensions/pi-cachemire/index.ts`, 401, 200, 14_300),
    bash(`cd ${repo} && rm -f /tmp/pog-scratch.txt`, { chars: 0 }),
    prose("Measuring the bash-corpus census before and after the rule change."),
    bash(`set -euo pipefail\ncd ${repo}\nuv run scripts/dev/bash-corpus/report.ts --census out/before.json`, {
      rendered: ["$ set -euo pipefail", `cd ${repo}`, "uv run scripts/dev/bash-corpus/report.ts --census out/before.json (timeout 120s)"],
      chars: 2_100,
    }),
    bash(`set -euo pipefail\ncd ${repo}\nuv run scripts/dev/bash-corpus/report.ts --census out/after.json`, {
      rendered: ["$ set -euo pipefail", `cd ${repo}`, "uv run scripts/dev/bash-corpus/report.ts --census out/after.json (timeout 120s)"],
      chars: 2_050,
    }),
    prose("The typecheck output looks wrong — checking the runner script."),
    bash("python3 -c '...'", {
      rendered: ["$ python3 -c '", "  import json", "  print(json.dumps(cfg))", "  ' | tail -2 (timeout 70s)"],
      chars: 56_300,
      error: true,
    }),
    prose("The runner mangles the config — patching it and logging the pass."),
    mutation("edit", `${repo}/scripts/dev/screenshots/rig.mjs`, `${"+x\n".repeat(4)}${"-x\n".repeat(9)}`, 210),
    mutation("edit", `${repo}/scripts/dev/screenshots/ansi2html.mjs`, "-x\n", 180),
    mutation("write", `${repo}/worklog/2026-07-02-rig-fix.md`, "+x\n".repeat(18), 120),
    prose("Fixed — committing and shipping the release."),
    bash(`cd ${repo} && git add -A && git -c user.email=6326440+tmustier@users.noreply.github.com commit -m "traceline: records of consequence" && git push`, {
      text: `[main a4f21c9] traceline: records of consequence\n 3 files changed, 210 insertions(+)\nTo https://github.com/tmustier/pine-of-glass.git\n   50cf33f..a4f21c9  main -> main\n`,
    }),
    bash("gh pr merge 87 --squash --delete-branch", {
      text: "✓ Squashed and merged pull request tmustier/pine-of-glass#87 (traceline: records)\n✓ Deleted branch git-records\n",
    }),
    bash("git status --short", { running: true }),
  ];
  g.__tracelineChat = { children };

  const renderAt = (width: number): string => {
    const lines: string[] = [];
    for (const child of children) {
      if (isToolRow(child)) {
        for (const line of renderTraceRow(child, width)) lines.push(stripAnsi(line));
        continue;
      }
      const meta = child as { __prose?: string; __thinking?: boolean };
      const marker = meta.__prose ?? stripAnsi(dedupeThinkingLabels(child, ["Thinking..."], width)[0] ?? "Thinking...");
      lines.push("", marker);
    }
    return `${lines.join("\n")}\n`;
  };

  expectGolden("traceline-rows-80.txt", renderAt(80));
  expectGolden("traceline-rows-120.txt", renderAt(120));

  // The golden never exceeds its width budget.
  for (const width of [80, 120]) {
    for (const line of renderAt(width).split("\n")) {
      assert.ok(line.length <= width, `line exceeds ${width} cols: ${JSON.stringify(line)}`);
    }
  }
});

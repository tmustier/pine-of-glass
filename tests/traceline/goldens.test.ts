// Visual regression net for the one-line trace grammar (design language §10):
// a realistic scripted sequence — repeated cd preambles, a dropped set-hygiene run, a
// newline-preamble context fold, a grouped multiline thinking preview, a paginated read
// run, healthy and ballooned outputs, and a flattened multiline command, rendered at 80
// and 120 columns.
// Colour is not under test (see docs/testing.md); structure, alignment, folding, and
// wording are. Regenerate with UPDATE_GOLDENS=1 npm test and review the diff like code.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { internals } from "../../extensions/pi-traceline/index.ts";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";
import { expectGolden } from "../helpers.ts";
import { assistantBefore, completedWriteRow, nativeBashLines } from "./runtime-fixtures.ts";

const {
  renderTraceRow,
  stripAnsi,
  isToolRow,
  dedupeThinkingLabels,
  setTracelineChat,
  setTracelineThemeGetter,
} = internals;

function bash(
  command: string,
  options: { timeout?: number; chars?: number; text?: string; error?: boolean; running?: boolean } = {},
): ToolRowLike {
  const timeout = options.timeout ?? 30;
  return {
    toolName: "bash",
    args: { command, timeout },
    result: options.running
      ? undefined
      : { content: [{ type: "text", text: options.text ?? "x".repeat(options.chars ?? 200) }], isError: options.error === true },
    isPartial: options.running === true,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => nativeBashLines(command, timeout) },
  } as ToolRowLike;
}

function read(path: string, offset: number, limit: number, chars: number): ToolRowLike {
  return {
    toolName: "read",
    args: { path, offset, limit },
    result: { content: [{ type: "text", text: "x".repeat(chars) }], isError: false },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [`read ${path}:${offset}-${offset + limit - 1}`] },
  } as ToolRowLike;
}

function edit(path: string, diff: string, chars: number): ToolRowLike {
  return {
    toolName: "edit",
    args: { path },
    result: { content: [{ type: "text", text: "x".repeat(chars) }], isError: false, details: { diff } },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [`edit ${path}`] },
  } as ToolRowLike;
}

function prose(text: string, rows: ToolRowLike[]) {
  return { ...assistantBefore(rows, [{ type: "text", text }]), __prose: text };
}

function thinking(blocks: string[], rows: ToolRowLike[]) {
  return {
    ...assistantBefore(rows, blocks.map((text) => ({ type: "thinking", thinking: text })), true),
    __thinkingBlocks: blocks.length,
  };
}

beforeEach(() => {
  setTracelineChat(undefined);
  setTracelineThemeGetter(undefined);
});

test("one-line trace goldens at 80 and 120 columns", () => {
  const repo = `${homedir()}/projects/pine-of-glass`;
  const writeCwd = mkdtempSync(join(tmpdir(), "traceline-golden-write-"));
  try {
    const testRun = bash(`cd ${repo} && npm test 2>/dev/null | tail -5`, { chars: 1_437 });
    const typecheck = bash(`cd ${repo} && npm run typecheck`, { chars: 14_200 });
    const read1 = read(`${repo}/extensions/pi-cachemire/index.ts`, 1, 200, 18_400);
    const read2 = read(`${repo}/extensions/pi-cachemire/index.ts`, 201, 200, 18_400);
    const read3 = read(`${repo}/extensions/pi-cachemire/index.ts`, 401, 200, 14_300);
    const cleanup = bash(`cd ${repo} && rm -f /tmp/pog-scratch.txt`, { chars: 0 });
    const censusBefore = bash(
      `set -euo pipefail\ncd ${repo}\nuv run scripts/dev/bash-corpus/report.ts --census out/before.json`,
      { timeout: 120, chars: 2_100 },
    );
    const censusAfter = bash(
      `set -euo pipefail\ncd ${repo}\nuv run scripts/dev/bash-corpus/report.ts --census out/after.json`,
      { timeout: 120, chars: 2_050 },
    );
    const pythonCommand = ["python3 -c '", "  import json", "  print(json.dumps(cfg))", "  ' | tail -2"].join("\n");
    const python = bash(pythonCommand, { timeout: 70, chars: 56_300, error: true });
    const rigEdit = edit(`${repo}/scripts/dev/screenshots/rig.mjs`, `${"+x\n".repeat(4)}${"-x\n".repeat(9)}`, 210);
    const ansiEdit = edit(`${repo}/scripts/dev/screenshots/ansi2html.mjs`, "-x\n", 180);
    const worklogWrite = completedWriteRow(writeCwd, "worklog/2026-07-02-rig-fix.md", "x\n".repeat(18));
    const commit = bash(`cd ${repo} && git add -A && git -c user.email=6326440+tmustier@users.noreply.github.com commit -m "traceline: records of consequence" && git push`, {
      text: `[main a4f21c9] traceline: records of consequence\n 3 files changed, 210 insertions(+)\nTo https://github.com/tmustier/pine-of-glass.git\n   50cf33f..a4f21c9  main -> main\n`,
    });
    const merge = bash("gh pr merge 87 --squash --delete-branch", {
      text: "✓ Squashed and merged pull request tmustier/pine-of-glass#87 (traceline: records)\n✓ Deleted branch git-records\n",
    });
    const status = bash("git status --short", { running: true });

    const children = [
      prose("Let me look at the failing suite.", [testRun]),
      testRun,
      thinking([
        "Checking the typecheck before the next command.",
        "The previous test output was noisy.",
        "Reading the paginated file next.",
      ], [typecheck, read1, read2, read3, cleanup]),
      typecheck,
      read1,
      read2,
      read3,
      cleanup,
      prose("Measuring the bash-corpus census before and after the rule change.", [censusBefore, censusAfter]),
      censusBefore,
      censusAfter,
      prose("The typecheck output looks wrong — checking the runner script.", [python]),
      python,
      prose("The runner mangles the config — patching it and logging the pass.", [rigEdit, ansiEdit, worklogWrite]),
      rigEdit,
      ansiEdit,
      worklogWrite,
      prose("Fixed — committing and shipping the release.", [commit, merge, status]),
      commit,
      merge,
      status,
    ];
    setTracelineChat({ children });

    const renderAt = (width: number): string => {
      const lines: string[] = [];
      for (const child of children) {
        if (isToolRow(child)) {
          for (const line of renderTraceRow(child, width)) lines.push(stripAnsi(line));
          continue;
        }
        const meta = child as { __prose?: string; __thinkingBlocks?: number };
        if (meta.__prose !== undefined) {
          lines.push("", meta.__prose);
          continue;
        }
        const nativeLabels = Array.from({ length: meta.__thinkingBlocks ?? 1 }, (_, index) =>
          index === 0 ? ["Thinking..."] : ["", "Thinking..."]
        ).flat();
        const previews = dedupeThinkingLabels(child, nativeLabels, width).map(stripAnsi);
        lines.push("", ...(previews.length > 0 ? previews : ["Thinking..."]));
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
  } finally {
    setTracelineChat(undefined);
    rmSync(writeCwd, { recursive: true, force: true });
  }
});

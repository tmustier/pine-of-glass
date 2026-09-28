// Contract: traceline's call capture (extensions/pi-traceline/call-capture.ts) assumes Pi's
// call renderers wrap greedily and pad to width, so two bounded renders that agree prove the
// 10,000-column result. Asserted against the installed Pi's own components: when Pi's wrap or
// padding changes, these fail and name the capture as the dependent seam.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as pi from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import type { ToolArgsLike } from "../../extensions/_lib/chat.ts";
import { captureCallLines } from "../../extensions/pi-traceline/call-capture.ts";
import { summarizeCallLines } from "../../extensions/pi-traceline/call-summary.ts";

const WIDE = 10_000;
const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");

type CallRenderer = { render(width: number): string[] };
type CaptureProbe = { call: CallRenderer; widths: number[] };
type ToolRowWithCall = { callRendererComponent?: CallRenderer };
type ToolRenderers = ConstructorParameters<typeof pi.ToolExecutionComponent>[4];

/** Record the widths a capture asks for while rendering the real component. */
function recorded(call: CallRenderer): CaptureProbe {
  const widths: number[] = [];
  return { widths, call: { render: (width: number) => (widths.push(width), call.render(width)) } };
}

function wideLines(call: CallRenderer): string[] {
  return call.render(WIDE);
}

// What the one-line path consumes: ANSI-kept summary and the plain flattened text.
function assertSameAsWide(call: CallRenderer, args: ToolArgsLike, label: string): number[] {
  const probe = recorded(call);
  const captured = captureCallLines(probe.call, args);
  const wide = wideLines(call);
  assert.ok(captured, `${label}: traceline call capture returned nothing`);
  assert.equal(captured.length, wide.length, `${label}: bounded capture line count drifted from Pi's wide render; traceline call capture breaks`);
  assert.equal(summarizeCallLines(captured), summarizeCallLines(wide), `${label}: one-line summary drifted from the wide capture; traceline invocation rows change`);
  assert.deepEqual(
    captured.map((line) => stripAnsi(line).trimEnd()),
    wide.map((line) => stripAnsi(line).trimEnd()),
    `${label}: bounded capture text drifted from Pi's wide render; traceline call capture breaks`,
  );
  return probe.widths;
}

// A pi-shaped call shell: Box with a background around a Text, both padding to width.
function shell(text: string): CallRenderer {
  const box = new Box(1, 1, (line: string) => `\x1b[48;5;236m${line}\x1b[49m`);
  box.addChild(new Text(text, 0, 0));
  return box;
}

function seeded(seed: number): (n: number) => number {
  let state = seed;
  return (n) => ((state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff) % n);
}

test("bounded capture matches the wide capture for any wrapped, wide or styled text", () => {
  const pick = seeded(7);
  const word = (): string => {
    const kind = pick(10);
    if (kind === 0) return "漢字表".repeat(1 + pick(40));
    if (kind === 1) return `\x1b[1m${"b".repeat(1 + pick(30))}\x1b[22m`;
    if (kind === 2) return "w".repeat(200 + pick(1000)); // wraps at one or both bounded widths
    return "x".repeat(1 + pick(24));
  };
  const gap = (): string => (pick(40) === 0 ? " ".repeat(40 + pick(3_000)) : pick(12) === 0 ? "\n" : " ".repeat(1 + pick(3)));
  let wideFallbacks = 0;
  for (let run = 0; run < 400; run++) {
    let text = word();
    for (let i = pick(60); i > 0; i--) text += gap() + word();
    const widths = assertSameAsWide(shell(text), { command: text }, `run ${run}`);
    if (widths.includes(WIDE)) wideFallbacks++;
    else assert.ok(widths.every((w) => w < WIDE), `run ${run}: bounded capture asked for ${widths}`);
  }
  assert.ok(wideFallbacks > 20 && wideFallbacks < 380, `both paths must be exercised, got ${wideFallbacks} fallbacks`);
});

test("a wrap at a short space run is not mistaken for an unwrapped line", () => {
  // This wraps identically at 256 and 512 columns; only the check width's space allowance
  // tells the pair apart from the one-line wide render.
  const text = `${"a".repeat(250)}${" ".repeat(20)}${"b".repeat(250)}`;
  assertSameAsWide(shell(text), { command: text }, "short space run at the wrap");
});

test("real pi call components capture at bounded widths and match the wide capture", async () => {
  pi.initTheme(undefined, false);
  const { withBuiltInRenderers } = await import(pathToFileURL(join(piRoot, "dist/core/tools/renderers/index.js")).href) as {
    withBuiltInRenderers: (toolName: string, definition: undefined) => ToolRenderers;
  };
  const cwd = mkdtempSync(join(tmpdir(), "pog-capture-"));
  let id = 0;
  const real = (toolName: string, args: ToolArgsLike) => {
    const comp = new pi.ToolExecutionComponent(
      toolName, `capture-${++id}`, args, undefined, withBuiltInRenderers(toolName, undefined), {} as never, cwd,
    );
    // SAFETY: callRendererComponent is the traceline seam pinned in tests/contract/pi-internals.test.ts.
    const call = (comp as unknown as ToolRowWithCall).callRendererComponent;
    assert.ok(call, `${toolName} call component missing`);
    return call;
  };

  const heredoc = `cat > notes.md <<'EOF'\n${Array.from({ length: 40 }, (_, i) => `line ${i}: ${"word ".repeat(i % 9)}`).join("\n")}\nEOF`;
  const bounded: Array<[string, string, ToolArgsLike]> = [
    ["bash one line", "bash", { command: "npm run check 2>&1 | tail -20", timeout: 120 }],
    ["bash heredoc", "bash", { command: heredoc }],
    ["read range", "read", { path: join(cwd, "src/index.ts"), offset: 10, limit: 40 }],
    ["write", "write", { path: join(cwd, "out.ts"), content: Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join("\n") }],
    ["bash line past the first pair", "bash", { command: `echo ${"z".repeat(400)}` }],
  ];
  for (const [label, toolName, args] of bounded) {
    const widths = assertSameAsWide(real(toolName, args), args, label);
    assert.ok(!widths.includes(WIDE), `${label}: fell back to the wide capture (${widths})`);
  }

  const wide: Array<[string, string, ToolArgsLike]> = [
    ["bash line over every bounded width", "bash", { command: `echo ${"y".repeat(1_500)}` }],
    ["bash with a long space run", "bash", { command: `printf 'a${" ".repeat(80)}b'` }],
  ];
  for (const [label, toolName, args] of wide) {
    const widths = assertSameAsWide(real(toolName, args), args, label);
    assert.ok(widths.includes(WIDE), `${label}: must fall back to the wide capture (${widths})`);
  }
});

test("a row without a call component captures nothing", () => {
  assert.equal(captureCallLines(undefined, {}), undefined);
});

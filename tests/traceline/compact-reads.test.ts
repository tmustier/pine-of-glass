import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { internals } from "../../extensions/pi-traceline/index.ts";
import { compactReadDisplay } from "../../extensions/pi-traceline/path-rows.ts";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";

const { oneLine, stripAnsi, setTracelineChat, setTracelineThemeGetter } = internals;
const CODES: Record<string, number> = { dim: 245, text: 255, success: 41, warning: 220, accent: 214 };
const ansi = (role: string) => `\x1b[38;5;${CODES[role]}m`;

function themed(): Theme {
  return {
    fg: (role: string, text: string) => `${ansi(role)}${text}\x1b[39m`,
    bold: (text: string) => text,
    bg: (_role: string, text: string) => text,
  } as Theme;
}

beforeEach(() => {
  setTracelineChat(undefined);
  setTracelineThemeGetter(undefined);
});

test("compact read labels parse without swallowing the line range", () => {
  assert.deepEqual(compactReadDisplay("read docs docs/extensions.md:1-200", ":1-200"), {
    classification: "docs",
    path: "docs/extensions.md",
  });
  assert.deepEqual(compactReadDisplay("read resource AGENTS.md", ""), {
    classification: "resource",
    path: "AGENTS.md",
  });
  assert.equal(compactReadDisplay("read ~/projects/demo/file.ts:1-200", ":1-200"), undefined);
});

test("compact Pi docs reads keep their label but use ordinary filename ink (§9.5)", () => {
  setTracelineThemeGetter(() => themed());
  const comp = {
    toolName: "read",
    args: { path: "/opt/pi-coding-agent/docs/extensions.md", offset: 1364, limit: 1400 },
    result: { content: [{ type: "text", text: "x".repeat(1437) }], isError: false },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: {
      render: () => [
        `${ansi("accent")}\x1b[1mread docs\x1b[22m\x1b[39m ${ansi("accent")}docs/extensions.md\x1b[39m${ansi("warning")}:1364-2763\x1b[39m`,
      ],
    },
  } as ToolRowLike;

  const line = oneLine(comp, 100);
  const visible = stripAnsi(line);
  assert.ok(visible.includes("read docs docs/extensions.md:1364-2763"), visible);
  assert.ok(line.includes(`${ansi("dim")}docs docs/\x1b[39m`), "classification and directory must be dim");
  assert.ok(line.includes(`${ansi("text")}\x1b[1mextensions.md\x1b[22m`), "filename must be neutral-bold");
  assert.ok(line.includes(`${ansi("warning")}:1364-2763\x1b[39m`), "line range must stay warning-coloured");
  assert.ok(!line.includes(`${ansi("accent")}docs/extensions.md`), "native accent path must not survive");
});

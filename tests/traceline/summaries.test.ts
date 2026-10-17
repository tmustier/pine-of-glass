// Summaries (design language §9.15), hosted through Pi's SDK with a scripted summary
// model registered through the public provider API, so every request it gets is counted
// and nothing leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { stripAnsi } from "../../extensions/_lib/ansi.ts";
import type { AssistantRowDataLike, ToolRowLike } from "../../extensions/_lib/chat.ts";
import piTraceline, { internals } from "../../extensions/pi-traceline/index.ts";
import { SUMMARY_ENTRY } from "../../extensions/pi-traceline/summaries.ts";
import { installThinkingPreviews } from "../../extensions/pi-traceline/thinking-preview.ts";
import { assistantMessage } from "../helpers.ts";
import { hostExtension, IsolatedProject, type HostedExtension } from "../harness/extension-host.ts";
import { nativeBashLines } from "./runtime-fixtures.ts";

const { renderTraceRow, setTracelineThemeGetter } = internals;
initTheme(undefined, false);

const PROVIDER = "pog-summaries";
type Asked = { kind: string; text: string };

/** A summary model that answers every item with `gist <n>`, or with `reply` when given, after `delay` ms. */
function summaryModel(asked: Asked[][], reply?: string, delay = 0) {
  return (pi: ExtensionAPI) => pi.registerProvider(PROVIDER, {
    baseUrl: "http://127.0.0.1:9",
    apiKey: "fixture-never-sent",
    api: "openai-completions",
    models: [{ id: "gist", name: "Gist", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 }],
    streamSimple: (_model, context) => {
      const user = context.messages.find((message) => message.role === "user");
      const content = user?.role === "user" ? user.content : "";
      const items: { id: string; kind: string; text: string }[] = JSON.parse(typeof content === "string" ? content : content.map((block) => (block.type === "text" ? block.text : "")).join(""));
      asked.push(items.map(({ kind, text }) => ({ kind, text })));
      const gists = Object.fromEntries(items.map(({ id }) => [id, `gist ${asked.flat().length - items.length + Number(id)}`]));
      const message: AssistantMessage = assistantMessage([{ type: "text", text: reply ?? JSON.stringify(gists) }], { provider: PROVIDER, model: "gist", api: "openai-completions" });
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      }, delay);
      return stream;
    },
  });
}

function bash(command: string, output?: string): ToolRowLike {
  return {
    toolName: "bash",
    args: { command },
    ...(output === undefined ? {} : { result: { content: [{ type: "text", text: output }], isError: false } }),
    isPartial: output === undefined,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => nativeBashLines(command) },
  } as ToolRowLike;
}

const LONG = "cd ~/projects/slack-bridge && git add -A && pnpm lint && pnpm typecheck && npx prettier --check . && git commit -m \"Fix the bridge\"";
const lines = (row: ToolRowLike, width = 90) => renderTraceRow(row, width).map((line) => stripAnsi(line).trimEnd());
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

async function hosted(project: IsolatedProject, asked: Asked[][], check: (host: HostedExtension) => Promise<void>, reply?: string, sessionManager?: HostedExtension["session"]["sessionManager"]) {
  const host = await hostExtension((pi) => {
    summaryModel(asked, reply)(pi);
    piTraceline(pi);
  }, { project, sessionManager });
  try {
    await check(host);
  } finally {
    await host.dispose();
  }
}

test("summaries are off unless the user's own file turns them on", async () => {
  const project = new IsolatedProject();
  try {
    const asked: Asked[][] = [];
    const row = bash(LONG, "ok");
    await hosted(project, asked, async () => {
      lines(row);
      await settle();
      assert.ok(!lines(row).some((line) => line.includes("≈")));
    });
    project.writeProjectConfig("pi-traceline", { summaries: { model: `${PROVIDER}/gist` } });
    await hosted(project, asked, async () => {
      lines(row);
      await settle();
      assert.ok(!lines(row).some((line) => line.includes("≈")));
    });
    assert.deepEqual(asked, []);
  } finally {
    project.dispose();
  }
});

test("a cut command gets one ≈ line once settled, asked for in one batch; the record keeps its slot", async () => {
  const project = new IsolatedProject();
  try {
    project.writeUserConfig("pi-traceline", { summaries: { model: `${PROVIDER}/gist` } });
    const asked: Asked[][] = [];
    const cut = bash(LONG, "[main a4f21c9] Fix the bridge\n");
    const other = bash(`${LONG} && git push`, "ok");
    const short = bash("git status --short", "ok");
    const running = bash(`${LONG} && sleep 60`);
    await hosted(project, asked, async (host) => {
      const before = lines(cut);
      for (const row of [other, short, running]) lines(row);
      assert.ok(!before.some((line) => line.includes("≈")), "the row renders as it would without summaries while it waits");
      await settle();
      assert.deepEqual(asked, [[{ kind: "command", text: LONG }, { kind: "command", text: `${LONG} && git push` }]]);
      // A group opens with its blank line (§9.1); the bullet line follows.
      const after = lines(cut);
      assert.deepEqual(after.slice(0, -1), before);
      assert.match(after[1]!, /^ {2}▏ › committed a4f21c9 \$ /);
      // Under the row's first word, not the command column: a note about the row (§9.15).
      assert.equal(after.at(-1), "  ▏   ≈ gist 1");
      assert.deepEqual(lines(short).filter(Boolean), ["  ▏ › $ git status --short"]);
      assert.ok(!lines(running).some((line) => line.includes("≈")));
      const entries = host.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === SUMMARY_ENTRY);
      assert.deepEqual(entries.map((entry) => entry.type === "custom" && (entry.data as { gist: string }).gist), ["gist 1", "gist 2"]);
    });
  } finally {
    project.dispose();
  }
});

test("a cut wide-character command earns a gist by terminal columns", async () => {
  const project = new IsolatedProject();
  try {
    project.writeUserConfig("pi-traceline", { summaries: { model: `${PROVIDER}/gist` } });
    const asked: Asked[][] = [];
    const command = `echo '${"界".repeat(20)}'`;
    const cut = bash(command, "ok");
    const fits = bash(`echo '${"界".repeat(8)}'`, "ok");
    await hosted(project, asked, async () => {
      const before = lines(cut, 40);
      assert.match(before[1]!, /…/, "the wide command is visibly cut");
      lines(fits, 40);
      await settle();
      assert.deepEqual(asked, [[{ kind: "command", text: command }]]);
      assert.deepEqual(lines(cut, 40), [...before, "  ▏   ≈ gist 1"]);
      assert.ok(!lines(fits, 40).some((line) => line.includes("≈")));
    });
  } finally {
    project.dispose();
  }
});

test("a replayed session reads its gists back and asks for nothing", async () => {
  const project = new IsolatedProject();
  try {
    project.writeUserConfig("pi-traceline", { summaries: { model: `${PROVIDER}/gist` } });
    const asked: Asked[][] = [];
    let first: HostedExtension["session"]["sessionManager"] | undefined;
    await hosted(project, asked, async (host) => {
      first = host.session.sessionManager;
      lines(bash(LONG, "ok"));
      await settle();
    });
    assert.equal(asked.length, 1);
    await hosted(project, asked, async () => {
      assert.equal(lines(bash(LONG, "ok")).at(-1), "  ▏   ≈ gist 1");
      await settle();
    }, undefined, first);
    assert.equal(asked.length, 1, "the replay made no request");
  } finally {
    project.dispose();
  }
});

test("a reply that answers nothing leaves the row as it was and is not asked again", async () => {
  const project = new IsolatedProject();
  try {
    project.writeUserConfig("pi-traceline", { summaries: { model: `${PROVIDER}/gist` } });
    const asked: Asked[][] = [];
    await hosted(project, asked, async () => {
      const row = bash(LONG, "ok");
      lines(row);
      await settle();
      lines(row);
      await settle();
      assert.ok(!lines(row).some((line) => line.includes("≈")));
    }, "I cannot help with that.");
    assert.equal(asked.length, 1);
  } finally {
    project.dispose();
  }
});

test("a reply that arrives after its session ended is dropped, not stored", async () => {
  const project = new IsolatedProject();
  try {
    project.writeUserConfig("pi-traceline", { summaries: { model: `${PROVIDER}/gist` } });
    const asked: Asked[][] = [];
    const host = await hostExtension((pi) => {
      summaryModel(asked, undefined, 300)(pi);
      piTraceline(pi);
    }, { project });
    lines(bash(LONG, "ok"));
    await new Promise((resolve) => setTimeout(resolve, 280));
    assert.equal(asked.length, 1, "the request is in flight");
    await host.dispose();
    await settle();
    assert.deepEqual(host.session.sessionManager.getEntries().filter((entry) => entry.type === "custom"), []);
  } finally {
    project.dispose();
  }
});

test("a headless child cannot clear its TUI parent's pending or cached gists", async () => {
  const project = new IsolatedProject();
  try {
    project.writeUserConfig("pi-traceline", { summaries: { model: `${PROVIDER}/gist` } });
    const asked: Asked[][] = [];
    await hosted(project, asked, async () => {
      const row = bash(LONG, "ok");
      lines(row);
      const child = await hostExtension(piTraceline, { project, interactive: false });
      try {
        await settle();
        assert.equal(lines(row).at(-1), "  ▏   ≈ gist 1");
      } finally {
        await child.dispose();
      }
      assert.equal(lines(row).at(-1), "  ▏   ≈ gist 1");
      assert.equal(asked.length, 1);
    });
  } finally {
    project.dispose();
  }
});

// A reply long enough to wrap, with control characters a model could send: the rendered
// gist is these words exactly, with the control characters gone.
const RAMBLING = "stages everything,\u0007 runs lint and type checks, checks formatting with prettier,\u009b then commits the bridge fix";
const RAMBLING_SHOWN = "stages everything, runs lint and type checks, checks formatting with prettier, then commits the bridge fix";

test("a long gist wraps under the row's first word in muted words, never cut, with control characters dropped", async () => {
  const project = new IsolatedProject();
  try {
    project.writeUserConfig("pi-traceline", { summaries: { model: `${PROVIDER}/gist` } });
    const asked: Asked[][] = [];
    const row = bash(LONG, "ok");
    await hosted(project, asked, async () => {
      lines(row, 60);
      await settle();
      // A theme whose muted and dim differ, so the ink of each part is visible.
      setTracelineThemeGetter(() => ({ fg: (color: string, text: string) => `\x1b[38;5;${color === "muted" ? 246 : color === "dim" ? 245 : 250}m${text}\x1b[39m`, bold: (text: string) => text, bg: (_color: string, text: string) => text }) as unknown as ReturnType<NonNullable<Parameters<typeof setTracelineThemeGetter>[0]>>);
      try {
        const raw = renderTraceRow(row, 60);
        const shown = raw.map((line) => stripAnsi(line).trimEnd());
        const start = shown.findIndex((line) => line.includes("≈"));
        const gist = shown.slice(start);
        assert.ok(gist.length >= 2, `a gist wider than the row wraps: ${JSON.stringify(gist)}`);
        assert.match(gist[0]!, /^ {2}▏ {3}≈ \S/);
        for (const line of gist.slice(1)) assert.match(line, /^ {2}▏ {5}\S/, "further lines hang under the gist's first word");
        assert.equal(gist.map((line) => line.replace(/^ {2}▏ {3}(?:≈ | {2})/, "")).join(" "), RAMBLING_SHOWN);
        assert.ok(shown.every((line) => [...line].length <= 60), "every line fits the width");
        assert.ok(raw[start]!.includes("\x1b[38;5;245m≈") && raw[start]!.includes("\x1b[38;5;246mstages everything,"), "≈ is dim, the words muted");
        assert.ok(raw.slice(start + 1).every((line) => line.includes("\x1b[38;5;246m")), "wrapped words stay muted");
        assert.ok(!raw.some((line) => /[\u0007\u009b]/.test(line)), "no control character reaches the terminal");
      } finally {
        setTracelineThemeGetter(undefined);
      }
    }, JSON.stringify({ 1: RAMBLING }));
  } finally {
    project.dispose();
  }
});

test("a cut thinking gist wraps under its first word in the label's place, never cut", async () => {
  const project = new IsolatedProject();
  try {
    project.writeUserConfig("pi-traceline", { summaries: { model: `${PROVIDER}/gist` } });
    const asked: Asked[][] = [];
    const comp = new AssistantMessageComponent(assistantMessage([{ type: "thinking", thinking: "first I check whether the push landed\nthen I compare the branches" }, { type: "text", text: "Merging now." }]), true);
    installThinkingPreviews(comp as unknown as AssistantRowDataLike);
    const render = () => comp.render(38).map((line) => stripAnsi(line).trimEnd());
    await hosted(project, asked, async () => {
      render();
      await settle();
      const shown = render();
      const start = shown.findIndex((line) => line.includes("≈"));
      const end = shown.findIndex((line) => line.includes("Merging now."));
      const gist = shown.slice(start, end).filter(Boolean);
      const indent = gist[0]!.indexOf("≈");
      assert.ok(gist.length >= 2, `a gist wider than the line wraps: ${JSON.stringify(shown)}`);
      for (const line of gist.slice(1)) assert.equal(line.search(/\S/), indent + 2, "further lines hang under the gist's first word");
      assert.equal(gist.map((line) => line.trim().replace(/^≈ /, "")).join(" "), RAMBLING_SHOWN);
      assert.ok(shown.every((line) => [...line].length <= 38), "every line fits the width");
    }, JSON.stringify({ 1: RAMBLING }));
  } finally {
    project.dispose();
  }
});

test("a cut thinking preview shows its ≈ gist once the run is settled", async () => {
  const project = new IsolatedProject();
  try {
    project.writeUserConfig("pi-traceline", { summaries: { model: `${PROVIDER}/gist` } });
    const asked: Asked[][] = [];
    const thinking = "first I check whether the push landed\nthen I compare the remote branch with the local one\nand only then do I merge the pull request";
    const preview = (content: AssistantMessage["content"], width: number) => {
      const comp = new AssistantMessageComponent(assistantMessage(content), true);
      installThinkingPreviews(comp as unknown as AssistantRowDataLike);
      return () => comp.render(width).map((line) => stripAnsi(line).trim()).filter(Boolean);
    };
    await hosted(project, asked, async () => {
      const settled = preview([{ type: "thinking", thinking }, { type: "text", text: "Merging now." }], 60);
      const streaming = preview([{ type: "thinking", thinking: `${thinking}\nstill going` }], 60);
      const fits = preview([{ type: "thinking", thinking: "short thought" }, { type: "text", text: "ok" }], 60);
      const before = settled()[0]!;
      streaming();
      fits();
      assert.match(before, /^first I check.*…/);
      await settle();
      assert.deepEqual(asked, [[{ kind: "thinking", text: thinking.split("\n").join(" · ") }]]);
      assert.equal(settled()[0], "≈ gist 1");
      assert.match(streaming()[0]!, /^first I check.*…/);
      assert.equal(fits()[0], "short thought");
    });
  } finally {
    project.dispose();
  }
});

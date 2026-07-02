// The one-line row grammar: status, result-size suffix fitting, path emphasis, fallback
// rendering, and tool-group spacing. Comps here are synthetic stand-ins satisfying the
// duck type; the contract suite proves the duck type matches the real installed pi.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

import { internals } from "../../extensions/pi-traceline/index.ts";

const {
  oneLine,
  rightAlignSuffix,
  formatCharCount,
  charSuffix,
  diffStatsFromText,
  diffStatsFromContents,
  captureWriteSnapshot,
  writeDiffStats,
  mutationDiffStats,
  toolFactSuffix,
  configureSizeThresholds,
  configureToolBackgrounds,
  toolBackgroundsEnabled,
  lineRange,
  tildify,
  toolStatus,
  blockSizeColumnLive,
  boringPrefix,
  cwdRelativePath,
  leadingBlank,
  stripAnsi,
  isToolRow,
  isAssistantRow,
  stripTimeoutSuffix,
  inkBashBody,
  dimUnstyledSpans,
  flattenInvocationLines,
  rowBackground,
  shadeRow,
  renderTraceRow,
  repeatsPreviousCdPreamble,
  elideCdPreamble,
  readRun,
  dedupeThinkingLabels,
} = internals;

const g = globalThis as Record<string, unknown>;

// Without a theme handle, all family ink falls back to basic raw ANSI (style.ts):
const DIM = "\x1b[90m";

// A theme whose palette is distinguishable from every raw-ANSI fallback: 256-colour
// codes per role (real escape sequences, so width math stays honest).
const THEME_CODES: Record<string, number> = { dim: 245, muted: 246, text: 255, success: 41, warning: 220, error: 196, accent: 214 };
const T = Object.fromEntries(Object.entries(THEME_CODES).map(([role, n]) => [role, `\x1b[38;5;${n}m`])) as Record<string, string>;
function themed() {
  return {
    fg: (color: string, text: string) => `\x1b[38;5;${THEME_CODES[color] ?? 250}m${text}\x1b[39m`,
    bold: (text: string) => text,
    bg: (_color: string, text: string) => text,
  };
}

type SyntheticComp = Record<string, unknown>;

function toolComp(overrides: SyntheticComp = {}): SyntheticComp {
  return {
    toolName: "read",
    args: { path: `${homedir()}/projects/demo/file.ts`, offset: 1, limit: 40 },
    result: { content: [{ type: "text", text: "x".repeat(1437) }], isError: false },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [`read ~/projects/demo/file.ts:1-40`] },
    ...overrides,
  };
}

beforeEach(() => {
  g.__tracelineChat = undefined;
  g.__tracelineGetTheme = undefined;
  configureSizeThresholds(undefined);
  configureToolBackgrounds({ toolBackgrounds: false });
});

test("row grammar units", () => {
  // Family number grammar (design language §4): one unit everywhere — fixed
  // one-decimal k so suffixes compare down the column; raw integers never appear.
  assert.equal(formatCharCount(0), "0.0k");
  assert.equal(formatCharCount(49), "0.0k");
  assert.equal(formatCharCount(412), "0.4k");
  assert.equal(formatCharCount(1437), "1.4k");
  assert.equal(formatCharCount(10_000), "10.0k");
  assert.equal(lineRange({ offset: 1, limit: 20 }), ":1-20");
  assert.equal(lineRange({ offset: 5 }), ":5");
  assert.equal(lineRange({ limit: 300 }), ":1-300");
  assert.equal(lineRange({}), "");
  assert.equal(tildify(`${homedir()}/x/y`), "~/x/y");
});

test("tool status reflects result/partial state", () => {
  assert.equal(toolStatus({ result: { isError: true } }), "error");
  assert.equal(toolStatus({ result: { isError: false }, isPartial: false }), "success");
  assert.equal(toolStatus({ result: { isError: false }, isPartial: true }), "running");
  assert.equal(toolStatus({}), "running");
});

test("suffix fitting: right-aligned, never overlapping, suffix wins when starved", () => {
  const invocation = "read ~/projects/demo/some/deeply/nested/path/file.ts:1-40";
  const suffix = "9.9k ch";
  for (let width = 1; width <= 120; width++) {
    const out = rightAlignSuffix(invocation, suffix, width);
    assert.ok(visibleWidth(out) <= width, `width ${width}: ${visibleWidth(out)} cols`);
    if (width > suffix.length + 2) {
      assert.ok(stripAnsi(out).endsWith(suffix), `width ${width} must keep the suffix`);
    }
  }
});

test("one-line read row: rail + emphasized path, range kept, suffix right-aligned", () => {
  const line = oneLine(toolComp(), 80);
  const visible = stripAnsi(line);
  assert.ok(visibleWidth(line) <= 80);
  assert.ok(visible.startsWith("  ▏ › read ~/projects/demo/file.ts:1-40"), visible);
  assert.ok(line.startsWith(`  ${DIM}▏\x1b[0m `), "the rail must be dim block chrome, one gutter in");
  assert.ok(visible.endsWith("1.4k ch"), visible);
  // Emphasis dims the directory separately from the basename — which renders L0-bold
  // (§12.11), never prose-plain — while the range keeps Pi's warning treatment.
  assert.ok(line.includes(`${DIM}~/projects/demo/\x1b[0m`), "directory must be dimmed");
  assert.ok(line.includes("\x1b[1mfile.ts\x1b[22m"), "basename must be bold, not prose-plain");
  assert.ok(line.includes("\x1b[33m:1-40\x1b[0m"), "line range must stay warning/yellow");
});

test("mutation diff stats ride the right suffix for edit rows", () => {
  const diff = [
    " 10 context before",
    "+11 added one",
    "+12 added two",
    "-13 removed one",
    " 14 context after",
  ].join("\n");
  const comp = toolComp({
    toolName: "edit",
    args: { path: `${homedir()}/projects/demo/file.ts` },
    result: { content: [{ type: "text", text: "Successfully replaced 1 block." }], isError: false, details: { diff } },
    callRendererComponent: { render: () => ["edit ~/projects/demo/file.ts"] },
  });

  assert.deepEqual(diffStatsFromText("--- a/file\n+++ b/file\n+1 real add\n-2 real remove"), { added: 1, removed: 1 });
  assert.deepEqual(mutationDiffStats(comp), { added: 2, removed: 1 });
  // Result is under the 100 ch fact floor (§12.13): the diff stats stand alone.
  assert.equal(stripAnsi(toolFactSuffix(comp)), "+2 -1");

  const visible = stripAnsi(oneLine(comp, 90));
  assert.ok(visible.includes("edit ~/projects/demo/file.ts"), visible);
  assert.ok(visible.endsWith("+2 -1"), visible);
});

test("diff stats are a table: +, -, and · each hold one x down the block (§12.22)", () => {
  const mut = (toolName: string, path: string, diff: string) =>
    toolComp({
      toolName,
      args: { path: `${homedir()}/projects/demo/${path}` },
      callRendererComponent: { render: () => [`${toolName} ~/projects/demo/${path}`] },
      result: { content: [{ type: "text", text: "ok." }], isError: false, details: { diff } },
    });
  const both = mut("edit", "src/a.ts", "+x\n".repeat(4) + "-x\n".repeat(9));
  const minusOnly = mut("edit", "src/b.ts", "-x\n");
  const plusOnly = mut("write", "src/c.ts", "+x\n".repeat(18));
  const read = toolComp({
    toolName: "read",
    args: { path: `${homedir()}/projects/demo/src/d.ts` },
    callRendererComponent: { render: () => ["read ~/projects/demo/src/d.ts"] },
    result: { content: [{ type: "text", text: "y".repeat(14200) }], isError: false },
  });
  g.__tracelineChat = { children: [both, minusOnly, plusOnly, read] };
  try {
    const [a, b, c, d] = [both, minusOnly, plusOnly, read].map((row) => stripAnsi(oneLine(row, 80)));
    // A dropped zero side keeps its column as space; the size cell pads to the
    // block's widest (`14.2k ch`), so `·` holds still too.
    assert.ok(a!.endsWith("+4  -9 \u00b7  0.0k ch"), a);
    assert.ok(b!.endsWith("-1 \u00b7  0.0k ch"), b);
    assert.ok(c!.endsWith("+18    \u00b7  0.0k ch"), c);
    assert.ok(d!.endsWith("14.2k ch"), d);
    // Every row ends at the block edge, and the sign/separator columns align.
    assert.ok([a, b, c, d].every((l) => l!.length === 78), JSON.stringify([a, b, c, d].map((l) => l!.length)));
    assert.equal(a!.indexOf("+4"), c!.indexOf("+18"), `+ column wanders: ${JSON.stringify([a, c])}`);
    assert.equal(a!.lastIndexOf("-9"), b!.lastIndexOf("-1"), `- column wanders: ${JSON.stringify([a, b])}`);
    assert.ok(
      [a, b, c].every((l) => l!.lastIndexOf("\u00b7") === a!.lastIndexOf("\u00b7")),
      `· column wanders: ${JSON.stringify([a, b, c])}`,
    );
  } finally {
    g.__tracelineChat = undefined;
  }
});

test("edit preview diff stats show before a result exists", () => {
  const comp = toolComp({
    toolName: "edit",
    args: { path: `${homedir()}/projects/demo/file.ts` },
    result: undefined,
    isPartial: true,
    callRendererComponent: {
      preview: { diff: "+1 pending add\n-2 pending remove", firstChangedLine: 1 },
      render: () => ["edit ~/projects/demo/file.ts"],
    },
  });

  const visible = stripAnsi(oneLine(comp, 80));
  assert.ok(visible.endsWith("+1 -1"), visible);
});

test("write rows use a pre-execution snapshot for +N -M stats", () => {
  const dir = mkdtempSync(join(tmpdir(), "traceline-write-"));
  try {
    const path = join(dir, "fixture.txt");
    writeFileSync(path, "one\ntwo\nthree\n", "utf8");
    const comp = toolComp({
      toolName: "write",
      args: { path, content: "one\nTWO\nthree\nfour\n" },
      cwd: dir,
      result: { content: [{ type: "text", text: "Successfully wrote bytes." }], isError: false },
      callRendererComponent: { render: () => [`write ${path}`] },
    });

    assert.deepEqual(diffStatsFromContents("one\ntwo\n", "one\ntwo\nthree\n"), { added: 1, removed: 0 });
    captureWriteSnapshot(comp);
    assert.deepEqual(writeDiffStats(comp), { added: 2, removed: 1 });
    assert.equal(stripAnsi(toolFactSuffix(comp)), "+2 -1");

    const visible = stripAnsi(oneLine(comp, 100));
    assert.ok(visible.includes("write"), visible);
    assert.ok(visible.endsWith("+2 -1"), visible);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new write rows count all written lines as additions", () => {
  const dir = mkdtempSync(join(tmpdir(), "traceline-write-new-"));
  try {
    const path = join(dir, "new.txt");
    const comp = toolComp({
      toolName: "write",
      args: { path, content: "alpha\nbeta\n" },
      cwd: dir,
      result: undefined,
      isPartial: true,
      callRendererComponent: { render: () => [`write ${path}`] },
    });

    captureWriteSnapshot(comp);
    assert.deepEqual(writeDiffStats(comp), { added: 2, removed: 0 });
    // Zero sides drop (§12.13): a new-file write never wears a `-0`.
    assert.equal(stripAnsi(toolFactSuffix(comp)), "+2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("result-size suffix severity: dim while healthy, warning ≥10k ch, error ≥50k ch", () => {
  assert.ok(charSuffix(1_437).startsWith(DIM), "healthy sizes stay dim");
  assert.ok(charSuffix(10_000).startsWith("\x1b[33m"), "≥10k ch must tint warning");
  assert.ok(charSuffix(50_000).startsWith("\x1b[31m"), "≥50k ch must tint error");
  assert.equal(charSuffix(undefined), "");
  assert.equal(stripAnsi(charSuffix(50_000)), "50.0k ch");

  // A fact suffix must carry a fact (§12.13): below 100 ch there is no suffix at all.
  assert.equal(charSuffix(0), "");
  assert.equal(charSuffix(99), "");
  assert.equal(stripAnsi(charSuffix(100)), "0.1k ch");

  // Thresholds follow the family config convention (~/.pi/agent/pi-traceline.json).
  configureSizeThresholds({ sizeWarningChars: 100, sizeErrorChars: 1_000 });
  assert.ok(charSuffix(500).startsWith("\x1b[33m"));
  assert.ok(charSuffix(2_000).startsWith("\x1b[31m"));
  configureSizeThresholds(undefined);
  assert.ok(charSuffix(500).startsWith(DIM));
});

test("ink derives from the theme when one is active", () => {
  g.__tracelineGetTheme = () => themed();
  const line = oneLine(toolComp(), 80);
  assert.ok(line.includes(`${T.dim}~/projects/demo/`), `directory must use theme dim: ${JSON.stringify(line)}`);
  assert.ok(line.includes(`${T.success}›`), "bullet ink must use the theme success role");
  assert.ok(line.includes(`${T.text}\x1b[1mread\x1b[22m`), "verb must use the neutral theme text role");
  assert.ok(line.includes(`${T.warning}:1-40`), "line range must use the theme warning role");
  assert.ok(line.includes(`${T.dim}1.4k ch`), "healthy suffix must use theme dim");
  assert.ok(!line.includes(DIM), "no raw fallback grey may leak while a theme is active");
});

test("the cut is a column: a block shares one body budget so ellipses and tails align (§12.17)", () => {
  const longBash = (cmd: string, over: SyntheticComp = {}) =>
    toolComp({
      toolName: "bash",
      args: { command: cmd },
      callRendererComponent: { render: () => [`$ ${cmd}`] },
      ...over,
    });
  // Two long rows, different suffix widths: bare size vs diff · size.
  const a = longBash(
    "grep -rni 'gate\\|mark\\|held\\|released\\|wheel\\|autopilot' src/data src/content --include='*.astro' -l",
    { result: { content: [{ type: "text", text: "y".repeat(200) }], isError: false } },
  );
  const b = longBash(
    "sed -n 195,250p src/data/site.ts && grep -n 'mark\\|gate' DESIGN.md | grep -vi 'market' | head -20",
    {
      toolName: "edit",
      args: { path: `${homedir()}/projects/demo/src/data/site.ts` },
      callRendererComponent: { render: () => ["edit ~/projects/demo/src/data/site.ts"] },
      result: {
        content: [{ type: "text", text: "z".repeat(1400) }],
        isError: false,
        details: { diff: "+12\n+x\n-3\n" },
      },
    },
  );
  const c = longBash(
    "git log --oneline --graph --decorate --all --color=never --since='2 weeks ago' -n 50 | head -30",
    { result: { content: [{ type: "text", text: "w".repeat(200) }], isError: false } },
  );
  g.__tracelineChat = { children: [a, b, c] };
  const lines = [a, c].map((row) => stripAnsi(oneLine(row, 80)));
  const cuts = lines.map((l) => l.indexOf("…"));
  assert.ok(cuts[0]! > 0, `expected truncation: ${JSON.stringify(lines[0])}`);
  assert.equal(cuts[0], cuts[1], `ellipsis columns differ: ${JSON.stringify(lines)}`);
  // Tails end flush at one column: the body ends where the block's widest suffix begins.
  const bodyEnds = lines.map((l) => l.slice(0, l.lastIndexOf(" ch") - 4).trimEnd().length);
  assert.equal(bodyEnds[0], bodyEnds[1], `tail-end columns differ: ${JSON.stringify(lines)}`);
  g.__tracelineChat = undefined;
});

test("reserve holds a body to the shared block budget (§12.17)", () => {
  const body = "x".repeat(100);
  const out = stripAnsi(rightAlignSuffix(body, "0.2k ch", 80, undefined, 20));
  assert.equal(out.length, 80);
  assert.ok(out.endsWith("0.2k ch"), "suffix stays right-aligned at the edge");
  // body budget = 80 - max(7+2, 20) = 60; the gap absorbs the difference
  assert.equal(out.slice(60, 73), " ".repeat(13), JSON.stringify(out));
  // a suffix-less row under the same reserve cuts at the same column
  const bare = stripAnsi(rightAlignSuffix(body, "", 80, undefined, 20));
  assert.equal(bare.length, 60);
});

test("the right edge breathes: 2-col inset and a ≥2-space body↔suffix gap (§12.21)", () => {
  // A truncated row with a suffix: the suffix column ends 2 columns short of the
  // terminal edge, and the body tail sits ≥2 spaces before the suffix.
  const comp = toolComp({
    toolName: "bash",
    args: { command: "x" },
    callRendererComponent: { render: () => [`$ grep -rni 'pattern' ${"src/a src/b ".repeat(12)}-l`] },
    result: { content: [{ type: "text", text: "y".repeat(200) }], isError: false },
  });
  const line = stripAnsi(oneLine(comp, 80));
  assert.equal(line.length, 78, `row must end 2 columns short of the edge: ${JSON.stringify(line)}`);
  assert.ok(line.endsWith("0.2k ch"), line);
  assert.ok(line.includes("  0.2k ch"), `≥2-space gap before the suffix: ${JSON.stringify(line)}`);
  // Direct style-level check: a full body leaves exactly two spaces before its suffix.
  const flush = stripAnsi(rightAlignSuffix("x".repeat(100), "0.2k ch", 40));
  assert.equal(flush.length, 40);
  assert.ok(flush.includes("  0.2k ch") && !flush.includes("   0.2k ch"), JSON.stringify(flush));
});

test("size column is block-scoped: one row over the floor lights every cell (§12.15)", () => {
  const tiny = (over: SyntheticComp = {}) =>
    toolComp({ result: { content: [{ type: "text", text: "ok" }], isError: false }, ...over });
  const big = toolComp();

  // Isolated all-tiny block: no size suffixes at all — the right edge stays clean.
  const a = tiny();
  const b = tiny();
  g.__tracelineChat = { children: [a, b] };
  assert.equal(stripAnsi(toolFactSuffix(a)), "");
  assert.equal(stripAnsi(toolFactSuffix(b)), "");

  // Mixed block: the 1.4k row lights the column; tiny neighbours render their cells.
  const c = tiny();
  const d = tiny();
  g.__tracelineChat = { children: [c, big, d] };
  assert.equal(blockSizeColumnLive(c), true);
  assert.equal(stripAnsi(toolFactSuffix(c)), "0.0k ch");
  assert.equal(stripAnsi(toolFactSuffix(d)), "0.0k ch");

  // Visible prose breaks the block: across it, a tiny row stays clean.
  const e = tiny();
  const prose = {
    setHideThinkingBlock: () => {},
    hideThinkingBlock: false,
    lastMessage: { content: [{ type: "text", text: "done reading" }] },
  };
  g.__tracelineChat = { children: [big, prose, e] };
  assert.equal(stripAnsi(toolFactSuffix(e)), "");
  g.__tracelineChat = undefined;
});

test("path emphasis dims the boring prefix: block-common directory or cwd, tail bold (§12.16)", () => {
  const home = homedir();
  const edit = (path: string, cwd?: string) =>
    toolComp({
      toolName: "edit",
      args: { path },
      cwd,
      callRendererComponent: { render: () => [`edit ${tildify(path)}`] },
    });

  // Divergence under a shared src/: the common prefix dims, divergent dirs go bold.
  const p1 = edit(`${home}/projects/site/src/pages/product.astro`);
  const p2 = edit(`${home}/projects/site/src/data/site.ts`);
  const p3 = edit(`${home}/projects/site/src/components/Cta.astro`);
  g.__tracelineChat = { children: [p1, p2, p3] };
  assert.equal(boringPrefix(p1, tildify(String(p1.args && (p1.args as any).path))), "~/projects/site/src/");
  const line = oneLine(p1, 100);
  assert.ok(line.includes(`${DIM}~/projects/site/src/\x1b[0m`), `common prefix dims: ${JSON.stringify(line)}`);
  assert.ok(line.includes("\x1b[1mpages/product.astro\x1b[22m"), `divergent tail bold: ${JSON.stringify(line)}`);

  // cwd is boring by default — and collapses to ./ (§12.18): the in-repo path renders
  // cwd-relative behind a dim ./ while the out-of-cwd neighbour keeps its absolute form.
  const inRepo = edit(`${home}/projects/site/src/lib/util.ts`, `${home}/projects/site`);
  const inTmp = edit("/tmp/scratch-note.md", `${home}/projects/site`);
  g.__tracelineChat = { children: [inRepo, inTmp] };
  assert.equal(cwdRelativePath(inRepo, String((inRepo.args as any).path)), "./src/lib/util.ts");
  assert.equal(boringPrefix(inRepo, "./src/lib/util.ts"), "./");
  assert.equal(boringPrefix(inTmp, "/tmp/scratch-note.md"), "/tmp/");
  const repoLine = oneLine(inRepo, 100);
  assert.ok(repoLine.includes(`${DIM}./\x1b[0m`), `collapsed cwd dims: ${JSON.stringify(repoLine)}`);
  assert.ok(repoLine.includes("\x1b[1msrc/lib/util.ts\x1b[22m"), `sub-cwd tail bold: ${JSON.stringify(repoLine)}`);

  // A lone row (no block siblings) keeps the classic basename-only emphasis.
  g.__tracelineChat = undefined;
  const lone = edit(`${home}/projects/site/src/pages/product.astro`);
  assert.equal(boringPrefix(lone, "~/projects/site/src/pages/product.astro"), "~/projects/site/src/pages/");
});

test("cwd collapses to ./: two columns of ambient context instead of thirty (§12.18)", () => {
  const home = homedir();
  const cwd = `${home}/projects/site`;
  const read = (path: string) =>
    toolComp({ args: { path }, cwd, callRendererComponent: { render: () => [`read ${tildify(path)}`] } });

  // Lone in-repo row: dim ./dir/, bold basename — calm, short, unambiguous.
  g.__tracelineChat = undefined;
  const lone = read(`${cwd}/src/pages/product.astro`);
  const line = oneLine(lone, 100);
  assert.ok(stripAnsi(line).includes("read ./src/pages/product.astro"), JSON.stringify(stripAnsi(line)));
  assert.ok(line.includes(`${DIM}./src/pages/\x1b[0m`), JSON.stringify(line));
  assert.ok(line.includes("\x1b[1mproduct.astro\x1b[22m"), JSON.stringify(line));

  // Outside cwd the tildified absolute form survives — the asymmetry is the information.
  const outside = read(`${home}/reference/notes.md`);
  assert.ok(stripAnsi(oneLine(outside, 100)).includes("read ~/reference/notes.md"));

  // A block diverging at the repo root brightens whole relative paths past the dim ./.
  const a = read(`${cwd}/README.md`);
  const b = read(`${cwd}/src/data/site.ts`);
  g.__tracelineChat = { children: [a, b] };
  assert.ok(oneLine(a, 100).includes("\x1b[1mREADME.md\x1b[22m"));
  assert.ok(oneLine(b, 100).includes("\x1b[1msrc/data/site.ts\x1b[22m"));

  // But ./ counts like ~: a block diverging under one src/ dims ./src/ as shared.
  const c = read(`${cwd}/src/pages/product.astro`);
  const d = read(`${cwd}/src/data/site.ts`);
  g.__tracelineChat = { children: [c, d] };
  assert.equal(boringPrefix(c, "./src/pages/product.astro"), "./src/");
  const lineC = oneLine(c, 100);
  assert.ok(lineC.includes(`${DIM}./src/\x1b[0m`), JSON.stringify(lineC));
  assert.ok(lineC.includes("\x1b[1mpages/product.astro\x1b[22m"), JSON.stringify(lineC));
  g.__tracelineChat = undefined;
});

test("status lives in the bullet: red error, blue running, green success; verbs neutral", () => {
  const success = oneLine(toolComp(), 80);
  const error = oneLine(toolComp({ result: { content: [], isError: true } }), 80);
  const running = oneLine(toolComp({ result: undefined, isPartial: true }), 80);
  assert.ok(success.includes("\x1b[32m›"), "success bullet green");
  assert.ok(error.includes("\x1b[31m›"), "error bullet red");
  assert.ok(running.includes("\x1b[34m›"), "running bullet blue");

  // Verbs are neutral bold (design language §2/§12); only a failed call tints its verb.
  assert.ok(success.includes("\x1b[1mread\x1b[22m"), "healthy verb must be neutral bold");
  assert.ok(!success.includes("\x1b[32m\x1b[1mread"), "healthy verb must not be success-tinted");
  assert.ok(error.includes("\x1b[31m\x1b[1mread\x1b[22m"), "failed verb keeps the error tint");
});

test("errors tint the discriminators: basename and bash head go error-bold on failed rows (§12.14)", () => {
  const g = globalThis as any;
  g.__tracelineGetTheme = () => themed();
  try {
    const failedRead = oneLine(toolComp({ result: { content: [], isError: true } }), 80);
    assert.ok(failedRead.includes(`${T.error}\x1b[1mread\x1b[22m`), `failed verb error-bold: ${JSON.stringify(failedRead)}`);
    assert.ok(failedRead.includes(`${T.error}\x1b[1mfile.ts\x1b[22m`), `failed basename error-bold: ${JSON.stringify(failedRead)}`);

    const failedBash = oneLine(
      toolComp({
        toolName: "bash",
        args: { command: "npm test" },
        result: { content: [{ type: "text", text: "boom" }], isError: true },
        callRendererComponent: { render: () => ["$ npm test"] },
      }),
      80,
    );
    assert.ok(failedBash.includes(`${T.error}\x1b[1m$\x1b[22m`), `failed $ error-bold: ${JSON.stringify(failedBash)}`);
    assert.ok(failedBash.includes(`${T.error}\x1b[1mnpm\x1b[22m`), `failed head error-bold: ${JSON.stringify(failedBash)}`);
    assert.ok(failedBash.includes(`${T.dim} test`), `failed args stay dim: ${JSON.stringify(failedBash)}`);

    // Healthy rows untouched: discriminators stay neutral text-bold.
    const healthy = oneLine(toolComp(), 80);
    assert.ok(healthy.includes(`${T.text}\x1b[1mfile.ts\x1b[22m`), `healthy basename text-bold: ${JSON.stringify(healthy)}`);
  } finally {
    g.__tracelineGetTheme = undefined;
  }
});

test("no plain ink in native rows: unstyled spans demote to dim, accents and bold survive (§12.12)", () => {
  const g = globalThis as any;
  g.__tracelineGetTheme = () => themed();
  try {
    const comp = toolComp({
      toolName: "grep",
      args: { pattern: "TOOL" },
      callRendererComponent: { render: () => ["grep \x1b[36mTOOL\x1b[0m in extensions/ \x1b[1mnow\x1b[22m"] },
    });
    const line = oneLine(comp, 100);
    assert.ok(line.includes("\x1b[36mTOOL\x1b[0m"), `deliberate accents survive: ${JSON.stringify(line)}`);
    assert.ok(line.includes(`${T.dim} in extensions/ \x1b[39m`), `unstyled spans demote to dim: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[1mnow\x1b[22m") && !line.includes(`${T.dim}now`), `bold-only spans survive: ${JSON.stringify(line)}`);

    // Unit edges: OSC sequences pass through untouched and are never counted as text.
    const osc = "\x1b]8;;https://x.test\x1b\\\x1b[35mlink\x1b[0m\x1b]8;;\x1b\\ tail";
    const out = dimUnstyledSpans(osc);
    assert.ok(out.includes("\x1b]8;;https://x.test\x1b\\"), `OSC preserved: ${JSON.stringify(out)}`);
    assert.ok(out.includes(`${T.dim} tail`) || out.includes(`${T.dim}tail`), `trailing plain text dims: ${JSON.stringify(out)}`);
  } finally {
    g.__tracelineGetTheme = undefined;
  }
});

test("fallback rendering when a tool has no native call renderer", () => {
  const comp = toolComp({ toolName: "mcp", args: { foo: "bar" }, callRendererComponent: undefined, result: undefined, isPartial: true });
  const visible = stripAnsi(oneLine(comp, 80));
  assert.ok(visible.includes('mcp {"foo":"bar"}'), visible);
});

test("bash rows: timeout stripped, $ anchors bold, head command L0-bold, rest one dim grey", () => {
  const comp = toolComp({
    toolName: "bash",
    args: { command: "pwd && git remote -v" },
    callRendererComponent: {
      render: () => ["$ pwd && git remote -v 2>/dev/null | head -5 (timeout 10s)"],
    },
  });
  const line = oneLine(comp, 120);
  const visible = stripAnsi(line);
  assert.ok(!visible.includes("timeout"), `timeout boilerplate must be stripped: ${visible}`);
  assert.ok(visible.includes("$ pwd && git remote -v 2>/dev/null | head -5"), visible);
  assert.ok(line.includes("\x1b[1m$\x1b[22m"), "the $ prompt anchors the row in neutral bold");
  // Raw fallback (no theme): everything shares one grey, but pieces are individually
  // wrapped so a themed terminal keeps the levels honest.
  assert.ok(line.includes(`${DIM}&&\x1b[0m`), "&& must be dimmed");
  assert.ok(line.includes(`${DIM}2>/dev/null\x1b[0m`), "2>/dev/null must be dimmed");
  assert.ok(line.includes(`${DIM}|\x1b[0m`), "pipe must be dimmed");

  // With a theme (design language §2/§12.9/§12.11/§12.20): one supporting grey — each
  // command's head word renders L0-bold, the bash row's basename; arguments and
  // plumbing all sit at L3-dim. No muted level anywhere in a trace row.
  g.__tracelineGetTheme = () => themed();
  const body = inkBashBody("pwd && git remote -v 2>/dev/null");
  assert.ok(body.startsWith(`${T.text}\x1b[1mpwd\x1b[22m`), `head command must be bold text: ${JSON.stringify(body)}`);
  assert.ok(body.includes(`${T.dim}&&`), `plumbing must be dim: ${JSON.stringify(body)}`);
  assert.ok(body.includes(`${T.text}\x1b[1mgit\x1b[22m`), `&& starts a new command — its head is bold (§12.20): ${JSON.stringify(body)}`);
  assert.ok(body.includes(`${T.dim} remote -v`), `arguments of later commands stay dim: ${JSON.stringify(body)}`);
  assert.ok(!body.includes(T.muted), `no muted ink in a bash body: ${JSON.stringify(body)}`);

  // Env assignments are not the command: the head scans past them.
  const env = inkBashBody("FOO=1 npm test");
  assert.ok(env.includes(`${T.dim}FOO=1 \x1b[39m`), `assignments dim: ${JSON.stringify(env)}`);
  assert.ok(env.includes(`${T.text}\x1b[1mnpm\x1b[22m`), `head after assignments is bold text: ${JSON.stringify(env)}`);
  assert.ok(env.includes(`${T.dim} test`), `arguments dim: ${JSON.stringify(env)}`);

  // After a ⋯ && elision the head of the surviving command stays bright.
  const elided = inkBashBody("\u22ef && npm run typecheck");
  assert.ok(stripAnsi(elided).startsWith("\u22ef && npm"), stripAnsi(elided));
  assert.ok(elided.includes(`${T.text}\x1b[1mnpm\x1b[22m`), `head after ⋯ must be bold text: ${JSON.stringify(elided)}`);
  assert.ok(elided.includes(`${T.dim} run typecheck`), `tail arguments dim: ${JSON.stringify(elided)}`);
  g.__tracelineGetTheme = undefined;

  // Unit edges: heredoc markers dim; quoted near-misses stay one chunk.
  assert.ok(inkBashBody("cat <<'EOF'").includes(`${DIM}<<'EOF'\x1b[0m`));
  assert.equal(stripAnsi(inkBashBody("echo 'a&&b'")), "echo 'a&&b'", "unspaced operators are left alone");
  assert.ok(!inkBashBody("echo 'a&&b'").includes(`${DIM}&&`), "a quoted && must not be split out");
  assert.equal(stripTimeoutSuffix("$ ls (timeout 10s)"), "$ ls");
  assert.equal(stripTimeoutSuffix("$ ls"), "$ ls");
});

test("every command head is bold: sequencers and ↵ re-arm, pipes stay filters (§12.20)", () => {
  const g = globalThis as any;
  g.__tracelineGetTheme = () => themed();
  try {
    const bold = (word: string) => `${T.text}\x1b[1m${word}\x1b[22m`;

    // Sequencers start new commands: cd, printf, and git all read as heads.
    const chain = inkBashBody("cd /tmp/x && printf 'HEAD ' ; git rev-parse HEAD | head -3");
    for (const head of ["cd", "printf", "git"]) {
      assert.ok(chain.includes(bold(head)), `${head} must be a bold head: ${JSON.stringify(chain)}`);
    }
    assert.ok(chain.includes(`${T.dim} rev-parse HEAD`), `arguments stay dim: ${JSON.stringify(chain)}`);
    // A pipe continues the command: `head -3` is a filter and stays dim (§12.2).
    assert.ok(!chain.includes(bold("head")), `pipe tails must not bold: ${JSON.stringify(chain)}`);

    // Flattened line breaks are new commands: each script line's head bolds.
    const script = inkBashBody("set -euo pipefail \u21b5 mkdir -p /tmp/x \u21b5 npm pack");
    for (const head of ["set", "mkdir", "npm"]) {
      assert.ok(script.includes(bold(head)), `${head} must be a bold head: ${JSON.stringify(script)}`);
    }

    // Env assignments still scan past, per command.
    const env = inkBashBody("FOO=1 npm test && BAR=2 node x.js");
    assert.ok(env.includes(bold("npm")) && env.includes(bold("node")), JSON.stringify(env));
    assert.ok(env.includes(`${T.dim} BAR=2 \x1b[39m`), `assignments dim: ${JSON.stringify(env)}`);

    // Heredoc bodies are inert: no heads between <<TAG and its terminator; the
    // command after the terminator re-arms.
    const heredoc = inkBashBody("cat <<'EOF' \u21b5 alpha beta \u21b5 EOF \u21b5 echo done");
    assert.ok(heredoc.includes(bold("cat")), JSON.stringify(heredoc));
    assert.ok(!heredoc.includes(bold("alpha")), `heredoc body lines are data, not commands: ${JSON.stringify(heredoc)}`);
    assert.ok(!heredoc.includes(bold("EOF")), `the terminator is not a command: ${JSON.stringify(heredoc)}`);
    assert.ok(heredoc.includes(bold("echo")), `after the terminator, heads re-arm: ${JSON.stringify(heredoc)}`);

    // Failed rows tint every head error (§12.14 × §12.20).
    const failed = { toolName: "bash", result: { content: [], isError: true } };
    const red = inkBashBody("pwd && git push", failed);
    assert.ok(red.includes(`${T.error}\x1b[1mpwd\x1b[22m`), JSON.stringify(red));
    assert.ok(red.includes(`${T.error}\x1b[1mgit\x1b[22m`), JSON.stringify(red));
  } finally {
    g.__tracelineGetTheme = undefined;
  }
});

test("multiline bash flattens to one line: tail survives, breaks marked, timeout stripped (#10)", () => {
  // The issue #10 shape: an inline python heredoc-ish command plus chained tmux checks,
  // where the first rendered line alone (`$ python3 -c "`) says nothing.
  const comp = toolComp({
    toolName: "bash",
    args: { command: "python3 ...", timeout: 70 },
    callRendererComponent: {
      render: () => [
        '$ python3 -c "',
        "  import json",
        "  d=json.load(open(p))",
        '  " && tmux send-keys -t pog-th BTab && tmux capture-pane -p | tail -4 (timeout 70s)',
      ],
    },
  });
  const line = oneLine(comp, 160);
  const visible = stripAnsi(line);
  assert.ok(visible.startsWith('  ▏ › $ python3 -c "'), visible);
  assert.ok(visible.includes("capture-pane"), `operative tail must survive: ${visible}`);
  assert.ok(visible.includes("\u21b5"), `original line breaks must be marked: ${visible}`);
  assert.ok(line.includes(`${DIM}\u21b5\x1b[0m`), "break marks must be dimmed");
  assert.ok(!visible.includes("timeout"), `timeout boilerplate stays stripped after flatten: ${visible}`);

  // Narrow widths middle-truncate but still keep both ends of the flattened command.
  const narrow = stripAnsi(oneLine(comp, 60));
  assert.ok(narrow.includes("python3"), narrow);
  assert.ok(narrow.includes("tail -4"), narrow);

  // Unit edges: blank-only lines drop out; a single line flattens to itself, unmarked;
  // the joined line stays plain — inkBashBody dims the marks later.
  assert.equal(flattenInvocationLines(["", "   "]), undefined);
  assert.equal(flattenInvocationLines(["$ ls -la"]), "$ ls -la");
  assert.equal(flattenInvocationLines(["$ cat <<'EOF'", "  body", "EOF"]), "$ cat <<'EOF' \u21b5 body \u21b5 EOF");
});

test("tool background flag accepts config and env, with unbanded rows as the default", () => {
  const previous = process.env.PI_TRACELINE_TOOL_BACKGROUNDS;
  try {
    delete process.env.PI_TRACELINE_TOOL_BACKGROUNDS;
    configureToolBackgrounds(undefined);
    assert.equal(toolBackgroundsEnabled(), false);

    process.env.PI_TRACELINE_TOOL_BACKGROUNDS = "1";
    configureToolBackgrounds(undefined);
    assert.equal(toolBackgroundsEnabled(), true);

    process.env.PI_TRACELINE_TOOL_BACKGROUNDS = "off";
    configureToolBackgrounds(undefined);
    assert.equal(toolBackgroundsEnabled(), false);

    process.env.PI_TRACELINE_TOOL_BACKGROUNDS = "1";
    configureToolBackgrounds({ toolBackgrounds: false });
    assert.equal(toolBackgroundsEnabled(), false, "explicit config keeps tests and project overrides deterministic");
  } finally {
    if (previous === undefined) delete process.env.PI_TRACELINE_TOOL_BACKGROUNDS;
    else process.env.PI_TRACELINE_TOOL_BACKGROUNDS = previous;
    configureToolBackgrounds({ toolBackgrounds: false });
  }
});

test("tool backgrounds are off by default; opt-in keeps the native full-width band", () => {
  const BG_OPEN = "\x1b[48;2;30;30;40m";
  const bgFn = (text: string) => `${BG_OPEN}${text}\x1b[49m`; // theme.bg shape
  const comp = toolComp({ contentBox: { bgFn }, getRenderShell: () => "box" });

  assert.equal(toolBackgroundsEnabled(), false, "unbanded trace rows are the default");
  assert.equal(rowBackground(comp), undefined);
  assert.equal(oneLine(comp, 80).includes(BG_OPEN), false, "default trace row should not paint a background");

  configureToolBackgrounds({ toolBackgrounds: true });
  assert.equal(toolBackgroundsEnabled(), true);
  const line = oneLine(comp, 80);
  assert.ok(line.startsWith(BG_OPEN), "opt-in row must open on the tool background");
  assert.ok(line.endsWith("\x1b[49m"), "opt-in row must close only the background");
  assert.equal(visibleWidth(line), 78, "opt-in band must span the inset row width (§12.21)");
  for (const segment of line.split("\x1b[0m").slice(1)) {
    assert.ok(segment.startsWith(BG_OPEN), `background must be re-asserted after every reset: ${JSON.stringify(segment)}`);
  }

  // No native shade → no band: self-framing tools and rows without a contentBox.
  assert.equal(rowBackground(toolComp({ contentBox: { bgFn }, getRenderShell: () => "self" })), undefined);
  assert.equal(rowBackground(toolComp()), undefined);
  assert.equal(oneLine(toolComp(), 80).includes(BG_OPEN), false);

  // A bgFn that paints nothing leaves the row untouched.
  assert.equal(shadeRow("x", 10, (text) => text), "x");
});

test("hyperlinked read rows (OSC 8, ST-terminated): text survives stripAnsi, URL survives tildify, emphasis applies", () => {
  // pi-tui's hyperlink() emits \x1b]8;;URL\x1b\\TEXT\x1b]8;;\x1b\\ on hyperlink-capable
  // terminals. A greedy OSC strip swallowed TEXT (killing path emphasis), and a naive
  // tildify rewrote the home dir inside the URL (breaking the click target).
  const url = `file://${homedir()}/projects/demo/file.ts`;
  const linked = `read \x1b]8;;${url}\x1b\\~/projects/demo/file.ts\x1b]8;;\x1b\\:1-40`;
  assert.equal(stripAnsi(linked), "read ~/projects/demo/file.ts:1-40", "link text must survive stripAnsi");
  assert.ok(tildify(linked).includes(`\x1b]8;;${url}\x1b\\`), "OSC URL must not be tildified");

  const comp = toolComp({ callRendererComponent: { render: () => [linked] } });
  const line = oneLine(comp, 80);
  assert.ok(
    line.includes(`${DIM}~/projects/demo/\x1b[0m`),
    `path emphasis must apply on hyperlink terminals: ${JSON.stringify(line)}`,
  );
});

test("native invocation drops the expand hint and keeps only the first visible line", () => {
  const comp = toolComp({
    callRendererComponent: { render: () => ["read ~/projects/demo/file.ts:1-40 (ctrl+o to expand)", "  body line"] },
  });
  const visible = stripAnsi(oneLine(comp, 80));
  assert.ok(!visible.includes("to expand"), visible);
  assert.ok(!visible.includes("body line"), visible);
});

test("tool-group spacing: blank before a group, tight within it, connectors skipped", () => {
  const toolA = toolComp();
  const toolB = toolComp();
  const toolC = toolComp();
  const visibleAssistant = {
    setHideThinkingBlock: () => {},
    hideThinkingBlock: false,
    lastMessage: { content: [{ type: "text", text: "let me look" }] },
  };
  const connector = {
    setHideThinkingBlock: () => {},
    hideThinkingBlock: false,
    lastMessage: { content: [{ type: "toolCall" }] },
  };
  assert.equal(isToolRow(toolA), true);
  assert.equal(isAssistantRow(visibleAssistant), true);

  g.__tracelineChat = { children: [visibleAssistant, toolA, connector, toolB, visibleAssistant, toolC] };
  assert.equal(leadingBlank(toolA), true, "blank after visible assistant content");
  assert.equal(leadingBlank(toolB), false, "tight through an invisible connector turn");
  assert.equal(leadingBlank(toolC), true, "new group after visible content");
});

test("thought→action couplet: tight under a collapsed Thinking... line", () => {
  const tool = toolComp();
  const collapsedThinking = {
    setHideThinkingBlock: () => {},
    hideThinkingBlock: true,
    lastMessage: { content: [{ type: "thinking", thinking: "let me check the repo" }] },
  };
  const thinkingWithProse = {
    setHideThinkingBlock: () => {},
    hideThinkingBlock: true,
    lastMessage: {
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Here is what I found." },
      ],
    },
  };
  g.__tracelineChat = { children: [collapsedThinking, tool] };
  assert.equal(leadingBlank(tool), false, "reasoning-only turn reads as this call's thought");
  g.__tracelineChat = { children: [thinkingWithProse, tool] };
  assert.equal(leadingBlank(tool), true, "visible prose still opens a new paragraph");
});

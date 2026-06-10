// The one-line row grammar: status, result-size suffix fitting, path emphasis, fallback
// rendering, and tool-group spacing. Comps here are synthetic stand-ins satisfying the
// duck type; the contract suite proves the duck type matches the real installed pi.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";

import { internals } from "../../extensions/pi-traceline/index.ts";

const {
  oneLine,
  fitOneLineAndSuffix,
  formatCharCount,
  lineRange,
  tildify,
  toolStatus,
  leadingBlank,
  stripAnsi,
  isToolRow,
  isAssistantRow,
  stripTimeoutSuffix,
  dimShellPlumbing,
  flattenInvocationLines,
  rowBackground,
  shadeRow,
} = internals;

const g = globalThis as Record<string, unknown>;

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
});

test("row grammar units", () => {
  // Family number grammar: raw integers below 1000, one-decimal k above.
  assert.equal(formatCharCount(0), "0");
  assert.equal(formatCharCount(49), "49");
  assert.equal(formatCharCount(412), "412");
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
    const out = fitOneLineAndSuffix(invocation, suffix, width);
    assert.ok(visibleWidth(out) <= width, `width ${width}: ${visibleWidth(out)} cols`);
    if (width > suffix.length + 2) {
      assert.ok(stripAnsi(out).endsWith(suffix), `width ${width} must keep the suffix`);
    }
  }
});

test("one-line read row: emphasized path, range kept, suffix right-aligned", () => {
  const line = oneLine(toolComp(), 80);
  const visible = stripAnsi(line);
  assert.ok(visibleWidth(line) <= 80);
  assert.ok(visible.startsWith("  › read ~/projects/demo/file.ts:1-40"), visible);
  assert.ok(visible.endsWith("1.4k ch"), visible);
  // Emphasis dims the directory separately from the basename: the raw line must restyle
  // the directory span, not just pass the native text through.
  assert.ok(line.includes("\x1b[38;2;128;128;128m~/projects/demo/\x1b[0m"), "directory must be dimmed");
});

test("error status colours the bullet red; running is blue; success green", () => {
  const success = oneLine(toolComp(), 80);
  const error = oneLine(toolComp({ result: { content: [], isError: true } }), 80);
  const running = oneLine(toolComp({ result: undefined, isPartial: true }), 80);
  assert.ok(success.includes("\x1b[32m›"), "success bullet green");
  assert.ok(error.includes("\x1b[31m›"), "error bullet red");
  assert.ok(running.includes("\x1b[34m›"), "running bullet blue");
});

test("fallback rendering when a tool has no native call renderer", () => {
  const comp = toolComp({ toolName: "mcp", args: { foo: "bar" }, callRendererComponent: undefined, result: undefined, isPartial: true });
  const visible = stripAnsi(oneLine(comp, 80));
  assert.ok(visible.includes('mcp {"foo":"bar"}'), visible);
});

test("bash rows: timeout boilerplate stripped, shell plumbing dimmed, segments bright", () => {
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
  // Plumbing is dimmed; the command segments around it keep full brightness.
  assert.ok(line.includes("\x1b[38;2;128;128;128m&&\x1b[0m"), "&& must be dimmed");
  assert.ok(line.includes("\x1b[38;2;128;128;128m2>/dev/null\x1b[0m"), "2>/dev/null must be dimmed");
  assert.ok(line.includes("\x1b[38;2;128;128;128m|\x1b[0m"), "pipe must be dimmed");

  // Unit edges: heredoc markers dim; quoted near-misses and SGR params stay untouched.
  assert.ok(dimShellPlumbing("cat <<'EOF'").includes("\x1b[38;2;128;128;128m<<'EOF'\x1b[0m"));
  assert.equal(dimShellPlumbing("echo 'a&&b'"), "echo 'a&&b'", "unspaced operators are left alone");
  assert.equal(stripTimeoutSuffix("$ ls (timeout 10s)"), "$ ls\x1b[0m");
  assert.equal(stripTimeoutSuffix("$ ls"), "$ ls");
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
  assert.ok(visible.startsWith('  › $ python3 -c "'), visible);
  assert.ok(visible.includes("capture-pane"), `operative tail must survive: ${visible}`);
  assert.ok(visible.includes("\u21b5"), `original line breaks must be marked: ${visible}`);
  assert.ok(line.includes("\x1b[38;2;128;128;128m\u21b5\x1b[0m"), "break marks must be dimmed");
  assert.ok(!visible.includes("timeout"), `timeout boilerplate stays stripped after flatten: ${visible}`);

  // Narrow widths middle-truncate but still keep both ends of the flattened command.
  const narrow = stripAnsi(oneLine(comp, 60));
  assert.ok(narrow.includes("python3"), narrow);
  assert.ok(narrow.includes("tail -4"), narrow);

  // Unit edges: blank-only lines drop out; a single line flattens to itself, unmarked.
  assert.equal(flattenInvocationLines(["", "   "]), undefined);
  assert.equal(stripAnsi(flattenInvocationLines(["$ ls -la"])!), "$ ls -la");
  assert.equal(stripAnsi(flattenInvocationLines(["$ cat <<'EOF'", "  body", "EOF"])!), "$ cat <<'EOF' \u21b5 body \u21b5 EOF");
});

test("rows sit on the native tool surface: full-width band, reset-proof, self-shell exempt", () => {
  const BG_OPEN = "\x1b[48;2;30;30;40m";
  const bgFn = (text: string) => `${BG_OPEN}${text}\x1b[49m`; // theme.bg shape
  const comp = toolComp({ contentBox: { bgFn }, getRenderShell: () => "box" });

  const line = oneLine(comp, 80);
  assert.ok(line.startsWith(BG_OPEN), "row must open on the tool background");
  assert.ok(line.endsWith("\x1b[49m"), "row must close only the background");
  assert.equal(visibleWidth(line), 80, "band must span the full width");
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
    line.includes("\x1b[38;2;128;128;128m~/projects/demo/\x1b[0m"),
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

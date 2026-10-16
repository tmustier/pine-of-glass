// How records are recognised in the shell, and which evidence counts (design language
// §9.10). Each vocabulary entry's own cases are examples in vocabulary.ts, which
// vocabulary.test.ts runs; the cases here are rows that used to earn a record they had
// not proved.
import { test } from "node:test";
import assert from "node:assert/strict";

import { recordFacts } from "../../extensions/pi-traceline/records.ts";
import type { ToolRowDataLike } from "../../extensions/_lib/chat.ts";

function bash(command: string, output: string, options: { error?: boolean } = {}): ToolRowDataLike {
  return {
    toolName: "bash",
    args: { command },
    result: { content: [{ type: "text", text: output }], isError: options.error === true },
  };
}

const factLabels = (command: string, output: string, options: { error?: boolean } = {}) =>
  recordFacts(bash(command, output, options)).map(({ verb, datum }) => `${verb} ${datum}`);
const SILENT = "(no output)";

test("a command named in quotes, a comment or a heredoc body is not a command", () => {
  assert.deepEqual(factLabels("echo 'git commit' && cat log.txt", "[main a4f21c9] x\n"), []);
  assert.deepEqual(factLabels("cat notes.md # then git commit", "[main a4f21c9] x\n"), []);
  assert.deepEqual(factLabels("cat > /tmp/steps.md <<'EOF'\ngit commit -m x\ngit push\nEOF\ncat /tmp/steps.md", "[main a4f21c9] x\n   1c75c2a..50cf33f  main -> main\n"), []);
  // The command after a heredoc still counts.
  assert.deepEqual(factLabels("cat > /tmp/body.md <<'EOF'\nSummary\nEOF\ngh pr create --body-file /tmp/body.md", "https://github.com/o/r/pull/88\n"), ["opened PR #88"]);
});

test("completion output counts from substitutions, loops and wrappers", () => {
  assert.deepEqual(factLabels('PR_URL=$(gh pr create --fill) && echo "$PR_URL"', "https://github.com/o/r/pull/88\n"), ["opened PR #88"]);
  assert.deepEqual(factLabels('out=$(git -C "$dir" push origin main 2>&1); echo "$out"', "To github.com:o/r.git\n   1c75c2a..50cf33f  main -> main\n"), ["pushed main"]);
  assert.deepEqual(
    factLabels('for n in 8 9; do gh issue close "$n" --comment done; done', "✓ Closed issue o/r#8 (a)\n✓ Closed issue o/r#9 (b)\n"),
    ["closed #8", "closed #9"],
  );
  assert.deepEqual(factLabels("env -u PINET_MESH_SECRET git push", "To github.com:o/r.git\n   1c75c2a..50cf33f  main -> main\n"), ["pushed main"]);
});

test("quiet success: a silent worktree removal is its own row's status", () => {
  const [removed] = recordFacts(bash("set -euo pipefail\ncd ~/projects/pine-of-glass\ngit worktree remove .worktrees/fix", SILENT));
  assert.deepEqual([removed?.verb, removed?.datum, removed?.evidence], ["removed worktree", ".worktrees/fix", "quiet"]);
  assert.deepEqual(factLabels("git worktree remove --force /tmp/review", SILENT), ["removed worktree /tmp/review"]);
  assert.deepEqual(factLabels('git worktree remove "$WT"', SILENT), []);
  assert.deepEqual(factLabels("git worktree remove .worktrees/fix; git worktree prune", SILENT), []);
  assert.deepEqual(factLabels("git worktree remove .worktrees/fix", "fatal: '.worktrees/fix' contains modified or untracked files, use --force to delete it\n", { error: true }), []);
});

test("quiet success needs the exit status to be the operation's own", () => {
  const unproven = [
    "exit 0; gh pr merge 87", // the shell ends first
    "set -n; gh pr merge 87", // read, never run
    "true; # skipped ; gh pr merge 87", // a comment
    "true || gh pr merge 87", // the row succeeds without it
    "trap 'exit 0' ERR; gh pr merge 87",
    "eval \"$SETUP\"; gh pr merge 87",
    "if true; then gh pr merge 87; fi",
    "! gh pr merge 87",
    "gh pr merge 87 &",
    "gh pr merge 87 > /tmp/merge.log",
    "gh pr merge $PR",
  ];
  for (const command of unproven) assert.deepEqual(factLabels(command, SILENT), [], command);
  // Safe shell options, wrappers and assignments keep the status the operation's own.
  assert.deepEqual(factLabels("set -euo pipefail\ngh pr merge 87 --squash", SILENT), ["merged PR #87"]);
  assert.deepEqual(factLabels("GH_TOKEN=$(gh auth token 2>/dev/null || true) gh pr merge 755 --repo o/r --squash", SILENT), ["merged PR #755"]);
});

test("observed state is about the same PR in the same repository", () => {
  assert.deepEqual(factLabels("gh pr merge 87 --repo a/x; gh pr view 87 --repo b/y --json state -q .state", "MERGED\n"), []);
  assert.deepEqual(factLabels("gh pr merge 87; cd ../other && gh pr view 87 --json state -q .state", "MERGED\n"), []);
  // A repository only one side states does not conflict.
  const [merged] = recordFacts(bash("gh pr merge 1145 --squash && gh pr view 1145 --repo Nexcade/commercial --json state -q .state", "MERGED\n"));
  assert.deepEqual([merged?.datum, merged?.evidence], ["PR #1145", "state"]);
});

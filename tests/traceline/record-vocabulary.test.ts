// The record vocabulary and the shell subset it is recognised in (design language
// §9.10). Output shapes are copied from real git, gh and npm porcelain; the negative
// cases are rows that used to earn a record they had not proved.
import { test } from "node:test";
import assert from "node:assert/strict";

import { recordFacts } from "../../extensions/pi-traceline/records.ts";
import { internals } from "../../extensions/pi-traceline/index.ts";
import type { ToolRowLike } from "../../extensions/_lib/chat.ts";

const { recordCells } = internals;

function bash(command: string, output: string, options: { error?: boolean } = {}): ToolRowLike {
  return {
    toolName: "bash",
    args: { command },
    result: { content: [{ type: "text", text: output }], isError: options.error === true },
    isPartial: false,
    render: () => [],
    setExpanded: () => {},
    callRendererComponent: { render: () => [`$ ${command}`] },
  } as ToolRowLike;
}

const cells = (command: string, output: string, options: { error?: boolean } = {}) => recordCells(bash(command, output, options));
const SILENT = "(no output)";

test("a worktree is created when git's checkout completes, named by its branch", () => {
  assert.deepEqual(
    cells(
      "git fetch origin && git worktree add -b release/0.16.0 /tmp/pine-of-glass-release-0.16.0 origin/main",
      "Preparing worktree (new branch 'release/0.16.0')\nbranch 'release/0.16.0' set up to track 'origin/main'.\nHEAD is now at f238efe Release pine-of-glass 0.16.0 (#160)\n",
    ),
    ["created worktree release/0.16.0"],
  );
  assert.deepEqual(
    cells("git worktree add .worktrees/fix fix", "Preparing worktree (checking out 'fix')\nUpdating files:  88% (3881/4396)\rUpdating files: 100% (4396/4396), done.\nHEAD is now at a4f21c9 Fix parser\n"),
    ["created worktree fix"],
  );
  // A detached worktree is named by its sha, which stays dim like a commit's.
  const [detached] = recordFacts(bash("git worktree add --detach /tmp/review HEAD", "Preparing worktree (detached HEAD 5372dd0)\nHEAD is now at 5372dd0 init\n"));
  assert.deepEqual([detached?.datum, detached?.opaque], ["5372dd0", true]);
});

test("announced work is not completion", () => {
  assert.deepEqual(cells("git worktree add .worktrees/fix fix", "Preparing worktree (checking out 'fix')\nfatal: 'fix' is already used by worktree at '/repo/.worktrees/old'\n", { error: true }), []);
  assert.deepEqual(cells("git worktree add -b fix ../wt 2>&1 | head -1", "Preparing worktree (new branch 'fix')\n"), []);
});

test("branch lifecycle: created, rebased, deleted locally and on the remote", () => {
  assert.deepEqual(cells("git checkout -b fix origin/main", "Switched to a new branch 'fix'\n"), ["created branch fix"]);
  assert.deepEqual(cells("git switch -c fix", "Switched to a new branch 'fix'\n"), ["created branch fix"]);
  // A progress line shares the success line through `\r`.
  assert.deepEqual(cells("git fetch origin && git rebase origin/main", "Rebasing (1/1)\rSuccessfully rebased and updated refs/heads/release/0.16.0.\n"), ["rebased release/0.16.0"]);
  assert.deepEqual(cells("git rebase origin/main", "Current branch fix is up to date.\n"), []);
  // The cleanup row: the remote deletion is qualified by the remote the command names,
  // and merges with the local one into one cell.
  assert.deepEqual(
    cells(
      "git worktree remove .worktrees/fix && git branch -D fix && git push origin --delete fix",
      "Deleted branch fix (was a4f21c9).\nTo github.com:tmustier/pine-of-glass.git\n - [deleted]         fix\n",
    ),
    ["deleted fix, origin/fix"],
  );
  assert.deepEqual(cells("git push origin :refs/tags/v0.1.0", "To github.com:o/r.git\n - [deleted]         v0.1.0\n"), ["deleted origin/v0.1.0"]);
  assert.deepEqual(cells("git branch -D fix", "error: branch 'fix' not found\n", { error: true }), []);
});

test("an issue opened by gh earns its number", () => {
  assert.deepEqual(cells("gh issue create --title x --body-file /tmp/body.md", "https://github.com/tmustier/pine-of-glass/issues/14\n"), ["opened #14"]);
});

test("output that only imitates success earns nothing", () => {
  // Dry runs print the real porcelain.
  assert.deepEqual(cells("git push --dry-run", "To github.com:o/r.git\n   1c75c2a..50cf33f  main -> main\n"), []);
  assert.deepEqual(cells("git push -n origin main", "To github.com:o/r.git\n   1c75c2a..50cf33f  main -> main\n"), []);
  assert.deepEqual(cells("npm publish --dry-run --access public", "npm notice Publishing to https://registry.npmjs.org/ (dry-run)\n+ pine-of-glass@0.5.10\n"), []);
  // `git fetch` prints push-shaped lines; `set-url --push` is not a push.
  assert.deepEqual(cells("git remote set-url --push upstream DISABLED && git fetch upstream", "From github.com:o/r\n * [new tag]         v1.2.0     -> v1.2.0\n"), []);
  // `fetch --prune` prints `[deleted]` lines with an arrow; a push deletion has none.
  assert.deepEqual(cells("git push origin --delete fix; git fetch --prune", " - [deleted]         (none)     -> origin/stale\n"), []);
});

test("a command named in quotes, a comment or a heredoc body is not a command", () => {
  assert.deepEqual(cells("echo 'git commit' && cat log.txt", "[main a4f21c9] x\n"), []);
  assert.deepEqual(cells("cat notes.md # then git commit", "[main a4f21c9] x\n"), []);
  assert.deepEqual(cells("cat > /tmp/steps.md <<'EOF'\ngit commit -m x\ngit push\nEOF\ncat /tmp/steps.md", "[main a4f21c9] x\n   1c75c2a..50cf33f  main -> main\n"), []);
  // The command after a heredoc still counts.
  assert.deepEqual(cells("cat > /tmp/body.md <<'EOF'\nSummary\nEOF\ngh pr create --body-file /tmp/body.md", "https://github.com/o/r/pull/88\n"), ["opened PR #88"]);
});

test("completion output counts from substitutions, loops and wrappers", () => {
  assert.deepEqual(cells('PR_URL=$(gh pr create --fill) && echo "$PR_URL"', "https://github.com/o/r/pull/88\n"), ["opened PR #88"]);
  assert.deepEqual(cells('out=$(git -C "$dir" push origin main 2>&1); echo "$out"', "To github.com:o/r.git\n   1c75c2a..50cf33f  main -> main\n"), ["pushed main"]);
  assert.deepEqual(
    cells('for n in 8 9; do gh issue close "$n" --comment done; done', "✓ Closed issue o/r#8 (a)\n✓ Closed issue o/r#9 (b)\n"),
    ["closed #8, #9"],
  );
  assert.deepEqual(cells("env -u PINET_MESH_SECRET git push", "To github.com:o/r.git\n   1c75c2a..50cf33f  main -> main\n"), ["pushed main"]);
});

test("quiet success: a silent worktree removal is its own row's status", () => {
  const [removed] = recordFacts(bash("set -euo pipefail\ncd ~/projects/pine-of-glass\ngit worktree remove .worktrees/fix", SILENT));
  assert.deepEqual([removed?.verb, removed?.datum, removed?.evidence], ["removed worktree", ".worktrees/fix", "quiet"]);
  assert.deepEqual(cells("git worktree remove --force /tmp/review", SILENT), ["removed worktree /tmp/review"]);
  assert.deepEqual(cells('git worktree remove "$WT"', SILENT), []);
  assert.deepEqual(cells("git worktree remove .worktrees/fix; git worktree prune", SILENT), []);
  assert.deepEqual(cells("git worktree remove .worktrees/fix", "fatal: '.worktrees/fix' contains modified or untracked files, use --force to delete it\n", { error: true }), []);
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
  for (const command of unproven) assert.deepEqual(cells(command, SILENT), [], command);
  // Safe shell options, wrappers and assignments keep the status the operation's own.
  assert.deepEqual(cells("set -euo pipefail\ngh pr merge 87 --squash", SILENT), ["merged PR #87"]);
  assert.deepEqual(cells("GH_TOKEN=$(gh auth token 2>/dev/null || true) gh pr merge 755 --repo o/r --squash", SILENT), ["merged PR #755"]);
});

test("observed state is about the same PR in the same repository", () => {
  assert.deepEqual(cells("gh pr merge 87 --repo a/x; gh pr view 87 --repo b/y --json state -q .state", "MERGED\n"), []);
  assert.deepEqual(cells("gh pr merge 87; cd ../other && gh pr view 87 --json state -q .state", "MERGED\n"), []);
  // A repository only one side states does not conflict.
  const [merged] = recordFacts(bash("gh pr merge 1145 --squash && gh pr view 1145 --repo Nexcade/commercial --json state -q .state", "MERGED\n"));
  assert.deepEqual([merged?.datum, merged?.evidence], ["PR #1145", "state"]);
});

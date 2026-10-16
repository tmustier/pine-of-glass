// The built-in record vocabulary (design language §9.10): plain data, parsed by
// records.ts's parseVocabulary like any other vocabulary. Patterns are strings matched
// with the `g` and `m` flags; `{name}` in a datum reads the pattern's named group.
// An entry loads only when each example yields exactly its records with the entry alone:
// copy examples from real porcelain, and add the near misses that must earn nothing.
import type { VocabularyEntryInput } from "./records.ts";

const SILENT = "(no output)";
const PUSHED = "To github.com:o/r.git\n   1c75c2a..50cf33f  main -> main\n";
// Git's tracking note and checkout progress may sit between a worktree's announcement
// and its completion; `fatal:` never does.
const CHECKED_OUT = String.raw`\)\n(?:branch '[^'\n]+' set up to track [^\n]+\n|Updating files:[^\n]*\n)*HEAD is now at [0-9a-f]+`;

export const BUILT_IN_VOCABULARY = [
  {
    // `[main a4f21c9]`, `[main (root-commit) a4f21c9]`, `[detached HEAD a4f21c9]`. The sha
    // is opaque audit data: the verb wears the ink, the sha stays dim.
    id: "git.commit",
    commands: ["git commit"],
    unless: ["--dry-run"],
    records: [{ output: String.raw`^\[[^\n\]]*?(?<sha>[0-9a-f]{7,40})\]`, verb: "committed", datum: "{sha}", opaque: true }],
    examples: [
      { command: 'git add -A && git commit -m "fix: thing"', output: "[main a4f21c9] fix: thing\n 1 file changed, 2 insertions(+)\n", records: ["committed a4f21c9"] },
      { command: "git commit -m init", output: "[main (root-commit) abc1234] init\n", records: ["committed abc1234"] },
      { command: "git commit -m wip", output: "On branch main\nnothing to commit, working tree clean\n", error: true, records: [] },
    ],
  },
  {
    // `1c75c2a..50cf33f main -> main`, `* [new tag] …`; a forced update tints warning.
    // Rejections (`! [rejected] main -> main`) and `Everything up-to-date` match neither.
    id: "git.push",
    commands: ["git push"],
    unless: ["--dry-run", "-n"],
    records: [
      { output: String.raw`^\s*(?:[0-9a-f]+\.\.\.?[0-9a-f]+|\* \[new (?:branch|tag)\])\s+\S+\s+->\s+(?<ref>\S+)`, verb: "pushed", datum: "{ref}" },
      { output: String.raw`^\s*\+\s?[0-9a-f]+\.\.\.?[0-9a-f]+\s+\S+\s+->\s+(?<ref>\S+)`, verb: "pushed", datum: "{ref}", tone: "warning" },
    ],
    examples: [
      { command: "git push", output: PUSHED, records: ["pushed main"] },
      { command: "git push -u origin feat", output: "To github.com:o/r.git\n * [new branch]      feat -> feat\n", records: ["pushed feat"] },
      { command: "git push --force", output: "To github.com:o/r.git\n + 1c75c2a...50cf33f main -> main (forced update)\n", records: ["pushed main"] },
      { command: "git push", output: "To github.com:o/r.git\n ! [rejected]        main -> main (fetch first)\n", error: true, records: [] },
      { command: "git push --dry-run", output: PUSHED, records: [] },
      { command: "git push -n origin main", output: PUSHED, records: [] },
      // `git fetch` prints push-shaped lines; `set-url --push` is not a push.
      { command: "git remote set-url --push upstream DISABLED && git fetch upstream", output: "From github.com:o/r\n * [new tag]         v1.2.0     -> v1.2.0\n", records: [] },
    ],
  },
  {
    // ` - [deleted]  fix`: the output names the ref, the command names the remote (code).
    // `fetch --prune` prints `[deleted]` lines with an arrow; a push deletion has none.
    id: "git.push.delete",
    commands: ["git push"],
    unless: ["--dry-run", "-n"],
    records: [{ output: String.raw`^\s*- \[deleted\]\s+(?<ref>\S+)\s*$`, verb: "deleted", datum: "{ref}" }],
    examples: [
      { command: "git push origin --delete fix", output: "To github.com:o/r.git\n - [deleted]         fix\n", records: ["deleted origin/fix"] },
      { command: "git push origin :refs/tags/v0.1.0", output: "To github.com:o/r.git\n - [deleted]         v0.1.0\n", records: ["deleted origin/v0.1.0"] },
      {
        command: "git worktree remove .worktrees/fix && git branch -D fix && git push origin --delete fix",
        output: "Deleted branch fix (was a4f21c9).\nTo github.com:o/r.git\n - [deleted]         fix\n",
        records: ["deleted origin/fix"],
      },
      { command: "git push origin --delete fix; git fetch --prune", output: " - [deleted]         (none)     -> origin/stale\n", records: [] },
    ],
  },
  {
    id: "git.branch.delete",
    commands: ["git branch"],
    requires: ["--delete", "-d", "-D"],
    records: [{ output: String.raw`^Deleted branch (?<branch>\S+) \(was [0-9a-f]+\)\.$`, verb: "deleted", datum: "{branch}" }],
    examples: [
      { command: "git branch -D fix", output: "Deleted branch fix (was a4f21c9).\n", records: ["deleted fix"] },
      { command: "git branch -D fix", output: "error: branch 'fix' not found\n", error: true, records: [] },
    ],
  },
  {
    id: "git.branch.create",
    commands: ["git checkout", "git switch"],
    requires: ["--create", "--force-create", "-b", "-B", "-c", "-C"],
    records: [{ output: String.raw`^Switched to a new branch '(?<branch>[^'\n]+)'$`, verb: "created branch", datum: "{branch}" }],
    examples: [
      { command: "git checkout -b fix origin/main", output: "Switched to a new branch 'fix'\n", records: ["created branch fix"] },
      { command: "git switch -c fix", output: "Switched to a new branch 'fix'\n", records: ["created branch fix"] },
      { command: "git checkout -b fix", output: "fatal: a branch named 'fix' already exists\n", error: true, records: [] },
    ],
  },
  {
    // `Preparing worktree (…)` announces the work; `HEAD is now at` completes it. A
    // worktree is named by its branch, or by its sha when detached.
    id: "git.worktree.add",
    commands: ["git worktree add"],
    records: [
      { output: String.raw`^Preparing worktree \((?:new branch|checking out) '(?<branch>[^'\n]+)'${CHECKED_OUT}`, verb: "created worktree", datum: "{branch}" },
      { output: String.raw`^Preparing worktree \(detached HEAD (?<sha>[0-9a-f]+)${CHECKED_OUT}`, verb: "created worktree", datum: "{sha}", opaque: true },
    ],
    examples: [
      {
        command: "git fetch origin && git worktree add -b release/0.16.0 /tmp/pog-release origin/main",
        output: "Preparing worktree (new branch 'release/0.16.0')\nbranch 'release/0.16.0' set up to track 'origin/main'.\nHEAD is now at f238efe Release 0.16.0 (#160)\n",
        records: ["created worktree release/0.16.0"],
      },
      {
        command: "git worktree add .worktrees/fix fix",
        output: "Preparing worktree (checking out 'fix')\nUpdating files:  88% (3881/4396)\rUpdating files: 100% (4396/4396), done.\nHEAD is now at a4f21c9 Fix parser\n",
        records: ["created worktree fix"],
      },
      { command: "git worktree add --detach /tmp/review HEAD", output: "Preparing worktree (detached HEAD 5372dd0)\nHEAD is now at 5372dd0 init\n", records: ["created worktree 5372dd0"] },
      { command: "git worktree add .worktrees/fix fix", output: "Preparing worktree (checking out 'fix')\nfatal: 'fix' is already used by worktree at '/repo/.worktrees/old'\n", error: true, records: [] },
      { command: "git worktree add -b fix ../wt 2>&1 | head -1", output: "Preparing worktree (new branch 'fix')\n", records: [] },
    ],
  },
  {
    // Quiet success (code): `git worktree remove` prints nothing and exits 0 only once the
    // working tree and its administrative files are gone; a dirty or locked tree exits 128
    // (git-worktree(1)). The datum is the path as typed.
    id: "git.worktree.remove",
    commands: ["git worktree remove"],
    examples: [
      { command: "git worktree remove --force /tmp/review", output: SILENT, records: ["removed worktree /tmp/review"] },
      { command: 'git worktree remove "$WT"', output: SILENT, records: [] },
      { command: "git worktree remove .worktrees/fix", output: "fatal: '.worktrees/fix' contains modified or untracked files, use --force to delete it\n", error: true, records: [] },
    ],
  },
  {
    // A progress line may share the line through `\r`: `Rebasing (1/1)\rSuccessfully …`.
    id: "git.rebase",
    commands: ["git rebase"],
    records: [{ output: String.raw`Successfully rebased and updated refs/heads/(?<branch>\S+?)\.(?=\s|$)`, verb: "rebased", datum: "{branch}" }],
    examples: [
      { command: "git rebase origin/main", output: "Rebasing (1/1)\rSuccessfully rebased and updated refs/heads/release/0.16.0.\n", records: ["rebased release/0.16.0"] },
      { command: "git rebase origin/main", output: "Current branch fix is up to date.\n", records: [] },
    ],
  },
  {
    // Observed state and quiet success are code: exit 0 means merged unless `--auto` or
    // `--disable-auto` only changed merge settings.
    id: "gh.pr.merge",
    commands: ["gh pr merge"],
    records: [{ output: String.raw`(?:Merged|Squashed and merged|Rebased and merged) pull request \S*?#(?<number>\d+)`, verb: "merged", datum: "PR #{number}" }],
    examples: [
      { command: "gh pr merge 87 --squash --delete-branch", output: "✓ Squashed and merged pull request o/r#87 (records)\n✓ Deleted branch records\n", records: ["merged PR #87"] },
      { command: "gh pr merge 120 --squash --delete-branch", output: SILENT, records: ["merged PR #120"] },
      { command: "gh pr merge 126 --squash && gh pr view 126 --json state,url", output: '{"state":"MERGED","url":"https://github.com/o/r/pull/126"}\n', records: ["merged PR #126"] },
      { command: "gh pr merge 120 --auto", output: SILENT, records: [] },
      { command: "gh pr merge 120 --squash", output: "! Pull request o/r#120 was already merged\n", records: [] },
    ],
  },
  {
    id: "gh.pr.close",
    commands: ["gh pr close"],
    records: [{ output: String.raw`Closed pull request \S*?#(?<number>\d+)`, verb: "closed", datum: "PR #{number}" }],
    examples: [{ command: "gh pr close 12", output: "✓ Closed pull request o/r#12 (stale)\n", records: ["closed PR #12"] }],
  },
  {
    id: "gh.pr.create",
    commands: ["gh pr create"],
    unless: ["--dry-run"],
    records: [{ output: String.raw`/pull/(?<number>\d+)\b`, verb: "opened", datum: "PR #{number}" }],
    examples: [
      { command: "gh pr create --fill", output: "https://github.com/o/r/pull/88\n", records: ["opened PR #88"] },
      { command: 'PR_URL=$(gh pr create --fill) && echo "$PR_URL"', output: "https://github.com/o/r/pull/88\n", records: ["opened PR #88"] },
    ],
  },
  {
    id: "gh.issue.create",
    commands: ["gh issue create"],
    records: [{ output: String.raw`github\.com/[^/\s]+/[^/\s]+/issues/(?<number>\d+)\b`, verb: "opened", datum: "#{number}" }],
    examples: [{ command: "gh issue create --title x --body-file /tmp/body.md", output: "https://github.com/o/r/issues/14\n", records: ["opened #14"] }],
  },
  {
    id: "gh.issue.close",
    commands: ["gh issue close"],
    records: [{ output: String.raw`Closed issue \S*?#(?<number>\d+)`, verb: "closed", datum: "#{number}" }],
    examples: [{ command: "gh issue close 12", output: "✓ Closed issue o/r#12 (rail glyphs)\n", records: ["closed #12"] }],
  },
  {
    // The tag is URL-encoded in the release URL; code decodes it.
    id: "gh.release.create",
    commands: ["gh release create"],
    records: [{ output: String.raw`/releases/tag/(?<tag>[^\s/]+)`, verb: "released", datum: "{tag}" }],
    examples: [
      { command: "gh release create v0.5.9 --notes x", output: "https://github.com/o/r/releases/tag/v0.5.9\n", records: ["released v0.5.9"] },
      { command: "gh release create v1.0.0+build.7 --notes x", output: "https://github.com/o/r/releases/tag/v1.0.0%2Bbuild.7\n", records: ["released v1.0.0+build.7"] },
    ],
  },
  {
    // npm's publish porcelain: `+ pine-of-glass@0.5.10`. A dry run prints the same line.
    id: "npm.publish",
    commands: ["npm publish"],
    unless: ["--dry-run"],
    records: [{ output: String.raw`^\+ \S+@(?<version>[^\s@]+)\s*$`, verb: "published", datum: "{version}" }],
    examples: [
      { command: "npm publish", output: "npm notice Publishing to https://registry.npmjs.org/\n+ pine-of-glass@0.5.10\n", records: ["published 0.5.10"] },
      { command: "npm publish --dry-run --access public", output: "npm notice Publishing to https://registry.npmjs.org/ (dry-run)\n+ pine-of-glass@0.5.10\n", records: [] },
    ],
  },
] satisfies VocabularyEntryInput[];

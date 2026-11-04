import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

export function linkedPiLaunch(repoRoot) {
  const cli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  const argv = [process.execPath, realpathSync(cli)];
  return { argv, shell: argv.map(shellQuote).join(" ") };
}

// Each smoke runs its own tmux server rather than the shared default one, whose state
// it does not control: a default server started from a since-deleted directory gives
// every new pane that directory, even with -c, and Pi exits before painting. The
// caller kills the server and removes this socket, which tmux leaves behind.
export function smokeTmuxSocket(name) {
  const socketDir = process.env.CLAUDE_TMUX_SOCKET_DIR ?? join(tmpdir(), "claude-tmux-sockets");
  mkdirSync(socketDir, { recursive: true });
  return join(socketDir, `pog-${name}-${process.pid}.sock`);
}

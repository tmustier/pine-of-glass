import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

export const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Launch the exact installed Pi runtime linked for contract tests. Going through a
 * user shell wrapper is not equivalent once a smoke fixture replaces HOME: wrappers
 * commonly resolve Node or Pi itself relative to the user's real home directory. */
export function linkedPiLaunch(repoRoot) {
  const packageDir = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  const cli = join(packageDir, "dist", "bundle", "cli.js");
  if (!existsSync(cli)) {
    throw new Error("Pi runtime is not linked; run `npm run link-pi` before the smoke suite");
  }
  const argv = [process.execPath, realpathSync(cli)];
  return { argv, shell: argv.map(shellQuote).join(" ") };
}

import { realpathSync } from "node:fs";
import { join } from "node:path";

export const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

export function linkedPiLaunch(repoRoot) {
  const cli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  const argv = [process.execPath, realpathSync(cli)];
  return { argv, shell: argv.map(shellQuote).join(" ") };
}

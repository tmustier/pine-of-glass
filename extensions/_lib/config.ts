// Shared config-file convention for the pine-of-glass extension family:
// user-level `~/.pi/agent/<name>.json`, then project-level `<cwd>/.pi/<name>.json`.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function expandHomePath(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2));
  return filePath;
}

/** Read JSON config through a domain parser; undefined on absence or any parse error. */
export function readJsonConfig<T>(filePath: string, parse: (value: unknown) => T): T | undefined {
  try {
    const expanded = expandHomePath(filePath);
    if (!existsSync(expanded)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(expanded, "utf8"));
    return parse(parsed);
  } catch {
    return undefined;
  }
}

/** Standard lookup order: user file first, project file second (later overrides). */
export function configPaths(name: string, cwd: string): string[] {
  return [join(homedir(), ".pi", "agent", `${name}.json`), join(cwd, ".pi", `${name}.json`)];
}

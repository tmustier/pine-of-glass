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

/** Read and parse a JSON object file; undefined on absence or any error. */
export function readJsonConfig<T extends object>(filePath: string): T | undefined {
  try {
    const expanded = expandHomePath(filePath);
    if (!existsSync(expanded)) return undefined;
    const parsed = JSON.parse(readFileSync(expanded, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Standard lookup order: user file first, project file second (later overrides). */
export function configPaths(name: string, cwd: string): string[] {
  return [join(homedir(), ".pi", "agent", `${name}.json`), join(cwd, ".pi", `${name}.json`)];
}

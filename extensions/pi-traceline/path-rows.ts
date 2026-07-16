import type { ToolArgsLike, ToolRowDataLike } from "../_lib/chat.ts";
import { tildify } from "../_lib/style.ts";

export function lineRange(args: ToolArgsLike | undefined): string {
  const rawOffset = args?.offset;
  const rawLimit = args?.limit;
  const offset = typeof rawOffset === "number" && Number.isFinite(rawOffset) ? Math.max(1, Math.floor(rawOffset)) : undefined;
  const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : undefined;
  if (offset !== undefined && limit !== undefined) return `:${offset}-${offset + limit - 1}`;
  if (offset !== undefined) return `:${offset}`;
  if (limit !== undefined) return `:1-${limit}`;
  return "";
}

// The directory key a read fold groups on (design language §9.9): everything up to
// and including the raw path's last `/`, so bare cwd-relative names share the empty key.
export function readDirKey(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

export function cwdRelativePath(comp: ToolRowDataLike | undefined, rawPath: string): string {
  const tilde = tildify(rawPath);
  const cwd = typeof comp?.cwd === "string" && comp.cwd.length > 0 ? comp.cwd : undefined;
  if (!cwd) return tilde;
  const cwdPrefix = `${tildify(cwd).replace(/\/+$/, "")}/`;
  return tilde.startsWith(cwdPrefix) ? `./${tilde.slice(cwdPrefix.length)}` : tilde;
}

export function commonDirSegments(paths: string[]): string[] {
  const split = paths.map((path) => path.slice(0, path.lastIndexOf("/") + 1).split("/").slice(0, -1));
  let common = split[0] ?? [];
  for (const segments of split.slice(1)) {
    let index = 0;
    while (index < common.length && index < segments.length && common[index] === segments[index]) index++;
    common = common.slice(0, index);
  }
  return common;
}

export function compactReadDisplay(
  nativeVisible: string,
  range: string,
): { classification: "docs" | "resource"; path: string } | undefined {
  const withoutRange = range && nativeVisible.endsWith(range)
    ? nativeVisible.slice(0, -range.length)
    : nativeVisible;
  const match = /^read (docs|resource) (.+)$/.exec(withoutRange);
  if (!match) return undefined;
  const classification = match[1] === "docs" ? "docs" : "resource";
  return { classification, path: match[2]! };
}

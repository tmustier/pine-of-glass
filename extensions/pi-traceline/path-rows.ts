import { realpathSync } from "node:fs";
import type { ToolArgsLike, ToolRowDataLike } from "../_lib/chat.ts";
import { expandHomePath } from "../_lib/config.ts";
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

function resolveFolder(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

// The part of `path` below `dir` ("" for `dir` itself), or undefined when it lies
// outside (design language §9.5). "Below" is about the folder, not its spelling: if the
// text does not match, an existing ancestor that resolves to `dir` counts, so
// `/tmp/demo/a.ts` is below `/private/tmp/demo`. The tail keeps the caller's spelling.
// Both may be tildified.
export function pathBelow(path: string, dir: string): string | undefined {
  const target = expandHomePath(path).replace(/\/+$/, "");
  const root = expandHomePath(dir).replace(/\/+$/, "");
  if (root.length === 0) return undefined;
  if (target === root) return "";
  if (target.startsWith(`${root}/`)) return target.slice(root.length + 1);
  const real = target.startsWith("/") ? resolveFolder(root) : undefined;
  if (real === undefined) return undefined;
  for (let cut = target.length; cut > 0; cut = target.lastIndexOf("/", cut - 1)) {
    if (resolveFolder(target.slice(0, cut)) === real) return target.slice(cut + 1);
  }
  return undefined;
}

export function cwdRelativePath(comp: ToolRowDataLike | undefined, rawPath: string): string {
  const cwd = typeof comp?.cwd === "string" && comp.cwd.length > 0 ? comp.cwd : undefined;
  const tail = cwd === undefined ? undefined : pathBelow(rawPath, cwd);
  return tail ? `./${tail}` : tildify(rawPath);
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

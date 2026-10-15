// Pins for the pi seams behind the peek pager's fidelity surface (design language
// §9.13) and the trace row's image what-fact (§9.7): the result image blocks pi's
// read tool emits, the ToolExecutionComponent fields the pager piggybacks on
// (showImages, image sources handed to pi-tui's transcoding Image), the call
// fallback that justifies the pager's argument grammar, the syntax-highlight exports
// behind the pager's code grammar, and the pi-tui image API (Image component line
// accounting, kitty id deletion). After `pi update`, a failure here names exactly
// which seam drifted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as piTui from "@earendil-works/pi-tui";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");

function pngBase64(widthPx: number, heightPx: number): string {
  const buffer = Buffer.alloc(96);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12);
  buffer.writeUInt32BE(widthPx, 16);
  buffer.writeUInt32BE(heightPx, 20);
  return buffer.toString("base64");
}

test("read tool emits image result blocks the pager and image fact consume", () => {
  const source = readFileSync(join(piRoot, "dist/core/tools/read.js"), "utf8");
  assert.ok(
    source.includes('{ type: "image", data: processed.data, mimeType: processed.mimeType }'),
    "read no longer emits { type: 'image', data, mimeType } blocks — image fidelity seam drifted",
  );
});

test("ToolExecutionComponent seams the pager piggybacks on", () => {
  const source = readFileSync(join(piRoot, "dist/modes/interactive/components/tool-execution.js"), "utf8");
  assert.ok(
    source.includes("this.showImages = options.showImages ?? true;"),
    "showImages default drifted — the pager mirrors this row setting",
  );
  assert.ok(
    source.includes('this.result.content.filter((c) => c.type === "image")'),
    "image blocks no longer filtered by type — the pager's per-block indexing drifted",
  );
  // Pi 1.x keeps no conversions on the row: it hands each block's source to pi-tui's
  // Image and registers the PNG transcoder that Image applies for kitty. The pager
  // passes sources through the same way (drill-pager-content.ts imagePixelSource).
  assert.ok(
    !source.includes("convertedImages") &&
      source.includes("new Image(source.data, source.mimeType,") &&
      source.includes("ensurePngTranscoder("),
    "the row's image conversion moved — re-check imagePixelSource's era test (convertedImages)",
  );
  const imageSource = readFileSync(join(resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-tui"))), "components/image.js")), "utf8");
  assert.ok(
    /caps\.images === "kitty" && this\.mimeType !== "image\/png"\) \{\s*this\.pngData \?\?= toPng\(/.test(imageSource),
    "pi-tui Image no longer transcodes non-PNG for kitty — the pager would hand kitty raw JPEG",
  );
  // A tool without renderCall renders its bold name plus a collapsed `key=value`
  // preview cut at a fixed character budget (pi 0.99: formatToolCallWithArgs); the
  // pager still renders the complete, aligned arguments itself (§9.13) because the
  // preview is lossy.
  assert.ok(
    source.includes("createCallFallback() {") &&
      source.includes("return new Text(formatToolCallWithArgs(this.toolName, this.args, theme, this.expanded), 0, 0);"),
    "call fallback shape drifted — revisit whether the argument grammar still owns this gap",
  );
  const renderUtils = readFileSync(join(piRoot, "dist/core/tools/render-utils.js"), "utf8");
  assert.ok(
    /const preview = pairs\.length > COLLAPSED_ARGS_CHARS \? `\$\{pairs\.slice\(0, COLLAPSED_ARGS_CHARS - 3\)\}\.\.\.` : pairs;/.test(renderUtils),
    "collapsed fallback preview no longer lossy — the pager's argument grammar may be redundant",
  );
});

test("syntax-highlight exports behind the pager's code grammar", () => {
  // The pager claims code only through pi's own path-to-language mapping, and inks it
  // through pi's own highlighter; both must stay exported and line-preserving.
  assert.equal(getLanguageFromPath("a/b.ts"), "typescript");
  assert.equal(getLanguageFromPath("dist/x.mjs"), "javascript");
  assert.equal(getLanguageFromPath("notes.txt"), undefined, "prose must never earn a code claim");
  const code = "const x = 1;\n\nconst y = 2;";
  const lines = highlightCode(code, "typescript");
  assert.equal(lines.length, 3, "highlightCode must preserve line structure");
  assert.equal(
    lines.map((line) => line.replaceAll(/\x1b\[[0-9;]*m/g, "")).join("\n"),
    code,
    "highlighting must be ink only, never content",
  );
});

test("pi-tui image API: Image line accounting, capability override, kitty deletion", () => {
  const original = piTui.getCapabilities();
  try {
    piTui.setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
    const image = new piTui.Image(pngBase64(100, 800), "image/png", { fallbackColor: (s: string) => s }, { maxWidthCells: 20, maxHeightCells: 10 });
    const lines = image.render(60);
    assert.ok(lines.length >= 1 && lines.length <= 10, "Image.render must account its height in lines, capped by maxHeightCells");
    assert.ok(lines.some((line) => line.includes("\x1b]1337")), "iterm2 sequence gone from rendered lines");

    piTui.setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const fallback = new piTui.Image(pngBase64(4, 4), "image/png", { fallbackColor: (s: string) => s });
    assert.match(fallback.render(60).join("\n"), /\[Image: \[image\/png\] 4x4\]/, "capability-less fallback text drifted");
  } finally {
    piTui.setCapabilities(original);
  }
  assert.deepEqual(piTui.getImageDimensions(pngBase64(1044, 646), "image/png"), { widthPx: 1044, heightPx: 646 });
  assert.ok(piTui.deleteKittyImage(7).includes("a=d"), "kitty delete sequence drifted — pager dispose would leak images");
});

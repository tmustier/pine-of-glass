// Pins for the pi seams behind the peek pager's image fidelity (design language
// §9.13) and the trace row's image what-fact (§9.7): the result image blocks pi's
// read tool emits, the ToolExecutionComponent fields the pager piggybacks on
// (showImages, convertedImages, the kitty PNG-only guard), the bare-name call
// fallback that justifies the pager's argument grammar, and the pi-tui image API
// (Image component line accounting, kitty id deletion). After `pi update`, a failure
// here names exactly which seam drifted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as piTui from "@earendil-works/pi-tui";

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
    "image blocks no longer filtered by type — convertedImages indexing drifted",
  );
  assert.ok(
    source.includes("this.convertedImages.set(index, converted)"),
    "convertedImages no longer keyed by image-block index — the pager's kitty reuse drifted",
  );
  assert.ok(
    /caps\.images === "kitty" && imageMimeType !== "image\/png"/.test(source),
    "kitty PNG-only guard gone — re-verify the pager's mirrored guard",
  );
  // A tool without renderCall renders only its bold name; that bareness is why the
  // pager renders the complete arguments itself (§9.13).
  assert.ok(
    source.includes("createCallFallback() {") &&
      source.includes("return new Text(theme.fg(\"toolTitle\", theme.bold(this.toolName)), 0, 0);"),
    "call fallback no longer a bare tool name — revisit whether the argument grammar still owns this gap",
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

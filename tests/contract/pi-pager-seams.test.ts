// Runtime contracts for the pager's image and syntax-highlighting APIs (§9.13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as piTui from "@earendil-works/pi-tui";
import { createReadTool, getLanguageFromPath, highlightCode, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { mouseViewport } from "../fixtures/mouse-viewport.ts";

function pngBase64(widthPx: number, heightPx: number): string {
  const buffer = Buffer.alloc(96);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12);
  buffer.writeUInt32BE(widthPx, 16);
  buffer.writeUInt32BE(heightPx, 20);
  return buffer.toString("base64");
}

test("native read images render by default and respect the row's showImages setting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pog-image-contract-"));
  const caps = piTui.getCapabilities();
  try {
    const path = join(dir, "pixel.png");
    writeFileSync(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=", "base64"));
    const result = await createReadTool(dir, { autoResizeImages: false }).execute("read-image", { path });
    const image = result.content.find((block) => block.type === "image");
    assert.ok(image, "read must return an image block, not a text-only description");
    assert.equal(image.mimeType, "image/png");
    assert.deepEqual(piTui.getImageDimensions(image.data, image.mimeType), { widthPx: 1, heightPx: 1 });

    initTheme(undefined, false);
    piTui.setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
    const { view } = mouseViewport();
    for (const showImages of [undefined, false]) {
      const row = new ToolExecutionComponent("read", "read-image", { path }, { showImages }, undefined, view, dir);
      row.updateResult({ ...result, isError: false });
      row.setExpanded(true);
      assert.equal(row.render(80).some((line) => line.includes("\x1b]1337")), showImages !== false);
    }
  } finally {
    piTui.setCapabilities(caps);
    rmSync(dir, { recursive: true, force: true });
  }
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

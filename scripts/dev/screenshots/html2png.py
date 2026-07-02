#!/usr/bin/env python3
"""Screenshot an HTML file with headless Chrome, then autocrop to content.

Usage: html2png.py <in.html> <out.png> [--width 1800] [--height 2600]
"""
import subprocess, sys, tempfile, os
from PIL import Image, ImageChops

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PAGE_BG = (0x0B, 0x0C, 0x10)
MARGIN = 56  # device px at scale 2 == 28 css px of page background kept around the frame


def main() -> int:
    html, out = sys.argv[1], sys.argv[2]
    width = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--width"), "1800")
    height = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--height"), "2600")
    with tempfile.TemporaryDirectory() as td:
        raw = os.path.join(td, "raw.png")
        subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--force-device-scale-factor=2",
             f"--window-size={width},{height}", f"--screenshot={raw}",
             "--hide-scrollbars", f"file://{os.path.abspath(html)}"],
            check=True, capture_output=True, timeout=90,
        )
        img = Image.open(raw).convert("RGB")
        bg = Image.new("RGB", img.size, PAGE_BG)
        # Threshold the diff so the frame's soft drop shadow doesn't inflate the bbox
        # (it fades over hundreds of px and otherwise leaves a lopsided margin).
        diff = ImageChops.difference(img, bg).convert("L").point(lambda v: 255 if v > 12 else 0)
        bbox = diff.getbbox()
        if bbox is None:
            print("nothing rendered", file=sys.stderr)
            return 1
        left = max(bbox[0] - MARGIN, 0)
        top = max(bbox[1] - MARGIN, 0)
        right = min(bbox[2] + MARGIN, img.width)
        bottom = min(bbox[3] + MARGIN, img.height)
        img.crop((left, top, right, bottom)).save(out)
        print(f"wrote {out} ({right - left}x{bottom - top})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

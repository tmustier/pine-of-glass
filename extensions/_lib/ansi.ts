// Shared ANSI helpers for the pine-of-glass extension family.
// This directory has no index.ts on purpose: pi's extension discovery skips it.

/** Strip CSI (colors/cursor) and OSC (hyperlink/title) escape sequences. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

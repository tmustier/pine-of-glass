// Shared ANSI helpers for the pine-of-glass extension family.
// This directory has no index.ts on purpose: pi's extension discovery skips it.

/** Matches one OSC sequence (hyperlink/title). The payload can never contain ESC — ESC
 * starts the ST terminator — so excluding it keeps the match from greedily swallowing
 * the visible text between an ST-terminated OSC 8 open and its close. */
export const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Strip CSI (colors/cursor) and OSC (hyperlink/title) escape sequences. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(OSC_SEQUENCE, "");
}

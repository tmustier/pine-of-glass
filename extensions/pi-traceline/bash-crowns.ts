// Bold command heads in flattened bash rows (§9.4).
import { LINE_BREAK_MARK, PREAMBLE_MARK } from "./bash-preamble.ts";

// Skip leading assignments unless their value runs a command.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Find `$(` or backticks anywhere in the value, excluding single quotes,
// arithmetic and file reads. Nested substitutions in arithmetic still count.
const SUBSTITUTED_HEAD = /^[A-Za-z_][A-Za-z0-9_]*=(?:[^\s`$'()]|\$(?!\()|\$\(\()*(?:\$\(|`)([^\s()`;"'|&<>]*[A-Za-z0-9][^\s()`;"'|&<>]*)/;
// Skip arithmetic and file-read values through their closing parentheses.
const OPEN_VALUE = /\$\(\(|\$\(</;

// Pipes continue a command; only sequencers start a new head.
const BASH_SEQUENCER = /^(?:&&|\|\||;)$/;

// Heredoc bodies bypass head and quote scanning. `<<<` is a here-string.
const BASH_HEREDOC_TOKEN = /^<<-?(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))?$/;

// Prefer substantive commands over setup and plumbing. Block keywords pass
// the head slot to the following command.
const BASH_PREAMBLE_HEADS = new Set(["cd", "set", "mktemp"]);
const BASH_PLUMBING_HEADS = new Set(["echo", "true", "false", "printf", "exit"]);
const BASH_CLOSERS = new Set(["do", "done", "then", "else", "elif", "fi", "esac", "in"]);

export type BashHeadClass = "real" | "plumbing" | "preamble";
/**
 * A head word's range; `token`, where the shell word holding it starts (`PR_URL=$(gh`); and
 * `from`, where its command starts, leading assignments included (§9.4).
 */
export type BashHead = { start: number; end: number; token: number; from: number; cls: BashHeadClass };

function headClass(word: string): BashHeadClass {
  return BASH_PREAMBLE_HEADS.has(word) ? "preamble" : BASH_PLUMBING_HEADS.has(word) ? "plumbing" : "real";
}

// Crown all substantive heads, or the first plumbing/setup head if there are none.
export function bashCrownedHeads(body: string): BashHead[] {
  const heads: BashHead[] = [];
  let quote: "'" | '"' | undefined;
  let headPending = true;
  let heredocTag: string | undefined; // armed by `<<TAG`; active from the next ↵
  let heredocTagFromNext = false; // armed by a bare `<<`; the next token names the tag
  let heredocActive = false;
  let atLineStart = false; // inside a heredoc: was the previous token a ↵?
  let assignedFrom: number | undefined; // the first leading assignment of the pending command
  let valueDepth = 0; // open parens of an OPEN_VALUE assignment; its words are skipped
  const tokens = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(body))) {
    const text = match[0];
    if (heredocActive) {
      if (text === LINE_BREAK_MARK) {
        atLineStart = true;
        continue;
      }
      if (atLineStart && text === heredocTag) {
        heredocActive = false;
        heredocTag = undefined;
      }
      atLineStart = false;
      continue;
    }
    const startsInQuote = quote !== undefined;
    // Count only unquoted, unescaped parentheses and trailing semicolons.
    let endsWithUnquotedSemi = false;
    let depthChange = 0;
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (quote === "'") {
        if (ch === "'") quote = undefined;
      } else if (quote === '"') {
        if (ch === "\\") k++;
        else if (ch === '"') quote = undefined;
      } else if (ch === "'") quote = "'";
      else if (ch === '"') quote = '"';
      else if (ch === "\\") k++;
      else if (ch === "(") depthChange++;
      else if (ch === ")") depthChange--;
      else if (ch === ";" && k === text.length - 1) endsWithUnquotedSemi = true;
    }
    const lineBreak = text === LINE_BREAK_MARK;
    const sequencer = !startsInQuote && (lineBreak || BASH_SEQUENCER.test(text));
    const inValue = valueDepth > 0 && !sequencer;
    if (inValue) valueDepth += depthChange;
    if (sequencer || (inValue && endsWithUnquotedSemi)) {
      heredocActive = lineBreak && heredocTag !== undefined;
      headPending = !heredocActive;
      assignedFrom = undefined;
      valueDepth = 0;
      atLineStart = lineBreak;
      continue;
    }
    if (inValue) continue;
    if (!startsInQuote) {
      if (text === "|") {
        headPending = false;
        continue;
      }
      if (text === PREAMBLE_MARK) continue; // the ⋯ elision mark neither crowns nor consumes
      if (heredocTagFromNext) {
        heredocTagFromNext = false;
        heredocTag = text.replace(/^['"]|['"]$/g, "");
        continue;
      }
      const heredoc = BASH_HEREDOC_TOKEN.exec(text);
      if (heredoc) {
        const tag = heredoc[1] ?? heredoc[2] ?? heredoc[3];
        if (tag !== undefined) heredocTag = tag;
        else heredocTagFromNext = true;
        continue;
      }
      const assignment = headPending && ENV_ASSIGNMENT.test(text);
      if (assignment) assignedFrom ??= match.index;
      const substituted = assignment ? SUBSTITUTED_HEAD.exec(text) : null;
      if (substituted) {
        const wordStart = match.index + substituted[0].length - substituted[1]!.length;
        heads.push({ start: wordStart, end: wordStart + substituted[1]!.length, token: match.index, from: assignedFrom ?? match.index, cls: headClass(substituted[1]!) });
        headPending = false;
        assignedFrom = undefined;
      } else if (assignment && OPEN_VALUE.test(text)) {
        valueDepth = depthChange;
      } else if (headPending && !assignment) {
        // Classify the word inside subshell parentheses, not the punctuation.
        const trimmed = endsWithUnquotedSemi ? text.slice(0, -1) : text;
        const open = /^\(+/.exec(trimmed)?.[0].length ?? 0;
        const close = /\)+$/.exec(trimmed)?.[0].length ?? 0;
        const word = trimmed.slice(open, trimmed.length - close);
        const wordStart = match.index + open;
        if (!/[A-Za-z0-9]/.test(word) || word.startsWith("-")) {
          headPending = false; // §9.4: apparatus and flags consume the slot
        } else if (!BASH_CLOSERS.has(word)) {
          heads.push({ start: wordStart, end: wordStart + word.length, token: wordStart, from: assignedFrom ?? wordStart, cls: headClass(word) });
          headPending = false;
        }
        assignedFrom = undefined;
        // a closer falls through with the slot still armed: `; do gh …` crowns gh
      }
    }
    atLineStart = false;
    if (endsWithUnquotedSemi) {
      headPending = true;
      assignedFrom = undefined;
      valueDepth = 0;
    }
  }
  const real = heads.filter((head) => head.cls === "real");
  if (real.length > 0) return real;
  const fallback = heads.find((head) => head.cls === "plumbing") ?? heads[0];
  return fallback ? [fallback] : [];
}

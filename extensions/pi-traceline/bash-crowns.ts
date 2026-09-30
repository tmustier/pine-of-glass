// Crown selection for bash rows (design language §9.4): which head words of a
// flattened command body render as L0 discriminators. Pure text grammar, measured
// against the 51k-invocation corpus in scripts/dev/bash-corpus/; ink stays in index.ts.
import { LINE_BREAK_MARK, PREAMBLE_MARK } from "./bash-preamble.ts";

// Env-var assignments (`FOO=1 npm test`) are not the command; the head scans past them.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Sequencing operators start a new command whose head word is a discriminator
// (§9.4). Pipes and redirects continue a command — `| head -240` is a filter, and
// §9.4's rejection of brightening filters stands — so `|` consumes a pending head
// slot instead of re-arming it. The attached form of the semicolon (`sleep 60; ps`)
// sequences too (§9.4); it is detected on the token, quote-aware, in the walk below.
const BASH_SEQUENCER = /^(?:&&|\|\||;)$/;

// A heredoc marker arms body-inertness (§9.4): from the `↵` that follows `<<TAG`
// until the terminator line, tokens are data — no heads, no re-arms, and no quote
// tracking, so an unbalanced apostrophe in heredoc prose cannot silence the commands
// after the terminator (§9.4). A bare `<<`/`<<-` takes the next token as its tag;
// `<<<` is a here-string, not a heredoc, and matches neither form.
const BASH_HEREDOC_TOKEN = /^<<-?(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))?$/;

// The crown vocabularies (§9.4, measured over a 51k-invocation corpus — see
// scripts/dev/bash-corpus/). Preambles situate (`cd X && …`, `set -e; …`); plumbing
// glues (`|| true`, `&& echo done`); neither is why the row exists, so neither wears
// a crown when a real command in the row does. Closers are the block keywords a
// sequencer exposes (`; do`, `↵ fi`); they pass the crown to the head that follows.
const BASH_PREAMBLE_HEADS = new Set(["cd", "set"]);
const BASH_PLUMBING_HEADS = new Set(["echo", "true", "false", "printf", "exit"]);
const BASH_CLOSERS = new Set(["do", "done", "then", "else", "elif", "fi", "esac", "in"]);

export type BashHeadClass = "real" | "plumbing" | "preamble";
export type BashHead = { start: number; end: number; cls: BashHeadClass };

// One walk over the flattened body collects every command's head candidate (§9.4's
// grammar): tokens scan left to right with quote state carried across
// them (the gaps are whitespace and hold none), sequencers re-arm the pending head
// slot only outside quotes, a token-final unquoted `;` re-arms exactly like the
// space-delimited form, and heredoc bodies are skipped whole. Within an armed slot:
// env assignments are scanned past (§9.4), block closers pass the crown through,
// and a token with no word character (§9.4) or a leading `-` (a flattened
// continuation line's flag, §9.4) renders headless and consumes the slot so a
// pipe filter cannot inherit it.
export function bashHeadCandidates(body: string): BashHead[] {
  const heads: BashHead[] = [];
  let quote: "'" | '"' | undefined;
  let headPending = true;
  let heredocTag: string | undefined; // armed by `<<TAG`; active from the next ↵
  let heredocTagFromNext = false; // armed by a bare `<<`; the next token names the tag
  let heredocActive = false;
  let atLineStart = false; // inside a heredoc: was the previous token a ↵?
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
    // Advance the quote scanner across this token. A backslash escapes the next
    // character except inside single quotes; a `;` counts as a sequencer only when
    // it is the token's last character and sits outside any quote (`\;` is find's).
    let endsWithUnquotedSemi = false;
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
      else if (ch === ";" && k === text.length - 1) endsWithUnquotedSemi = true;
    }
    if (!startsInQuote) {
      if (text === LINE_BREAK_MARK) {
        if (heredocTag !== undefined) {
          heredocActive = true;
          headPending = false;
        } else headPending = true;
        atLineStart = true;
        continue;
      }
      if (BASH_SEQUENCER.test(text)) {
        headPending = true;
        continue;
      }
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
      if (headPending && !ENV_ASSIGNMENT.test(text)) {
        // Parens are apparatus (§9.4's spirit): `(cd …` and `… || true)` classify
        // and crown on the inner word, so a subshell close cannot smuggle glue past
        // the §9.4 vocabularies and a crown never bolds punctuation.
        const trimmed = endsWithUnquotedSemi ? text.slice(0, -1) : text;
        const open = /^\(+/.exec(trimmed)?.[0].length ?? 0;
        const close = /\)+$/.exec(trimmed)?.[0].length ?? 0;
        const word = trimmed.slice(open, trimmed.length - close);
        const wordStart = match.index + open;
        if (!/[A-Za-z0-9]/.test(word) || word.startsWith("-")) {
          headPending = false; // §9.4: apparatus and flags consume the slot
        } else if (!BASH_CLOSERS.has(word)) {
          const cls: BashHeadClass = BASH_PREAMBLE_HEADS.has(word)
            ? "preamble"
            : BASH_PLUMBING_HEADS.has(word)
              ? "plumbing"
              : "real";
          heads.push({ start: wordStart, end: wordStart + word.length, cls });
          headPending = false;
        }
        // a closer falls through with the slot still armed: `; do gh …` crowns gh
      }
    }
    atLineStart = false;
    if (endsWithUnquotedSemi) headPending = true;
  }
  return heads;
}

// Crown selection is row-global (§9.4): every real command head is crowned, and
// preamble (`cd`, `set`) and plumbing (`echo`, `true`, …) heads render headless
// beside them. A row with no real head keeps its first operative head — plumbing
// before preamble — so no row goes dark: `$ cd /tmp` and `$ echo hi > f` still
// carry one crown each.
export function bashCrownedHeads(body: string): BashHead[] {
  const heads = bashHeadCandidates(body);
  const real = heads.filter((head) => head.cls === "real");
  if (real.length > 0) return real;
  const fallback = heads.find((head) => head.cls === "plumbing") ?? heads[0];
  return fallback ? [fallback] : [];
}

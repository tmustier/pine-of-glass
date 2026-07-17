// Leading-preamble reclaim for bash rows (design language §9.4): the pure string
// grammar that splits a flattened bash body into top-level segments and classifies
// its leading run. Rendering (the `⋯` fold, previous-row comparison, family ink)
// stays in index.ts; everything here is plain text in, plain facts out.

/** ↵ — marks a real newline in a flattened invocation (design language §1). */
export const LINE_BREAK_MARK = "\u21b5";
/** ⋯ — stands in for a preamble identical to the row above (design language §9.4). */
export const PREAMBLE_MARK = "\u22ef";

// Top-level segments of a flattened bash body, split on `&&`/`||`/`;`/`↵` outside
// quotes, command substitutions and backticks. Only the leading preamble run is read
// (the walk stops at the first real command), so heredoc bodies — which live only in
// real segments — need no handling here.
export function bashTopLevelSegments(body: string): { start: number; text: string }[] {
  const segs: { start: number; text: string }[] = [];
  let quote: "'" | '"' | undefined;
  let paren = 0;
  let backtick = false;
  let segStart = 0;
  const push = (end: number) => {
    const raw = body.slice(segStart, end);
    const lead = raw.length - raw.replace(/^\s+/, "").length;
    const text = raw.trim();
    if (text.length > 0) segs.push({ start: segStart + lead, text });
  };
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") { i += 2; continue; }
      if (ch === '"') quote = undefined;
      i++;
      continue;
    }
    if (backtick) {
      if (ch === "`") backtick = false;
      i++;
      continue;
    }
    if (ch === "'") { quote = "'"; i++; continue; }
    if (ch === '"') { quote = '"'; i++; continue; }
    if (ch === "`") { backtick = true; i++; continue; }
    if (ch === "\\") { i += 2; continue; }
    if (ch === "(") { paren++; i++; continue; }
    if (ch === ")") { if (paren > 0) paren--; i++; continue; }
    if (paren === 0) {
      if (body.startsWith("&&", i) || body.startsWith("||", i)) { push(i); i += 2; segStart = i; continue; }
      if (ch === ";" || ch === LINE_BREAK_MARK) { push(i); i += 1; segStart = i; continue; }
    }
    i++;
  }
  push(body.length);
  return segs;
}

// One env-assignment-only segment (`WORK=$(cat x)`, `A=1 B=2`) is setup, not a command,
// so it situates; `FOO=bar cmd` is the command `cmd` and does not. Consumes each
// `VAR=value` token quote/substitution-aware, then checks nothing but assignments remain.
export function isEnvAssignmentOnly(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) return true;
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(text.slice(i))) return false;
    let quote: "'" | '"' | undefined;
    let paren = 0;
    let backtick = false;
    while (i < text.length) {
      const ch = text[i]!;
      if (quote === "'") { if (ch === "'") quote = undefined; i++; continue; }
      if (quote === '"') { if (ch === "\\") { i += 2; continue; } if (ch === '"') quote = undefined; i++; continue; }
      if (backtick) { if (ch === "`") backtick = false; i++; continue; }
      if (ch === "'") { quote = "'"; i++; continue; }
      if (ch === '"') { quote = '"'; i++; continue; }
      if (ch === "`") { backtick = true; i++; continue; }
      if (ch === "\\") { i += 2; continue; }
      if (ch === "(") { paren++; i++; continue; }
      if (ch === ")") { if (paren > 0) paren--; i++; continue; }
      if (paren === 0 && /\s/.test(ch)) break;
      i++;
    }
  }
  return true;
}

export type BashSegmentClass = "hygiene" | "context" | "real";

// `set -…` is hygiene (drop-always); `cd`, `export …` and bare assignments situate
// (fold-on-repeat); everything else is the reason the row exists and stops the run.
export function classifyBashSegment(text: string): BashSegmentClass {
  if (/^set(\s|$)/.test(text)) return "hygiene";
  if (/^cd(\s|$)/.test(text)) return "context";
  if (/^export\s+[A-Za-z_]/.test(text)) return "context";
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) return isEnvAssignmentOnly(text) ? "context" : "real";
  return "real";
}

export type BashPreambleRun = {
  contextText: string; // situating context, joined; "" when the run has none
  firstRealStart?: number; // body index of the first real command, if any
  dropStart?: number; // body index just past a leading `set -…` run, when a drop applies
};

// The leading preamble run of a flattened bash body. contextText compares context
// across rows (both computed from tildified bodies, so `cd ~/x` matches `cd ~/x`);
// firstRealStart is where the `⋯` fold would point; dropStart marks where a leading
// `set -…` run ends. dropStart stays undefined when the whole body is hygiene, so a
// `set -e`-only row keeps its head and no row goes dark (§9.4).
export function bashPreambleRun(body: string): BashPreambleRun {
  const contextParts: string[] = [];
  let firstRealStart: number | undefined;
  let dropStart: number | undefined;
  for (const seg of bashTopLevelSegments(body)) {
    const cls = classifyBashSegment(seg.text);
    if (cls === "real") {
      firstRealStart = seg.start;
      if (dropStart === undefined) dropStart = seg.start;
      break;
    }
    if (cls === "context") {
      contextParts.push(seg.text);
      if (dropStart === undefined) dropStart = seg.start;
    }
    // a leading hygiene (`set`) segment leaves dropStart pointing just past it
  }
  return { contextText: contextParts.join("\n"), firstRealStart, dropStart };
}

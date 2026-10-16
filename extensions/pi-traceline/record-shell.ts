// The shell subset records are recognised in (design language §9.10): words, quotes,
// escapes, comments, `&&`, `||`, `;`, `|`, `&`, line breaks, subshell parentheses and
// heredocs. Plain text in, simple commands out. Control flow, groups, subshells,
// heredocs and background jobs still split into commands but clear `flat`, which quiet
// success requires. A heredoc body is data and never yields a command; a command named
// inside quotes or a comment is a word, not a command. Commands inside `$(…)` and
// backticks are read into `nested`.

/** One shell word, unquoted. `literal`: no expansion can change it at run time. */
export type ShellWord = { text: string; literal: boolean };
export type ShellSeparator = "start" | "&&" | "||" | ";" | "|";
/**
 * A simple command: its words without leading `NAME=value` assignments or redirects,
 * the separator before it, and whether it carries a redirect.
 */
export type ShellCommand = { words: ShellWord[]; before: ShellSeparator; redirected: boolean };
/**
 * `commands` run in the row's shell, in order. `nested` ran inside `$(…)`, backticks or
 * `<(…)`: their output may reach the result, but their status never is the row's.
 */
export type ShellScript = { commands: ShellCommand[]; nested: ShellCommand[]; flat: boolean };

// Reserved words and `!` lead into the command that follows them (`do gh issue close`),
// and make the row compound.
const COMPOUND_WORDS = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "{", "}", "!"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GLOB = /[*?[{]/;

// `env`, `command` and `time` run the words after them as the command and keep its exit
// status: `env -u SECRET git push` is a push.
function unwrapped(words: ShellWord[]): ShellWord[] {
  let i = 0;
  for (;;) {
    const head = words[i];
    if (!head?.literal) return words.slice(i);
    if (head.text === "time" || (head.text === "command" && !words[i + 1]?.text.startsWith("-"))) i++;
    else if (head.text === "env") {
      for (i++; i < words.length; i++) {
        const { text } = words[i]!;
        if (text === "-u") i++;
        else if (!(text === "-i" || text === "-" || /^-u./.test(text) || text.startsWith("--unset=") || ASSIGNMENT.test(text))) break;
      }
    } else return words.slice(i);
  }
}

export function readShell(source: string): ShellScript {
  const commands: ShellCommand[] = [];
  const nested: ShellCommand[] = [];
  let flat = true;
  let words: ShellWord[] = [];
  let redirected = false;
  let before: ShellSeparator = "start";
  let assigning = true; // still reading leading NAME=value words
  let text = "";
  let inWord = false;
  let literal = true;
  let quotedAt = -1; // text index of the word's first quote, -1 when none
  let redirect = false;
  let opTail = ""; // text after the word's last redirect operator
  let redirectNext = false; // a bare `>`: the next word is its target
  let heredoc: "none" | "attached" | "next" = "none";
  const heredocTags: { tag: string; strip: boolean }[] = [];
  let heredocStrip = false;

  const endWord = () => {
    if (!inWord) return;
    const isTarget = redirectNext;
    redirectNext = redirect && (opTail === "" || opTail === "&");
    if (heredoc === "attached") {
      const tag = opTail.replace(/^-/, "");
      if (tag) heredocTags.push({ tag, strip: heredocStrip });
      heredoc = tag ? "none" : "next";
    } else if (heredoc === "next" && isTarget) {
      heredocTags.push({ tag: text, strip: heredocStrip });
      heredoc = "none";
    }
    const eq = text.indexOf("=");
    if (redirect || isTarget) {
      redirected = true;
    } else if (words.length === 0 && quotedAt < 0 && COMPOUND_WORDS.has(text)) {
      flat = false;
    } else if (!assigning || !ASSIGNMENT.test(text) || (quotedAt >= 0 && eq > quotedAt)) {
      assigning = false;
      words.push({ text, literal });
    }
    text = "";
    inWord = false;
    literal = true;
    quotedAt = -1;
    redirect = false;
    opTail = "";
  };
  const endCommand = (separator: ShellSeparator) => {
    endWord();
    words = unwrapped(words);
    if (words.length > 0) {
      commands.push({ words, before, redirected });
      before = separator;
    } else if (separator !== ";") {
      before = separator; // `) || next`, `&&` before a line break keeps its meaning
    }
    words = [];
    redirected = false;
    assigning = true;
  };
  const append = (chars: string) => {
    text += chars;
    inWord = true;
    if (redirect) opTail += chars;
  };
  const markQuote = () => {
    if (quotedAt < 0) quotedAt = text.length;
    inWord = true;
  };
  // `$(…)`, `<(…)`, backticks: one non-literal word here, their commands read into `nested`.
  const substitution = (start: number, open: string, close: string): number => {
    let depth = 1;
    let quote: "'" | '"' | undefined;
    let i = start;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i]!;
      if (quote) {
        if (ch === "\\" && quote === '"') i++;
        else if (ch === quote) quote = undefined;
      } else if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "\\") i++;
      else if (ch === open && open !== close) depth++;
      else if (ch === close) depth--;
    }
    append(source.slice(start - 1, i));
    literal = false;
    const inner = readShell(source.slice(start, Math.max(start, i - 1)));
    nested.push(...inner.commands, ...inner.nested);
    return i - 1;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "'") {
      markQuote();
      const end = source.indexOf("'", i + 1);
      const stop = end < 0 ? source.length : end;
      append(source.slice(i + 1, stop));
      i = stop;
    } else if (ch === '"') {
      markQuote();
      for (i++; i < source.length && source[i] !== '"'; i++) {
        const inner = source[i]!;
        if (inner === "\\" && i + 1 < source.length) append(source[++i]!);
        else if (inner === "$" && source[i + 1] === "(") i = substitution(i + 2, "(", ")");
        else if (inner === "`") i = substitution(i + 1, "`", "`");
        else {
          if (inner === "$") literal = false;
          append(inner);
        }
      }
    } else if (ch === "\\") {
      if (next === "\n") i++;
      else if (next !== undefined) {
        markQuote();
        append(next);
        i++;
      }
    } else if (ch === "#" && !inWord) {
      while (i + 1 < source.length && source[i + 1] !== "\n") i++;
    } else if (ch === " " || ch === "\t") {
      endWord();
    } else if (ch === "\n") {
      endCommand(";");
      // Heredoc bodies are data (§9.4's rule, here for records): skip to each terminator.
      for (const { tag, strip } of heredocTags.splice(0)) {
        let lineStart = i + 1;
        for (;;) {
          const lineEnd = source.indexOf("\n", lineStart);
          const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
          if ((strip ? line.replace(/^\t+/, "") : line) === tag || lineEnd < 0) {
            i = lineEnd < 0 ? source.length : lineEnd - 1;
            break;
          }
          lineStart = lineEnd + 1;
        }
      }
    } else if (ch === ";") {
      if (next === ";") {
        flat = false;
        i++;
      }
      endCommand(";");
    } else if (ch === "&") {
      if (next === "&") {
        endCommand("&&");
        i++;
      } else if (redirect && opTail === "") {
        append(ch); // `>&2`, `2>&1`
      } else if (next === ">") {
        redirect = true;
        text += "&>";
        inWord = true;
        opTail = "";
        i++;
      } else {
        flat = false; // a background job's status is not the row's
        endCommand(";");
      }
    } else if (ch === "|") {
      if (next === "|") {
        endCommand("||");
        i++;
      } else {
        if (next === "&") {
          flat = false;
          i++;
        }
        endCommand("|");
      }
    } else if (ch === "(" && (text.endsWith("$") || text.endsWith("<") || text.endsWith(">")) && inWord) {
      text = text.slice(0, -1);
      i = substitution(i + 1, "(", ")");
    } else if (ch === "(" || ch === ")") {
      flat = false;
      endWord();
      if (ch === ")") endCommand(";");
    } else if (ch === "`") {
      i = substitution(i + 1, "`", "`");
    } else if (ch === "<" || ch === ">") {
      if (ch === "<" && next === "<" && source[i + 2] !== "<") {
        flat = false;
        heredoc = "attached";
        heredocStrip = source[i + 2] === "-";
        text += "<<";
        inWord = true;
        redirect = true;
        opTail = "";
        i++;
        continue;
      }
      if (next === "(") {
        append(ch);
        continue;
      }
      text += ch;
      inWord = true;
      redirect = true;
      opTail = "";
      if (next === ch) {
        text += next;
        i++;
      }
    } else {
      if (ch === "$" || GLOB.test(ch)) literal = false;
      append(ch);
    }
  }
  endCommand(";");
  if (heredoc !== "none") flat = false;
  return { commands, nested, flat };
}

// Builtins that end the shell, change how it runs, or run other text.
const DISARMING = new Set(["exit", "return", "exec", "eval", "source", ".", "trap", "alias", "shopt", "enable"]);
const SAFE_SET_OPTIONS = new Set(["pipefail", "errexit", "nounset", "xtrace"]);

// `set -e`, `-u`, `-x` and `-o pipefail` keep every command running; `set -n` does not.
function safeSet(args: ShellWord[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const { text } = args[i]!;
    if (!/^[-+][euxo]+$/.test(text)) return false;
    if (text.includes("o") && !SAFE_SET_OPTIONS.has(args[++i]?.text ?? "")) return false;
  }
  return true;
}

function disarmsShell(command: ShellCommand): boolean {
  const [head, ...rest] = command.words;
  if (!head?.literal) return true;
  const name = head.text === "builtin" ? rest[0]?.text : head.text;
  if (name !== undefined && DISARMING.has(name)) return true;
  return name === "set" && !safeSet(rest);
}

/**
 * Whether the row's exit status is command `index`'s own (§9.10 quiet success): a flat
 * row whose last command it is, reached by `&&`, `;` or a line break, without a
 * redirect, after no command that ends or disarms the shell.
 */
export function ownsRowStatus(script: ShellScript, index: number): boolean {
  const command = script.commands[index];
  if (!script.flat || !command || index !== script.commands.length - 1) return false;
  if (command.redirected || command.before === "||" || command.before === "|") return false;
  return !script.commands.slice(0, index).some(disarmsShell);
}

// Parsing of the assembled system prompt pi hands extensions. The formats are pinned by
// tests/contract against the installed builders.
import { estimateCharsAsTokens } from "../_lib/heuristics.ts";

export type SkillSummary = {
  name: string;
  description: string;
  location: string;
  chars: number;
  tokens: number;
};

const PROJECT_CONTEXT_RE = /\n?<project_context>\n\n[\s\S]*?\n<\/project_context>\n?/;
export const PROJECT_INSTRUCTIONS_RE = /<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g;
export const AVAILABLE_SKILLS_RE = /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<available_skills>[\s\S]*?<\/available_skills>/;
const SKILL_RE = /<skill>\s*<name>([\s\S]*?)<\/name>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<location>([\s\S]*?)<\/location>\s*<\/skill>/g;
// Pi emits <available_skills> only while read or bash is active. Codex-dialect adapters
// (pi-codex-conversion) swap those tools out and re-inject the index per turn in upstream
// Codex's compact form: `- name: description (file: path)`, description possibly empty
// or spanning lines.
export const SKILLS_INSTRUCTIONS_RE = /\n*<skills_instructions>\n[\s\S]*?<\/skills_instructions>/;
const COMPACT_SKILL_RE = /^- (.+?): ([\s\S]*?) ?\(file: (.+?)\)$/gm;

const SKILL_FORMATS = [
  { block: AVAILABLE_SKILLS_RE, entry: SKILL_RE, decode: unescapeXml },
  { block: SKILLS_INSTRUCTIONS_RE, entry: COMPACT_SKILL_RE, decode: (text: string) => text },
];

function unescapeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function getPromptRemainder(systemPrompt: string): string {
  return systemPrompt
    .replace(PROJECT_CONTEXT_RE, "\n")
    .replace(AVAILABLE_SKILLS_RE, "\n")
    .replace(SKILLS_INSTRUCTIONS_RE, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The skill index block in whichever format the prompt carries, with its parsed entries. */
export function parseSkillsBlock(systemPrompt: string, denominator: number): { content: string; skills: SkillSummary[] } | undefined {
  for (const { block, entry, decode } of SKILL_FORMATS) {
    const match = systemPrompt.match(block);
    if (!match) continue;
    const content = match[0].trim();
    const skills = [...content.matchAll(entry)].map((m) => ({
      name: decode(m[1]!.trim()),
      description: decode(m[2]!.trim()),
      location: decode(m[3]!.trim()),
      chars: m[0].length,
      tokens: estimateCharsAsTokens(m[0].length, denominator),
    }));
    return { content, skills };
  }
  return undefined;
}

export type RuntimeAdditions = { chars: number; snippetCount: number; guidelineCount: number };

// Issue #9: the runtime system prompt is assembled from pi's base prompt plus tool- and
// extension-provided instructions (the "Available tools" snippet lines and deduplicated
// promptGuidelines). Attribute the part we can verify: count only text that is actually
// present in the prompt remainder, deduplicating guidelines the same way pi does, so the
// number is evidence-based rather than a guess from tool metadata.
export function detectRuntimeAdditions(promptRemainder: string, tools: { name: string; promptGuidelines: string[] }[]): RuntimeAdditions {
  let chars = 0;
  let snippetCount = 0;
  let guidelineCount = 0;
  const seenGuidelines = new Set<string>();
  for (const tool of tools) {
    const escapedName = tool.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const snippetMatch = promptRemainder.match(new RegExp(`^- ${escapedName}: .+$`, "m"));
    if (snippetMatch) {
      chars += snippetMatch[0].length + 1; // +1 for the newline the line occupies
      snippetCount += 1;
    }
    for (const guideline of tool.promptGuidelines) {
      const normalized = guideline.trim();
      if (normalized.length === 0 || seenGuidelines.has(normalized)) continue;
      seenGuidelines.add(normalized);
      if (promptRemainder.includes(normalized)) {
        chars += normalized.length + 1;
        guidelineCount += 1;
      }
    }
  }
  return { chars, snippetCount, guidelineCount };
}

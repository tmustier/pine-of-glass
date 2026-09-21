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

const PROJECT_CONTEXT_RE = /\n*<project_context>\n[\s\S]*?\n<\/project_context>\n*/;
export const PROJECT_INSTRUCTIONS_RE = /<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g;
export const AVAILABLE_SKILLS_RE = /\n*<skills>\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<available_skills>[\s\S]*?<\/available_skills>\n<\/skills>\n*/;
const SKILL_RE = /<skill>\s*<name>([\s\S]*?)<\/name>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<location>([\s\S]*?)<\/location>\s*<\/skill>/g;
// Pi emits <available_skills> only while read or bash is active. Codex-dialect adapters
// (pi-codex-conversion) swap those tools out and re-inject the index per turn in upstream
// Codex's compact form: `- name: description (file: path)`, description possibly empty
// or spanning lines.
export const CODEX_SKILLS_RE = /\n*<codex_skills>\n[\s\S]*?<\/codex_skills>/;
const COMPACT_SKILL_RE = /^- (.+?): ([\s\S]*?) ?\(file: (.+?)\)$/gm;

const SKILL_FORMATS = [
  { block: AVAILABLE_SKILLS_RE, entry: SKILL_RE, xml: true },
  { block: CODEX_SKILLS_RE, entry: COMPACT_SKILL_RE, xml: false },
];

export function getPromptRemainder(systemPrompt: string): string {
  return systemPrompt
    .replace(PROJECT_CONTEXT_RE, "\n")
    .replace(AVAILABLE_SKILLS_RE, "\n")
    .replace(CODEX_SKILLS_RE, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The skill index block in whichever format the prompt carries, with its parsed entries. */
export function parseSkillsBlock(systemPrompt: string, denominator: number): { content: string; skills: SkillSummary[] } | undefined {
  for (const { block, entry, xml } of SKILL_FORMATS) {
    const match = systemPrompt.match(block);
    if (!match) continue;
    const content = match[0].trim();
    const skills = [...content.matchAll(entry)].map((m) => {
      const [name, description, location] = m.slice(1, 4).map((field) => {
        const text = field!.trim();
        return xml
          ? text.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")
          : text;
      });
      return {
        name: name!,
        description: description!,
        location: location!,
        chars: m[0].length,
        tokens: estimateCharsAsTokens(m[0].length, denominator),
      };
    });
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

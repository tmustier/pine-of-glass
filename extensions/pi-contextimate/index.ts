import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripAnsi } from "../_lib/ansi.ts";
import {
  findContainerBy, isAssistantRow, isResourceRow, isToolRow,
  type ContainerLike,
} from "../_lib/chat.ts";
import type { ModelSummary } from "../_lib/heuristics.ts";
import { ink } from "../_lib/style.ts";
import { toModelSummary, loadContextimateConfig } from "./heuristic-config.ts";
import { buildSnapshot, type PrefixSnapshot } from "./snapshot.ts";
import { renderSummary, renderCompact, renderExpanded, type ViewMode } from "./render.ts";

type ContextimateGlobal = typeof globalThis & {
  __piContextimateTui?: TUI;
  __piContextimateChat?: ContainerLike;
  __piContextimateBlock?: StartupContextComponent;
  __piContextimateMode?: ViewMode;
  __piContextimateInstallTimer?: ReturnType<typeof setTimeout>;
  __piContextimateModel?: ModelSummary;
};

const g = globalThis as ContextimateGlobal;

const DEFAULT_MODE: ViewMode = "summary";

function nextMode(mode: ViewMode): ViewMode {
  return mode === "summary" ? "compact" : mode === "compact" ? "expanded" : "summary";
}

function wrapLines(lines: string[], width: number): string[] {
  const maxWidth = Math.max(24, width);
  const out: string[] = [];
  for (const rawLine of lines) {
    if (rawLine.length === 0) {
      out.push("");
      continue;
    }
    const wrapped = wrapTextWithAnsi(rawLine, maxWidth);
    if (wrapped.length === 0) out.push("");
    else out.push(...wrapped.map((line) => truncateToWidth(line, maxWidth, "…")));
  }
  return out;
}

class StartupContextComponent implements Component {
  readonly __piContextimateBlock = true;
  private cachedSignature?: string;
  private cachedMode?: ViewMode;
  private cachedWidth?: number;
  private cachedLines?: string[];

  // Explicit fields keep this compatible with Node's strip-only TypeScript loader.
  private readonly snapshot: () => PrefixSnapshot;
  private readonly getTheme: () => Theme;
  private mode: ViewMode;

  constructor(snapshot: () => PrefixSnapshot, getTheme: () => Theme, mode: ViewMode) {
    this.snapshot = snapshot;
    this.getTheme = getTheme;
    this.mode = mode;
  }

  setMode(mode: ViewMode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      g.__piContextimateMode = mode;
      this.invalidate();
    }
  }

  setExpanded(_expanded: boolean): void {
    // Pi's native Ctrl+O path toggles one global boolean and calls setExpanded()
    // on every expandable chat component exactly once per toggle. Use that as
    // the single source of truth for cycling; do not also listen to raw terminal
    // input, or one keypress can advance twice.
    this.setMode(nextMode(this.mode));
  }

  render(width: number): string[] {
    try {
      const snapshot = this.snapshot();
      if (
        this.cachedLines &&
        this.cachedSignature === snapshot.signature &&
        this.cachedMode === this.mode &&
        this.cachedWidth === width
      ) {
        return this.cachedLines;
      }

      const theme = this.getTheme();
      const body = this.mode === "summary"
        ? renderSummary(snapshot, theme, width)
        : this.mode === "compact"
          ? renderCompact(snapshot, theme, width)
          : renderExpanded(snapshot, theme, width);

      this.cachedSignature = snapshot.signature;
      this.cachedMode = this.mode;
      this.cachedWidth = width;
      this.cachedLines = wrapLines(body, Math.max(20, width));
      return this.cachedLines;
    } catch {
      return wrapLines([
        "",
        `${ink(undefined, "accent", "[Contextimate]")} unavailable while Pi finishes resuming this session`,
      ], Math.max(20, width));
    }
  }

  invalidate(): void {
    this.cachedLines = undefined;
  }
}

function isPrefixBlock(component: unknown): boolean {
  return !!component && typeof component === "object"
    && "__piContextimateBlock" in component && component.__piContextimateBlock === true;
}

// _lib/chat.ts isResourceRow, minus the panel itself: the [Contextimate] block renders
// arbitrary text the fuzzy [Section] regex must never re-anchor on.
function isResourceComponent(component: unknown): boolean {
  return !isPrefixBlock(component) && isResourceRow(component);
}

function scheduleInstall(block: StartupContextComponent): void {
  if (g.__piContextimateInstallTimer) clearTimeout(g.__piContextimateInstallTimer);
  let attempts = 0;
  const attempt = () => {
    attempts++;
    try {
      // Pi creates the resource container once and only clears and refills it, so search until it
      // is first found. Spotting resource rows means rendering components, so the search skips the
      // transcript beside the list, which in a long session would cost seconds per search.
      const tui = g.__piContextimateTui;
      const chat = g.__piContextimateChat ?? findContainerBy(
        tui,
        (children) => children.some(isResourceComponent),
        (children) => children.some((child) => isToolRow(child) || isAssistantRow(child)),
      );
      if (chat) {
        g.__piContextimateChat = chat;
        if (!chat.children.includes(block)) {
          chat.children = chat.children.filter((child) => !isPrefixBlock(child));
          let insertAfter = -1;
          for (let i = 0; i < chat.children.length; i++) {
            if (!isResourceComponent(chat.children[i])) continue;
            insertAfter = i;
            // SAFETY: Pi's resource container holds only TUI components.
            const next = chat.children[i + 1] as Component | undefined;
            if (next && stripAnsi(next.render(80).join("")).trim() === "") insertAfter = i + 1;
          }
          chat.children.splice(insertAfter >= 0 ? insertAfter + 1 : 0, 0, block);
          tui?.requestRender(true);
        }
        return;
      }
    } catch {
      // The foreign TUI tree may still be rebuilding; retry after it settles.
    }
    if (attempts < 30) {
      g.__piContextimateInstallTimer = setTimeout(attempt, 50);
    }
  };
  g.__piContextimateInstallTimer = setTimeout(attempt, 0);
}

export type { PrefixSnapshot, PrefixSection, ToolSummary } from "./snapshot.ts";
export type { ModelSummary } from "../_lib/heuristics.ts";
export type { ContextimateConfig, ResolvedHeuristic } from "./heuristic-config.ts";
export type { SessionBreakdown } from "./session-accounting.ts";

export default function piContextimate(pi: ExtensionAPI) {
  // Snapshot building is expensive (system-prompt regex parse, JSON serialization of
  // every tool schema, a full session walk) while rendering is frequent. Rebuild only
  // after a context-changing event or a short staleness window — never per render frame.
  const SNAPSHOT_TTL_MS = 5_000;
  const cache: { value?: PrefixSnapshot; builtAt: number; dirty: boolean } = { builtAt: 0, dirty: true };
  const markDirty = () => {
    cache.dirty = true;
  };

  // Pi keeps before_agent_start rewrites (such as pi-skill-gate's filtered skill index) only
  // while a run is active, so count the prompt the latest run sent once it has one.
  let runPrompt: string | undefined;
  pi.on("turn_start", async (_event, ctx) => {
    runPrompt = ctx.getSystemPrompt();
    markDirty();
  });
  pi.on("message_end", async () => markDirty());
  pi.on("session_compact", async () => markDirty());
  // Branch checkout can change the model that billed the latest usage (issue #58).
  pi.on("session_tree", async () => markDirty());

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Restore Pi's normal header; this extension now renders below Pi's loaded-resource list.
    ctx.ui.setHeader(undefined);

    runPrompt = undefined;
    const currentMode = g.__piContextimateMode ?? DEFAULT_MODE;
    const config = loadContextimateConfig(ctx.cwd);
    g.__piContextimateModel = toModelSummary(ctx.model);
    markDirty();
    const block = new StartupContextComponent(
      () => {
        const now = Date.now();
        if (!cache.value || cache.dirty || now - cache.builtAt > SNAPSHOT_TTL_MS) {
          cache.value = buildSnapshot(pi, {
            systemPrompt: runPrompt ?? ctx.getSystemPrompt(),
            sessionManager: ctx.sessionManager,
            contextUsage: ctx.getContextUsage(),
            model: g.__piContextimateModel ?? toModelSummary(ctx.model),
            config,
          });
          cache.builtAt = now;
          cache.dirty = false;
        }
        return cache.value;
      },
      () => ctx.ui.theme,
      currentMode,
    );
    g.__piContextimateBlock = block;

    ctx.ui.setWidget("__pi_contextimate_capture", (tui) => {
      g.__piContextimateTui = tui;
      return {
        render: () => {
          const activeBlock = g.__piContextimateBlock;
          // Reload and navigation clear Pi's resource container and drop the panel; this
          // zero-line widget puts it back. Until the panel first attaches (quietStartup hides
          // the resource list), only session start and /contextimate search for it.
          if (activeBlock && g.__piContextimateChat && !g.__piContextimateChat.children.includes(activeBlock)) scheduleInstall(activeBlock);
          return [];
        },
        invalidate: () => {},
      };
    });

    scheduleInstall(block);
  });

  pi.on("model_select", async (event, ctx) => {
    g.__piContextimateModel = toModelSummary(event.model);
    markDirty();
    g.__piContextimateBlock?.invalidate();
    if (ctx.hasUI) g.__piContextimateTui?.requestRender(true);
  });

  pi.on("session_shutdown", async () => {
    if (g.__piContextimateInstallTimer) clearTimeout(g.__piContextimateInstallTimer);
    g.__piContextimateInstallTimer = undefined;
  });

  pi.registerCommand("contextimate", {
    description: "Show or switch the startup [Contextimate] view (summary, compact, expanded)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const requested = args.trim().toLowerCase();
      const mode: ViewMode = requested === "summary" || requested === "compact" || requested === "expanded"
        ? requested
        : nextMode(g.__piContextimateMode ?? DEFAULT_MODE);
      g.__piContextimateMode = mode;
      g.__piContextimateBlock?.setMode(mode);
      g.__piContextimateTui?.requestRender(true);
      if (g.__piContextimateBlock) scheduleInstall(g.__piContextimateBlock);
      ctx.ui.notify(`[Contextimate] view: ${mode}`, "info");
    },
  });
}

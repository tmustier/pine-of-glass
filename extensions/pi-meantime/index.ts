import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { captureTui } from "../_lib/capture.ts";
import { appendAnchoredLine, type ChatLineHost } from "../_lib/chatline.ts";
import { configPaths, readJsonConfig } from "../_lib/config.ts";
import { LiveWidget } from "../_lib/live-widget.ts";
import { RequestTracker } from "../_lib/request-cycle.ts";
import { presentation, sessionStates } from "../_lib/session-state.ts";
import type { TextContent } from "../_lib/themed-text.ts";
import { GLYPH, ink, type Tone } from "../_lib/style.ts";
import { hasBilledUsage } from "../_lib/usage.ts";
import { renderPace, renderSlowStartLine, renderSlowStreamLine, tempoWidget } from "./render.ts";
import {
  applyStreamEvent,
  attachPhase,
  baselineFor,
  calibratedWritingCharsPerToken,
  detectSlowStart,
  detectSlowStream,
  liveToolWallClock,
  newLiveCall,
  parseMeantimeConfig,
  resolveCall,
  sessionTotals,
  DEFAULT_CONFIG,
  type CallTiming,
  type Interval,
  type LiveCall,
  type MeantimeConfig,
} from "./timing.ts";

/** Live phase, anomaly notices and the `/pace` timing ledger. UI-only (§10). */

// --- per-session state (docs/state-machines-2026-11-03.md) -------------------------------------

/** The request tracker owns live calls; this phase owns the work after a response. */
type CallPhase =
  | { kind: "between" }
  /** Unbilled responses own tools without a timed call. */
  | { kind: "after"; call?: CallTiming; startedAt: number; tools: ToolClock };

interface ToolClock {
  /** toolCallId to execution start, for top-level tools still running. */
  open: Map<string, number>;
  done: Interval[];
}

interface MeantimeSession extends ChatLineHost {
  calls: CallTiming[];
  requests: RequestTracker<LiveCall>;
  phase: CallPhase;
  /** Set from agent_settled until the next agent_start; Pi's work after agent_end is active. */
  idleSince?: number;
  /** Accumulated out-of-run time (agent settled → next agent start). */
  idleMs: number;
  startedAt: number;
  /** Provider-qualified model identity, used to keep baselines in one currency. */
  currentModel?: string;
  // Presentation, rebound on every session_start.
  theme?: Theme;
  widget?: LiveWidget;
  timer?: ReturnType<typeof setInterval>;
}

const states = sessionStates<MeantimeSession>("pi-meantime");

// One-line tempo facts share cachemire's loop-economics voice (design language §1, §10).
function tempoLine(s: MeantimeSession, tone: Tone, text: string): () => string {
  return () => ink(s.theme, tone, `${GLYPH.econ} ${text}`);
}

function appendChatLine(s: MeantimeSession, text: TextContent): void {
  appendAnchoredLine(s, "meantime", text);
}

function modelLabel(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

// --- phase accounting -----------------------------------------------------------------------

/** Close the tools+harness phase behind the last response. `endedByRequest` gates the harness
 * fact: without a next request the gap has no honest end boundary. */
function closePhase(s: MeantimeSession, endAt: number, endedByRequest: boolean): void {
  const phase = s.phase;
  s.phase = { kind: "between" };
  if (phase.kind !== "after") return;
  const intervals = [...phase.tools.done, ...Array.from(phase.tools.open.values(), (start) => ({ start, end: endAt }))];
  if (phase.call) attachPhase(phase.call, intervals, phase.startedAt, endAt, endedByRequest);
}

// --- widget ---------------------------------------------------------------------------------

function updateWidget(s: MeantimeSession, config: MeantimeConfig, now = Date.now()): void {
  if (!s.widget) return;
  const live = s.requests.inFlight;
  const baseline = live && live.firstTokenAt === undefined
    ? baselineFor(s.calls, s.currentModel, (call) => call.ttftMs)
    : undefined;
  const slowStartBar = baseline && baseline.samples >= config.baselineMinCalls
    ? {
        medianMs: baseline.median,
        thresholdMs: Math.max(config.slowStartFloorMs, baseline.median * config.slowStartFactor),
      }
    : undefined;
  const tools = s.phase.kind === "after" ? s.phase.tools : undefined;
  const line = tempoWidget({
    now,
    live,
    openTools: tools?.open.size ?? 0,
    toolElapsedMs: tools ? liveToolWallClock(tools.done, tools.open.values(), now) : 0,
    writingCharsPerToken: calibratedWritingCharsPerToken(s.calls, s.currentModel),
    slowStartBar,
  });
  s.widget.setLine(line ? tempoLine(s, line.tone, line.text) : "");
}

function unbindPresentation(s: MeantimeSession, ctx: ExtensionContext): void {
  if (s.timer) clearInterval(s.timer);
  s.timer = undefined;
  if (s.widget) ctx.ui.setWidget("pi-meantime", undefined);
  s.widget = undefined;
}

// --- extension entry --------------------------------------------------------------------------

export default function piMeantime(pi: ExtensionAPI): void {
  const config = configPaths("pi-meantime", process.cwd()).reduce(
    (current, filePath) => Object.assign(current, readJsonConfig(filePath, parseMeantimeConfig)),
    { ...DEFAULT_CONFIG },
  );
  if (!config.enabled) return;

  pi.on("session_start", async (event, ctx) => {
    const level = presentation(ctx);
    if (level === "none") return;
    // SDK reload preserves in-flight requests.
    const s = states.open(ctx, event.reason, () => {
      const now = Date.now();
      return {
        calls: [],
        requests: new RequestTracker<LiveCall>(),
        phase: { kind: "between" },
        idleSince: now,
        idleMs: 0,
        startedAt: now,
        anchored: [],
      };
    });
    unbindPresentation(s, ctx);
    if (ctx.model) s.currentModel = modelLabel(ctx.model);
    s.theme = ctx.ui.theme;
    s.notifyFallback = (plainText) => ctx.ui.notify(plainText, "info");
    s.tui = undefined;
    if (level !== "tui") return;
    captureTui(ctx.ui, "__pi_meantime_capture", (tui) => {
      s.tui = tui;
    });
    if (!config.widget) return;
    ctx.ui.setWidget("pi-meantime", (tui) => {
      s.widget = new LiveWidget(tui);
      return s.widget;
    });
    s.timer = setInterval(() => updateWidget(s, config), 1000);
    s.timer.unref();
    updateWidget(s, config);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    unbindPresentation(s, ctx);
    states.close(ctx, event.reason);
  });

  pi.on("model_select", async (event, ctx) => {
    const s = states.get(ctx);
    if (s) s.currentModel = modelLabel(event.model);
  });

  pi.on("agent_start", async (_event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    const now = Date.now();
    if (s.idleSince !== undefined) s.idleMs += Math.max(0, now - s.idleSince);
    s.idleSince = undefined;
    updateWidget(s, config, now);
  });

  pi.on("context", async (_event, ctx) => {
    states.get(ctx)?.requests.arm();
  });

  pi.on("cache_warming_decision", async (event, ctx) => {
    if (event.action === "warm") states.get(ctx)?.requests.expectReplay();
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    const now = Date.now();
    const kind = s.requests.payload(event.payload, () => {
      closePhase(s, now, true);
      return newLiveCall(s.calls.length + 1, now);
    }, () => {});
    if (kind === "agent") updateWidget(s, config, now);
  });

  pi.on("after_provider_response", async (_event, ctx) => {
    states.get(ctx)?.requests.responded(Date.now());
  });

  pi.on("message_update", async (event, ctx) => {
    const live = states.get(ctx)?.requests.inFlight;
    if (!live) return;
    const streamEvent = event.assistantMessageEvent;
    const deltaLength = "delta" in streamEvent ? streamEvent.delta.length : 0;
    applyStreamEvent(live, streamEvent.type, deltaLength, Date.now());
  });

  pi.on("message_end", async (event, ctx) => {
    const s = states.get(ctx);
    const message = event.message;
    if (!s || message.role !== "assistant") return;
    const ended = s.requests.settle();
    if (!ended) return;
    const now = Date.now();
    // A failed or aborted response runs no tools; a retry starts from a fresh context.
    if (message.stopReason === "error" || message.stopReason === "aborted") return;
    const tools: ToolClock = { open: new Map(), done: [] };
    if (!hasBilledUsage(message.usage)) {
      s.phase = { kind: "after", startedAt: now, tools };
      updateWidget(s, config, now);
      return;
    }
    const call = resolveCall(ended.sent, message.usage, now, s.currentModel);
    s.phase = { kind: "after", call, startedAt: now, tools };
    if (config.notices) {
      const slowStart = detectSlowStart(call, s.calls, config);
      if (slowStart) {
        appendChatLine(s, tempoLine(s, "warning", renderSlowStartLine(call, slowStart, config.prefillCauseTokens)));
      }
      const slowStream = detectSlowStream(call, s.calls, config);
      if (slowStream) appendChatLine(s, tempoLine(s, "warning", renderSlowStreamLine(call, slowStream)));
    }
    s.calls.push(call);
    updateWidget(s, config, now);
  });

  // Nested calls (parentToolCallId) run inside their parent tool, whose interval covers them.
  pi.on("tool_execution_start", async (event, ctx) => {
    const s = states.get(ctx);
    if (!s || event.parentToolCallId || s.phase.kind !== "after") return;
    const now = Date.now();
    s.phase.tools.open.set(event.toolCallId, now);
    updateWidget(s, config, now);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const s = states.get(ctx);
    if (!s || event.parentToolCallId || s.phase.kind !== "after") return;
    const now = Date.now();
    const tools = s.phase.tools;
    const startAt = tools.open.get(event.toolCallId);
    if (startAt !== undefined) {
      tools.open.delete(event.toolCallId);
      tools.done.push({ start: startAt, end: now });
    }
    updateWidget(s, config, now);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const s = states.get(ctx);
    if (!s) return;
    const now = Date.now();
    // A send that never produced a response must not linger as a phantom call.
    s.requests.abandon();
    closePhase(s, now, false);
    updateWidget(s, config, now);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const s = states.get(ctx);
    if (s) s.idleSince ??= Date.now();
  });

  pi.registerCommand("pace", {
    description: "Show the meantime tempo & latency ledger",
    handler: async (_args, ctx) => {
      const s = states.get(ctx);
      if (!s) return;
      const now = Date.now();
      const totals = sessionTotals(s.calls, {
        startedAt: s.startedAt,
        now,
        idleMs: s.idleMs,
        idleSince: s.idleSince,
      });
      const calls = s.calls.map((call) => ({ ...call }));
      const options = { config, modelLabel: s.currentModel };
      appendChatLine(s, () => renderPace(calls, totals, { ...options, theme: s.theme }).join("\n"));
    },
  });
}

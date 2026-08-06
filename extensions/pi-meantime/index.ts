import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { captureTui } from "../_lib/capture.ts";
import { type ContainerLike } from "../_lib/chat.ts";
import { appendAnchoredLine, type AnchoredLine } from "../_lib/chatline.ts";
import { configPaths, readJsonConfig } from "../_lib/config.ts";
import { GLYPH, ink, type Tone } from "../_lib/style.ts";
import { renderPace, renderSlowStartLine, renderSlowStreamLine, tempoWidget } from "./render.ts";
import {
  applyStreamEvent,
  attachPhase,
  baselineFor,
  calibratedCharsPerToken,
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

/**
 * pi-meantime — where did the time go, and why? ("what happened in the meantime?")
 *
 * pi's footer already *counts* elapsed time; meantime *explains* it:
 *   1. "Is it thinking, or stuck?"  → a live tempo line above the editor decomposing the
 *      current wait: waiting (no first token yet) / thinking / writing (with a ~tok/s
 *      estimate) / tools, hidden when the loop is idle.
 *   2. "Why was that one slow?"     → anomaly notices against the session's own rolling
 *      per-model median: slow starts (with prefill named as cause when usage proves it)
 *      and collapsed stream rates. Silence when healthy.
 *   3. "Where did the session go?"  → /pace: a per-call ledger (ttft / think / write /
 *      tools / total / out / exact tok/s) with totals and an active-vs-idle share bar.
 *
 * All durations are event-boundary observations from this process (design language
 * §10.1); resolved tok/s is exact provider usage over the observed stream span; live
 * rates are estimates and wear `~`. Display is UI-only: nothing meantime renders enters
 * LLM context, session entries, or exports, and nothing is reconstructed from restored
 * session history (message timestamps cannot yield TTFT or segment splits).
 */

// --- live state ---------------------------------------------------------------------------

interface MeantimeState {
  config: MeantimeConfig;
  calls: CallTiming[];
  live?: LiveCall;
  /** toolCallId → execution start, for tools currently running. */
  openTools: Map<string, number>;
  /** Completed tool execution intervals since the last resolved call. */
  toolIntervals: Interval[];
  /** The span between a resolved call and the next request: its tools + harness gap. */
  pendingPhase?: { callIndex: number; startedAt: number };
  runActive: boolean;
  /** Accumulated out-of-run time (agent settled → next agent start). */
  idleMs: number;
  idleSince?: number;
  startedAt: number;
  /** Provider-qualified model identity, used to keep baselines in one currency. */
  currentModel?: string;
  /** Chat lines meantime appended, with anchors for re-attachment after pi rebuilds. */
  anchored: AnchoredLine[];
  chat?: ContainerLike;
  notifyFallback?: (plainText: string) => void;
  theme?: Theme;
  ui?: Pick<ExtensionUIContext, "setWidget" | "notify">;
  tui?: { requestRender?: (force?: boolean) => void };
  lastWidgetText?: string;
}

type MeantimeGlobal = typeof globalThis & {
  __piMeantime?: MeantimeState;
  __piMeantimeTimer?: ReturnType<typeof setInterval>;
};
const g = globalThis as MeantimeGlobal;

function state(): MeantimeState {
  if (!g.__piMeantime) {
    const now = Date.now();
    g.__piMeantime = {
      config: DEFAULT_CONFIG,
      calls: [],
      openTools: new Map(),
      toolIntervals: [],
      runActive: false,
      idleMs: 0,
      idleSince: now,
      startedAt: now,
      anchored: [],
    };
  }
  return g.__piMeantime;
}

/** Session replacement (/new, /resume, /fork): the watched loop is a different session,
 * so timings restart. /reload keeps everything (same session, same process). */
function resetState(now: number): void {
  const s = state();
  s.calls = [];
  s.live = undefined;
  s.openTools = new Map();
  s.toolIntervals = [];
  s.pendingPhase = undefined;
  s.runActive = false;
  s.idleMs = 0;
  s.idleSince = now;
  s.startedAt = now;
  s.currentModel = undefined;
  s.anchored = [];
  s.chat = undefined;
  s.notifyFallback = undefined;
  s.theme = undefined;
  s.ui = undefined;
  s.tui = undefined;
  s.lastWidgetText = undefined;
}

function loadConfig(cwd: string): MeantimeConfig {
  return configPaths("pi-meantime", cwd).reduce(
    (config, filePath) => ({ ...config, ...readJsonConfig(filePath, parseMeantimeConfig) }),
    { ...DEFAULT_CONFIG },
  );
}

// One-line tempo facts share cachemire's loop-economics voice (design language §1, §10).
function tempoLine(tone: Tone, text: string): string {
  return ink(state().theme, tone, `${GLYPH.econ} ${text}`);
}

function appendChatLine(text: string): void {
  const s = state();
  s.notifyFallback ??= (plainText) => s.ui?.notify(plainText, "info");
  appendAnchoredLine(s, "meantime", text);
}

// --- phase accounting -----------------------------------------------------------------------

/** Close the tools+harness phase behind the last resolved call. `endedByRequest` gates
 * the harness fact: without a next request the gap has no honest end boundary. */
function finalizePendingPhase(endAt: number, endedByRequest: boolean): void {
  const s = state();
  if (!s.pendingPhase) return;
  for (const startAt of s.openTools.values()) {
    s.toolIntervals.push({ start: startAt, end: endAt });
  }
  s.openTools.clear();
  const call = s.calls.at(-1);
  if (call && call.index === s.pendingPhase.callIndex) {
    attachPhase(call, s.toolIntervals, s.pendingPhase.startedAt, endAt, endedByRequest);
  }
  s.toolIntervals = [];
  s.pendingPhase = undefined;
}

function closeIdle(now: number): void {
  const s = state();
  if (s.idleSince === undefined) return;
  s.idleMs += Math.max(0, now - s.idleSince);
  s.idleSince = undefined;
}

// --- widget ---------------------------------------------------------------------------------

function updateWidget(now = Date.now()): void {
  const s = state();
  if (!s.ui) return;
  if (!s.config.widget) {
    if (s.lastWidgetText === "") return;
    s.lastWidgetText = "";
    s.ui.setWidget("pi-meantime", undefined);
    return;
  }
  const baseline = s.live && s.live.firstTokenAt === undefined
    ? baselineFor(s.calls, s.currentModel, (call) => call.ttftMs)
    : undefined;
  const slowStartBar = baseline && baseline.samples >= s.config.baselineMinCalls
    ? {
        medianMs: baseline.median,
        thresholdMs: Math.max(s.config.slowStartFloorMs, baseline.median * s.config.slowStartFactor),
      }
    : undefined;
  const line = tempoWidget({
    now,
    runActive: s.runActive,
    live: s.live,
    openTools: s.openTools.size,
    toolElapsedMs: liveToolWallClock(s.toolIntervals, s.openTools.values(), now),
    charsPerToken: calibratedCharsPerToken(s.calls, s.currentModel),
    slowStartBar,
  });
  const text = line ? tempoLine(line.tone, line.text) : "";
  if (text === s.lastWidgetText) return;
  s.lastWidgetText = text;
  s.ui.setWidget("pi-meantime", text === "" ? undefined : [text]);
}

// --- extension entry --------------------------------------------------------------------------

/** Register the runtime only after the explicit config opt-in. Keeping this boundary
 * outside every hook makes the disabled state inert: no events, command, timer, or UI. */
export function registerMeantime(pi: ExtensionAPI, config: MeantimeConfig): void {
  if (!config.enabled) return;
  const s = state();
  s.config = config;

  pi.on("session_start", async (event, ctx) => {
    const now = Date.now();
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") resetState(now);
    s.config = config;
    if (ctx.model) s.currentModel = `${ctx.model.provider}/${ctx.model.id}`;
    if (!ctx.hasUI) return;
    s.ui = ctx.ui;
    s.theme = ctx.ui.theme;
    captureTui(ctx.ui, "__pi_meantime_capture", (tui) => {
      s.tui = tui;
    });
    if (g.__piMeantimeTimer) clearInterval(g.__piMeantimeTimer);
    g.__piMeantimeTimer = s.config.widget ? setInterval(() => updateWidget(), 1000) : undefined;
    updateWidget(now);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (g.__piMeantimeTimer) clearInterval(g.__piMeantimeTimer);
    g.__piMeantimeTimer = undefined;
    if (ctx.hasUI) ctx.ui.setWidget("pi-meantime", undefined);
    s.lastWidgetText = undefined;
  });

  pi.on("model_select", async (event) => {
    s.currentModel = `${event.model.provider}/${event.model.id}`;
  });

  pi.on("agent_start", async () => {
    const now = Date.now();
    closeIdle(now);
    s.runActive = true;
    updateWidget(now);
  });

  pi.on("before_provider_request", async () => {
    const now = Date.now();
    finalizePendingPhase(now, true);
    // A provider retry re-fires this event: the wait clock honestly restarts with the
    // attempt actually in flight.
    s.live = newLiveCall(s.calls.length + 1, now);
    updateWidget(now);
  });

  // Hot path: one O(1) state-machine step per streamed token; the 1s timer re-renders.
  pi.on("message_update", async (event) => {
    if (!s.live) return;
    const streamEvent = event.assistantMessageEvent;
    const deltaLength = "delta" in streamEvent && typeof streamEvent.delta === "string"
      ? streamEvent.delta.length
      : 0;
    applyStreamEvent(s.live, streamEvent.type, deltaLength, Date.now());
  });

  pi.on("message_end", async (event) => {
    const message = event.message;
    if (message.role !== "assistant" || !s.live) return;
    const usage = message.usage;
    if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) {
      return; // unbilled (abort/error): the dangling live call settles at agent_end
    }
    const now = Date.now();
    const call = resolveCall(s.live, usage, now, s.currentModel);
    const prior = s.calls.slice();
    s.calls.push(call);
    s.live = undefined;
    s.pendingPhase = { callIndex: call.index, startedAt: now };
    if (s.config.notices) {
      const slowStart = detectSlowStart(call, prior, s.config);
      if (slowStart) {
        appendChatLine(tempoLine("warning", renderSlowStartLine(call, slowStart, s.config.prefillCauseTokens)));
      }
      const slowStream = detectSlowStream(call, prior, s.config);
      if (slowStream) appendChatLine(tempoLine("warning", renderSlowStreamLine(call, slowStream)));
    }
    updateWidget(now);
  });

  pi.on("tool_execution_start", async (event) => {
    const now = Date.now();
    s.openTools.set(event.toolCallId, now);
    updateWidget(now);
  });

  pi.on("tool_execution_end", async (event) => {
    const now = Date.now();
    const startAt = s.openTools.get(event.toolCallId);
    if (startAt !== undefined) {
      s.openTools.delete(event.toolCallId);
      s.toolIntervals.push({ start: startAt, end: now });
    }
    updateWidget(now);
  });

  pi.on("agent_end", async () => {
    const now = Date.now();
    // A send that never produced usage (abort/error) must not linger as a phantom call.
    s.live = undefined;
    finalizePendingPhase(now, false);
    s.runActive = false;
    updateWidget(now);
  });

  pi.on("agent_settled", async () => {
    s.idleSince ??= Date.now();
  });

  pi.registerCommand("pace", {
    description: "Show the meantime tempo & latency ledger",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const now = Date.now();
      const totals = sessionTotals(s.calls, {
        startedAt: s.startedAt,
        now,
        idleMs: s.idleMs,
        idleSince: s.idleSince,
      });
      const lines = renderPace(s.calls, totals, {
        config: s.config,
        theme: s.theme,
        modelLabel: s.currentModel,
      });
      appendChatLine(lines.join("\n"));
    },
  });
}

export default function piMeantime(pi: ExtensionAPI): void {
  registerMeantime(pi, loadConfig(process.cwd()));
}

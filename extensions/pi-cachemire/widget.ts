import type { LiveWidget } from "../_lib/live-widget.ts";
import { type ClockInput, cacheClock, nextClockUpdateMs } from "./clock.ts";
import type { Tone } from "../_lib/style.ts";
import type { TextContent } from "../_lib/themed-text.ts";

export interface CacheWidgetRuntime {
  timer?: ReturnType<typeof setTimeout>;
  widget?: LiveWidget;
}

interface CacheWidgetInput {
  enabled: boolean;
  clock: ClockInput;
  renderLine: (tone: Tone, text: string) => TextContent;
}

export function clearCacheWidgetTimer(runtime: CacheWidgetRuntime): void {
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = undefined;
}

export function updateCacheWidget(runtime: CacheWidgetRuntime, input: CacheWidgetInput): void {
  clearCacheWidgetTimer(runtime);
  if (!runtime.widget) return;
  const clock = input.enabled ? cacheClock(input.clock) : { phase: "idle" as const, text: "" };
  const text = clock.phase === "idle" ? "" : input.renderLine("warning", clock.text);
  runtime.widget.setLine(text);
  if (!input.enabled) return;
  const delay = nextClockUpdateMs(input.clock);
  if (delay === undefined) return;
  runtime.timer = setTimeout(() => updateCacheWidget(runtime, { ...input, clock: { ...input.clock, now: Date.now() } }), Math.max(1, delay));
  runtime.timer.unref();
}

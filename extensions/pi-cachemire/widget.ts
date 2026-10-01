import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { LiveWidget } from "../_lib/live-widget.ts";
import { type ClockInput, cacheClock, nextClockUpdateMs } from "./clock.ts";
import type { Tone } from "../_lib/style.ts";

export interface CacheWidgetRuntime {
  timer?: ReturnType<typeof setTimeout>;
  widget?: LiveWidget;
}

interface CacheWidgetInput {
  enabled: boolean;
  clock: ClockInput;
  renderLine: (tone: Tone, text: string) => string;
}

export function mountCacheWidget(runtime: CacheWidgetRuntime, ui: Pick<ExtensionUIContext, "setWidget">, enabled: boolean): void {
  runtime.widget = undefined;
  if (!enabled) return;
  ui.setWidget("pi-cachemire", (tui) => {
    runtime.widget = new LiveWidget(tui);
    return runtime.widget;
  });
}

export function unmountCacheWidget(runtime: CacheWidgetRuntime, ui: Pick<ExtensionUIContext, "setWidget">): void {
  if (runtime.widget) ui.setWidget("pi-cachemire", undefined);
  runtime.widget = undefined;
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

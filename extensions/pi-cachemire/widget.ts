import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type ClockInput, cacheClock, nextClockUpdateMs, toneFor } from "./clock.ts";
import type { Tone } from "../_lib/style.ts";

export interface CacheWidgetRuntime {
  timer?: ReturnType<typeof setTimeout>;
  lastText?: string;
}

interface CacheWidgetInput {
  enabled: boolean;
  ui?: Pick<ExtensionUIContext, "setWidget">;
  clock: ClockInput;
  renderLine: (tone: Tone, text: string) => string;
}

export function clearCacheWidgetTimer(runtime: CacheWidgetRuntime): void {
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = undefined;
}

export function resetCacheWidget(runtime: CacheWidgetRuntime): void {
  clearCacheWidgetTimer(runtime);
  runtime.lastText = undefined;
}

export function updateCacheWidget(runtime: CacheWidgetRuntime, input: CacheWidgetInput): void {
  clearCacheWidgetTimer(runtime);
  if (!input.ui) return;
  const clock = input.enabled ? cacheClock(input.clock) : { phase: "idle" as const, text: "" };
  const text = clock.phase === "idle" ? "" : input.renderLine(toneFor(clock.phase), clock.text);
  if (text !== runtime.lastText) {
    runtime.lastText = text;
    input.ui.setWidget("pi-cachemire", text === "" ? undefined : [text]);
  }
  if (!input.enabled) return;
  const delay = nextClockUpdateMs(input.clock);
  if (delay === undefined) return;
  runtime.timer = setTimeout(() => updateCacheWidget(runtime, { ...input, clock: { ...input.clock, now: Date.now() } }), Math.max(1, delay));
  runtime.timer.unref();
}

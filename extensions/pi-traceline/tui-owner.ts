type TracelineTuiOwnerGlobal = typeof globalThis & {
  __tracelineTuiOwner?: symbol;
};

const g = globalThis as TracelineTuiOwnerGlobal;

/** Process-wide owner of Traceline's interactive TUI. A subagent child must not claim it. */
export interface TracelineTuiOwner {
  owns(): boolean;
  claim(ctx: { mode?: string; hasUI?: boolean }): boolean;
  release(): boolean;
}

export function createTracelineTuiOwner(): TracelineTuiOwner {
  const token = Symbol("pi-traceline-tui-owner");
  return {
    owns: () => g.__tracelineTuiOwner === token,
    claim(ctx) {
      if (ctx.mode !== "tui" || !ctx.hasUI) return false;
      if (g.__tracelineTuiOwner !== undefined && g.__tracelineTuiOwner !== token) return false;
      g.__tracelineTuiOwner = token;
      return true;
    },
    release() {
      if (g.__tracelineTuiOwner !== token) return false;
      g.__tracelineTuiOwner = undefined;
      return true;
    },
  };
}

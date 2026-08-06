import type { TracelineTuiLike } from "../_lib/chat.ts";

interface TracelineTuiPrototypeLike extends TracelineTuiLike {
  __tracelineRRWrapVersion?: number;
  __tracelineOriginalRequestRender?: (force?: boolean) => unknown;
}

// Pi 0.84 made the extension-visible TUI a stable Proxy so regular/fullscreen mode
// switches can replace its renderer. Assigning requestRender on that Proxy writes to the
// current renderer; a previously captured proxy method then resolves the assignment again
// and recurses. Patch the prototype that owns the native method instead. Both renderer
// classes inherit it, and the same route also works with Pi <=0.83's direct TUI object.
export function findRequestRenderPrototype(tui: TracelineTuiLike): TracelineTuiPrototypeLike | undefined {
  // SAFETY: requestRender's prototype ownership is a private Pi TUI seam. The installed-
  // Pi contract test exercises this walk through Pi's real stable TUI reference.
  let candidate: object | null = Object.getPrototypeOf(tui);
  while (candidate) {
    const proto = candidate as Partial<TracelineTuiPrototypeLike>;
    if (Object.prototype.hasOwnProperty.call(proto, "requestRender") && typeof proto.requestRender === "function") {
      return proto as TracelineTuiPrototypeLike;
    }
    candidate = Object.getPrototypeOf(candidate);
  }
  return undefined;
}

export function patchRequestRender(
  tui: TracelineTuiLike,
  version: number,
  beforeRender: () => void,
): void {
  const proto = findRequestRenderPrototype(tui);
  if (!proto || proto.__tracelineRRWrapVersion === version) return;
  const original = proto.__tracelineOriginalRequestRender ?? proto.requestRender;
  proto.__tracelineOriginalRequestRender = original;
  proto.requestRender = function (this: TracelineTuiLike, force?: boolean) {
    beforeRender();
    return original.call(this, force);
  };
  proto.__tracelineRRWrapVersion = version;
}

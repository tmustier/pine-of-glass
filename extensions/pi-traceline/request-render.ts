import type { TUI } from "@earendil-works/pi-tui";

const PATCH_VERSION = 29;

interface RequestRenderPrototype {
  requestRender(force?: boolean): void;
  __tracelineRRWrapVersion?: number;
  __tracelineOriginalRequestRender?: (force?: boolean) => void;
}

export function patchRequestRender(tui: TUI, beforeRender: () => void): void {
  // Writing through Pi's stable TUI proxy patches only the current renderer.
  let prototype: object = Object.getPrototypeOf(tui);
  while (!Object.hasOwn(prototype, "requestRender")) prototype = Object.getPrototypeOf(prototype);
  const owner = prototype as RequestRenderPrototype;
  if (owner.__tracelineRRWrapVersion === PATCH_VERSION) return;

  const original = owner.__tracelineOriginalRequestRender ?? owner.requestRender;
  owner.__tracelineOriginalRequestRender = original;
  owner.requestRender = function (this: TUI, force?: boolean) {
    beforeRender();
    original.call(this, force);
  };
  owner.__tracelineRRWrapVersion = PATCH_VERSION;
}

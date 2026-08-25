import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Bind Traceline's interactive TUI session so a headless child session cannot steal it.
 *
 * pi-subagents loads this module again in-process for a general-purpose child.
 * That child's session_start / session_shutdown must not clear the parent pane's
 * captured TUI or unsubscribe its Ctrl+T listener.
 */
export function bindInteractiveTuiOwnership(
  pi: Pick<ExtensionAPI, "on">,
  hooks: {
    arm: (ctx: ExtensionContext) => (() => void) | undefined;
    disarm: () => void;
  },
): void {
  let ownsInteractiveTui = false;
  let inputUnsubscribe: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    ownsInteractiveTui = true;
    inputUnsubscribe?.();
    inputUnsubscribe = hooks.arm(ctx);
  });

  pi.on("session_shutdown", () => {
    inputUnsubscribe?.();
    inputUnsubscribe = undefined;
    if (!ownsInteractiveTui) return;
    ownsInteractiveTui = false;
    hooks.disarm();
  });
}

// Per-session extension state that survives /reload (docs/state-machines-2026-11-03.md).
//
// Pi can host several agent sessions in one process, for example a headless child created with
// `createAgentSession`. Each session gets its own factory call, so closures are per session, but
// `globalThis` is shared. State that must outlive a /reload (which re-imports the extension and
// calls its factory again) therefore lives in one process-wide map, keyed by the session id that
// a reload keeps. A child session's events reach only its own entry.

import type { ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";

/** How much an extension shows in this session: the full TUI, notify lines only, or nothing. */
export type Presentation = "tui" | "notify" | "none";

/** Print, JSON and headless sessions have no output channel; RPC has notify but no components. */
export function presentation(ctx: Pick<ExtensionContext, "hasUI" | "mode">): Presentation {
  if (!ctx.hasUI) return "none";
  return ctx.mode === "tui" ? "tui" : "notify";
}

type SessionKey = Pick<ExtensionContext, "sessionManager">;

export interface SessionStates<S> {
  /** session_start: a reload returns the session's existing state; any other start creates it afresh. */
  open(ctx: SessionKey, reason: SessionStartEvent["reason"], create: () => S): S;
  /** Any later event; undefined when this session has no state. */
  get(ctx: SessionKey): S | undefined;
  /** session_shutdown: a reload keeps the state; any other reason removes and returns it. */
  close(ctx: SessionKey, reason: SessionShutdownEvent["reason"]): S | undefined;
}

type Registry = Map<string, Map<string, unknown>>;
type SessionStateGlobal = typeof globalThis & { __pineOfGlassSessionStates?: Registry };

/** One map per extension slot, shared by every load of the extension in this process. */
export function sessionStates<S>(slot: string): SessionStates<S> {
  // SAFETY: a typed view of the family's one reload-safe global; only this module touches the key.
  const registry = ((globalThis as SessionStateGlobal).__pineOfGlassSessionStates ??= new Map());
  let entries = registry.get(slot);
  if (!entries) registry.set(slot, entries = new Map());
  // SAFETY: only sessionStates<S>(slot) writes this slot's entries, so every value is an S. A
  // reload can re-import a newer S over the previous version's values, as every global here can.
  const states = entries as Map<string, S>;
  const id = (ctx: SessionKey) => ctx.sessionManager.getSessionId();
  return {
    open(ctx, reason, create) {
      const existing = reason === "reload" ? states.get(id(ctx)) : undefined;
      if (existing !== undefined) return existing;
      const state = create();
      states.set(id(ctx), state);
      return state;
    },
    get: (ctx) => states.get(id(ctx)),
    close(ctx, reason) {
      const state = states.get(id(ctx));
      if (reason !== "reload") states.delete(id(ctx));
      return state;
    },
  };
}

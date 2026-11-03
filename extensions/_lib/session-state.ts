// Per-session extension state that survives /reload (docs/state-machines-2026-11-03.md).
//
// Pi can host several agent sessions in one process, for example a headless child created with
// `createAgentSession`. Each session gets its own factory call, so closures are per session, but
// `globalThis` is shared. State that must outlive a /reload (which re-imports the extension and
// calls its factory again) therefore lives in one process-wide registry, keyed by the session's
// SessionManager: a reload keeps that object, and two runtimes never share one, even when they
// open the same session file. A session's events reach only its own entry, and an entry is
// collected with its SessionManager even when an SDK host disposes the session without a
// `session_shutdown`.

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
  /** Sessions in this process with state, counting those closed only by a reload. */
  readonly liveSessions: number;
}

type Slot = { states: WeakMap<object, unknown>; live: number };
type Registry = Map<string, Slot>;
type SessionStateGlobal = typeof globalThis & { __pineOfGlassSessionStates?: Registry };

/** One registry per extension slot, shared by every load of the extension in this process. */
export function sessionStates<S>(slot: string): SessionStates<S> {
  // SAFETY: a typed view of the family's one reload-safe global; only this module touches the key.
  const registry = ((globalThis as SessionStateGlobal).__pineOfGlassSessionStates ??= new Map());
  let entries = registry.get(slot);
  if (!entries) registry.set(slot, entries = { states: new WeakMap(), live: 0 });
  const owned = entries;
  // SAFETY: only sessionStates<S>(slot) writes this slot's entries, so every value is an S. A
  // reload can re-import a newer S over the previous version's values, as every global here can.
  const states = owned.states as WeakMap<object, S>;
  return {
    open(ctx, reason, create) {
      const existing = states.get(ctx.sessionManager);
      if (reason === "reload" && existing !== undefined) return existing;
      if (existing === undefined) owned.live++;
      const state = create();
      states.set(ctx.sessionManager, state);
      return state;
    },
    get: (ctx) => states.get(ctx.sessionManager),
    close(ctx, reason) {
      const state = states.get(ctx.sessionManager);
      if (reason !== "reload" && states.delete(ctx.sessionManager)) owned.live--;
      return state;
    },
    get liveSessions() {
      return owned.live;
    },
  };
}

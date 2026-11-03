// Reload keeps SessionManager identity; separate SDK runtimes never share it, even for
// one session file. Weak keys allow collection without shutdown. See docs/state-machines-2026-11-03.md.

import type { ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";

type Presentation = "tui" | "notify" | "none";

/** RPC has notifications but no components; headless sessions have neither. */
export function presentation(ctx: Pick<ExtensionContext, "hasUI" | "mode">): Presentation {
  if (!ctx.hasUI) return "none";
  return ctx.mode === "tui" ? "tui" : "notify";
}

type SessionKey = Pick<ExtensionContext, "sessionManager">;

interface SessionStates<S> {
  /** Reload reuses state; other starts replace it. */
  open(ctx: SessionKey, reason: SessionStartEvent["reason"], create: () => S): S;
  get(ctx: SessionKey): S | undefined;
  /** Reload retains state; other shutdowns remove it. */
  close(ctx: SessionKey, reason: SessionShutdownEvent["reason"]): void;
  /** Includes reloads; excludes shutdowns. */
  readonly liveSessions: number;
}

type Slot = { states: WeakMap<object, unknown>; live: number };
type Registry = Map<string, Slot>;
type SessionStateGlobal = typeof globalThis & { __pineOfGlassSessionStates?: Registry };

/** Shared by every load of an extension slot in this process. */
export function sessionStates<S>(slot: string): SessionStates<S> {
  // SAFETY: a typed view of the family's one reload-safe global; only this module touches the key.
  const registry = ((globalThis as SessionStateGlobal).__pineOfGlassSessionStates ??= new Map());
  const entries = registry.get(slot) ?? { states: new WeakMap(), live: 0 };
  registry.set(slot, entries);
  // SAFETY: each extension slot has one S, including across reloads.
  const states = entries.states as WeakMap<object, S>;
  return {
    open(ctx, reason, create) {
      const existing = states.get(ctx.sessionManager);
      if (reason === "reload" && existing !== undefined) return existing;
      if (existing === undefined) entries.live++;
      const state = create();
      states.set(ctx.sessionManager, state);
      return state;
    },
    get: (ctx) => states.get(ctx.sessionManager),
    close(ctx, reason) {
      if (reason !== "reload" && states.delete(ctx.sessionManager)) entries.live--;
    },
    get liveSessions() {
      return entries.live;
    },
  };
}

// Pi hooks lack request ids: attribute agent calls, warm replays and provider re-attempts
// by context events and conversation identity. See docs/state-machines-2026-11-03.md.
import { isJsonObject } from "./boundary.ts";

type RequestCycle<Sent> =
  | { kind: "idle" }
  | { kind: "armed" }
  | {
    kind: "sent";
    sent: Sent;
    /** Undefined before response; null when an overlapping replay makes attribution ambiguous. */
    respondedAt?: number | null;
  };

type EndedRequest<Sent> = { sent: Sent; respondedAt?: number };

export class RequestTracker<Sent> {
  #state: RequestCycle<Sent> = { kind: "idle" };
  #lastAgentKey: string | undefined;
  #replayKeys: string[] = [];
  #replaysAwaitingResponse = 0;

  get armed(): boolean {
    return this.#state.kind === "armed";
  }

  get inFlight(): Sent | undefined {
    return this.#state.kind === "sent" ? this.#state.sent : undefined;
  }

  /** `context`: arm the next agent payload. */
  arm(): void {
    this.#end();
    this.#state = { kind: "armed" };
  }

  /** `cache_warming_decision: warm`. Expectations last until replay or agent_end because
   * aborted refreshes can dispatch after the next agent payload; later handlers can cancel them. */
  expectReplay(): void {
    if (this.#lastAgentKey !== undefined) this.#replayKeys.push(this.#lastAgentKey);
  }

  /** `before_provider_request`: start an agent request or update its provider re-attempt.
   * True when the payload belongs to the agent's request. */
  payload(payload: unknown, start: () => Sent, retry: (sent: Sent) => void): boolean {
    // Adapters rewrite the warmer's output cap, but preserve the wire conversation.
    const conversation = isJsonObject(payload) ? payload.messages ?? payload.input ?? payload.contents : undefined;
    const key = conversation === undefined ? undefined : JSON.stringify(conversation);
    const replayAt = key === undefined ? -1 : this.#replayKeys.indexOf(key);
    if (replayAt >= 0) {
      this.#replayKeys.splice(replayAt, 1);
      this.#replaysAwaitingResponse++;
      return false;
    }
    if (this.#state.kind === "idle") return false;
    this.#lastAgentKey = key;
    if (this.#state.kind === "armed") this.#state = { kind: "sent", sent: start() };
    else retry(this.#state.sent);
    return true;
  }

  /** `after_provider_response`: overlapping replay responses cannot be attributed. */
  responded(now: number): void {
    const state = this.#state;
    if (this.#replaysAwaitingResponse > 0) {
      this.#replaysAwaitingResponse--;
      if (state.kind === "sent") state.respondedAt = null;
    } else if (state.kind === "sent" && state.respondedAt === undefined) {
      state.respondedAt = now;
    }
  }

  /** Assistant `message_end`, regardless of usage or stop reason. */
  settle(): EndedRequest<Sent> | undefined {
    return this.#end();
  }

  /** `agent_end` or tree navigation: discard unfinished work and replay expectations. */
  abandon(): EndedRequest<Sent> | undefined {
    this.#replayKeys = [];
    return this.#end();
  }

  #end(): EndedRequest<Sent> | undefined {
    const state = this.#state;
    this.#state = { kind: "idle" };
    if (state.kind !== "sent") return undefined;
    // A replay without a response must not make later requests ambiguous.
    this.#replaysAwaitingResponse = 0;
    return { sent: state.sent, respondedAt: state.respondedAt ?? undefined };
  }
}

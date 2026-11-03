// The provider request lifecycle shared by Cachemire, Meantime and Contextimate
// (docs/state-machines-2026-11-03.md, "Provider request cycle").
//
// Pi's provider hook events carry only the payload, so a before_provider_request does not say
// whether it is the agent loop's request, a cache-warm replay or the second attempt of the same
// request (Anthropic's strict-schema fallback). The tracker works that out from event order and
// is the only code in the family that does.
//
// - Pi's cache warmer replays the last agent request with `maxTokens: 1` and the same options,
//   so the replay reaches the provider hooks. Each refresh first emits `cache_warming_decision`.
//   Pi does not await an aborted refresh, so its payload can still arrive after the next agent
//   request has been sent.
// - An agent request is always preceded by a `context` event, retries included.
// - A second payload for the same request arrives without a new `context`.

import { isJsonObject } from "./boundary.ts";

export type RequestCycle<Sent> =
  | { kind: "idle" }
  /** `context` seen; the next agent payload starts a request. */
  | { kind: "armed" }
  | {
    kind: "sent";
    sent: Sent;
    /** When the provider began responding, if that response is attributable to this request. */
    respondedAt?: number;
    /** A cache-warm replay overlapped this request, so a response cannot be attributed to it. */
    responseAmbiguous: boolean;
  };

/** What one before_provider_request turned out to be. */
export type PayloadKind = "agent" | "reattempt" | "replay" | "foreign";

/** A request that left the `sent` state, with what the tracker learnt about its response. */
export type EndedRequest<Sent> = { sent: Sent; respondedAt?: number };

/** The wire conversation of a provider payload: Anthropic and OpenAI chat `messages`, OpenAI
 * Responses `input`, Gemini `contents`. A replay reuses the replayed request's conversation. */
export function conversationKey(payload: unknown): string | undefined {
  if (!isJsonObject(payload)) return undefined;
  const conversation = payload.messages ?? payload.input ?? payload.contents;
  return conversation === undefined ? undefined : JSON.stringify(conversation);
}

/** False when the payload states an output cap other than the warmer's one token: Anthropic and
 * OpenAI chat `max_tokens`, OpenAI `max_output_tokens` and `max_completion_tokens`, Gemini
 * `generationConfig.maxOutputTokens`. A route without a recognised cap field cannot tell. */
function mayBeReplay(payload: unknown): boolean {
  if (!isJsonObject(payload)) return false;
  const generation = isJsonObject(payload.generationConfig) ? payload.generationConfig : {};
  const cap = payload.max_tokens ?? payload.max_output_tokens ?? payload.max_completion_tokens
    ?? generation.maxOutputTokens;
  return typeof cap !== "number" || cap === 1;
}

export class RequestTracker<Sent> {
  #state: RequestCycle<Sent> = { kind: "idle" };
  #lastAgentKey: string | undefined;
  /** Conversations a decided refresh will replay, until that replay's payload arrives. */
  #replayKeys: string[] = [];
  #replaysAwaitingResponse = 0;

  get state(): RequestCycle<Sent> {
    return this.#state;
  }

  /** The in-flight request's data, if one is in flight. */
  get inFlight(): Sent | undefined {
    return this.#state.kind === "sent" ? this.#state.sent : undefined;
  }

  /** `context`: the next agent payload starts a request. Returns a request this replaces, which
   * Pi's ordering makes unreachable but which the caller must still be able to clean up. */
  arm(): EndedRequest<Sent> | undefined {
    const ended = this.#end();
    this.#state = { kind: "armed" };
    return ended;
  }

  /** `cache_warming_decision` with action `warm`: a payload that replays the last agent
   * conversation within the warmer's one-token cap is the warm request, whenever it arrives. A
   * later extension can still cancel the refresh, so an unused expectation lasts until
   * `abandon`. */
  expectReplay(): void {
    if (this.#lastAgentKey !== undefined) this.#replayKeys.push(this.#lastAgentKey);
  }

  /** `before_provider_request`. `start` creates the request's data for an agent payload, and
   * `retry` lets the caller re-derive what it read from the payload for a second attempt. */
  payload(payload: unknown, start: () => Sent, retry: (sent: Sent) => void): PayloadKind {
    const key = conversationKey(payload);
    const replayAt = key === undefined || !mayBeReplay(payload) ? -1 : this.#replayKeys.indexOf(key);
    if (replayAt >= 0) {
      this.#replayKeys.splice(replayAt, 1);
      this.#replaysAwaitingResponse++;
      return "replay";
    }
    switch (this.#state.kind) {
      case "armed":
        this.#lastAgentKey = key;
        this.#state = { kind: "sent", sent: start(), responseAmbiguous: false };
        return "agent";
      case "sent":
        this.#lastAgentKey = key;
        retry(this.#state.sent);
        return "reattempt";
      case "idle":
        return "foreign";
    }
  }

  /** `after_provider_response`. While a replay waits for its own response, no response can be
   * attributed, so the in-flight request keeps no response time at all. */
  responded(now: number): void {
    const state = this.#state;
    if (this.#replaysAwaitingResponse > 0) {
      this.#replaysAwaitingResponse--;
      if (state.kind === "sent") {
        state.responseAmbiguous = true;
        state.respondedAt = undefined;
      }
      return;
    }
    if (state.kind === "sent" && !state.responseAmbiguous) state.respondedAt ??= now;
  }

  /** An assistant `message_end`, whatever its usage or stop reason, ends the request. */
  settle(): EndedRequest<Sent> | undefined {
    return this.#end();
  }

  /** `agent_end`, `session_start`, `session_tree`: drop any request without a response. */
  abandon(): EndedRequest<Sent> | undefined {
    this.#replayKeys = [];
    return this.#end();
  }

  #end(): EndedRequest<Sent> | undefined {
    const state = this.#state;
    this.#state = { kind: "idle" };
    if (state.kind !== "sent") return undefined;
    // A replay that never got a response must not make later requests ambiguous.
    this.#replaysAwaitingResponse = 0;
    return { sent: state.sent, respondedAt: state.respondedAt };
  }
}

/** Settle the clock anchor for a send that ended without billed usage (abort or error).
 * before_provider_request moves the anchor to the in-flight request optimistically,
 * which is right for every send whose usage arrives. What lands here is the remainder:
 * fast aborts and errors where usage never arrived, so nothing proves the provider
 * processed, refreshed, or wrote the prefix. The anchor rolls back to the last billed
 * request, the only provider-confirmed refresh. On a first-send abort it clears outright.
 * If the aborted send did touch the cache after all, the next call resolves green. */
export function settleDanglingSend(state: {
  pendingRequestAt?: number;
  prevCallRequestAt?: number;
  lastRequestAt?: number;
}): { changed: boolean; lastRequestAt?: number } {
  if (state.pendingRequestAt === undefined) return { changed: false, lastRequestAt: state.lastRequestAt };
  return { changed: true, lastRequestAt: state.prevCallRequestAt };
}

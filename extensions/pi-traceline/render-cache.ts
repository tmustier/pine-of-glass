type Entry = { valid: boolean; value: unknown; dependencies: Set<object> };
export type RenderCacheWork = {
  outputHits: number; outputMisses: number; intrinsicHits: number; intrinsicMisses: number;
};
const MAX_VARIANTS = 16;

/** Cached computations form a dependency graph, not a transcript-wide generation.
 * Nested hits depend on their entry token, so a block shared by N rows stores O(N)
 * edges rather than copying N dependencies into each row. Eviction unlinks edges.
 */
export class TraceRenderCache {
  private values = new WeakMap<object, Map<string, Entry>>();
  private reverse = new WeakMap<object, Set<Entry>>();
  private collecting: Set<object> | undefined;
  private bypass = 0;
  private work: RenderCacheWork = { outputHits: 0, outputMisses: 0, intrinsicHits: 0, intrinsicMisses: 0 };

  get active(): boolean { return this.bypass === 0 && this.collecting !== undefined; }

  depend(value: unknown): void {
    if (this.active && value && typeof value === "object") this.collecting!.add(value);
  }

  value<T>(owner: object, key: string, compute: () => T): T {
    return this.bypass ? compute() : this.compute(owner, `output:${key}`, compute, true);
  }

  memo<T>(owner: object, key: string, compute: () => T): T {
    return this.active ? this.compute(owner, `memo:${key}`, compute, false) : compute();
  }

  private compute<T>(owner: object, key: string, compute: () => T, output: boolean): T {
    let variants = this.values.get(owner);
    const hit = variants?.get(key);
    if (hit?.valid) {
      this.depend(hit);
      this.work[output ? "outputHits" : "intrinsicHits"]++;
      // SAFETY: private keys have one typed compute function; values enter only here.
      return hit.value as T;
    }
    this.work[output ? "outputMisses" : "intrinsicMisses"]++;
    const parent = this.collecting;
    const dependencies = new Set<object>([owner]);
    this.collecting = dependencies;
    try {
      const value = compute();
      const entry: Entry = { valid: true, value, dependencies };
      if (!variants) this.values.set(owner, variants = new Map());
      if (variants.size >= MAX_VARIANTS && !variants.has(key)) {
        const oldest = variants.keys().next().value!;
        this.invalidate(variants.get(oldest)!);
        variants.delete(oldest);
      }
      variants.set(key, entry);
      for (const dependency of dependencies) {
        let entries = this.reverse.get(dependency);
        if (!entries) this.reverse.set(dependency, entries = new Set());
        entries.add(entry);
      }
      parent?.add(entry);
      return value;
    } finally {
      this.collecting = parent;
    }
  }

  private invalidate(entry: Entry): void {
    if (!entry.valid) return;
    entry.valid = false;
    entry.value = undefined;
    for (const dependency of entry.dependencies) this.reverse.get(dependency)?.delete(entry);
    entry.dependencies.clear();
    this.dirty(entry);
  }

  dirty(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const entries = this.reverse.get(value);
    if (!entries) return;
    this.reverse.delete(value);
    for (const entry of entries) this.invalidate(entry);
  }

  withoutCache<T>(fn: () => T): T {
    this.bypass++;
    try { return fn(); } finally { this.bypass--; }
  }

  reset(): void {
    this.values = new WeakMap();
    this.reverse = new WeakMap();
    this.collecting = undefined;
  }

  workCounts(reset = false): RenderCacheWork {
    const snapshot = { ...this.work };
    if (reset) this.work = { outputHits: 0, outputMisses: 0, intrinsicHits: 0, intrinsicMisses: 0 };
    return snapshot;
  }
}

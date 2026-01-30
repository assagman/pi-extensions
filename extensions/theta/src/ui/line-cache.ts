/**
 * LineCache — Pre-rendered line storage with bounded size.
 *
 * Caches styled terminal lines (strings with ANSI escapes) keyed by
 * a caller-defined string. When the cache exceeds maxSize, the oldest
 * 10% of entries are evicted (FIFO via insertion order).
 *
 * Used by DiffPanel to avoid regenerating ANSI-styled lines on every
 * render frame — styled lines are computed once on content change and
 * looked up on scroll.
 */

export class LineCache {
  private cache = new Map<string, string>();

  constructor(private readonly maxSize = 10_000) {}

  get(key: string): string | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: string): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest 10%
      const evictCount = Math.max(1, Math.floor(this.maxSize * 0.1));
      const iter = this.cache.keys();
      for (let i = 0; i < evictCount; i++) {
        const { value: key, done } = iter.next();
        if (done) break;
        this.cache.delete(key);
      }
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

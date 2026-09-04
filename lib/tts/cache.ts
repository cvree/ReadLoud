/* ────────────────────────────────────────────────────────────────
   Clip cache.

   Two jobs:
   1. Kill the gap between passages. Without a prefetch, every passage
      boundary costs a full synthesis of dead air and the narration
      sounds like it is buffering. The engine warms the next passage
      while the current one plays.
   2. Never pay twice. Scrubbing back over a passage, or exporting
      something you just listened to, reuses the bytes.

   Bounded by total bytes, not entry count, because clip sizes vary by
   two orders of magnitude between a heading and a long paragraph.
   ──────────────────────────────────────────────────────────────── */

export interface Clip {
  bytes: ArrayBuffer;
  mime: string;
}

const MAX_BYTES = 64 * 1024 * 1024;

const store = new Map<string, Clip>();
const inflight = new Map<string, Promise<Clip>>();
let used = 0;

export function cacheKey(provider: string, voiceId: string, rate: number, text: string): string {
  // FNV-1a over the text: fast, allocation-free, ample for a local cache.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${provider}|${voiceId}|${rate}|${text.length}|${(h >>> 0).toString(36)}`;
}

export function get(key: string): Clip | undefined {
  const hit = store.get(key);
  if (hit) {
    // Re-insert to move to the tail: Map iterates in insertion order, which
    // makes the first key the least-recently-used.
    store.delete(key);
    store.set(key, hit);
  }
  return hit;
}

export function put(key: string, clip: Clip): void {
  if (store.has(key)) return;
  store.set(key, clip);
  used += clip.bytes.byteLength;
  while (used > MAX_BYTES && store.size > 1) {
    const oldest = store.keys().next().value as string | undefined;
    if (!oldest) break;
    used -= store.get(oldest)?.bytes.byteLength ?? 0;
    store.delete(oldest);
  }
}

/** Deduplicate concurrent requests for the same clip. */
export function dedupe(key: string, run: () => Promise<Clip>): Promise<Clip> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = run()
    .then((clip) => {
      put(key, clip);
      return clip;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function clear(): void {
  store.clear();
  inflight.clear();
  used = 0;
}

export function stats() {
  return { entries: store.size, bytes: used };
}

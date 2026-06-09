/**
 * Tiny pub-sub store for the in-panel load scoreboard.
 *
 * The scoreboard counts source COG opens (loaded / failed) and collects
 * per-failure detail for the "copy all" debug list. It lives outside React
 * because the events that drive it originate in async, non-render code paths:
 * the MosaicLayer `getSource` promise (source open) and `getTileData`'s
 * give-up branch (tile decode). App subscribes once and mirrors snapshots
 * into state.
 *
 * Counts are deduped per URL so a cache hit (geotiffCache) doesn't double-count
 * a source that was already tallied. Call `resetStats()` on AOI / year / mode
 * change to start a fresh tally.
 *
 * Caveat: in NDVI mode the per-source GeoTIFF opens happen *inside*
 * MultiCOGLayer with no exposed hook, so `loaded` won't advance there — only
 * tile-decode failures surface. RGB mode (COGLayer via getSource) tallies fully.
 */

export type Failure = { url: string; err: string };
export type StatsSnapshot = { loaded: number; failed: number; failures: Failure[] };

let loaded = 0;
let failed = 0;
const failures: Failure[] = [];
const seen = new Set<string>();
const listeners = new Set<(s: StatsSnapshot) => void>();

function emit() {
  const snap: StatsSnapshot = { loaded, failed, failures: failures.slice() };
  for (const l of listeners) l(snap);
}

export function resetStats() {
  loaded = 0;
  failed = 0;
  failures.length = 0;
  seen.clear();
  emit();
}

export function reportLoaded(url: string) {
  if (seen.has(url)) return;
  seen.add(url);
  loaded += 1;
  emit();
}

export function reportFailed(url: string, err: string) {
  failed += 1;
  failures.push({ url, err });
  emit();
}

export function subscribeStats(fn: (s: StatsSnapshot) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

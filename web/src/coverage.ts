/**
 * Coverage-first mosaic selection for Sentinel-1 GRD, ported from the S2
 * mapterhorn app's `selectCoverageFirst` / `groupByDate`
 * (see `earthSearchStac.ts.ref`) and adapted for S1:
 *
 *   - No cloud. S2 ranked scenes clearest-first; S1 has no `eo:cloud_cover`, so
 *     the quality proxy is RECENCY (a more recent overpass is preferred).
 *   - No MGRS tile. S2 grouped overpasses by MGRS grid id; S1 GRD has none, so
 *     we group repeat passes of one frame by `relative_orbit` + a coarse bbox
 *     bucket (the same frame across dates collapses to one coverage slot; a
 *     distinct frame stays its own slot).
 *
 * Pure, no network. The STAC fetch (`stac.ts fetchStacItems`) returns the raw
 * candidates; this picks the set that best COVERS the AOI and orders it for the
 * MosaicLayer stack. `groupByDate` drives the SEARCH VIEW date stepper.
 */

import type { PartialSTACItem } from "./stac";

/** Acquisition date (YYYY-MM-DD) of a scene. */
export function sceneDate(item: PartialSTACItem): string {
  return (item.datetime ?? "").slice(0, 10);
}

/**
 * Coverage group key: repeat passes of the same footprint share it, distinct
 * frames differ. `relative_orbit` separates ascending/descending and adjacent
 * tracks; the ~0.5deg-bucketed bbox separates along-track frames. Falls back to
 * the bucketed bbox alone when the relative orbit is absent.
 */
export function groupKey(item: PartialSTACItem): string {
  const ro = item.relativeOrbit != null ? `r${item.relativeOrbit}` : "";
  const b = item.bbox.map((v) => Math.round(v * 2) / 2).join(",");
  return `${ro}|${b}`;
}

export type CoverageSelection = {
  /** Scenes ordered oldest-first so the most recent overpass draws LAST (on top);
   *  older scenes sit beneath and fill any footprint the top scenes miss. */
  items: PartialSTACItem[];
  /** Distinct acquisition dates contributing, newest first. */
  dates: string[];
  /** Count of distinct footprint groups represented (= AOI frames covered). */
  footprintsCovered: number;
};

export type SelectOptions = {
  /** Hard cap on scenes fed to the mosaic (each = open GeoTIFF + GPU textures).
   *  Coverage is reserved first, so the cap only trims extra fill dates. */
  maxScenes?: number;
  /** Up to this many most-recent distinct dates kept per footprint group (fills
   *  within-frame nodata swath edges across passes). */
  perGroup?: number;
  /** Scene ids to exclude (the "refine"/deselect path after auto-select). */
  excludeIds?: Set<string>;
};

/**
 * COVERAGE-FIRST selection. Groups candidates by footprint, keeps the `perGroup`
 * most-recent distinct dates per group, RESERVES each group's most-recent scene
 * before the budget cap (so the cap can never zero out a frame = no bare gap),
 * then fills the remaining budget with the most-recent leftover dates. Orders
 * most-recent-LAST per the MosaicLayer stack. Pure.
 */
export function selectCoverageFirst(
  candidates: PartialSTACItem[],
  opts: SelectOptions = {},
): CoverageSelection {
  // maxScenes is a HARD cap on scenes loaded. Each scene = an opened GeoTIFF + a
  // mesh built SYNCHRONOUSLY on the main thread (deck.gl-raster has no mesh
  // worker), so the count drives load + pan/zoom cost directly. Over a small AOI
  // many footprint groups (different relative orbits) REDUNDANTLY cover the same
  // ground, so a small cap still fills the viewport.
  const { maxScenes = 3, perGroup = 2, excludeIds } = opts;
  const usable = excludeIds
    ? candidates.filter((s) => !excludeIds.has(s.id))
    : candidates;
  if (!usable.length) return { items: [], dates: [], footprintsCovered: 0 };

  // Most-recent first (recency is the S1 quality proxy, no cloud).
  const byRecency = [...usable].sort((a, b) =>
    a.datetime < b.datetime ? 1 : a.datetime > b.datetime ? -1 : 0,
  );

  // Group by footprint; keep up to perGroup distinct dates per group (dedupe by
  // date so we never stack the same overpass on itself).
  const byGroup = new Map<string, PartialSTACItem[]>();
  for (const s of byRecency) {
    const kept = byGroup.get(groupKey(s)) ?? [];
    if (kept.some((k) => sceneDate(k) === sceneDate(s))) continue;
    if (kept.length >= perGroup) continue;
    kept.push(s);
    byGroup.set(groupKey(s), kept);
  }

  const groups = [...byGroup.values()];
  // Each group's most-recent scene is its coverage representative, most-recent
  // groups first. HARD cap here: keep at most `maxScenes` representatives (over a
  // small AOI the rest are redundant overlapping passes), so we never stack 12
  // full-coverage scenes just because the area has 12 overlapping orbits.
  const reps = groups
    .map((g) => g[0])
    .sort((a, b) => (a.datetime < b.datetime ? 1 : -1));
  const reserved = reps.slice(0, maxScenes);
  // If any budget remains (fewer groups than the cap), fill with extra passes.
  const fillBudget = Math.max(0, maxScenes - reserved.length);
  const fill = groups
    .flatMap((g) => g.slice(1))
    .sort((a, b) => (a.datetime < b.datetime ? 1 : -1))
    .slice(0, fillBudget);
  const chosen = [...reserved, ...fill];
  // Render order: oldest FIRST (bottom), most-recent LAST (top).
  chosen.sort((a, b) => (a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0));

  const footprintsCovered = new Set(chosen.map(groupKey)).size;
  const dates = [...new Set(chosen.map(sceneDate))]
    .filter(Boolean)
    .sort()
    .reverse();
  return { items: chosen, dates, footprintsCovered };
}

/**
 * Group candidates by acquisition date for the SEARCH VIEW date stepper, with
 * the BEST-COVERAGE dates up front: ordered by distinct footprint groups that
 * date's scenes cover (desc), then recency. Stepping starts at the date that
 * fills the most of the AOI on its own.
 */
export function groupByDate(
  candidates: PartialSTACItem[],
): { date: string; items: PartialSTACItem[]; footprints: number }[] {
  const map = new Map<string, PartialSTACItem[]>();
  for (const s of candidates) {
    const d = sceneDate(s);
    const arr = map.get(d) ?? [];
    arr.push(s);
    map.set(d, arr);
  }
  return [...map.entries()]
    .map(([date, items]) => ({
      date,
      items,
      footprints: new Set(items.map(groupKey)).size,
    }))
    .sort((a, b) => b.footprints - a.footprints || (a.date < b.date ? 1 : -1));
}

/**
 * SEARCH VIEW state: the STAC candidate search + coverage selection + date
 * stepping, isolated from the map/layer wiring.
 *
 * This is the seam that keeps the custom search panel swappable: a Development
 * Seed `stac-map` search component could replace the panel UI and drive the same
 * `search()` / `setDateIdx()` surface without touching `App`'s layer code. The
 * hook never loads tiles, it only finds and ranks candidates; `App` decides what
 * to render (LOAD MOST COMPLETE vs LOAD THIS DATE).
 */
import { useCallback, useMemo, useRef, useState } from "react";

import { fetchStacItems, type PartialSTACItem } from "./stac";
import {
  groupByDate,
  selectCoverageFirst,
  type CoverageSelection,
} from "./coverage";

// Page cap for a candidate search. Far above the old most-recent-3 load cap:
// we want the WHOLE date window's scenes to rank coverage, not just the latest.
// (Earth Search caps a page at 100; selection trims to a render budget.)
const CANDIDATE_LIMIT = 100;

export type DateGroup = {
  date: string;
  items: PartialSTACItem[];
  /** Distinct footprint frames this date covers on its own. */
  footprints: number;
};

export type SceneSearch = {
  candidates: PartialSTACItem[];
  searching: boolean;
  error: string | null;
  /** True once a search has run (distinguishes idle from an empty result). */
  hasSearched: boolean;
  /** Dates over the window, best-coverage first, for the stepper. */
  dates: DateGroup[];
  /** Current step index into `dates`. */
  dateIdx: number;
  /** The currently-stepped date group, or null. */
  current: DateGroup | null;
  /** Coverage-first "most complete" mosaic across the whole window. */
  selection: CoverageSelection;
  /** Run a candidate search over an AOI + datetime interval. Does NOT load tiles. */
  search: (bbox: [number, number, number, number], datetime: string) => void;
  setDateIdx: (i: number) => void;
  /** Step the date cursor by +/-1, clamped. */
  step: (delta: number) => void;
  reset: () => void;
};

/** Which orbit pass to keep. `null` = both (no look-direction lock). */
export type OrbitFilter = "ascending" | "descending" | null;

export type SceneSearchOptions = {
  /** Optional hard cap on scenes in the "most complete" selection. Undefined
   *  keeps `selectCoverageFirst`'s interactive default (3); export mode passes a
   *  far higher cap so a wide AOI can mosaic many frames. */
  maxScenes?: number;
  /** Lock the candidate set to one orbit direction. Ascending and descending
   *  light opposite slope faces, so mixing them in a wide mosaic gives the worst
   *  tonal seams; locking one direction is the cheapest seam reduction. */
  orbit?: OrbitFilter;
};

export function useSceneSearch(opts: SceneSearchOptions = {}): SceneSearch {
  const { maxScenes, orbit = null } = opts;
  const abort = useRef<AbortController | null>(null);
  const [rawCandidates, setRawCandidates] = useState<PartialSTACItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [dateIdx, setDateIdx] = useState(0);

  const search = useCallback(
    (bbox: [number, number, number, number], datetime: string) => {
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      setSearching(true);
      setError(null);
      setHasSearched(true);
      fetchStacItems({ datetime, bbox, maxItems: CANDIDATE_LIMIT, signal: ac.signal })
        .then(({ items }) => {
          if (ac.signal.aborted) return;
          setRawCandidates(items);
          setDateIdx(0);
          console.info(`[search] ${items.length} S1 GRD candidate scenes`);
        })
        .catch((err) => {
          if (err.name !== "AbortError") {
            console.error("[search] failed:", err);
            setError(String(err.message ?? err));
            setRawCandidates([]);
          }
        })
        .finally(() => {
          if (abort.current === ac) setSearching(false);
        });
    },
    [],
  );

  // Apply the orbit-direction lock before any grouping, so the date stepper, the
  // coverage selection, and the footprint overlay all reflect a single look.
  const candidates = useMemo(
    () => (orbit ? rawCandidates.filter((c) => c.orbit === orbit) : rawCandidates),
    [rawCandidates, orbit],
  );

  const dates = useMemo(() => groupByDate(candidates), [candidates]);
  const selection = useMemo(
    () => selectCoverageFirst(candidates, { maxScenes }),
    [candidates, maxScenes],
  );
  const current = dates[dateIdx] ?? null;

  const step = useCallback(
    (delta: number) =>
      setDateIdx((i) => Math.max(0, Math.min(dates.length - 1, i + delta))),
    [dates.length],
  );

  const reset = useCallback(() => {
    abort.current?.abort();
    setRawCandidates([]);
    setHasSearched(false);
    setError(null);
    setDateIdx(0);
  }, []);

  return {
    candidates, searching, error, hasSearched,
    dates, dateIdx, current, selection,
    search, setDateIdx, step, reset,
  };
}

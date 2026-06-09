/**
 * Persist the amplitude render-look knobs (polarization, dB window, gamma) to
 * localStorage so a reload keeps the user's choices. Scoped to look only — not
 * AOI or date window, which are navigational.
 */
import {
  DEFAULT_DB_RANGE,
  DEFAULT_GAMMA,
} from "./renderPipeline";
import type { Polarization } from "./stac";

const KEY = "s1amp.lookPrefs.v2";

export type LookPrefs = {
  pol: Polarization;
  dbRange: [number, number];
  gamma: number;
};

export const DEFAULT_LOOK_PREFS: LookPrefs = {
  pol: "vv",
  dbRange: DEFAULT_DB_RANGE,
  gamma: DEFAULT_GAMMA,
};

const num = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** Read + validate stored prefs; anything missing/stale falls back to default. */
export function loadLookPrefs(): LookPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_LOOK_PREFS;
    const p = JSON.parse(raw) as Partial<LookPrefs>;
    const r = Array.isArray(p.dbRange) ? p.dbRange : DEFAULT_DB_RANGE;
    return {
      pol: p.pol === "vh" ? "vh" : "vv",
      dbRange: [num(r[0], DEFAULT_DB_RANGE[0]), num(r[1], DEFAULT_DB_RANGE[1])],
      gamma: num(p.gamma, DEFAULT_GAMMA),
    };
  } catch {
    return DEFAULT_LOOK_PREFS;
  }
}

export function saveLookPrefs(prefs: LookPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / quota — preferences just won't persist */
  }
}

/**
 * Persist the dashboard settings to localStorage so a reload (or "come back
 * later") restores the session. Saving is EXPLICIT: the SAVE SETTINGS button
 * captures everything at click time; RESET clears back to defaults.
 *
 * Scope (decided with Stephen): the render look (polarization, dB window,
 * gamma) PLUS the navigational state, search window, drawn AOI, and map view,
 * which the old look-only prefs deliberately left out.
 *
 * Date/AOI/view default to `null` here (this module doesn't know the app's
 * starting AOI or camera); `App` substitutes its own defaults when a field is
 * null, so this stays free of a circular import.
 */
import { DEFAULT_DB_RANGE, DEFAULT_GAMMA } from "./renderPipeline";
import type { Polarization } from "./stac";

// v4: full session settings (look + search window + AOI + view). Supersedes the
// look-only v3 key; old v3 values are ignored (one-time reset on upgrade).
const KEY = "s1amp.settings.v4";

export type SavedView = {
  longitude: number;
  latitude: number;
  zoom: number;
};

export type Settings = {
  // Render look.
  pol: Polarization;
  dbRange: [number, number];
  gamma: number;
  // Search window.
  dateFrom: string | null;
  dateTo: string | null;
  // Drawn / searched AOI [W,S,E,N].
  bbox: [number, number, number, number] | null;
  // Map camera.
  view: SavedView | null;
};

export const DEFAULT_SETTINGS: Settings = {
  pol: "vv",
  dbRange: DEFAULT_DB_RANGE,
  gamma: DEFAULT_GAMMA,
  dateFrom: null,
  dateTo: null,
  bbox: null,
  view: null,
};

const num = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const isDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

function asBbox(v: unknown): [number, number, number, number] | null {
  return Array.isArray(v) && v.length === 4 && v.every((n) => Number.isFinite(n))
    ? [v[0], v[1], v[2], v[3]]
    : null;
}

function asView(v: unknown): SavedView | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (
    Number.isFinite(o.longitude) &&
    Number.isFinite(o.latitude) &&
    Number.isFinite(o.zoom)
  ) {
    return {
      longitude: o.longitude as number,
      latitude: o.latitude as number,
      zoom: o.zoom as number,
    };
  }
  return null;
}

/** Read + validate stored settings; anything missing/stale falls back to default. */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const p = JSON.parse(raw) as Partial<Settings>;
    const r = Array.isArray(p.dbRange) ? p.dbRange : DEFAULT_DB_RANGE;
    return {
      pol: p.pol === "vh" ? "vh" : "vv",
      dbRange: [num(r[0], DEFAULT_DB_RANGE[0]), num(r[1], DEFAULT_DB_RANGE[1])],
      gamma: num(p.gamma, DEFAULT_GAMMA),
      dateFrom: isDate(p.dateFrom) ? p.dateFrom : null,
      dateTo: isDate(p.dateTo) ? p.dateTo : null,
      bbox: asBbox(p.bbox),
      view: asView(p.view),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode / quota: settings just won't persist */
  }
}

export function resetSettings(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

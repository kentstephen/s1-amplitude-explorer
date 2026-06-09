/**
 * Persist the render-appearance knobs (colormap, reverse, range, darken,
 * brightness) to localStorage so a reload keeps the user's choices until they
 * change them. Scoped to color/look preferences only — not AOI, year, or mode,
 * which are navigational and better reset per visit.
 */
import {
  DEFAULT_NDVI_COLORMAP,
  DEFAULT_NDVI_RANGE,
  DEFAULT_NDVI_SCALE,
  INDEX_COLORMAPS,
  type NdviColormap,
} from "./renderPipeline";

const KEY = "s2cog.colorPrefs.v1";
const DEFAULT_RGB_GAIN = 1.0;

export type ColorPrefs = {
  rgbGain: number;
  ndviColormap: NdviColormap;
  ndviRange: [number, number];
  ndviScale: number;
  ndviReversed: boolean;
  // RGB texture smoothing: true = linear magnification, false = nearest.
  smoothing: boolean;
  // Selected mosaic year. App validates against AVAILABLE_YEARS on load.
  year: number;
};

export const DEFAULT_COLOR_PREFS: ColorPrefs = {
  rgbGain: DEFAULT_RGB_GAIN,
  ndviColormap: DEFAULT_NDVI_COLORMAP,
  ndviRange: DEFAULT_NDVI_RANGE,
  ndviScale: DEFAULT_NDVI_SCALE,
  ndviReversed: false,
  smoothing: false,
  year: 2023,
};

const num = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/**
 * Read + validate stored prefs. Anything missing, malformed, or stale (e.g. a
 * colormap name that no longer exists after we pruned the red-green ramps)
 * falls back to its default, so old/garbage storage can't break the UI.
 */
export function loadColorPrefs(): ColorPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_COLOR_PREFS;
    const p = JSON.parse(raw) as Partial<ColorPrefs>;
    const cmap =
      typeof p.ndviColormap === "string" &&
      (INDEX_COLORMAPS as readonly string[]).includes(p.ndviColormap)
        ? (p.ndviColormap as NdviColormap)
        : DEFAULT_NDVI_COLORMAP;
    const r = Array.isArray(p.ndviRange) ? p.ndviRange : DEFAULT_NDVI_RANGE;
    return {
      rgbGain: num(p.rgbGain, DEFAULT_RGB_GAIN),
      ndviColormap: cmap,
      ndviRange: [num(r[0], DEFAULT_NDVI_RANGE[0]), num(r[1], DEFAULT_NDVI_RANGE[1])],
      ndviScale: num(p.ndviScale, DEFAULT_NDVI_SCALE),
      ndviReversed: p.ndviReversed === true,
      smoothing: p.smoothing === true,
      year: num(p.year, 2023),
    };
  } catch {
    return DEFAULT_COLOR_PREFS;
  }
}

export function saveColorPrefs(prefs: ColorPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / quota — preferences just won't persist */
  }
}

import type { RasterModule } from "@developmentseed/deck.gl-raster";
import { LinearRescale } from "@developmentseed/deck.gl-raster/gpu-modules";
import { AmplitudeToDb } from "./shaders/amplitude";
import { Gamma } from "./shaders/gamma";
import type { Polarization } from "./stac";

export type { Polarization } from "./stac";
export const POLARIZATIONS: Polarization[] = ["vv", "vh"];

/**
 * Default dB stretch window. RTC VV land backscatter (gamma0 linear power →
 * 10·log10) lands roughly -22..0 dB; this window gives a punchy monochrome out
 * of the box and is the two-thumb slider's home.
 */
export const DEFAULT_DB_RANGE: [number, number] = [-22, 0];
export const DB_MIN = -40;
export const DB_MAX = 5;

/** Default midtone gamma. 1.0 = linear; the dramatic preset pushes it up. */
export const DEFAULT_GAMMA = 1.0;

/** A high-contrast, inky-shadow preset for the most cinematic look. */
export const DRAMATIC_DB_RANGE: [number, number] = [-20, -2];
export const DRAMATIC_GAMMA = 1.5;

/** MultiCOGLayer composite: the single amplitude slot → color.r. */
export const AMP_COMPOSITE = { r: "amp" } as const;

/**
 * Monochrome SAR amplitude pipeline: discard nodata, amplitude → dB, stretch the
 * dB window to [0,1] grayscale, then a gamma/contrast curve. No colormap —
 * Stephen wants pure monochrome.
 */
export function buildRenderPipeline(opts: {
  dbRange?: [number, number];
  gamma?: number;
} = {}): RasterModule[] {
  const [lo, hi] = opts.dbRange ?? DEFAULT_DB_RANGE;
  return [
    // AmplitudeToDb discards nodata/0-padding (color.r <= 0) before the log.
    { module: AmplitudeToDb },
    { module: LinearRescale, props: { rescaleMin: lo, rescaleMax: hi } },
    { module: Gamma, props: { value: opts.gamma ?? DEFAULT_GAMMA } },
  ];
}

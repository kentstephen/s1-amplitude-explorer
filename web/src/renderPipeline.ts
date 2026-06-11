import type { RasterModule } from "@developmentseed/deck.gl-raster";
import { LinearRescale } from "@developmentseed/deck.gl-raster/gpu-modules";
import { AmplitudeToDb } from "./shaders/amplitude";
import { Gamma } from "./shaders/gamma";
import { PolCompositeToRgb } from "./shaders/polComposite";
import type { Polarization } from "./stac";

export type { Polarization } from "./stac";
export const POLARIZATIONS: Polarization[] = ["vv", "vh"];

/** Render look: single-pol grayscale amplitude, or the dual-pol RGB composite. */
export type RenderMode = "amplitude" | "composite";

/**
 * Default dB stretch window. Raw GRD VV amplitude as `20·log10(DN/65535)`
 * lands roughly -65..-45 dB over land; this window gives a punchy monochrome
 * out of the box and is the two-thumb slider's home.
 */
export const DEFAULT_DB_RANGE: [number, number] = [-65, -45];
export const DB_MIN = -90;
export const DB_MAX = 0;

/** Default midtone gamma. 1.0 = linear; the dramatic preset pushes it up. */
export const DEFAULT_GAMMA = 1.0;

/** A high-contrast, inky-shadow preset for the most cinematic look. */
export const DRAMATIC_DB_RANGE: [number, number] = [-63, -47];
export const DRAMATIC_GAMMA = 1.5;

/** MultiCOGLayer composite: the single amplitude slot → color.r. */
export const AMP_COMPOSITE = { r: "amp" } as const;

/** Dual-pol composite: VV → color.r, VH → color.g (the ratio is computed in the
 *  shader from those two). The blue slot is left for the shader to derive. */
export const POL_COMPOSITE = { r: "vv", g: "vh" } as const;

/**
 * Default dB stretch windows for the dual-pol composite. VH backscatter sits
 * roughly 7-10 dB below VV over land, so its window is shifted down; the ratio
 * (VV-VH) is typically a few dB up to ~16 dB over land. The VV window is driven
 * live by the same dB-range slider as amplitude mode; VH tracks it shifted down,
 * and the ratio window is fixed (tuning all three is a later refinement).
 */
export const COMPOSITE_VH_OFFSET = 7;
export const COMPOSITE_RATIO_WINDOW: [number, number] = [2, 16];

/**
 * Dual-pol RGB composite pipeline (one module does dB, per-channel stretch, the
 * ratio, and gamma). `vvWindow` comes from the dB slider; `vhWindow` is it shifted
 * down by COMPOSITE_VH_OFFSET; the ratio window is fixed.
 */
export function buildCompositePipeline(opts: {
  vvWindow?: [number, number];
  gamma?: number;
} = {}): RasterModule[] {
  const vv = opts.vvWindow ?? DEFAULT_DB_RANGE;
  const vh: [number, number] = [vv[0] - COMPOSITE_VH_OFFSET, vv[1] - COMPOSITE_VH_OFFSET];
  return [
    {
      module: PolCompositeToRgb,
      props: {
        vvWindow: vv,
        vhWindow: vh,
        ratioWindow: COMPOSITE_RATIO_WINDOW,
        gamma: opts.gamma ?? DEFAULT_GAMMA,
      },
    },
  ];
}

/**
 * Monochrome SAR amplitude pipeline: discard nodata, amplitude → dB, stretch the
 * dB window to [0,1] grayscale, then a gamma/contrast curve. No colormap ,
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

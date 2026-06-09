import type { ShaderModule } from "@luma.gl/shadertools";

export const discardBlack = {
  name: "discard-black",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      if (color.r + color.g + color.b < 0.01) {
        discard;
      }
    `,
  },
} as const satisfies ShaderModule;

/**
 * Discards pixels where EITHER index input band is the MultiCOGLayer
 * `boundless: true` zero-padding outside a COG's data area.
 *
 * A normalized-difference index `(a − b)/(a + b)` needs BOTH bands. Where only
 * one is present — e.g. B08 (10 m) vs B11 (20 m, SWIR) have different
 * footprints/edges, so one COG pads with zeros while the other still has data —
 * the ratio collapses to a constant ±1 and paints a hard yellow/blue seam.
 * Requiring both bands present drops those one-sided edges.
 *
 * Runs first in the index pipeline (color.r = band a, color.g = band b;
 * color.b is always 0 by composite, so it is excluded from the test).
 * Threshold is ~2 × the smallest r16unorm step, so real low-reflectance pixels
 * (deep water, shadow) survive.
 */
export const discardBoundlessPadding = {
  name: "discard-boundless-padding",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      if (color.r < 0.00005 || color.g < 0.00005) {
        discard;
      }
    `,
  },
} as const satisfies ShaderModule;

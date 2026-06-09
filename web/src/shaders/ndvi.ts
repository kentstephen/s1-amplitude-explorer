import type { ShaderModule } from "@luma.gl/shadertools";

/**
 * Generic normalized difference `(a - b) / (a + b)` from an a-in-r / b-in-g
 * packed color. Drives every curated index (NDVI, NDWI) — only the band → slot
 * mapping differs per index (see `INDICES` in renderPipeline.ts).
 *
 * Runs after MultiCOGLayer's auto-prepended CompositeBands module, which has
 * written `composite.r` (band a) into `color.r` and `composite.g` (band b) into
 * `color.g`. We compute the ratio into `color.r` in [-1, 1]; a downstream
 * LinearRescale then maps it to [0, 1] for Colormap sampling.
 */
export const NormalizedDifference = {
  name: "normalized-difference",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      // Names must not collide with CompositeBands' injected locals (it declares
      // float a/b/g/r for alpha/blue/green/red in this same function scope).
      float ndA = color.r;
      float ndB = color.g;
      float ndDenom = ndA + ndB;
      color.r = ndDenom > 0.0 ? (ndA - ndB) / ndDenom : 0.0;
    `,
  },
} as const satisfies ShaderModule;

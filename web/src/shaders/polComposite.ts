import type { ShaderModule } from "@luma.gl/shadertools";

/**
 * Dual-pol false-colour composite for Sentinel-1 GRD.
 *
 * Amplitude alone (one polarization, grayscale) shows relief and roughness but
 * can't tell *what* is scattering. Loading BOTH co-registered pols of a scene and
 * mapping them to colour does:
 *
 *   R = VV         co-pol: bright on rough surfaces, bare ground, urban walls
 *   G = VH         cross-pol: bright on VOLUME scattering, i.e. vegetation canopy
 *   B = VV / VH    the ratio: high where there's little volume scatter (smooth
 *                  ground, water, bare soil), low over forest/dense vegetation
 *
 * So vegetation reads green, rough/urban reddish, smooth/open surfaces blue-ish.
 * It's the standard S1 RGB and it sidesteps the S1/S2 registration problem (both
 * pols share one acquisition + GCP grid, so they're pixel-aligned by construction).
 *
 * Inputs arrive as normalized amplitude: `CompositeBands` writes source `vv` into
 * `color.r` and `vh` into `color.g` (each a UInt16 DN / 65535 from its r16unorm
 * texture). We convert each to dB (`20·log10(DN/65535)`), stretch each channel by
 * its own window, take the ratio in dB (a subtraction), then gamma. A pixel where
 * either pol is nodata (0) is discarded so the log never sees ≤0.
 */
export const PolCompositeToRgb = {
  // The module name must match the uniform-block prefix (`polComposite` →
  // `polCompositeUniforms`) and be a valid GLSL identifier: luma.gl derives the
  // UBO binding name from it, so a hyphenated name silently fails to bind.
  name: "polComposite",
  fs: /* glsl */ `
uniform polCompositeUniforms {
  vec2 vvWindow;     // dB [min, max] mapped to red
  vec2 vhWindow;     // dB [min, max] mapped to green
  vec2 ratioWindow;  // dB [min, max] mapped to blue (VV - VH)
  float gamma;
} polComposite;
`,
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      float vvAmp = color.r;
      float vhAmp = color.g;
      if (vvAmp <= 0.0 || vhAmp <= 0.0) discard;   // nodata / 0-padding in either pol

      float vvDb = 20.0 * log(vvAmp) / log(10.0);
      float vhDb = 20.0 * log(vhAmp) / log(10.0);
      float ratioDb = vvDb - vhDb;                 // = 20·log10(VV / VH)

      vec3 raw = vec3(vvDb, vhDb, ratioDb);
      vec3 lo = vec3(polComposite.vvWindow.x, polComposite.vhWindow.x, polComposite.ratioWindow.x);
      vec3 hi = vec3(polComposite.vvWindow.y, polComposite.vhWindow.y, polComposite.ratioWindow.y);
      vec3 rgb = clamp((raw - lo) / max(hi - lo, vec3(1e-4)), 0.0, 1.0);
      rgb = pow(rgb, vec3(polComposite.gamma));

      color = vec4(rgb, color.a);
    `,
  },
  uniformTypes: {
    vvWindow: "vec2<f32>",
    vhWindow: "vec2<f32>",
    ratioWindow: "vec2<f32>",
    gamma: "f32",
  },
  getUniforms: (props: {
    vvWindow?: [number, number];
    vhWindow?: [number, number];
    ratioWindow?: [number, number];
    gamma?: number;
  }) => ({
    vvWindow: props.vvWindow ?? [-65, -45],
    vhWindow: props.vhWindow ?? [-72, -52],
    ratioWindow: props.ratioWindow ?? [2, 16],
    gamma: props.gamma ?? 1.0,
  }),
} as const satisfies ShaderModule<{
  vvWindow: [number, number];
  vhWindow: [number, number];
  ratioWindow: [number, number];
  gamma: number;
}>;

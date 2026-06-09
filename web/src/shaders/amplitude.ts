import type { ShaderModule } from "@luma.gl/shadertools";

/**
 * Raw Sentinel-1 GRD amplitude → decibels, for SAR display.
 *
 * The Earth Search `sentinel-1-grd` measurement COGs are single-band **UInt16
 * amplitude** (DN), nodata 0. `MultiCOGLayer` uploads Uint16 as an `r16unorm`
 * texture, so the sampler hands us the *normalized* value `DN / 65535` in
 * `color.r` (CompositeBands has already written our single `amp` slot there).
 *
 * Display the conventional way for amplitude: `dB = 20·log10(amplitude)`. With
 * the normalized DN that is `20·log10(DN/65535)`, i.e. 0 dB at full scale,
 * negative below, land typically lands around −65..−45 dB. (GLSL `log` is
 * natural log, hence `/ log(10)`.) The nodata 0 (and any boundless 0-padding)
 * is discarded first so `log` never sees ≤0.
 *
 * Writes dB into all of `color.rgb` so a downstream `LinearRescale` (which
 * clamps `color.rgb`) maps it uniformly to a [0,1] grayscale.
 */
export const AmplitudeToDb = {
  name: "amplitude-to-db",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      if (color.r <= 0.0) discard;       // nodata 0 + boundless 0-padding
      float ampDb = 20.0 * log(color.r) / log(10.0);
      color.rgb = vec3(ampDb);
    `,
  },
} as const satisfies ShaderModule;

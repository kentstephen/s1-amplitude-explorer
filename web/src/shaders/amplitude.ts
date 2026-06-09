import type { ShaderModule } from "@luma.gl/shadertools";

/**
 * Sentinel-1 RTC backscatter → decibels, for SAR display.
 *
 * The MPC `sentinel-1-rtc` assets are single-band Float32 *linear power*
 * (terrain-flattened gamma0), uploaded as `r32float`, so the sampler hands us
 * the raw power value in `color.r` (NOT a normalized DN). CompositeBands has
 * already written our single `amp` slot into `color.r`.
 *
 * Display the conventional way: `dB = 10·log10(power)`. (GLSL `log` is natural
 * log, hence `/ log(10)`.) Non-positive samples are discarded first: that covers
 * both the product nodata (-32768) and MultiCOGLayer's boundless 0-padding, and
 * keeps `log` away from ≤0.
 *
 * Writes dB into all of `color.rgb` so a downstream `LinearRescale` (which clamps
 * `color.rgb`) maps it uniformly to a [0,1] grayscale.
 */
export const AmplitudeToDb = {
  name: "amplitude-to-db",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      if (color.r <= 0.0) discard;       // nodata (-32768) + boundless 0-padding
      float ampDb = 10.0 * log(color.r) / log(10.0);
      color.rgb = vec3(ampDb);
    `,
  },
} as const satisfies ShaderModule;

/**
 * CARTOColors palettes injected as extra rows on top of deck.gl-raster's
 * shipped 107-row colormap sprite. The sprite only carries matplotlib /
 * cmocean / colorbrewer ramps; CARTOColors aren't in it, so we interpolate the
 * published class stops into 256-px stripes and append them as new layers of
 * the same 2D-array texture.
 *
 * All three chosen here are deuteranopia-friendly — they avoid putting red and
 * green at opposite ends of the ramp (the reason rdylgn/spectral were dropped).
 *
 * Stops are the 7-class CARTOColors definitions (carto.com/carto-colors).
 */
export const CARTO_PALETTES = {
  // Sequential light-green → deep teal-green.
  emrld: ["#d3f2a3", "#97e196", "#6cc08b", "#4c9b82", "#217a79", "#105965", "#074050"],
  // Diverging brown ↔ teal.
  earth: ["#a16928", "#bd925a", "#d6bd8d", "#edeac2", "#b5c8b8", "#79a7ac", "#2887a1"],
  // Diverging teal ↔ orange.
  geyser: ["#008080", "#70a494", "#b4c8a8", "#f6edbd", "#edbb8a", "#de8a5a", "#ca562c"],
  // Sequential multi-hue yellow → orange → pink → purple. Colorblind-safe
  // rainbow stand-in for the removed `spectral` (no green/red opposition).
  sunset: ["#f3e79b", "#fac484", "#f8a07e", "#eb7f86", "#ce6693", "#a059a0", "#5c53a5"],
  // Deeper sibling of sunset: yellow → red → magenta → purple.
  sunsetdark: ["#fcde9c", "#faa476", "#f0746e", "#e34f6f", "#dc3977", "#b9257a", "#7c1d6f"],
  // Sequential pale → deep blue-green. Natural read for NDWI/water.
  teal: ["#d1eeea", "#a8dbd9", "#85c4c9", "#68abb8", "#4f90a6", "#3b738f", "#2a5674"],
} as const;

export type CartoColormap = keyof typeof CARTO_PALETTES;
export const CARTO_NAMES = Object.keys(CARTO_PALETTES) as CartoColormap[];

export function isCartoColormap(name: string): name is CartoColormap {
  return name in CARTO_PALETTES;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Interpolate a palette's hex stops into a 256×1 RGBA stripe (the row layout
 * `createColormapTexture` expects: 256 texels wide, fully opaque).
 */
export function buildColormapStripe(name: CartoColormap): Uint8ClampedArray {
  const stops = CARTO_PALETTES[name].map(hexToRgb);
  const out = new Uint8ClampedArray(256 * 4);
  const segs = stops.length - 1;
  for (let x = 0; x < 256; x++) {
    const t = (x / 255) * segs;
    const i = Math.min(Math.floor(t), segs - 1);
    const f = t - i;
    const [r0, g0, b0] = stops[i];
    const [r1, g1, b1] = stops[i + 1];
    const o = x * 4;
    out[o] = r0 + (r1 - r0) * f;
    out[o + 1] = g0 + (g1 - g0) * f;
    out[o + 2] = b0 + (b1 - b0) * f;
    out[o + 3] = 255;
  }
  return out;
}

/**
 * Append CARTO stripes as new rows beneath a decoded base sprite. Returns the
 * combined ImageData (still 256 wide) plus a name→row-index map for just the
 * CARTO additions (their indices start at the base sprite's height).
 */
export function appendCartoColormaps(base: ImageData): {
  image: ImageData;
  index: Record<CartoColormap, number>;
} {
  const baseRows = base.height;
  const rows = baseRows + CARTO_NAMES.length;
  const data = new Uint8ClampedArray(256 * rows * 4);
  data.set(base.data, 0);
  const index = {} as Record<CartoColormap, number>;
  CARTO_NAMES.forEach((name, i) => {
    const row = baseRows + i;
    data.set(buildColormapStripe(name), row * 256 * 4);
    index[name] = row;
  });
  return { image: new ImageData(data, 256, rows), index };
}

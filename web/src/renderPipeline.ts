import type { RasterModule } from "@developmentseed/deck.gl-raster";
import {
  Colormap,
  COLORMAP_INDEX,
  LinearRescale,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import type { Texture } from "@luma.gl/core";
import { discardBoundlessPadding } from "./discardBlack";
import { NormalizedDifference } from "./shaders/ndvi";
import { ScaleColor } from "./shaders/scaleColor";

/** Sentinel-2 band assets we pull per item (RGB uses the precomposed TCI). */
export type BandKey = "B03" | "B04" | "B08";

/**
 * Curated spectral-index registry (item 4). Every entry is a normalized
 * difference `(a - b) / (a + b)` so they all share one shader (`NormalizedDifference`)
 * and the existing MultiCOGLayer composite path — only the two band slots differ.
 * `a` is packed into color.r, `b` into color.g by the `composite` below.
 *
 * Only 10 m bands here (B03/B04/B08). NDBI/NDMI were dropped (2026-05-20): they
 * pair B11 (20 m SWIR) with a 10 m band, and the resolution/nodata-footprint
 * mismatch paints hard ±1 seams where one grid has data and the other pads with
 * zeros. See docs/SPECTRAL_INDICES.md. A non-normalized-difference index (EVI,
 * SAVI, BSI) would also need a dedicated shader + constants.
 */
export const INDICES = {
  ndvi: { label: "NDVI", a: "B08", b: "B04", desc: "vegetation" },
  ndwi: { label: "NDWI", a: "B03", b: "B08", desc: "water" },
} as const satisfies Record<string, { label: string; a: BandKey; b: BandKey; desc: string }>;

export type IndexKey = keyof typeof INDICES;
export const INDEX_KEYS = Object.keys(INDICES) as IndexKey[];

/** "rgb" renders the precomposed TCI via COGLayer; the rest are GPU indices. */
export type RenderMode = "rgb" | IndexKey;

export function isIndexMode(mode: RenderMode): mode is IndexKey {
  return mode !== "rgb";
}

/**
 * Colormaps exposed for index modes. Deuteranopia-friendly set: the red-green
 * ramps (rdylgn, spectral) were dropped because they're indistinguishable to
 * red-green colorblind viewers. cividis/viridis/plasma are perceptually uniform
 * and colorblind-safe; rdbu is a blue-red divergent (safe — the confusion axis
 * is red-green, not red-blue); emrld/earth/geyser are CARTOColors injected via
 * cartoColormaps.ts (not in the shipped sprite).
 */
export const INDEX_COLORMAPS = [
  "cividis",
  "viridis",
  "plasma",
  "rdbu",
  "emrld",
  "earth",
  "geyser",
  "sunset",
  "sunsetdark",
  "teal",
  "blues",
  "oranges",
] as const;
export type IndexColormap = (typeof INDEX_COLORMAPS)[number];
export const DEFAULT_NDVI_COLORMAP: IndexColormap = "cividis";

/** Default index stretch range — symmetric [-1, 1] centers divergent ramps at 0. */
export const DEFAULT_NDVI_RANGE: [number, number] = [-1, 1];

/** Default post-colormap multiplier; 1.0 = unchanged, <1 darkens. */
export const DEFAULT_NDVI_SCALE = 1.0;

/** Back-compat alias used by App's UI. */
export const NDVI_COLORMAPS = INDEX_COLORMAPS;
export type NdviColormap = IndexColormap;

/**
 * MultiCOGLayer `sources` slot → STAC asset map for an index mode. Slot names
 * (`a`, `b`) are packed into color channels by COMPOSITE below.
 */
export function bandSlotsFor(mode: IndexKey): Record<"a" | "b", BandKey> {
  const { a, b } = INDICES[mode];
  return { a, b };
}

/** Composite packing: index input `a`→color.r, `b`→color.g (uniform for all indices). */
export const INDEX_COMPOSITE = { r: "a", g: "b" } as const;

export function buildRenderPipeline(
  mode: RenderMode,
  colormapTexture: Texture | null,
  opts: {
    ndviColormap?: IndexColormap;
    // Resolved row index in the (possibly CARTO-augmented) colormap texture.
    // Falls back to the shipped sprite's COLORMAP_INDEX when omitted.
    colormapIndex?: number;
    ndviRange?: [number, number];
    ndviScale?: number;
    ndviReversed?: boolean;
  } = {},
): RasterModule[] {
  if (mode === "rgb") return []; // RGB is handled by COGLayer/renderTile, not here.
  if (!colormapTexture) return [];
  const [lo, hi] = opts.ndviRange ?? DEFAULT_NDVI_RANGE;
  return [
    { module: discardBoundlessPadding },
    { module: NormalizedDifference },
    { module: LinearRescale, props: { rescaleMin: lo, rescaleMax: hi } },
    {
      module: Colormap,
      props: {
        colormapTexture,
        colormapIndex:
          opts.colormapIndex ??
          COLORMAP_INDEX[(opts.ndviColormap ?? DEFAULT_NDVI_COLORMAP) as keyof typeof COLORMAP_INDEX],
        reversed: opts.ndviReversed ?? false,
      },
    },
    {
      module: ScaleColor,
      props: { factor: opts.ndviScale ?? DEFAULT_NDVI_SCALE },
    },
  ];
}

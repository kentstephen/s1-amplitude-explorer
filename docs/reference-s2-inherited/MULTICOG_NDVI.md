# MultiCOGLayer + RGB/NDVI toggle

Switch the renderer from a single-asset `MosaicLayer → COGLayer(TCI)` path to
`MosaicLayer → MultiCOGLayer(B0n bands)` with a mode toggle between an RGB
composite and NDVI (cividis colormap, optional live range filter).

## Why MultiCOG

The Earth Genome Sentinel-2 Temporal Mosaics ship each band as its own COG
asset (`B01..B12`, `B8A`) alongside a pre-stretched `TCI` (3-band RGB
visualization). The current app uses only `TCI` — fast, but throws away
every other band. To compute NDVI we need at minimum **B04 (red)** and
**B08 (NIR)** as separate inputs, which is exactly what `MultiCOGLayer` is
built for: each "source" is one named single-band COG, the layer fetches
them in parallel per tile, GPU-resamples across resolutions, and exposes
them as `band0..band3` samplers to the render pipeline.

## Findings from deck.gl-raster examples

Read in `https://github.com/developmentseed/deck.gl-raster/tree/main/examples`.

### `examples/sentinel-2` — multi-band composite presets

```ts
const layer = new MultiCOGLayer({
  sources: { red:   { url: `${baseUrl}/B04.tif` },
             green: { url: `${baseUrl}/B03.tif` },
             blue:  { url: `${baseUrl}/B02.tif` } },
  composite: { r: 'red', g: 'green', b: 'blue' },
  renderPipeline: [
    { module: FilterNoDataVal, props: { noDataValue: 0 } },
    { module: LinearRescale,   props: { rescaleMin: 0, rescaleMax: 0.05 } },
  ],
});
```

`MultiCOGLayer` auto-prepends `CompositeBands` (multi-cog-layer.ts:594),
which writes the named bands into `color.r/g/b/a` according to `composite`.
The user-supplied `renderPipeline` runs **after** that — so all our
follow-on modules see standard RGBA color, not raw band samplers.

### `examples/naip-mosaic` — NDVI with a live range filter

This is the "pulls pixels away" demo. NAIP is 4-band (R,G,B,NIR) in a
single COG, so it uses `COGLayer` not `MultiCOG`, but the shader pattern
is what we want:

```glsl
// normalizedDifference module
color.r = (nir - red) / (nir + red);   // [-1, 1] in color.r

// ndviFilter module — uniforms ndviMin, ndviMax, slider-driven
if (color.r < ndviFilter.ndviMin || color.r > ndviFilter.ndviMax) discard;
```

Pipeline: `CreateTexture → normalizedDifference → ndviFilter →
LinearRescale(-1,1 → 0,1) → Colormap(cfastie) → SetAlpha1`.

The `discard` in `ndviFilter` is what visibly carves pixels away as the
slider moves — no recompute, no refetch, just a uniform change.

### `examples/vermont-cog-comparison` — same NDVI math, no slider

`shaders.ts` shows the simpler `(ndvi + 1) / 2` written into `color.r`,
feeding a fixed `cfastie` colormap. Useful as the no-slider baseline.

### Built-in modules we'll use

From `@developmentseed/deck.gl-raster/gpu-modules`:

- `CompositeBands` — auto-applied by MultiCOGLayer.
- `LinearRescale` — `(value - min) / (max - min)`, clamped to [0,1].
- `Colormap` — samples a row of the shipped `colormaps.png` sprite.
  Cividis is `COLORMAP_INDEX.cividis === 15`.
- `createColormapTexture`, `decodeColormapSprite` — one-time GPU upload of
  the sprite. Same dance as naip-mosaic/App.tsx and vermont/App.tsx.

## Port to our app

### Architecture

```
MosaicLayer<PartialSTACItem>           // existing, still drives viewport-driven
  sources: stacItems                   //   spatial indexing over MGRS items
  getSource: (item) => null            //   no shared GeoTIFF — MultiCOG opens its own
  renderSource: (item) =>
    new MultiCOGLayer({
      sources: bandsForMode(item, mode),   // { red, green, blue } | { nir, red }
      composite: compositeForMode(mode),
      renderPipeline: pipelineForMode(mode, colormapTexture),
    })
```

`MosaicLayer` still earns its keep: it uses each item's `bbox` to spatial-
index and only calls `renderSource` for items intersecting the visible
tiles. We don't need its `getSource` cache because MultiCOGLayer fetches
its own GeoTIFFs internally.

### RGB mode

```ts
sources:   { red: B04, green: B03, blue: B02 }
composite: { r: 'red', g: 'green', b: 'blue' }
pipeline:  [
  { module: FilterNoDataVal, props: { noDataValue: 0 } },
  { module: LinearRescale,   props: { rescaleMin: 0, rescaleMax: 3000 } },
  // 3000 is a starting point for surface-reflectance uint16 stretched ×10000.
  // TCI uses a non-linear stretch + atmosphere correction, so this will look
  // duller than TCI. Tweak rescaleMax to taste; consider a proper percentile
  // stretch later if it matters.
]
```

### NDVI mode

```ts
sources:   { nir: B08, red: B04 }
composite: { r: 'nir', g: 'red' }      // NIR in color.r, red in color.g
pipeline:  [
  { module: FilterNoDataVal, props: { noDataValue: 0 } },
  { module: NdviFromRG },                // color.r = (r-g)/(r+g)
  { module: LinearRescale, props: { rescaleMin: -1, rescaleMax: 1 } },
  { module: Colormap,
    props: { colormapTexture, colormapIndex: COLORMAP_INDEX.cividis,
             reversed: false } },
]
```

`NdviFromRG` is a tiny custom shader module we ship in
`src/shaders/ndvi.ts`:

```glsl
// fs:DECKGL_FILTER_COLOR
float nir = color.r;
float red = color.g;
color.r = (nir - red) / (nir + red);
```

Reads from `color.r/g` (post-CompositeBands), not from band textures
directly — keeps it independent of slot indexing.

### Optional: live filter slider

Not in v1 but cheap to add: clone naip-mosaic's `ndviFilter` module with
`ndviMin`/`ndviMax` uniforms and a `discard` test, drop it in between
`NdviFromRG` and `LinearRescale`, wire to a `<input type="range">` pair.

### TODO: real-time vegetation segmentation

A natural next step from the live `discard` filter above. The same
shader-level approach — threshold NDVI per fragment, keep what passes —
is the cheapest form of real-time vegetation segmentation: vegetation =
visible, non-vegetation = transparent (basemap shows through). The
filter range becomes the segmentation threshold. Add a smoothing /
morphological step in the shader if the per-pixel mask is too noisy at
high zoom.

Prior art: there's a Fused UDF that does this against Esri's basemap.
That uses higher-resolution imagery than Sentinel-2 (sub-meter vs. 10
m), so the segmentation is more precise and the field boundaries are
crisp. The S2 version here would be coarser but live across the whole
collection and tunable interactively — different tradeoff.

Likely shape if we build it:
- Reuse the NDVI pipeline; add an `ndviSegmentationThreshold` uniform.
- Discard when NDVI < threshold (or symmetric range for non-veg mask).
- Optionally write the mask to a 1-channel offscreen target so a second
  pass can dilate/erode it.
- UI: single threshold slider + a "show mask only / overlay on RGB" toggle.

## Footguns / unknowns

- **B0n format.** Need to confirm Earth Genome publishes B02/B03/B04/B08 as
  separate single-band COGs alongside TCI. CLAUDE.md says yes. If a band
  is uint16 in 0..10000 (typical scaled SR), `LinearRescale 0→3000`
  matches TCI's brightness range roughly. If it's already 0..1 float, drop
  the 10000 scale factor.
- **No shared GeoTIFF cache.** Our existing module-level `geotiffCache`
  doesn't apply — `MultiCOGLayer` accepts only URLs and opens its own
  `GeoTIFF.fromUrl`. Toggling modes that share `B04` will re-open the
  header. Acceptable for v1; if it bites, fork MultiCOGLayer or PR an
  injectable loader upstream.
- **Header-read fan-out.** RGB mode = 3 bands × ~30 Netherlands items =
  ~90 small header reads on first paint. NDVI = 2 × ~30 = ~60. Lower than
  it sounds because headers are small Range reads, but front-loaded.
- **Mode toggle ⇒ layer rebuild.** Switching modes constructs a fresh
  `MultiCOGLayer` per item; tile textures are dropped. No way around it
  without a custom layer that hot-swaps its render pipeline.
- **Composite slot order matters for our NDVI shader.** `composite:
  { r: 'nir', g: 'red' }` puts NIR in `color.r`. Swap and the math
  inverts. Keep the names obvious.

## Things learned the hard way after first ship

Captured here so the next iteration doesn't re-burn the time.

### `boundless: true` is hardcoded in MultiCOG

`MultiCOGLayer._fetchPrimaryBand` / `_fetchSecondaryBand` both call
`image.fetchTile(..., boundless: true)` (`multi-cog-layer.ts:627, 724`).
Out-of-COG pixels arrive as real zeros. The old TCI path used our own
`getTileData` with `boundless: false` plus a `discardBlack` shader — both
protections. Without them, every MGRS tile gets a black border. Fix:
`discardBoundlessPadding` at the front of the render pipeline (`src/
discardBlack.ts`). Threshold `0.00005` ≈ 2× r16unorm step, low enough that
deep water survives.

### `updateTriggers.renderTile` is mandatory for live UI

`RasterTileLayer` wires `updateTriggers: { renderSubLayers:
updateTriggers?.renderTile }` (`raster-tile-layer.ts:338`). Without
threading `updateTriggers.renderTile` through `MultiCOGLayer`, the inner
`TileLayer` caches each tile's `RenderTileResult` forever and prop
changes (brightness, colormap, mode) never reach the GPU. We pass
`[mode, rgbRescaleMax, ndviColormap, colormapTexture]` as the trigger.

### `sources` is reference-compared

`MultiCOGLayer.updateState` does `props.sources !== oldProps.sources`
(`multi-cog-layer.ts:309`) and on mismatch **resets internal state** —
reopens GeoTIFFs, refetches every tile. Constructing the `sources` record
inline in `renderSource` produces a new object every render, so every
brightness-slider tick was kicking off a full refetch. Fix:
`useRef(new Map<...>())` keyed by `(mode, source.id)` so the same
reference is reused across non-source changes (`App.tsx`).

Symptom while debugging: brightness slider visibly worked but tiles
flickered/reloaded; network panel showed the same B0n COG URLs hit
repeatedly per slider tick.

### MGRS gaps are architectural, not configurable

Each item's `MultiCOGLayer` has its own inner `TileLayer` bound to that
COG's extent (`_tilesetDescriptor` returns the primary band's descriptor).
Adjacent items' tile grids don't share edges in mercator. Cross-UTM-zone
seams (e.g. 31N / 32N at 6°E) are wider because MGRS tiles are defined
in their respective UTM zones — they don't tile cleanly in mercator at
all. Upstream has no example combining `MosaicLayer` with
`MultiCOGLayer`; we're the first.

Options if it ever becomes a real problem:
1. Live with it + use a dark basemap so the seams read as imagery edges.
2. Re-tile to a shared mercator grid offline (defeats the project's
   "no prebake" premise).
3. Fork `MultiCOGLayer` to share a tile grid across items (real work).

### CRS verified uniform via `gdalinfo /vsicurl/`

Earlier hypothesis was TCI in mercator, B0n in UTM. `gdalinfo` over each
asset's URL confirmed all assets are EPSG:3857 with identical origin,
pixel size (`19.109m`), and dimensions (`9984 × 9984`). Same overview
pyramid too (6 levels down to 156×156). So the rendering differences
between paths are purely software-layer differences, not data ones.

### Year coverage on CORS-open hosts

Collection metadata claims temporal extent 2018-01 → 2024-01, but at
`bbox = wide Netherlands area`:

| year | items |
|------|-------|
| 2020 | 0     |
| 2021 | 0     |
| 2022 | 77    |
| 2023 | 154   |
| 2024 | 77    |

The 2018–2021 items live on `ei-imagery.s3.us-east-2`, which is
CORS-blocked; `stac.ts` filters them out. The year dropdown only offers
2022/2023/2024 for that reason. 2023 has ~2× items because the producer
shipped four overlapping seasonal composites (`*_2023-01_2023-05`,
`2023-04_2023-08`, etc.) that year. Visually that means more redundancy,
not better coverage.

# RGB tile-edge seams (NDVI is clean)

## RESOLVED (2026-05-20): render the single TCI COG via COGLayer

**Fix shipped.** RGB now renders each item's precomposed 3-band **TCI** COG
(`assets.visual`) through a single **`COGLayer`** per item under `MosaicLayer`
— the deck.gl-raster **naip-mosaic** pattern (`getTileData` → `CreateTexture` +
`discardBlack`). NDVI stays on `MultiCOGLayer` (needs the B08/B04 ratio; already
seam-free).

**The earlier "per-item independent tile grids" diagnosis below was wrong.**
The naip-mosaic example mosaics dozens of independent per-item COGLayers with no
visible seams, which disproves that theory. The actual cause was **`MultiCOGLayer`
compositing three *separately-tiled single-band* COGs (B04/B03/B02)** whose tile
grids / reprojection meshes don't co-register at the sub-pixel level. Rendering
one precomposed COG per item removes that misregistration entirely.

The BitmapLayer overview "Attempt 2" below was abandoned (looked worse, low-res,
still seamed). Overview mode and the zoom-gate were removed. The investigation
notes below are kept for history.

---


## Symptom

In **RGB** mode a faint regular grid of seams appears at tile boundaries —
visible at every zoom, including close in. In **NDVI (cividis)** the same
view is seam-free. Brightness slider doesn't change it.

## What it is NOT

- **Not radiometric / a data defect.** The Earth Genome temporal mosaic is
  advertised as seamless, and `gdalinfo /vsicurl/...` confirms every band
  (B02/B03/B04/B08/TCI) shares one CRS (EPSG:3857), origin, pixel size
  (19.109 m) and overview pyramid. The product is balanced.
- **Not transparent gaps.** `discardBoundlessPadding` runs first in *both*
  pipelines. If these were holes (basemap showing through), NDVI would show
  them too. It doesn't.

## Why RGB shows it and NDVI doesn't

- **RGB** renders *absolute* band values through `LinearRescale(0, 0.05)`.
  Any sub-pixel discontinuity at a tile edge becomes an absolute brightness
  step, stretched into visibility against the low-contrast forest.
- **NDVI** is a *normalized ratio* `(NIR − Red)/(NIR + Red)`. At a seam both
  bands shift together (same cause), so the ratio is stable → the
  discontinuity cancels. NDVI is inherently robust to exactly the per-edge
  offsets RGB exposes.

This asymmetry is the tell: the seam is an **absolute-value discontinuity at
tile boundaries**, introduced on the render side, not in the data.

## Where it comes from (the projection path)

deck.gl-raster reprojects **per tile**:

- `multi-cog-layer.ts:362` — `proj4(sourceProjection, "EPSG:3857")` builds a
  forward/inverse transform for every source. proj4 does **not** hard
  short-circuit `3857→3857` to identity; it still meshes each tile.
- `raster-reproject/src/delatin.ts` — builds a Delatin TIN mesh approximating
  the warp, refined until reprojection error < `maxError` (**default
  0.125 px**), then drapes the band texture over it.

Our architecture renders **one `MultiCOGLayer` per STAC item** under a single
`MosaicLayer`. Each item therefore builds its **own** tile grid and its **own**
reprojection mesh, independently. Along the edge shared by two adjacent items
the two meshes / grids can disagree at the sub-pixel level → the texture
warps/samples slightly differently on each side → a hairline seam.

## What we tried (2026-05-19) — none fixed it

| change                              | hypothesis                                   | result      |
| ---                                 | ---                                          | ---         |
| `maxError: 0.01`                    | tighten reprojection mesh tolerance          | no change   |
| `refinementStrategy: "no-overlap"`  | stop best-available overview-level mixing    | no change; also regressed zoom feel (tiles pop in blank) |

Both reverted. That maxError and refinement had zero effect points away from
mesh tolerance and overview mixing, and **at the per-item grid registration**
itself.

## The real fix (not done — significant work)

The seam is structural to "one independent `MultiCOGLayer` per item." To
eliminate it you'd need a **single shared mercator tile grid** across all
items, so adjacent items sample one common grid with no independent
per-item mesh:

- Fork / extend `MultiCOGLayer` (or `MosaicLayer`) so the whole mosaic meshes
  once against a shared tileset rather than per-item, OR
- Pre-mosaic to a single multi-band COG / overviews server-side (defeats the
  no-prebake premise), OR
- Accept it: NDVI is seam-free for analysis; RGB seams are cosmetic and only
  noticeable on low-contrast scenes. A darker basemap or gentler stretch
  reduces their salience.

## Attempt 2 (branch `overview-mosaic`) — BitmapLayer overview: STILL SEAMS

Built a zoom-independent "overview" toggle: per item, decode the coarsest TCI
overview (~156 px, one Range read) into an ImageBitmap and render it as a
single `BitmapLayer` with `bounds = STAC item.bbox`. Theory: one GPU-
reprojected quad per item, adjacent items share exact lng/lat edges → seamless,
and no per-tile mesh to mismatch.

**Result: still seams.** So the quad-per-item idea didn't kill them. Needs
debugging next session. Leading hypotheses, most likely first:

### Fix applied (2026-05-20): precise 3857→WGS84 bounds

Implemented hypothesis #1. `overviewMosaic.ts` now reads the GeoTIFF's exact
`tiff.bbox` (EPSG:3857 meters) and reprojects the two corners to WGS84 with a
closed-form inverse mercator (`mercToLngLat`, sphere R=6378137), returning
those bounds with the image (`OverviewTile`). `App.tsx`'s BitmapLayer uses
`tile.bounds` instead of the rounded STAC `item.bbox`. Because the 3857 grid
abuts exactly and both items run the shared edge through the identical formula,
adjacent quads now get bit-identical lng/lat edges. Guards `tiff.crs === 3857`.

**Needs visual verification in-browser** (Yuma AOI, overview on) — not yet
confirmed seam-free. If seams persist, move to hypothesis #2 (no-data edge
ring going transparent: temporarily force alpha 255 to test).

Original hypotheses, for reference:

1. **`bounds = STAC item.bbox` is approximate.** The collection is gridded in
   EPSG:3857 (origin 494088…, 19.109 m px, 9984 px). Adjacent items' *3857*
   extents abut exactly, but each STAC `bbox` is a WGS84 footprint that may be
   rounded — so item A's east edge ≠ item B's west edge by an epsilon, leaving
   a hairline basemap gap (or overlap) between quads.
   **Fix to try:** in `overviewMosaic.ts` we already open the GeoTIFF — read
   the exact `tiff.bbox` (3857), reproject the two corners to WGS84 with proj4,
   and return *those* precise bounds with the image instead of `item.bbox`.
   Adjacent items then share a bit-identical edge.
2. **No-data transparency eats the edge.** We set alpha 0 where TCI = (0,0,0).
   If the overview has a 0-valued outer ring, that ring goes transparent and
   shows basemap as a seam even when bounds abut. Test by temporarily forcing
   alpha 255 and see if seams vanish; if so, only zero-out *interior* no-data.
3. **BitmapLayer edge sampling / texture clamp.** A half-texel at the image
   border can leave a hairline. Less likely than #1/#2 but check
   `textureParameters` / a 1px overdraw on bounds.

Recommended order: #2 (cheap toggle), then #1 (the real one).

## Practical guidance

- For analysis or screenshots that must be seamless, **use NDVI**.
- RGB is fine for browsing; the seams are faint and scene-dependent (worst on
  flat, dark, low-contrast cover like rainforest).
- `overview` toggle exists but does NOT yet solve seams — see Attempt 2.

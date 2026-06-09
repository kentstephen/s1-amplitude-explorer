# Plan — Sentinel-1 Amplitude Explorer

> **NEXT AGENT: START HERE.** This is the committed direction as of 2026-06-09.
> **Start by cutting a new branch off `main`** (e.g. `gcp-warp`) — this work lands
> there, not on `main`. Read this whole file, then `docs/RESEARCH.md` and
> `.claude/memory/MEMORY.md`.
> The headline: we are building a **client-side GCP warp of raw Sentinel-1 GRD
> amplitude**, read straight from open object storage. No backend, no DEM, no
> tile server. This is the no-compromise path Stephen held out for after we
> burned through every off-the-shelf source.

## The decision (why this and not a quick swap)

Stephen's non-negotiables: **raw amplitude, from open object storage / a tolerant
API, rendered client-side and ultralight, with the dramatic GRD relief look,
global.** Every shortcut violated one of these. The dead ends, so the next agent
doesn't re-walk them:

| Source | Renders? | Open/CORS, no token? | Global? | Verdict |
|---|---|---|---|---|
| Earth Search `sentinel-1-grd` COG (`sentinel-s1-l1c`) | ✗ **GCP ground-range, no affine** | ✓ (`ACAO:*`, 206) | ✓ | data perfect, geometry unrenderable by default |
| EOPF S1 GRD Zarr (`objects.eodc.eu`) | ✗ GCP ground-range | likely (unconfirmed CORS) | sample-only now | same geometry; GCP grid is a native array |
| MPC `sentinel-1-rtc` | ✓ (UTM affine) | ✗ SAS token **+ throttles hard (504s)** | ✓ | we wired it, it throttled exactly as Stephen warned |
| DE Africa `s1_rtc` (`deafrica-sentinel-1`) | ✓ (4326 affine) | ✗ **bucket has no CORS** (STAC does) | Africa only | perfect data, browser-blocked |
| ASF OPERA RTC | ✓ | ✗ Earthdata auth | ✓ | needs a backend/proxy |

The pattern: **renderable S1 (RTC) is always gated; open S1 (raw GRD) is always
GCP ground-range.** deck.gl-geotiff only handles affine grids today; GCP support
is a written-down *future* note (`packages/deck.gl-raster/.../tileset-interface.ts`:
"allows non-affine transforms (e.g. GCPs) in the future"). No browser library
anywhere does GCP warping — confirmed via GitHub search. Everyone terrain-corrects
server-side first.

So we build the missing client-side piece. It is bounded and lightweight because
the heavy part (DEM terrain correction) is the part we **skip** — exactly like the
canonical EOPF notebook, which states its geocoding "does not involve terrain
correction." Skipping it keeps the layover/foreshortening, i.e. the dramatic look.

## The architecture (client-side, ultralight)

The EOPF S1 GRD notebook recipe, ported to the browser:

```
notebook                          browser (this app)
--------                          ------------------
open store / measurements/grd  →  STAC query → amplitude COG over HTTP range
conditions/gcp (coarse grid)   →  read 210-pt GCP grid (21×10) from COG header
gcp.interp_like(grd)           →  bilinear interpolator: pixel → (lon,lat)  [a FUNCTION, not an array]
plot x=lon y=lat               →  RasterReprojector builds adaptive TIN mesh from that function
10*log10                       →  GPU dB shader drapes amplitude on the mesh
```

Verified facts that make this concrete (probed 2026-06-09):
- Raw VV COG `sentinel-s1-l1c/.../iw-vv.tiff`: 26117×16885 px, **uint16 amplitude**,
  nodata 0, **overviews present**, bucket **CORS-open** (`ACAO:*`, anonymous 206,
  not requester-pays).
- It carries a **210-point GCP grid (21 distinct columns × 10 rows)**, each
  `pixel,line → lon,lat` in WGS84. That is the entire geolocation payload: ~210
  floats per scene. Tiny.
- `@developmentseed/raster-reproject` (already a dep of deck.gl-raster) is a
  standalone mesh reprojector taking arbitrary `ReprojectionFns` and refining a
  delatin TIN — it does NOT need per-pixel lat/lon, only the function. This is why
  it stays light.

Why it's lightweight: we never materialize per-pixel lat/lon. The mesh refines
only where the warp bends (a smooth ~21×10 grid → a coarse mesh). Amplitude tiles
stream from overviews as usual. One extra small read per scene for the GCPs.

## Net-new work (sequenced; de-risk cheap first)

**A. Read all GCPs from the GeoTIFF.** `@developmentseed/geotiff` fetches the
ModelTiePoint tag but `transform.ts` uses only the first point (`[3],[4]`). The
other 209 tiepoints are in the same tag (6 doubles each: i,j,k,x,y,z), plus the
GDAL `_GDAL_GCPs`/GCP tag in some files. Parse them into a list of
`{pixel,line,lon,lat}`. *Do this against the verified VV COG and check the count
is 210 and GCP[0] ≈ (pixel0,line0)→(-72.3686,-33.7071), matching gdalinfo.*

**B. GCP→lon/lat interpolator.** ~30 lines. The tiepoints form a regular 21×10
grid in pixel space; bilinear within each grid cell. Expose
`forward(px,py) → [lon,lat]` and an approximate `inverse([lon,lat]) → [px,py]`
(invert per-cell, or Newton from the forward). **Validate B standalone** (no
deck.gl) by sampling a few pixels and comparing to gdalinfo GCP values. Ship A+B
behind a tiny test before touching the tileset.

**C. Non-affine `RasterTileset` descriptor.** Implement `tileset-interface.ts`
(`projectTo3857`, `projectTo4326`, `inverse4326ToSource`, per-tile
`tileTransform → {forwardTransform, inverseTransform}`) from B. Source CRS is
EPSG:4326 (GCP lon/lat); `projectTo3857` is the standard 4326→3857. Feed the
existing `raster-tile-layer` + `raster-reproject` mesh path. This is the piece
deck.gl-raster flagged as "future" — net-new, but it slots into an interface that
already exists and is consumed by the affine tileset alongside it (copy
`affine-tileset.ts` as the structural template).

**D. Wire a layer + the dB pipeline.** A COG layer (or a thin custom layer) that
builds the GCP tileset from A+B and renders amplitude through the dB shader we
already have. The shader pipeline rides on top unchanged.

## What already exists (reuse, don't rebuild)

- **dB shader** (`web/src/shaders/amplitude.ts`) + **gamma** (`shaders/gamma.ts`)
  + the monochrome pipeline (`renderPipeline.ts`). *Note:* these are currently
  tuned for **RTC float32 power** (`10*log10(power)`, discard ≤0) from the MPC
  detour. For **raw GRD uint16 amplitude**, switch back to `20*log10(DN/65535)`
  and nodata 0 (the earlier form, in git history).
- **App shell** (`web/src/App.tsx`): map, PlaceSearch, draw-AOI, FETCH VIEW, load
  scoreboard, **dual-thumb dB slider**, gamma, dramatic preset, VV/VH toggle,
  prefs. All reusable.
- **STAC client** (`web/src/stac.ts`): currently points at **MPC RTC** (with SAS
  token + retry/backoff) from the detour. Repoint to Earth Search
  `sentinel-1-grd` (raw COG, `s3://sentinel-s1-l1c` → https rewrite) — that code
  existed one commit ago; see git history. Keep the IW filter and VV/VH shape.
- **Screenshot harness** `web/shot.mjs` (Brave headless) for verifying renders.

## Current working-tree state (important)

The tree is mid-detour: `stac.ts` + the shader + prefs + App defaults were wired
to **MPC RTC** to prove the render path end-to-end (it DID render the UI and
stream tiles; MPC just throttled the tile reads with 504s, blanking the map).
That detour confirmed the dB pipeline + reprojection + UI all work against an
affine source. The GCP build (A–D) replaces the *source + geometry*, not the
shader/UI. Decide whether to keep the MPC path behind a fallback toggle or strip
it; Stephen leans toward the real thing.

## Data source

- **Primary:** raw GRD COGs, Earth Search `sentinel-1-grd` → `sentinel-s1-l1c`
  bucket (CORS-verified). uint16 amplitude, 210-pt GCP grid, overviews.
- **Alternate (equally valid):** EOPF S1 GRD Zarr on `objects.eodc.eu` — GCP grid
  is a native `conditions/gcp` array (cleaner to read than COG tags). **Confirm
  CORS on `objects.eodc.eu` before relying on it.** Read via `@developmentseed/
  deck.gl-zarr` + `zarrita`.

## Risks / unknowns

- **Inverse transform.** `tileTransform` wants forward AND inverse. Forward
  (pixel→lonlat) is easy; inverse (lonlat→pixel) needs per-cell inversion or a
  Newton step. The mesh path may only need forward + a bounds query — check what
  `affine-tileset.ts` actually calls before over-building the inverse.
- **Antimeridian / pole-crossing scenes** — ignore for v1 (mid-latitude demo
  AOIs: Andes, Himalaya, Namib, Atacama).
- **No terrain correction** → horizontal misregistration in extreme relief
  (layover). Acceptable / desirable for the look; note it in the UI.
- **GCP tag variants.** Some COGs store GCPs as many ModelTiepoints, some as a
  dedicated GDAL tag. Handle the ModelTiepoint-list case first (the verified file).

## First milestone

A+B shipped and validated against gdalinfo numbers (no deck.gl), then C+D rendering
**one** raw GRD scene over the Andes, warped, in monochrome dB. Prove the warp
visually against a known coastline/relief before scaling to a mosaic.

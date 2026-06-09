# Plan — Sentinel-1 Amplitude Explorer

Decisions (locked with Stephen 2026-06-09): **Path A** (Earth Search
`sentinel-1-grd` COGs) first, EOPF GeoZarr as a later track. **Grayscale**
default look, with a **dramatic dark/high-contrast preset** held in reserve.
Product **IW GRD**, **VV** default / **VH** toggle, **dB** display, **no
elevation**. Background and trade-offs in `docs/RESEARCH.md`.

## Phase 0 — Source verified (DONE)

Live probe of Earth Search `sentinel-1-grd` (Andes scene
`S1A_IW_GRDH_1SDV_20240228T232840...`):

| property | value | implication |
|---|---|---|
| asset hrefs | `s3://sentinel-s1-l1c/.../measurement/iw-vv.tiff` | must rewrite `s3://` → `https://sentinel-s1-l1c.s3.eu-central-1.amazonaws.com/<key>` |
| CORS | `Access-Control-Allow-Origin: *`, `GET` | browser range reads allowed |
| range read | anonymous `206 Partial Content`, `Accept-Ranges: bytes` | no auth, **not** requester-pays (no `x-amz-request-charged`) |
| `proj:epsg` | **4326** (geographic) | global reproject 4326→3857, NOT per-scene UTM |
| assets | `vv`, `vh` (COG), plus schema/manifest XML | render `vv`/`vh` only |
| `raster:bands` | `data_type: uint16`, `nodata: 0` | single-band amplitude; discard 0 as nodata |
| file size | ~676 MB per VV COG | overview-driven; cost is visible-scene count |
| `sar:instrument_mode` | `IW`, `sar:polarizations` `[VV, VH]` | filter to IW |

No blockers. Path A is viable as a direct fork.

## Phase 1 — STAC client swap (`web/src/stac.ts`)

Replace the Earth Genome S2 client with a `sentinel-1-grd` client, using
`earthSearchStac.ts.ref` as the POST-query template.

- Endpoint `https://earth-search.aws.element84.com/v1/search`, collection
  `sentinel-1-grd`. POST bbox + datetime, `limit: 100`, paginate `rel=next`.
- Filter `properties.sar:instrument_mode == "IW"`.
- Project each feature to `{ id, bbox, assets: { vv, vh } }`.
- **s3→https rewrite** helper: `s3://sentinel-s1-l1c/KEY` →
  `https://sentinel-s1-l1c.s3.eu-central-1.amazonaws.com/KEY`.
- Drop the `CORS_OK_HOSTS` S2 logic (single known-open host now) but keep a
  host guard.
- Carry orbit direction / relative orbit in props if cheap (useful later for
  consistent look-direction shading).

## Phase 2 — Render pipeline (the core work)

Single-band amplitude, so this is *simpler* than S2 multiband, but needs two new
pieces: a dB shader and a 4326→3857 reproject.

- **New shader `web/src/shaders/decibel.ts`** — `AmplitudeToDb`: from uint16 DN
  `x` (sampler returns `x/65535`), compute intensity and `10*log10`. For a
  visual look, `dB = 20*log10(DN)` (amplitude→intensity is the square) is fine;
  precise sigma0 calibration via the calibration LUT is out of scope for v1
  (note it as a future radiometric-accuracy task).
- **Pipeline** (replaces NDVI chain in `renderPipeline.ts`):
  `discardNodata(0)` → `AmplitudeToDb` → `LinearRescale(dbMin, dbMax)` →
  grayscale (identity colormap) or `Colormap`. Default stretch ~ `[-25, 0]` dB
  for VV land; expose via the existing dual-thumb slider.
- **Reprojection 4326→3857.** Wire `@developmentseed/proj` so COGLayer/MosaicLayer
  reproject geographic tiles to web mercator. Single global transform (not the
  per-scene UTM the S2 app avoided). Confirm whether deck.gl-geotiff handles 4326
  COGs natively at this version before adding the proj dep path.
- Reuse `MosaicLayer` → one `COGLayer` per scene on the selected-pol asset
  (single-band, so no MultiCOGLayer composite needed for grayscale).

## Phase 3 — UI rework (`web/src/App.tsx`)

- **Strip** the S2 index machinery: remove `INDICES`/NDVI/NDWI modes, the
  spectral panel, multi-band composite wiring, `shaders/ndvi.ts`,
  `discardBlack`'s S2-specific paths.
- **Modes** become: polarization `VV` / `VH` (and later `VV/VH ratio`).
- **Keep**: map shell, PlaceSearch, draw-AOI, load scoreboard, the **dual-thumb
  slider** (now drives dB min/max), prefs/localStorage, keyboard shortcuts.
- **Look controls**: grayscale default; a **"dramatic" contrast preset**
  (gamma + tighter stretch toward inky shadows / bright foreslopes); keep the
  inherited colormaps available but off by default.
- Retitle panel/app to Sentinel-1 amplitude; update copy.

## Phase 4 — STAC explorer (Stephen flagged this needs work)

Because S1 loads are deliberate (no dense load-anywhere, and the EOPF track is
sample-only), the discovery UI carries weight:

- Date-range + AOI search returning scene candidates with footprints, acquisition
  date, orbit direction, polarizations available.
- Step-by-date / browse-overpasses preview (adapt `groupByDate` /
  coverage-selection ideas from `earthSearchStac.ts.ref`).
- Show look-direction / orbit so the user can pick consistent relief shading.
- Manual fetch (no auto-load on pan), matching the sibling apps' deliberate model.

## Phase 5 — Polish + deploy

- Tune the dramatic preset on real mountain (Andes/Himalaya/Alaska Range) and
  desert (Namib/Atacama/Sahara) scenes.
- README hero from a rendered frame.
- GitHub Pages deploy already wired (`base: /s1-amplitude-explorer/`).

## Track 2 (later) — EOPF GeoZarr via deck.gl-raster `ZarrLayer`

Once Path A is solid: add an EOPF GeoZarr source as a second mode. No SAR
amplitude `ZarrLayer` example exists upstream yet, so budget for spiking the
GeoZarr S1 structure (consult EOPF Webinar 8 + deck.gl-raster GeoZarr docs).
Sample-only coverage means the Phase 4 explorer must surface what EOPF actually
has. This is where the ESA/DevSeed Zarr alignment with your event contacts pays
off.

## Suggested first PR

Phases 1+2 minimal: swap STAC to `sentinel-1-grd`, s3→https rewrite, single VV
COGLayer, dB shader + grayscale stretch, 4326 reproject. Get one dramatic Andes
scene on screen. Everything else (VH toggle, explorer, presets) layers on after.

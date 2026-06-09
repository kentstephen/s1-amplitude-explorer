# s1-amplitude-explorer

Browser-side rendering of **Sentinel-1 SAR amplitude** as dramatic monochrome
imagery over mountains and deserts, on the Development Seed `deck.gl-raster`
client-side COG/Zarr GPU pipeline. No tile server, no derived data, no hosting.

Forked from `sentinel-2-cog-deckgl-raster` (two-way-slider COG/STAC app) with
the S2 spectral pipeline and ALL elevation/terrain code removed. Sibling project
`deckgl-raster-mapterhorn-s2` holds the terrain + Earth Search work we did NOT
carry over.

## Intent

- Product: **Sentinel-1 IW GRD** (NOT RTC, which flattens the relief shading that
  makes mountains dramatic; NOT SLC, which is complex InSAR data).
- Polarization: **VV** default, VH toggle.
- Display: amplitude/intensity then **dB (`10*log10`)** then `LinearRescale` then
  grayscale/`Colormap`. The dB shader is the centerpiece, replacing S2's NDVI
  `NormalizedDifference`.
- **No elevation.** 2D amplitude only.
- Data: primary = Earth Search `sentinel-1-grd` COGs (AWS public). Second track =
  EOPF GeoZarr via deck.gl-raster `ZarrLayer`. See `docs/RESEARCH.md`.
- The STAC explorer UI matters more than in the S2 app because the S1 coverage we
  care about (EOPF samples especially) is deliberate, not load-anywhere.

## Where things are

- `web/src/App.tsx` — map shell, state, layer wiring (still S2 until rewired).
- `web/src/stac.ts` — runtime STAC client (S2 source; adapt for `sentinel-1-grd`).
- `web/src/earthSearchStac.ts.ref` — S2 Earth Search POST client, the reference
  shape for the S1 GRD query.
- `web/src/renderPipeline.ts` — shader pipeline registry (NDVI today; dB next).
- `web/src/shaders/` — GPU modules.
- `docs/RESEARCH.md` — feasibility + data-source findings (read this first).
- `docs/reference-s2-inherited/` — inherited S2 design docs (seams, perf, etc.).

## Known footguns to confirm before building (from RESEARCH.md)

- S1 GRD COGs are often **per-scene UTM**, not EPSG:3857, so likely need
  `@developmentseed/proj` reprojection (the S2 app dodged this; the CDL
  predecessor did reproject, pattern in its git history).
- Verify **CORS** on the GRD COG bucket for browser range reads before
  committing to path A.
- GRD pixel dtype (uint16 amplitude vs float intensity) drives the dB scale.

## Tone & conduct

Inherits `~/CLAUDE.md`. No flattery, no unsolicited critique, no "you're
absolutely right." Peer-level. **No em dashes.** Memories go in
`.claude/memory/MEMORY.md` in THIS workspace (gitignored), never the auto path.

# Memory — s1-amplitude-explorer

## What this is
Browser-side Sentinel-1 SAR **amplitude** as dramatic monochrome over mountains/
deserts, on deck.gl-raster, no backend. Forked from `sentinel-2-cog-deckgl-raster`,
elevation dropped. **Read `docs/PLAN.md` first** — it's the committed direction and
the next-agent handoff.

## COMMITTED DIRECTION (2026-06-09)
Build a **client-side GCP warp of raw Sentinel-1 GRD amplitude** from open object
storage. No backend, no DEM, no tile server. This is the no-compromise path Stephen
insisted on after every off-the-shelf source failed. Details + sequencing (work
A→B→C→D) are in `docs/PLAN.md`.

## The core finding (why this is the path)
- Raw S1 GRD (open, CORS, global) is **ground-range with GCPs, no affine grid** →
  deck.gl-geotiff can't place it (throws "does not have an affine transformation").
- Renderable S1 (RTC, affine) is always **gated**: MPC = SAS token + hard throttle
  (504s); DE Africa bucket = no CORS; ASF/OPERA = Earthdata auth.
- deck.gl-raster marks GCP support as a *future* note; no browser lib does GCP
  warping (confirmed via GitHub search). Everyone terrain-corrects server-side.
- Solution = port the EOPF notebook recipe: read the coarse GCP geolocation grid,
  build pixel→lon/lat interpolator, feed `@developmentseed/raster-reproject`'s
  adaptive TIN mesh (it takes a function, not per-pixel arrays → stays light).
  Skip terrain correction (like the notebook) → keeps the dramatic relief.

## Verified facts (probed live)
- `sentinel-s1-l1c` bucket: CORS-open (`ACAO:*`), anonymous **206**, NOT
  requester-pays. Raw VV COG = **uint16 amplitude**, nodata 0, overviews present.
- That COG carries a **210-point GCP grid (21×10)**, pixel/line→lon/lat WGS84.
  GCP[0]: pixel0,line0 → (-72.3686,-33.7071). ~210 floats/scene = tiny.
- `@developmentseed/geotiff` reads the ModelTiePoint tag but `transform.ts` uses
  only the FIRST point — the other 209 are right there to parse (work item A).
- `raster-reproject` (dep of deck.gl-raster) = standalone delatin mesh reprojector,
  takes arbitrary `ReprojectionFns`. The engine we drive with the GCP interpolator.
- deck.gl-raster latest = 0.8.0-beta.2; `deck.gl-zarr` 0.7.0 / 0.8.0-beta.2 on npm.

## Dead ends (do NOT re-walk — see PLAN.md table)
- Earth Search `sentinel-1-grd` COG: GCP, won't render via affine path.
- MPC `sentinel-1-rtc`: renders (UTM affine) but SAS + throttles to 504 (Stephen
  vetoed MS; it proved his point). We DID wire it — current tree is on this.
- DE Africa `s1_rtc`: perfect projected data, but bucket has no CORS (STAC does).
- EOPF S1 GRD Zarr (`objects.eodc.eu`): also ground-range/GCP (native `conditions/gcp`
  array). **CONFIRMED NO CORS (2026-06-09)** on objects.eodc.eu — every bucket
  (`notebook-data`, `202606-s01siwgrh-global`): 200 GET carries NO `access-control-
  allow-origin`, OPTIONS preflight 403s. Browser-blocked = DE Africa wall. The STAC
  API (`stac.core.eopf.eodc.eu`, collection `sentinel-1-l1-grd`) IS CORS-open but its
  asset hrefs point back at no-CORS objects.eodc.eu. EOPF explorer renders via
  server-side TiTiler, not client-side chunk streaming, so there is NO no-backend
  Zarr route. Store is Zarr v2 w/ consolidated `.zmetadata` (one fetch = all meta);
  measurements at `<scene>/measurements`, GCPs at `conditions/gcp` (lat/long vars).
  Coverage now `...-global...` (cpm_v270), broader than old samples. Stephen's call
  2026-06-09: drop Zarr, build COG GCP-warp. Reopen only if a CORS proxy/EODC fix lands.

## Current code state (mid-detour, reconcile per PLAN.md)
- `stac.ts` → MPC RTC + container SAS token + retry/backoff. Repoint to raw GRD
  (`sentinel-s1-l1c`, s3→https) — that code was here one commit before the RTC swap.
- `shaders/amplitude.ts` → tuned for RTC float32 power (`10*log10`). For raw GRD
  uint16 switch back to `20*log10(DN/65535)`, nodata 0 (earlier form in git log).
- `App.tsx` defaults: tight Andes AOI, zoom 10, maxItems 12, maxRequests 6 (all
  throttle mitigations for MPC). prefs key bumped to v2.
- UI/shell/dB-slider/gamma/dramatic-preset/VV-VH = reusable as-is.
- `web/shot.mjs` = Brave headless screenshot harness (verified renders work).

## Ops notes
- Repo: github.com/kentstephen/s1-amplitude-explorer (public).
- Removed the inherited GH Pages deploy workflow — it auto-ran on push and FAILED
  (Pages not enabled), emailing Stephen twice. Re-add + enable Pages only when
  there's something worth deploying.
- gh auth = kentstephen.

## Conduct
Inherits `~/CLAUDE.md`. No flattery, no "you're absolutely right," no em dashes.
Peer-level. Don't compromise the source to get a quick render — Stephen will stop
you. Memory stays in THIS workspace `.claude/memory/`, gitignored.

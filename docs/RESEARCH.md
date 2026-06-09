# Research: Sentinel-1 amplitude for dramatic monochrome scenery

Notes gathered 2026-06-09 to answer two questions before we build:

1. Can Sentinel-1 amplitude give the dramatic monochrome "look" we want over
   mountain ranges and deserts, or is ICEYE-class resolution required?
2. Where do the COGs (or Zarr) live, and which access path forks cleanest off
   the existing `sentinel-2-cog-deckgl-raster` deck.gl-raster app?

## 1. Feasibility: the look

**Resolution reality check.** Sentinel-1 IW GRD is multi-looked to ~20 x 22 m,
resampled to 10 m pixel spacing. ICEYE Spotlight is sub-1 m (down to 25 cm
azimuth). So S1 is roughly **20x coarser** than the ICEYE open-data scenes.
If the goal were crisp building/vehicle/infrastructure detail, S1 cannot match
that look. It is not the same instrument class.

**But that is the wrong comparison for wide terrain.** For mountain ranges and
deserts at regional scale, the thing that makes SAR amplitude dramatic is not
fine resolution, it is the **side-looking geometry**: radar lights one slope
face bright (foreslope, near-perpendicular to the look direction) and throws the
opposite face into radar shadow, with layover on steep terrain. That produces a
strong, almost hand-shaded relief look across a whole range in one monochrome
frame. At 10 m spacing over a 250 km swath, S1 is genuinely well-suited to the
"dramatic wide-area scenery" goal. Deserts read as texture: dune fields, lava
flows, alluvial fans, and sabkha/playa surfaces separate by roughness
(rough = bright, smooth specular = near-black).

**Conclusion.** S1 will not give the ICEYE close-up "look," but for the stated
goal (wide mountain/desert scenery, dramatic monochrome, coverage over crispness)
it is arguably the *better* fit, because the wide swath + relief shading is the
whole point. Feasible. Worth doing.

### Footgun that directly affects the look: GRD vs RTC

There are two amplitude product families in object storage, and they look
**very different**:

- **GRD (Ground Range Detected)** keeps the radar relief shading: bright
  foreslopes, dark radar shadows, layover. This is the dramatic look we want.
  Geocoded to a map grid but **not** radiometrically terrain-flattened.
- **RTC (Radiometrically Terrain Corrected)** deliberately *removes* the
  terrain-induced brightness variation so backscatter is comparable slope to
  slope. Great for analysis, **flat and undramatic** for our purpose. The
  mountains stop popping.

So for this project we want **GRD, not RTC**, even though RTC is the "nicer"
analysis product. Note this loudly in the build.

### Polarization

- **VV** (co-pol) is the standard land choice and gives the cleanest terrain /
  surface-roughness look. Default to VV for mountains and deserts.
- **VH** (cross-pol) responds to volume scattering (vegetation, some rough
  surfaces); darker, different texture. Useful as a toggle.
- A **VV / VH / VV-VH** false-color or ratio is a nice optional mode later, but
  the monochrome VV amplitude is the headline.

### Display transform (the real centerpiece)

GRD pixel values are linear amplitude/intensity with a huge dynamic range. The
classic SAR display step is **dB: `10 * log10(intensity)`**, then a linear
stretch (typ. around -25 dB .. 0 dB for VV land), then grayscale or a colormap.
A dB-stretch shader is the single most important addition over the S2 pipeline,
and it maps cleanly onto the existing `LinearRescale` + `Colormap` chain (just
add a `dB` module in front, replacing the NDVI `NormalizedDifference`).

## 2. Where the data lives (access paths)

Three realistic sources, in rough order of fork-friendliness:

### A. Earth Search (Element 84) `sentinel-1-grd` — COGs, AWS public

- STAC API: `https://earth-search.aws.element84.com/v1/`, collection
  `sentinel-1-grd`. The full global GRD archive converted to COG.
- Bucket: `e84-earth-search-sentinel-data` (AWS Registry of Open Data, public).
- **This is the cleanest fork.** It is the same shape as the existing app's
  Earth Search S2 path (`web/src/earthSearchStac.ts.ref` is the S2 version of
  exactly this query) — POST a bbox + datetime, get back per-scene COG asset
  hrefs, hand them to `MosaicLayer`/`COGLayer`. Amplitude is single-band, so the
  render is simpler than S2 multiband.
- **To verify before committing (build step 0):** (1) CORS on the COG bucket for
  browser range reads; (2) the COG CRS — S1 GRD COGs are commonly per-scene UTM,
  which would need `@developmentseed/proj` reprojection (the S2 app avoided this
  by being EPSG:3857-native; the CDL predecessor *did* reproject, so the pattern
  exists in git history); (3) asset keys / pixel dtype (uint16 amplitude vs
  float intensity) so the dB shader scales correctly.

### B. Microsoft Planetary Computer `sentinel-1-rtc` — COGs, Azure

- COGs in Azure Blob, STAC API, well-documented.
- **Two strikes for our purpose:** it is **RTC** (terrain-flattened = flat look,
  see above) and it requires **SAS-token signing** with ~1 hr expiry (the exact
  credentialing dance the S2 app deliberately *dropped* when it left the CDL/MPC
  scaffold). There is also a `sentinel-1-grd` collection on MPC. Higher friction,
  worse default look. Fallback only.

### C. EOPF Sentinel Zarr Explorer — GeoZarr, TiTiler

- `https://explorer.eopf.copernicus.eu/` (the link you sent). This is the ESA
  EOPF "Sentinel into Zarr" effort — almost certainly the work your event
  contacts are on. Built by Development Seed.
- Serves **Sentinel-1 IW GRD and SLC** in EOPF/GeoZarr, rendered dynamically via
  a **TiTiler** web API (server-side dynamic tiling), with **OpenLayers** + a
  GeoZarr source on the front end — **not** deck.gl / deck.gl-raster.
- Two ways we could use it:
  - **API-tolerant path:** consume their TiTiler tile endpoints as a raster
    basemap source. Low effort, but then it is server-rendered tiles, which
    abandons the client-side deck.gl-raster GPU pipeline that is the whole point
    of this lineage.
  - **deck.gl-raster `ZarrLayer` path:** deck.gl-raster now ships a `ZarrLayer`
    that streams GeoZarr chunks client-side and animates over dimensions (the
    published examples are temperature forecast + Google AlphaEarth embeddings —
    **no SAR amplitude example yet**). This is the most "on-trend" and matches
    "deck.gl-raster has plenty of zarr support," but S1 GeoZarr + a SAR amplitude
    `ZarrLayer` pipeline is **bleeding edge** and the EOPF sample coverage is a
    curated sample set, not the full archive. Highest novelty, highest risk.
- **Important coverage note:** because EOPF is a deliberate **sample** service
  right now, there is no "load anywhere" — which is exactly why you said the STAC
  explorer needs to be good. The explorer UI carries more weight here than in the
  S2 app, where coverage was dense.

## Recommendation (for discussion, not yet committed)

- **Get pixels on screen fast via path A** (Earth Search `sentinel-1-grd` COGs):
  it is a near-mechanical fork of the existing app, preserves the dramatic GRD
  relief look, has full global coverage, and reuses the deck.gl-raster COG
  pipeline. The only new shader is dB-stretch; the only new risk is per-scene
  UTM reprojection.
- **Treat path C (EOPF GeoZarr + `ZarrLayer`) as the ambitious second track** —
  it is the most aligned with where ESA/DevSeed are heading and with your event
  contacts, but it is early and sample-limited. Good as a second mode or a
  follow-on once the COG path is solid and the STAC explorer is rebuilt.
- **Skip path B (MPC RTC)** unless A's CORS/reprojection turns out to be a wall —
  RTC's flat look is wrong for this and the SAS dance is friction we already shed.
- **Product = IW GRD, polarization = VV default (VH toggle), display = dB stretch
  → grayscale/colormap, no elevation.**

## Sources

- [Sentinel-1 SLC vs GRD (Copernicus docs)](https://documentation.dataspace.copernicus.eu/Data/SentinelMissions/Sentinel1.html)
- [Sentinel-1 product overview (Terrascope)](https://docs.terrascope.be/DataProducts/Sentinel-1/ProductsOverview.html)
- [EOPF Sentinel Zarr Explorer](https://explorer.eopf.copernicus.eu/) · [DevSeed launch writeup](https://developmentseed.org/blog/2026-02-13-eopf-explorer-launch/) · [Webinar 8: S1 SLC & GRD in EOPF Zarr](https://zarr.eopf.copernicus.eu/webinars/webinar-8-access-and-process-sentinel-1-slc-and-grd-in-eopf-zarr/)
- [deck.gl-raster (GitHub)](https://github.com/developmentseed/deck.gl-raster) · [Initial GeoZarr support](https://developmentseed.org/deck.gl-raster/blog/initial-geozarr/)
- [Earth Search by Element 84](https://element84.com/earth-search/) · [Earth Search v1 datasets (incl. Sentinel-1 GRD COG)](https://element84.com/geospatial/introducing-earth-search-v1-new-datasets-now-available/)
- [MPC Sentinel-1 RTC](https://planetarycomputer.microsoft.com/dataset/sentinel-1-rtc)
- [ICEYE sub-1 m SAR (resolution reference)](https://www.iceye.com/newsroom/press-releases/iceye-releases-first-under-1-meter-resolution-spotlight-radar-imagery-from-small-sar) · [ICEYE constellation, eoPortal](https://www.eoportal.org/satellite-missions/iceye-constellation)

# Roadmap / TODO

## Done

- **Spectral-index suite + panel redesign (2026-05-20, session 3).** Curated
  normalized-difference indices (NDVI/NDWI/NDBI/NDMI) via one shared
  `NormalizedDifference` shader + `INDICES` registry; divergent colormaps
  (rdylgn/rdbu/spectral) and a reverse toggle; editable slider values and a
  live colormap reference bar. CI moved pnpm→npm. Live load scoreboard
  (`loadStats.ts`) replacing the dead `stats` local. Lightweight draw-AOI
  box-select + debounced STAC refetch. Search clear (×). Panel restyled as a
  sectioned "instrument" surface (AREA / RENDER card / DIAGNOSTICS / footer),
  IBM Plex Mono, teal accent. Footer credits split so the GitHub repo link
  (yours) reads separately from the "built with deck.gl-raster by Development
  Seed" provenance. Keyboard shortcuts (`/ M L D Esc`) with the marker as
  transient context (auto-hide on user pan/zoom, `M` to summon). Customization
  guide at `docs/CUSTOMIZE.md`; index-catalog roadmap at
  `docs/SPECTRAL_INDICES.md`.


- **RGB seams fixed (2026-05-20).** RGB renders the single TCI COG per item via
  `COGLayer` (naip-mosaic pattern); see `docs/SEAMS.md` → "RESOLVED". The
  BitmapLayer overview mode + zoom-gate were dropped (looked worse, still
  seamed). Brightness is now a uniform `ScaleColor` gain on the TCI texture.
- **Place search + marker (2026-05-20).** OSM geocoding via **Photon**
  (`src/geocode.ts`, `src/PlaceSearch.tsx`) — no LLM. Debounced autocomplete
  (350ms, ≥3 chars), arrow-key nav, Enter/Escape/blur to dismiss. On select it
  flies the map (`fitBounds`), sets the bbox state (drives the STAC refetch),
  and drops a hideable marker. `resultToBbox` always applies a margin + a point
  floor and clamps the span (`maxSpanDeg=3.0`) so a huge extent doesn't fan out
  into thousands of COGs — tune `maxSpanDeg`/`minHalfDeg` in `geocode.ts`.
- **Coverage messaging (2026-05-20).** `fetchStacItems` reports how many items
  were dropped for being on the CORS-blocked host; the panel says "No CORS-open
  imagery here" when an AOI has none.
- **Slider double-click resets to default** (brightness/NDVI range/darken).

  Footgun: keep panel subcomponents in their own files — an in-`App.tsx`
  forward reference across the `InfoPanel` boundary tripped react-refresh's
  "X is not defined" on every HMR update (false crash; needs hard reload).

## TODO: fuzzy/relative queries (optional LLM front-end)

The Photon geocoder handles plain place names. An LLM would only earn its place
as a *front-end* for fuzzy/relative queries it can't parse ("the soy frontier",
"+200 km buffer") — have it normalize to `{place, bufferKm}`, then hand the
place to Photon. Don't trust an LLM for raw coordinates. Low priority.

### "Load >=100 tiles at a time"

The current eager-load path melts past ~1000 items and grinds in the hundreds
(see `docs/SEAMS.md` connection-pool note, `docs/PERF_KNOBS.md`). The main
enabler for big-AOI loads:

- **Viewport-driven STAC fetch.** Stop enumerating the whole bbox up front;
  query items near the view on `moveend` (debounced) and diff the source list.
  Long-standing TODO (noted in CLAUDE.md). The COGLayer/MosaicLayer path already
  only streams tiles for visible items, so this caps how many sources are open
  at once.

### "Clip" button for spectral index range

Today the index range slider only *rescales* the colormap — values outside
`[lo, hi]` clamp to the ramp ends and still paint. A clip toggle would instead
**discard** out-of-range pixels (let the basemap show through), turning the
range into a true mask rather than a stretch. Likely a small shader change:
`discard` when the normalized-difference value falls outside the rescale window,
alongside the existing `discardBoundlessPadding`. Not started.

### Layering two indices (NDVI + NDWI)

Showing vegetation and water together in one view. Both indices are all-10 m and
share B08, so the data side is cheap; the open question is how to combine two
scalar fields into color (channel-split bivariate, masked overlay, 2D colormap,
or thematic classify). Directions + trade-offs written up in
[`docs/INDEX_LAYERING.md`](./INDEX_LAYERING.md). Not started.

### Suggested build order

1. Geocoder text box + toggleable marker.
2. LLM front-end for fuzzy queries (optional, last).
3. Viewport-driven STAC fetch for true large-area roaming.

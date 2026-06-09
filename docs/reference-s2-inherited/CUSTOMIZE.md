# Customizing the app

Everything here is a small, local edit — no build step beyond `npm run dev`.
File paths are relative to `web/`.

## Where things live

| What | File | Symbol |
|------|------|--------|
| Map start view, AOI, years | `src/App.tsx` | `initialViewState`, `STAC_BBOX`, `AVAILABLE_YEARS`, `DEFAULT_YEAR` |
| Spectral indices | `src/renderPipeline.ts` | `INDICES`, `INDEX_COLORMAPS` |
| Index math (shader) | `src/shaders/ndvi.ts` | `NormalizedDifference` |
| Required bands / CORS hosts | `src/stac.ts` | `REQUIRED_BANDS`, `CORS_OK_HOSTS` |
| Panel look (theme tokens) | `src/App.tsx` | `UI`, `eyebrowStyle`, `selectStyle` |
| Keyboard shortcuts | `src/App.tsx` | the `onKey` effect |
| Marker behavior | `src/App.tsx` | the `movestart` handler + `handleDrawBox`/`handlePickPlace` |
| Fonts | `index.html` | IBM Plex Mono `<link>` |
| Footer links | `src/App.tsx` | footer block in `InfoPanel` |

## Area of interest & year

```ts
// src/App.tsx
const AVAILABLE_YEARS = [2022, 2023, 2024] as const;  // CORS-open years only
const DEFAULT_YEAR = 2023;
const STAC_BBOX: [number, number, number, number] = [-115.5, 31.5, -113.0, 33.5]; // [W,S,E,N]
const initialViewState = { longitude: -114.6, latitude: 32.7, zoom: 9, ... };
```

`STAC_BBOX` bounds the items enumerated on first load; the search box and the
draw-AOI tool overwrite it at runtime. Keep the bbox modest — every MGRS tile in
it opens COGs (see `docs/PERF_KNOBS.md`).

## Add a spectral index

The curated indices are all normalized differences `(a − b) / (a + b)`, so they
share one shader. To add one (e.g. **GNDVI** = (B08 − B03)/(B08 + B03)):

1. Add a row to `INDICES` (`src/renderPipeline.ts`):
   ```ts
   gndvi: { label: "GNDVI", a: "B08", b: "B03", desc: "chlorophyll" },
   ```
   `a` packs into `color.r`, `b` into `color.g`; the shader does the ratio.
2. Make sure both bands are in `REQUIRED_BANDS` (`src/stac.ts`). Bands not
   listed there aren't fetched, and items missing a required band are skipped.

That's it — the dropdown, sliders, colormap, and reverse all pick it up.

> ⚠️ **Stick to same-resolution bands.** Earth Genome publishes each band at its
> native resolution: **B02/B03/B04/B08 are 10 m, B05–B07/B8A/B11/B12 are 20 m,
> B01/B09 are 60 m.** A normalized-difference index that mixes resolutions (e.g.
> NDBI/NDMI, which use 20 m **B11** with a 10 m band) paints hard ±1 seams where
> the two grids' nodata footprints disagree — this is exactly why NDBI/NDMI were
> removed. Pair bands of equal resolution, or resample to a common grid first.

**Non-normalized-difference indices** (EVI, SAVI, BSI — need constants or >2
bands) need a dedicated shader: clone `src/shaders/ndvi.ts`, write the GLSL, and
branch to it in `buildRenderPipeline`. See `docs/SPECTRAL_INDICES.md` for the
formula-catalog approach.

## Colormaps

```ts
// src/renderPipeline.ts
export const INDEX_COLORMAPS = ["cividis","viridis","plasma","rdylgn","rdbu","spectral"] as const;
```

Any name from `COLORMAP_INDEX` (107 maps in the shipped `colormaps.png` sprite)
works — sequential and divergent. The in-panel **reverse** toggle flips
direction at render time via the `Colormap.reversed` uniform (no extra map
needed). A symmetric range (e.g. `[-1, 1]`) centers a divergent ramp at 0.

To see the full list: `node -e` print of `colormap-names.js` in
`node_modules/@developmentseed/deck.gl-raster/dist/gpu-modules/`.

## Theme / look

The panel's instrument aesthetic is driven by the `UI` token object in
`src/App.tsx`:

```ts
const UI = {
  accent: "#7dd3c0",      // active toggles, links, slider thumbs
  accentDim: "rgba(125,211,192,0.16)",
  mono: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
  // text / mute / faint / hairline / field / fieldBorder ...
};
```

Change `accent` to re-skin every active control at once. The font is loaded in
`index.html`; swap the Google Fonts `<link>` and update `UI.mono` to change it
(it degrades to `ui-monospace`/SF Mono if Fonts is blocked).

## Keyboard shortcuts

Defined in the `onKey` effect in `src/App.tsx`. Current set: `/` focus search,
`M` marker, `L` labels, `D` draw AOI, `Esc` cancel draw / clear / dismiss
marker. Letter keys are ignored while an input/select is focused; `Esc` always
fires. To add one, add a `case` to the `switch`:

```ts
case "r": onModeChange("rgb"); break;   // example: R → RGB
```

Keep the footer hint line in sync so it stays discoverable.

## Marker behavior

The marker is transient orientation context, not a persistent layer:

- Shown on search-pick (`handlePickPlace`) and draw-box (`handleDrawBox`).
- Auto-hidden on the first **user** map move — the `map.on("movestart", …)`
  handler checks `ev.originalEvent`, which is absent for our programmatic
  `flyTo`/`fitBounds`, so the fly-to-place animation doesn't dismiss it.
- `M` re-summons / hides it; `Esc` dismisses.

To make it sticky again, delete the `movestart` handler.

## CORS / data hosts

```ts
// src/stac.ts
const CORS_OK_HOSTS = new Set(["data.source.coop"]);
```

Only items whose COG host is in this set are kept (others 403 in-browser). If
Earth Genome opens CORS on the annual-mosaic bucket (`ei-imagery.s3.us-east-2`),
add it here to unlock 2018–2021.

## Footer links

In `InfoPanel`'s footer block (`src/App.tsx`): the GitHub "View source" link
points at your repo; the "Built with deck.gl-raster by Development Seed" line
credits the upstream libraries. Update the `href`s if you fork.

## Run & deploy

```bash
cd web && npm install && npm run dev   # http://localhost:5455/sentinel-2-cog-deckgl-raster/
```

Deploy is GitHub Actions → Pages (`.github/workflows/deploy-pages.yml`, npm).
The Vite `base` in `vite.config.ts` must match the repo name. **Repo setting:**
Settings → Pages → Source = "GitHub Actions" (otherwise the workflow runs but
nothing publishes).

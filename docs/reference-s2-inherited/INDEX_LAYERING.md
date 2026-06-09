# Layering two indices (NDVI + NDWI) for visualization

Design discussion only — **not implemented**. Captured from a working session
so the directions and trade-offs aren't lost. The app today renders exactly one
scalar field at a time (RGB, or a single normalized-difference index).

## Why it's cheap on the data side

- NDVI = `(B08 − B04) / (B08 + B04)`
- NDWI (McFeeters) = `(B03 − B08) / (B03 + B08)`

The two share **B08**, so showing both needs exactly **B03, B04, B08** — all
10 m, same grid. No 20 m SWIR seam (the thing that killed NDBI/NDMI), and
normalized differences cancel per-edge brightness, so the result stays
seam-free. The band cost over a single index is one extra COG (B08 is shared).

The current index path already loads per-band 10 m COGs through `MultiCOGLayer`
(slots `a`,`b`), packs them into color channels (`INDEX_COMPOSITE = {r:a, g:b}`),
runs one `NormalizedDifference` shader → `Colormap`. The open question is purely
**how to combine two scalar fields into color** — the directions below.

## Direction A — Stack two layers, mask the top

Reuse the existing single-index pipeline twice: NDVI mosaic as the opaque base,
NDWI mosaic on top with a *discard-below-threshold* shader so only water pixels
paint and vegetation shows through everywhere else.

- **Pro:** smallest conceptual change — two existing layers, one new discard
  module (`discardBoundlessPadding` is a template). Each keeps its own colormap.
- **Con:** double the COG fetches (two `MultiCOGLayer`s with overlapping bands;
  B08 fetched twice unless shared). Z-order / refinement timing between two
  mosaics can flicker during load.
- **Reads as:** "vegetation map with water painted in." Categorical-ish.

## Direction B — One shader, channel split (bivariate)

Single `MultiCOGLayer` with three slots (B03/B04/B08), a custom shader computing
both ratios, mapping **NDVI → green, NDWI → blue** (bare ground stays dark).

- **Pro:** one layer, one fetch set, B08 shared. NDVI/NDWI are largely
  anti-correlated (water: low NDVI / high NDWI; vegetation: the reverse), so the
  two channels separate naturally — you rarely get muddy "both high" pixels.
- **Con:** no per-index colormap dropdown — the mapping is fixed hue-coding. The
  current panel (one colormap + one range) doesn't express two fields, so it
  needs a different control set or fixed ranges.
- **Reads as:** continuous and atmospheric — green vegetation, blue water, in
  one pass.

## Direction C — True 2D bivariate colormap

Map the **(NDVI, NDWI) pair** into a 2D color lookup (a square legend instead of
a strip). The textbook "two continuous variables" technique.

- **Pro:** most information-dense; shows the joint distribution honestly.
- **Con:** most work — needs a 2D LUT texture and a 2D legend UI. The `Colormap`
  module is 1D (`texture(..., vec3(idx, 0.5, layer))`), so this is a new shader
  module, not a tweak.

## Direction D — Classify / priority composite

In one shader: if NDWI > t → water ramp; else if NDVI > t → vegetation ramp;
else bare. Crisp thematic classes rather than blended continua.

- **Pro:** legible, map-like; thresholds tune with the existing slider pattern.
- **Con:** discards within-class gradient; threshold choice is editorial.

## The honest trade

- **Least effort, fits today's code:** A (stacked + masked top).
- **Best viz payoff per line of code:** B (channel split) — leans into the
  anti-correlation so the image stays clean.
- **Most rigorous:** C, but it's a real feature (2D LUT + legend), not a tweak.

One UI knock-on for any single-layer approach (B/C/D): the panel's colormap
dropdown + range slider assume *one* scalar. A combined mode would hide those or
replace them with a fixed/dual control. Decide that before building.

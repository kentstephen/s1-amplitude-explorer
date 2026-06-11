# Session 5 handoff (2026-06-11)

Picks up after PLAN.md session 4. Everything here happened on top of `main`
commit `6a80e0a`'s lineage. Read this, then PLAN.md, then `.claude/memory/`.

## ⚠️ Branch / commit / stash state (READ FIRST)

**UPDATE (session 6): items 6-8 + the footer legend are now COMMITTED on
`pol-composite` as `ba934ab`. The stash has been popped and consumed (no longer
exists). Typecheck + build are clean. Runtime headless verify of culling /
keybindings (item 8 / 7) is still pending. `pol-composite` is still the
merge-to-`main` branch.** The original session-5 narrative is preserved below.

**As of this writing the working tree is on `main` (clean). The uncommitted
session-5 work (items 6-8 below) is parked in `git stash@{0}` ("WIP on
pol-composite"), NOT lost.** It was stashed so the app could be viewed on `main`.

Work is stacked on ONE cumulative branch, `pol-composite`:

- `export-mode` branch: `09deb49` (export mode), `ca9d8a8` (orbit lock + filenames),
  `6a80e0a` (load-bar settle fix).
- `pol-composite` branched from `6a80e0a`, so it CONTAINS all of the above, plus:
  `d6e966a` (dual-pol composite + panel tidy), `df5179a` (colourblind-safe palette).
  This branch is COMMITTED and safe.
- **`stash@{0}` = items 6-8** (capture fix + keybindings + zoom-out perf), an edit to
  `web/src/App.tsx` plus this untracked handoff doc. NOT typechecked/built/committed;
  the build was interrupted before stashing.

Nothing is merged to `main` yet. `pol-composite` is the branch to merge when ready.

### Recovery: get back to the in-progress state

```bash
cd /Users/stephenk/dev/projects/s1-amplitude-explorer
git checkout pol-composite     # back onto the cumulative feature branch
git stash pop                  # restore items 6-8 into the working tree
cd web && npx tsc --noEmit && npm run build   # verify (was never run on 6-8)
```

If `git stash pop` ever reports a conflict, the safe inspect-first move is
`git stash show -p stash@{0}` to see the patch, or `git stash branch tmp-6-8` to
pop it onto a fresh branch. Do NOT `git stash drop` until 6-8 are committed.

Also changed (global, outside the repo): `~/CLAUDE.md` gained a colourblindness
accessibility rule (red-green; never encode meaning in red-vs-green; default to
colourblind-safe). Applies to all projects now.

## What shipped (committed on `pol-composite`)

1. **Export mode** (`09deb49`). Toggle that lifts the interactive caps for a wide
   still: AOI span 3 deg -> 14 deg (`EXPORT_MAX_VIEWPORT_SPAN_DEG`), scene cap 3 ->
   30 (`EXPORT_MAX_SCENES`). Off by default so panning stays smooth. Plus a CAPTURE
   PNG button. Rationale: the 3-scene cap exists to protect interactivity, but a
   screenshot does not pan, so export mode trades interactivity for coverage.
2. **Orbit-direction lock** (`ca9d8a8`). BOTH / ASC / DESC under Export. Filters
   candidates before grouping (in `useSceneSearch`, derived `candidates` from
   `rawCandidates`). Ascending and descending light opposite slope faces, so mixing
   them is the worst tonal seam in a wide mosaic. Also metadata-rich export
   filenames: `s1-amp_<band>_<orbit>_<dateSpan>_<n>sc_<lat>_<lon>_<zoom>.png`.
3. **Load-bar infinite-spin fix** (`6a80e0a`). Root cause: some loaded scenes never
   request tiles at a given viewport (out of view / fully overlapped), so their
   `onGeoTIFFLoad` never fires and `loaded` plateaus below scene count. The bar +
   capture-wait keyed on a full count spun forever (worst in export mode).
   Fix: settle on IDLE (no new load activity for ~3.5 s grace), via the `settled`
   state + effect. Status reads "N drawn" once settled, not "N pending".
4. **Dual-pol composite mode** (`d6e966a`). New render-mode toggle AMPLITUDE
   (single-pol grayscale, the default headline, untouched) vs COMPOSITE
   (R=VV, G=VH, B=VV/VH ratio false colour). Composite loads BOTH pols of a scene
   (same acquisition + GCP grid, pixel-aligned by construction, so NO S1/S2-style
   registration problem). New `shaders/polComposite.ts` (`PolCompositeToRgb`) does
   dB + per-channel stretch + ratio + gamma in one pass. `renderPipeline.ts` gained
   `buildCompositePipeline` + `POL_COMPOSITE` band mapping + `RenderMode`. Mode
   persisted in prefs; layers remount on mode switch (extended the `prevPol` gen-bump
   to `prevMode`); status/filename mode-aware. **GOTCHA, learned the hard way:** a
   luma.gl shader module's `name` must equal its uniform-block prefix and be a valid
   GLSL identifier. First name `pol-composite-to-rgb` (hyphens) silently failed to
   bind the UBO and rendered blank; renamed to `polComposite`.
   Also a first pass of **panel tidy** (tighter section spacing, condensed one-line
   footer, padding trims).
5. **Colourblind-safe palette** (`df5179a`). Stephen is red-green colourblind, so
   R=VV/G=VH is the worst case. Added a blue<->yellow + luminance mapping of the same
   data: VV drives brightness (keeps the relief), VV/VH ratio drives hue (blue =
   smooth/water, yellow = vegetation/volume). `CompositePalette` = "cbSafe" | "natural".
   **Default is cbSafe.** Natural RGB is a toggle (CB-SAFE / NATURAL). Legend adapts
   per palette; palette persisted in prefs. Verified both render + toggle on the GPU.

## What's in the working tree, uncommitted (on `pol-composite`)

6. **Capture PNG fix (blank image).** Root cause confirmed by probe: react-map-gl
   does NOT forward `preserveDrawingBuffer` (context attribute came back `false`),
   so the GL buffer is wiped before `toDataURL` reads it -> blank. Fix in
   `captureExport`: grab `map.getCanvas().toDataURL()` SYNCHRONOUSLY inside maplibre's
   `render` event (same task as the draw, before the buffer clears), triggered by
   `map.triggerRepaint()`, with a 1200 ms fallback read. Deck renders interleaved
   into that pass so basemap + imagery are both captured. The panel/marker are HTML
   (not canvas) so they are never in the grab; footprints dropped via `capturing`.
   **VERIFIED headless:** download went 36 KB (blank) -> 1.5 MB (full SAR view, no
   chrome). This task is functionally DONE, just needs committing.
7. **Keyboard bindings.** Rewrote the keydown effect to dispatch through a
   `keyCmdRef` (assigned each render after the handlers exist, so no stale closures).
   New: `s` = search this view, `Enter` = load most complete, `c` = toggle
   amplitude/composite, `b` = toggle palette, `g` = grab PNG, `x` = export mode,
   `[` / `]` = step coverage date. Kept `/` `p` `m` `l` `d`. NOT yet verified.
   **TODO: footer keyboard legend still only lists / P L D; update it.**
8. **Zoom-out perf.** Two levers:
   - `MIN_ZOOM = 5` floor on the map (`minZoom={MIN_ZOOM}`). Below ~5 every loaded
     scene collapses into one coarse overview tile at once (N full-scene reprojection
     meshes on the main thread = the freeze), and 10 m S1 says nothing at that scale.
   - **Viewport culling.** New `viewBounds` state (margin-expanded view bbox, set on
     move-end + load via `updateViewBounds`) and `renderItems = polItems` filtered to
     scenes whose footprint intersects it (`bboxIntersects`). The mosaic, settle
     effect, and capture now use `renderItems`, so panning away frees off-screen
     meshes (they reload on return). `sceneCount` in the panel intentionally stays
     `polItems.length` (the loaded pool), so the count does not flicker while panning;
     culling is a silent perf optimization. NOT yet typechecked/built/verified.

## Discussed / decided (context, not all built)

- **S1 + S2 fusion** (researched, sources in the chat). The governing constraint:
  this app's S1 is raw GRD, GCP-warped, NOT terrain-corrected (layover is the whole
  dramatic look), while S2 is orthorectified. So any per-pixel S1xS2 fusion
  misregisters by hundreds of metres exactly in the relief we care about; fusion's
  natural home here is low-relief scenes (deserts, plains, coast). Conclusion: the
  S1-only polarization composite is the best-fit, lowest-risk path (no registration
  issue), which is what we built. S1xS2 HSV drape (S2 colour over S1 structure) and
  analytical S1+S2 indices (crop/water/flood, validated against ground truth) are
  real but are a different, look- or research-oriented product. A novel un-validated
  "index" is just a pretty false-colour; do not ship it as an index.
- **Colourblindness.** Built cbSafe as above and defaulted to it. Open idea NOT yet
  built: the natural RGB "pops more" to Stephen even though he cannot interpret it.
  To make cbSafe punch harder without breaking safety: (a) boost saturation + drop
  the black floor (currently 0.22) for more contrast, (b) blue<->orange instead of
  blue<->yellow, (c) use VH as SATURATION (strong cross-pol = vivid, weak = gray) to
  add back a third perceivable dimension. Recommended (a)+(c) together. His call
  whether to replace cbSafe or add a third palette.
- **"What is bright?"** Clarified: in cbSafe, brightness is not a colour, it is the
  VV luminance axis. DONE in session 6: the legend row now renders a dark->bright
  gradient ramp swatch (commit `59b32b2`).

## Remaining plan / next steps (in order)

1. **~~Finish + commit the uncommitted work (6-8).~~ DONE (session 6, `ba934ab`).**
   Typecheck + build clean. **Headless GPU verify DONE** via `web/verify-s6.mjs`
   (10/10): keybindings, MIN_ZOOM floor (settles at 5), culling pan round-trip (no
   crash), capture. Caveat: "culling" confirms no-crash + reload, not the actual
   off-screen mesh freeing (not observable from the DOM).
2. **~~Update the footer keyboard legend~~ DONE (session 6).** Now lists /, s,
   Enter, c, b, g, x, [ ], p, l, d.
3. **~~Panel redesign~~ DONE (session 6, `292e909`).** Progressive disclosure:
   Search + Coverage + Render stay always-visible; View (labels/north/marker/zoom),
   Export, Session collapse behind a `MORE` expander; Diagnostics stays visible on
   failure. Measured fit-to-view at 900px: tallest primary state (composite +
   coverage) = 840px, no scroll. Only the fully-expanded MORE state scrolls.
4. **(Optional) Punch up cbSafe** per the ideas above. STILL OPEN, his call
   (replace cbSafe vs add a third palette; (a) saturation+floor, (c) VH as
   saturation, blue<->orange).
5. **~~Relabel the "bright" legend row~~ DONE (session 6, `59b32b2`).** cbSafe
   "bright" row now renders a dark->bright gradient ramp, not a solid grey chip.
6. **(Optional) Per-channel composite tuning.** STILL OPEN. Today only the VV dB
   slider + gamma drive composite; VH window tracks VV shifted down by
   `COMPOSITE_VH_OFFSET` (7 dB) and the ratio window is fixed
   (`COMPOSITE_RATIO_WINDOW [2,16]`).
7. **Merge `pol-composite` to `main`** when the above is settled. **Stephen will
   trigger the merge himself (session 6 instruction: "wait on me to merge").**

## Testing notes (headless verify harness)

- Dev server: `cd web && npm run dev` -> http://localhost:5455/s1-amplitude-explorer/
  (port fixed, `strictPort`).
- Playwright-core is borrowed from the sibling project:
  `/Users/stephenk/dev/projects/deckgl-raster-mapterhorn-s2/web/node_modules/playwright-core`.
  Drive Brave at `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`.
- **Use real GPU** args `--enable-gpu --use-angle=metal --ignore-gpu-blocklist`.
  Swiftshader (`--use-gl=angle --use-angle=swiftshader`) does NOT paint the deck
  reprojection mesh (UI/wiring renders, raster stays blank).
- **Headless map inits at zoom 0** (container-size race), so the loaded scene is a
  sub-pixel speck. Wheel-zoom into the scene centre (mouse over the map, ~9x
  `wheel(0,-120)`) BEFORE judging a render.
- To verify capture: `acceptDownloads:true` context, click CAPTURE PNG, `saveAs`,
  inspect bytes (blank ~36 KB vs real ~1.5 MB) and/or read the PNG.
- The luma.gl warning "Binding sampler not set: Not found in shader layout" is benign
  (appears even when rendering is correct).

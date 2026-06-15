import { MosaicLayer } from "@developmentseed/deck.gl-geotiff";
import { GeoJsonLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Device } from "@luma.gl/core";
import "maplibre-gl/dist/maplibre-gl.css";
import * as RadixSlider from "@radix-ui/react-slider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map as MaplibreMap, Marker, useControl } from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";

import { type PartialSTACItem, type Polarization } from "./stac";
import { useSceneSearch, type SceneSearch, type OrbitFilter } from "./useSceneSearch";
import { selectCoverageFirst } from "./coverage";
import { footprintCollection } from "./footprints";
import {
  reportFailed,
  reportLoaded,
  resetStats,
  subscribeStats,
} from "./loadStats";
import { resultToBbox, type GeoResult } from "./geocode";
import { loadSettings, saveSettings, resetSettings, hasSavedSettings, DEFAULT_SETTINGS } from "./prefs";
import { PlaceSearch } from "./PlaceSearch";
import { GcpMultiCOGLayer } from "./GcpMultiCOGLayer";
import {
  AMP_COMPOSITE,
  POL_COMPOSITE,
  buildRenderPipeline,
  buildCompositePipeline,
  DB_MAX,
  DB_MIN,
  DEFAULT_DB_RANGE,
  DEFAULT_GAMMA,
  DRAMATIC_DB_RANGE,
  DRAMATIC_GAMMA,
  POLARIZATIONS,
  type RenderMode,
  type CompositePalette,
} from "./renderPipeline";

// Lena River Delta, Siberia: braided channels over frozen tundra, the dramatic
// winter-SAR demo. Tight AOI so the first warp renders one well-understood scene.
const DEFAULT_BBOX: [number, number, number, number] = [126.2, 71.89, 130.03, 73.13];
// Winter window (frozen delta, strongest channel/relief contrast). Wide enough
// that FETCH VIEW finds an overpass after you pan; the load stays bounded by
// maxItems regardless of how many scenes the window contains.
const DEFAULT_DATE_FROM = "2017-11-01";
const DEFAULT_DATE_TO = "2018-03-01";
// Fresh visit (no saved session): auto-search the default AOI and load this date
// so the app opens straight onto a SAR mosaic, not a bare basemap. Falls back to
// the most-complete mosaic if no overpass lands on this exact date.
const AUTOLOAD_DATE = "2018-01-31";
// Ceiling for the "fetch viewport" AOI span (deg/axis) so a zoomed-out view
// can't enumerate hundreds of ~700 MB COGs.
const MAX_VIEWPORT_SPAN_DEG = 3.0;

function datetimeOf(from: string, to: string): string {
  // Tolerate a reversed range (the segmented date fields don't link min/max).
  const [a, b] = from <= to ? [from, to] : [to, from];
  return `${a}T00:00:00Z/${b}T23:59:59Z`;
}

/** Min interactive zoom. Below this every loaded scene piles into one coarse
 *  overview tile at once (N full-scene reprojection meshes on the main thread),
 *  which is the zoom-out freeze. It's also below where 10 m S1 imagery says
 *  anything. So we floor the camera here. */
const MIN_ZOOM = 5;

/** Max interactive zoom = maplibre-gl's hard ceiling (24). NOT an LOD cap on the
 *  imagery: it just stops the camera running past what the renderer supports, so
 *  the raster keeps refining/holding instead of dropping out at extreme zoom. */
const MAX_ZOOM = 24;

/** Do two [W,S,E,N] bboxes overlap? Used to cull scenes outside the view. */
function bboxIntersects(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/**
 * Build a self-describing export filename from the loaded mosaic so a folder of
 * captures is legible at a glance: pol, look direction, the acquisition-date span
 * actually rendered, scene count, and the map center + zoom. The browser dedupes
 * collisions with a trailing "(1)", so no timestamp is needed.
 *   s1-amp_VV_desc_2020-11-23..2020-12-05_30sc_27.95N_85.42E_z7.4.png
 */
function exportFilename(
  map: { getCenter: () => { lat: number; lng: number }; getZoom: () => number },
  items: PartialSTACItem[],
  pol: Polarization,
  orbit: OrbitFilter,
  renderMode: RenderMode,
): string {
  const dates = items
    .map((i) => i.datetime?.slice(0, 10))
    .filter(Boolean)
    .sort() as string[];
  const span = dates.length
    ? dates[0] === dates[dates.length - 1]
      ? dates[0]
      : `${dates[0]}..${dates[dates.length - 1]}`
    : "nodate";
  const look = orbit === "ascending" ? "asc" : orbit === "descending" ? "desc" : "both";
  const c = map.getCenter();
  const lat = `${Math.abs(c.lat).toFixed(2)}${c.lat >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(c.lng).toFixed(2)}${c.lng >= 0 ? "E" : "W"}`;
  const z = `z${map.getZoom().toFixed(1)}`;
  const band = renderMode === "composite" ? "RGB" : pol.toUpperCase();
  return `s1-amp_${band}_${look}_${span}_${items.length}sc_${lat}_${lon}_${z}.png`;
}

/**
 * Reprojection-mesh error budget (pixels) as a function of viewport zoom.
 *
 * The GCP warp is smooth, so a wide view tolerates a far looser mesh: each step
 * down in zoom doubles the ground-meters per screen pixel, so sub-pixel mesh
 * accuracy at z4 is invisible AND expensive, every extra triangle is another
 * per-vertex GCP `inverse()` solve, which is the zoom-out bottleneck. Detail
 * zooms keep the fine 0.75px mesh. Quantized into bands so the layer's
 * `maxError` prop (and thus the mesh) only regenerates when crossing a band,
 * not on every zoom delta. `maxError` is a public deck.gl-raster prop; changing
 * it updates the mesh in place (no layer remount).
 */
function maxErrorForZoom(zoom: number): number {
  // The warp is smooth bilinear and the imagery isn't terrain-corrected (layover
  // already displaces by hundreds of m), so a 1-2px mesh error is invisible while
  // roughly halving triangle count vs sub-pixel. Snappiness > sub-pixel fidelity.
  if (zoom >= 9) return 1.5;
  // z7-9: high-latitude GRD frames (e.g. the Lena delta at ~72N) warp harder than
  // a 4px mesh can approximate, so the refiner bailed at ~36px and left the two
  // frames misregistered (the seam). A looser 12px target actually converges, so
  // adjacent frames register and the seam mostly closes; the warp is smooth so the
  // extra mesh error stays invisible.
  if (zoom >= 7) return 12;
  if (zoom >= 5) return 14;
  return 24;
}

type LoadStats = { loaded: number; failed: number; failures: { url: string; err: string }[] };

function DeckGLOverlay({
  layers,
  onDevice,
}: {
  layers: any[];
  onDevice: (device: Device) => void;
}) {
  const overlay = useControl(
    () =>
      new MapboxOverlay({
        interleaved: true,
        layers,
        onDeviceInitialized: onDevice,
      } as any),
  );
  overlay.setProps({ layers });
  return null;
}

export default function App() {
  const mapRef = useRef<MapRef>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Cache MultiCOGLayer `sources` records per (pol, source.id) so the SAME
  // object reference is reused across look changes. MultiCOGLayer resets on
  // `props.sources !== oldProps.sources`, reopening GeoTIFFs and refetching ,
  // a fresh object each render would refetch on every slider tick.
  const sourcesCache = useRef(new Map<string, Record<string, { url: string }>>());
  const polGen = useRef(0);
  const prevPol = useRef<Polarization | null>(null);
  const prevMode = useRef<RenderMode | null>(null);
  // Latest keyboard-command handlers, refreshed each render so the single mounted
  // keydown listener never closes over stale callbacks (the handlers are defined
  // further down; this ref is assigned once they exist).
  const keyCmdRef = useRef<Record<string, (() => void) | undefined>>({});
  // One AbortController per generation; aborting on pol switch kills the old
  // pol's in-flight band fetches so they don't starve the new pol's requests.
  const genAbort = useRef<AbortController | null>(null);

  const [labelBeforeId, setLabelBeforeId] = useState<string | undefined>(undefined);
  // The scenes currently LOADED into the mosaic (rendered as GCP-warped tiles).
  const [stacItems, setStacItems] = useState<PartialSTACItem[]>([]);
  // Loading is explicit: SEARCH finds candidates, then LOAD renders a mosaic.
  // `hasLoaded` distinguishes the idle first-run state from an empty load.
  const [hasLoaded, setHasLoaded] = useState(false);
  // `capturing` blanks transient overlays (footprints) and the chrome while the
  // canvas is grabbed, so they aren't baked into the PNG.
  const [capturing, setCapturing] = useState(false);
  // `settled` = the mosaic has stopped loading. NOT "every scene opened": at any
  // viewport some loaded scenes never request tiles (out of view, fully
  // overlapped), so their `onGeoTIFFLoad` never fires and the raw loaded count
  // plateaus BELOW the scene count. Keying the load bar / capture on a full count
  // spins forever. Instead we settle on IDLE: no new load activity for a short
  // grace window. See the effect below.
  const [settled, setSettled] = useState(true);
  // Orbit-direction lock. Ascending and descending light opposite slope faces, so
  // mixing them across a wide mosaic gives the worst tonal seams; locking one
  // direction is the cheapest way to make the frames read as one consistent scene.
  const [orbitFilter, setOrbitFilter] = useState<OrbitFilter>(null);
  // SEARCH VIEW: candidate search + coverage selection + date stepping. Isolated
  // in a hook so a stac-map search component could drive the same surface later.
  const search = useSceneSearch({
    orbit: orbitFilter,
  });
  // Footprint coverage overlay: on after a search so you can see/step coverage,
  // off once a mosaic is loaded (so the imagery reads cleanly).
  const [previewMode, setPreviewMode] = useState(false);

  // Saved session settings (look + search window + AOI + view). Seeds all the
  // state below; falls back to the app defaults for any field left unsaved.
  const saved = useRef(loadSettings()).current;
  // Auto-load the default scene only on a fresh visit (no saved session). Cleared
  // once the search resolves and we've loaded (or given up), so it never re-fires.
  const autoload = useRef(!hasSavedSettings());
  const [pol, setPol] = useState<Polarization>(saved.pol);
  const [dbRange, setDbRange] = useState<[number, number]>(saved.dbRange);
  const [gamma, setGamma] = useState<number>(saved.gamma);
  // Render look: single-pol grayscale amplitude (default, the headline) or the
  // dual-pol VV/VH/ratio RGB composite. Composite needs BOTH pols of a scene.
  const [renderMode, setRenderMode] = useState<RenderMode>(saved.renderMode);
  // Composite palette. Default is the red-green colourblind-safe (blue↔yellow +
  // luminance) mapping, not the standard R=VV/G=VH false colour, which is the
  // worst case for a red-green dichromat. Natural RGB is one click away.
  const [compositePalette, setCompositePalette] = useState<CompositePalette>(saved.compositePalette);

  // Device is initialized by the deck overlay; kept for parity / future GPU work.
  const [, setDevice] = useState<Device | null>(null);

  const [labels, setLabels] = useState(false);
  const [bbox, setBbox] = useState<[number, number, number, number]>(saved.bbox ?? DEFAULT_BBOX);
  const [dateFrom, setDateFrom] = useState(saved.dateFrom ?? DEFAULT_DATE_FROM);
  const [dateTo, setDateTo] = useState(saved.dateTo ?? DEFAULT_DATE_TO);
  const [marker, setMarker] = useState<{ lng: number; lat: number; label: string } | null>(null);
  const [showMarker, setShowMarker] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [stats, setStats] = useState<LoadStats>({ loaded: 0, failed: 0, failures: [] });
  const [zoom, setZoom] = useState<number>(8);
  // Zoom sampled only when a gesture ENDS, used solely to band the mesh maxError.
  // Decoupled from the live `zoom` (which drives the readout and updates every
  // onMove tick): the reprojection mesh rebuilds SYNCHRONOUSLY on the main thread
  // whenever maxError changes, so re-banding mid-zoom rebuilt every visible tile's
  // mesh on each tick, stalling the frame (the "image vanishes mid zoom-in /
  // sluggish zoom-out"). Settling it on move-end rebuilds once, after the gesture.
  const [meshZoom, setMeshZoom] = useState<number>(8);
  // Current view bbox (margin-expanded), refreshed on move-end. Scenes whose
  // footprint falls outside it are dropped from the mosaic, so panning away frees
  // their meshes/textures (they reload on return). Null = no cull yet (first load).
  const [viewBounds, setViewBounds] = useState<[number, number, number, number] | null>(null);
  // Bumped on every manual fetch. Folded into the layer ids so the MosaicLayer
  // (and its inner TileLayer) remounts and re-traverses each fetch. Without it a
  // FETCH VIEW that doesn't move the viewport never reloads: TileLayer only
  // re-runs getTileIndices on a viewport/prop change, so new scenes for the same
  // view would silently never appear.
  const [fetchGen, setFetchGen] = useState(0);

  // Mirror the module-level load scoreboard into React state.
  useEffect(() => subscribeStats(setStats), []);

  // Brief "Saved" / "Reset" confirmation on the settings buttons.
  const [savedFlash, setSavedFlash] = useState<"" | "saved" | "reset">("");

  // SAVE SETTINGS: capture the whole session (look + search window + AOI + the
  // live map camera) to localStorage. Explicit, not auto, so the dash is a
  // deliberate "remember this" rather than persisting every slider twitch.
  const handleSaveSettings = useCallback(() => {
    const map = mapRef.current?.getMap();
    const c = map?.getCenter();
    saveSettings({
      pol,
      renderMode,
      compositePalette,
      dbRange,
      gamma,
      dateFrom,
      dateTo,
      bbox,
      view: c ? { longitude: c.lng, latitude: c.lat, zoom: map!.getZoom() } : null,
    });
    setSavedFlash("saved");
    setTimeout(() => setSavedFlash(""), 1400);
  }, [pol, renderMode, compositePalette, dbRange, gamma, dateFrom, dateTo, bbox]);

  // RESET: clear saved settings and return the look + search window to defaults.
  const handleResetSettings = useCallback(() => {
    resetSettings();
    setPol(DEFAULT_SETTINGS.pol);
    setRenderMode(DEFAULT_SETTINGS.renderMode);
    setCompositePalette(DEFAULT_SETTINGS.compositePalette);
    setDbRange(DEFAULT_SETTINGS.dbRange);
    setGamma(DEFAULT_SETTINGS.gamma);
    setDateFrom(DEFAULT_DATE_FROM);
    setDateTo(DEFAULT_DATE_TO);
    setSavedFlash("reset");
    setTimeout(() => setSavedFlash(""), 1400);
  }, []);

  // Keyboard shortcuts (mounted once; action handlers dispatched via keyCmdRef so
  // they're never stale). Ignored while typing in a field. Left/right arrows step
  // coverage dates unless the map is focused (then they pan). See the footer legend.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const cmd = keyCmdRef.current;
      switch (e.key.toLowerCase()) {
        case "/":
          e.preventDefault();
          searchRef.current?.focus();
          break;
        case "s": // search THIS view
          e.preventDefault();
          cmd.searchView?.();
          break;
        case "enter": // load the most-complete mosaic for the current search
          e.preventDefault();
          cmd.loadMost?.();
          break;
        case "c": // toggle amplitude <-> composite
          cmd.toggleMode?.();
          break;
        case "b": // toggle composite palette (cb-safe / natural)
          cmd.togglePalette?.();
          break;
        case "g": // grab a PNG of the current view
          cmd.capture?.();
          break;
        case "[": // step coverage date back
          cmd.stepPrev?.();
          break;
        case "]": // step coverage date forward
          cmd.stepNext?.();
          break;
        case "arrowleft": // step coverage date back (unless the map is focused)
        case "arrowright": {
          // Arrows pan the map ONLY when the map is "selected" (its container has
          // focus, i.e. you clicked it). Otherwise they drive the date stepper, so
          // browsing dates needs no mouse. No candidates loaded => fall through to
          // the map's default (a no-op when the map isn't focused).
          const onMap = !!t?.closest?.(".maplibregl-map");
          if (onMap || !cmd.canStep?.()) break;
          e.preventDefault();
          if (e.key === "ArrowLeft") cmd.stepPrev?.();
          else cmd.stepNext?.();
          break;
        }
        case "p":
          setPol((v) => (v === "vv" ? "vh" : "vv"));
          break;
        case "m":
          setShowMarker((v) => (marker ? !v : v));
          break;
        case "l":
          setLabels((v) => !v);
          break;
        case "d":
          setDrawing((v) => !v);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [marker]);

  // Dark, label-light basemap so the monochrome amplitude reads against it.
  const mapStyle = labels
    ? "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
    : "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json";

  // Bump a generation on pol OR render-mode change so the layer ids change,
  // forcing deck.gl to unmount the old tiles instead of leaving stale fetching
  // tiles behind. A mode switch also changes which COGs each scene opens (one pol
  // vs both), so the sources cache must be cleared too.
  if (prevPol.current !== pol || prevMode.current !== renderMode) {
    if (prevPol.current !== null) polGen.current += 1;
    prevPol.current = pol;
    prevMode.current = renderMode;
    sourcesCache.current.clear();
    genAbort.current?.abort();
    genAbort.current = new AbortController();
  }
  if (!genAbort.current) genAbort.current = new AbortController();
  const gen = polGen.current;
  const genSignal = genAbort.current.signal;

  // Fresh scoreboard on pol / mode switch (layers remount and reload).
  useEffect(() => resetStats(), [pol, renderMode]);

  /**
   * Load a chosen set of scenes into the mosaic (the render step). Separate from
   * search: search finds candidates, this renders them. Bumps fetchGen TOGETHER
   * with the new scenes (batched into one render) so the MosaicLayer id changes
   * exactly when the data does, forcing the inner TileLayer to re-traverse (it
   * only re-runs getTileIndices on a viewport/prop change). Hides the footprint
   * overlay so the imagery reads cleanly.
   */
  const loadItems = useCallback((items: PartialSTACItem[]) => {
    resetStats();
    setStacItems(items);
    setFetchGen((g) => g + 1);
    setHasLoaded(true);
    setPreviewMode(false);
    console.info(`[load] ${items.length} S1 GRD scenes into the mosaic`);
  }, []);

  // SEARCH the current date window over an AOI. Shows the coverage overlay; does
  // NOT load tiles (the user picks a mosaic to LOAD).
  const runSearch = useCallback(
    (targetBbox: [number, number, number, number]) => {
      setBbox(targetBbox);
      setMarker(null);
      setPreviewMode(true);
      search.search(targetBbox, datetimeOf(dateFrom, dateTo));
    },
    [search, dateFrom, dateTo],
  );

  const handleDrawBox = (bb: [number, number, number, number]) => {
    setDrawing(false);
    runSearch(bb); // drawing an AOI searches it
  };

  // SEARCH VIEW: build an AOI from the current view + small buffer, clamped so a
  // zoomed-out view can't fan out into hundreds of COG candidates, then search.
  const handleSearchViewport = () => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const b = map.getBounds();
    let w = b.getWest();
    let s = b.getSouth();
    let e = b.getEast();
    let n = b.getNorth();
    const margin = 0.1;
    const dw = (e - w) * margin;
    const dh = (n - s) * margin;
    w -= dw; e += dw; s -= dh; n += dh;
    const cx = (w + e) / 2;
    const cy = (s + n) / 2;
    const maxHalf = MAX_VIEWPORT_SPAN_DEG / 2;
    const halfW = Math.min((e - w) / 2, maxHalf);
    const halfH = Math.min((n - s) / 2, maxHalf);
    runSearch([cx - halfW, cy - halfH, cx + halfW, cy + halfH]);
  };

  // LOAD the coverage-first "most complete" mosaic across the whole window.
  const handleLoadMostComplete = () => loadItems(search.selection.items);
  // LOAD only the date currently stepped to. Route through selectCoverageFirst so
  // a date with many overlapping frames still respects the scene cap.
  const handleLoadThisDate = () => {
    if (search.current)
      loadItems(selectCoverageFirst(search.current.items).items);
  };

  // Fresh visit: kick off the default-AOI search once on mount. The result effect
  // below loads the target date when candidates arrive.
  useEffect(() => {
    if (autoload.current) runSearch(DEFAULT_BBOX);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the auto-load search resolves, load the target date (or the most-complete
  // mosaic if no overpass lands on it), then disarm so it never re-fires.
  useEffect(() => {
    if (!autoload.current || search.searching || !search.hasSearched) return;
    autoload.current = false;
    if (!search.dates.length) return; // empty result: leave the basemap up
    const idx = search.dates.findIndex((d) => d.date === AUTOLOAD_DATE);
    if (idx < 0) {
      loadItems(search.selection.items);
      return;
    }
    search.setDateIdx(idx);
    loadItems(selectCoverageFirst(search.dates[idx].items).items);
  }, [search.searching, search.hasSearched, search.dates, search.selection, search.setDateIdx, loadItems]);

  const handleResetNorth = () => {
    mapRef.current?.getMap()?.easeTo({ bearing: 0, pitch: 0, duration: 400 });
  };

  // Geocode just MOVES the map (and drops a marker). It does NOT fetch — the
  // user hits FETCH VIEW when they're framed on what they want.
  const handlePickPlace = (r: GeoResult) => {
    const bb = resultToBbox(r);
    setMarker({ lng: r.center[0], lat: r.center[1], label: r.label });
    setShowMarker(false);
    mapRef.current?.fitBounds(
      [
        [bb[0], bb[1]],
        [bb[2], bb[3]],
      ],
      { padding: 40, duration: 1000 },
    );
  };

  const handleDramatic = () => {
    setDbRange(DRAMATIC_DB_RANGE);
    setGamma(DRAMATIC_GAMMA);
  };

  // Scenes that can render under the current look: amplitude needs the selected
  // pol; the composite needs BOTH pols (it maps VV+VH to colour).
  const polItems = useMemo(
    () =>
      renderMode === "composite"
        ? stacItems.filter((it) => it.assets.vv && it.assets.vh)
        : stacItems.filter((it) => it.assets[pol]),
    [stacItems, pol, renderMode],
  );

  // Cull to the current view: only scenes whose footprint intersects the (margin-
  // expanded) viewport are handed to the mosaic, so off-screen meshes aren't built
  // or held. This is the "only show what's in view" perf lever for zoom-out / pan.
  const renderItems = useMemo(
    () => (viewBounds ? polItems.filter((it) => bboxIntersects(it.bbox, viewBounds)) : polItems),
    [polItems, viewBounds],
  );

  // Live mirrors for the capture settle-wait (which runs outside React's render
  // cycle and needs the latest values without re-subscribing).
  const settledRef = useRef(settled);
  settledRef.current = settled;
  // Settle-cycle gating: a cycle (and the load bar) starts only when `fetchGen`
  // bumps (an explicit load), not on the renderItems/stats churn that panning's
  // scene cull produces. See the settle effect below.
  const loadActiveRef = useRef(false);
  const prevFetchGen = useRef(fetchGen);

  // IDLE settle: re-arm a short timer on every load-count change; when the counts
  // stop moving (or all scenes that will load have), mark the mosaic settled. The
  // first scene gets a long grace (a big synchronous mesh build can stall the main
  // thread for seconds before the count first moves); once scenes are flowing, a
  // short idle window ends the load. This is what stops the load bar spinning when
  // some scenes never request tiles.
  useEffect(() => {
    if (!hasLoaded) return;
    // Only a fresh LOAD (fetchGen bumped) starts a settle cycle / shows the bar.
    // Panning re-culls scenes (renderItems + stats churn as they remount and
    // re-report), but that's not a load, so it must NOT re-spin the bar.
    if (prevFetchGen.current !== fetchGen) {
      prevFetchGen.current = fetchGen;
      loadActiveRef.current = true;
      setSettled(false);
    }
    if (!loadActiveRef.current) return;
    const done = stats.loaded + stats.failed;
    const pending = renderItems.length - done;
    if (renderItems.length > 0 && pending <= 0) {
      loadActiveRef.current = false;
      setSettled(true);
      return;
    }
    const idleMs = done > 0 ? 3500 : 12000;
    const id = window.setTimeout(() => {
      loadActiveRef.current = false;
      setSettled(true);
    }, idleMs);
    return () => clearTimeout(id);
  }, [fetchGen, stats, hasLoaded, renderItems.length]);

  /**
   * EXPORT a PNG of exactly what's on the map (no UI: the panel and marker are
   * HTML, not canvas, so they're never in the grab; the footprint overlay is
   * dropped via `capturing`). Waits for the mosaic to settle, then reads the
   * canvas.
   *
   * The catch: react-map-gl does not forward `preserveDrawingBuffer`, so the GL
   * drawing buffer is cleared as soon as the JS task yields after a paint. A plain
   * `toDataURL()` (which we reach via awaits) therefore returns a BLANK frame. The
   * fix is to read SYNCHRONOUSLY inside maplibre's `render` event, in the same task
   * as the draw, before the buffer is cleared. Deck renders interleaved into that
   * same pass, so the basemap + amplitude/composite are both captured.
   */
  const captureExport = useCallback(async () => {
    const map = mapRef.current?.getMap();
    if (!map || renderItems.length === 0) return;
    setCapturing(true);
    try {
      // Wait for the mosaic to settle (idle, not "every scene opened" — some never
      // request tiles). Bounded so a genuinely stuck load can't hang the capture.
      const deadline = Date.now() + 45000;
      await new Promise<void>((resolve) => {
        const tick = () => {
          if (settledRef.current) return resolve();
          if (Date.now() > deadline) return resolve();
          setTimeout(tick, 200);
        };
        tick();
      });
      // Let the last tiles/meshes finish painting before the grab.
      await new Promise<void>((r) => setTimeout(() => r(), 400));
      // Grab inside the render event (synchronous, pre-buffer-clear).
      const url = await new Promise<string>((resolve) => {
        const grab = () => resolve(map.getCanvas().toDataURL("image/png"));
        map.once("render", grab);
        map.triggerRepaint();
        // Fallback if no render fires (e.g. nothing changed): force one read.
        setTimeout(() => {
          map.off("render", grab);
          resolve(map.getCanvas().toDataURL("image/png"));
        }, 1200);
      });
      const a = document.createElement("a");
      a.href = url;
      a.download = exportFilename(map, renderItems, pol, orbitFilter, renderMode);
      a.click();
    } finally {
      setCapturing(false);
    }
  }, [pol, renderItems, orbitFilter, renderMode]);

  // Wire the keyboard commands to the current handlers (read by the mounted
  // keydown listener via keyCmdRef). Reassigned every render so they're current.
  keyCmdRef.current = {
    searchView: handleSearchViewport,
    loadMost: handleLoadMostComplete,
    toggleMode: () => setRenderMode((m) => (m === "amplitude" ? "composite" : "amplitude")),
    togglePalette: () => setCompositePalette((p) => (p === "cbSafe" ? "natural" : "cbSafe")),
    capture: captureExport,
    stepPrev: () => search.step(-1),
    stepNext: () => search.step(1),
    canStep: () => search.dates.length > 1,
  };

  // Refresh the cull bbox from the map, expanded by a half-viewport margin so
  // scenes just off-screen stay loaded (no reload on a small pan). Called on
  // move-end and on load.
  const updateViewBounds = useCallback((map: {
    getBounds: () => { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
  }) => {
    const b = map.getBounds();
    const w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
    const mx = (e - w) * 0.5;
    const my = (n - s) * 0.5;
    setViewBounds([w - mx, s - my, e + mx, n + my]);
  }, []);

  // Banded off the settled (move-end) zoom, not the live one, so the mesh only
  // regenerates after a gesture ends, not on every zoom tick.
  const meshMaxError = maxErrorForZoom(meshZoom);

  const layers = useMemo(() => {
    if (renderItems.length === 0) return [];
    const composite = renderMode === "composite";
    // One pipeline + composite mapping per look: grayscale dB amplitude (single
    // `amp` slot) or the dual-pol VV/VH/ratio RGB composite (vv + vh slots).
    const pipeline = composite
      ? buildCompositePipeline({ vvWindow: dbRange, gamma, palette: compositePalette })
      : buildRenderPipeline({ dbRange, gamma });
    const bandComposite = composite ? POL_COMPOSITE : AMP_COMPOSITE;

    // Resolve a STAC item to the COG source record (and the scoreboard key),
    // reused by both the detail layer and the coarse underlay so they open the
    // identical sources object (MultiCOGLayer resets if `sources` !== old).
    const resolveSources = (source: PartialSTACItem) => {
      const vvHref = source.assets.vv?.href;
      const vhHref = source.assets.vh?.href;
      if (composite) {
        if (!vvHref || !vhHref) return null;
        const cacheKey = `comp-${source.id}`;
        let sources = sourcesCache.current.get(cacheKey);
        if (!sources) {
          sources = { vv: { url: vvHref }, vh: { url: vhHref } };
          sourcesCache.current.set(cacheKey, sources);
        }
        return { sources, sceneHref: vvHref };
      }
      const sceneHref = source.assets[pol]?.href;
      if (!sceneHref) return null;
      const cacheKey = `${pol}-${source.id}`;
      let sources = sourcesCache.current.get(cacheKey);
      if (!sources) {
        sources = { amp: { url: sceneHref } };
        sourcesCache.current.set(cacheKey, sources);
      }
      return { sources, sceneHref };
    };

    // `underlay`: render ONLY the coarsest overview (maxZoom: 0 caps the level
    // index, see raster-tileset-2d). That's one gap-free mesh per scene drawn
    // BENEATH the tiled detail layer, so the hairline cracks between the detail
    // layer's independently-reprojected tiles reveal the same imagery (a touch
    // soft) instead of the dark basemap. Same pipeline → the seam disappears.
    // The underlay doesn't tally the load scoreboard (the detail layer does) so
    // counts aren't doubled.
    const makeSceneLayer = (source: PartialSTACItem, underlay: boolean) => {
      const resolved = resolveSources(source);
      if (!resolved) return null;
      const { sources, sceneHref } = resolved;
      const tag = underlay ? "under" : "multi";
      return new GcpMultiCOGLayer({
        id: `s1-${tag}-${renderMode}-${pol}-${gen}-${fetchGen}-${source.id}`,
        sources,
        composite: bandComposite,
        renderPipeline: pipeline,
        signal: genSignal,
        refinementStrategy: "best-available",
        ...(underlay ? { maxZoom: 0 } : {}),
        // The GCP warp is smooth (bilinear over a 21x10 grid), so a coarse
        // reprojection mesh looks identical to a fine one but builds far fewer
        // triangles and calls the (heavier) GCP inverse far fewer times.
        // Banded by viewport zoom (maxErrorForZoom): loose on wide views where
        // sub-pixel mesh accuracy is invisible, fine on detail zooms.
        maxError: meshMaxError,
        // Raw GRD bucket is fast and CORS-open (no SAS throttle); still cap
        // concurrency so a wide view doesn't stampede range reads.
        maxRequests: 10,
        ...(underlay
          ? {}
          : {
              onGeoTIFFLoad: () => reportLoaded(sceneHref),
              onError: (e: unknown) =>
                reportFailed(sceneHref, e instanceof Error ? e.message : String(e)),
            }),
        updateTriggers: {
          renderTile: [renderMode, pol, dbRange[0], dbRange[1], gamma, compositePalette],
        },
      } as any);
    };

    const mosaic = (underlay: boolean) =>
      new MosaicLayer<PartialSTACItem, null>({
        id: `s1-mosaic${underlay ? "-under" : ""}-${renderMode}-${pol}-${gen}-${fetchGen}`,
        sources: renderItems,
        maxCacheSize: 0,
        // MultiCOGLayer opens its own GeoTIFFs; MosaicLayer only needs each
        // item's bbox for spatial indexing.
        getSource: async () => null,
        renderSource: (source) => makeSceneLayer(source, underlay),
        // @ts-expect-error beforeId is injected by @deck.gl/mapbox
        beforeId: labelBeforeId,
      });

    // Underlay first (drawn below), then the tiled detail layer on top.
    return [mosaic(true), mosaic(false)];
  }, [renderItems, labelBeforeId, renderMode, pol, gen, fetchGen, dbRange, gamma, meshMaxError, compositePalette]);

  // SEARCH VIEW coverage overlay: candidate footprints, the stepped date bright,
  // the "most complete" selection dim-teal, the rest faint. Sits above the
  // raster, below labels. Only while previewing (cleared once a mosaic loads).
  const footprintLayer = useMemo(() => {
    if (!previewMode || capturing || search.candidates.length === 0) return null;
    const activeIds = new Set((search.current?.items ?? []).map((i) => i.id));
    const selectedIds = new Set(search.selection.items.map((i) => i.id));
    const data = footprintCollection(search.candidates, activeIds, selectedIds);
    return new GeoJsonLayer({
      id: "coverage-footprints",
      data: data as any,
      stroked: true,
      filled: true,
      getFillColor: (f: any) =>
        f.properties.active ? [125, 211, 192, 38]
          : f.properties.selected ? [125, 211, 192, 12]
          : [255, 255, 255, 6],
      getLineColor: (f: any) =>
        f.properties.active ? [125, 211, 192, 255]
          : f.properties.selected ? [125, 211, 192, 130]
          : [255, 255, 255, 64],
      getLineWidth: (f: any) => (f.properties.active ? 2 : 1),
      lineWidthUnits: "pixels",
      pickable: false,
      updateTriggers: {
        getFillColor: [search.dateIdx, search.selection],
        getLineColor: [search.dateIdx, search.selection],
        getLineWidth: [search.dateIdx],
      },
      beforeId: labelBeforeId,
    } as any);
  }, [previewMode, capturing, search.candidates, search.current, search.selection, search.dateIdx, labelBeforeId]);

  const allLayers = useMemo(
    () => (footprintLayer ? [...layers, footprintLayer] : layers),
    [layers, footprintLayer],
  );

  const initialViewState = {
    longitude: saved.view?.longitude ?? 127.82,
    latitude: saved.view?.latitude ?? 72.55,
    zoom: saved.view?.zoom ?? 7.7,
    pitch: 0,
    bearing: 0,
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MaplibreMap
        ref={mapRef}
        initialViewState={initialViewState}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        onMove={(e) => setZoom(e.viewState.zoom)}
        onMoveEnd={(e) => {
          updateViewBounds(e.target);
          setMeshZoom(e.viewState.zoom);
        }}
        attributionControl={false}
        mapStyle={mapStyle}
        onLoad={(e) => {
          const map = e.target;
          updateViewBounds(map);
          setMeshZoom(map.getZoom());
          const ls = map.getStyle()?.layers ?? [];
          const firstSymbol = ls.find((l: any) => l.type === "symbol");
          setLabelBeforeId(firstSymbol?.id);
          map.on("styledata", () => {
            const layers = map.getStyle()?.layers ?? [];
            const sym = layers.find((l: any) => l.type === "symbol");
            setLabelBeforeId(sym?.id);
          });
          map.on("movestart", (ev: any) => {
            if (ev.originalEvent) setShowMarker(false);
          });
        }}
      >
        <DeckGLOverlay layers={allLayers} onDevice={setDevice} />
        <DrawBbox mapRef={mapRef} active={drawing} onComplete={handleDrawBox} />
        {marker && showMarker && (
          <Marker longitude={marker.lng} latitude={marker.lat} anchor="bottom">
            <div
              title={marker.label}
              style={{
                width: 14,
                height: 14,
                borderRadius: "50% 50% 50% 0",
                transform: "rotate(-45deg)",
                background: "#ff4d4f",
                border: "2px solid white",
                boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
              }}
            />
          </Marker>
        )}
      </MaplibreMap>
      <InfoPanel
        sceneCount={polItems.length}
        totalCount={stacItems.length}
        hasLoaded={hasLoaded}
        stats={stats}
        search={search}
        previewMode={previewMode}
        onTogglePreview={() => setPreviewMode((v) => !v)}
        onSearchViewport={handleSearchViewport}
        onLoadMostComplete={handleLoadMostComplete}
        onLoadThisDate={handleLoadThisDate}
        pol={pol}
        onPolChange={setPol}
        renderMode={renderMode}
        onRenderModeChange={setRenderMode}
        compositePalette={compositePalette}
        onCompositePaletteChange={setCompositePalette}
        dbRange={dbRange}
        onDbRangeChange={setDbRange}
        gamma={gamma}
        onGammaChange={setGamma}
        onDramatic={handleDramatic}
        dateFrom={dateFrom}
        onDateFromChange={setDateFrom}
        dateTo={dateTo}
        onDateToChange={setDateTo}
        labels={labels}
        onLabelsChange={setLabels}
        onPickPlace={handlePickPlace}
        searchRef={searchRef}
        hasMarker={marker !== null}
        showMarker={showMarker}
        onToggleMarker={() => setShowMarker((v) => !v)}
        drawing={drawing}
        onToggleDraw={() => setDrawing((v) => !v)}
        onResetNorth={handleResetNorth}
        onSaveSettings={handleSaveSettings}
        onResetSettings={handleResetSettings}
        savedFlash={savedFlash}
        zoom={zoom}
        onCapture={captureExport}
        capturing={capturing}
        orbitFilter={orbitFilter}
        onOrbitFilterChange={setOrbitFilter}
        settled={settled}
      />
    </div>
  );
}

// ── Instrument-panel design tokens ─────────────────────────────────────────
const UI = {
  accent: "#7dd3c0",
  accentDim: "rgba(125,211,192,0.16)",
  text: "rgba(236,242,240,0.92)",
  mute: "rgba(236,242,240,0.5)",
  faint: "rgba(236,242,240,0.34)",
  hairline: "rgba(255,255,255,0.09)",
  field: "rgba(255,255,255,0.06)",
  fieldBorder: "rgba(255,255,255,0.16)",
  mono: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
} as const;

const eyebrowStyle: React.CSSProperties = {
  fontFamily: UI.mono,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: UI.faint,
  marginBottom: 6,
};

function Section({
  label,
  children,
  first,
}: {
  label: string;
  children: React.ReactNode;
  first?: boolean;
}) {
  return (
    <div
      style={{
        marginTop: first ? 8 : 9,
        paddingTop: first ? 0 : 8,
        borderTop: first ? "none" : `1px solid ${UI.hairline}`,
      }}
    >
      <div style={eyebrowStyle}>{label}</div>
      {children}
    </div>
  );
}

/**
 * Collapsible folder: a clickable header that shows/hides its children. Replaces
 * the old Find/Look/View tab bar so every group lives on one scrolling page and
 * more than one can be open at a time.
 */
function Group({
  label,
  children,
  defaultOpen,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div
      style={{
        marginTop: 9,
        paddingTop: 9,
        borderTop: `1px solid ${UI.hairline}`,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontFamily: UI.mono,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: open ? UI.accent : UI.text,
        }}
      >
        <span style={{ width: 10, color: UI.mute, fontSize: 10 }}>{open ? "▾" : "▸"}</span>
        {label}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

function Toggle({
  active,
  onClick,
  children,
  title,
  grow,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  grow?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        flex: grow ? 1 : undefined,
        padding: "5px 11px",
        fontFamily: UI.mono,
        fontSize: 12,
        letterSpacing: "0.04em",
        borderRadius: 4,
        border: `1px solid ${active ? UI.accent : UI.fieldBorder}`,
        background: active ? UI.accentDim : "transparent",
        color: active ? UI.accent : UI.text,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

const selectStyle: React.CSSProperties = {
  fontFamily: UI.mono,
  fontSize: 12,
  padding: "5px 7px",
  background: UI.field,
  border: `1px solid ${UI.fieldBorder}`,
  borderRadius: 4,
  color: UI.text,
  cursor: "pointer",
};

/**
 * Segmented date field: MM / DD / 20[YY]. The century is fixed at "20" (all of
 * Sentinel-1's archive is 20xx) and you type only the two-digit year. Commits a
 * clamped YYYY-MM-DD on blur / Enter. No hard era bounds (overridable); the
 * search swaps a reversed range, so from/to don't need linked min/max.
 */
function DateField({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
}) {
  const parse = (v: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    return m ? { mm: m[2], dd: m[3], yy: m[1].slice(2) } : { mm: "", dd: "", yy: "" };
  };
  const [seg, setSeg] = useState(parse(value));
  const lastValue = useRef(value);
  useEffect(() => {
    if (value !== lastValue.current) {
      setSeg(parse(value));
      lastValue.current = value;
    }
  }, [value]);

  const digits = (v: string, n: number) => v.replace(/\D/g, "").slice(0, n);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clampInt = (s: string, lo: number, hi: number, fb: number) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? fb : Math.max(lo, Math.min(hi, n));
  };

  const commit = (next: { mm: string; dd: string; yy: string }) => {
    const m = clampInt(next.mm, 1, 12, 1);
    const yNum = 2000 + clampInt(next.yy, 0, 99, new Date().getFullYear() - 2000);
    const dMax = new Date(yNum, m, 0).getDate(); // last day of month m
    const d = clampInt(next.dd, 1, dMax, 1);
    const iso = `${yNum}-${pad(m)}-${pad(d)}`;
    setSeg({ mm: pad(m), dd: pad(d), yy: pad(yNum % 100) });
    if (iso !== lastValue.current) {
      lastValue.current = iso;
      onChange(iso);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  };
  const segInput: React.CSSProperties = {
    ...selectStyle,
    width: 26,
    padding: "5px 0",
    textAlign: "center",
    cursor: "text",
  };
  const sep = { color: UI.faint, fontFamily: UI.mono, fontSize: 12 } as const;

  return (
    <div
      aria-label={ariaLabel}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 3,
        flex: 1,
        padding: "0 6px",
        background: UI.field,
        border: `1px solid ${UI.fieldBorder}`,
        borderRadius: 4,
        justifyContent: "center",
      }}
    >
      <input
        value={seg.mm}
        onChange={(e) => setSeg((s) => ({ ...s, mm: digits(e.target.value, 2) }))}
        onBlur={() => commit(seg)}
        onKeyDown={onKey}
        onFocus={(e) => e.target.select()}
        inputMode="numeric"
        placeholder="MM"
        aria-label="month"
        style={segInput}
      />
      <span style={sep}>/</span>
      <input
        value={seg.dd}
        onChange={(e) => setSeg((s) => ({ ...s, dd: digits(e.target.value, 2) }))}
        onBlur={() => commit(seg)}
        onKeyDown={onKey}
        onFocus={(e) => e.target.select()}
        inputMode="numeric"
        placeholder="DD"
        aria-label="day"
        style={segInput}
      />
      <span style={sep}>/</span>
      <span style={{ ...sep, color: UI.mute }}>20</span>
      <input
        value={seg.yy}
        onChange={(e) => setSeg((s) => ({ ...s, yy: digits(e.target.value, 2) }))}
        onBlur={() => commit(seg)}
        onKeyDown={onKey}
        onFocus={(e) => e.target.select()}
        inputMode="numeric"
        placeholder="YY"
        aria-label="year"
        style={segInput}
      />
    </div>
  );
}

function StepButton({
  onClick,
  disabled,
  children,
  title,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: 30,
        height: 30,
        flexShrink: 0,
        fontFamily: UI.mono,
        fontSize: 12,
        borderRadius: 4,
        border: `1px solid ${UI.fieldBorder}`,
        background: UI.field,
        color: disabled ? UI.faint : UI.text,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}

/** Dual-thumb range slider (Radix Slider primitive). */
function RangeSlider({
  value,
  min,
  max,
  step = 1,
  minGap = 1,
  onChange,
  onResetLow,
  onResetHigh,
}: {
  value: [number, number];
  min: number;
  max: number;
  step?: number;
  minGap?: number;
  onChange: (v: [number, number]) => void;
  onResetLow?: () => void;
  onResetHigh?: () => void;
}) {
  const minStepsBetweenThumbs = Math.max(1, Math.round(minGap / step));
  return (
    <RadixSlider.Root
      className="range-slider-root"
      value={value}
      min={min}
      max={max}
      step={step}
      minStepsBetweenThumbs={minStepsBetweenThumbs}
      onValueChange={(v) => onChange([v[0], v[1]] as [number, number])}
    >
      <RadixSlider.Track className="range-slider-track">
        <RadixSlider.Range className="range-slider-range" />
      </RadixSlider.Track>
      <RadixSlider.Thumb
        className="range-slider-thumb"
        onDoubleClick={onResetLow}
        aria-label="dB minimum"
      />
      <RadixSlider.Thumb
        className="range-slider-thumb"
        onDoubleClick={onResetHigh}
        aria-label="dB maximum"
      />
    </RadixSlider.Root>
  );
}

/** Labelled single slider with an editable NumBox header. */
function Slider({
  label,
  value,
  min,
  max,
  step = 0.05,
  onChange,
  onReset,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onReset?: () => void;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontFamily: UI.mono, fontSize: 12, color: UI.mute }}>{label}</span>
        <NumBox value={value} min={min} max={max} onChange={onChange} />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={onReset}
        style={{ width: "100%", marginTop: 4, accentColor: UI.accent }}
      />
    </div>
  );
}

function InfoPanel({
  sceneCount,
  totalCount,
  hasLoaded,
  stats,
  search,
  previewMode,
  onTogglePreview,
  onSearchViewport,
  onLoadMostComplete,
  onLoadThisDate,
  pol,
  onPolChange,
  renderMode,
  onRenderModeChange,
  compositePalette,
  onCompositePaletteChange,
  dbRange,
  onDbRangeChange,
  gamma,
  onGammaChange,
  onDramatic,
  dateFrom,
  onDateFromChange,
  dateTo,
  onDateToChange,
  labels,
  onLabelsChange,
  onPickPlace,
  searchRef,
  hasMarker,
  showMarker,
  onToggleMarker,
  drawing,
  onToggleDraw,
  onResetNorth,
  onSaveSettings,
  onResetSettings,
  savedFlash,
  zoom,
  onCapture,
  capturing,
  orbitFilter,
  onOrbitFilterChange,
  settled,
}: {
  sceneCount: number;
  totalCount: number;
  hasLoaded: boolean;
  stats: LoadStats;
  search: SceneSearch;
  previewMode: boolean;
  onTogglePreview: () => void;
  onSearchViewport: () => void;
  onLoadMostComplete: () => void;
  onLoadThisDate: () => void;
  pol: Polarization;
  onPolChange: (p: Polarization) => void;
  renderMode: RenderMode;
  onRenderModeChange: (m: RenderMode) => void;
  compositePalette: CompositePalette;
  onCompositePaletteChange: (p: CompositePalette) => void;
  dbRange: [number, number];
  onDbRangeChange: (r: [number, number]) => void;
  gamma: number;
  onGammaChange: (v: number) => void;
  onDramatic: () => void;
  dateFrom: string;
  onDateFromChange: (v: string) => void;
  dateTo: string;
  onDateToChange: (v: string) => void;
  labels: boolean;
  onLabelsChange: (v: boolean) => void;
  onPickPlace: (r: GeoResult) => void;
  searchRef: React.Ref<HTMLInputElement>;
  hasMarker: boolean;
  showMarker: boolean;
  onToggleMarker: () => void;
  drawing: boolean;
  onToggleDraw: () => void;
  onResetNorth: () => void;
  onSaveSettings: () => void;
  onResetSettings: () => void;
  savedFlash: "" | "saved" | "reset";
  zoom: number;
  onCapture: () => void;
  capturing: boolean;
  orbitFilter: OrbitFilter;
  onOrbitFilterChange: (o: OrbitFilter) => void;
  settled: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const pending = Math.max(0, sceneCount - stats.loaded - stats.failed);
  const { searching, error: searchError, hasSearched, candidates, dates, dateIdx, current, selection } = search;
  const showCoverage = hasSearched && !searching && !searchError && candidates.length > 0;

  const bandLabel = renderMode === "composite" ? "VV+VH" : pol.toUpperCase();
  let statusText: string;
  let statusColor: string = UI.mute;
  if (searchError) {
    statusText = `STAC: ${searchError}`;
    statusColor = "#f0a3a3";
  } else if (searching) {
    statusText = "searching scenes…";
  } else if (hasLoaded) {
    // While loading, show the live pending count; once settled, drop it (the
    // leftover scenes simply had no tiles in view, they aren't stuck).
    statusText = settled
      ? `${sceneCount} ${bandLabel} · ${stats.loaded} drawn · ${stats.failed} failed`
      : `${sceneCount} ${bandLabel} loaded · ${stats.loaded} ok · ${stats.failed} failed · ${pending} pending`;
  } else if (hasSearched) {
    statusText = candidates.length
      ? `${candidates.length} candidates · ${dates.length} date${dates.length === 1 ? "" : "s"} · step and load below`
      : "No Sentinel-1 GRD scenes here for this window. Widen the dates or move the AOI.";
  } else {
    statusText = "Search a date range over an area, then load a mosaic.";
  }

  const copyFailures = () => {
    const text = stats.failures.map((f) => `${f.url}\n  ${f.err}`).join("\n\n");
    navigator.clipboard?.writeText(text).catch(() => {});
  };
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label="expand panel"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: 14,
          left: 14,
          width: 30,
          height: 30,
          padding: 0,
          background: "linear-gradient(180deg, rgba(15,19,25,0.9), rgba(10,13,18,0.86))",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          color: UI.accent,
          border: `1px solid ${UI.hairline}`,
          borderRadius: 8,
          cursor: "pointer",
          fontSize: 13,
          lineHeight: "28px",
          boxShadow: "0 10px 34px rgba(0,0,0,0.5)",
        }}
      >
        ▸
      </button>
    );
  }
  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        top: 14,
        left: 14,
        width: 324,
        maxHeight: "calc(100vh - 28px)",
        overflowY: "auto",
        padding: "12px 16px 0",
        background: "linear-gradient(180deg, rgba(15,19,25,0.82), rgba(10,13,18,0.78))",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        border: `1px solid ${UI.hairline}`,
        borderRadius: 10,
        boxShadow: "0 10px 34px rgba(0,0,0,0.5)",
        color: UI.text,
        fontSize: 12,
        userSelect: "text",
        WebkitUserSelect: "text",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label="collapse"
          style={{
            background: "transparent",
            border: "none",
            color: UI.mute,
            cursor: "pointer",
            padding: 0,
            fontSize: 11,
            width: 12,
          }}
        >
          ▾
        </button>
        <div
          style={{
            flex: 1,
            fontFamily: UI.mono,
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          Sentinel-1 <span style={{ color: UI.accent }}>Explorer</span>
        </div>
      </div>

      {/* Collapsible folders (Find / Look / View) stacked on one scrolling page.
          Each opens independently; Find is open by default. */}
      <Group label="Find" defaultOpen>
      {/* Search: place, date window, look direction, search action */}
      <Section label="Search" first>
        <PlaceSearch ref={searchRef} onPick={onPickPlace} />
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <DateField value={dateFrom} onChange={onDateFromChange} ariaLabel="start date" />
          <span style={{ color: UI.faint }}>→</span>
          <DateField value={dateTo} onChange={onDateToChange} ariaLabel="end date" />
        </div>

        {/* Orbit / look direction: scopes the search. One pass = consistent slope
            shading across the mosaic; BOTH mixes ascending + descending (seams
            hardest). Re-search or re-load after changing. */}
        <div style={{ ...eyebrowStyle, marginTop: 11, marginBottom: 6 }}>look direction</div>
        <div style={{ display: "flex", gap: 6 }}>
          <Toggle active={orbitFilter === null} onClick={() => onOrbitFilterChange(null)} grow
            title="Both passes. Mixing ascending + descending flips slope shading and seams hardest.">
            BOTH
          </Toggle>
          <Toggle active={orbitFilter === "ascending"} onClick={() => onOrbitFilterChange("ascending")} grow
            title="Ascending pass only: one consistent look direction across the mosaic.">
            ASC
          </Toggle>
          <Toggle active={orbitFilter === "descending"} onClick={() => onOrbitFilterChange("descending")} grow
            title="Descending pass only: one consistent look direction across the mosaic.">
            DESC
          </Toggle>
        </div>

        <div style={{ marginTop: 9, display: "flex", gap: 6 }}>
          <Toggle active={searching} onClick={onSearchViewport} grow
            title="Find Sentinel-1 scenes over the current view for this date window">
            {searching ? "SEARCHING…" : "SEARCH VIEW"}
          </Toggle>
          <Toggle active={drawing} onClick={onToggleDraw} title="Drag a rectangle to search a specific AOI">
            {drawing ? "DRAG BOX" : "DRAW AOI"}
          </Toggle>
        </div>
        <div
          style={{
            fontFamily: UI.mono,
            fontSize: 11.5,
            color: statusColor,
            marginTop: 8,
          }}
        >
          {statusText}
        </div>
        {(searching || (hasLoaded && !settled)) && (
          <div className="s1-loadbar" style={{ marginTop: 8 }} aria-label="loading" />
        )}
        {hasLoaded && totalCount > sceneCount && !searchError && (
          <div style={{ fontFamily: UI.mono, fontSize: 11, color: UI.faint, marginTop: 3 }}>
            ({totalCount - sceneCount} loaded scenes lack {renderMode === "composite" ? "both pols" : pol.toUpperCase()})
          </div>
        )}
      </Section>

      {/* Coverage: step through candidate mosaics, load the most complete or one date */}
      {showCoverage && (
        <Section label="Coverage">
          <div style={{ fontFamily: UI.mono, fontSize: 11.5, color: UI.mute }}>
            most complete: {selection.items.length} scene{selection.items.length === 1 ? "" : "s"}
            {" · "}{selection.dates.length} date{selection.dates.length === 1 ? "" : "s"}
            {" · "}{selection.footprintsCovered} frame{selection.footprintsCovered === 1 ? "" : "s"}
          </div>

          {/* Date stepper: toggle through candidate dates, best coverage first */}
          <div style={{ marginTop: 9, display: "flex", alignItems: "center", gap: 6 }}>
            <StepButton onClick={() => search.step(-1)} disabled={dateIdx <= 0} title="Previous date">
              ◀
            </StepButton>
            <div style={{ flex: 1, textAlign: "center" }}>
              <div style={{ fontFamily: UI.mono, fontSize: 13, color: UI.text, letterSpacing: "0.04em" }}>
                {current?.date ?? "—"}
              </div>
              <div style={{ fontFamily: UI.mono, fontSize: 10.5, color: UI.faint, marginTop: 1 }}>
                {dates.length ? `${dateIdx + 1}/${dates.length}` : "0/0"}
                {" · "}{current?.footprints ?? 0} frame{current?.footprints === 1 ? "" : "s"} this date
              </div>
            </div>
            <StepButton onClick={() => search.step(1)} disabled={dateIdx >= dates.length - 1} title="Next date">
              ▶
            </StepButton>
          </div>

          <div style={{ marginTop: 10 }}>
            <Toggle active onClick={onLoadMostComplete} grow
              title="Render the coverage-first mosaic across the whole date window">
              LOAD MOST COMPLETE
            </Toggle>
          </div>
          <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
            <Toggle active={false} onClick={onLoadThisDate} grow
              title="Render only the scenes from the stepped date">
              LOAD THIS DATE
            </Toggle>
            <Toggle active={previewMode} onClick={onTogglePreview}
              title="Show / hide the footprint coverage overlay on the map">
              COVERAGE {previewMode ? "ON" : "OFF"}
            </Toggle>
          </div>
        </Section>
      )}
      </Group>

      <Group label="Look">
      {/* Render: mode + (pol) + dB stretch + gamma. Amplitude = single-pol
          grayscale; Composite = dual-pol VV/VH/ratio false colour. */}
      <Section label={renderMode === "composite" ? "Composite" : "Amplitude"} first>
        {/* Mode switch */}
        <div style={{ display: "flex", gap: 6 }}>
          <Toggle active={renderMode === "amplitude"} onClick={() => onRenderModeChange("amplitude")} grow
            title="Single polarization, grayscale dB. The dramatic relief / texture look.">
            AMPLITUDE
          </Toggle>
          <Toggle active={renderMode === "composite"} onClick={() => onRenderModeChange("composite")} grow
            title="Dual-pol false colour: R=VV, G=VH, B=VV/VH ratio. Needs both pols of a scene.">
            COMPOSITE
          </Toggle>
        </div>

        {/* Polarization: amplitude mode only (composite uses both) */}
        {renderMode === "amplitude" && (
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            {POLARIZATIONS.map((p) => (
              <Toggle key={p} active={pol === p} onClick={() => onPolChange(p)} grow
                title={p === "vv" ? "Co-pol: cleanest terrain / surface look" : "Cross-pol: volume scattering (vegetation, rough)"}>
                {p.toUpperCase()}
              </Toggle>
            ))}
          </div>
        )}

        {/* Composite palette: colourblind-safe (default) vs natural R/G/B */}
        {renderMode === "composite" && (
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <Toggle active={compositePalette === "cbSafe"} onClick={() => onCompositePaletteChange("cbSafe")} grow
              title="Red-green colourblind-safe: VV→brightness, VV/VH ratio→blue↔yellow.">
              CB-SAFE
            </Toggle>
            <Toggle active={compositePalette === "natural"} onClick={() => onCompositePaletteChange("natural")} grow
              title="Standard S1 false colour: R=VV, G=VH, B=VV/VH ratio.">
              NATURAL
            </Toggle>
          </div>
        )}

        {/* Composite legend: what the colours mean (the learning bit), per palette */}
        {renderMode === "composite" && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
            {(compositePalette === "cbSafe"
              ? [
                  ["#facc15", "yellow", "vegetation / volume"],
                  ["#3b82f6", "blue", "smooth surfaces, water"],
                  // Brightness is the VV luminance axis, not a hue: show a dark->bright
                  // ramp so it reads as lightness rather than a single colour chip.
                  ["linear-gradient(90deg, #11151a, #e5e7eb)", "bright", "VV: rough / strong relief"],
                ]
              : [
                  ["#e06666", "R · VV", "rough ground, urban"],
                  ["#7dd37d", "G · VH", "vegetation / volume"],
                  ["#6fa8dc", "B · VV/VH", "smooth surfaces, water"],
                ]
            ).map(([c, k, desc]) => {
              const isRamp = c.includes("gradient");
              return (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: UI.mono, fontSize: 11 }}>
                <span style={{ width: isRamp ? 22 : 9, height: 9, borderRadius: 2, background: c, flexShrink: 0, border: isRamp ? `1px solid ${UI.hairline}` : "none" }} />
                <span style={{ color: UI.text, width: isRamp ? 51 : 64 }}>{k}</span>
                <span style={{ color: UI.faint }}>{desc}</span>
              </div>
              );
            })}
          </div>
        )}

        <div
          style={{
            marginTop: 9,
            padding: "9px 11px 11px",
            border: `1px solid ${UI.hairline}`,
            borderRadius: 8,
            background: "rgba(255,255,255,0.025)",
          }}
        >
          <div style={{ ...eyebrowStyle, color: UI.accent, letterSpacing: "0.1em", marginBottom: 2 }}>
            {renderMode === "composite" ? "VV/VH · dB stretch" : `${pol.toUpperCase()} · dB stretch`}
          </div>

          {/* dB window (two-way stretch). In composite mode this is the VV window;
              VH tracks it shifted down, the ratio window is fixed. */}
          <div style={{ marginTop: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontFamily: UI.mono, fontSize: 12, color: UI.mute }}>
                {renderMode === "composite" ? "VV dB" : "dB range"}
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <NumBox
                  value={dbRange[0]}
                  min={DB_MIN}
                  max={DB_MAX}
                  onChange={(v) => onDbRangeChange([Math.min(v, dbRange[1] - 1), dbRange[1]])}
                />
                <span style={{ color: UI.faint }}>→</span>
                <NumBox
                  value={dbRange[1]}
                  min={DB_MIN}
                  max={DB_MAX}
                  onChange={(v) => onDbRangeChange([dbRange[0], Math.max(v, dbRange[0] + 1)])}
                />
              </span>
            </div>
            <RangeSlider
              value={dbRange}
              min={DB_MIN}
              max={DB_MAX}
              step={1}
              minGap={1}
              onChange={onDbRangeChange}
              onResetLow={() => onDbRangeChange([DEFAULT_DB_RANGE[0], dbRange[1]])}
              onResetHigh={() => onDbRangeChange([dbRange[0], DEFAULT_DB_RANGE[1]])}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontFamily: UI.mono,
                fontSize: 11,
                color: UI.faint,
                marginTop: 2,
              }}
            >
              <span>dark</span>
              <span>bright</span>
            </div>
          </div>

          <Slider
            label="gamma"
            value={gamma}
            min={0.4}
            max={2.6}
            step={0.05}
            onChange={onGammaChange}
            onReset={() => onGammaChange(DEFAULT_GAMMA)}
          />

          {/* DRAMATIC PRESET hidden for now (commented out per request).
          <div style={{ marginTop: 10 }}>
            <Toggle active={false} onClick={onDramatic} grow
              title="High-contrast preset: tighter dB window + raised gamma for inky shadows">
              DRAMATIC PRESET
            </Toggle>
          </div>
          */}
        </div>
      </Section>
      </Group>

      <Group label="View">
      {/* View: labels, north reset, marker, live zoom readout */}
      <Section label="View" first>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <Toggle active={labels} onClick={() => onLabelsChange(!labels)}>
            LABELS {labels ? "ON" : "OFF"}
          </Toggle>
          <Toggle active={false} onClick={onResetNorth} title="Reset to north-up, flat">
            NORTH ↑
          </Toggle>
          {hasMarker && (
            <Toggle active={showMarker} onClick={onToggleMarker}>
              {showMarker ? "HIDE MARKER" : "SHOW MARKER"}
            </Toggle>
          )}
        </div>
        <div style={{ fontFamily: UI.mono, fontSize: 11, color: UI.faint, marginTop: 8 }}>
          zoom {zoom.toFixed(2)} · dpr {window.devicePixelRatio}
        </div>
      </Section>

      {/* Export: grab a PNG of the current map */}
      <Section label="Export">
        <div>
          <Toggle active={capturing} onClick={onCapture} grow
            title="Wait for all scenes to finish loading, then download a PNG of the map (no UI chrome).">
            {capturing ? "CAPTURING…" : "CAPTURE PNG"}
          </Toggle>
        </div>
        {sceneCount === 0 && (
          <div style={{ fontFamily: UI.mono, fontSize: 11, color: UI.faint, marginTop: 6 }}>
            Load a mosaic first; capture grabs what's on the map.
          </div>
        )}
      </Section>

      {/* Session: persist the look + search window + AOI + map view */}
      <Section label="Session">
        <div style={{ display: "flex", gap: 6 }}>
          <Toggle active={savedFlash === "saved"} onClick={onSaveSettings} grow
            title="Remember the look, search window, AOI, and map view for next time">
            {savedFlash === "saved" ? "SAVED ✓" : "SAVE SETTINGS"}
          </Toggle>
          <Toggle active={savedFlash === "reset"} onClick={onResetSettings}
            title="Forget saved settings; restore defaults">
            {savedFlash === "reset" ? "RESET ✓" : "RESET"}
          </Toggle>
        </div>
        <div style={{ fontFamily: UI.mono, fontSize: 11, color: UI.faint, marginTop: 6 }}>
          Saves look, dates, AOI &amp; view to this browser.
        </div>
      </Section>
      </Group>

      {/* Diagnostics: only when something failed to load */}
      {stats.failures.length > 0 && (
        <Section label="Diagnostics">
          <details open style={{ fontSize: 11 }}>
            <summary
              style={{
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontFamily: UI.mono,
                fontSize: 12,
                color: "#f0a3a3",
              }}
            >
              <span>{stats.failures.length} failed</span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  copyFailures();
                }}
                style={{
                  fontFamily: UI.mono,
                  fontSize: 11,
                  padding: "2px 8px",
                  background: UI.field,
                  color: UI.text,
                  border: `1px solid ${UI.fieldBorder}`,
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                copy all
              </button>
            </summary>
            <ul
              style={{
                margin: "8px 0 0 0",
                paddingLeft: 14,
                maxHeight: 200,
                overflow: "auto",
                userSelect: "text",
                WebkitUserSelect: "text",
              }}
            >
              {stats.failures.map((f, i) => (
                <li key={i} style={{ wordBreak: "break-all", marginBottom: 6 }}>
                  <code style={{ fontFamily: UI.mono, fontSize: 10.5, color: UI.mute }}>{f.url}</code>
                  <div style={{ color: UI.faint, marginTop: 2 }}>{f.err}</div>
                </li>
              ))}
            </ul>
          </details>
        </Section>
      )}

      {/* Footer: keyboard hints + condensed provenance */}
      <div
        style={{
          marginTop: 9,
          paddingTop: 8,
          borderTop: `1px solid ${UI.hairline}`,
          fontFamily: UI.mono,
          fontSize: 11,
          lineHeight: 1.4,
        }}
      >
        <div style={{ color: UI.faint, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <span style={{ display: "flex", flexWrap: "wrap", columnGap: 10, rowGap: 3 }}>
            <span><span style={{ color: UI.mute }}>/</span> search</span>
            <span><span style={{ color: UI.mute }}>S</span> this view</span>
            <span><span style={{ color: UI.mute }}>⏎</span> load</span>
            <span><span style={{ color: UI.mute }}>C</span> composite</span>
            <span><span style={{ color: UI.mute }}>B</span> palette</span>
            <span><span style={{ color: UI.mute }}>G</span> grab PNG</span>
            <span><span style={{ color: UI.mute }}>[ ] ←→</span> date</span>
            <span><span style={{ color: UI.mute }}>P</span> pol</span>
            <span><span style={{ color: UI.mute }}>L</span> labels</span>
            <span><span style={{ color: UI.mute }}>D</span> draw</span>
          </span>
          <a
            href="https://github.com/kentstephen/s1-amplitude-explorer"
            target="_blank"
            rel="noreferrer"
            title="This project's source on GitHub"
            style={{ color: UI.mute, display: "inline-flex", alignItems: "center", gap: 4, textDecoration: "none" }}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
            source
          </a>
        </div>
        <div style={{ color: UI.faint, marginTop: 5 }}>
          <a
            href="https://registry.opendata.aws/sentinel-1/"
            target="_blank"
            rel="noreferrer"
            title="Raw Sentinel-1 GRD via Element 84 Earth Search (AWS Open Data)"
            style={{ color: UI.accent, textDecoration: "none" }}
          >
            Sentinel-1 GRD
          </a>{" "}
          · Earth Search · GCP-warped via{" "}
          <a
            href="https://developmentseed.org/deck.gl-raster/"
            target="_blank"
            rel="noreferrer"
            style={{ color: UI.mute, textDecoration: "underline" }}
          >
            deck.gl-raster
          </a>
        </div>
      </div>
      {/* Real bottom gap as flow content: a scroll container's padding-bottom is
          dropped by WebKit when content overflows, so the last line would bleed
          into the rounded edge. A spacer reserves the gap in every engine. */}
      <div aria-hidden style={{ height: 12 }} />
    </div>
  );
}

/** Compact editable number box for slider values; clamps to [min,max] on commit. */
function NumBox({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
    else setText(String(value));
  };
  return (
    <input
      type="number"
      value={text}
      min={min}
      max={max}
      step={1}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      style={{
        width: 52,
        fontFamily: UI.mono,
        fontSize: 12,
        padding: "3px 6px",
        textAlign: "right",
        background: UI.field,
        border: `1px solid ${UI.fieldBorder}`,
        borderRadius: 4,
        color: UI.text,
        outline: "none",
      }}
    />
  );
}

/**
 * Drag-to-draw an AOI rectangle on the map. While `active`, map panning is
 * disabled and a mousedown→drag→mouseup gesture captures two corners as a
 * [W,S,E,N] box. A rubber-band div tracks the drag in screen space.
 */
function DrawBbox({
  mapRef,
  active,
  onComplete,
}: {
  mapRef: React.RefObject<MapRef | null>;
  active: boolean;
  onComplete: (bbox: [number, number, number, number]) => void;
}) {
  const [rect, setRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => {
    if (!active) return;
    const map = mapRef.current?.getMap();
    if (!map) return;

    map.dragPan.disable();
    map.getCanvas().style.cursor = "crosshair";
    let start: { x: number; y: number; lng: number; lat: number } | null = null;

    const down = (e: any) => {
      start = { x: e.point.x, y: e.point.y, lng: e.lngLat.lng, lat: e.lngLat.lat };
      setRect({ x0: e.point.x, y0: e.point.y, x1: e.point.x, y1: e.point.y });
    };
    const move = (e: any) => {
      if (!start) return;
      setRect((r) => (r ? { ...r, x1: e.point.x, y1: e.point.y } : r));
    };
    const up = (e: any) => {
      if (!start) return;
      const w = Math.min(start.lng, e.lngLat.lng);
      const east = Math.max(start.lng, e.lngLat.lng);
      const s = Math.min(start.lat, e.lngLat.lat);
      const n = Math.max(start.lat, e.lngLat.lat);
      start = null;
      setRect(null);
      if (east - w > 1e-4 && n - s > 1e-4) onComplete([w, s, east, n]);
    };

    map.on("mousedown", down);
    map.on("mousemove", move);
    map.on("mouseup", up);
    return () => {
      map.off("mousedown", down);
      map.off("mousemove", move);
      map.off("mouseup", up);
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
    };
  }, [active, mapRef, onComplete]);

  if (!rect) return null;
  const left = Math.min(rect.x0, rect.x1);
  const top = Math.min(rect.y0, rect.y1);
  const width = Math.abs(rect.x1 - rect.x0);
  const height = Math.abs(rect.y1 - rect.y0);
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width,
        height,
        border: "1.5px dashed #ff4d4f",
        background: "rgba(255,77,79,0.12)",
        pointerEvents: "none",
        zIndex: 5,
      }}
    />
  );
}

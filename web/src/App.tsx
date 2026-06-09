import {
  COGLayer,
  MosaicLayer,
  MultiCOGLayer,
} from "@developmentseed/deck.gl-geotiff";
import {
  COLORMAP_INDEX,
  createColormapTexture,
  decodeColormapSprite,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import colormapsPngUrl from "@developmentseed/deck.gl-raster/gpu-modules/colormaps.png";
import { epsgResolver } from "@developmentseed/proj";
import type { GeoTIFF } from "@developmentseed/geotiff";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Device, Texture } from "@luma.gl/core";
import "maplibre-gl/dist/maplibre-gl.css";
import * as RadixSlider from "@radix-ui/react-slider";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Map as MaplibreMap,
  Marker,
  useControl,
} from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";

import { fetchStacItems, type PartialSTACItem } from "./stac";
import {
  reportFailed,
  reportLoaded,
  resetStats,
  subscribeStats,
  type StatsSnapshot,
} from "./loadStats";
import { resultToBbox, type GeoResult } from "./geocode";
import { loadColorPrefs, saveColorPrefs } from "./prefs";
import {
  appendCartoColormaps,
  buildColormapStripe,
  isCartoColormap,
} from "./cartoColormaps";
import { PlaceSearch } from "./PlaceSearch";
import { loadGeoTIFF } from "./loadGeotiff";
import { getTileData, type S2TileData } from "./getTileData";
import { renderTile } from "./renderTile";
import {
  bandSlotsFor,
  buildRenderPipeline,
  DEFAULT_NDVI_COLORMAP,
  DEFAULT_NDVI_RANGE,
  DEFAULT_NDVI_SCALE,
  INDEX_COMPOSITE,
  INDICES,
  INDEX_KEYS,
  isIndexMode,
  NDVI_COLORMAPS,
  type NdviColormap,
  type RenderMode,
} from "./renderPipeline";

// RGB renders the precomposed 8-bit TCI COG via COGLayer; brightness is a
// uniform ScaleColor gain (1.0 = faithful TCI), not a raw-band rescale.
const DEFAULT_RGB_GAIN = 1.0;

/**
 * Module-level cache of opened TCI GeoTIFFs keyed by URL (mirrors the
 * deck.gl-raster naip-mosaic example). Header reads are small; the GeoTIFF
 * instance is reused for the app's lifetime and shared across concurrent
 * callers via the cached promise. Kept outside MosaicLayer's TileLayer cache
 * so cheap header metadata isn't pinned to parent-tile lifetime. Uses our
 * loadGeoTIFF wrapper for the chunkd HEAD-size workaround. Evicts on rejection.
 */
const geotiffCache = new Map<string, Promise<GeoTIFF>>();
function getCachedGeoTIFF(url: string): Promise<GeoTIFF> {
  let p = geotiffCache.get(url);
  if (!p) {
    p = loadGeoTIFF(url).catch((err) => {
      geotiffCache.delete(url);
      throw err;
    });
    geotiffCache.set(url, p);
  }
  return p;
}

// Years with CORS-open coverage on data.source.coop. The STAC collection
// advertises 2018–2021 too but those items are hosted on a non-CORS bucket
// (filtered out by stac.ts CORS_OK_HOSTS).
const AVAILABLE_YEARS = [2022, 2023, 2024] as const;
const DEFAULT_YEAR = 2023;
// Yuma, AZ + margin (lower Colorado River irrigated ag vs Sonoran desert;
// ~32 CORS-open items in 2023)
const STAC_BBOX: [number, number, number, number] = [-115.5, 31.5, -113.0, 33.5];
// Ceiling for the "fetch viewport" AOI span (deg/axis) so a zoomed-out view
// can't enumerate thousands of COGs. Matches geocode.ts's maxSpanDeg.
const MAX_VIEWPORT_SPAN_DEG = 3.0;

// Items are ANNUAL composites (`YYYY-01-01_YYYY+1-01-01`). A full-year query
// also matches the adjacent years' annuals at the Jan-1 boundary, so a tile can
// come back as two overlapping composites. We KEEP that overlap on purpose: a
// no-data hole (cloud) in one year's composite can be backfilled by the other
// through the mosaic (discardBlack lets the lower layer show through). Deduping
// would maximize speed but risk losing coverage.
function yearToDatetime(year: number): string {
  return `${year}-01-01T00:00:00Z/${year}-12-31T23:59:59Z`;
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
  // Cache MultiCOGLayer `sources` records per (mode, source.id) so the SAME
  // object reference is reused across brightness / colormap changes. MultiCOG
  // checks `props.sources !== oldProps.sources` (multi-cog-layer.ts:309) and
  // resets internal state on any mismatch — i.e. reopens GeoTIFFs and refetches
  // tiles. Passing a fresh object each render was forcing a full refetch on
  // every slider tick.
  const sourcesCache = useRef(new Map<string, Record<string, { url: string }>>());
  const modeGen = useRef(0);
  const prevMode = useRef<RenderMode | null>(null);
  // One AbortController per generation. Aborting on mode switch kills the
  // old mode's in-flight band fetches so they stop hogging the (maxRequests-
  // capped) scheduler — otherwise a backlog of pending NDVI reads can starve
  // the new mode's requests and the switch appears to hang.
  const genAbort = useRef<AbortController | null>(null);
  const [labelBeforeId, setLabelBeforeId] = useState<string | undefined>(undefined);
  const [stacItems, setStacItems] = useState<PartialSTACItem[]>([]);
  const [stacError, setStacError] = useState<string | null>(null);
  const [mode, setMode] = useState<RenderMode>("rgb");
  // Look/selection prefs are seeded from localStorage so a reload keeps the
  // user's choices until they change them (persisted by the effect below).
  const initialPrefs = useRef(loadColorPrefs()).current;
  const [year, setYear] = useState<number>(
    (AVAILABLE_YEARS as readonly number[]).includes(initialPrefs.year)
      ? initialPrefs.year
      : DEFAULT_YEAR,
  );
  const [rgbGain, setRgbGain] = useState<number>(initialPrefs.rgbGain);
  const [ndviColormap, setNdviColormap] = useState<NdviColormap>(initialPrefs.ndviColormap);
  const [ndviRange, setNdviRange] = useState<[number, number]>(initialPrefs.ndviRange);
  const [ndviScale, setNdviScale] = useState<number>(initialPrefs.ndviScale);
  const [ndviReversed, setNdviReversed] = useState<boolean>(initialPrefs.ndviReversed);
  const [device, setDevice] = useState<Device | null>(null);
  const [colormapTexture, setColormapTexture] = useState<Texture | null>(null);
  // name → row index in the CARTO-augmented colormap texture. Populated once the
  // sprite decodes; CARTO names resolve to rows appended past the shipped sprite.
  const [colormapIndexMap, setColormapIndexMap] = useState<Record<string, number>>({});
  const [labels, setLabels] = useState(false);
  const [bbox, setBbox] = useState<[number, number, number, number]>(STAC_BBOX);
  const [marker, setMarker] = useState<{ lng: number; lat: number; label: string } | null>(null);
  const [showMarker, setShowMarker] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [stats, setStats] = useState<LoadStats>({ loaded: 0, failed: 0, failures: [] });
  // Live map zoom, mirrored for the on-panel readout (diagnostic).
  const [zoom, setZoom] = useState<number>(9);
  // RGB texture magnification: false = nearest (blocky, honest 10 m pixels),
  // true = linear (smooth interpolation past native zoom). Experiment toggle.
  const [smoothing, setSmoothing] = useState<boolean>(initialPrefs.smoothing);

  // Mirror the module-level load scoreboard into React state.
  useEffect(() => subscribeStats(setStats), []);

  // Persist color/look prefs whenever they change, so they survive a reload.
  useEffect(() => {
    saveColorPrefs({ rgbGain, ndviColormap, ndviRange, ndviScale, ndviReversed, smoothing, year });
  }, [rgbGain, ndviColormap, ndviRange, ndviScale, ndviReversed, smoothing, year]);

  // Keyboard shortcuts (core set). Letter keys are ignored while typing in an
  // input/select; Esc works everywhere (also blurs/clears via the field's own
  // handler). `/` focuses search, `m` marker, `l` labels, `d` draw AOI.
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
      switch (e.key.toLowerCase()) {
        case "/":
          e.preventDefault();
          searchRef.current?.focus();
          break;
        case "m":
          // Summon/hide the marker — only meaningful once one exists.
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

  const mapStyle = labels
    ? "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
    : "https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json";

  // Bump a generation on mode change so the MosaicLayer/MultiCOGLayer ids
  // change, forcing deck.gl to fully unmount the old mode's layer tree
  // instead of leaving stale tile-cache entries that keep rendering + fetching.
  if (prevMode.current !== mode) {
    if (prevMode.current !== null) modeGen.current += 1;
    prevMode.current = mode;
    sourcesCache.current.clear();
    genAbort.current?.abort();
    genAbort.current = new AbortController();
  }
  if (!genAbort.current) genAbort.current = new AbortController();
  const gen = modeGen.current;
  const genSignal = genAbort.current.signal;

  // Load + upload the cividis-bearing colormap sprite once the GPU device exists.
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(colormapsPngUrl);
        const bytes = await resp.arrayBuffer();
        const image = await decodeColormapSprite(bytes);
        if (cancelled) return;
        // Append CARTOColors rows, then upload the combined texture. The CARTO
        // names resolve to row indices past the shipped sprite's 107 rows.
        const { image: merged, index: cartoIndex } = appendCartoColormaps(image);
        setColormapIndexMap({ ...COLORMAP_INDEX, ...cartoIndex });
        setColormapTexture(createColormapTexture(device, merged));
      } catch (err) {
        console.error("[colormap] failed to load sprite:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [device]);

  // Fresh scoreboard whenever the source set changes (AOI / year) or the render
  // mode switches — stale per-AOI counts would otherwise carry over.
  useEffect(() => resetStats(), [bbox, year, mode]);

  useEffect(() => {
    const ac = new AbortController();
    setStacItems([]);
    setStacError(null);
    // Debounce: rapid bbox changes (draw-tool drags, repeated searches) would
    // otherwise kick off overlapping /search paginations against the public
    // STAC API. Wait for the AOI to settle before fetching.
    const t = setTimeout(() => {
      fetchStacItems({ datetime: yearToDatetime(year), bbox, signal: ac.signal })
        .then(({ items, rejected }) => {
          setStacItems(items);
          console.info(`[stac] ${items.length} items for ${year} (${rejected} CORS-blocked)`);
          if (items.length === 0) {
            setStacError(
              rejected > 0
                ? `No CORS-open imagery here — ${rejected} item${rejected > 1 ? "s" : ""} exist but are on a CORS-blocked host. Try the Americas or Europe.`
                : "No imagery for this area/year.",
            );
          }
        })
        .catch((err) => {
          if (err.name !== "AbortError") {
            console.error("[stac] fetch failed:", err);
            setStacError(String(err.message ?? err));
          }
        });
    }, 400);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [year, bbox]);

  // Box drawn on the map (item 5): the [W,S,E,N] becomes the new STAC AOI,
  // mirroring lonboard's `selected_bounds`. No marker — the box is its own cue.
  const handleDrawBox = (bb: [number, number, number, number]) => {
    setBbox(bb);
    setMarker(null);
    setDrawing(false);
  };

  // "Fetch viewport": set the STAC AOI to whatever's currently in view, with a
  // small buffer so items overlapping the edges are included. Span is clamped
  // (MAX_VIEWPORT_SPAN_DEG) so a zoomed-out view can't fan out into thousands of
  // COG opens. Drives the same debounced /search as draw/geocode.
  const handleFetchViewport = () => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const b = map.getBounds();
    let w = b.getWest();
    let s = b.getSouth();
    let e = b.getEast();
    let n = b.getNorth();
    const margin = 0.1; // 10% buffer beyond the visible edges
    const dw = (e - w) * margin;
    const dh = (n - s) * margin;
    w -= dw; e += dw; s -= dh; n += dh;
    // Clamp each axis span to the ceiling, keeping the viewport center.
    const cx = (w + e) / 2;
    const cy = (s + n) / 2;
    const maxHalf = MAX_VIEWPORT_SPAN_DEG / 2;
    const halfW = Math.min((e - w) / 2, maxHalf);
    const halfH = Math.min((n - s) / 2, maxHalf);
    setMarker(null);
    setBbox([cx - halfW, cy - halfH, cx + halfW, cy + halfH]);
  };

  // Snap the map back to plan view: bearing → north, pitch → flat.
  const handleResetNorth = () => {
    mapRef.current?.getMap()?.easeTo({ bearing: 0, pitch: 0, duration: 400 });
  };

  const handlePickPlace = (r: GeoResult) => {
    const bb = resultToBbox(r);
    setBbox(bb);
    // Marker exists after a geocode but stays HIDDEN — the user reveals it via
    // SHOW MARKER / `M`. Do not auto-show on search.
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

  const layers = useMemo(() => {
    if (stacItems.length === 0) return [];

    // RGB: render the single precomposed 3-band TCI COG per item through
    // COGLayer (the deck.gl-raster naip-mosaic pattern). One COG per item, so
    // no cross-band-file misregistration — this is what kills the seams that
    // the old MultiCOGLayer (separate B04/B03/B02 files) produced. See
    // docs/SEAMS.md.
    if (mode === "rgb") {
      const mosaic = new MosaicLayer<PartialSTACItem, GeoTIFF>({
        id: `s2-mosaic-rgb-${gen}`,
        sources: stacItems,
        maxCacheSize: 0,
        getSource: (source) => {
          const url = source.assets.visual.href;
          return getCachedGeoTIFF(url).then(
            (g) => {
              reportLoaded(url);
              return g;
            },
            (e) => {
              reportFailed(url, e instanceof Error ? e.message : String(e));
              throw e;
            },
          );
        },
        renderSource: (source, { data }) =>
          new COGLayer<S2TileData>({
            // Smoothing is baked into each tile's texture sampler, so the id
            // includes it — toggling forces deck to rebuild tiles with the new
            // filter rather than reusing the cached (wrong-sampler) textures.
            id: `s2-cog-rgb-${gen}-${smoothing ? "lin" : "near"}-${source.id}`,
            geotiff: data,
            epsgResolver,
            getTileData: (image: any, opts: any) =>
              getTileData(image, opts, smoothing ? "linear" : "nearest"),
            renderTile: (tileData: S2TileData) => renderTile(tileData, rgbGain),
            signal: genSignal,
            refinementStrategy: "best-available",
            maxRequests: 16,
            // ScaleColor gain is closed over rgbGain; retrigger the cached
            // per-tile renderPipeline when it changes.
            updateTriggers: { renderTile: [rgbGain] },
          } as any),
        // @ts-expect-error beforeId is injected by @deck.gl/mapbox
        beforeId: labelBeforeId,
      });
      return [mosaic];
    }

    // Spectral indices: need a 2-band ratio, so keep the MultiCOGLayer composite
    // path. Normalized-difference indices are seam-free (the ratio cancels
    // per-edge brightness offsets).
    if (!colormapTexture) return [];

    const bandSlots = bandSlotsFor(mode);
    const composite = INDEX_COMPOSITE;
    const pipeline = buildRenderPipeline(mode, colormapTexture, {
      ndviColormap,
      colormapIndex: colormapIndexMap[ndviColormap],
      ndviRange,
      ndviScale,
      ndviReversed,
    });

    const mosaic = new MosaicLayer<PartialSTACItem, null>({
      id: `s2-mosaic-${mode}-${gen}`,
      sources: stacItems,
      // Cache full MultiCOGLayer instances minimally — keeps stale per-mode
      // sublayers from lingering across a mode switch.
      maxCacheSize: 0,
      // MultiCOGLayer fetches its own GeoTIFFs; MosaicLayer only needs each
      // item's bbox (used internally for spatial indexing).
      getSource: async () => null,
      renderSource: (source) => {
        const cacheKey = `${mode}-${source.id}`;
        let sources = sourcesCache.current.get(cacheKey);
        if (!sources) {
          sources = Object.fromEntries(
            Object.entries(bandSlots).map(([slot, bandKey]) => [
              slot,
              { url: source.assets[bandKey].href },
            ]),
          );
          sourcesCache.current.set(cacheKey, sources);
        }
        return new MultiCOGLayer({
          id: `s2-multi-${mode}-${gen}-${source.id}`,
          sources,
          composite,
          renderPipeline: pipeline,
          epsgResolver,
          signal: genSignal,
          // See docs/PERF_KNOBS.md for the full menu + drawbacks.
          refinementStrategy: "best-available",
          maxRequests: 16,
          // Inner RasterTileLayer caches each tile's renderPipeline result
          // (raster-tile-layer.ts:338 wires renderTile → renderSubLayers).
          // Without this, colormap prop changes never reach already-rendered
          // tiles.
          updateTriggers: {
            renderTile: [mode, ndviColormap, ndviRange[0], ndviRange[1], ndviScale, ndviReversed, colormapTexture],
          },
        } as any);
      },
      // @ts-expect-error beforeId is injected by @deck.gl/mapbox
      beforeId: labelBeforeId,
    });
    return [mosaic];
  }, [stacItems, labelBeforeId, mode, gen, colormapTexture, colormapIndexMap, rgbGain, smoothing, ndviColormap, ndviRange, ndviScale, ndviReversed]);

  const initialViewState = {
    longitude: -114.6,
    latitude: 32.7,
    zoom: 9,
    pitch: 0,
    bearing: 0,
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MaplibreMap
        ref={mapRef}
        initialViewState={initialViewState}
        minZoom={3}
        onMove={(e) => setZoom(e.viewState.zoom)}
        // attributionControl={false}  // comment out to re-enable the (i) badge bottom-right
        attributionControl={false}
        mapStyle={mapStyle}
        onLoad={(e) => {
          const map = e.target;
          const ls = map.getStyle()?.layers ?? [];
          const firstSymbol = ls.find((l: any) => l.type === "symbol");
          setLabelBeforeId(firstSymbol?.id);
          // Re-derive the label insertion point whenever the style reloads
          // (e.g. toggling the labels basemap) so imagery stays under labels.
          map.on("styledata", () => {
            const layers = map.getStyle()?.layers ?? [];
            const sym = layers.find((l: any) => l.type === "symbol");
            setLabelBeforeId(sym?.id);
          });
          // Marker is transient orientation context: auto-hide it the moment
          // the user pans/zooms. `e.originalEvent` is set only for user-driven
          // moves, so our programmatic flyTo (on search) doesn't dismiss it.
          map.on("movestart", (ev: any) => {
            if (ev.originalEvent) setShowMarker(false);
          });
        }}
      >
        <DeckGLOverlay layers={layers} onDevice={setDevice} />
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
        sourceCount={stacItems.length}
        year={year}
        availableYears={AVAILABLE_YEARS}
        onYearChange={setYear}
        error={stacError}
        stats={stats}
        mode={mode}
        onModeChange={setMode}
        rgbGain={rgbGain}
        onRgbGainChange={setRgbGain}
        ndviColormap={ndviColormap}
        onNdviColormapChange={setNdviColormap}
        ndviRange={ndviRange}
        onNdviRangeChange={setNdviRange}
        ndviScale={ndviScale}
        onNdviScaleChange={setNdviScale}
        ndviReversed={ndviReversed}
        onNdviReversedChange={setNdviReversed}
        labels={labels}
        onLabelsChange={setLabels}
        onPickPlace={handlePickPlace}
        searchRef={searchRef}
        hasMarker={marker !== null}
        showMarker={showMarker}
        onToggleMarker={() => setShowMarker((v) => !v)}
        drawing={drawing}
        onToggleDraw={() => setDrawing((v) => !v)}
        onFetchViewport={handleFetchViewport}
        onResetNorth={handleResetNorth}
        zoom={zoom}
        smoothing={smoothing}
        onSmoothingChange={setSmoothing}
      />
    </div>
  );
}

// ── Instrument-panel design tokens ─────────────────────────────────────────
// A refined dark "satellite readout" surface: glass background, hairline
// section rules, a single spectral-teal accent for active/interactive state,
// and IBM Plex Mono for the technical labels/values.
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
  marginBottom: 8,
};

/** A grouped block with a quiet uppercase eyebrow label and a top hairline. */
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
        marginTop: first ? 10 : 11,
        paddingTop: first ? 0 : 10,
        borderTop: first ? "none" : `1px solid ${UI.hairline}`,
      }}
    >
      <div style={eyebrowStyle}>{label}</div>
      {children}
    </div>
  );
}

/** Consistent pill toggle; accent fill when active. */
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

/** Dual-thumb range slider built on Radix Slider primitive. The Radix root
 *  owns both thumbs and a single track, so the two thumbs never compete for
 *  hit-testing or repaint order the way two stacked <input type="range"> do. */
function RangeSlider({
  value,
  min,
  max,
  step = 0.05,
  minGap = 0.05,
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
        aria-label="range minimum"
      />
      <RadixSlider.Thumb
        className="range-slider-thumb"
        onDoubleClick={onResetHigh}
        aria-label="range maximum"
      />
    </RadixSlider.Root>
  );
}

/** Labelled slider with an editable NumBox header. */
function Slider({
  label,
  value,
  min,
  max,
  step = 0.05,
  onChange,
  onReset,
  box,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onReset?: () => void;
  box?: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontFamily: UI.mono, fontSize: 12, color: UI.mute }}>{label}</span>
        {box ?? <NumBox value={value} min={min} max={max} onChange={onChange} />}
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
  sourceCount,
  year,
  availableYears,
  onYearChange,
  error,
  stats,
  mode,
  onModeChange,
  rgbGain,
  onRgbGainChange,
  ndviColormap,
  onNdviColormapChange,
  ndviRange,
  onNdviRangeChange,
  ndviScale,
  onNdviScaleChange,
  ndviReversed,
  onNdviReversedChange,
  labels,
  onLabelsChange,
  onPickPlace,
  searchRef,
  hasMarker,
  showMarker,
  onToggleMarker,
  drawing,
  onToggleDraw,
  onFetchViewport,
  onResetNorth,
  zoom,
  smoothing,
  onSmoothingChange,
}: {
  sourceCount: number;
  year: number | null;
  availableYears: readonly number[];
  onYearChange: (y: number) => void;
  error: string | null;
  stats: LoadStats;
  mode: RenderMode;
  onModeChange: (m: RenderMode) => void;
  rgbGain: number;
  onRgbGainChange: (v: number) => void;
  ndviColormap: NdviColormap;
  onNdviColormapChange: (c: NdviColormap) => void;
  ndviRange: [number, number];
  onNdviRangeChange: (r: [number, number]) => void;
  ndviScale: number;
  onNdviScaleChange: (s: number) => void;
  ndviReversed: boolean;
  onNdviReversedChange: (v: boolean) => void;
  labels: boolean;
  onLabelsChange: (v: boolean) => void;
  onPickPlace: (r: GeoResult) => void;
  searchRef: React.Ref<HTMLInputElement>;
  hasMarker: boolean;
  showMarker: boolean;
  onToggleMarker: () => void;
  drawing: boolean;
  onToggleDraw: () => void;
  onFetchViewport: () => void;
  onResetNorth: () => void;
  zoom: number;
  smoothing: boolean;
  onSmoothingChange: (v: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const pending = Math.max(0, sourceCount - stats.loaded - stats.failed);
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
        // Cap to the viewport and scroll internally so the tall spectral-index
        // panel fits on screen instead of spilling past the bottom edge.
        maxHeight: "calc(100vh - 28px)",
        overflowY: "auto",
        padding: "14px 16px 12px",
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
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          Sentinel-2 <span style={{ color: UI.accent }}>Mosaic</span>
        </div>
        <select
          value={year ?? ""}
          onChange={(e) => onYearChange(Number(e.target.value))}
          style={selectStyle}
        >
          {availableYears.map((y) => (
            <option key={y} value={y} style={{ background: "#15191f" }}>
              {y}
            </option>
          ))}
        </select>
      </div>

      {/* Area: search, coverage status, view toggles */}
      <Section label="Area" first>
        <PlaceSearch ref={searchRef} onPick={onPickPlace} />
        <div
          style={{
            fontFamily: UI.mono,
            fontSize: 11.5,
            color: error ? "#f0a3a3" : UI.mute,
            marginTop: 8,
          }}
        >
          {error
            ? `STAC error: ${error}`
            : sourceCount === 0
              ? "loading STAC items…"
              : `${sourceCount} sources · ${stats.loaded} loaded · ${stats.failed} failed · ${pending} pending`}
        </div>
        <div
          style={{
            fontFamily: UI.mono,
            fontSize: 11.5,
            color: UI.accent,
            marginTop: 4,
          }}
        >
          zoom {zoom.toFixed(2)} · dpr {window.devicePixelRatio}
        </div>
        <div style={{ marginTop: 9, display: "flex", flexWrap: "wrap", gap: 6 }}>
          <Toggle
            active={drawing}
            onClick={onToggleDraw}
            title="Drag a rectangle on the map to set the area of interest"
          >
            {drawing ? "DRAW: DRAG BOX" : "DRAW AOI"}
          </Toggle>
          <Toggle
            active={false}
            onClick={onFetchViewport}
            title="Load imagery for the current map view (with a small buffer)"
          >
            FETCH VIEW
          </Toggle>
          <Toggle active={labels} onClick={() => onLabelsChange(!labels)}>
            LABELS {labels ? "ON" : "OFF"}
          </Toggle>
          <Toggle
            active={false}
            onClick={onResetNorth}
            title="Reset map to north-up, flat (bearing 0, pitch 0)"
          >
            NORTH ↑
          </Toggle>
          {hasMarker && (
            <Toggle active={showMarker} onClick={onToggleMarker}>
              {showMarker ? "HIDE MARKER" : "SHOW MARKER"}
            </Toggle>
          )}
        </div>
      </Section>

      {/* Render: mode selector + a bounded card for the active mode's params */}
      <Section label="Render">
        <div style={{ display: "flex", gap: 6 }}>
          <Toggle active={mode === "rgb"} onClick={() => onModeChange("rgb")}>
            RGB
          </Toggle>
          <select
            value={isIndexMode(mode) ? mode : ""}
            onChange={(e) => onModeChange(e.target.value as RenderMode)}
            style={{ ...selectStyle, flex: 1, textTransform: "uppercase" }}
          >
            <option value="" disabled style={{ background: "#15191f" }}>
              spectral index…
            </option>
            {INDEX_KEYS.map((k) => (
              <option key={k} value={k} style={{ background: "#15191f" }}>
                {INDICES[k].label} · {INDICES[k].desc}
              </option>
            ))}
          </select>
        </div>

        <div
          style={{
            marginTop: 10,
            padding: "9px 11px 11px",
            border: `1px solid ${UI.hairline}`,
            borderRadius: 8,
            background: "rgba(255,255,255,0.025)",
          }}
        >
          <div
            style={{
              ...eyebrowStyle,
              color: UI.accent,
              letterSpacing: "0.1em",
              marginBottom: 2,
            }}
          >
            {mode === "rgb"
              ? "RGB · true color"
              : `${INDICES[mode].label} · ${INDICES[mode].desc}`}
          </div>

          {mode === "rgb" && (
            <>
              <Slider
                label="brightness"
                value={rgbGain}
                min={0.4}
                max={2.5}
                onChange={onRgbGainChange}
                onReset={() => onRgbGainChange(DEFAULT_RGB_GAIN)}
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
                <span>darker</span>
                <span>brighter</span>
              </div>
              <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
                <Toggle
                  active={smoothing}
                  onClick={() => onSmoothingChange(!smoothing)}
                  title="Linear texture filtering: smooths magnified pixels past native 10 m zoom (interpolation, not added detail)"
                >
                  SMOOTH {smoothing ? "ON" : "OFF"}
                </Toggle>
                <span style={{ fontFamily: UI.mono, fontSize: 10.5, color: UI.faint }}>
                  (when zoomed in)
                </span>
              </div>
            </>
          )}

          {isIndexMode(mode) && (
            <>
              <div style={{ marginTop: 8 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ fontFamily: UI.mono, fontSize: 12, color: UI.mute }}>
                    range
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <NumBox
                      value={ndviRange[0]}
                      min={-1}
                      max={1}
                      onChange={(v) =>
                        onNdviRangeChange([Math.min(v, ndviRange[1] - 0.05), ndviRange[1]])
                      }
                    />
                    <span style={{ color: UI.faint }}>→</span>
                    <NumBox
                      value={ndviRange[1]}
                      min={-1}
                      max={1}
                      onChange={(v) =>
                        onNdviRangeChange([ndviRange[0], Math.max(v, ndviRange[0] + 0.05)])
                      }
                    />
                  </span>
                </div>
                <RangeSlider
                  value={ndviRange}
                  min={-1}
                  max={1}
                  step={0.05}
                  onChange={onNdviRangeChange}
                  onResetLow={() => onNdviRangeChange([DEFAULT_NDVI_RANGE[0], ndviRange[1]])}
                  onResetHigh={() => onNdviRangeChange([ndviRange[0], DEFAULT_NDVI_RANGE[1]])}
                />
              </div>
              <Slider
                label="darken"
                value={ndviScale}
                min={0.2}
                max={1.5}
                onChange={onNdviScaleChange}
                onReset={() => onNdviScaleChange(DEFAULT_NDVI_SCALE)}
              />
              <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
                <select
                  value={ndviColormap}
                  onChange={(e) => onNdviColormapChange(e.target.value as NdviColormap)}
                  style={{ ...selectStyle, flex: 1, textTransform: "uppercase" }}
                >
                  {NDVI_COLORMAPS.map((c) => (
                    <option key={c} value={c} style={{ background: "#15191f" }}>
                      {c}
                    </option>
                  ))}
                </select>
                <Toggle
                  active={ndviReversed}
                  onClick={() => onNdviReversedChange(!ndviReversed)}
                  title="Reverse the colormap direction"
                >
                  REVERSE
                </Toggle>
              </div>
              <ColormapBar name={ndviColormap} reversed={ndviReversed} />
            </>
          )}
        </div>
      </Section>

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
                  <code
                    style={{
                      fontFamily: UI.mono,
                      fontSize: 10.5,
                      color: UI.mute,
                      userSelect: "all",
                      WebkitUserSelect: "all",
                    }}
                  >
                    {f.url}
                  </code>
                  <div style={{ color: UI.faint, marginTop: 2 }}>{f.err}</div>
                </li>
              ))}
            </ul>
          </details>
        </Section>
      )}

      {/* Footer: provenance */}
      <div
        style={{
          marginTop: 10,
          paddingTop: 9,
          borderTop: `1px solid ${UI.hairline}`,
          fontFamily: UI.mono,
          fontSize: 11,
          lineHeight: 1.45,
        }}
      >
        <div style={{ color: UI.faint }}>
          <span style={{ color: UI.mute }}>/</span> search&nbsp;&nbsp;
          <span style={{ color: UI.mute }}>M</span> marker&nbsp;&nbsp;
          <span style={{ color: UI.mute }}>L</span> labels&nbsp;&nbsp;
          <span style={{ color: UI.mute }}>D</span> draw
        </div>
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 12 }}>
          <a
            href="https://github.com/kentstephen/sentinel-2-cog-deckgl-raster"
            target="_blank"
            rel="noreferrer"
            title="This project's source on GitHub"
            style={{
              color: UI.mute,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              textDecoration: "none",
            }}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
            View source
          </a>
        </div>
        <div style={{ color: UI.faint, marginTop: 4 }}>
          Data:{" "}
          <a
            href="https://source.coop/earthgenome/sentinel2-temporal-mosaics"
            target="_blank"
            rel="noreferrer"
            title="Earth Genome Sentinel-2 Temporal Mosaics on Source Cooperative"
            style={{ color: UI.accent, textDecoration: "none" }}
          >
            Sentinel-2 Temporal Mosaics
          </a>{" "}
          by{" "}
          <a
            href="https://www.earthgenome.org"
            target="_blank"
            rel="noreferrer"
            style={{ color: UI.mute, textDecoration: "underline" }}
          >
            Earth Genome
          </a>{" "}
          on{" "}
          <a
            href="https://source.coop"
            target="_blank"
            rel="noreferrer"
            title="Source Cooperative"
            style={{ color: UI.mute, textDecoration: "underline" }}
          >
            Source Coop
          </a>
        </div>
        <div style={{ color: UI.faint, marginTop: 4 }}>
          Built with{" "}
          <a
            href="https://developmentseed.org/deck.gl-raster/"
            target="_blank"
            rel="noreferrer"
            style={{ color: UI.mute, textDecoration: "underline" }}
          >
            deck.gl-raster
          </a>{" "}
          by{" "}
          <a
            href="https://developmentseed.org"
            target="_blank"
            rel="noreferrer"
            style={{ color: UI.mute, textDecoration: "underline" }}
          >
            Development Seed
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact editable number box (kepler-style) for slider values. Commits any
 * parseable number through `onChange`; clamps to [min, max] on commit.
 */
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
  const [text, setText] = useState(value.toFixed(2));
  // Keep the field in sync when the value changes elsewhere (slider, reset).
  useEffect(() => setText(value.toFixed(2)), [value]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
    else setText(value.toFixed(2));
  };
  return (
    <input
      type="number"
      value={text}
      min={min}
      max={max}
      step={0.05}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      style={{
        width: 56,
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
 * Horizontal reference bar for the active colormap. Draws row `index` of the
 * shipped 256×107 `colormaps.png` sprite (1px per colormap) stretched to the
 * bar width; flips horizontally when `reversed` so it matches what the shader
 * renders (`Colormap.reversed`).
 */
function ColormapBar({ name, reversed }: { name: NdviColormap; reversed: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // CARTO palettes aren't in the sprite PNG — paint them straight from the
    // interpolated 256-px stripe so the bar matches what the texture renders.
    if (isCartoColormap(name)) {
      const stripe = buildColormapStripe(name);
      const off = new OffscreenCanvas(256, 1);
      const offCtx = off.getContext("2d")!;
      const src = offCtx.createImageData(256, 1);
      src.data.set(stripe);
      offCtx.putImageData(src, 0, 0);
      ctx.save();
      if (reversed) {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, 256, 1, 0, 0, canvas.width, canvas.height);
      ctx.restore();
      return;
    }

    const img = new Image();
    img.src = colormapsPngUrl;
    img.onload = () => {
      const row = COLORMAP_INDEX[name as keyof typeof COLORMAP_INDEX];
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      if (reversed) {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(img, 0, row, 256, 1, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    };
  }, [name, reversed]);
  return (
    <canvas
      ref={ref}
      width={256}
      height={12}
      style={{
        marginTop: 5,
        width: "100%",
        height: 12,
        borderRadius: 3,
        display: "block",
        border: "1px solid rgba(255,255,255,0.15)",
      }}
    />
  );
}

/**
 * Drag-to-draw an AOI rectangle on the map (item 5; lonboard `selected_bounds`
 * pattern). While `active`, map panning is disabled and a mousedown→drag→mouseup
 * gesture captures two corners. maplibre hands us `e.lngLat` directly, so we
 * build the [W,S,E,N] box from the two corner lng/lats — no unproject needed.
 * A rubber-band div tracks the drag in screen space. Tiny boxes (a stray click)
 * are ignored.
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


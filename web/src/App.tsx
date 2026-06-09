import { MosaicLayer } from "@developmentseed/deck.gl-geotiff";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Device } from "@luma.gl/core";
import "maplibre-gl/dist/maplibre-gl.css";
import * as RadixSlider from "@radix-ui/react-slider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map as MaplibreMap, Marker, useControl } from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";

import { fetchStacItems, type PartialSTACItem, type Polarization } from "./stac";
import {
  reportFailed,
  reportLoaded,
  resetStats,
  subscribeStats,
} from "./loadStats";
import { resultToBbox, type GeoResult } from "./geocode";
import { loadLookPrefs, saveLookPrefs } from "./prefs";
import { PlaceSearch } from "./PlaceSearch";
import { GcpMultiCOGLayer } from "./GcpMultiCOGLayer";
import {
  AMP_COMPOSITE,
  buildRenderPipeline,
  DB_MAX,
  DB_MIN,
  DEFAULT_DB_RANGE,
  DEFAULT_GAMMA,
  DRAMATIC_DB_RANGE,
  DRAMATIC_GAMMA,
  POLARIZATIONS,
} from "./renderPipeline";

// Aconcagua / central Andes: steep relief, the canonical dramatic-SAR demo.
// Tight AOI so the first warp renders one well-understood GRD scene.
const DEFAULT_BBOX: [number, number, number, number] = [-70.3, -32.9, -69.8, -32.5];
// ~1-week window ending on the verified Andes VV/VH IW GRD scene (2026-06-05;
// see docs/PLAN.md, S1A_IW_GRDH_1SDV_20260605T232821...). A week (not a single
// day) so FETCH VIEW finds an overpass after you pan elsewhere; the load stays
// bounded by maxItems regardless of how many scenes the window contains.
const DEFAULT_DATE_FROM = "2026-05-30";
const DEFAULT_DATE_TO = "2026-06-05";
// Ceiling for the "fetch viewport" AOI span (deg/axis) so a zoomed-out view
// can't enumerate hundreds of ~700 MB COGs.
const MAX_VIEWPORT_SPAN_DEG = 3.0;

function datetimeOf(from: string, to: string): string {
  return `${from}T00:00:00Z/${to}T23:59:59Z`;
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
  // One AbortController per generation; aborting on pol switch kills the old
  // pol's in-flight band fetches so they don't starve the new pol's requests.
  const genAbort = useRef<AbortController | null>(null);
  // Aborts the in-flight STAC search when a new manual fetch supersedes it.
  const fetchAbort = useRef<AbortController | null>(null);

  const [labelBeforeId, setLabelBeforeId] = useState<string | undefined>(undefined);
  const [stacItems, setStacItems] = useState<PartialSTACItem[]>([]);
  const [stacError, setStacError] = useState<string | null>(null);
  // Fetching is MANUAL: nothing loads until the user hits FETCH VIEW or draws an
  // AOI. `hasFetched` distinguishes the idle first-run state from an empty result.
  const [fetching, setFetching] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  const initialPrefs = useRef(loadLookPrefs()).current;
  const [pol, setPol] = useState<Polarization>(initialPrefs.pol);
  const [dbRange, setDbRange] = useState<[number, number]>(initialPrefs.dbRange);
  const [gamma, setGamma] = useState<number>(initialPrefs.gamma);

  // Device is initialized by the deck overlay; kept for parity / future GPU work.
  const [, setDevice] = useState<Device | null>(null);

  const [labels, setLabels] = useState(false);
  const [bbox, setBbox] = useState<[number, number, number, number]>(DEFAULT_BBOX);
  const [dateFrom, setDateFrom] = useState(DEFAULT_DATE_FROM);
  const [dateTo, setDateTo] = useState(DEFAULT_DATE_TO);
  const [marker, setMarker] = useState<{ lng: number; lat: number; label: string } | null>(null);
  const [showMarker, setShowMarker] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [stats, setStats] = useState<LoadStats>({ loaded: 0, failed: 0, failures: [] });
  const [zoom, setZoom] = useState<number>(8);

  // Mirror the module-level load scoreboard into React state.
  useEffect(() => subscribeStats(setStats), []);

  // Persist look prefs whenever they change.
  useEffect(() => {
    saveLookPrefs({ pol, dbRange, gamma });
  }, [pol, dbRange, gamma]);

  // Keyboard shortcuts. Letter keys ignored while typing; `/` search, `p` swap
  // polarization, `l` labels, `d` draw AOI, `m` marker.
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

  // Bump a generation on pol change so the layer ids change, forcing deck.gl to
  // unmount the old pol's tiles instead of leaving stale fetching tiles behind.
  if (prevPol.current !== pol) {
    if (prevPol.current !== null) polGen.current += 1;
    prevPol.current = pol;
    sourcesCache.current.clear();
    genAbort.current?.abort();
    genAbort.current = new AbortController();
  }
  if (!genAbort.current) genAbort.current = new AbortController();
  const gen = polGen.current;
  const genSignal = genAbort.current.signal;

  // Fresh scoreboard on pol switch (layers remount and reload under the new pol).
  useEffect(() => resetStats(), [pol]);

  // Abort any in-flight search when the component unmounts.
  useEffect(() => () => fetchAbort.current?.abort(), []);

  /**
   * The single, explicit STAC fetch. Nothing calls this on load, on geocode, or
   * on a date edit. Only FETCH VIEW and DRAW AOI invoke it, each passing the AOI
   * directly so we never race React state. The current date window is read live.
   */
  const runFetch = useCallback(
    (targetBbox: [number, number, number, number]) => {
      fetchAbort.current?.abort();
      const ac = new AbortController();
      fetchAbort.current = ac;
      setBbox(targetBbox);
      setStacError(null);
      setFetching(true);
      setHasFetched(true);
      resetStats();
      fetchStacItems({
        datetime: datetimeOf(dateFrom, dateTo),
        bbox: targetBbox,
        maxItems: 3,
        signal: ac.signal,
      })
        .then(({ items, rejected }) => {
          if (ac.signal.aborted) return;
          setStacItems(items);
          console.info(`[stac] ${items.length} S1 GRD scenes (${rejected} unusable)`);
          if (items.length === 0) {
            setStacError("No Sentinel-1 GRD scenes here for this date window. Widen the dates or move the AOI, then fetch again.");
          }
        })
        .catch((err) => {
          if (err.name !== "AbortError") {
            console.error("[stac] fetch failed:", err);
            setStacError(String(err.message ?? err));
          }
        })
        .finally(() => {
          if (fetchAbort.current === ac) setFetching(false);
        });
    },
    [dateFrom, dateTo],
  );

  const handleDrawBox = (bb: [number, number, number, number]) => {
    setMarker(null);
    setDrawing(false);
    runFetch(bb); // drawing an AOI is an explicit "load scenes here"
  };

  // FETCH VIEW: build an AOI from the current view + small buffer, clamped so a
  // zoomed-out view can't fan out into hundreds of COG opens, then fetch it.
  const handleFetchViewport = () => {
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
    setMarker(null);
    runFetch([cx - halfW, cy - halfH, cx + halfW, cy + halfH]);
  };

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

  // Only scenes carrying the selected polarization can render in this mode.
  const polItems = useMemo(
    () => stacItems.filter((it) => it.assets[pol]),
    [stacItems, pol],
  );

  const layers = useMemo(() => {
    if (polItems.length === 0) return [];
    const pipeline = buildRenderPipeline({ dbRange, gamma });

    const mosaic = new MosaicLayer<PartialSTACItem, null>({
      id: `s1-mosaic-${pol}-${gen}`,
      sources: polItems,
      maxCacheSize: 0,
      // MultiCOGLayer opens its own GeoTIFFs; MosaicLayer only needs each
      // item's bbox for spatial indexing.
      getSource: async () => null,
      renderSource: (source) => {
        const href = source.assets[pol]?.href;
        if (!href) return null;
        const cacheKey = `${pol}-${source.id}`;
        let sources = sourcesCache.current.get(cacheKey);
        if (!sources) {
          sources = { amp: { url: href } };
          sourcesCache.current.set(cacheKey, sources);
        }
        return new GcpMultiCOGLayer({
          id: `s1-multi-${pol}-${gen}-${source.id}`,
          sources,
          composite: AMP_COMPOSITE,
          renderPipeline: pipeline,
          signal: genSignal,
          refinementStrategy: "best-available",
          // The GCP warp is smooth (bilinear over a 21x10 grid), so a coarse
          // reprojection mesh looks identical to a fine one but builds far fewer
          // triangles and calls the (heavier) GCP inverse far fewer times.
          // Default 0.125 px is overkill here and stutters; 0.75 px is plenty.
          maxError: 0.75,
          // Raw GRD bucket is fast and CORS-open (no SAS throttle); still cap
          // concurrency so a wide view doesn't stampede range reads.
          maxRequests: 10,
          onGeoTIFFLoad: () => reportLoaded(href),
          onError: (e: unknown) =>
            reportFailed(href, e instanceof Error ? e.message : String(e)),
          updateTriggers: {
            renderTile: [pol, dbRange[0], dbRange[1], gamma],
          },
        } as any);
      },
      // @ts-expect-error beforeId is injected by @deck.gl/mapbox
      beforeId: labelBeforeId,
    });
    return [mosaic];
  }, [polItems, labelBeforeId, pol, gen, dbRange, gamma]);

  const initialViewState = {
    longitude: -70.05,
    latitude: -32.7,
    zoom: 10,
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
        attributionControl={false}
        mapStyle={mapStyle}
        onLoad={(e) => {
          const map = e.target;
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
        sceneCount={polItems.length}
        totalCount={stacItems.length}
        error={stacError}
        fetching={fetching}
        hasFetched={hasFetched}
        stats={stats}
        pol={pol}
        onPolChange={setPol}
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
        onFetchViewport={handleFetchViewport}
        onResetNorth={handleResetNorth}
        zoom={zoom}
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
  marginBottom: 8,
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

const dateInputStyle: React.CSSProperties = {
  ...selectStyle,
  flex: 1,
  colorScheme: "dark",
};

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
  error,
  fetching,
  hasFetched,
  stats,
  pol,
  onPolChange,
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
  onFetchViewport,
  onResetNorth,
  zoom,
}: {
  sceneCount: number;
  totalCount: number;
  error: string | null;
  fetching: boolean;
  hasFetched: boolean;
  stats: LoadStats;
  pol: Polarization;
  onPolChange: (p: Polarization) => void;
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
  onFetchViewport: () => void;
  onResetNorth: () => void;
  zoom: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const pending = Math.max(0, sceneCount - stats.loaded - stats.failed);
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
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          Sentinel-1 <span style={{ color: UI.accent }}>Amplitude</span>
        </div>
      </div>

      {/* Area: search, date window, coverage status, view toggles */}
      <Section label="Area" first>
        <PlaceSearch ref={searchRef} onPick={onPickPlace} />
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="date"
            value={dateFrom}
            max={dateTo}
            onChange={(e) => onDateFromChange(e.target.value)}
            style={dateInputStyle}
          />
          <span style={{ color: UI.faint }}>→</span>
          <input
            type="date"
            value={dateTo}
            min={dateFrom}
            onChange={(e) => onDateToChange(e.target.value)}
            style={dateInputStyle}
          />
        </div>
        <div
          style={{
            fontFamily: UI.mono,
            fontSize: 11.5,
            color: error ? "#f0a3a3" : UI.mute,
            marginTop: 8,
          }}
        >
          {error
            ? `STAC: ${error}`
            : fetching
              ? "fetching scenes…"
              : !hasFetched
                ? "Hit FETCH VIEW or draw an AOI to load Sentinel-1 scenes."
                : `${sceneCount} ${pol.toUpperCase()} scenes · ${stats.loaded} loaded · ${stats.failed} failed · ${pending} pending`}
        </div>
        {totalCount > sceneCount && !error && (
          <div style={{ fontFamily: UI.mono, fontSize: 11, color: UI.faint, marginTop: 3 }}>
            ({totalCount - sceneCount} scenes lack {pol.toUpperCase()})
          </div>
        )}
        <div style={{ fontFamily: UI.mono, fontSize: 11.5, color: UI.accent, marginTop: 4 }}>
          zoom {zoom.toFixed(2)} · dpr {window.devicePixelRatio}
        </div>
        <div style={{ marginTop: 9, display: "flex", flexWrap: "wrap", gap: 6 }}>
          <Toggle active={drawing} onClick={onToggleDraw} title="Drag a rectangle to set the AOI">
            {drawing ? "DRAW: DRAG BOX" : "DRAW AOI"}
          </Toggle>
          <Toggle active={false} onClick={onFetchViewport} title="Load scenes for the current view">
            FETCH VIEW
          </Toggle>
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
      </Section>

      {/* Render: polarization + dB stretch + gamma + colormap */}
      <Section label="Amplitude">
        <div style={{ display: "flex", gap: 6 }}>
          {POLARIZATIONS.map((p) => (
            <Toggle key={p} active={pol === p} onClick={() => onPolChange(p)} grow
              title={p === "vv" ? "Co-pol: cleanest terrain / surface look" : "Cross-pol: volume scattering (vegetation, rough)"}>
              {p.toUpperCase()}
            </Toggle>
          ))}
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
          <div style={{ ...eyebrowStyle, color: UI.accent, letterSpacing: "0.1em", marginBottom: 2 }}>
            {pol.toUpperCase()} · dB stretch
          </div>

          {/* dB window (two-way stretch) */}
          <div style={{ marginTop: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontFamily: UI.mono, fontSize: 12, color: UI.mute }}>dB range</span>
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

          <div style={{ marginTop: 10 }}>
            <Toggle active={false} onClick={onDramatic} grow
              title="High-contrast preset: tighter dB window + raised gamma for inky shadows">
              DRAMATIC PRESET
            </Toggle>
          </div>
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
                  <code style={{ fontFamily: UI.mono, fontSize: 10.5, color: UI.mute }}>{f.url}</code>
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
          <span style={{ color: UI.mute }}>P</span> pol&nbsp;&nbsp;
          <span style={{ color: UI.mute }}>L</span> labels&nbsp;&nbsp;
          <span style={{ color: UI.mute }}>D</span> draw
        </div>
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 12 }}>
          <a
            href="https://github.com/kentstephen/s1-amplitude-explorer"
            target="_blank"
            rel="noreferrer"
            title="This project's source on GitHub"
            style={{ color: UI.mute, display: "inline-flex", alignItems: "center", gap: 5, textDecoration: "none" }}
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
            href="https://registry.opendata.aws/sentinel-1/"
            target="_blank"
            rel="noreferrer"
            title="Raw Sentinel-1 GRD via Element 84 Earth Search (AWS Open Data)"
            style={{ color: UI.accent, textDecoration: "none" }}
          >
            Sentinel-1 GRD
          </a>{" "}
          via Earth Search (AWS Open Data), GCP-warped in the browser
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
          by Development Seed
        </div>
      </div>
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

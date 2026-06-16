/**
 * Runtime STAC client for raw Sentinel-1 GRD over Element 84's public Earth
 * Search (`sentinel-1-grd`). Pages through /search and returns the minimal shape
 * the layer needs: bbox + the VV / VH measurement-COG hrefs.
 *
 * Why raw GRD and not RTC: GRD is open, global, and browser-readable with no
 * auth (the `sentinel-s1-l1c` bucket is CORS-open, anonymous 206 range reads).
 * The catch is geometry, GRD COGs are ground-range with a GCP grid and no
 * affine transform, so they only render through the GCP tileset path
 * (`gcpTileset.ts` / `GcpMultiCOGLayer`), not deck.gl-geotiff's affine default.
 * RTC was the affine shortcut; it's gated/throttled (MPC SAS + 504s), so we
 * dropped it. See docs/PLAN.md.
 *
 * Access: assets carry `s3://sentinel-s1-l1c/...` hrefs; we rewrite them to the
 * CORS-open https virtual-hosted endpoint. No token, no requester-pays.
 */

const EARTH_SEARCH = "https://earth-search.aws.element84.com/v1/search";
const COLLECTION = "sentinel-1-grd";
// CORS-open virtual-hosted endpoint for the AWS Open Data S1 L1C bucket
// (eu-central-1): anonymous range reads, `Access-Control-Allow-Origin: *`.
const S1_BUCKET_HTTPS = "https://sentinel-s1-l1c.s3.eu-central-1.amazonaws.com/";

export type Polarization = "vv" | "vh";

/** A GeoJSON Polygon/MultiPolygon footprint (loosely typed to avoid a dep). */
export type Footprint = {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][] | number[][][][];
};

export type PartialSTACItem = {
  id: string;
  bbox: [number, number, number, number];
  /** Acquisition datetime (ISO). */
  datetime: string;
  /** Ascending / descending pass; affects look-direction and relief shading. */
  orbit: "ascending" | "descending" | null;
  /** Scene footprint polygon, for the coverage overlay + coverage grouping. */
  geometry: Footprint | null;
  /** Relative orbit number; repeat passes of one frame share it. Null if absent. */
  relativeOrbit: number | null;
  assets: {
    /** https measurement-COG href; present only when the scene carries that pol. */
    vv?: { href: string };
    vh?: { href: string };
  };
};

type StacFeature = {
  id: string;
  bbox: [number, number, number, number];
  geometry?: Footprint;
  assets: Record<string, { href?: string }>;
  properties?: {
    datetime?: string;
    "sat:orbit_state"?: string;
    "sat:relative_orbit"?: number;
  };
};

type StacFeatureCollection = {
  features: StacFeature[];
  links?: { rel: string; href: string; method?: string; body?: Record<string, unknown>; merge?: boolean }[];
};

export type FetchOptions = {
  /** Datetime interval in RFC3339, e.g. "2026-01-01T00:00:00Z/2026-03-01T23:59:59Z" */
  datetime: string;
  /** bbox [W,S,E,N], global collection, so an AOI is effectively required. */
  bbox?: [number, number, number, number];
  /** Hard cap on items fetched (safety net; GRD scenes are ~650 MB COGs). */
  maxItems?: number;
  signal?: AbortSignal;
};

export type FetchResult = {
  items: PartialSTACItem[];
  /** Scenes dropped because they carried no usable VV/VH asset. */
  rejected: number;
  /** Kept for caller compatibility; always null for the token-free GRD source. */
  tokenExpiry: string | null;
};

/**
 * fetch with retry/backoff on transient failures. Earth Search occasionally
 * 502/503s under load; a couple of backed-off retries usually clears it.
 * Aborts (user navigation) are not retried.
 */
async function fetchRetry(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  tries = 3,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if (![429, 502, 503, 504].includes(res.status) || i === tries - 1) return res;
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      lastErr = e;
      if (i === tries - 1) throw e;
    }
    await new Promise((r) => setTimeout(r, 600 * 2 ** i)); // 0.6s, 1.2s, 2.4s
  }
  throw lastErr ?? new Error("fetchRetry exhausted");
}

/** Rewrite an `s3://sentinel-s1-l1c/KEY` href to the CORS-open https endpoint. */
function s3ToHttps(href: string | undefined): string | null {
  if (!href) return null;
  const m = /^s3:\/\/sentinel-s1-l1c\/(.+)$/.exec(href);
  if (m) return S1_BUCKET_HTTPS + m[1];
  // Already https (or some other scheme we pass through unchanged).
  return href.startsWith("http") ? href : null;
}

function orbitOf(f: StacFeature): PartialSTACItem["orbit"] {
  const o = f.properties?.["sat:orbit_state"];
  return o === "ascending" || o === "descending" ? o : null;
}

// Side cache of the verbatim Earth Search features, keyed by item id, kept OUT of
// the PartialSTACItem objects that flow into the deck.gl layers (hanging the full
// feature on every rendered item bogs down layer diffing). Used only by the STAC
// download to emit a faithful ItemCollection. Last search wins; bounded by the
// candidate limit, so it can't grow without end.
const rawById = new Map<string, StacFeature>();

/** Full STAC features for the given item ids (skips any not in the cache). */
export function getRawFeatures(ids: string[]): StacFeature[] {
  return ids.map((id) => rawById.get(id)).filter((f): f is StacFeature => !!f);
}

/**
 * Page through Earth Search for IW-mode GRD scenes over the AOI, rewriting each
 * VV/VH measurement href to the https bucket endpoint. Scenes with neither pol
 * are dropped.
 */
export async function fetchStacItems(opts: FetchOptions): Promise<FetchResult> {
  const { datetime, bbox, maxItems = 24, signal } = opts;

  const items: PartialSTACItem[] = [];
  let rejected = 0;
  rawById.clear(); // fresh search: drop the previous candidates' raw features

  const body: Record<string, unknown> = {
    collections: [COLLECTION],
    datetime,
    // GRD only; SLC (complex) and other modes are not amplitude imagery.
    query: { "sar:instrument_mode": { eq: "IW" } },
    limit: 100,
    sortby: [{ field: "properties.datetime", direction: "desc" }],
  };
  if (bbox) body.bbox = bbox;

  let url: string | null = EARTH_SEARCH;
  let nextBody: Record<string, unknown> | null = body;

  while (url && items.length < maxItems) {
    const res: Response = await fetchRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify(nextBody),
    });
    if (!res.ok) throw new Error(`STAC search failed: ${res.status} ${res.statusText}`);
    const fc = (await res.json()) as StacFeatureCollection;

    for (const feat of fc.features) {
      const vv = s3ToHttps(feat.assets["vv"]?.href);
      const vh = s3ToHttps(feat.assets["vh"]?.href);
      if (!vv && !vh) {
        rejected += 1;
        continue;
      }
      const ro = feat.properties?.["sat:relative_orbit"];
      items.push({
        id: feat.id,
        bbox: feat.bbox,
        datetime: feat.properties?.datetime ?? "",
        orbit: orbitOf(feat),
        geometry: feat.geometry ?? null,
        relativeOrbit: typeof ro === "number" ? ro : null,
        assets: {
          ...(vv ? { vv: { href: vv } } : {}),
          ...(vh ? { vh: { href: vh } } : {}),
        },
      });
      rawById.set(feat.id, feat);
      if (items.length >= maxItems) break;
    }

    const next = fc.links?.find((l) => l.rel === "next");
    if (next?.href && items.length < maxItems) {
      url = next.href;
      nextBody = next.merge ? { ...body, ...(next.body ?? {}) } : (next.body ?? body);
    } else {
      url = null;
    }
  }

  return { items, rejected, tokenExpiry: null };
}

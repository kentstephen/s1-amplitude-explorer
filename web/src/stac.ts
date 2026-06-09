/**
 * Runtime STAC client for Sentinel-1 RTC backscatter on the Microsoft Planetary
 * Computer (`sentinel-1-rtc`). Pages through /search and returns the minimal
 * shape the MosaicLayer needs: bbox + the VV / VH COG asset hrefs.
 *
 * Why RTC and not raw GRD: the Earth Search / EOPF GRD products are ground-range
 * with GCP geolocation (no affine grid), which deck.gl-geotiff can't place yet
 * (GCP warping is a roadmap item — see docs/RESEARCH.md). RTC is terrain-
 * corrected onto a real UTM affine grid, so it renders via the existing
 * epsgResolver path. Trade-off: RTC flattens some of the dramatic relief shading,
 * and MPC blob storage throttles on bursts.
 *
 * Access: assets are Azure blob URLs needing a SAS token. We fetch ONE container
 * token for the whole collection (`/api/sas/v1/token/sentinel-1-rtc`, CORS-open,
 * ~1 hr expiry) and append it to every href — one signing call per search, which
 * keeps us under the throttle. The token expiry is surfaced so the app can
 * refetch when it lapses.
 */

const MPC_STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search";
const MPC_TOKEN = "https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-1-rtc";
const COLLECTION = "sentinel-1-rtc";

export type Polarization = "vv" | "vh";

export type PartialSTACItem = {
  id: string;
  bbox: [number, number, number, number];
  /** Acquisition datetime (ISO). */
  datetime: string;
  /** Ascending / descending pass; affects look-direction and relief shading. */
  orbit: "ascending" | "descending" | null;
  assets: {
    /** SAS-signed blob href; present only when the scene carries that pol. */
    vv?: { href: string };
    vh?: { href: string };
  };
};

type StacFeature = {
  id: string;
  bbox: [number, number, number, number];
  assets: Record<string, { href?: string }>;
  properties?: {
    datetime?: string;
    "sat:orbit_state"?: string;
  };
};

type StacFeatureCollection = {
  features: StacFeature[];
  links?: { rel: string; href: string; method?: string; body?: Record<string, unknown>; merge?: boolean }[];
};

export type FetchOptions = {
  /** Datetime interval in RFC3339, e.g. "2024-01-01T00:00:00Z/2024-03-01T23:59:59Z" */
  datetime: string;
  /** bbox [W,S,E,N] — global collection, so an AOI is effectively required. */
  bbox?: [number, number, number, number];
  /** Hard cap on items fetched (safety net; RTC scenes are big, keep modest). */
  maxItems?: number;
  signal?: AbortSignal;
};

export type FetchResult = {
  items: PartialSTACItem[];
  /** Scenes dropped because they carried no usable VV/VH asset. */
  rejected: number;
  /** SAS token expiry (ISO) so the caller can refetch before it lapses. */
  tokenExpiry: string | null;
};

/**
 * fetch with retry/backoff on throttle/transient failures. MPC's STAC + SAS
 * endpoints 429/5xx under burst; a couple of backed-off retries usually clears
 * it. Aborts (user navigation) are not retried.
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
      // Retry only on throttle / gateway / transient server errors.
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

/** One container SAS token for the whole collection; append to each blob href. */
async function fetchSasToken(signal?: AbortSignal): Promise<{ token: string; expiry: string | null }> {
  const res = await fetchRetry(MPC_TOKEN, { signal });
  if (!res.ok) throw new Error(`SAS token failed: ${res.status} ${res.statusText}`);
  const j = (await res.json()) as { token?: string; "msft:expiry"?: string };
  if (!j.token) throw new Error("SAS token response missing `token`");
  return { token: j.token, expiry: j["msft:expiry"] ?? null };
}

function sign(href: string | undefined, token: string): string | null {
  if (!href) return null;
  return href.includes("?") ? `${href}&${token}` : `${href}?${token}`;
}

function orbitOf(f: StacFeature): PartialSTACItem["orbit"] {
  const o = f.properties?.["sat:orbit_state"];
  return o === "ascending" || o === "descending" ? o : null;
}

/**
 * Page through MPC search for RTC scenes over the AOI, signing each VV/VH href
 * with the container token. Scenes with neither pol are dropped.
 */
export async function fetchStacItems(opts: FetchOptions): Promise<FetchResult> {
  const { datetime, bbox, maxItems = 60, signal } = opts;
  const { token, expiry } = await fetchSasToken(signal);

  const items: PartialSTACItem[] = [];
  let rejected = 0;

  const body: Record<string, unknown> = {
    collections: [COLLECTION],
    datetime,
    limit: 100,
    sortby: [{ field: "properties.datetime", direction: "desc" }],
  };
  if (bbox) body.bbox = bbox;

  let url: string | null = MPC_STAC;
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
      const vv = sign(feat.assets["vv"]?.href, token);
      const vh = sign(feat.assets["vh"]?.href, token);
      if (!vv && !vh) {
        rejected += 1;
        continue;
      }
      items.push({
        id: feat.id,
        bbox: feat.bbox,
        datetime: feat.properties?.datetime ?? "",
        orbit: orbitOf(feat),
        assets: {
          ...(vv ? { vv: { href: vv } } : {}),
          ...(vh ? { vh: { href: vh } } : {}),
        },
      });
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

  return { items, rejected, tokenExpiry: expiry };
}

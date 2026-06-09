/**
 * Runtime STAC client for Earth Genome's Sentinel-2 Temporal Mosaics
 * collection at stac.earthgenome.org. Pages through /search and returns the
 * minimal shape MosaicLayer needs: bbox + the TCI (true-color) asset href.
 *
 * No SAS signing, no token expiry — source.coop is a public CloudFront-fronted
 * S3 bucket with permissive CORS. The STAC API itself is also CORS-open.
 */

const STAC_ROOT = "https://stac.earthgenome.org";
const COLLECTION = "sentinel2-temporal-mosaics";

/**
 * Hosts known to serve the COGs with permissive CORS.
 *
 * The STAC API mixes two backends: source.coop (CORS-open mirror, partial
 * coverage — seasonal 2024 composites only) and ei-imagery.s3.us-east-2
 * (raw S3, CORS-blocked from the browser, holds the full-year annual
 * mosaics). For now we filter to the CORS-open subset; everything else
 * 403s and cascades into deck.gl error spam.
 */
const CORS_OK_HOSTS = new Set(["data.source.coop"]);

export type PartialSTACItem = {
  id: string;
  bbox: [number, number, number, number];
  assets: {
    visual: { href: string };
    B03: { href: string };
    B04: { href: string };
    B08: { href: string };
  };
};

// Bands the curated index set needs: B04(red) B08(NIR) for NDVI, B03(green) for
// NDWI. All 10 m. B02 dropped (RGB renders the TCI `visual` asset, not a
// B04/B03/B02 composite); B11 dropped with NDBI/NDMI — pairing 20 m SWIR with a
// 10 m band seamed (see renderPipeline.ts). Items missing any of these are
// skipped.
const REQUIRED_BANDS = ["B03", "B04", "B08"] as const;

type StacFeature = {
  id: string;
  bbox: [number, number, number, number];
  assets: Record<string, { href: string; roles?: string[] }>;
  properties?: { datetime?: string; "good_pxl_pct"?: number };
};

type StacFeatureCollection = {
  features: StacFeature[];
  links?: { rel: string; href: string }[];
};

export type FetchOptions = {
  /** Datetime interval in RFC3339, e.g. "2024-01-01T00:00:00Z/2024-12-31T23:59:59Z" */
  datetime: string;
  /** Optional bbox [W,S,E,N] — omit for global */
  bbox?: [number, number, number, number];
  /** Hard cap on items fetched (safety net) */
  maxItems?: number;
  signal?: AbortSignal;
};

/**
 * Page through STAC search and project each item down to {id, bbox, visual asset}.
 * TCI is the pre-composed RGB visualization band on this collection.
 */
export type FetchResult = {
  items: PartialSTACItem[];
  /** Items dropped because their COG host isn't CORS-open (can't load in-browser). */
  rejected: number;
};

export async function fetchStacItems(opts: FetchOptions): Promise<FetchResult> {
  const { datetime, bbox, maxItems = 5000, signal } = opts;
  const items: PartialSTACItem[] = [];
  const rejectedHosts = new Map<string, number>();

  const params = new URLSearchParams({
    collections: COLLECTION,
    datetime,
    limit: "200",
  });
  if (bbox) params.set("bbox", bbox.join(","));

  let url: string | null = `${STAC_ROOT}/search?${params.toString()}`;

  while (url && items.length < maxItems) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`STAC search failed: ${res.status} ${res.statusText}`);
    const fc = (await res.json()) as StacFeatureCollection;

    for (const feat of fc.features) {
      const visual = feat.assets["TCI"] ?? feat.assets["visual"];
      if (!visual?.href) continue;
      let host: string;
      try {
        host = new URL(visual.href).host;
      } catch {
        continue;
      }
      if (!CORS_OK_HOSTS.has(host)) {
        rejectedHosts.set(host, (rejectedHosts.get(host) ?? 0) + 1);
        continue;
      }
      const bandAssets: Record<string, { href: string }> = {};
      let missingBand = false;
      for (const b of REQUIRED_BANDS) {
        const a = feat.assets[b];
        if (!a?.href) {
          missingBand = true;
          break;
        }
        bandAssets[b] = { href: a.href };
      }
      if (missingBand) continue;
      items.push({
        id: feat.id,
        bbox: feat.bbox,
        assets: {
          visual: { href: visual.href },
          B03: bandAssets.B03,
          B04: bandAssets.B04,
          B08: bandAssets.B08,
        },
      });
      if (items.length >= maxItems) break;
    }

    const next = fc.links?.find((l) => l.rel === "next");
    url = next?.href ?? null;
  }

  let rejected = 0;
  if (rejectedHosts.size > 0) {
    rejected = [...rejectedHosts.values()].reduce((a, b) => a + b, 0);
    const summary = [...rejectedHosts.entries()]
      .map(([h, n]) => `${h} (${n})`)
      .join(", ");
    console.warn(
      `[stac] dropped items from non-CORS-OK hosts: ${summary}. ` +
        `Update CORS_OK_HOSTS in src/stac.ts if any of these are now CORS-open.`,
    );
  }

  return { items, rejected };
}

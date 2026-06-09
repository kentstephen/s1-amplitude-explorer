/**
 * Minimal OSM geocoder via Photon (Komoot's OSM-backed search, built for
 * autocomplete; no API key, CORS-open). We use it to turn a typed place into a
 * center + bbox to drive the STAC fetch. No LLM — a geocoder resolves place
 * names deterministically.
 *
 * Photon's `properties.extent` is [west, north, east, south]; we normalize to
 * the [W, S, E, N] order the rest of the app uses.
 */

const PHOTON_URL = "https://photon.komoot.io/api/";

export type GeoResult = {
  label: string;
  /** [lng, lat] */
  center: [number, number];
  /** [W, S, E, N] in degrees, if Photon returned a feature extent. */
  bbox?: [number, number, number, number];
};

type PhotonFeature = {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    street?: string;
    city?: string;
    county?: string;
    state?: string;
    country?: string;
    /** [west, north, east, south] */
    extent?: [number, number, number, number];
  };
};

function labelFor(p: PhotonFeature["properties"]): string {
  const parts = [p.name ?? p.street, p.city ?? p.county, p.state, p.country]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
  return parts.join(", ");
}

export async function searchPhoton(
  query: string,
  signal?: AbortSignal,
  limit = 6,
): Promise<GeoResult[]> {
  const q = query.trim();
  if (!q) return [];
  const url = `${PHOTON_URL}?q=${encodeURIComponent(q)}&limit=${limit}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Photon ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { features: PhotonFeature[] };
  return data.features.map((f) => {
    const [lng, lat] = f.geometry.coordinates;
    const ext = f.properties.extent;
    const bbox: GeoResult["bbox"] = ext
      ? [ext[0], ext[3], ext[2], ext[1]] // [W,N,E,S] -> [W,S,E,N]
      : undefined;
    return { label: labelFor(f.properties), center: [lng, lat], bbox };
  });
}

/**
 * Turn a geocoder result into a STAC bbox. Imagery is cheap, so we always apply
 * a margin (and a floor for point results), and clamp the span to a ceiling so
 * a country-sized extent doesn't fan out into thousands of COG opens.
 *
 * @param marginFrac fractional margin added to each side of a real extent
 * @param minHalfDeg minimum half-span (deg) so a bare point still loads area
 * @param maxSpanDeg maximum total span (deg) per axis; larger extents clamp to
 *   this around the center
 */
export function resultToBbox(
  r: GeoResult,
  {
    marginFrac = 0.15,
    minHalfDeg = 0.2,
    maxSpanDeg = 3.0,
  }: { marginFrac?: number; minHalfDeg?: number; maxSpanDeg?: number } = {},
): [number, number, number, number] {
  const [cx, cy] = r.center;
  let halfW: number;
  let halfH: number;
  if (r.bbox) {
    const [w, s, e, n] = r.bbox;
    halfW = (Math.abs(e - w) / 2) * (1 + marginFrac);
    halfH = (Math.abs(n - s) / 2) * (1 + marginFrac);
  } else {
    halfW = minHalfDeg;
    halfH = minHalfDeg;
  }
  halfW = Math.max(minHalfDeg, Math.min(halfW, maxSpanDeg / 2));
  halfH = Math.max(minHalfDeg, Math.min(halfH, maxSpanDeg / 2));
  return [cx - halfW, cy - halfH, cx + halfW, cy + halfH];
}

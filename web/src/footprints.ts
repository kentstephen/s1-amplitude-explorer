/**
 * Build the GeoJSON FeatureCollection for the SEARCH VIEW coverage overlay from
 * candidate scenes. Pure data shaping, no deck.gl, so the overlay layer (today a
 * `GeoJsonLayer`; a `stac-map` footprint layer later) is a thin consumer.
 */
import type { PartialSTACItem } from "./stac";

export type FootprintFeature = {
  type: "Feature";
  geometry: NonNullable<PartialSTACItem["geometry"]>;
  properties: {
    id: string;
    /** Belongs to the date currently stepped to (highlighted). */
    active: boolean;
    /** Part of the "most complete" coverage-first selection. */
    selected: boolean;
  };
};

export type FootprintCollection = {
  type: "FeatureCollection";
  features: FootprintFeature[];
};

export function footprintCollection(
  candidates: PartialSTACItem[],
  activeIds: Set<string>,
  selectedIds: Set<string>,
): FootprintCollection {
  const features: FootprintFeature[] = [];
  for (const c of candidates) {
    if (!c.geometry) continue;
    features.push({
      type: "Feature",
      geometry: c.geometry,
      properties: {
        id: c.id,
        active: activeIds.has(c.id),
        selected: selectedIds.has(c.id),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

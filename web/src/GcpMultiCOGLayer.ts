/**
 * MultiCOGLayer for raw Sentinel-1 GRD COGs, placed by their GCP geolocation
 * grid instead of an affine geotransform.
 *
 * `MultiCOGLayer` is almost entirely geometry-agnostic: its tile fetch path,
 * band compositing, render pipeline, and z→overview mapping all route through
 * the `RasterTilesetLevel` interface (`tileTransform`, `projectedTileCorners`,
 * `metersPerPixel`). The single affine-only step is `_parseAllSources`, which
 * calls `geoTiffToDescriptor` → reads `img.transform` → throws on a GCP COG
 * ("does not have an affine transformation").
 *
 * So this subclass overrides only `_parseAllSources`, swapping in
 * {@link buildGcpDescriptor}. Everything downstream (the GPU dB shader, mesh
 * reprojection, tile streaming from overviews, mosaicking) is inherited
 * unchanged. The source CRS is EPSG:4326 (GCP lon/lat), so there is no proj4 /
 * epsgResolver step, the geometry IS the GCP grid.
 */
import { MultiCOGLayer } from "@developmentseed/deck.gl-geotiff";
import { createMultiRasterTilesetDescriptor } from "@developmentseed/deck.gl-raster";
import type { RasterTilesetDescriptor } from "@developmentseed/deck.gl-raster";
import { GeoTIFF } from "@developmentseed/geotiff";

import { buildGcpDescriptor } from "./gcpTileset";

export class GcpMultiCOGLayer extends MultiCOGLayer {
  static layerName = "GcpMultiCOGLayer";

  /**
   * Open every configured COG, build a GCP-placed descriptor for each, and
   * group them into the MultiRasterTilesetDescriptor the base class consumes.
   * Mirrors the base `_parseAllSources` state contract exactly, minus the
   * proj4/affine plumbing (unneeded for a 4326 GCP source).
   */
  override async _parseAllSources(): Promise<void> {
    const { sources } = this.props;
    const entries = Object.entries(sources);

    const opened = await Promise.all(
      entries.map(async ([name, config]) => {
        const geotiff = await openGeoTIFF((config as { url: GeoTIFF | string | URL }).url);
        neutralizeAffine(geotiff);
        return { name, geotiff };
      }),
    );

    const tilesetMap = new Map<string, RasterTilesetDescriptor>();
    const sourceMap = new Map<string, { geotiff: GeoTIFF }>();
    for (const { name, geotiff } of opened) {
      tilesetMap.set(name, buildGcpDescriptor(geotiff));
      sourceMap.set(name, { geotiff });
    }

    const multiDescriptor = createMultiRasterTilesetDescriptor(tilesetMap);
    // Base class state shape: { sources: Map<name, {geotiff}>, multiDescriptor }.
    this.setState({ sources: sourceMap, multiDescriptor });

    if (this.props.onGeoTIFFLoad) {
      const primaryKey = multiDescriptor.primaryKey;
      const [minLon, minLat, maxLon, maxLat] =
        multiDescriptor.primary.projectedBounds;
      const geotiffMap = new Map<string, GeoTIFF>();
      for (const [name, state] of sourceMap) geotiffMap.set(name, state.geotiff);
      this.props.onGeoTIFFLoad(geotiffMap, {
        primaryKey,
        geographicBounds: { west: minLon, south: minLat, east: maxLon, north: maxLat },
      });
    }
  }
}

/** Open a source config's `url`, accepting an already-opened GeoTIFF too. */
function openGeoTIFF(url: GeoTIFF | string | URL): Promise<GeoTIFF> {
  if (url instanceof GeoTIFF) return Promise.resolve(url);
  return GeoTIFF.fromUrl(url);
}

// A valid identity affine `[a, b, c, d, e, f]` for @developmentseed/affine.
const IDENTITY_AFFINE = [1, 0, 0, 0, 1, 0];

/**
 * Shadow the `transform` (affine) getter on a GCP COG and its overviews.
 *
 * The geotiff library's `assembleTile` computes `compose(self.transform, …)`
 * for every tile it decodes, and `transform` throws "The image does not have
 * an affine transformation" for a ground-range GRD COG (no ModelPixelScale /
 * ModelTransformation, only GCP ModelTiepoints). That computed affine is dead
 * weight on our path: placement comes entirely from the GCP descriptor's
 * `tileTransform`, and `_fetchPrimaryBand` reads only the tile's pixel data.
 * So we replace the throwing getter with a neutral identity affine; the value
 * is never read downstream.
 */
function neutralizeAffine(geotiff: GeoTIFF): void {
  const define = (img: object) =>
    Object.defineProperty(img, "transform", {
      value: IDENTITY_AFFINE,
      configurable: true,
    });
  define(geotiff);
  for (const overview of geotiff.overviews) define(overview);
}

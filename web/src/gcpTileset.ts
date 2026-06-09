/**
 * A non-affine {@link RasterTilesetDescriptor} for raw Sentinel-1 GRD COGs,
 * placed by their GCP geolocation grid instead of an affine geotransform.
 *
 * This is the piece `deck.gl-raster` flagged as "future" on the
 * `RasterTilesetLevel.tileTransform` doc-comment ("allows non-affine transforms
 * (e.g. GCPs) in the future"). It is the structural twin of
 * `deck.gl-raster`'s `AffineTilesetLevel` / `geoTiffToDescriptor`, but every
 * pixel<->CRS conversion routes through the GCP bilinear interpolator in
 * `gcp.ts` rather than an affine matrix.
 *
 * Source CRS is EPSG:4326: the GCP grid already stores lon/lat, so
 * `projectTo4326` is the identity and `projectTo3857` is the analytic Web
 * Mercator forward. No proj4, no epsgResolver, the geometry is the GCP grid.
 *
 * The reprojection mesh (`@developmentseed/raster-reproject`) consumes only the
 * `forwardTransform`/`inverseTransform` functions a level hands out, so the rest
 * of the deck.gl-raster GPU pipeline (tile streaming from overviews, the dB
 * shader, mosaicking) rides on top unchanged.
 */
import type {
  Corners,
  ProjectionFunction,
  RasterTilesetDescriptor,
  RasterTilesetLevel,
} from "@developmentseed/deck.gl-raster";
import type { GeoTIFF, Overview } from "@developmentseed/geotiff";
import { makeClampedForwardTo3857 } from "@developmentseed/proj";

import { buildGcpGrid, forward, inverse, parseGcps, type GcpGrid } from "./gcp";

/** A 2D point [x, y], matching deck.gl-raster's (non-exported) `Point`. */
type Point = [number, number];

// metersPerUnit for degrees on the WGS84 ellipsoid: 2*pi*a/360. Matches what
// `@developmentseed/proj`'s `metersPerUnit("degree", { semiMajorAxis: 6378137 })`
// returns, used here for LOD selection exactly as the affine 4326 path does.
const MPU_DEGREE = (2 * Math.PI * 6378137) / 360;
const MAX_WEB_MERCATOR_LAT = 85.05112877980659;

/** Identity projection, source CRS is already EPSG:4326. */
const identity: ProjectionFunction = (x, y) => [x, y];

/** Analytic EPSG:4326 → EPSG:3857. Used directly (the source is already 4326),
 *  wrapped in `makeClampedForwardTo3857` for pole safety / API parity. */
const mercatorForward: ProjectionFunction = (lon, lat) => {
  const x = (lon * Math.PI * 6378137) / 180;
  const clamped = Math.max(-MAX_WEB_MERCATOR_LAT, Math.min(MAX_WEB_MERCATOR_LAT, lat));
  const latRad = (clamped * Math.PI) / 180;
  const y = Math.log(Math.tan(Math.PI / 4 + latRad / 2)) * 6378137;
  return [x, y];
};

/** Analytic EPSG:3857 → EPSG:4326 (inverse Web Mercator). */
const mercatorInverse: ProjectionFunction = (x, y) => {
  const lon = (x / 6378137) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
};

const projectTo3857 = makeClampedForwardTo3857(mercatorForward, identity);
const projectFrom3857 = mercatorInverse;

interface GcpTilesetLevelOptions {
  /** The scene's GCP grid (pixel/line in FULL-RES space → lon/lat). */
  grid: GcpGrid;
  /** Full-resolution image dimensions (the space GCP pixel/line live in). */
  fullWidth: number;
  fullHeight: number;
  /** This level's array (overview or full-res) dimensions, in pixels. */
  arrayWidth: number;
  arrayHeight: number;
  /** Tile dimensions for this level, in pixels. */
  tileWidth: number;
  tileHeight: number;
  /** Geographic extent of the grid (shared by all levels). */
  bounds: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
}

/**
 * One resolution level of a GCP-placed tileset. Implements
 * {@link RasterTilesetLevel} so the generic traversal + the MultiCOG tile path
 * drive it identically to {@link AffineTilesetLevel}.
 *
 * GCP pixel/line coordinates live in full-resolution space. An overview's
 * pixels are mapped into that space by `scaleX = fullWidth / arrayWidth` (and
 * likewise Y) before hitting the interpolator.
 */
export class GcpTilesetLevel implements RasterTilesetLevel {
  readonly matrixWidth: number;
  readonly matrixHeight: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly metersPerPixel: number;
  readonly projectedBounds: [number, number, number, number];

  private readonly grid: GcpGrid;
  private readonly tw: number;
  private readonly th: number;
  private readonly scaleX: number;
  private readonly scaleY: number;

  constructor(opts: GcpTilesetLevelOptions) {
    this.grid = opts.grid;
    this.tw = opts.tileWidth;
    this.th = opts.tileHeight;
    this.tileWidth = opts.tileWidth;
    this.tileHeight = opts.tileHeight;
    this.matrixWidth = Math.ceil(opts.arrayWidth / opts.tileWidth);
    this.matrixHeight = Math.ceil(opts.arrayHeight / opts.tileHeight);
    this.scaleX = opts.fullWidth / opts.arrayWidth;
    this.scaleY = opts.fullHeight / opts.arrayHeight;
    this.projectedBounds = opts.bounds;

    // LOD metric: average degrees-per-pixel at this level, converted to meters.
    // Mirrors AffineTilesetLevel's `sqrt(|a*e|) * mpu` for a 4326 source (no
    // cos(lat) term, consistent with how the library treats geographic affines).
    const [minLon, minLat, maxLon, maxLat] = opts.bounds;
    const degPerPxX = (maxLon - minLon) / opts.arrayWidth;
    const degPerPxY = (maxLat - minLat) / opts.arrayHeight;
    this.metersPerPixel = Math.sqrt(Math.abs(degPerPxX * degPerPxY)) * MPU_DEGREE;
  }

  /** Level pixel → full-resolution pixel (the GCP grid's coordinate space). */
  private toFull(px: number, py: number): [number, number] {
    return [px * this.scaleX, py * this.scaleY];
  }

  projectedTileCorners(col: number, row: number): Corners {
    const tw = this.tw;
    const th = this.th;
    const at = (lx: number, ly: number): Point => {
      const [fx, fy] = this.toFull(lx, ly);
      return forward(this.grid, fx, fy);
    };
    return {
      topLeft: at(col * tw, row * th),
      topRight: at((col + 1) * tw, row * th),
      bottomLeft: at(col * tw, (row + 1) * th),
      bottomRight: at((col + 1) * tw, (row + 1) * th),
    };
  }

  tileTransform(col: number, row: number): {
    forwardTransform: ProjectionFunction;
    inverseTransform: ProjectionFunction;
  } {
    const offX = col * this.tw;
    const offY = row * this.th;
    return {
      // tile pixel (origin top-left of tile) → source CRS (lon/lat)
      forwardTransform: (px, py) => {
        const [fx, fy] = this.toFull(offX + px, offY + py);
        return forward(this.grid, fx, fy);
      },
      // source CRS (lon/lat) → tile pixel
      inverseTransform: (lon, lat) => {
        const [fx, fy] = inverse(this.grid, lon, lat);
        return [fx / this.scaleX - offX, fy / this.scaleY - offY];
      },
    };
  }

  crsBoundsToTileRange(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
  ): { minCol: number; maxCol: number; minRow: number; maxRow: number } {
    // Map the four CRS corners to full-res pixels via the GCP inverse, then take
    // the bbox in level-pixel space (handles the warp's rotation like the affine
    // version handles skew).
    const corners: Point[] = [
      inverse(this.grid, minLon, minLat),
      inverse(this.grid, maxLon, minLat),
      inverse(this.grid, minLon, maxLat),
      inverse(this.grid, maxLon, maxLat),
    ];
    const xs = corners.map(([fx]) => fx / this.scaleX);
    const ys = corners.map(([, fy]) => fy / this.scaleY);
    const pixMinX = Math.min(...xs);
    const pixMaxX = Math.max(...xs);
    const pixMinY = Math.min(...ys);
    const pixMaxY = Math.max(...ys);
    const maxColIdx = this.matrixWidth - 1;
    const maxRowIdx = this.matrixHeight - 1;
    // Asymmetric clamp (matches AffineTilesetLevel): a bbox fully outside the
    // array yields an empty range (min > max) so the consumer's loop is a no-op.
    return {
      minCol: Math.max(0, Math.floor(pixMinX / this.tw)),
      maxCol: Math.min(maxColIdx, Math.floor(pixMaxX / this.tw)),
      minRow: Math.max(0, Math.floor(pixMinY / this.th)),
      maxRow: Math.min(maxRowIdx, Math.floor(pixMaxY / this.th)),
    };
  }
}

/**
 * The geographic bbox a GCP grid spans, as [minLon, minLat, maxLon, maxLat].
 * (The grid is rectilinear in pixel space but warped in lon/lat, so we scan all
 * nodes rather than assuming the corners are the extremes.)
 */
function gridBounds(grid: GcpGrid): [number, number, number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (let r = 0; r < grid.rows.length; r++) {
    for (let c = 0; c < grid.cols.length; c++) {
      const lon = grid.lon[r][c];
      const lat = grid.lat[r][c];
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * A {@link RasterTilesetDescriptor} for a GCP-placed GRD COG. The structural
 * twin of `AffineTileset`, emitted as a plain object so it satisfies the
 * interface without subclassing.
 *
 * Levels are ordered coarsest-first with the full-resolution image appended
 * last, identical to `geoTiffToDescriptor`, so MultiCOGLayer's z→overview
 * mapping (`selectImage`) lines up.
 */
export function buildGcpDescriptor(geotiff: GeoTIFF): RasterTilesetDescriptor {
  const tiepoints = geotiff.cachedTags.modelTiepoint;
  if (!tiepoints || tiepoints.length === 0) {
    throw new Error("GRD COG has no ModelTiepoint tag, no GCP geolocation to place it");
  }
  const grid = buildGcpGrid(parseGcps(tiepoints));
  const bounds = gridBounds(grid);
  const fullWidth = geotiff.width;
  const fullHeight = geotiff.height;

  // overviews are finest-to-coarsest; reverse for coarsest-first, then append
  // the full-res image as the finest level.
  const images: (GeoTIFF | Overview)[] = [
    ...[...geotiff.overviews].reverse(),
    geotiff,
  ];
  const levels = images.map(
    (img) =>
      new GcpTilesetLevel({
        grid,
        fullWidth,
        fullHeight,
        arrayWidth: img.width,
        arrayHeight: img.height,
        tileWidth: img.tileWidth,
        tileHeight: img.tileHeight,
        bounds,
      }),
  );

  return {
    levels,
    projectTo3857,
    projectFrom3857,
    projectTo4326: identity,
    projectFrom4326: identity,
    projectedBounds: bounds,
  };
}

/**
 * Ground Control Point (GCP) geolocation for raw Sentinel-1 GRD COGs.
 *
 * Raw S1 GRD COGs (Earth Search `sentinel-1-grd`, bucket `sentinel-s1-l1c`) are
 * ground-range: they carry NO affine transform, only a coarse GCP grid in the
 * GeoTIFF ModelTiepoint tag (33922). For the verified Andes VV scene that is a
 * regular 21x10 grid = 210 points, each `pixel,line -> lon,lat` (WGS84).
 *
 * `@developmentseed/geotiff` fetches the whole tag into a flat `modelTiepoint`
 * array but `transform.ts` uses only the first point ([3],[4]) and throws if no
 * affine exists. This module parses ALL tiepoints and builds a bilinear
 * pixel<->lon/lat interpolator over the grid. It is the geolocation engine we
 * drive the reprojection mesh with. No deck.gl dependency: pure functions,
 * standalone-testable against gdalinfo numbers.
 */

/** One geolocation tiepoint: raster (pixel,line) -> geographic (lon,lat) WGS84. */
export interface Gcp {
  pixel: number;
  line: number;
  lon: number;
  lat: number;
}

/**
 * Parse all GCPs from a GeoTIFF ModelTiepoint tag (33922) value.
 *
 * The tag is a flat array of N*6 doubles, each tiepoint being
 * `(i, j, k, x, y, z)` = `(pixel, line, 0, lon, lat, 0)` for a ground-range
 * GRD scene in a geographic CRS. We keep pixel/line and lon/lat, dropping the
 * unused k/z (always 0 here).
 */
export function parseGcps(modelTiepoint: ArrayLike<number>): Gcp[] {
  const n = modelTiepoint.length;
  if (n === 0 || n % 6 !== 0) {
    throw new Error(`ModelTiepoint length ${n} is not a positive multiple of 6`);
  }
  const gcps: Gcp[] = [];
  for (let o = 0; o < n; o += 6) {
    gcps.push({
      pixel: modelTiepoint[o],
      line: modelTiepoint[o + 1],
      lon: modelTiepoint[o + 3],
      lat: modelTiepoint[o + 4],
    });
  }
  return gcps;
}

/**
 * A rectilinear GCP grid: the tiepoints sit at the cross product of `cols`
 * (distinct pixel coordinates, ascending) and `rows` (distinct line
 * coordinates, ascending). `lon[r][c]` / `lat[r][c]` hold the geographic
 * coordinate at column `c`, row `r`. The S1 geolocation grid is exactly this
 * shape (verified 21x10); the last column/row are clamped to the raster edge,
 * so column/row spacing is regular but not perfectly uniform.
 */
export interface GcpGrid {
  cols: number[]; // ascending distinct pixel coordinates, length C
  rows: number[]; // ascending distinct line coordinates, length R
  lon: number[][]; // [R][C]
  lat: number[][]; // [R][C]
  width: number; // cols[C-1] (max pixel)
  height: number; // rows[R-1] (max line)
  /**
   * Per-cell lon/lat bounding boxes, indexed `[r][c]` over the (R-1)x(C-1)
   * cells. Lets {@link inverse} Newton-solve only the cell(s) that actually
   * contain a query point instead of every cell, the difference between a
   * usable warp and a stuttering one, since the reprojection mesh calls
   * `inverse` per candidate vertex.
   */
  cellLonMin: number[][];
  cellLonMax: number[][];
  cellLatMin: number[][];
  cellLatMax: number[][];
  /**
   * Least-squares affine fit of the whole grid's inverse map
   * `[lon,lat] -> [pixel,line]`, as `[a,b,c, d,e,f]` where
   * `pixel = a*lon + b*lat + c` and `line = d*lon + e*lat + f`. Used by
   * {@link inverse} for points that fall beyond even the padded ghost ring
   * (boundless coarse tiles map far past the grid): an O(1) estimate there
   * instead of a full per-cell Newton scan, which was the zoom-out bottleneck.
   * `null` if the fit is degenerate (tiny/collinear grid), in which case
   * `inverse` keeps its exact per-cell scan.
   */
  invAffine: [number, number, number, number, number, number] | null;
}

/**
 * Diagnostic counters for {@link inverse}'s code paths, so a zoom-out can be
 * profiled from the browser console (`globalThis.gcpInverseStats`) to confirm
 * which path dominates. Cheap to maintain; safe to leave in.
 */
export const gcpInverseStats = { fast: 0, edge: 0, affine: 0, scan: 0 };
(globalThis as { gcpInverseStats?: typeof gcpInverseStats }).gcpInverseStats =
  gcpInverseStats;

/**
 * Build a rectilinear grid from a flat GCP list. Validates that the points
 * form a complete cols x rows lattice (every (col,row) present exactly once),
 * which is the assumption the bilinear interpolator relies on.
 */
export function buildGcpGrid(gcps: Gcp[]): GcpGrid {
  const cols = uniqueSorted(gcps.map((g) => g.pixel));
  const rows = uniqueSorted(gcps.map((g) => g.line));
  const C = cols.length;
  const R = rows.length;
  if (C * R !== gcps.length) {
    throw new Error(
      `GCPs (${gcps.length}) do not form a complete ${C}x${R} grid (${C * R} expected)`
    );
  }
  const colIndex = new Map(cols.map((v, i) => [v, i]));
  const rowIndex = new Map(rows.map((v, i) => [v, i]));
  const lon: number[][] = rows.map(() => new Array(C).fill(NaN));
  const lat: number[][] = rows.map(() => new Array(C).fill(NaN));
  for (const g of gcps) {
    const c = colIndex.get(g.pixel)!;
    const r = rowIndex.get(g.line)!;
    if (!Number.isNaN(lon[r][c])) {
      throw new Error(`duplicate GCP at pixel ${g.pixel}, line ${g.line}`);
    }
    lon[r][c] = g.lon;
    lat[r][c] = g.lat;
  }

  return finalizeGrid(cols, rows, lon, lat);
}

/**
 * Assemble a {@link GcpGrid} from coordinate axes and node positions, computing
 * the per-cell lon/lat bbox index. Shared by {@link buildGcpGrid} and
 * {@link padGcpGridLinear}.
 */
function finalizeGrid(
  cols: number[],
  rows: number[],
  lon: number[][],
  lat: number[][],
): GcpGrid {
  const C = cols.length;
  const R = rows.length;
  const cellLonMin: number[][] = [];
  const cellLonMax: number[][] = [];
  const cellLatMin: number[][] = [];
  const cellLatMax: number[][] = [];
  for (let r = 0; r < R - 1; r++) {
    cellLonMin[r] = new Array(C - 1);
    cellLonMax[r] = new Array(C - 1);
    cellLatMin[r] = new Array(C - 1);
    cellLatMax[r] = new Array(C - 1);
    for (let c = 0; c < C - 1; c++) {
      const lo0 = lon[r][c], lo1 = lon[r][c + 1], lo2 = lon[r + 1][c], lo3 = lon[r + 1][c + 1];
      const la0 = lat[r][c], la1 = lat[r][c + 1], la2 = lat[r + 1][c], la3 = lat[r + 1][c + 1];
      cellLonMin[r][c] = Math.min(lo0, lo1, lo2, lo3);
      cellLonMax[r][c] = Math.max(lo0, lo1, lo2, lo3);
      cellLatMin[r][c] = Math.min(la0, la1, la2, la3);
      cellLatMax[r][c] = Math.max(la0, la1, la2, la3);
    }
  }
  return {
    cols, rows, lon, lat,
    width: cols[C - 1], height: rows[R - 1],
    cellLonMin, cellLonMax, cellLatMin, cellLatMax,
    invAffine: fitInverseAffine(cols, rows, lon, lat),
  };
}

/**
 * Least-squares fit of the affine inverse map `[lon,lat] -> [pixel,line]` over
 * all grid nodes. Two independent linear regressions (pixel and line each on
 * `[lon, lat, 1]`) sharing the same 3x3 normal-equation matrix. Returns
 * `[a,b,c, d,e,f]`, or `null` if the normal matrix is singular.
 */
function fitInverseAffine(
  cols: number[],
  rows: number[],
  lon: number[][],
  lat: number[][],
): [number, number, number, number, number, number] | null {
  const R = rows.length;
  const C = cols.length;
  // Normal-equation accumulators for design columns [lon, lat, 1].
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, n = 0;
  let bpx = 0, bpy = 0, bp1 = 0; // pixel target dotted with [lon, lat, 1]
  let blx = 0, bly = 0, bl1 = 0; // line  target dotted with [lon, lat, 1]
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const x = lon[r][c];
      const y = lat[r][c];
      const px = cols[c];
      const ln = rows[r];
      sxx += x * x; sxy += x * y; sx += x; syy += y * y; sy += y; n += 1;
      bpx += x * px; bpy += y * px; bp1 += px;
      blx += x * ln; bly += y * ln; bl1 += ln;
    }
  }
  // Symmetric normal matrix M = [[sxx,sxy,sx],[sxy,syy,sy],[sx,sy,n]].
  const m00 = sxx, m01 = sxy, m02 = sx;
  const m11 = syy, m12 = sy;
  const m22 = n;
  const det =
    m00 * (m11 * m22 - m12 * m12) -
    m01 * (m01 * m22 - m12 * m02) +
    m02 * (m01 * m12 - m11 * m02);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  // Inverse of the symmetric 3x3.
  const i00 = (m11 * m22 - m12 * m12) / det;
  const i01 = (m02 * m12 - m01 * m22) / det;
  const i02 = (m01 * m12 - m02 * m11) / det;
  const i11 = (m00 * m22 - m02 * m02) / det;
  const i12 = (m01 * m02 - m00 * m12) / det;
  const i22 = (m00 * m11 - m01 * m01) / det;
  const a = i00 * bpx + i01 * bpy + i02 * bp1;
  const b = i01 * bpx + i11 * bpy + i12 * bp1;
  const cc = i02 * bpx + i12 * bpy + i22 * bp1;
  const d = i00 * blx + i01 * bly + i02 * bl1;
  const e = i01 * blx + i11 * bly + i12 * bl1;
  const f = i02 * blx + i12 * bly + i22 * bl1;
  return [a, b, cc, d, e, f];
}

/**
 * Return a copy of `grid` ringed by one extrapolated ghost row/column on every
 * side, so the warp stays well-defined far outside the image without the
 * bilinear cross-term blowing up.
 *
 * Why this exists: COG tiles are boundless (padded past the image edge), and at
 * coarse overviews a single tile is mostly padding mapping FAR beyond the grid.
 * Plain bilinear extrapolation there is quadratic (the `u*t` cross term), so the
 * reprojection mesh can never approximate it under its error target and spins to
 * its iteration cap on every tile — the app's sluggishness. The ghost nodes are
 * placed by a SINGLE averaged edge gradient per side (and the sum at corners),
 * which makes every ghost cell a parallelogram; bilinear over a parallelogram is
 * exactly affine, so extrapolation is linear and the mesh converges immediately,
 * exactly like an affine geotransform.
 *
 * The interior is copied unchanged, so `forward`/`inverse` are identical there.
 * `width`/`height` and dataset bounds must still be derived from the ORIGINAL
 * grid (the caller does this before padding) — the ghost ring is geometry-only.
 */
export function padGcpGridLinear(grid: GcpGrid): GcpGrid {
  const { cols, rows, lon, lat } = grid;
  const C = cols.length;
  const R = rows.length;
  const colMargin = cols[C - 1] - cols[0];
  const rowMargin = rows[R - 1] - rows[0];

  // Averaged per-pixel edge gradients (constant across the edge → parallelogram
  // ghost cells → affine extrapolation).
  const gapR = cols[C - 1] - cols[C - 2];
  const gapL = cols[1] - cols[0];
  const gapT = rows[1] - rows[0];
  const gapB = rows[R - 1] - rows[R - 2];
  let gRx = 0, gRy = 0, gLx = 0, gLy = 0;
  for (let r = 0; r < R; r++) {
    gRx += (lon[r][C - 1] - lon[r][C - 2]); gRy += (lat[r][C - 1] - lat[r][C - 2]);
    gLx += (lon[r][1] - lon[r][0]); gLy += (lat[r][1] - lat[r][0]);
  }
  gRx /= R * gapR; gRy /= R * gapR; gLx /= R * gapL; gLy /= R * gapL;
  let gTx = 0, gTy = 0, gBx = 0, gBy = 0;
  for (let c = 0; c < C; c++) {
    gTx += (lon[1][c] - lon[0][c]); gTy += (lat[1][c] - lat[0][c]);
    gBx += (lon[R - 1][c] - lon[R - 2][c]); gBy += (lat[R - 1][c] - lat[R - 2][c]);
  }
  gTx /= C * gapT; gTy /= C * gapT; gBx /= C * gapB; gBy /= C * gapB;

  // Offsets to move a node from the edge out to the ghost ring (per side).
  const dLx = -gLx * colMargin, dLy = -gLy * colMargin; // left  (toward -col)
  const dRx = gRx * colMargin, dRy = gRy * colMargin;   // right (toward +col)
  const dTx = -gTx * rowMargin, dTy = -gTy * rowMargin; // top   (toward -row)
  const dBx = gBx * rowMargin, dBy = gBy * rowMargin;   // bottom(toward +row)

  const newCols = [cols[0] - colMargin, ...cols, cols[C - 1] + colMargin];
  const newRows = [rows[0] - rowMargin, ...rows, rows[R - 1] + rowMargin];
  const nC = C + 2;
  const nR = R + 2;
  const nlon: number[][] = Array.from({ length: nR }, () => new Array(nC).fill(0));
  const nlat: number[][] = Array.from({ length: nR }, () => new Array(nC).fill(0));

  // interior copy
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      nlon[r + 1][c + 1] = lon[r][c];
      nlat[r + 1][c + 1] = lat[r][c];
    }
  }
  // left / right ghost columns
  for (let r = 0; r < R; r++) {
    nlon[r + 1][0] = lon[r][0] + dLx; nlat[r + 1][0] = lat[r][0] + dLy;
    nlon[r + 1][nC - 1] = lon[r][C - 1] + dRx; nlat[r + 1][nC - 1] = lat[r][C - 1] + dRy;
  }
  // top / bottom ghost rows
  for (let c = 0; c < C; c++) {
    nlon[0][c + 1] = lon[0][c] + dTx; nlat[0][c + 1] = lat[0][c] + dTy;
    nlon[nR - 1][c + 1] = lon[R - 1][c] + dBx; nlat[nR - 1][c + 1] = lat[R - 1][c] + dBy;
  }
  // corners (sum of the two adjacent edge offsets → parallelogram corner cells)
  nlon[0][0] = lon[0][0] + dLx + dTx; nlat[0][0] = lat[0][0] + dLy + dTy;
  nlon[0][nC - 1] = lon[0][C - 1] + dRx + dTx; nlat[0][nC - 1] = lat[0][C - 1] + dRy + dTy;
  nlon[nR - 1][0] = lon[R - 1][0] + dLx + dBx; nlat[nR - 1][0] = lat[R - 1][0] + dLy + dBy;
  nlon[nR - 1][nC - 1] = lon[R - 1][C - 1] + dRx + dBx; nlat[nR - 1][nC - 1] = lat[R - 1][C - 1] + dRy + dBy;

  return finalizeGrid(newCols, newRows, nlon, nlat);
}

/**
 * Forward map: raster (pixel,line) -> [lon, lat] by bilinear interpolation
 * within the enclosing grid cell. Inputs outside the grid extent are clamped to
 * the edge (edge scenes / antimeridian are out of scope for v1).
 */
export function forward(grid: GcpGrid, pixel: number, line: number): [number, number] {
  const { c0, t } = locate(grid.cols, pixel);
  const { c0: r0, t: u } = locate(grid.rows, line);
  const c1 = Math.min(c0 + 1, grid.cols.length - 1);
  const r1 = Math.min(r0 + 1, grid.rows.length - 1);
  const lon = bilerp(grid.lon, r0, r1, c0, c1, u, t);
  const lat = bilerp(grid.lat, r0, r1, c0, c1, u, t);
  return [lon, lat];
}

/**
 * Inverse map: geographic [lon,lat] -> [pixel, line]. The grid is a smooth,
 * near-affine warp per cell, so we (1) find the cell whose lon/lat quad
 * contains the target, then (2) solve the local bilinear map for fractional
 * (col,row) via a few Newton steps. Returns the best-effort pixel/line even if
 * the point is slightly outside (clamped). Adequate for tile-bounds queries;
 * not a high-precision geodetic inverse.
 */
export function inverse(grid: GcpGrid, lon: number, lat: number): [number, number] {
  const R = grid.rows.length;
  const C = grid.cols.length;
  let best: { r: number; c: number; u: number; t: number; err: number } | null = null;

  // Fast jump: the global affine fit lands within ~1 cell of the true cell on a
  // smooth warp, so Newton-solve only a 3x3 neighborhood around the estimate
  // instead of bbox-scanning all (R-1)*(C-1) cells. This is the hot path the
  // reprojection mesh hammers per candidate sample (and the mesh builds
  // synchronously on the main thread), so the O(cells)->O(9) cut is what keeps a
  // detail-zoom load from freezing. The full scan below stays as the exact
  // fallback for neighborhood misses (strong warp curvature) and degenerate grids.
  if (grid.invAffine) {
    const [aa, bb, cc, dd, ee, ff] = grid.invAffine;
    const pxEst = aa * lon + bb * lat + cc;
    const pyEst = dd * lon + ee * lat + ff;
    const spanX = grid.cols[C - 1] - grid.cols[0];
    const spanY = grid.rows[R - 1] - grid.rows[0];
    // Only treat as off-swath when the estimate is FAR (>1 grid span) past the
    // grid: that's the boundless coarse-tile padding, where the affine estimate
    // is plenty (O(1)) and the pixels are discarded. Near the edges the fit can
    // land a little outside, so don't bail there, solve the neighborhood.
    if (
      pxEst < grid.cols[0] - spanX || pxEst > grid.cols[C - 1] + spanX ||
      pyEst < grid.rows[0] - spanY || pyEst > grid.rows[R - 1] + spanY
    ) {
      gcpInverseStats.affine++;
      return [pxEst, pyEst];
    }
    // Newton-solve a 3x3 neighborhood around the affine-estimated cell. `locate`
    // clamps the index to a valid cell even when the estimate falls just outside
    // (corners). On a miss, fall through to the exact bbox scan.
    const cEst = locate(grid.cols, pxEst).c0;
    const rEst = locate(grid.rows, pyEst).c0;
    const rHi = Math.min(R - 2, rEst + 1);
    const cHi = Math.min(C - 2, cEst + 1);
    for (let r = Math.max(0, rEst - 1); r <= rHi; r++) {
      for (let c = Math.max(0, cEst - 1); c <= cHi; c++) {
        const sol = solveCell(grid, r, c, lon, lat);
        if (!sol) continue;
        if (sol.u >= -1e-6 && sol.u <= 1 + 1e-6 && sol.t >= -1e-6 && sol.t <= 1 + 1e-6) {
          gcpInverseStats.fast++;
          return cellToPixel(grid, r, c, sol.u, sol.t);
        }
      }
    }
  }

  // Exact path (neighborhood miss or degenerate grid): Newton-solve only cells
  // whose precomputed lon/lat bbox contains the target. A tiny epsilon pads the
  // bbox so points exactly on a shared edge aren't missed by both cells.
  const EPS = 1e-7;
  for (let r = 0; r < R - 1; r++) {
    for (let c = 0; c < C - 1; c++) {
      if (
        lon < grid.cellLonMin[r][c] - EPS || lon > grid.cellLonMax[r][c] + EPS ||
        lat < grid.cellLatMin[r][c] - EPS || lat > grid.cellLatMax[r][c] + EPS
      ) {
        continue; // bbox can't contain the point
      }
      const sol = solveCell(grid, r, c, lon, lat);
      if (!sol) continue;
      const inside = sol.u >= -1e-6 && sol.u <= 1 + 1e-6 && sol.t >= -1e-6 && sol.t <= 1 + 1e-6;
      if (inside) {
        gcpInverseStats.fast++;
        return cellToPixel(grid, r, c, sol.u, sol.t);
      }
      if (best === null || sol.err < best.err) best = { r, c, ...sol };
    }
  }
  // No cell strictly contained the point. Return the nearest cell's solution
  // UNCLAMPED so it linearly extrapolates past the grid edge, the exact inverse
  // of `forward`'s edge extrapolation. Clamping here would refold the boundless
  // padding region and reintroduce the non-convergence `forward` just fixed.
  if (best !== null) {
    gcpInverseStats.edge++;
    return cellToPixel(grid, best.r, best.c, best.u, best.t);
  }

  // Off-swath: the point is beyond even the padded ghost ring (a coarse,
  // boundless tile maps far past the grid). The old code Newton-scanned EVERY
  // cell here, O(cells * iters) per sample, and the reprojection mesh calls
  // this per candidate vertex, so on zoom-out it dominated the main thread.
  // The grid's global affine fit is an excellent estimate this far out (and
  // these pixels are off-image: discarded as nodata by the dB shader, or only
  // used for tile-range bounds), so use it directly, O(1), no Newton.
  if (grid.invAffine) {
    gcpInverseStats.affine++;
    const [a, b, c, d, e, f] = grid.invAffine;
    return [a * lon + b * lat + c, d * lon + e * lat + f];
  }

  // Degenerate grid (no affine fit): keep the exact per-cell scan.
  gcpInverseStats.scan++;
  for (let r = 0; r < R - 1; r++) {
    for (let c = 0; c < C - 1; c++) {
      const sol = solveCell(grid, r, c, lon, lat);
      if (!sol) continue;
      if (best === null || sol.err < best.err) best = { r, c, ...sol };
    }
  }
  if (best === null) return [NaN, NaN];
  return cellToPixel(grid, best.r, best.c, best.u, best.t);
}

// --- internals ---

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Locate `x` in an ascending coordinate array. Returns the lower cell index
 * `c0` (always in [0, last-1]) and the local fraction `t` toward `c0+1`.
 *
 * Past the ends, `t` EXTRAPOLATES (t<0 below coords[0], t>1 above coords[last])
 * using the first/last cell's spacing, instead of clamping. This keeps `forward`
 * linear and continuous past the grid edge, matching an affine geotransform. It
 * matters because COG tiles are boundless (padded past the image edge): clamping
 * would fold every out-of-grid pixel onto the edge, a discontinuity the
 * reprojection mesh can never resolve (it spins to its iteration cap).
 */
function locate(coords: number[], x: number): { c0: number; t: number } {
  const last = coords.length - 1;
  if (x <= coords[0]) {
    const span = coords[1] - coords[0];
    return { c0: 0, t: span === 0 ? 0 : (x - coords[0]) / span };
  }
  if (x >= coords[last]) {
    const span = coords[last] - coords[last - 1];
    return { c0: last - 1, t: span === 0 ? 0 : (x - coords[last - 1]) / span };
  }
  // binary search for the cell [c0, c0+1] containing x
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (coords[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = coords[lo + 1] - coords[lo];
  return { c0: lo, t: span === 0 ? 0 : (x - coords[lo]) / span };
}

function bilerp(
  grid: number[][],
  r0: number,
  r1: number,
  c0: number,
  c1: number,
  u: number,
  t: number
): number {
  const top = grid[r0][c0] * (1 - t) + grid[r0][c1] * t;
  const bot = grid[r1][c0] * (1 - t) + grid[r1][c1] * t;
  return top * (1 - u) + bot * u;
}

/** Convert a cell-local (u along row, t along col) back to absolute pixel/line. */
function cellToPixel(
  grid: GcpGrid,
  r: number,
  c: number,
  u: number,
  t: number
): [number, number] {
  const pixel = grid.cols[c] * (1 - t) + grid.cols[c + 1] * t;
  const line = grid.rows[r] * (1 - u) + grid.rows[r + 1] * u;
  return [pixel, line];
}

/**
 * Solve the bilinear map of cell (r,c) for local (u,t) given a target lon/lat,
 * via Newton iteration. The bilinear forward is:
 *   P(u,t) = (1-u)(1-t)*A + (1-u)t*B + u(1-t)*C + u*t*D
 * with A,B,C,D the four corner lon/lat. Returns null if the Jacobian is
 * singular. `err` is the residual distance in degrees at the returned (u,t).
 */
function solveCell(
  grid: GcpGrid,
  r: number,
  c: number,
  lon: number,
  lat: number
): { u: number; t: number; err: number } | null {
  const Ax = grid.lon[r][c],
    Ay = grid.lat[r][c];
  const Bx = grid.lon[r][c + 1],
    By = grid.lat[r][c + 1];
  const Cx = grid.lon[r + 1][c],
    Cy = grid.lat[r + 1][c];
  const Dx = grid.lon[r + 1][c + 1],
    Dy = grid.lat[r + 1][c + 1];
  let u = 0.5;
  let t = 0.5;
  for (let iter = 0; iter < 12; iter++) {
    const omu = 1 - u;
    const omt = 1 - t;
    const px = omu * omt * Ax + omu * t * Bx + u * omt * Cx + u * t * Dx;
    const py = omu * omt * Ay + omu * t * By + u * omt * Cy + u * t * Dy;
    const fx = px - lon;
    const fy = py - lat;
    // partials
    const dpx_du = -omt * Ax - t * Bx + omt * Cx + t * Dx;
    const dpx_dt = -omu * Ax + omu * Bx - u * Cx + u * Dx;
    const dpy_du = -omt * Ay - t * By + omt * Cy + t * Dy;
    const dpy_dt = -omu * Ay + omu * By - u * Cy + u * Dy;
    const det = dpx_du * dpy_dt - dpx_dt * dpy_du;
    if (Math.abs(det) < 1e-18) return null;
    const du = (fx * dpy_dt - fy * dpx_dt) / det;
    const dt = (dpx_du * fy - dpy_du * fx) / det;
    u -= du;
    t -= dt;
    if (Math.abs(du) < 1e-12 && Math.abs(dt) < 1e-12) break;
  }
  const omu = 1 - u;
  const omt = 1 - t;
  const px = omu * omt * Ax + omu * t * Bx + u * omt * Cx + u * t * Dx;
  const py = omu * omt * Ay + omu * t * By + u * omt * Cy + u * t * Dy;
  const err = Math.hypot(px - lon, py - lat);
  return { u, t, err };
}

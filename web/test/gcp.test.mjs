/**
 * Standalone validation of the GCP parser + interpolator (work items A & B)
 * against ground-truth GCPs dumped from gdalinfo for the verified Andes VV
 * scene. No deck.gl, no browser: `node web/test/gcp.test.mjs`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseGcps, buildGcpGrid, forward, inverse } from "../src/gcp.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fix = JSON.parse(readFileSync(join(here, "fixtures/andes-vv-gcps.json"), "utf8"));

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}  ${detail}`);
  }
}

// Reconstruct the flat ModelTiepoint tag (i,j,k,x,y,z) from the fixture so we
// exercise parseGcps exactly as @developmentseed/geotiff would hand it to us.
const flat = [];
for (const g of fix.gcps) flat.push(g.pixel, g.line, 0, g.lon, g.lat, 0);

console.log(`\nA. parseGcps (${fix.scene})`);
const gcps = parseGcps(flat);
check("parses 210 GCPs", gcps.length === 210, `got ${gcps.length}`);
const g0 = gcps[0];
check(
  "GCP[0] (0,0) -> (-72.3714, -33.708)",
  g0.pixel === 0 && g0.line === 0 && near(g0.lon, fix.gcps[0].lon, 1e-9) && near(g0.lat, fix.gcps[0].lat, 1e-9),
  JSON.stringify(g0)
);

console.log("\nB. buildGcpGrid");
const grid = buildGcpGrid(gcps);
check("21 columns x 10 rows", grid.cols.length === 21 && grid.rows.length === 10);
check("extent matches raster (26116 x 16883)", grid.width === 26116 && grid.height === 16883);

console.log("\nB. forward() reproduces every GCP node (bilinear is exact at nodes)");
let maxNodeErr = 0;
for (const g of gcps) {
  const [lon, lat] = forward(grid, g.pixel, g.line);
  maxNodeErr = Math.max(maxNodeErr, Math.hypot(lon - g.lon, lat - g.lat));
}
check("max node error < 1e-9 deg", maxNodeErr < 1e-9, `maxNodeErr=${maxNodeErr.toExponential(3)}`);

console.log("\nB. forward() at a cell midpoint lies between its neighbors");
{
  // midpoint of pixel between col0..col1, line between row0..row1
  const pmid = (grid.cols[0] + grid.cols[1]) / 2;
  const lmid = (grid.rows[0] + grid.rows[1]) / 2;
  const [lon, lat] = forward(grid, pmid, lmid);
  const lons = [grid.lon[0][0], grid.lon[0][1], grid.lon[1][0], grid.lon[1][1]];
  const lats = [grid.lat[0][0], grid.lat[0][1], grid.lat[1][0], grid.lat[1][1]];
  check(
    "midpoint lon/lat within corner bounds",
    lon >= Math.min(...lons) && lon <= Math.max(...lons) && lat >= Math.min(...lats) && lat <= Math.max(...lats),
    `lon=${lon} lat=${lat}`
  );
}

console.log("\nB. inverse() round-trips forward() within ~1 pixel");
{
  let maxPixErr = 0;
  let worst = null;
  // sample a grid of interior pixels
  for (let pf = 0.05; pf < 1; pf += 0.137) {
    for (let lf = 0.05; lf < 1; lf += 0.211) {
      const px = pf * grid.width;
      const ly = lf * grid.height;
      const [lon, lat] = forward(grid, px, ly);
      const [pi, li] = inverse(grid, lon, lat);
      const e = Math.hypot(pi - px, li - ly);
      if (e > maxPixErr) {
        maxPixErr = e;
        worst = { px, ly, pi, li };
      }
    }
  }
  check("max round-trip error < 1 px", maxPixErr < 1, `maxPixErr=${maxPixErr.toFixed(4)} px @ ${JSON.stringify(worst)}`);
}

console.log("\nB. inverse() of GCP[0] geographic returns ~ (0,0)");
{
  const [pi, li] = inverse(grid, g0.lon, g0.lat);
  check("inverse(GCP[0]) ~ (0,0)", Math.hypot(pi, li) < 1, `got (${pi.toFixed(3)}, ${li.toFixed(3)})`);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

function near(a, b, eps) {
  return Math.abs(a - b) <= eps;
}

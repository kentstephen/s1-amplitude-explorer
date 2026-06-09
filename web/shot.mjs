// Headless smoke test: drive Brave, wait for S1 GRD COG tiles to paint over the
// Andes, capture a screenshot + console. Throwaway verification helper.
import pw from "/Users/stephenk/dev/projects/deckgl-raster-mapterhorn-s2/web/node_modules/playwright-core/index.js";
const { chromium } = pw;

const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const URL = "http://localhost:5455/s1-amplitude-explorer/";
const OUT = process.argv[2] || "/tmp/s1-shot.png";
const WAIT = Number(process.argv[3] || 25000);

const browser = await chromium.launch({
  executablePath: BRAVE,
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
let stac = 0, errors = 0;
page.on("console", (m) => {
  const t = m.text();
  if (/\[stac\]/.test(t)) { stac++; console.log(`[console] ${t}`); }
  if (m.type() === "error") { errors++; console.log(`[console.error] ${t}`); }
});
page.on("pageerror", (e) => { errors++; console.log(`[pageerror] ${e.message}`); });
page.on("response", (r) => {
  const u = r.url();
  if (/sentinel-s1-l1c|iw-vv|iw-vh/.test(u)) console.log(`[tile] ${r.status()} ${u.slice(0, 100)}`);
});
await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => console.log("[goto]", e.message));
await page.waitForTimeout(WAIT);
await page.screenshot({ path: OUT });
console.log(`\nstac msgs: ${stac} · errors: ${errors} · screenshot -> ${OUT}`);
await browser.close();

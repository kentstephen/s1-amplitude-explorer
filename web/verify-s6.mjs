// Session-6 headless verification for items 7 (keybindings) + 8 (MIN_ZOOM floor,
// culling sanity). Drives Brave on a real GPU via the sibling project's
// playwright-core. Run: node verify-s6.mjs
// playwright-core is borrowed from the sibling project (see docs handoff). Override
// with PLAYWRIGHT_CORE / BRAVE_BIN / APP_URL env vars if those paths move.
const PW_PATH = process.env.PLAYWRIGHT_CORE ||
  "/Users/stephenk/dev/projects/deckgl-raster-mapterhorn-s2/web/node_modules/playwright-core/index.js";
const pw = (await import(PW_PATH)).default;
const { chromium } = pw;

const URL = process.env.APP_URL || "http://localhost:5455/s1-amplitude-explorer/";
const BRAVE = process.env.BRAVE_BIN || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const results = [];
const ok = (n, p, extra = "") => { results.push([p, n, extra]); console.log(`${p ? "PASS" : "FAIL"}  ${n}${extra ? "  :: " + extra : ""}`); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: BRAVE,
  headless: true,
  args: ["--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--no-sandbox"],
});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
const jsErrors = [];   // uncaught JS (real bugs)
const httpErrors = []; // resource >=400 (SAR COG overviews 404 sporadically; informational)
page.on("pageerror", (e) => jsErrors.push(String(e)));
page.on("response", (r) => { if (r.status() >= 400) httpErrors.push(r.status() + " " + r.url().slice(-60)); });

await page.goto(URL, { waitUntil: "networkidle" });
// Panel renders client-side; wait for the header.
await page.waitForFunction(() => document.body.innerText.includes("SENTINEL-1"), { timeout: 20000 });
await sleep(800);

const txt = () => page.evaluate(() => document.body.innerText);

// --- Item 7: keybindings ---------------------------------------------------
// Ensure focus is on body, not an input.
await page.evaluate(() => document.activeElement && document.activeElement.blur());

// Export + view controls now live behind the "MORE" progressive-disclosure
// expander; open it so EXPORT MODE text is in the DOM to assert against.
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /\b(MORE|LESS)\b/.test(x.innerText));
  if (b && /\bMORE\b/.test(b.innerText)) b.click();
});
await sleep(300);
ok("panel: MORE expander reveals export controls", /EXPORT MODE/.test(await txt()), "");

// x = export mode toggle
let before = await txt();
await page.keyboard.press("x"); await sleep(250);
let after = await txt();
ok("key 'x' toggles export mode", /EXPORT MODE OFF/.test(before) && /EXPORT MODE ON/.test(after), `${/EXPORT MODE (ON|OFF)/.exec(before)?.[0]} -> ${/EXPORT MODE (ON|OFF)/.exec(after)?.[0]}`);
await page.keyboard.press("x"); await sleep(250); // back off

// c = amplitude <-> composite
before = await txt();
await page.keyboard.press("c"); await sleep(300);
after = await txt();
// dB-stretch label is CSS-uppercased in the DOM ("DB STRETCH"); match case-insensitively.
const wasAmp = /VV\s*·\s*dB stretch/i.test(before);
const nowComposite = /VV\/VH\s*·\s*dB stretch/i.test(after);
ok("key 'c' toggles amplitude -> composite", wasAmp && nowComposite, `amp=${wasAmp} composite=${nowComposite}`);

// b = palette toggle (only meaningful in composite; legend text adapts).
// Natural palette legend contains "R · VV"; cbSafe does not.
const compLegend1 = await txt();
await page.keyboard.press("b"); await sleep(300);
const compLegend2 = await txt();
const natural1 = /R\s*·\s*VV/.test(compLegend1);
const natural2 = /R\s*·\s*VV/.test(compLegend2);
ok("key 'b' toggles composite palette (legend changes)", natural1 !== natural2, `naturalLegend ${natural1} -> ${natural2}`);

// back to amplitude
await page.keyboard.press("c"); await sleep(300);
const backAmp = await txt();
ok("key 'c' toggles composite -> amplitude", /VV\s*·\s*dB stretch/i.test(backAmp) && !/VV\/VH/i.test(backAmp), "");

// --- Item 8: MIN_ZOOM floor ------------------------------------------------
// Footer shows "zoom X.XX". Wheel-out hard over the map canvas, then read it.
const canvas = await page.$("canvas");
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 240); await sleep(20); }
await sleep(600);
const zoomTxt = await txt();
const zoomVal = parseFloat(/zoom\s+([0-9.]+)/.exec(zoomTxt)?.[1] ?? "NaN");
ok("MIN_ZOOM floor holds (>= 5 after zooming out)", zoomVal >= 4.99, `zoom settled at ${zoomVal}`);

// --- Item 8: culling sanity (load, pan away, pan back; no crash) -----------
// Zoom back in to the default scene first.
for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -240); await sleep(20); }
await sleep(400);
// 's' = search this view. Search is async (STAC over network); poll for the result.
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await page.keyboard.press("s");
let sawCandidates = false;
try {
  await page.waitForFunction(() => /candidate/i.test(document.body.innerText), { timeout: 15000 });
  sawCandidates = true;
} catch {}
const searched = await txt();
ok("key 's' runs search-this-view (candidates appear)", sawCandidates, /([0-9]+ candidates[^\n]*)/.exec(searched)?.[1] ?? "no 'candidate' text");

if (sawCandidates) {
  await page.keyboard.press("Enter"); // load most complete
  // wait for scenes to draw or settle (up to 25s)
  try {
    await page.waitForFunction(() => /drawn|loaded/.test(document.body.innerText), { timeout: 25000 });
    ok("key 'Enter' loads a mosaic", true, "");
  } catch { ok("key 'Enter' loads a mosaic", false, "no drawn/loaded within 25s"); }
  await sleep(3000);
  // pan far away (drag), then back; confirm no crash + zoom readout still live
  await page.mouse.move(cx, cy); await page.mouse.down();
  await page.mouse.move(cx - 600, cy - 400, { steps: 12 }); await page.mouse.up();
  await sleep(2500);
  await page.mouse.move(cx, cy); await page.mouse.down();
  await page.mouse.move(cx + 600, cy + 400, { steps: 12 }); await page.mouse.up();
  await sleep(2500);
  const afterPan = await txt();
  ok("culling pan round-trip does not crash", /zoom\s+[0-9.]/.test(afterPan), "");
}

ok("no uncaught JS errors", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));
if (httpErrors.length) console.log(`  (info) ${httpErrors.length} HTTP >=400 (sporadic COG overview 404s, non-fatal): ${httpErrors.slice(0, 3).join(", ")}`);

const passed = results.filter((r) => r[0]).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);

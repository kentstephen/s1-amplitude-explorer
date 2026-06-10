/**
 * Standalone validation of the coverage-first selection (W3). No network, no
 * browser: `node --experimental-strip-types web/test/coverage.test.mjs`.
 * `coverage.ts` imports only a TYPE from stac.ts, erased at runtime, so it runs
 * in isolation.
 */
import { selectCoverageFirst, groupByDate, groupKey } from "../src/coverage.ts";

let pass = 0,
  fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}  ${detail}`);
  }
}

// Build synthetic candidates: two distinct frames (A, B) over a few dates.
// Frame A: relative orbit 5, bbox ~[-70,-33,-68,-31]. Frame B: orbit 156, ~[-68,-33,-66,-31].
function item(id, datetime, ro, bbox) {
  return { id, bbox, datetime, orbit: "descending", geometry: null, relativeOrbit: ro, assets: { vv: { href: `x://${id}` } } };
}
const A = (d) => item(`A-${d}`, `${d}T23:00:00Z`, 5, [-70, -33, -68, -31]);
const B = (d) => item(`B-${d}`, `${d}T23:10:00Z`, 156, [-68, -33, -66, -31]);

const candidates = [
  A("2026-06-05"), A("2026-05-30"), A("2026-05-18"),
  B("2026-06-01"), B("2026-05-20"),
];

// 1. The two frames group separately, repeats collapse.
const keys = new Set(candidates.map(groupKey));
check("two distinct footprint groups", keys.size === 2, `got ${keys.size}`);

// 2. Coverage-first reserves BOTH frames (no bare gap) before filling.
const sel = selectCoverageFirst(candidates, { maxScenes: 8, perGroup: 2 });
const frames = new Set(sel.items.map((s) => s.id[0]));
check("both frames covered", sel.footprintsCovered === 2 && frames.has("A") && frames.has("B"), `covered=${sel.footprintsCovered}`);

// 3. Tight budget still reserves one per frame (coverage beats fill).
const tight = selectCoverageFirst(candidates, { maxScenes: 2, perGroup: 2 });
const tightFrames = new Set(tight.items.map((s) => s.id[0]));
check("budget=2 keeps both frames", tight.items.length === 2 && tightFrames.size === 2, `items=${tight.items.length} frames=${tightFrames.size}`);

// 4. Render order: most-recent draws LAST (on top).
const last = sel.items[sel.items.length - 1];
check("most-recent scene drawn last", last.datetime.startsWith("2026-06-05"), `last=${last.datetime}`);

// 5. groupByDate orders best-coverage date first. 2026-06-05 has only frame A (1),
//    but no single date here covers both frames, so all are 1-footprint; ties
//    break by recency → newest first.
const grouped = groupByDate(candidates);
check("date stepper newest-first on ties", grouped[0].date === "2026-06-05", `first=${grouped[0].date}`);
check("groupByDate returns all distinct dates", grouped.length === 5, `n=${grouped.length}`);

// 6. A date where both frames share the day ranks ABOVE single-frame dates.
const shared = [...candidates, B("2026-06-05")];
const g2 = groupByDate(shared);
check("multi-footprint date ranks first", g2[0].date === "2026-06-05" && g2[0].footprints === 2, `first=${g2[0].date} fp=${g2[0].footprints}`);

// 7. HARD CAP: many overlapping frames (the LA case, 12 distinct groups) must
//    NOT load one-per-group; the cap is absolute.
const many = [];
for (let g = 0; g < 12; g++) {
  many.push(item(`G${g}-a`, "2026-06-04T23:00:00Z", g, [-118 + g * 0.01, 33, -116 + g * 0.01, 35]));
}
const capped = selectCoverageFirst(many, { maxScenes: 3 });
check("12 overlapping frames cap to 3 scenes", capped.items.length === 3, `items=${capped.items.length}`);
check("footprintsCovered reflects loaded set", capped.footprintsCovered === 3, `fp=${capped.footprintsCovered}`);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

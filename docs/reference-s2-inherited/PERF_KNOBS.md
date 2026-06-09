# MultiCOGLayer perf knobs

Notes on what `@developmentseed/deck.gl-geotiff`'s `MultiCOGLayer`
exposes for tile-load performance, what each one buys, and what each one
costs to debug. Decided to ship just the two safest and let the rest sit
behind explicit opt-in.

## What's available

`MultiCOGLayer` re-exposes five `TileLayer` props plus its own
`DecoderPool` slot (`multi-cog-layer.ts:148`):

```ts
debounceTime, maxCacheSize, maxCacheByteSize, maxRequests, refinementStrategy
pool?: DecoderPool
```

## Per-knob assessment

| knob                              | win                                                                     | drawback                                                                                                                                              | verdict       |
| ---                               | ---                                                                     | ---                                                                                                                                                   | ---           |
| `refinementStrategy: "best-available"` | parent tile upsamples while child loads; feels instant on zoom-in       | **transient 1-row stair-stepped seams** where loaded child tiles meet still-upsampled parents at different overview levels; pixel grids don't subpixel-align across levels. Goes away when the child finishes loading. | ship, with caveat |
| `maxRequests: 16`                 | more concurrent fetches; meaningful on HTTP/2 (CloudFront/source.coop)  | on flaky networks more timeouts land at once; failure scoreboard gets noisier; reversible                                                             | ship          |
| `maxCacheByteSize: 512MB`         | revisited tiles render instantly                                        | long sessions on memory-constrained machines can swap                                                                                                  | hold          |
| `debounceTime: 0`                 | instant fetches on zoom-end                                             | **trap.** Fast scroll fires dozens of doomed requests. Our `AbortSignal` plumbing isn't great — those requests still hold slots and spam the console. Default 100 ms exists for a reason. | hold          |
| `pool: shared DecoderPool`        | decode workers shared across items; saturates cores at high item count  | must be a single module-scope instance; if you ever forget and construct a second pool the workers fight for the same cores and it slows down         | hold          |

## What's not available

- No prefetch (hover or neighbour-tile).
- No "always use level z+1" override.
- No way to hand `MultiCOGLayer` an already-opened `GeoTIFF` — only
  URLs. Header warming externally only helps if `chunkd`'s HTTP cache
  catches the second open.

## Decision

Two knobs only:

```ts
refinementStrategy: "best-available",
maxRequests: 16,
```

Two knobs are debuggable. Five is "which one regressed." If we ever hit
real pain we already know which knob to reach for and can A/B with one
prop change at a time.

### Refinement is a pick-your-poison

You don't get a free lunch on tile-load presentation:

- `"best-available"` → upsampled-parent shows during load; **transient
  1-row seams** where loaded child meets upsampled parent at different
  overview levels.
- `"no-overlap"` / `"never"` (default) → no seams, but cells render
  **blank** until the child tile finishes loading. Tiles pop in
  rather than fade-from-blurry. Subjectively slower.

Shipped `"best-available"` because the blur-to-sharp transition reads as
"working" and the seam goes away on its own. For a clean screenshot, set
`refinementStrategy: "never"`, pan, wait for everything to load, capture.
Could be wired to a "screenshot mode" toggle if it becomes a frequent
need.

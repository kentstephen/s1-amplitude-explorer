import type { GetTileDataOptions } from "@developmentseed/deck.gl-geotiff";
import type { GeoTIFF, Overview } from "@developmentseed/geotiff";
import type { Texture } from "@luma.gl/core";
import { reportFailed } from "./loadStats";

async function fetchTileWithRetry(
  image: GeoTIFF | Overview,
  x: number,
  y: number,
  signal: AbortSignal | undefined,
  attempts = 3,
) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await image.fetchTile(x, y, { signal, boundless: false });
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** i + Math.random() * 150));
      }
    }
  }
  console.error(`[tile] giving up on tile ${x},${y}`, lastErr);
  // Surface terminal decode failures to the in-panel scoreboard, not just the
  // console. Aborts (AOI/mode change) are expected churn, not failures.
  if (!signal?.aborted) {
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    reportFailed(`tile ${x},${y}`, msg);
  }
  throw lastErr;
}

export type S2TileData = {
  width: number;
  height: number;
  texture: Texture;
};

export async function getTileData(
  image: GeoTIFF | Overview,
  options: GetTileDataOptions,
  // Texture magnification filter. "nearest" = honest 10 m blocks past native
  // zoom; "linear" = smooth (interpolated, no added detail). Toggleable from
  // the panel so the two can be compared at the same zoom.
  filter: "nearest" | "linear" = "nearest",
): Promise<S2TileData> {
  const { device, x, y, signal } = options;
  const tile = await fetchTileWithRetry(image, x, y, signal);
  const { array } = tile;
  const { width, height } = array;

  if (array.layout === "band-separate") {
    throw new Error("Sentinel-2 TCI expected pixel-interleaved");
  }

  const src = array.data;
  if (!(src instanceof Uint8Array)) {
    throw new Error(`expected Uint8Array, got ${src?.constructor?.name}`);
  }
  const pixels = width * height;
  const rgba = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    rgba[i * 4] = src[i * 3];
    rgba[i * 4 + 1] = src[i * 3 + 1];
    rgba[i * 4 + 2] = src[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }

  const texture = device.createTexture({
    data: rgba,
    format: "rgba8unorm",
    width,
    height,
    sampler: {
      minFilter: filter,
      magFilter: filter,
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    },
  });

  return { width, height, texture };
}

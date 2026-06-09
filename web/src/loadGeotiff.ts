import { SourceCache, SourceChunk } from "@chunkd/middleware";
import { SourceView } from "@chunkd/source";
import { SourceHttp } from "@chunkd/source-http";
import { GeoTIFF } from "@developmentseed/geotiff";

/**
 * Mirrors `GeoTIFF.fromUrl`, but does an upfront HEAD so the source's
 * `metadata.size` is set before any range read. Works around a
 * `@chunkd/source-http` regression where `Content-Range` parsing on a
 * range-fetched response can leave `metadata.size` unset, which silently
 * breaks COG reads (chunkd PR #1666, stac-map issue #459). `SourceHttp.fetch`
 * won't overwrite `metadata` once populated, so the HEAD result wins.
 */
export async function loadGeoTIFF(
  href: string,
  options: { chunkSize?: number; cacheSize?: number } = {},
): Promise<GeoTIFF> {
  const { chunkSize = 32 * 1024, cacheSize = 1024 * 1024 } = options;
  const source = new SourceHttp(href, {});
  await source.head();
  const chunk = new SourceChunk({ size: chunkSize });
  const cache = new SourceCache({ size: cacheSize });
  const view = new SourceView(source, [chunk, cache]);
  return await GeoTIFF.open({
    dataSource: source,
    headerSource: view,
  });
}

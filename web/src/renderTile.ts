import type {
  RasterModule,
  RenderTileResult,
} from "@developmentseed/deck.gl-raster";
import { CreateTexture } from "@developmentseed/deck.gl-raster/gpu-modules";
import type { S2TileData } from "./getTileData";
import { discardBlack } from "./discardBlack";
import { ScaleColor } from "./shaders/scaleColor";

/**
 * RGB render pipeline for the precomposed 3-band TCI COG: upload the texture,
 * discard no-data (0,0,0) fill, then a uniform RGB gain so the whole frame can
 * be dimmed/brightened for image-making. TCI is already 8-bit stretched, so
 * `gain` is a multiply on the finished color (1.0 = faithful), applied
 * per-pixel at every zoom / overview level.
 */
export function renderTile(tileData: S2TileData, gain = 1.0): RenderTileResult {
  const renderPipeline: RasterModule[] = [
    { module: CreateTexture, props: { textureName: tileData.texture } },
    { module: discardBlack },
    { module: ScaleColor, props: { factor: gain } },
  ];
  return { renderPipeline };
}

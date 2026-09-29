import type { FrameHandle } from "../engine/types.ts";

type Offset = FrameHandle["offset"];

export function mapFramePoint(point: { x: number; y: number }, offset: Offset) {
  return {
    x: offset.x + point.x * (offset.scaleX ?? 1),
    y: offset.y + point.y * (offset.scaleY ?? 1),
  };
}

export function mapFrameRect(
  rect: { x: number; y: number; width: number; height: number },
  offset: Offset,
) {
  return {
    ...rect,
    ...mapFramePoint(rect, offset),
    width: rect.width * (offset.scaleX ?? 1),
    height: rect.height * (offset.scaleY ?? 1),
  };
}

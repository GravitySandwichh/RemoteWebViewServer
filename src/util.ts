export function hash32(buf: Buffer): number {
  let h = 0x811C9DC5 >>> 0;
  for (let i = 0; i < buf.length; i += 16) {
    h ^= buf[i]; h = (h * 0x01000193) >>> 0;
    h ^= buf[i + 4] ?? 0; h = (h * 0x01000193) >>> 0;
    h ^= buf[i + 8] ?? 0; h = (h * 0x01000193) >>> 0;
    h ^= buf[i + 12] ?? 0; h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Exact equality check between the same tile region in two packed RGB/RGBA
 * frame buffers of identical layout (same width/channels), reading directly
 * from the strided source — no extraction copy needed. Used to be a sampled
 * hash (every 4th byte) for speed, but that let a real pixel change go
 * undetected whenever it happened to miss every sampled byte — the tile
 * would then keep showing stale content until the next periodic full-frame
 * correction caught up. Hashing was never the bottleneck (JPEG encode is,
 * by a wide margin), so there's no real cost to just comparing every byte.
 * channels: 3 (RGB from JPEG screencast) or 4 (RGBA from PNG).
 */
export function tileRegionEqual(
  a: Buffer, b: Buffer,
  frameW: number, channels: number,
  x: number, y: number, w: number, h: number
): boolean {
  const rowBytes = w * channels;
  const rowStride = frameW * channels;
  for (let r = 0; r < h; r++) {
    const base = (y + r) * rowStride + x * channels;
    if (a.compare(b, base, base + rowBytes, base, base + rowBytes) !== 0) return false;
  }
  return true;
}

export type Rotation = 0 | 90 | 180 | 270;

export function getRotatedDimensions(
  width: number,
  height: number,
  rotation: Rotation
): { width: number; height: number } {
  if (rotation === 90 || rotation === 270) {
    return { width: height, height: width };
  }
  return { width, height };
}

export function mapPointForRotation(
  xd: number, yd: number,
  srcW: number, srcH: number, // розмір сторінки у Chrome (до ротації)
  rotation: Rotation
): { x: number; y: number } {
  switch (rotation) {
    case 0:   return { x: xd,            y: yd };
    case 90:  return { x: yd,            y: srcH - 1 - xd };
    case 180: return { x: srcW - 1 - xd, y: srcH - 1 - yd };
    case 270: return { x: srcW - 1 - yd, y: xd };
  }
}
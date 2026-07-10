import os from "node:os";
import sharp from "sharp";
import { Encoding, FRAME_HEADER_BYTES, TILE_HEADER_BYTES } from "./protocol.js";
import { tileRegionEqual } from "./util.js";

sharp.concurrency(Math.max(1, os.cpus().length - 1));

export type RGBA = { data: Buffer; width: number; height: number; channels: number };

export type Rect = { x: number; y: number; w: number; h: number; data: Buffer };

export type FrameOut = {
  rects: Rect[];
  isFullFrame: boolean;
  encoding: Encoding;
};

export type FrameProcessorCfg = {
  tileSize: number;
  fullframeTileCount: number;
  fullframeAreaThreshold: number;
  jpegQuality: number;
  fullFrameEvery: number;
  maxBytesPerMessage: number;
};

// Streaming vs idle-refinement encoding. Full-frame latency on the ESP32 is
// dominated by Wi-Fi transfer of the 4 strips, not by decode (the JPEGDEC
// fork ships ESP32-S3 SIMD for both 4:4:4 and 4:2:0) — so while content is
// moving we encode 4:2:0 at the configured quality: ~35% fewer bytes on the
// wire and the faster SIMD chroma path, with softness that motion masks.
// Once the screen goes idle, deviceManager asks for a refinement pass and we
// re-send everything at 4:4:4/REFINE_QUALITY — the static image the user
// actually studies ends up crisper than the old always-4:4:4 stream.
const STREAM_SUBSAMPLING = "4:2:0";
const REFINE_SUBSAMPLING = "4:4:4";
const REFINE_QUALITY = 90;
// Full-frame strips (scene cuts: >threshold area changed, or an explicit
// refresh) are sent HALF-RESOLUTION (Encoding.JPEG_HALF): a clean q75->q55
// A/B on-device proved full-res repaints are pixel-bound, not byte-bound —
// scalar IDCT plus framebuffer writes put a hard ~40-42ms floor under a
// full 480x480 decode, over the 33ms/30fps budget. Quarter the pixels
// lands scene cuts at ~20-25ms. The transition frame is visibly soft for
// the ~1s until idle refinement re-sends everything at 4:4:4 q90 — an
// explicit user choice of latency over one frame's sharpness. Partial
// updates and refinement stay full resolution.
// Requires client >= 1.6.0 (older clients skip enc=6 tiles: deploy the
// client first). HALFRES_QUALITY is generous since resolution, not
// quantization, is the dominant loss here.
const HALFRES_QUALITY = 70;
// Fallback quality for full-res full-frame strips (odd-sized rects that
// can't be cleanly halved).
const FULLFRAME_QUALITY = 55;

export class FrameProcessor {
  private _cfg: FrameProcessorCfg;
  private _cols = 0;
  private _rows = 0;
  // Previous frame's raw pixels, compared exactly (byte-for-byte per tile)
  // against the current frame to decide what changed. Just a reference to
  // last call's rgba.data — deviceManager hands us a freshly allocated
  // buffer every frame, so no copy is needed to keep this snapshot around.
  // Also serves as the source for idle refinement re-encodes.
  private _prevFrame?: Buffer;
  private _frameW = 0;
  private _frameH = 0;
  private _channels = 3;
  private _iter = 0;
  private _fullFrameRequested = false;

  // The periodic drift-correction refresh (every fullFrameEvery frames) used
  // to force every tile changed in a single frame — re-encoding and
  // re-decoding the whole screen at once. That's exactly the ~1-frame stutter
  // every couple of seconds users saw: a big burst of JPEG encode (server)
  // and JPEG decode (ESP32) cost landing in one frame interval. Instead,
  // spread it across `fullframeTileCount` frames, one strip per frame,
  // folded into the ordinary partial-diff path below — same eventual
  // coverage, no single frame costs more than one extra strip.
  private _sweepStrip = 0;
  private _sweepRemaining = 0;

  constructor(cfg: FrameProcessorCfg) {
    this._cfg = cfg;
  }

  public requestFullFrame(): void {
    this._iter = 0;
    this._fullFrameRequested = true;
    this._sweepRemaining = 0; // an immediate full frame supersedes any in-flight sweep
  }

  public async processFrameAsync(rgba: RGBA): Promise<FrameOut> {
    if (this._cols === 0) this._initGrid(rgba.width, rgba.height);

    let forceFull = false;
    if (this._fullFrameRequested) {
      forceFull = true;
      this._fullFrameRequested = false;
    } else if ((this._iter % this._cfg.fullFrameEvery) === 0) {
      // Due for drift correction — (re)start a progressive sweep rather than
      // forcing a full frame right now.
      this._sweepStrip = 0;
      this._sweepRemaining = this._cfg.fullframeTileCount;
    }

    const chosenEncoding: Encoding = Encoding.JPEG;

    // Which strip (if any) is being force-refreshed this frame as part of an
    // in-progress sweep.
    let sweepRect: { x: number; y: number; w: number; h: number } | undefined;
    if (!forceFull && this._sweepRemaining > 0) {
      const strips = this._splitWholeFrame(rgba.width, rgba.height, this._cfg.fullframeTileCount);
      sweepRect = strips[this._sweepStrip];
      this._sweepStrip++;
      this._sweepRemaining--;
    }

    type TileInfo = { x: number; y: number; w: number; h: number; changed: boolean };
    const tiles: TileInfo[] = [];
    let changedArea = 0;

    for (let ty = 0; ty < this._rows; ty++) {
      for (let tx = 0; tx < this._cols; tx++) {
        const x = tx * this._cfg.tileSize;
        const y = ty * this._cfg.tileSize;
        const w = Math.min(this._cfg.tileSize, rgba.width - x);
        const h = Math.min(this._cfg.tileSize, rgba.height - y);

        // Compare directly against the previous frame's strided buffer — no
        // extraction copy, no sampling, so no chance of a missed change.
        let changed = forceFull || !this._prevFrame ||
          !tileRegionEqual(rgba.data, this._prevFrame, rgba.width, rgba.channels, x, y, w, h);
        if (!changed && sweepRect && y >= sweepRect.y && y < sweepRect.y + sweepRect.h) {
          changed = true;
        }

        tiles.push({ x, y, w, h, changed });
        if (changed) changedArea += w * h;
      }
    }

    const totalArea = rgba.width * rgba.height;
    const changedPct = totalArea > 0 ? (changedArea / totalArea) : 0;
    const doFull = forceFull || (changedPct > this._cfg.fullframeAreaThreshold);
    if (doFull) this._sweepRemaining = 0; // whole screen just got covered one way or another

    let out: FrameOut;
    if (doFull) {
      out = await this._processFullFrame(rgba, chosenEncoding);
    } else {
      out = await this._processPartialFrame(rgba, tiles, chosenEncoding);
    }
    this._prevFrame = rgba.data;
    this._frameW = rgba.width;
    this._frameH = rgba.height;
    this._channels = rgba.channels;

    const maxBytesPerTile = this._cfg.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES;
    for (let i = 0; i < out.rects.length; i++) {
      const r = out.rects[i];
      if (r.data.length > maxBytesPerTile) {
        // Match the frame's encoding: a JPEG_HALF frame needs a half-size
        // red payload since the client pixel-doubles it into the rect.
        const redData = (out.encoding === Encoding.JPEG_HALF)
          ? await this._makeRedFrameAsync(Math.max(1, r.w >> 1), Math.max(1, r.h >> 1), chosenEncoding)
          : await this._makeRedFrameAsync(r.w, r.h, chosenEncoding);
        out.rects[i] = { x: r.x, y: r.y, w: r.w, h: r.h, data: redData };
      }
    }

    this._iter++;
    return out;
  }

  private async _processFullFrame(
    rgba: RGBA,
    encoding: Encoding
  ): Promise<FrameOut> {
    const rectsForFull = this._splitWholeFrame(rgba.width, rgba.height, this._cfg.fullframeTileCount);

    // Half-res only works if every strip halves cleanly (they always do for
    // even display dimensions); an all-or-nothing choice keeps the frame's
    // encoding field uniform across its messages.
    const canHalve = encoding === Encoding.JPEG &&
      rectsForFull.every((r) => r.w % 2 === 0 && r.h % 2 === 0 && r.w >= 2 && r.h >= 2);
    const outEncoding = canHalve ? Encoding.JPEG_HALF : encoding;
    const fallbackQuality = Math.min(this._cfg.jpegQuality, FULLFRAME_QUALITY);

    const rects = await Promise.all(
      rectsForFull.map(async (r) => {
        // Full-frame tiles are horizontal strips with x=0, w=frameWidth.
        // These rows are contiguous in rgba.data — use subarray (zero-copy).
        const ch = rgba.channels;
        const raw = (r.x === 0 && r.w === rgba.width)
          ? rgba.data.subarray(r.y * rgba.width * ch, (r.y + r.h) * rgba.width * ch)
          : this._extractRaw(rgba, r.x, r.y, r.w, r.h);
        let data: Buffer;
        if (canHalve) {
          data = await sharp(raw, { raw: { width: r.w, height: r.h, channels: ch as 1 | 2 | 3 | 4 } })
            .resize(r.w / 2, r.h / 2)
            .jpeg({ quality: HALFRES_QUALITY, mozjpeg: false, chromaSubsampling: STREAM_SUBSAMPLING })
            .toBuffer();
        } else if (encoding === Encoding.JPEG) {
          data = await this._encodeJPEG(raw, r.w, r.h, ch, fallbackQuality, STREAM_SUBSAMPLING);
        } else {
          data = await this._encode(raw, r.w, r.h, ch, encoding);
        }
        return { x: r.x, y: r.y, w: r.w, h: r.h, data };
      })
    );

    return { rects, isFullFrame: true, encoding: outEncoding };
  }

  private async _processPartialFrame(
    rgba: RGBA,
    tiles: { x: number; y: number; w: number; h: number; changed: boolean }[],
    encoding: Encoding
  ): Promise<FrameOut> {
    const mergedRects = this._mergeChangedTiles(tiles, rgba.width, rgba.height);

    // Encode all changed rects in parallel.
    const out = await Promise.all(
      mergedRects.map(async (r) => {
        // Full-width merged rects are contiguous in rgba.data, same as the
        // full-frame strips — skip the row-by-row copy in that common case.
        const ch = rgba.channels;
        const raw = (r.x === 0 && r.w === rgba.width)
          ? rgba.data.subarray(r.y * rgba.width * ch, (r.y + r.h) * rgba.width * ch)
          : this._extractRaw(rgba, r.x, r.y, r.w, r.h);
        const data = await this._encode(raw, r.w, r.h, rgba.channels, encoding);
        return { ...r, data };
      })
    );

    return { rects: out, isFullFrame: false, encoding };
  }

  private _splitWholeFrame(w: number, h: number, n: number): { x: number; y: number; w: number; h: number }[] {
    if (n <= 1) return [{ x: 0, y: 0, w, h }];

    if (n === 2) {
      const h1 = Math.floor(h / 2);
      const h2 = h - h1;
      return [
        { x: 0, y: 0, w, h: h1 },
        { x: 0, y: h1, w, h: h2 },
      ];
    }

    let rows = Math.floor(Math.sqrt(n));
    while (rows > 1 && (n % rows !== 0)) rows--;
    const cols = Math.floor(n / rows);

    const split = (size: number, parts: number): number[] => {
      const out: number[] = [];
      let prev = 0;
      for (let i = 1; i <= parts; i++) {
        const cur = Math.floor((i * size) / parts);
        out.push(cur - prev);
        prev = cur;
      }
      return out;
    };

    const widths = split(w, cols);
    const heights = split(h, rows);

    const rects: { x: number; y: number; w: number; h: number }[] = [];
    let yAcc = 0;
    for (let r = 0; r < rows; r++) {
      let xAcc = 0;
      for (let c = 0; c < cols; c++) {
        rects.push({ x: xAcc, y: yAcc, w: widths[c], h: heights[r] });
        xAcc += widths[c];
      }
      yAcc += heights[r];
    }
    return rects;
  }

  private _getMaxFullTileSize(frameW: number, frameH: number): { maxW: number; maxH: number } {
    const fullRects = this._splitWholeFrame(frameW, frameH, this._cfg.fullframeTileCount);
    let maxW = 0, maxH = 0;
    for (const r of fullRects) {
      if (r.w > maxW) maxW = r.w;
      if (r.h > maxH) maxH = r.h;
    }
    return { maxW, maxH };
  }

  private _calcGridSplits(frameW: number, frameH: number) {
    const cols = this._cols, rows = this._rows, ts = this._cfg.tileSize;
    const widths: number[] = new Array(cols);
    const heights: number[] = new Array(rows);
    const xOffsets: number[] = new Array(cols);
    const yOffsets: number[] = new Array(rows);

    let x = 0;
    for (let c = 0; c < cols; c++) {
      const w = Math.min(ts, frameW - x);
      widths[c] = w;
      xOffsets[c] = x;
      x += w;
    }
    let y = 0;
    for (let r = 0; r < rows; r++) {
      const h = Math.min(ts, frameH - y);
      heights[r] = h;
      yOffsets[r] = y;
      y += h;
    }
    return { widths, heights, xOffsets, yOffsets };
  }

  private _mergeChangedTiles(
    tiles: { x: number; y: number; w: number; h: number; changed: boolean }[],
    frameW: number,
    frameH: number
  ): { x: number; y: number; w: number; h: number }[] {
    const cols = this._cols, rows = this._rows;
    const changed: boolean[][] = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false));
    const visited: boolean[][] = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false));

    for (let i = 0; i < tiles.length; i++) {
      const ty = Math.floor(i / cols);
      const tx = i % cols;
      changed[ty][tx] = tiles[i].changed;
    }

    // NOTE (v1.4.3): v1.4.2 dilated this mask by one tile to merge nearby
    // rects and save per-tile JPEG setup on the client. Measured on-device it
    // was a net LOSS — thin horizontal changes (sliders) grew whole extra
    // tile-rows, tripling decoded pixels per frame (partial avg 5-6ms ->
    // 24ms), and the per-tile setup cost it targeted turned out to be partly
    // scheduler noise in the original measurement. Exact changed tiles only.

    const { widths, heights, xOffsets, yOffsets } = this._calcGridSplits(frameW, frameH);
    const { maxW, maxH } = this._getMaxFullTileSize(frameW, frameH);

    const rects: { x: number; y: number; w: number; h: number }[] = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!changed[r][c] || visited[r][c]) continue;

        // grow horizontally
        let wTiles = 0, pxW = 0;
        while (c + wTiles < cols && changed[r][c + wTiles] && !visited[r][c + wTiles]) {
          const nextW = pxW + widths[c + wTiles];
          if (nextW > maxW) break;
          pxW = nextW;
          wTiles++;
        }

        // grow vertically
        let hTiles = 1, pxH = heights[r];
        let canGrow = true;
        while (canGrow && (r + hTiles) < rows) {
          const nextH = pxH + heights[r + hTiles];
          if (nextH > maxH) break;
          for (let cc = c; cc < c + wTiles; cc++) {
            if (!changed[r + hTiles][cc] || visited[r + hTiles][cc]) { canGrow = false; break; }
          }
          if (!canGrow) break;
          pxH = nextH;
          hTiles++;
        }

        rects.push({ x: xOffsets[c], y: yOffsets[r], w: pxW, h: pxH });

        for (let rr = r; rr < r + hTiles; rr++) {
          for (let cc = c; cc < c + wTiles; cc++) {
            visited[rr][cc] = true;
          }
        }
      }
    }

    return rects;
  }

  private _initGrid(w: number, h: number) {
    this._cols = Math.ceil(w / this._cfg.tileSize);
    this._rows = Math.ceil(h / this._cfg.tileSize);
  }

  private _extractRaw(rgba: RGBA, x: number, y: number, w: number, h: number): Buffer {
    const ch = rgba.channels;
    const out = Buffer.allocUnsafe(w * h * ch);
    for (let yy = 0; yy < h; yy++) {
      const src = ((y + yy) * rgba.width + x) * ch;
      rgba.data.copy(out, yy * w * ch, src, src + w * ch);
    }
    return out;
  }

  private async _encode(rawRgb: Buffer, w: number, h: number, channels: number, enc: Encoding): Promise<Buffer> {
    switch (enc) {
      case Encoding.JPEG:
        return this._encodeJPEG(rawRgb, w, h, channels);
      case Encoding.RAW565:
        return this._encodeRAW565(rawRgb, channels);
      default:
        return this._encodeJPEG(rawRgb, w, h, channels);
    }
  }

  private async _encodeJPEG(
    rawRgb: Buffer, w: number, h: number, channels: number,
    quality = this._cfg.jpegQuality,
    chromaSubsampling: string = STREAM_SUBSAMPLING
  ): Promise<Buffer> {
    return sharp(rawRgb, { raw: { width: w, height: h, channels: channels as 1 | 2 | 3 | 4 } })
      .jpeg({ quality, mozjpeg: false, chromaSubsampling })
      .toBuffer();
  }

  /**
   * Re-encode the entire last frame at maximum quality (4:4:4, REFINE_QUALITY)
   * as full-frame strips. Called by deviceManager once the screen has been
   * idle for a moment — latency is irrelevant then, so the strips can be as
   * heavy as the per-message limit allows. Returns null if no frame has been
   * processed yet. Strips that exceed the per-message budget fall back to the
   * streaming quality, and are skipped entirely if still too large (the
   * client simply keeps the already-displayed streamed version).
   */
  public async encodeRefinementAsync(): Promise<FrameOut | null> {
    const data = this._prevFrame;
    if (!data || !this._frameW) return null;

    const w = this._frameW, h = this._frameH, ch = this._channels;
    const maxBytesPerTile = this._cfg.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES;
    const strips = this._splitWholeFrame(w, h, this._cfg.fullframeTileCount);

    const rects: Rect[] = [];
    for (const r of strips) {
      const raw = (r.x === 0 && r.w === w)
        ? data.subarray(r.y * w * ch, (r.y + r.h) * w * ch)
        : this._extractRaw({ data, width: w, height: h, channels: ch }, r.x, r.y, r.w, r.h);
      let enc = await this._encodeJPEG(raw, r.w, r.h, ch, REFINE_QUALITY, REFINE_SUBSAMPLING);
      if (enc.length > maxBytesPerTile)
        enc = await this._encodeJPEG(raw, r.w, r.h, ch, this._cfg.jpegQuality, REFINE_SUBSAMPLING);
      if (enc.length > maxBytesPerTile) continue;
      rects.push({ x: r.x, y: r.y, w: r.w, h: r.h, data: enc });
    }

    return rects.length ? { rects, isFullFrame: true, encoding: Encoding.JPEG } : null;
  }

  private _encodeRAW565(rawRgb: Buffer, channels: number): Buffer {
    const pxCount = Math.floor(rawRgb.length / channels);
    const out = Buffer.allocUnsafe(pxCount * 2);
    for (let i = 0, j = 0; i < pxCount; i++, j += channels) {
      const r = rawRgb[j];
      const g = rawRgb[j + 1];
      const b = rawRgb[j + 2];
      const v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
      out[i * 2] = v & 0xFF;
      out[i * 2 + 1] = (v >> 8) & 0xFF;
    }
    return out;
  }

  private async _makeRedFrameAsync(w: number, h: number, enc: Encoding): Promise<Buffer> {
    const channels = 3;
    const raw = Buffer.allocUnsafe(w * h * channels);
    for (let o = 0; o < raw.length; o += channels) {
      raw[o] = 0xFF; raw[o + 1] = 0x00; raw[o + 2] = 0x00;  // RGB red
    }
    return this._encode(raw, w, h, channels, enc);
  }
}

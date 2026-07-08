import os from "node:os";
import sharp from "sharp";
import { Encoding, FRAME_HEADER_BYTES, TILE_HEADER_BYTES } from "./protocol.js";
import { hash32, hashTileInPlace } from "./util.js";

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

export class FrameProcessor {
  private _cfg: FrameProcessorCfg;
  private _cols = 0;
  private _rows = 0;
  private _prev?: Uint32Array;
  private _iter = 0;
  private _fullFrameRequested = false;

  constructor(cfg: FrameProcessorCfg) {
    this._cfg = cfg;
  }

  public requestFullFrame(): void {
    this._iter = 0;
    this._fullFrameRequested = true;
  }

  public async processFrameAsync(rgba: RGBA): Promise<FrameOut> {
    if (!this._prev) this._initGrid(rgba.width, rgba.height);

    let forceFull = (this._iter % this._cfg.fullFrameEvery) === 0;
    if (this._fullFrameRequested) {
      forceFull = true;
      this._fullFrameRequested = false;
    }
    const chosenEncoding: Encoding = Encoding.JPEG;

    type TileInfo = { x: number; y: number; w: number; h: number; idx: number; h32: number; changed: boolean };
    const tiles: TileInfo[] = [];
    let changedArea = 0;

    for (let ty = 0; ty < this._rows; ty++) {
      for (let tx = 0; tx < this._cols; tx++) {
        const x = tx * this._cfg.tileSize;
        const y = ty * this._cfg.tileSize;
        const w = Math.min(this._cfg.tileSize, rgba.width - x);
        const h = Math.min(this._cfg.tileSize, rgba.height - y);

        // Hash the tile directly from the strided RGB/RGBA buffer — no copy needed.
        const h32 = hashTileInPlace(rgba.data, rgba.width, rgba.channels, x, y, w, h);
        const idx = ty * this._cols + tx;
        const prev = this._prev![idx];
        const changed = forceFull || (prev !== h32);

        tiles.push({ x, y, w, h, idx, h32, changed });
        if (changed) changedArea += w * h;
      }
    }

    const totalArea = rgba.width * rgba.height;
    const changedPct = totalArea > 0 ? (changedArea / totalArea) : 0;
    const doFull = forceFull || (changedPct > this._cfg.fullframeAreaThreshold);

    let out: FrameOut;
    if (doFull) {
      out = await this._processFullFrame(rgba, tiles, chosenEncoding);
    } else {
      out = await this._processPartialFrame(rgba, tiles, chosenEncoding);
    }

    const maxBytesPerTile = this._cfg.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES;
    for (let i = 0; i < out.rects.length; i++) {
      const r = out.rects[i];
      if (r.data.length > maxBytesPerTile) {
        const redData = await this._makeRedFrameAsync(r.w, r.h, chosenEncoding);
        out.rects[i] = { x: r.x, y: r.y, w: r.w, h: r.h, data: redData };
      }
    }

    this._iter++;
    return out;
  }

  private async _processFullFrame(
    rgba: RGBA,
    tilesInfo: { idx: number; h32: number }[],
    encoding: Encoding
  ): Promise<FrameOut> {
    const rectsForFull = this._splitWholeFrame(rgba.width, rgba.height, this._cfg.fullframeTileCount);

    const rects = await Promise.all(
      rectsForFull.map(async (r) => {
        // Full-frame tiles are horizontal strips with x=0, w=frameWidth.
        // These rows are contiguous in rgba.data — use subarray (zero-copy).
        const ch = rgba.channels;
        const raw = (r.x === 0 && r.w === rgba.width)
          ? rgba.data.subarray(r.y * rgba.width * ch, (r.y + r.h) * rgba.width * ch)
          : this._extractRaw(rgba, r.x, r.y, r.w, r.h);
        const data = await this._encode(raw, r.w, r.h, ch, encoding);
        return { x: r.x, y: r.y, w: r.w, h: r.h, data };
      })
    );

    for (const t of tilesInfo) this._prev![t.idx] = t.h32;

    return { rects, isFullFrame: true, encoding };
  }

  private async _processPartialFrame(
    rgba: RGBA,
    tiles: { x: number; y: number; w: number; h: number; idx: number; h32: number; changed: boolean }[],
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

    for (const t of tiles) if (t.changed) this._prev![t.idx] = t.h32;

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
    tiles: { x: number; y: number; w: number; h: number; idx: number; h32: number; changed: boolean }[],
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
    this._prev = new Uint32Array(this._cols * this._rows);
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

  private async _encodeJPEG(rawRgb: Buffer, w: number, h: number, channels: number): Promise<Buffer> {
    return sharp(rawRgb, { raw: { width: w, height: h, channels: channels as 1 | 2 | 3 | 4 } })
      // 4:4:4 encodes full color resolution per pixel. 4:2:0 (the default)
      // discards 75% of chroma data, causing color bleeding at tile edges and
      // smeared color transitions — visibly "shoddy" on colored UI elements.
      // File size is ~15% larger but well within the 32 KB per-message limit.
      .jpeg({ quality: this._cfg.jpegQuality, mozjpeg: false, chromaSubsampling: "4:4:4" })
      .toBuffer();
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

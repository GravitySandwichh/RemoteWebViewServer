import { WebSocket } from "ws";
import { buildFrameStatsPacket, buildFramePackets, buildCurrentURLPacket } from "./protocol.js";
import type { FrameOut } from "./frameProcessor.js";

type OutFrame = { frameId?: number | null; packets: Buffer[] };
type BroadcasterState = { queue: OutFrame[]; sending: boolean };

export class DeviceBroadcaster {
  private _clients = new Map<string, Set<WebSocket>>();
  private _state = new Map<string, BroadcasterState>();

  addClient(id: string, ws: WebSocket): void {
    const old = this._clients.get(id);
    if (old && old.size) {
      for (const sock of old) {
        try { sock.close(); } catch {}
      }
      old.clear();
    }

    if (!this._clients.has(id)) this._clients.set(id, new Set());
    this._clients.get(id)!.add(ws);

    if (!this._state.has(id)) this._state.set(id, { queue: [], sending: false });

    console.log(`[broadcaster] Client connected to device ${id}, total clients: ${this._clients.get(id)?.size}`);
    ws.once("close", () => this.removeClient(id, ws));
    ws.once("error", () => this.removeClient(id, ws));
  }

  removeClient(id: string, ws: WebSocket): void {
    this._clients.get(id)?.delete(ws);
    if ((this._clients.get(id)?.size ?? 0) === 0) {
      this._clients.delete(id);
      this._state.delete(id);
    }
    console.log(`[broadcaster] Client disconnected from device ${id}, total clients: ${this._clients.get(id)?.size ?? 0}`);
  }

  getClientCount(id: string): number {
    return this._clients.get(id)?.size ?? 0;
  }

  public sendFrameChunked(id: string, data: FrameOut, frameId: number, maxBytes = 12_000): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0 || data.rects.length === 0) return;

    const packets = buildFramePackets(data.rects, data.encoding, frameId, data.isFullFrame, maxBytes);

    const st = this._ensureState(id);

    // If the queue is already backed up, drop stale frames — the ESP32 should
    // always display the most recent content, not frames from the past.
    // Keep at most 1 pending frame in the queue beyond what is currently sending.
    if (st.queue.length > 1) {
      st.queue.splice(1); // truncate to 1 pending entry
    }

    st.queue.push({ frameId, packets });
    this._drainAsync(id).catch(() => {});
  }

  public startSelfTestMeasurement(id: string): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0) return;

    const packet = buildFrameStatsPacket();
    const st = this._ensureState(id);
    st.queue.push({ packets: [packet] });
    this._drainAsync(id).catch(() => {});
  }

  public sendCurrentURL(id: string, url: string): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0) return;

    const packet = buildCurrentURLPacket(url);
    const st = this._ensureState(id);

    st.queue.push({ packets: [packet] });
    this._drainAsync(id).catch(() => {});
  }

  private _ensureState(id: string): BroadcasterState {
    let st = this._state.get(id);
    if (!st) {
      st = { queue: [], sending: false };
      this._state.set(id, st);
    }
    return st;
  }

  private async _drainAsync(id: string): Promise<void> {
    const st = this._ensureState(id);
    if (st.sending) return;
    st.sending = true;

    try {
      const peers = this._clients.get(id);
      if (!peers || peers.size === 0) { st.queue.length = 0; return; }

      while (st.queue.length) {
        const f = st.queue.shift()!;
        for (const pkt of f.packets) {
          for (const ws of new Set(peers)) {
            if (ws.readyState !== WebSocket.OPEN) {
              peers.delete(ws);
              continue;
            }
            try {
              ws.send(pkt, { binary: true });
            } catch {
              // drop on send error
              try { ws.close(); } catch {}
              peers.delete(ws);
            }
          }
          if (peers.size === 0) { st.queue.length = 0; return; }
        }
        // Yield once per frame (not per packet) so all tiles of a frame are sent
        // in one synchronous burst. Each tile is ~15 KB — well within the kernel
        // TCP send buffer. One yield per frame is enough to stay I/O-cooperative.
        await Promise.resolve();
      }
    } finally {
      st.sending = false;
    }
  }
}

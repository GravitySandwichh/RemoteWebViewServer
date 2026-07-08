import http from 'http';
import fs from 'fs';
import { WebSocketServer } from "ws"
import env from "env-var";
import { makeConfigFromParams, setConfigFor, logDeviceConfig } from "./config.js";
import { broadcaster, ensureDeviceAsync, cleanupIdleAsync, type DeviceSession } from './deviceManager.js';
import { InputRouter } from "./inputRouter.js";
import { bootstrapAsync } from './browser.js';
import { MsgType } from './protocol.js';

const WS_PORT = env.get("WS_PORT").default("8081").asIntPositive();
const HEALTH_PORT = env.get("HEALTH_PORT").default("18080").asIntPositive();

// Printed on every boot so a mismatch between "what's running" and "what I
// just pushed" is immediately obvious in the add-on log, instead of quietly
// debugging a deploy that never actually took effect.
try {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  console.log(`[server] remote-webview-server v${pkg.version}`);
} catch {
  console.log('[server] remote-webview-server (version unknown — package.json not found)');
}

// Bootstrap the browser/CDP connection before we start accepting device
// connections. Previously the WS server started listening immediately and
// only awaited the browser afterwards, so a device connecting during that
// window hit ensureDeviceAsync() with no CDP root, throwing inside an async
// "connection" handler (an unhandled rejection) and leaving the socket
// half-wired forever.
await bootstrapAsync();

const wss = new WebSocketServer({ port: WS_PORT, perMessageDeflate: false });
const inputRouter = new InputRouter();

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url || "", `ws://localhost:${WS_PORT}`);
  const id = url.searchParams.get("id") || "default";

  const cfg = makeConfigFromParams(url.searchParams);
  setConfigFor(id, cfg);
  logDeviceConfig(id, cfg);

  broadcaster.addClient(id, ws);

  // ensureDeviceAsync() awaits several CDP round trips on first connect
  // (create target, attach, enable page, start screencast). The ESP32
  // sends its OpenURL packet the instant the WS handshake completes, so if
  // the "message" listener is only attached after that await, the very
  // first OpenURL is silently dropped, the tab never navigates off
  // about:blank, and the device is stuck showing a blank/white page until
  // it reconnects (when ensureDeviceAsync takes the fast, already-provisioned
  // path and the race no longer applies) — this is the "needs an extra
  // reboot" symptom. Buffer messages until the device is ready to fix it.
  let dev: DeviceSession | undefined;
  let closed = false;
  const pending: Buffer[] = [];

  const handle = (dev: DeviceSession, buf: Buffer) => {
    switch (buf.readUInt8(0)) {
      case MsgType.Touch:
        inputRouter.handleTouchPacketAsync(dev, buf).catch(e => console.warn(`Failed to handle touch packet: ${(e as Error).message}`));
        break;
      case MsgType.Keepalive:
        dev.lastActive = Date.now();
        break;
      case MsgType.FrameStats:
        inputRouter.handleFrameStatsPacketAsync(dev, buf).catch(() => console.warn(`Failed to handle Self test packet`));
        break;
      case MsgType.OpenURL:
        inputRouter.handleOpenURLPacketAsync(dev, buf).catch(e => console.warn(`Failed to handle OpenURL packet: ${(e as Error).message}`));
        break;
    }
  };

  ws.on("message", (msg, isBinary) => {
    if (!isBinary) return;

    const buf: Buffer = Buffer.isBuffer(msg) ? msg : Buffer.from(msg as ArrayBuffer);
    if (!dev) { pending.push(buf); return; }
    handle(dev, buf);
  })

  ws.on("close", () => {
    closed = true;
    if (dev) dev.lastActive = Date.now();
    broadcaster.removeClient(id, ws);
  })

  try {
    dev = await ensureDeviceAsync(id, cfg);
  } catch (e) {
    console.warn(`[server] Failed to provision device ${id}: ${(e as Error).message}`);
    try { ws.close(); } catch { }
    return;
  }

  if (closed) return; // disconnected while we were provisioning

  dev.lastActive = Date.now();
  for (const buf of pending) handle(dev, buf);
});

http.createServer(async (req, res) => {
  try {
    res.writeHead(200); res.end('ok');
  } catch (e) {
    res.writeHead(500); res.end('err');
  }
}).listen(HEALTH_PORT);

setInterval(() => cleanupIdleAsync(), 60_000);

console.log(`[server] WebSocket listening on :${WS_PORT}`);

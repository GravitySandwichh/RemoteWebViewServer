import { CDPSession } from "playwright-core";
import sharp from "sharp";
import { DeviceConfig, deviceConfigsEqual, readInjectScriptConfig } from "./config.js";
import { getRoot } from "./cdpRoot.js";
import { FrameProcessor } from "./frameProcessor.js";
import { DeviceBroadcaster } from "./broadcaster.js";
import { hash32 } from "./util.js";
import { SelfTestRunner } from "./selfTest.js";
import { getInjectScriptFromUrl } from "./scriptLoader.js";

export type DeviceSession = {
  id: string;
  deviceId: string;
  cdp: CDPSession;
  cfg: DeviceConfig;
  url: string;
  lastActive: number;
  frameId: number;
  prevFrameHash: number;
  processor: FrameProcessor;
  selfTestRunner: SelfTestRunner

  // trailing throttle state
  pendingB64?: string;
  throttleTimer?: NodeJS.Timeout;
  lastProcessedMs?: number;
  // guard: only one flushPending may run at a time
  processingFrame: boolean;
  // false while page is loading — suppresses white/blank frames during navigation.
  // set true by Page.loadEventFired, false by Page.frameNavigated (full loads only).
  pageReady: boolean;
  pageReadyTimer?: NodeJS.Timeout;
  // idle refinement: once no new frames have arrived for IDLE_REFINE_MS,
  // re-send the whole screen at 4:4:4 high quality (streaming is 4:2:0).
  idleRefineTimer?: NodeJS.Timeout;
  needsRefine: boolean;
};

// How long the screen must be still before the high-quality refinement pass
// is sent. Long enough that a paused-then-resuming animation usually won't
// collide with it, short enough that the user never consciously sees the
// softer streamed image at rest.
const IDLE_REFINE_MS = 800;

const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');

const devices = new Map<string, DeviceSession>();
let _cleanupRunning = false;
export const broadcaster = new DeviceBroadcaster();

export async function ensureDeviceAsync(id: string, cfg: DeviceConfig): Promise<DeviceSession> {
  const root = getRoot();
  if (!root) throw new Error("CDP not ready");

  let device = devices.get(id);
  if (device) {
    if (deviceConfigsEqual(device.cfg, cfg)) {
      device.lastActive = Date.now();
      device.processor.requestFullFrame();
      return device;
    } else {
      console.log(`[device] Reconfiguring device ${id}`);
      await deleteDeviceAsync(device);
    }
  }

  const { targetId } = await root.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    width: cfg.width,
    height: cfg.height,
  });

  const { sessionId } = await root.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true
  });
  const session = (root as any).session(sessionId);

  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: cfg.width,
    height: cfg.height,
    deviceScaleFactor: 1,
    mobile: true
  });
  if (PREFERS_REDUCED_MOTION) {
    await session.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
  }

  const keyboardScript = await getInjectScriptFromUrl(readInjectScriptConfig());
  if (keyboardScript) {
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: keyboardScript });
  }

  await session.send('Page.startScreencast', {
    // JPEG is ~3× faster to decode than PNG on ARM (libjpeg-turbo vs libpng).
    // PNG decode was ~25ms per frame; JPEG at q90 is ~8ms — the single biggest
    // remaining bottleneck. Sharp auto-detects the format from magic bytes so
    // no downstream code changes are required. At quality 90, double-compression
    // artifacts when re-encoding to our tile quality (60) are imperceptible.
    format: 'jpeg',
    quality: 90,
    maxWidth: cfg.width,
    maxHeight: cfg.height,
    everyNthFrame: cfg.everyNthFrame
  });

  const processor = new FrameProcessor({
    tileSize: cfg.tileSize,
    fullframeTileCount: cfg.fullFrameTileCount,
    fullframeAreaThreshold: cfg.fullFrameAreaThreshold,
    jpegQuality: cfg.jpegQuality,
    fullFrameEvery: cfg.fullFrameEvery,
    maxBytesPerMessage: cfg.maxBytesPerMessage,
  });

  const newDevice: DeviceSession = {
    id: targetId,
    deviceId: id,
    cdp: session,
    cfg: cfg,
    url: '',
    lastActive: Date.now(),
    frameId: 0,
    prevFrameHash: 0,
    processor,
    selfTestRunner: new SelfTestRunner(broadcaster),
    pendingB64: undefined,
    throttleTimer: undefined,
    lastProcessedMs: undefined,
    processingFrame: false,
    // Start suppressed — Chrome opens to about:blank (white). Frames are only
    // delivered after Page.loadEventFired signals the page is ready.
    pageReady: false,
    pageReadyTimer: undefined,
    idleRefineTimer: undefined,
    needsRefine: false,
  };
  devices.set(id, newDevice);
  newDevice.processor.requestFullFrame();

  const flushPending = async () => {
    const dev = newDevice;
    dev.throttleTimer = undefined;

    // Strict serial guard: only one frame may be processed at a time.
    // Without this, a new CDP frame arriving during the async sharp/encode
    // work would spawn a second concurrent flushPending, causing two calls
    // to processFrameAsync to race on shared FrameProcessor state (_prev,
    // _iter) and the frameId counter, corrupting dirty-rect detection and
    // sending frames out-of-order to the ESP32.
    if (dev.processingFrame) return;
    dev.processingFrame = true;

    const b64 = dev.pendingB64;
    dev.pendingB64 = undefined;
    if (!b64) { dev.processingFrame = false; return; }

    try {
      const pngFull = Buffer.from(b64, 'base64');

      const h32 = hash32(pngFull);
      if (dev.prevFrameHash === h32) {
        dev.lastProcessedMs = Date.now();
        return;
      }
      dev.prevFrameHash = h32;

      let img = sharp(pngFull);
      if (dev.cfg.rotation) img = img.rotate(dev.cfg.rotation);

      const { data, info } = await img
        // Strip alpha channel — JPEG screencast never has alpha, PNG screenshots
        // rarely do. Keeping 3-channel RGB saves 25% on buffer size and all
        // downstream hash/extract/encode work vs .ensureAlpha() which added a
        // synthetic 4th channel that Sharp's JPEG encoder then discarded anyway.
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const out = await processor.processFrameAsync({ data, width: info.width, height: info.height, channels: info.channels });
      if (out.rects.length > 0) {
        dev.frameId = (dev.frameId + 1) >>> 0;
        broadcaster.sendFrameChunked(id, out, dev.frameId, cfg.maxBytesPerMessage);
        // Streamed frames are 4:2:0 — remember to send the crisp 4:4:4 pass
        // once the screen settles.
        dev.needsRefine = true;
      }
    } catch (e) {
      console.warn(`[device] Failed to process frame for ${id}: ${(e as Error).message}`);
    } finally {
      dev.lastProcessedMs = Date.now();
      dev.processingFrame = false;

      // If a new frame arrived while we were processing, start it immediately.
      // It has already been waiting for the full duration of the current frame's
      // processing — adding another minFrameInterval delay here doubles the
      // effective frame time (was causing ~13fps instead of ~25fps at 33ms interval).
      if (dev.pendingB64 && !dev.throttleTimer) {
        dev.throttleTimer = setTimeout(flushPending, 0);
      } else if (dev.needsRefine) {
        scheduleIdleRefine();
      }
    }
  };

  const scheduleIdleRefine = () => {
    if (newDevice.idleRefineTimer) clearTimeout(newDevice.idleRefineTimer);
    newDevice.idleRefineTimer = setTimeout(runIdleRefine, IDLE_REFINE_MS);
  };

  const runIdleRefine = async () => {
    const dev = newDevice;
    dev.idleRefineTimer = undefined;
    if (!dev.needsRefine || !dev.pageReady) return;
    // New content is flowing (or being processed) — its flushPending will
    // reschedule refinement when things settle again. Skipping here also
    // guarantees the refinement can never interleave with a newer frame and
    // overwrite it with older pixels: while processingFrame is set below,
    // screencastFrame handlers only stash pendingB64, and the broadcaster
    // queue is FIFO per device.
    if (dev.processingFrame || dev.pendingB64) return;
    if (broadcaster.getClientCount(dev.deviceId) === 0) return;

    dev.processingFrame = true;
    try {
      const out = await dev.processor.encodeRefinementAsync();
      if (out) {
        dev.frameId = (dev.frameId + 1) >>> 0;
        broadcaster.sendFrameChunked(dev.deviceId, out, dev.frameId, cfg.maxBytesPerMessage);
      }
      dev.needsRefine = false;
    } catch (e) {
      console.warn(`[device] Idle refinement failed for ${id}: ${(e as Error).message}`);
    } finally {
      dev.processingFrame = false;
      if (dev.pendingB64 && !dev.throttleTimer) {
        dev.throttleTimer = setTimeout(flushPending, 0);
      }
    }
  };

  // Gate frame delivery behind page readiness so the ESP32 never receives
  // white/blank frames from about:blank or mid-navigation Chrome state.
  const setPageReady = (source: string) => {
    if (newDevice.pageReadyTimer) {
      clearTimeout(newDevice.pageReadyTimer);
      newDevice.pageReadyTimer = undefined;
    }
    if (!newDevice.pageReady) {
      newDevice.pageReady = true;
      newDevice.processor.requestFullFrame();
      console.log(`[device] ${id}: page ready (${source}), starting frame stream`);
    }
  };

  const suppressFrames = (reason: string) => {
    newDevice.pageReady = false;
    newDevice.pendingB64 = undefined;
    if (newDevice.throttleTimer) {
      clearTimeout(newDevice.throttleTimer);
      newDevice.throttleTimer = undefined;
    }
    if (newDevice.idleRefineTimer) {
      clearTimeout(newDevice.idleRefineTimer);
      newDevice.idleRefineTimer = undefined;
    }
    newDevice.needsRefine = false;
    // Fallback: if loadEventFired never arrives (page error, infinite spinner)
    // start streaming after 12 s so the user isn't stuck on a blank screen.
    if (newDevice.pageReadyTimer) clearTimeout(newDevice.pageReadyTimer);
    newDevice.pageReadyTimer = setTimeout(() => setPageReady('timeout-fallback'), 12_000);
    console.log(`[device] ${id}: frames suppressed (${reason})`);
  };

  // Page.loadEventFired fires when window.onload completes — page content is ready.
  session.on('Page.loadEventFired', () => setPageReady('loadEventFired'));

  session.on('Page.screencastFrame', async (evt: any) => {
    // ACK immediately to keep producer running
    session.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => { });

    // Suppress frames while the page is loading to prevent white-screen delivery.
    if (!newDevice.pageReady) return;

    if (broadcaster.getClientCount(newDevice.deviceId) === 0)
      return;
    newDevice.lastActive = Date.now();
    newDevice.pendingB64 = evt.data;

    // Only schedule a flush if neither a timer nor active processing is running.
    if (!newDevice.throttleTimer && !newDevice.processingFrame) {
      const now = Date.now();
      const since = newDevice.lastProcessedMs ? (now - newDevice.lastProcessedMs) : Infinity;
      const delay = Math.max(0, cfg.minFrameInterval - (Number.isFinite(since) ? since : 0));
      newDevice.throttleTimer = setTimeout(flushPending, delay);
    }
  });

  const handleNavigation = (url: string) => {
    if (newDevice.url !== url) {
      newDevice.url = url;
      broadcaster.sendCurrentURL(newDevice.deviceId, url);
      console.log(`[device] URL changed to: ${url}`);
    }
  };

  session.on('Page.frameNavigated', (evt: any) => {
    // Only track the main frame, ignore iframes
    if (!evt.frame.parentId) {
      handleNavigation(evt.frame.url);
      // Full navigation (not SPA pushState) — suppress frames until page loads.
      // about:blank is the initial state; real URLs start loading after OpenURL.
      suppressFrames(`frameNavigated → ${evt.frame.url}`);
    }
  });
  session.on('Page.navigatedWithinDocument', (evt: any) => {
    // SPA navigation (e.g. HA switching dashboards via history.pushState).
    // Content is already rendered — do NOT suppress frames.
    handleNavigation(evt.url);
  });

  // Suppress on first setup (about:blank) and start the fallback timer.
  suppressFrames('initial-setup');

  return newDevice;
}

export async function cleanupIdleAsync(ttlMs = 5 * 60_000) {
  if (_cleanupRunning) return;
  _cleanupRunning = true;

  try {
    const now = Date.now();
    const staleIds = Array.from(devices.values())
      .filter(d => now - d.lastActive > ttlMs)
      .map(d => d.deviceId);

    for (const id of staleIds) {
      const dev = devices.get(id);
      if (!dev) continue;

      console.log(`[device] Cleaning up idle device ${id}`);
      await deleteDeviceAsync(dev).catch(() => { /* swallow */ });
    }
  } finally {
    _cleanupRunning = false;
  }
}

async function deleteDeviceAsync(device: DeviceSession) {
  const root = getRoot();

  if (!devices.delete(device.deviceId))
    return;

  if (device.throttleTimer)
    clearTimeout(device.throttleTimer);

  if (device.pageReadyTimer)
    clearTimeout(device.pageReadyTimer);

  if (device.idleRefineTimer)
    clearTimeout(device.idleRefineTimer);

  try { await device.cdp.send("Page.stopScreencast").catch(() => { }); } catch { }
  try { await root?.send("Target.closeTarget", { targetId: device.id }); } catch { }
}

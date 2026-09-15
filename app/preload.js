// Preload — runs before every page in the kiosk window.
//
// The remote kiosk page only gets a read-only marker so it can tailor its
// messages ("press Ctrl+Shift+K on this kiosk…"). The privileged bridge that can
// change the saved kiosk URL is exposed ONLY to our local recovery.html.
const { contextBridge, ipcRenderer } = require('electron');

const versionArg = (process.argv || []).find(a => a.startsWith('--flk-version='));
contextBridge.exposeInMainWorld('fieldlinkKioskApp', Object.freeze({
  app: true,
  platform: 'linux',
  device: 'raspberry-pi',
  version: versionArg ? versionArg.slice('--flk-version='.length) : undefined,
}));

// ── Corner hold: open the settings screen without a keyboard ─────────────────
// A Pi display has no keyboard, so the Ctrl+Shift+K screen can also be opened
// (and closed) by pressing and holding the top-left corner of the screen for
// four seconds with one finger or the mouse. Pointer Events make touch and
// mouse behave the same; listeners run in the capture phase on window so the
// kiosk page (map panning, its own handlers) is not disturbed and cannot
// swallow the gesture. A small progress ring is drawn while holding so the
// person knows the display noticed. Runs on every page this window shows.
(function cornerHold() {
  const HOLD_MS = 4000;        // how long to hold
  const CORNER = 0.12;         // top-left 12% of width and height
  const MAX_MOVE_PX = 40;      // moving further than this cancels
  const RING_AFTER_MS = 500;   // do not draw anything for a stray tap
  let pointerId = null, startX = 0, startY = 0, startAt = 0, timer = null, raf = null, ring = null;

  function inCorner(e) { return e.clientX <= window.innerWidth * CORNER && e.clientY <= window.innerHeight * CORNER; }
  function showRing() {
    if (ring || !document.documentElement) return;
    ring = document.createElement('div');
    ring.setAttribute('aria-hidden', 'true');
    ring.style.cssText = 'position:fixed;top:14px;left:14px;width:64px;height:64px;border-radius:50%;z-index:2147483647;pointer-events:none;' +
      'background:conic-gradient(#e8b84b 0%,rgba(232,184,75,0.15) 0%);box-shadow:0 0 0 3px rgba(10,15,26,0.6),0 8px 24px rgba(0,0,0,0.5);';
    document.documentElement.appendChild(ring);
    const tick = () => {
      if (!ring) return;
      const pct = Math.min(100, Math.round((Date.now() - startAt) / HOLD_MS * 100));
      ring.style.background = `conic-gradient(#e8b84b ${pct}%, rgba(232,184,75,0.15) 0%)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  function cancel() {
    if (timer) clearTimeout(timer); timer = null; pointerId = null;
    if (raf) cancelAnimationFrame(raf); raf = null;
    if (ring) { ring.remove(); ring = null; }
  }
  window.addEventListener('pointerdown', e => {
    if (!e.isPrimary || pointerId !== null || !inCorner(e)) return;
    pointerId = e.pointerId; startX = e.clientX; startY = e.clientY; startAt = Date.now();
    setTimeout(() => { if (pointerId === e.pointerId) showRing(); }, RING_AFTER_MS);
    timer = setTimeout(() => { cancel(); ipcRenderer.send('kiosk:gesture', { name: 'corner-hold' }); }, HOLD_MS);
  }, true);
  window.addEventListener('pointermove', e => { if (pointerId === e.pointerId && Math.hypot(e.clientX - startX, e.clientY - startY) > MAX_MOVE_PX) cancel(); }, true);
  window.addEventListener('pointerup', e => { if (pointerId === e.pointerId) cancel(); }, true);
  window.addEventListener('pointercancel', e => { if (pointerId === e.pointerId) cancel(); }, true);
  window.addEventListener('blur', cancel);
  // A long press would otherwise pop the context menu on a touch screen.
  window.addEventListener('contextmenu', e => { if (pointerId !== null) e.preventDefault(); }, true);
})();

if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('kiosk', {
    getState: ()             => ipcRenderer.invoke('kiosk:get-state'),
    setUrl:   (text, server) => ipcRenderer.invoke('kiosk:set-url', { text, server }),
    retry:    ()             => ipcRenderer.invoke('kiosk:retry'),
    back:     ()             => ipcRenderer.invoke('kiosk:back'),
    quit:     ()             => ipcRenderer.invoke('kiosk:quit'),
    // Kiosk-displayed pairing code (admin types it into FieldLink Admin)
    pairRequest: (server)    => ipcRenderer.invoke('kiosk:pair-request', { server }),
    // Wi-Fi (NetworkManager through main.js)
    wifiScan:    ()               => ipcRenderer.invoke('kiosk:wifi-scan'),
    wifiConnect: (ssid, password) => ipcRenderer.invoke('kiosk:wifi-connect', { ssid, password }),
    wifiHotspot: (on)             => ipcRenderer.invoke('kiosk:wifi-hotspot', { on }),
    wifiForget:  (ssid)           => ipcRenderer.invoke('kiosk:wifi-forget', { ssid }),
    // Updates and maintenance (root helper through main.js)
    updateCheck:   ()        => ipcRenderer.invoke('kiosk:update-check'),
    updateInstall: ()        => ipcRenderer.invoke('kiosk:update-install'),
    updateState:   ()        => ipcRenderer.invoke('kiosk:update-state'),
    setChannel:    (channel) => ipcRenderer.invoke('kiosk:set-channel', { channel }),
    restart:       ()        => ipcRenderer.invoke('kiosk:restart'),
    factoryReset:  ()        => ipcRenderer.invoke('kiosk:factory-reset'),
    logs:          ()        => ipcRenderer.invoke('kiosk:logs'),
    onState:  (cb) => {
      const handler = (_e, state) => cb(state);
      ipcRenderer.on('kiosk:state', handler);
      return () => ipcRenderer.removeListener('kiosk:state', handler);
    },
  });
}

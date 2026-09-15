// FieldLink Pi Kiosk — Linux Electron shell around the FieldLink kiosk web page.
//
// This is the Raspberry Pi counterpart of the Windows shell in
// Whitened-Fields-Ministries/Fieldlink-Win-Kiosk. It speaks the same server
// protocol (pairing by on-screen code, the 30 s /whoami key check, the recovery
// screen) and is kept deliberately close to that file so fixes port both ways.
// Everything Windows-specific (the elevated PowerShell helper, the NSIS updater)
// is gone; on the Pi the image owns kiosk mode and updates arrive through apt.
//
// Responsibilities:
//   • Find the kiosk URL (which carries this display's API key) in config.json.
//   • Show the kiosk full-screen and keep it healthy: reload after crashes,
//     survive the network being down at boot, recover from maintenance pages.
//   • Notice when the key has been deleted/disabled on the server and show a
//     recovery screen instead of a stale or broken page.
//   • Let an admin link the display without touching files: the screen shows
//     a code that is typed into FieldLink Admin (or a kiosk URL can be pasted).
//
// Config resolution — the most recently modified of these wins:
//   $FIELDLINK_KIOSK_STATE_DIR/config.json   the image's unit sets the state dir
//                                            to /var/lib/fieldlink-kiosk
//   <userData>/config.json                   ~/.config/fieldlink-pi-kiosk when
//                                            started by hand
//   ./config.json                            development only (npm start)
//
// Keyboard (a keyboard plugged into the Pi) — or, with no keyboard, press and
// hold the top-left corner of the screen for four seconds (touch or mouse) to
// open and close the settings screen:
//   Ctrl+Shift+K  open the settings / recovery screen
//   Ctrl+Shift+R  reload the kiosk page
//   Ctrl+Shift+Q  quit the app (systemd starts it again within seconds)
//
// Networking (network.js, setup-server.js): with no cable and no Wi-Fi the Pi
// becomes a hotspot and serves a setup page to a phone; see "Network" below.
//
// Flags:
//   --smoke-test  start, load the recovery screen once, exit 0 — used by CI to
//                 prove the packaged app runs on the target architecture.

const { app, BrowserWindow, ipcMain, net, powerSaveBlocker } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { execFile } = require('child_process');
const QRCode = require('qrcode');
const network = require('./network');
const { createSetupServer } = require('./setup-server');

const APP_VERSION        = app.getVersion();
// The FieldLink app lives on the app. host; the bare domain is the public website.
const DEFAULT_SERVER     = 'https://app.fieldlinkmissions.com';
// Short names accepted wherever a server can be typed (setup screen, pasted key):
// "qa" points a display at the QA stack without spelling out its hostname.
const SERVER_ALIASES     = {
  prod: DEFAULT_SERVER, production: DEFAULT_SERVER, live: DEFAULT_SERVER,
  qa: 'https://app.qa.fieldlinkmissions.com', test: 'https://app.qa.fieldlinkmissions.com',
};
const LEGACY_ORIGINS     = {
  'https://fieldlinkmissions.com':     DEFAULT_SERVER,
  'https://www.fieldlinkmissions.com': DEFAULT_SERVER,
  'https://qa.fieldlinkmissions.com':  SERVER_ALIASES.qa,
};
const HEALTH_INTERVAL_MS = 30 * 1000;          // steady-state key/server check
const RETRY_STEPS_MS     = [5000, 10000, 20000, 30000]; // backoff while offline
const REQUEST_TIMEOUT_MS = 15 * 1000;
const KEY_RE             = /^fl_kiosk_[0-9a-f]{16,}$/i;
const SMOKE_TEST         = process.argv.includes('--smoke-test');

// Everything this display remembers lives in one directory so the image can
// wipe it for a factory reset. The systemd unit sets it; by hand it defaults to
// Electron's per-user config directory.
const STATE_DIR = process.env.FIELDLINK_KIOSK_STATE_DIR || null;
if (STATE_DIR) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); app.setPath('userData', STATE_DIR); } catch {}
}

// Videos in missionary updates should play without a click on a lobby TV.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── Logging ──────────────────────────────────────────────────────────────────
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(logPath(), line + '\n'); } catch {}
}
function logPath() { return path.join(app.getPath('userData'), 'kiosk.log'); }
function trimLog() {
  try {
    const p = logPath();
    if (fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024) {
      const tail = fs.readFileSync(p, 'utf8').split('\n').slice(-500).join('\n');
      fs.writeFileSync(p, tail);
    }
  } catch {}
}

// ── Config ───────────────────────────────────────────────────────────────────
function configCandidates() {
  const list = [path.join(app.getPath('userData'), 'config.json')];
  if (!app.isPackaged) list.push(path.join(__dirname, 'config.json'));
  return [...new Set(list)];
}

// Returns { config, source } — the newest valid config.json, or { config: null }.
function loadConfig() {
  let best = null;
  for (const p of configCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      const stat = fs.statSync(p);
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { config: parsed, source: p, mtimeMs: stat.mtimeMs };
    } catch (e) {
      log(`config: could not read ${p}: ${e.message}`);
    }
  }
  return best || { config: null, source: null };
}

// Writable targets, in order of preference.
function writableConfigTargets() {
  const list = [path.join(app.getPath('userData'), 'config.json')];
  if (!app.isPackaged) list.unshift(path.join(__dirname, 'config.json'));
  return list;
}

function saveConfig(patch) {
  const { config } = loadConfig();
  const merged = { ...(config || {}), ...patch, updatedAt: new Date().toISOString(), updatedBy: `FieldLinkPiKiosk ${APP_VERSION}` };
  const body = JSON.stringify(merged, null, 2);
  let lastErr = null;
  for (const target of writableConfigTargets()) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = target + '.tmp';
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, target);
      log(`config: saved to ${target}`);
      return target;
    } catch (e) {
      lastErr = e;
      log(`config: cannot write ${target}: ${e.message}`);
    }
  }
  throw new Error(`Could not save config anywhere (${lastErr ? lastErr.message : 'unknown error'})`);
}

function parseKioskUrl(kioskUrl) {
  try {
    const u = new URL(kioskUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return { url: u.toString(), origin: u.origin, key: u.searchParams.get('key') || '' };
  } catch { return null; }
}

// Accepts a full kiosk URL or a bare key; returns a normalised kiosk URL.
function normaliseKioskInput(text, fallbackOrigin) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Nothing entered.');
  if (KEY_RE.test(t)) {
    const origin = normaliseOrigin(fallbackOrigin || DEFAULT_SERVER);
    return `${origin}/kiosk?key=${t}`;
  }
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  const parsed = parseKioskUrl(withScheme);
  if (!parsed) throw new Error('That is not a valid web address.');
  if (!parsed.key) throw new Error('That address has no ?key=… part. Copy the full kiosk URL from FieldLink Admin → Kiosk.');
  if (!KEY_RE.test(parsed.key)) throw new Error('The key in that address does not look like a FieldLink kiosk key.');
  const moved = LEGACY_ORIGINS[parsed.origin];
  return moved ? `${moved}/kiosk?key=${parsed.key}` : parsed.url;
}

function normaliseOrigin(text) {
  const t = String(text || '').trim();
  if (!t) return DEFAULT_SERVER;
  const alias = SERVER_ALIASES[t.toLowerCase()];
  if (alias) return alias;
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  const u = new URL(withScheme);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Server must be an http(s) address.');
  return u.origin;
}

// ── Clock ────────────────────────────────────────────────────────────────────
// A Pi has no battery-backed clock. Until NTP has set the time, TLS to the
// server fails with "certificate not yet valid", which must read as
// "connecting…" on screen, not as an error. systemd-timesyncd creates this file
// the first time it has synchronised.
function clockSynced() {
  if (process.platform !== 'linux') return true;
  try { return fs.existsSync('/run/systemd/timesync/synchronized'); } catch { return true; }
}

// The IPv4 addresses of this Pi, for the Details panel (handy for ssh while testing).
function localAddresses() {
  const out = [];
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal) out.push(`${name} ${i.address}`);
      }
    }
  } catch {}
  return out;
}

// ── Server health / key validity ─────────────────────────────────────────────
async function fetchJson(url, init = {}) {
  const res = await net.fetch(url, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'Accept': 'application/json', 'User-Agent': `FieldLinkKiosk/${APP_VERSION} (Raspberry Pi)`, ...(init.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, body };
}

// → { status: 'ok'|'invalid'|'server'|'offline', http, info, error }
async function checkKey(kioskUrl) {
  const parsed = parseKioskUrl(kioskUrl);
  if (!parsed || !parsed.key) return { status: 'invalid', error: 'no key in URL' };
  const headers = { 'x-kiosk-key': parsed.key };
  try {
    const r = await fetchJson(`${parsed.origin}/api/kiosk/whoami`, { headers });
    if (r.ok) return { status: 'ok', http: r.status, info: r.body || {} };
    if (r.status === 401 || r.status === 403) return { status: 'invalid', http: r.status, error: (r.body && r.body.error) || `HTTP ${r.status}` };
    return { status: 'server', http: r.status, error: (r.body && r.body.error) || `HTTP ${r.status}` };
  } catch (e) {
    return { status: 'offline', error: e && e.message ? e.message : String(e) };
  }
}

// ── Application state ────────────────────────────────────────────────────────
let win = null;
let kioskUrl = null;          // current kiosk URL (string) or null
let configSource = null;
let view = 'none';            // 'kiosk' | 'recovery'
let recoveryReason = null;    // 'invalid-key' | 'offline' | 'server' | 'no-config' | 'manual'
let pageFailed = false;       // kiosk page failed to load / showed an HTTP error page
let invalidStreak = 0;
let offlineStreak = 0;
let lastCheck = null;         // { at, status, http, error, info }
let checkTimer = null;
let checking = false;
let nextCheckAt = null;
let lastGoodAt = null;
let keyInfo = null;           // { name, key_prefix, display_mode, ... } from /whoami

function stateForPage() {
  const parsed = kioskUrl ? parseKioskUrl(kioskUrl) : null;
  return {
    reason:        recoveryReason,
    appVersion:    APP_VERSION,
    electron:      process.versions.electron,
    hostname:      os.hostname(),
    addresses:     localAddresses(),
    clockSynced:   clockSynced(),
    server:        parsed ? parsed.origin : null,
    keyPrefix:     parsed && parsed.key ? parsed.key.slice(0, 20) + '…' : null,
    keyName:       keyInfo && keyInfo.name ? keyInfo.name : null,
    hasConfig:     !!kioskUrl,
    configSource,
    configTargets: writableConfigTargets(),
    logPath:       logPath(),
    lastCheck,
    lastGoodAt,
    nextCheckAt,
    defaultServer: DEFAULT_SERVER,
    pair:          pair ? { code: pair.code, expiresAt: pair.expiresAt, origin: pair.origin, status: pair.status, error: pair.error } : null,
    platform:      process.platform,
    net:           netForPage(),
    updateState,
  };
}

function pushState() {
  if (win && !win.isDestroyed() && view === 'recovery') {
    win.webContents.send('kiosk:state', stateForPage());
  }
}

// A kiosk URL saved before the app moved to the app.* host keeps its key and gets
// the new origin. Returns the URL to use (unchanged when nothing is legacy).
function migrateLegacyOrigin(parsed) {
  const target = parsed && LEGACY_ORIGINS[parsed.origin];
  if (!target) return parsed ? parsed.url : null;
  const migrated = `${target}/kiosk?key=${parsed.key}`;
  log(`config: server moved ${parsed.origin} → ${target} (same key)`);
  try { saveConfig({ kioskUrl: migrated }); }
  catch (e) { log(`config: could not save the moved server, using it for this run only: ${e.message}`); }
  return migrated;
}

function applyConfig() {
  const { config, source } = loadConfig();
  configSource = source;
  const parsed = config && config.kioskUrl ? parseKioskUrl(config.kioskUrl) : null;
  kioskUrl = parsed ? migrateLegacyOrigin(parsed) : null;
  if (config && config.kioskUrl && !parsed) log(`config: kioskUrl is not a valid URL: ${config.kioskUrl}`);
  log(`config: ${kioskUrl ? `using ${source}` : 'no usable config found'} (candidates: ${configCandidates().join(' | ')})`);
  return !!kioskUrl;
}

// ── Views ────────────────────────────────────────────────────────────────────
function showKiosk() {
  if (!win || win.isDestroyed() || !kioskUrl) return;
  view = 'kiosk';
  recoveryReason = null;
  pageFailed = false;
  stopPairRequest();
  log(`view: kiosk → ${maskUrl(kioskUrl)}`);
  win.loadURL(kioskUrl, { userAgent: userAgent() });
}

function showRecovery(reason) {
  if (!win || win.isDestroyed()) return;
  if (view === 'recovery') {
    // Never re-navigate while the admin may be typing — just update the reason.
    if (recoveryReason !== reason) { recoveryReason = reason; log(`view: recovery reason → ${reason}`); }
    maybeStartPairing(reason);
    pushState();
    return;
  }
  view = 'recovery';
  recoveryReason = reason;
  log(`view: recovery (${reason})`);
  win.loadFile(path.join(__dirname, 'recovery.html'), { query: { reason } });
  maybeStartPairing(reason);
}

// On-screen pairing makes sense whenever the display needs (or may want) a new
// key — not while we are merely offline.
function maybeStartPairing(reason) {
  if (!['invalid-key', 'no-config', 'manual'].includes(reason)) return;
  if (pair && pair.status !== 'error') return;
  startPairRequest();
}

function maskUrl(u) {
  const p = parseKioskUrl(u);
  return p ? `${p.origin}/kiosk?key=${p.key ? p.key.slice(0, 20) + '…' : ''}` : String(u);
}

let _ua = null;
function userAgent() {
  if (!_ua) _ua = `${win.webContents.getUserAgent()} FieldLinkKiosk/${APP_VERSION} FieldLinkPiKiosk/${APP_VERSION}`;
  return _ua;
}

// ── Health loop ──────────────────────────────────────────────────────────────
function scheduleCheck(delayMs) {
  if (checkTimer) clearTimeout(checkTimer);
  nextCheckAt = Date.now() + delayMs;
  checkTimer = setTimeout(runCheck, delayMs);
  pushState();
}

function backoffDelay(streak) {
  // Until the clock is set every TLS attempt fails; poll quickly, NTP is seconds away.
  if (!clockSynced()) return RETRY_STEPS_MS[0];
  return RETRY_STEPS_MS[Math.min(streak, RETRY_STEPS_MS.length) - 1] || RETRY_STEPS_MS[0];
}

async function runCheck() {
  if (checking) return;
  checking = true;
  try {
    if (!kioskUrl) {
      showRecovery('no-config');
      scheduleCheck(pair && pair.status === 'error' ? backoffDelay(1) : HEALTH_INTERVAL_MS);
      return;
    }
    const result = await checkKey(kioskUrl);
    lastCheck = { at: Date.now(), ...result };

    if (result.status === 'ok') {
      invalidStreak = 0; offlineStreak = 0; lastGoodAt = Date.now();
      if (result.info && (result.info.name || result.info.key_prefix)) keyInfo = result.info;
      followServerChannel(result.info && result.info.update_channel);
      const recovering = view === 'recovery' && ['invalid-key', 'offline', 'server', 'no-config'].includes(recoveryReason);
      if (recovering || (view === 'kiosk' && pageFailed)) {
        log(`health: ok — loading kiosk (was ${view}/${recoveryReason || (pageFailed ? 'page-failed' : '')})`);
        showKiosk();
      } else {
        pushState();
      }
      scheduleCheck(HEALTH_INTERVAL_MS);
      return;
    }

    if (result.status === 'invalid') {
      invalidStreak++; offlineStreak = 0;
      log(`health: key rejected (${result.error}) streak=${invalidStreak}`);
      // Two consecutive rejections before taking over a working display —
      // the server never answers 401 transiently, this is just belt and braces.
      if (invalidStreak >= 2 || view !== 'kiosk' || pageFailed) showRecovery('invalid-key');
      scheduleCheck(invalidStreak < 2 ? 5000 : HEALTH_INTERVAL_MS);
      return;
    }

    // 'server' (5xx, maintenance) or 'offline' (no network / DNS / timeout)
    offlineStreak++; invalidStreak = 0;
    log(`health: ${result.status} (${result.error}) streak=${offlineStreak}${clockSynced() ? '' : ' clock-not-synced'}`);
    if (view === 'kiosk' && !pageFailed) {
      // The page is up and has its own offline handling (service worker) — leave it alone.
    } else if (view === 'recovery' && recoveryReason === 'invalid-key') {
      // Keep the key message; it is more useful than "offline".
      pushState();
    } else {
      showRecovery(result.status === 'server' ? 'server' : 'offline');
    }
    scheduleCheck(backoffDelay(offlineStreak));
  } catch (e) {
    log(`health: unexpected error ${e && e.stack || e}`);
    scheduleCheck(HEALTH_INTERVAL_MS);
  } finally {
    checking = false;
  }
}

// ── Config file watching (config.json written from outside, e.g. over ssh) ──
let watchTimer = null;
function watchConfigDirs() {
  const dirs = [...new Set(configCandidates().map(p => path.dirname(p)))];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (filename && !/config\.json/i.test(String(filename))) return;
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = setTimeout(onConfigChanged, 1500);
      });
    } catch (e) { log(`watch: cannot watch ${dir}: ${e.message}`); }
  }
}

function onConfigChanged() {
  const before = kioskUrl;
  applyConfig();
  if (kioskUrl && kioskUrl !== before) {
    log('config: kioskUrl changed on disk — reloading');
    invalidStreak = 0; keyInfo = null;
    showKiosk();
    scheduleCheck(3000);
  } else if (kioskUrl && view === 'recovery' && recoveryReason === 'no-config') {
    showKiosk();
    scheduleCheck(3000);
  }
}

// ── Updates, restart, factory reset: the root helper ─────────────────────────
// Everything that needs root goes through /usr/lib/fieldlink-kiosk/root-helper
// (shipped in the .deb, allowed for the kiosk user by a sudoers entry). It is
// a fixed menu; see the script for the commands. New builds arrive through
// the signed apt repository (nightly by unattended-upgrades, or from the
// settings screen here); the package's postinst restarts the display.
const ROOT_HELPER = '/usr/lib/fieldlink-kiosk/root-helper';
let updateState = null; // { phase: idle|checking|installing|done|failed, installed, candidate, newer, channel, message, lines, checkedAt, error, available }

function setUpdateState(patch) {
  updateState = { ...(updateState || {}), ...patch, updatedAt: Date.now() };
  pushState();
}

function runHelper(args, { timeoutMs = 10 * 60 * 1000, onLine } = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', buf = '';
    const child = execFile('sudo', ['-n', ROOT_HELPER, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      const extra = err && typeof err.code !== 'number' ? String(err.message || err) : '';
      resolve({ code, stdout: String(out || stdout), stderr: String(errOut || stderr) + (extra ? `\n${extra}` : '') });
    });
    if (onLine && child.stdout) {
      child.stdout.on('data', d => { buf += d; const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(l => l.trim() && onLine(l.trim())); });
    }
  });
}

function cmpVersion(a, b) {
  const pa = String(a).split(/[.+~-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.+~-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

function helperUnavailable(r) {
  const t = `${r.stderr} ${r.stdout}`;
  if (/ENOENT|not found|command not found/i.test(t)) return 'Updates are not available in this build (no root helper).';
  if (/password is required|not allowed|sudo:/i.test(t)) return 'The display is not allowed to run its update helper (sudoers).';
  return null;
}

async function checkUpdate() {
  if (updateState && ['checking', 'installing'].includes(updateState.phase)) return updateState;
  setUpdateState({ phase: 'checking', message: 'Checking for a newer build…', error: null, lines: [] });
  const r = await runHelper(['check-update'], { timeoutMs: 3 * 60 * 1000 });
  const un = helperUnavailable(r);
  if (un) { setUpdateState({ phase: 'idle', available: false, installed: APP_VERSION, error: un, message: un }); return updateState; }
  const get = k => { const m = r.stdout.match(new RegExp(`^${k}=(.*)$`, 'm')); return m ? m[1].trim() : null; };
  const installed = get('installed') || APP_VERSION;
  const candidate = get('candidate');
  const ch = await runHelper(['channel'], { timeoutMs: 30 * 1000 });
  const channel = (ch.stdout.match(/^channel=(.*)$/m) || [])[1] || 'none';
  const newer = !!candidate && candidate !== '(none)' && cmpVersion(candidate, installed) > 0;
  const noSource = channel === 'none';
  log(`update: installed ${installed}, candidate ${candidate || '?'}, channel ${channel}${r.code ? `, helper exit ${r.code}` : ''}`);
  setUpdateState({ phase: 'idle', available: true, installed, candidate, newer, channel, checkedAt: Date.now(), error: r.code ? (r.stderr.trim().split('\n').pop() || `helper exit ${r.code}`) : null,
    message: noSource ? 'This build has no update channel configured.' : newer ? `Version ${candidate} is available.` : `Up to date (${installed}).` });
  return updateState;
}

async function installUpdate() {
  if (updateState && ['checking', 'installing'].includes(updateState.phase)) return { ok: false, error: 'An update is already in progress.' };
  const st = await checkUpdate();
  if (st.error && !st.available) return { ok: false, error: st.error };
  if (!st.newer) return { ok: true, upToDate: true };
  const from = st.installed, to = st.candidate;
  setUpdateState({ phase: 'installing', message: `Installing ${to}… the display restarts by itself when it is done.`, lines: [], error: null });
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'last-update.json'), JSON.stringify({ from, to, startedAt: new Date().toISOString() })); } catch {}
  log(`update: installing ${to} (from ${from})`);
  // The helper hands the install to a transient systemd unit (our own service
  // gets restarted by the package's postinst, which would kill dpkg if it ran
  // in our cgroup) and returns at once; progress is a log file we tail.
  const r = await runHelper(['update'], { timeoutMs: 60 * 1000 });
  if (r.code !== 0) {
    const msg = (r.stderr.trim().split('\n').filter(Boolean).pop()) || `helper exit ${r.code}`;
    log(`update: could not start — ${msg}`);
    setUpdateState({ phase: 'failed', message: `Update could not start: ${msg}`, error: msg });
    return { ok: false, error: msg };
  }
  followUpdateLog(to);
  return { ok: true };
}

const UPDATE_LOG = '/var/log/fieldlink-kiosk-update.log';
function followUpdateLog(to) {
  const deadline = Date.now() + 15 * 60 * 1000;
  let seen = 0;
  const tick = () => {
    let text = '';
    try { text = fs.readFileSync(UPDATE_LOG, 'utf8'); } catch {}
    const lines = text.split('\n').filter(Boolean);
    if (lines.length !== seen) { seen = lines.length; setUpdateState({ lines: lines.slice(-14) }); }
    const last = lines[lines.length - 1] || '';
    if (/^done:/.test(last)) { log(`update: ${last}`); setUpdateState({ phase: 'done', message: `Installed ${to}. Restarting the display…` }); return; }
    if (/^failed:/.test(last)) { log(`update: ${last}`); setUpdateState({ phase: 'failed', message: `Update failed: ${last.replace(/^failed:\s*/, '')}`, error: last }); return; }
    if (Date.now() > deadline) { setUpdateState({ phase: 'failed', message: 'The update did not finish within 15 minutes.', error: 'timeout' }); return; }
    // The unit itself is the source of truth once the log goes quiet.
    execFile('systemctl', ['is-active', 'fieldlink-kiosk-update'], { timeout: 5000 }, (_e, out) => {
      const active = String(out || '').trim();
      if ((active === 'inactive' || active === 'failed') && lines.length && !/^(done|failed):/.test(last) && seen > 1) {
        setUpdateState({ phase: active === 'failed' ? 'failed' : 'done', message: active === 'failed' ? 'Update failed (see Show log).' : `Installed ${to}. Restarting the display…`, error: active === 'failed' ? 'unit failed' : null });
        return;
      }
      setTimeout(tick, 1000);
    });
  };
  setTimeout(tick, 1000);
}

// After the package's postinst restarted us, say so once on the settings screen.
function noteCompletedUpdate() {
  const file = path.join(app.getPath('userData'), 'last-update.json');
  try {
    if (!fs.existsSync(file)) return;
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    if (m && m.to && cmpVersion(APP_VERSION, m.from || '0') >= 0) {
      log(`update: now running ${APP_VERSION} (was ${m.from || '?'}, started ${m.startedAt || '?'})`);
      updateState = { phase: 'idle', available: true, installed: APP_VERSION, message: `Updated to ${APP_VERSION} (from ${m.from || '?'}).`, lines: [], updatedAt: Date.now() };
    }
  } catch {}
}

// The server names the update channel its displays should follow (/whoami
// answers update_channel: "qa" on a QA server, "prod" on production), so a
// display linked to QA gets early builds from apt-qa and one linked to prod
// only promoted ones — the same image, no reflash. Switched at most once per
// change; a server that does not send the field leaves the manual switch alone.
let followedChannel = null;   // last channel the server asked for and we applied (or found in place)
let followingChannel = false;
async function followServerChannel(wanted) {
  if (!['qa', 'prod'].includes(wanted) || wanted === followedChannel || followingChannel) return;
  followingChannel = true;
  try {
    const cur = await runHelper(['channel'], { timeoutMs: 30 * 1000 });
    if (helperUnavailable(cur)) return;
    const current = (cur.stdout.match(/^channel=(.*)$/m) || [])[1] || 'none';
    if (current === 'none') return;                       // this build has no update source to point anywhere
    if (current === wanted) { followedChannel = wanted; return; }
    log(`update: server asks for the ${wanted} channel (display is on ${current}) — switching`);
    const r = await runHelper(['channel', wanted], { timeoutMs: 3 * 60 * 1000 });
    if (r.code) { log(`update: channel switch failed — ${r.stderr.trim().split('\n').pop() || `helper exit ${r.code}`}`); return; }
    followedChannel = wanted;
    if (updateState) setUpdateState({ channel: wanted });
    checkUpdate().catch(() => {});
  } catch (e) {
    log(`update: channel follow error ${e && e.message || e}`);
  } finally {
    followingChannel = false;
  }
}

ipcMain.handle('kiosk:update-check', () => checkUpdate());
ipcMain.handle('kiosk:update-install', () => installUpdate());
ipcMain.handle('kiosk:update-state', () => updateState);
ipcMain.handle('kiosk:set-channel', async (_e, { channel } = {}) => {
  if (!['qa', 'prod'].includes(channel)) return { ok: false, error: 'Channel must be qa or prod.' };
  const r = await runHelper(['channel', channel], { timeoutMs: 3 * 60 * 1000 });
  const un = helperUnavailable(r);
  if (un || r.code) return { ok: false, error: un || r.stderr.trim().split('\n').pop() || `helper exit ${r.code}` };
  log(`update: channel set to ${channel}`);
  await checkUpdate();
  return { ok: true, channel };
});
ipcMain.handle('kiosk:restart', async () => {
  log('restart requested from the settings screen');
  const r = await runHelper(['reboot'], { timeoutMs: 30 * 1000 });
  const un = helperUnavailable(r);
  return un || r.code ? { ok: false, error: un || r.stderr.trim() || `helper exit ${r.code}` } : { ok: true };
});
ipcMain.handle('kiosk:factory-reset', async () => {
  log('factory reset requested from the settings screen');
  stopPairRequest();
  const r = await runHelper(['factory-reset'], { timeoutMs: 2 * 60 * 1000 });
  const un = helperUnavailable(r);
  return un || r.code ? { ok: false, error: un || r.stderr.trim() || `helper exit ${r.code}` } : { ok: true };
});
ipcMain.handle('kiosk:logs', async () => {
  const r = await runHelper(['logs'], { timeoutMs: 30 * 1000 });
  let own = '';
  try { own = fs.readFileSync(logPath(), 'utf8').split('\n').slice(-80).join('\n'); } catch {}
  const journal = helperUnavailable(r) ? `(journal not available: ${helperUnavailable(r)})` : r.stdout;
  let update = '';
  try { update = fs.readFileSync(UPDATE_LOG, 'utf8').split('\n').slice(-40).join('\n'); } catch {}
  return { journal: journal.trim().split('\n').slice(-120).join('\n'), app: own, update };
});

// ── Network: Ethernet, Wi-Fi and the phone setup hotspot ─────────────────────
// Ethernet plugged in → nothing to do. No network at all → after a grace
// period the Pi becomes a Wi-Fi hotspot ("FieldLink-XXXX"), shows a QR code,
// and serves the setup page (setup-server.js) to the phone that joins. The
// phone picks the church's network; the hotspot goes down and the Pi joins
// it. The radio cannot do both at once, so this is a hand-off, not a bridge.
const NET_POLL_ONLINE_MS      = 30 * 1000;
const NET_POLL_OFFLINE_MS     = 5 * 1000;
// A display without keyboard or touch has no other way in, so the setup
// network comes up almost at once. The short waits only give DHCP on a cable
// or a saved Wi-Fi the few seconds they need at boot.
const HOTSPOT_GRACE_MS        = 8 * 1000;       // no cable, nothing saved → hotspot
const HOTSPOT_GRACE_ETH_MS    = 20 * 1000;      // cable plugged in but no address yet (DHCP)
const HOTSPOT_GRACE_SAVED_MS  = 25 * 1000;      // a saved Wi-Fi exists → let NetworkManager join first
const HOTSPOT_IDLE_RETRY_MS   = 10 * 60 * 1000; // hotspot up, no phone → retry the saved Wi-Fi
const HOTSPOT_RETRY_WINDOW_MS = 45 * 1000;      // how long that retry gets

let netState = {          // not Electron's net module (that is the fetch client)
  available: null,     // nmcli usable?
  error: null,         // last status() error
  status: null,        // network.status() result
  phase: 'idle',       // idle | hotspot | connecting
  hotspot: null,       // { ssid, password, ip, qr }
  qr: null,            // data: URL of the QR image
  networks: [],        // last scan (cached before the hotspot went up)
  scannedAt: null,
  connectingSsid: null,
  failedSsid: null,
  lastError: null,
  noNetSince: null,
  hotspotUpAt: null,
  lastPhoneHitAt: null,
  retryUntil: null,
};
let netTimer = null;
let netBusy = false;
let setupServer = null;

function netForPage() {
  const st = netState.status;
  return {
    available: netState.available,
    error: netState.error,
    online: !!(st && st.online),
    eth:  st ? st.eth  : null,
    wifi: st ? st.wifi : null,
    saved: st ? st.saved : [],
    hotspot: { active: !!(st && st.hotspot.active), ssid: netState.hotspot && netState.hotspot.ssid, password: netState.hotspot && netState.hotspot.password, ip: network.HOTSPOT_ADDR, qr: netState.qr },
    phase: netState.phase,
    connectingSsid: netState.connectingSsid,
    failedSsid: netState.failedSsid,
    lastError: netState.lastError,
    networks: netState.networks,
    scannedAt: netState.scannedAt,
    noNetSince: netState.noNetSince,
  };
}

function scheduleNet(delayMs) {
  if (netTimer) clearTimeout(netTimer);
  netTimer = setTimeout(netTick, delayMs);
}

async function netTick() {
  if (netBusy) return scheduleNet(2000);
  netBusy = true;
  try {
    if (netState.available === null) {
      netState.available = await network.available();
      if (!netState.available) log('net: nmcli not found — Wi-Fi setup disabled');
    }
    if (!netState.available) { netState.error = 'NetworkManager (nmcli) is not available on this system.'; return; }
    let st;
    try { st = await network.status(); netState.error = null; }
    catch (e) { netState.error = e.message; log(`net: status failed: ${e.message}`); return; }
    const was = netState.status;
    netState.status = st;
    if (!was || was.online !== st.online) log(`net: ${st.online ? 'online' : 'offline'} (eth ${st.eth ? st.eth.state + (st.eth.ip ? ' ' + st.eth.ip : '') : 'none'}, wifi ${st.wifi ? st.wifi.state + (st.wifi.ssid ? ' ' + st.wifi.ssid : '') + (st.wifi.ip ? ' ' + st.wifi.ip : '') : 'none'}${st.hotspot.active ? ', hotspot up' : ''})`);

    if (st.online) {
      netState.noNetSince = null; netState.retryUntil = null;
      if (netState.phase === 'hotspot' || st.hotspot.active) { log('net: online — taking the setup network down'); await stopHotspot(); }
      if (netState.phase !== 'connecting') netState.phase = 'idle';
      return;
    }
    if (netState.phase === 'connecting') return; // joinNetwork() is driving
    if (netState.phase === 'hotspot' && st.hotspot.active) {
      // A router reboot or a Wi-Fi outage should not leave the display in
      // setup mode forever: with nobody on the phone page, drop the hotspot
      // now and then so NetworkManager can retry the saved network.
      const idleFor = Date.now() - Math.max(netState.hotspotUpAt || 0, netState.lastPhoneHitAt || 0);
      if (st.saved.length && idleFor > HOTSPOT_IDLE_RETRY_MS) {
        log('net: nobody on the setup page for a while — trying the saved Wi-Fi again');
        await stopHotspot();
        netState.retryUntil = Date.now() + HOTSPOT_RETRY_WINDOW_MS;
      }
      return;
    }
    if (netState.phase === 'hotspot' && !st.hotspot.active) { log('net: setup network went away'); netState.phase = 'idle'; }
    if (!st.wifi) return;                                  // no radio: only the offline screen
    if (netState.retryUntil && Date.now() < netState.retryUntil) return;
    if (netState.retryUntil) { netState.retryUntil = null; await startHotspot('saved Wi-Fi still not reachable'); return; }
    if (!netState.noNetSince) { netState.noNetSince = Date.now(); return; }
    const grace = st.saved.length ? HOTSPOT_GRACE_SAVED_MS : (st.eth && st.eth.carrier ? HOTSPOT_GRACE_ETH_MS : HOTSPOT_GRACE_MS);
    if (Date.now() - netState.noNetSince >= grace) await startHotspot(st.saved.length ? 'saved Wi-Fi did not come up' : 'no network');
  } catch (e) {
    log(`net: unexpected error ${e && e.stack || e}`);
  } finally {
    netBusy = false;
    pushState();
    scheduleNet(netState.status && netState.status.online ? NET_POLL_ONLINE_MS : NET_POLL_OFFLINE_MS);
  }
}

async function startHotspot(reason) {
  log(`net: starting the setup network (${reason})`);
  try {
    try { await network.radioOn(); } catch (e) { log(`net: radio on failed: ${e.message}`); }
    // Scan before the hotspot takes the radio; the phone page shows this list.
    try { netState.networks = await network.scan({ rescan: true }); netState.scannedAt = Date.now(); }
    catch (e) { log(`net: scan failed: ${e.message}`); }
    const hs = await network.hotspotUp();
    netState.hotspot = hs;
    try { netState.qr = await QRCode.toDataURL(hs.qr, { margin: 1, width: 480, errorCorrectionLevel: 'M', color: { dark: '#0a0f1aff', light: '#ffffffff' } }); }
    catch (e) { netState.qr = null; log(`net: QR failed: ${e.message}`); }
    netState.phase = 'hotspot'; netState.hotspotUpAt = Date.now(); netState.lastPhoneHitAt = null;
    if (!setupServer) setupServer = createSetupServer({ backend: setupBackend(), log });
    try { await setupServer.start(80, network.HOTSPOT_ADDR); }
    catch (e) { log(`net: setup page cannot listen on port 80: ${e.message}`); netState.lastError = `The phone setup page could not start (${e.message}). Use a keyboard instead.`; }
    log(`net: setup network "${hs.ssid}" is up, page at http://${network.HOTSPOT_ADDR}/`);
  } catch (e) {
    netState.phase = 'idle'; netState.lastError = e.message; netState.noNetSince = Date.now();
    log(`net: hotspot failed: ${e.message}`);
  }
  pushState();
}

async function stopHotspot() {
  if (setupServer) await setupServer.stop();
  await network.hotspotDown();
  if (netState.phase === 'hotspot') netState.phase = 'idle';
  netState.hotspotUpAt = null;
}

// Join a network chosen on the phone page or with a keyboard.
async function joinNetwork(ssid, password, source) {
  if (!ssid) return { ok: false, error: 'Enter the network name.' };
  if (netState.phase === 'connecting') return { ok: false, error: 'Already connecting — wait a moment.' };
  const wasHotspot = netState.phase === 'hotspot';
  netState.phase = 'connecting'; netState.connectingSsid = ssid; netState.failedSsid = null; netState.lastError = null;
  pushState();
  log(`net: joining "${ssid}" (from ${source})`);
  if (wasHotspot) {
    // Give the phone time to receive the confirmation before the network vanishes.
    await new Promise(r => setTimeout(r, 2500));
    await stopHotspot();
  }
  const r = await network.connect(ssid, password);
  netState.connectingSsid = null;
  if (r.ok) {
    log(`net: joined "${ssid}" (${r.ip || 'address pending'})`);
    netState.phase = 'idle'; netState.noNetSince = null; netState.retryUntil = null;
    pushState();
    if (checkTimer) clearTimeout(checkTimer);
    scheduleCheck(3000);
    scheduleNet(1500);
    return r;
  }
  log(`net: could not join "${ssid}": ${r.detail || r.error}`);
  netState.failedSsid = ssid; netState.lastError = r.error;
  if (wasHotspot) await startHotspot('retry after a failed join'); // the phone rejoins and sees the error
  else { netState.phase = 'idle'; netState.noNetSince = Date.now(); }
  pushState();
  return r;
}

// What the phone page (setup-server.js) can ask for.
function setupBackend() {
  return {
    getNetworks: async () => ({ networks: netState.networks, scannedAt: netState.scannedAt }),
    getStatus: async () => ({
      phase: (netState.status && netState.status.online) ? 'connected' : (netState.phase === 'hotspot' && netState.failedSsid) ? 'failed' : netState.phase,
      ssid: netState.connectingSsid || netState.failedSsid || null,
      error: netState.lastError,
      hotspot: { ssid: netState.hotspot && netState.hotspot.ssid },
    }),
    connect: (ssid, password) => joinNetwork(ssid, password, 'phone'),
    touch: () => { netState.lastPhoneHitAt = Date.now(); },
  };
}

ipcMain.handle('kiosk:wifi-scan', async () => {
  try {
    if (netState.phase === 'hotspot') return { networks: netState.networks, scannedAt: netState.scannedAt, cached: true };
    netState.networks = await network.scan({ rescan: true }); netState.scannedAt = Date.now();
    return { networks: netState.networks, scannedAt: netState.scannedAt };
  } catch (e) { return { networks: netState.networks, scannedAt: netState.scannedAt, error: e.message }; }
});
ipcMain.handle('kiosk:wifi-connect', (_e, { ssid, password } = {}) => joinNetwork(String(ssid || '').trim(), String(password || ''), 'keyboard'));
ipcMain.handle('kiosk:wifi-hotspot', async (_e, { on } = {}) => {
  if (on) { if (netState.phase !== 'hotspot') await startHotspot('requested from the settings screen'); }
  else { await stopHotspot(); netState.noNetSince = Date.now(); }
  pushState();
  return netForPage();
});
ipcMain.handle('kiosk:wifi-forget', async (_e, { ssid } = {}) => { const ok = await network.forget(ssid); scheduleNet(1000); return { ok }; });

// ── IPC from recovery.html ───────────────────────────────────────────────────
ipcMain.handle('kiosk:get-state', () => stateForPage());

ipcMain.handle('kiosk:set-url', async (_e, { text, server } = {}) => {
  try {
    const current = kioskUrl ? parseKioskUrl(kioskUrl) : null;
    const url = normaliseKioskInput(text, server || (current && current.origin));
    const check = await checkKey(url);
    if (check.status === 'invalid') return { ok: false, error: 'The server rejected that key. Copy the URL again from FieldLink Admin → Kiosk → ⚙ Settings → Copy URL.' };
    // Offline/server errors: save anyway — the health loop will bring the page up when the server is reachable.
    const saved = saveConfig({ kioskUrl: url });
    kioskUrl = url; configSource = saved; invalidStreak = 0; keyInfo = check.info || null;
    log(`set-url: saved ${maskUrl(url)} to ${saved} (check=${check.status})`);
    showKiosk();
    scheduleCheck(5000);
    return { ok: true, saved, warning: check.status === 'ok' ? null : `Saved, but the server is not reachable right now (${check.error}). The kiosk will keep retrying.` };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('kiosk:retry', async () => {
  if (checkTimer) clearTimeout(checkTimer);
  invalidStreak = 0;
  if (pair && pair.status === 'error') startPairRequest(pair.origin);
  await runCheck();
  return stateForPage();
});

ipcMain.handle('kiosk:back', () => {
  if (kioskUrl) { showKiosk(); scheduleCheck(HEALTH_INTERVAL_MS); return { ok: true }; }
  return { ok: false, error: 'No kiosk URL configured yet.' };
});

ipcMain.handle('kiosk:quit', () => { app.quit(); });

// ── Kiosk-displayed pairing code ─────────────────────────────────────────────
// The setup/recovery screen asks the server for a short code and shows it; the
// admin types it into FieldLink Admin → Kiosk → 🔗 Link kiosk. We poll with the
// secret token until the admin has claimed the code, then save the URL the
// server hands back. No keyboard needed at the display.
const PAIR_POLL_MS = 3000;
let pair = null; // { origin, code, token, expiresAt, status: requesting|waiting|error, error, timer }

function stopPairRequest() {
  if (pair && pair.timer) clearTimeout(pair.timer);
  pair = null;
}

async function startPairRequest(serverText) {
  stopPairRequest();
  let origin;
  try {
    const current = kioskUrl ? parseKioskUrl(kioskUrl) : null;
    origin = normaliseOrigin(serverText || (current && current.origin) || DEFAULT_SERVER);
  } catch (e) {
    pair = { status: 'error', error: e.message || String(e), origin: null, code: null, token: null, expiresAt: null, timer: null };
    pushState();
    return;
  }
  const mine = { origin, status: 'requesting', code: null, token: null, expiresAt: null, error: null, timer: null };
  pair = mine;
  pushState();
  try {
    const r = await fetchJson(`${origin}/api/kiosk/pair/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname: os.hostname(), app_version: `pi ${APP_VERSION}` }),
    });
    if (pair !== mine) return; // superseded by a newer request
    if (!r.ok || !r.body || !r.body.code || !r.body.token) {
      mine.status = 'error';
      mine.error = (r.body && r.body.error) || (r.status === 404
        ? 'This FieldLink server does not support on-screen pairing yet. Ask for a code in FieldLink Admin and type it below instead.'
        : `Server answered HTTP ${r.status}.`);
      log(`pair-request: failed ${r.status} ${mine.error}`);
      pushState();
      return;
    }
    mine.code = r.body.code;
    mine.token = r.body.token;
    mine.expiresAt = Date.parse(r.body.expires_at) || (Date.now() + 15 * 60 * 1000);
    mine.status = 'waiting';
    log(`pair-request: showing code ${mine.code} for ${origin}`);
    pushState();
    mine.timer = setTimeout(pollPairRequest, PAIR_POLL_MS);
  } catch (e) {
    if (pair !== mine) return;
    mine.status = 'error';
    mine.error = clockSynced()
      ? `Cannot reach ${origin} (${e && e.message ? e.message : e}).`
      : 'Waiting for the network and the clock to be set…';
    log(`pair-request: ${mine.error}`);
    pushState();
    // Retry on our own while the recovery screen is up; the health loop also retries.
    mine.timer = setTimeout(() => { if (pair === mine && view === 'recovery') startPairRequest(origin); }, backoffDelay(1));
  }
}

async function pollPairRequest() {
  if (!pair || pair.status !== 'waiting' || view !== 'recovery') return;
  const p = pair;
  try {
    const r = await fetchJson(`${p.origin}/api/kiosk/pair/poll`, { headers: { 'x-pair-token': p.token } });
    if (pair !== p) return;
    if (r.ok && r.body && r.body.status === 'linked' && r.body.url) {
      const parsed = parseKioskUrl(r.body.url);
      if (parsed && parsed.key) {
        const saved = saveConfig({ kioskUrl: parsed.url });
        keyInfo = r.body.key || null; kioskUrl = parsed.url; configSource = saved; invalidStreak = 0;
        log(`pair-request: linked as "${(r.body.key && r.body.key.name) || '?'}" — saved to ${saved}`);
        stopPairRequest();
        showKiosk();
        scheduleCheck(5000);
        return;
      }
    }
    const expired = r.status === 404 || r.status === 410 || (r.body && r.body.status === 'expired') || Date.now() > p.expiresAt;
    if (expired) {
      log('pair-request: code expired — requesting a new one');
      startPairRequest(p.origin);
      return;
    }
  } catch (e) { /* offline — keep polling */ }
  if (pair === p) p.timer = setTimeout(pollPairRequest, PAIR_POLL_MS);
}

ipcMain.handle('kiosk:pair-request', async (_e, { server } = {}) => { await startPairRequest(server); return stateForPage(); });

// ── Keyboard shortcuts and the corner-hold gesture ───────────────────────────
// The gesture itself is detected in preload.js (it needs the page's pointer
// events); it only ever asks for the same thing Ctrl+Shift+K does.
let smokeGestureSeen = false;
ipcMain.on('kiosk:gesture', (e, { name } = {}) => {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
  if (name !== 'corner-hold') return;
  if (SMOKE_TEST) { smokeGestureSeen = true; return; }
  toggleSettingsScreen('corner hold');
});

// Electron's globalShortcut is X11-only; under cage (Wayland) the window itself
// is the only thing with focus, so the shortcuts come through before-input-event.
function toggleSettingsScreen(source) {
  log(`settings screen toggled (${source})`);
  if (view === 'recovery' && recoveryReason === 'manual') { if (kioskUrl) showKiosk(); }
  else showRecovery('manual');
}

function handleShortcut(input) {
  if (input.type !== 'keyDown' || !input.control || !input.shift || input.alt || input.meta) return false;
  const key = String(input.key || '').toUpperCase();
  if (key === 'K') { toggleSettingsScreen('Ctrl+Shift+K'); return true; }
  if (key === 'R') {
    if (kioskUrl) { invalidStreak = 0; showKiosk(); scheduleCheck(5000); }
    else if (win && !win.isDestroyed()) win.webContents.reload();
    return true;
  }
  if (key === 'Q') { log('quit requested from the keyboard'); app.quit(); return true; }
  return false;
}

// ── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1920,
    height: 1080,
    fullscreen: true,
    kiosk: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      additionalArguments: [`--flk-version=${APP_VERSION}`],
    },
  });

  win.webContents.on('before-input-event', (e, input) => { if (handleShortcut(input)) e.preventDefault(); });

  // Stay on the kiosk's own server (or our local recovery page).
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    const p = kioskUrl ? parseKioskUrl(kioskUrl) : null;
    if (!p || !url.startsWith(p.origin)) { log(`blocked navigation to ${url}`); e.preventDefault(); }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Network down at boot, DNS failure, connection refused…
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED: we navigated away */) return;
    log(`page: failed to load ${maskUrl(url)} (${code} ${desc})`);
    if (view === 'kiosk') {
      pageFailed = true;
      offlineStreak = Math.max(offlineStreak, 1);
      showRecovery('offline');
      scheduleCheck(RETRY_STEPS_MS[0]);
    }
  });

  // A maintenance page or gateway error (502/503) "loads" fine as far as
  // Chromium is concerned. Remember that so the health loop reloads once the
  // server is healthy again — but leave the server's own page on screen.
  win.webContents.on('did-navigate', (_e, url, httpCode) => {
    if (view !== 'kiosk' || !url.startsWith('http')) return;
    if (httpCode >= 400) { pageFailed = true; log(`page: HTTP ${httpCode} for ${maskUrl(url)}`); scheduleCheck(RETRY_STEPS_MS[0]); }
    else pageFailed = false;
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    log(`page: renderer gone (${details.reason}) — reloading in 2s`);
    setTimeout(() => { if (view === 'kiosk') showKiosk(); else if (win && !win.isDestroyed()) win.webContents.reload(); }, 2000);
  });
  win.webContents.on('unresponsive', () => {
    log('page: unresponsive — reloading in 10s unless it recovers');
    setTimeout(() => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.reload(); }, 10000);
  });
  win.webContents.on('console-message', (details) => {
    if (details && typeof details === 'object' && (details.level === 'error' || details.level === 'warning')) log(`page console: ${details.message}`);
  });

  win.on('closed', () => { win = null; });
}

// CI proof that the packaged build starts on this architecture: open the
// window, load the recovery screen once, exit 0. Anything else exits 1.
function runSmokeTest() {
  const timer = setTimeout(() => { console.error('smoke-test: timed out'); app.exit(1); }, 60000);
  createWindow();
  win.webContents.once('did-finish-load', async () => {
    try {
      const r = await win.webContents.executeJavaScript('document.getElementById("pair-code") ? "ok" : "missing"');
      console.log(`smoke-test: recovery screen loaded (${r}) — electron ${process.versions.electron}, ${process.arch}`);
      if (r !== 'ok') { clearTimeout(timer); return app.exit(1); }
      // The corner-hold gesture, end to end: a synthetic pointer-down in the
      // corner must reach preload.js and, four seconds later, this process.
      await win.webContents.executeJavaScript("window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 10, pointerId: 1, isPrimary: true, bubbles: true }))");
      const deadline = Date.now() + 6500;
      while (!smokeGestureSeen && Date.now() < deadline) await new Promise(res => setTimeout(res, 100));
      clearTimeout(timer);
      console.log(`smoke-test: corner-hold gesture ${smokeGestureSeen ? 'received' : 'NOT received'}`);
      app.exit(smokeGestureSeen ? 0 : 1);
    } catch (e) { clearTimeout(timer); console.error(`smoke-test: ${e.message}`); app.exit(1); }
  });
  win.webContents.once('did-fail-load', (_e, code, desc) => { console.error(`smoke-test: failed to load (${code} ${desc})`); app.exit(1); });
  view = 'recovery'; recoveryReason = 'no-config';
  win.loadFile(path.join(__dirname, 'recovery.html'), { query: { reason: 'no-config', smoke: '1' } });
}

app.whenReady().then(() => {
  if (SMOKE_TEST) return runSmokeTest();

  trimLog();
  log(`FieldLinkPiKiosk ${APP_VERSION} starting (electron ${process.versions.electron}, ${process.arch}, ${os.hostname()}, state ${app.getPath('userData')})`);

  try { powerSaveBlocker.start('prevent-display-sleep'); } catch {}

  createWindow();
  applyConfig();
  watchConfigDirs();
  noteCompletedUpdate();

  if (kioskUrl) showKiosk(); else showRecovery('no-config');
  scheduleCheck(kioskUrl ? 5000 : HEALTH_INTERVAL_MS);
  scheduleNet(3000);
});

// Only one kiosk window at a time.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { if (checkTimer) clearTimeout(checkTimer); if (netTimer) clearTimeout(netTimer); stopPairRequest(); if (setupServer) setupServer.stop(); });

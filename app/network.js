// Wi-Fi and Ethernet through NetworkManager's nmcli, as the unprivileged
// kiosk user (a polkit rule in the .deb allows it). No Electron dependency so
// the parsers can be unit-tested with plain node.
//
// The Pi's radio cannot run a hotspot and scan or join at the same time, so
// the flow is: scan → cache the list → hotspot up → phone picks a network from
// the cached list → hotspot down → join. main.js drives that; this module only
// knows how to talk to NetworkManager.

const { execFile } = require('child_process');
const crypto = require('crypto');

const HOTSPOT_CON  = 'FieldLink-Setup';       // NetworkManager profile name
const HOTSPOT_ADDR = '10.42.0.1';             // the Pi's address on the setup network
const HOTSPOT_CIDR = `${HOTSPOT_ADDR}/24`;
const NMCLI_TIMEOUT_MS = 25 * 1000;
const CONNECT_TIMEOUT_S = 45;

// ── nmcli plumbing ───────────────────────────────────────────────────────────
class NmError extends Error {
  constructor(message, { code, stderr, stdout } = {}) { super(message); this.name = 'NmError'; this.code = code; this.stderr = stderr; this.stdout = stdout; }
}

function exec(bin, args, timeoutMs) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: timeoutMs || NMCLI_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        const extra = err && typeof err.code !== 'number' ? String(err.message || err) : '';
        resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') + (extra ? `\n${extra}` : '') });
      });
  });
}

// nmcli in terse mode; throws NmError with nmcli's own message on failure.
async function nmcli(args, { timeoutMs, terse = true } = {}) {
  const r = await exec('nmcli', terse ? ['--terse', '--colors', 'no', ...args] : ['--colors', 'no', ...args], timeoutMs);
  if (r.code !== 0) throw new NmError((r.stderr || r.stdout || `nmcli exited ${r.code}`).trim(), r);
  return r.stdout;
}

// Is nmcli usable? Resolves true (remembered), or throws: err.permanent when
// nmcli is not installed at all, otherwise a transient problem worth retrying
// (a Pi 4 at cold boot, with Chromium starting and the SD card busy, can take
// well over five seconds just to load nmcli's libraries).
let _available = false;
async function available() {
  if (_available) return true;
  const r = await exec('nmcli', ['--version'], 30 * 1000);
  if (r.code === 0) { _available = true; return true; }
  const err = new NmError((r.stderr || r.stdout || `nmcli exited ${r.code}`).trim(), r);
  err.permanent = /ENOENT|not found/i.test(err.message);
  throw err;
}

// ── Parsers (pure; unit-tested) ──────────────────────────────────────────────
// nmcli --terse escapes ':' inside values as '\:' and '\' as '\\'.
function splitTerse(line) {
  const out = []; let cur = ''; let esc = false;
  for (const ch of line) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === ':') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseDevices(text) {
  return String(text || '').split('\n').filter(Boolean).map(l => {
    const [device, type, state, connection] = splitTerse(l);
    return { device, type, state: state || '', connection: connection || '' };
  });
}

// `dev show`: "IP4.ADDRESS[1]:192.168.1.20/24" lines → first IPv4 without prefix.
function parseIp4(text) {
  for (const l of String(text || '').split('\n')) {
    const [k, v] = splitTerse(l);
    if (/^IP4\.ADDRESS\[\d+\]$/.test(k || '') && v) return v.split('/')[0];
  }
  return null;
}

function parseField(text, key) {
  for (const l of String(text || '').split('\n')) {
    const [k, ...rest] = splitTerse(l);
    if (k === key) return rest.join(':');
  }
  return null;
}

// `dev wifi list` with -f SSID,SIGNAL,SECURITY,FREQ,IN-USE → deduped, strongest first.
function parseScan(text) {
  const best = new Map();
  for (const l of String(text || '').split('\n')) {
    if (!l) continue;
    const [ssid, signal, security, freq, inUse] = splitTerse(l);
    if (!ssid) continue; // hidden networks
    const entry = { ssid, signal: parseInt(signal, 10) || 0, security: (security || '').trim(), freq: parseInt(freq, 10) || 0, inUse: (inUse || '').trim() === '*' };
    entry.secured = !!entry.security && entry.security !== '--';
    entry.band = entry.freq >= 5000 ? '5' : entry.freq > 0 ? '2.4' : '';
    const prev = best.get(ssid);
    if (!prev || entry.signal > prev.signal || (entry.inUse && !prev.inUse)) best.set(ssid, { ...entry, inUse: entry.inUse || (prev ? prev.inUse : false) });
  }
  return [...best.values()].sort((a, b) => b.signal - a.signal);
}

// `con show` with -f NAME,TYPE → saved Wi-Fi profile names (excluding our hotspot).
function parseSavedWifi(text) {
  return String(text || '').split('\n').filter(Boolean).map(splitTerse)
    .filter(([name, type]) => type === '802-11-wireless' && name && name !== HOTSPOT_CON)
    .map(([name]) => name);
}

// Friendly text for nmcli's activation errors.
function friendlyConnectError(msg) {
  const m = String(msg || '');
  if (/Secrets were required|802-1X supplicant|wpa_supplicant.*(fail|timeout)|password/i.test(m)) return 'The password was not accepted.';
  if (/No network with SSID|not found|No suitable device/i.test(m)) return 'That network is not in range.';
  if (/timed? ?out|Timeout/i.test(m)) return 'The network did not answer in time.';
  if (/IP configuration could not be reserved|dhcp/i.test(m)) return 'Joined, but the network gave no address (DHCP).';
  const line = m.split('\n').find(l => l.trim()) || 'Unknown error.';
  return line.replace(/^Error:\s*/i, '').trim();
}

// WIFI: QR payload (the format phone cameras understand). Backslash, semicolon,
// comma, colon and double quote are escaped with a backslash. The backslash is
// spelled out with fromCharCode so no build step or editor can eat it.
const BACKSLASH = String.fromCharCode(92);
const QR_SPECIALS = new RegExp('[' + BACKSLASH + BACKSLASH + ';,:"]', 'g');
function qrWifi(ssid, password) {
  const esc = s => String(s).replace(QR_SPECIALS, c => BACKSLASH + c);
  return password ? `WIFI:T:WPA;S:${esc(ssid)};P:${esc(password)};;` : `WIFI:T:nopass;S:${esc(ssid)};;`;
}

// Unambiguous characters only: this is read off a TV and typed on a phone.
function randomPassword(len = 10) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function hotspotName(hwaddr, machineId) {
  const mac = String(hwaddr || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  const tail = mac.length >= 4 ? mac.slice(-4) : String(machineId || '').replace(/[^0-9a-f]/gi, '').toUpperCase().slice(-4) || 'KIOSK';
  return `FieldLink-${tail}`;
}

// ── Queries ──────────────────────────────────────────────────────────────────
async function devices() { return parseDevices(await nmcli(['-f', 'DEVICE,TYPE,STATE,CONNECTION', 'dev', 'status'])); }

async function ip4Of(device) {
  try { return parseIp4(await nmcli(['-f', 'IP4.ADDRESS', 'dev', 'show', device])); } catch { return null; }
}

async function ssidOfConnection(name) {
  try { return parseField(await nmcli(['-f', '802-11-wireless.ssid', 'con', 'show', name]), '802-11-wireless.ssid'); } catch { return null; }
}

let hotspot = null; // { ssid, password, device } once created this boot

// Everything the screen and the state machine need, in one call.
async function status() {
  const devs = await devices();
  const eth = devs.find(d => d.type === 'ethernet') || null;
  const wifi = devs.find(d => d.type === 'wifi') || null;
  const out = {
    eth:  eth  ? { device: eth.device,  state: eth.state,  connection: eth.connection,  ip: null, carrier: eth.state !== 'unavailable' && eth.state !== 'unmanaged' } : null,
    wifi: wifi ? { device: wifi.device, state: wifi.state, connection: wifi.connection, ip: null, ssid: null, radio: null } : null,
    hotspot: { active: false, ssid: hotspot ? hotspot.ssid : null, password: hotspot ? hotspot.password : null, ip: HOTSPOT_ADDR },
    saved: [],
    online: false,
  };
  if (eth && /^connected/.test(eth.state)) out.eth.ip = await ip4Of(eth.device);
  if (wifi) {
    out.hotspot.active = wifi.connection === HOTSPOT_CON;
    if (/^connected/.test(wifi.state) && !out.hotspot.active) {
      out.wifi.ip = await ip4Of(wifi.device);
      out.wifi.ssid = await ssidOfConnection(wifi.connection);
    }
    try { out.wifi.radio = (await nmcli(['-f', 'WIFI', 'radio'])).trim(); } catch {}
  }
  try { out.saved = parseSavedWifi(await nmcli(['-f', 'NAME,TYPE', 'con', 'show'])); } catch {}
  out.online = !!(out.eth && out.eth.ip) || !!(out.wifi && out.wifi.ip && !out.hotspot.active);
  return out;
}

async function wifiDevice() {
  const d = (await devices()).find(x => x.type === 'wifi');
  return d ? d.device : null;
}

async function radioOn() { await nmcli(['radio', 'wifi', 'on']); }

// Scan for networks. Not possible while the hotspot is up (same radio), so
// callers cache the result before starting it.
async function scan({ rescan = true } = {}) {
  const dev = await wifiDevice();
  if (!dev) throw new NmError('This device has no Wi-Fi adapter.');
  const args = ['-f', 'SSID,SIGNAL,SECURITY,FREQ,IN-USE', 'dev', 'wifi', 'list', 'ifname', dev, '--rescan', rescan ? 'yes' : 'no'];
  return parseScan(await nmcli(args, { timeoutMs: 40 * 1000 }));
}

async function deleteConnection(name) {
  try { await nmcli(['con', 'delete', name]); return true; } catch { return false; }
}

// Join a network. Creates an autoconnect profile named after the SSID so the
// Pi rejoins by itself after a power cut. A failed attempt leaves nothing
// behind (NetworkManager would otherwise retry a wrong password forever).
async function connect(ssid, password, { hidden = false } = {}) {
  const dev = await wifiDevice();
  if (!dev) return { ok: false, error: 'This device has no Wi-Fi adapter.' };
  const name = String(ssid);
  await deleteConnection(name);
  const args = ['-w', String(CONNECT_TIMEOUT_S), 'dev', 'wifi', 'connect', name, 'ifname', dev, 'name', name];
  if (password) args.push('password', String(password));
  if (hidden) args.push('hidden', 'yes');
  try {
    await nmcli(args, { timeoutMs: (CONNECT_TIMEOUT_S + 15) * 1000, terse: false });
    return { ok: true, ssid: name, ip: await ip4Of(dev) };
  } catch (e) {
    await deleteConnection(name);
    return { ok: false, ssid: name, error: friendlyConnectError(e.message), detail: e.message };
  }
}

async function forget(ssid) { return deleteConnection(String(ssid)); }
async function forgetAll() {
  const saved = parseSavedWifi(await nmcli(['-f', 'NAME,TYPE', 'con', 'show']));
  for (const name of saved) await deleteConnection(name);
  return saved;
}

// WPA2 (RSN/CCMP only: some phones refuse WPA1/TKIP) access point on 2.4 GHz
// (every phone can see it), fixed address so the setup page URL and the
// captive-portal DNS entry are constants.
async function hotspotUp() {
  const dev = await wifiDevice();
  if (!dev) throw new NmError('This device has no Wi-Fi adapter.');
  if (!hotspot) {
    let hw = null;
    try { hw = parseField(await nmcli(['-f', 'GENERAL.HWADDR', 'dev', 'show', dev]), 'GENERAL.HWADDR'); } catch {}
    let mid = null;
    try { mid = require('fs').readFileSync('/etc/machine-id', 'utf8'); } catch {}
    hotspot = { ssid: hotspotName(hw, mid), password: randomPassword(10), device: dev };
  }
  await deleteConnection(HOTSPOT_CON);
  await nmcli(['con', 'add', 'type', 'wifi', 'ifname', dev, 'con-name', HOTSPOT_CON, 'autoconnect', 'no',
    'ssid', hotspot.ssid,
    '802-11-wireless.mode', 'ap', '802-11-wireless.band', 'bg',
    'ipv4.method', 'shared', 'ipv4.addresses', HOTSPOT_CIDR, 'ipv6.method', 'disabled',
    'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.proto', 'rsn', 'wifi-sec.pairwise', 'ccmp', 'wifi-sec.group', 'ccmp',
    'wifi-sec.psk', hotspot.password], { terse: false });
  await nmcli(['-w', '30', 'con', 'up', HOTSPOT_CON], { timeoutMs: 45 * 1000, terse: false });
  return { ssid: hotspot.ssid, password: hotspot.password, ip: HOTSPOT_ADDR, qr: qrWifi(hotspot.ssid, hotspot.password) };
}

async function hotspotDown() {
  try { await nmcli(['con', 'down', HOTSPOT_CON], { terse: false }); } catch {}
  await deleteConnection(HOTSPOT_CON);
}

module.exports = {
  HOTSPOT_CON, HOTSPOT_ADDR, HOTSPOT_CIDR, NmError,
  available, status, scan, connect, forget, forgetAll, hotspotUp, hotspotDown, radioOn, wifiDevice,
  // exported for tests
  _parsers: { splitTerse, parseDevices, parseIp4, parseField, parseScan, parseSavedWifi, friendlyConnectError, qrWifi, randomPassword, hotspotName },
};

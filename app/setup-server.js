// The phone-side setup page, served by the app itself while the hotspot is up.
//
// A phone that joins the FieldLink-XXXX network gets 10.42.0.1 as its DNS
// server and every name resolves to the Pi (dnsmasq-shared.d entry in the
// .deb). The phone's captive-portal probe therefore lands here; anything that
// is not one of our pages is answered with a redirect to the setup page, which
// is what makes iOS and Android pop the "sign in to network" sheet by
// themselves. No dependency on Electron: it is exercised by node --test.
//
// backend interface (implemented in main.js):
//   getNetworks()            → { networks: [{ssid, signal, secured, band}], scannedAt }
//   getStatus()              → { phase, ssid, error, hotspot: {ssid} }
//   connect(ssid, password)  → Promise<void>  (starts the join; the page never waits for it)
//   touch()                  → called on every page hit (keeps the hotspot alive)

const http = require('http');
const { HOTSPOT_ADDR } = require('./network');

const MAX_BODY = 4096;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function page(status) {
  const hs = (status && status.hotspot && status.hotspot.ssid) || 'FieldLink';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>FieldLink display setup</title>
<style>
  :root { --bg:#0a0f1a; --panel:#111827; --border:#1f2a3d; --text:#e7ecf5; --muted:#8b97ad; --gold:#e8b84b; --ok:#4ade80; --bad:#f87171; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--text); font:17px/1.45 -apple-system,Roboto,"Segoe UI",sans-serif; }
  .wrap { max-width:520px; margin:0 auto; padding:20px 16px 40px; }
  .brand { color:var(--muted); font-size:.78rem; letter-spacing:.06em; text-transform:uppercase; margin-bottom:8px; }
  h1 { font-size:1.4rem; margin:0 0 6px; } p { color:var(--muted); margin:0 0 14px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:16px; padding:14px 16px; margin-top:12px; }
  ul { list-style:none; margin:0; padding:0; } li { display:flex; align-items:center; gap:12px; padding:13px 6px; border-top:1px solid var(--border); cursor:pointer; }
  li:first-child { border-top:0; } li .n { flex:1; font-weight:600; word-break:break-all; } li .m { color:var(--muted); font-size:.85rem; white-space:nowrap; }
  li.sel { color:var(--gold); }
  .bars { width:18px; height:14px; display:inline-flex; align-items:flex-end; gap:2px; } .bars i { flex:1; background:#334155; border-radius:1px; } .bars i.on { background:var(--gold); }
  input { width:100%; font:inherit; padding:12px 14px; border-radius:12px; border:1px solid var(--border); background:#0b1220; color:var(--text); margin:6px 0 10px; }
  button { width:100%; font:inherit; font-weight:700; padding:14px; border-radius:12px; border:0; background:var(--gold); color:#1a1405; }
  button.secondary { background:transparent; color:var(--muted); border:1px solid var(--border); margin-top:8px; }
  button:disabled { opacity:.5; }
  .msg { margin-top:10px; min-height:1.3em; } .msg.bad { color:var(--bad); } .msg.ok { color:var(--ok); }
  .hidden { display:none !important; } label { display:block; font-size:.78rem; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
  .small { font-size:.85rem; color:var(--muted); }
</style></head><body><div class="wrap">
  <div class="brand">FieldLink Missions · Display setup</div>
  <h1>Connect the display to Wi‑Fi</h1>
  <p>You are on the display's setup network <strong>${esc(hs)}</strong>. Pick the church's Wi‑Fi below and enter its password. The display joins it and shows a pairing code on the TV.</p>

  <div id="list" class="card">
    <label>Networks the display can see</label>
    <ul id="networks"><li class="small">Loading…</li></ul>
    <button id="other" class="secondary" type="button">Other network…</button>
    <button id="rescan" class="secondary" type="button">Refresh list</button>
  </div>

  <form id="form" class="card hidden" autocomplete="off">
    <label>Network</label>
    <input id="ssid" type="text" maxlength="32" placeholder="Network name" autocapitalize="none" autocorrect="off">
    <label>Password</label>
    <input id="pass" type="password" maxlength="63" placeholder="Wi‑Fi password" autocapitalize="none" autocorrect="off">
    <button id="go" type="submit">Connect the display</button>
    <button id="back" class="secondary" type="button">Back to the list</button>
    <div id="msg" class="msg"></div>
  </form>

  <div id="done" class="card hidden">
    <h1 id="done-h">Connecting…</h1>
    <p id="done-p"></p>
    <div id="done-msg" class="msg"></div>
  </div>
  <p class="small" style="margin-top:16px">This page is only reachable from the display's own setup network and disappears once the display is online.</p>
</div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var selected = null, secured = true, submitted = false;
  function bars(sig) { var n = sig >= 75 ? 4 : sig >= 55 ? 3 : sig >= 35 ? 2 : 1, h = '<span class="bars">'; for (var i = 1; i <= 4; i++) h += '<i class="' + (i <= n ? 'on' : '') + '" style="height:' + (i * 25) + '%"></i>'; return h + '</span>'; }
  function render(list) {
    var ul = $('networks'); ul.innerHTML = '';
    if (!list.length) { ul.innerHTML = '<li class="small">No networks seen yet. Tap Refresh list, or use Other network.</li>'; return; }
    list.forEach(function (n) {
      var li = document.createElement('li');
      li.innerHTML = bars(n.signal) + '<span class="n"></span><span class="m">' + (n.secured ? '🔒' : 'open') + (n.band ? ' · ' + n.band + ' GHz' : '') + '</span>';
      li.querySelector('.n').textContent = n.ssid;
      li.addEventListener('click', function () { pick(n.ssid, n.secured); });
      ul.appendChild(li);
    });
  }
  function pick(ssid, sec) {
    selected = ssid; secured = sec !== false;
    $('ssid').value = ssid || ''; $('ssid').readOnly = !!ssid; $('pass').value = '';
    $('pass').placeholder = secured ? 'Wi‑Fi password' : 'No password needed';
    $('list').classList.add('hidden'); $('form').classList.remove('hidden'); $('msg').textContent = '';
    (ssid ? $('pass') : $('ssid')).focus();
  }
  function load() {
    $('networks').innerHTML = '<li class="small">Loading…</li>';
    fetch('/api/networks', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { render(j.networks || []); })
      .catch(function () { $('networks').innerHTML = '<li class="small">Could not load the list. Are you still on the setup network?</li>'; });
  }
  $('other').addEventListener('click', function () { pick('', true); });
  $('rescan').addEventListener('click', load);
  $('back').addEventListener('click', function () { $('form').classList.add('hidden'); $('list').classList.remove('hidden'); });
  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (submitted) return;
    var ssid = $('ssid').value.trim(), pass = $('pass').value;
    if (!ssid) { $('msg').textContent = 'Enter the network name.'; $('msg').className = 'msg bad'; return; }
    if (secured && pass.length < 8) { $('msg').textContent = 'Wi‑Fi passwords are at least 8 characters.'; $('msg').className = 'msg bad'; return; }
    submitted = true; $('go').disabled = true; $('msg').textContent = 'Sending to the display…'; $('msg').className = 'msg';
    fetch('/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ssid: ssid, password: pass }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { submitted = false; $('go').disabled = false; $('msg').textContent = (x.j && x.j.error) || 'That did not work.'; $('msg').className = 'msg bad'; return; }
        $('form').classList.add('hidden'); $('done').classList.remove('hidden');
        $('done-h').textContent = 'Connecting the display to ' + ssid + '…';
        $('done-p').textContent = 'The setup network switches off now, so this phone will drop off it in a moment. Look at the TV: it shows a pairing code within about a minute. If the password was wrong, the setup network comes back and you can try again from here.';
        poll();
      })
      .catch(function () { submitted = false; $('go').disabled = false; $('msg').textContent = 'Could not reach the display.'; $('msg').className = 'msg bad'; });
  });
  function poll() {
    fetch('/api/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
      if (s.phase === 'failed') { $('done-h').textContent = 'Could not join ' + (s.ssid || 'the network'); $('done-msg').textContent = (s.error || '') + ' Tap below to try again.'; $('done-msg').className = 'msg bad'; $('done-p').innerHTML = '<button type="button" onclick="location.reload()">Try again</button>'; return; }
      if (s.phase === 'connected') { $('done-h').textContent = 'Connected'; $('done-msg').textContent = 'The display is online. Look at the TV for the pairing code.'; $('done-msg').className = 'msg ok'; return; }
      setTimeout(poll, 2000);
    }).catch(function () { setTimeout(poll, 3000); });
  }
  load();
})();
</script></body></html>`;
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let body = ''; let over = false;
    req.on('data', chunk => { body += chunk; if (body.length > limit) { over = true; req.destroy(); } });
    req.on('end', () => { if (over) return reject(new Error('body too large')); try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

function validate(ssid, password) {
  if (typeof ssid !== 'string' || !ssid.trim()) return 'Enter the network name.';
  if (Buffer.byteLength(ssid, 'utf8') > 32) return 'Network names are at most 32 characters.';
  if (password != null && typeof password !== 'string') return 'Invalid password.';
  if (password && (password.length < 8 || password.length > 63)) return 'Wi-Fi passwords are 8 to 63 characters.';
  return null;
}

function createSetupServer({ backend, log = () => {} }) {
  let server = null; let connecting = false;
  const setupUrl = `http://${HOTSPOT_ADDR}/`;

  async function handle(req, res) {
    const url = new URL(req.url, setupUrl);
    const path = url.pathname;
    const send = (code, body, type = 'text/html; charset=utf-8', headers = {}) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...headers });
      res.end(body);
    };
    const json = (code, obj) => send(code, JSON.stringify(obj), 'application/json; charset=utf-8');
    try { backend.touch && backend.touch(); } catch {}

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) return send(200, page(await backend.getStatus()));
    if (req.method === 'GET' && path === '/api/networks') return json(200, await backend.getNetworks());
    if (req.method === 'GET' && path === '/api/status') return json(200, await backend.getStatus());
    if (req.method === 'POST' && path === '/api/connect') {
      let body;
      try { body = await readJson(req, MAX_BODY); } catch (e) { return json(400, { ok: false, error: e.message }); }
      const err = validate(body.ssid, body.password);
      if (err) return json(400, { ok: false, error: err });
      if (connecting) return json(409, { ok: false, error: 'The display is already connecting. Wait a moment.' });
      connecting = true;
      log(`setup-server: connect requested for "${body.ssid}"`);
      // Answer first so the phone sees the confirmation before the hotspot drops.
      json(200, { ok: true });
      Promise.resolve().then(() => backend.connect(String(body.ssid).trim(), body.password || '')).catch(e => log(`setup-server: connect failed: ${e && e.message || e}`)).finally(() => { connecting = false; });
      return;
    }
    // Captive-portal probes (Android generate_204, Apple hotspot-detect,
    // Windows connecttest, Firefox canonical.html…) and anything else.
    if (req.method === 'GET' || req.method === 'HEAD') return send(302, `<a href="${setupUrl}">FieldLink display setup</a>`, 'text/html; charset=utf-8', { Location: setupUrl });
    return send(405, 'Method not allowed', 'text/plain');
  }

  return {
    url: setupUrl,
    start(port = 80, host = HOTSPOT_ADDR) {
      return new Promise((resolve, reject) => {
        if (server) return resolve(server.address());
        server = http.createServer((req, res) => { handle(req, res).catch(e => { log(`setup-server: ${e && e.stack || e}`); try { res.writeHead(500); res.end('error'); } catch {} }); });
        server.keepAliveTimeout = 5000;
        server.once('error', e => { server = null; reject(e); });
        server.listen(port, host, () => { log(`setup-server: listening on http://${host}:${port}/`); resolve(server.address()); });
      });
    },
    stop() {
      return new Promise(resolve => {
        if (!server) return resolve();
        const s = server; server = null;
        s.closeAllConnections && s.closeAllConnections();
        s.close(() => { log('setup-server: stopped'); resolve(); });
      });
    },
    get running() { return !!server; },
  };
}

module.exports = { createSetupServer, page, validate };

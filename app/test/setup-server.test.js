const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createSetupServer, validate } = require('../setup-server');

function fakeBackend() {
  const calls = [];
  return {
    calls,
    async getNetworks() { return { networks: [{ ssid: 'ChurchWifi', signal: 80, secured: true, band: '2.4' }, { ssid: 'Guest', signal: 50, secured: false, band: '5' }], scannedAt: 1 }; },
    async getStatus() { return { phase: 'hotspot', hotspot: { ssid: 'FieldLink-4F2A' } }; },
    async connect(ssid, password) { calls.push({ ssid, password }); },
    touch() { calls.push('touch'); },
  };
}

function request(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withServer(fn) {
  const backend = fakeBackend();
  const srv = createSetupServer({ backend });
  const addr = await srv.start(0, '127.0.0.1');
  try { await fn(addr.port, backend, srv); } finally { await srv.stop(); }
}

test('serves the setup page with the hotspot name', () => withServer(async port => {
  const r = await request(port, 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.body, /FieldLink-4F2A/);
  assert.match(r.body, /Connect the display to Wi/);
}));

test('lists networks as JSON', () => withServer(async port => {
  const r = await request(port, 'GET', '/api/networks');
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.networks[0].ssid, 'ChurchWifi');
}));

test('answers captive-portal probes with a redirect to the setup page', () => withServer(async port => {
  for (const p of ['/generate_204', '/hotspot-detect.html', '/connecttest.txt', '/canonical.html', '/anything/else']) {
    const r = await request(port, 'GET', p);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.location, 'http://10.42.0.1/');
  }
}));

test('starts a connection and answers before it finishes', () => withServer(async (port, backend) => {
  const r = await request(port, 'POST', '/api/connect', JSON.stringify({ ssid: 'ChurchWifi', password: 'correct horse' }));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(backend.calls.filter(c => c !== 'touch'), [{ ssid: 'ChurchWifi', password: 'correct horse' }]);
}));

test('rejects bad input', () => withServer(async (port, backend) => {
  let r = await request(port, 'POST', '/api/connect', JSON.stringify({ ssid: '', password: 'x' }));
  assert.equal(r.status, 400);
  r = await request(port, 'POST', '/api/connect', JSON.stringify({ ssid: 'X', password: 'short' }));
  assert.equal(r.status, 400);
  r = await request(port, 'POST', '/api/connect', '{not json');
  assert.equal(r.status, 400);
  r = await request(port, 'POST', '/api/connect', JSON.stringify({ ssid: 'a'.repeat(33), password: '' }));
  assert.equal(r.status, 400);
  assert.equal(backend.calls.filter(c => c !== 'touch').length, 0);
}));

test('validate accepts open networks and 8-63 char passwords', () => {
  assert.equal(validate('Guest', ''), null);
  assert.equal(validate('Guest', 'abcdefgh'), null);
  assert.match(validate('Guest', 'abc'), /8 to 63/);
  assert.match(validate('', 'abcdefgh'), /network name/);
});

test('stop closes the listener', async () => {
  const srv = createSetupServer({ backend: fakeBackend() });
  const addr = await srv.start(0, '127.0.0.1');
  assert.equal(srv.running, true);
  await srv.stop();
  assert.equal(srv.running, false);
  await assert.rejects(request(addr.port, 'GET', '/'));
});

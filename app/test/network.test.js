const test = require('node:test');
const assert = require('node:assert/strict');
const { _parsers: p, HOTSPOT_CON } = require('../network');

test('splitTerse honours escaped colons and backslashes', () => {
  assert.deepEqual(p.splitTerse('IP4.ADDRESS[1]:192.168.1.20/24'), ['IP4.ADDRESS[1]', '192.168.1.20/24']);
  assert.deepEqual(p.splitTerse('GENERAL.HWADDR:DC\\:A6\\:32\\:12\\:4F\\:2A'), ['GENERAL.HWADDR', 'DC:A6:32:12:4F:2A']);
  assert.deepEqual(p.splitTerse('a\\\\b:c'), ['a\\b', 'c']);
});

test('parseDevices reads dev status', () => {
  const out = p.parseDevices('eth0:ethernet:connected:Wired connection 1\nwlan0:wifi:disconnected:\nlo:loopback:unmanaged:\n');
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { device: 'eth0', type: 'ethernet', state: 'connected', connection: 'Wired connection 1' });
  assert.deepEqual(out[1], { device: 'wlan0', type: 'wifi', state: 'disconnected', connection: '' });
});

test('parseIp4 takes the first IPv4 address without its prefix', () => {
  assert.equal(p.parseIp4('IP4.ADDRESS[1]:10.0.0.5/24\nIP4.ADDRESS[2]:10.0.0.6/24\n'), '10.0.0.5');
  assert.equal(p.parseIp4('IP4.GATEWAY:10.0.0.1\n'), null);
  assert.equal(p.parseIp4(''), null);
});

test('parseScan dedupes by SSID, keeps the strongest, drops hidden networks, sorts', () => {
  const text = [
    'ChurchWifi:55:WPA2:5180: ',
    'ChurchWifi:80:WPA2:2437:*',
    ':40:WPA2:2412: ',
    'Guest:70::2462: ',
    'Neighbour:30:WPA1 WPA2:2417: ',
  ].join('\n');
  const out = p.parseScan(text);
  assert.deepEqual(out.map(n => n.ssid), ['ChurchWifi', 'Guest', 'Neighbour']);
  assert.equal(out[0].signal, 80);
  assert.equal(out[0].inUse, true);
  assert.equal(out[0].band, '2.4');
  assert.equal(out[1].secured, false);
  assert.equal(out[2].secured, true);
});

test('parseSavedWifi lists Wi-Fi profiles but never the hotspot', () => {
  const text = `Wired connection 1:802-3-ethernet\nChurchWifi:802-11-wireless\n${HOTSPOT_CON}:802-11-wireless\nlo:loopback\n`;
  assert.deepEqual(p.parseSavedWifi(text), ['ChurchWifi']);
});

test('friendlyConnectError maps nmcli messages', () => {
  assert.equal(p.friendlyConnectError('Error: Connection activation failed: (7) Secrets were required, but not provided.'), 'The password was not accepted.');
  assert.equal(p.friendlyConnectError('Error: No network with SSID \'Nope\' found.'), 'That network is not in range.');
  assert.equal(p.friendlyConnectError('Error: Timeout 45 sec expired.'), 'The network did not answer in time.');
  assert.equal(p.friendlyConnectError('Error: something odd'), 'something odd');
});

test('qrWifi escapes special characters', () => {
  const B = String.fromCharCode(92); // backslash
  assert.equal(p.qrWifi('FieldLink-4F2A', 'abc123'), 'WIFI:T:WPA;S:FieldLink-4F2A;P:abc123;;');
  const ssid = 'a;b:c', pass = 'p,q"r' + B + 's';
  const expected = 'WIFI:T:WPA;S:a' + B + ';b' + B + ':c;P:p' + B + ',q' + B + '"r' + B + B + 's;;';
  assert.equal(p.qrWifi(ssid, pass), expected);
  assert.equal(p.qrWifi('Open', ''), 'WIFI:T:nopass;S:Open;;');
});

test('randomPassword uses only unambiguous characters', () => {
  for (let i = 0; i < 50; i++) assert.match(p.randomPassword(10), /^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/);
});

test('hotspotName takes the last four MAC digits, falls back to machine-id', () => {
  assert.equal(p.hotspotName('DC:A6:32:12:4F:2A'), 'FieldLink-4F2A');
  assert.equal(p.hotspotName('', 'abcdef0123456789\n'), 'FieldLink-6789');
  assert.equal(p.hotspotName('', ''), 'FieldLink-KIOSK');
});

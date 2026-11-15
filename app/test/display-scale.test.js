const test = require('node:test');
const assert = require('node:assert/strict');
const { scaleFor, zoomFor, parseOverride } = require('../display-scale');

test('every common TV shows the 1080p layout', () => {
  assert.equal(scaleFor({ width: 1920, height: 1080 }), 1);
  assert.equal(scaleFor({ width: 3840, height: 2160 }), 2);
  assert.equal(scaleFor({ width: 2560, height: 1440 }), 1.35);   // 1.333 in 5 % steps
  assert.equal(scaleFor({ width: 1280, height: 720 }), 0.65);
  assert.equal(scaleFor({ width: 1366, height: 768 }), 0.7);
  assert.equal(scaleFor({ width: 7680, height: 4320 }), 4);
});

test('a portrait screen scales like its landscape twin, an ultrawide by its height', () => {
  assert.equal(scaleFor({ width: 2160, height: 3840 }), 2);
  assert.equal(scaleFor({ width: 1080, height: 1920 }), 1);
  assert.equal(scaleFor({ width: 2560, height: 1080 }), 1);
});

test('limits and unknown sizes', () => {
  assert.equal(scaleFor({ width: 640, height: 480 }), 0.5);
  assert.equal(scaleFor({ width: 20000, height: 10000 }), 4);
  assert.equal(scaleFor(null), 1);
  assert.equal(scaleFor({ width: 0, height: 0 }), 1);
});

test('config.displayScale pins the size; junk is ignored', () => {
  assert.equal(scaleFor({ width: 3840, height: 2160 }, 1.5), 1.5);
  assert.equal(scaleFor({ width: 3840, height: 2160 }, '2.5'), 2.5);
  assert.equal(scaleFor({ width: 3840, height: 2160 }, 99), 4);
  assert.equal(scaleFor({ width: 3840, height: 2160 }, 'auto'), 2);
  assert.equal(scaleFor({ width: 3840, height: 2160 }, 0), 2);
  assert.equal(parseOverride(undefined), null);
});

test('scaling the compositor already does is not applied twice', () => {
  assert.equal(zoomFor({ width: 3840, height: 2160 }, 1), 2);
  assert.equal(zoomFor({ width: 3840, height: 2160 }, 2), 1);
  assert.equal(zoomFor({ width: 1920, height: 1080 }, 1), 1);
});

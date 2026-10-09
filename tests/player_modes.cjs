const assert = require('node:assert/strict');
const { test } = require('node:test');
const { detectModes } = require('../src/ui/player.js');

test('EC-3 chooses MSE before PCM regardless of browser', () => {
  global.Worker = function Worker() {};
  global.AudioContext = function AudioContext() {};
  global.WebAssembly = WebAssembly;
  global.AmDecrypt = { supported: () => true };
  global.MediaSource = { isTypeSupported: () => true };
  global.navigator = { vendor: 'Google Inc.' };
  assert.deepEqual(detectModes('ec-3'), ['mse', 'ec3']);
  global.navigator.vendor = 'Apple Computer, Inc.';
  assert.deepEqual(detectModes('ec-3'), ['mse', 'ec3']);
});

test('EC-3 selects PCM when native playback is unavailable', () => {
  global.Worker = function Worker() {};
  global.AudioContext = function AudioContext() {};
  global.AmDecrypt = { supported: () => true };
  global.MediaSource = { isTypeSupported: () => false };
  assert.deepEqual(detectModes('ec-3'), ['ec3']);
});

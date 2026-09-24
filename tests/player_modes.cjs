const assert = require('node:assert/strict');
const { test } = require('node:test');
const { detectModes } = require('../src/ui/player.js');

const audio = {
  canPlayType(type) {
    return type === 'application/vnd.apple.mpegurl' || type === 'audio/mp4; codecs="ec-3"' ? 'maybe' : '';
  },
};

test('EC-3 chooses MSE before PCM regardless of browser or --hook', () => {
  global.Worker = function Worker() {};
  global.AudioContext = function AudioContext() {};
  global.WebAssembly = WebAssembly;
  global.AmDecrypt = { supported: () => true };
  global.MediaSource = { isTypeSupported: () => true };
  global.navigator = { vendor: 'Google Inc.' };
  assert.deepEqual(detectModes('ec-3', audio, true), ['mse', 'ec3']);
  assert.deepEqual(detectModes('ec-3', audio, false), ['mse', 'ec3']);
  global.navigator.vendor = 'Apple Computer, Inc.';
  assert.deepEqual(detectModes('ec-3', audio, true), ['mse', 'ec3']);
});

test('EC-3 selects PCM when native playback is unavailable', () => {
  global.Worker = function Worker() {};
  global.AudioContext = function AudioContext() {};
  global.AmDecrypt = { supported: () => true };
  global.MediaSource = { isTypeSupported: () => false };
  assert.deepEqual(detectModes('ec-3', audio, false), ['ec3']);
  assert.deepEqual(detectModes('ec-3', audio, true), ['ec3']);
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AmPlayer, detectModes, useJocSettings, sortVariants } = require('../src/ui/player.js');

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

test('JOC object rendering comes first for EC-3 when enabled: binaural, then Speaker 2.0, then the usual modes', () => {
  global.Worker = function Worker() {};
  global.AudioContext = function AudioContext() {};
  global.AmDecrypt = { supported: () => true };
  global.MediaSource = { isTypeSupported: () => true };
  let settings = { mode: 'binaural', gain: 0, dataset: 'D2' };
  useJocSettings({ get: () => settings, set: () => {} });
  try {
    assert.deepEqual(detectModes('ec-3'), ['jocbin', 'joc2', 'mse', 'ec3']);
    settings = { ...settings, mode: 'speaker' };
    assert.deepEqual(detectModes('ec-3'), ['joc2', 'mse', 'ec3']);
    // only E-AC-3 is affected
    assert.deepEqual(detectModes('alac'), ['mse', 'flac']);
    settings = { ...settings, mode: 'off' };
    assert.deepEqual(detectModes('ec-3'), ['mse', 'ec3']);
    // JOC needs the same Worker / WebAssembly / Web Audio support as the PCM fallback
    settings = { ...settings, mode: 'speaker' };
    global.AudioContext = undefined;
    assert.deepEqual(detectModes('ec-3'), ['mse']);
  } finally {
    useJocSettings(null);
  }
});

test('the queue prefers Dolby Atmos over ALAC only while JOC rendering is on', () => {
  const variants = [
    { group_id: 'audio-stereo-256', bandwidth: 256000 },
    { group_id: 'audio-atmos-2768', bandwidth: 768000 },
    { group_id: 'audio-alac-stereo-48000-24', bandwidth: 2000000 },
  ];
  const order = () => sortVariants(variants).map((v) => v.group_id.split('-')[1]);
  assert.deepEqual(order(), ['alac', 'atmos', 'stereo']);
  useJocSettings({ get: () => ({ mode: 'speaker', gain: 0, dataset: 'D2' }), set: () => {} });
  try {
    assert.deepEqual(order(), ['atmos', 'alac', 'stereo']);
  } finally {
    useJocSettings(null);
  }
});

test('the ALAC / AAC volume trim attenuates only the audio element and never EC-3 or the slider value', () => {
  const player = { volume: 0.8, audio: { volume: 1 }, pcm: null, current: { codecs: 'alac' } };
  const apply = () => AmPlayer.prototype.applyVolume.call(player);
  useJocSettings({ get: () => ({ mode: 'binaural', gain: 0, dataset: 'D2', stereoGain: -6 }), set: () => {} });
  try {
    apply();
    assert.ok(Math.abs(player.audio.volume - 0.8 * 10 ** (-6 / 20)) < 1e-9);
    assert.equal(player.volume, 0.8);
    player.current = { codecs: 'ec-3' };
    player.pcm = { gain: { gain: { value: 0 } } };
    apply();
    assert.equal(player.audio.volume, 0.8);
    assert.equal(player.pcm.gain.gain.value, 0.8);
    player.current = null;
    apply();
    assert.equal(player.audio.volume, 0.8);
  } finally {
    useJocSettings(null);
  }
  player.current = { codecs: 'mp4a.40.2' };
  apply();
  assert.equal(player.audio.volume, 0.8);
});

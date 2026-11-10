const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AmPlayer, detectModes, useJocSettings, sortVariants, pickPlayable } = require('../src/ui/player.js');

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

test('the playback quality setting picks the tier, falls back down, and gates Dolby Atmos', () => {
  global.Worker = function Worker() {};
  global.AudioContext = function AudioContext() {};
  global.AmDecrypt = { supported: () => true };
  global.MediaSource = { isTypeSupported: () => true };
  const variants = [
    { group_id: 'audio-HE-stereo-64', codecs: 'mp4a.40.5', bandwidth: 64000 },
    { group_id: 'audio-stereo-128', codecs: 'mp4a.40.2', bandwidth: 128000 },
    { group_id: 'audio-stereo-256', codecs: 'mp4a.40.2', bandwidth: 256000 },
    { group_id: 'audio-stereo-256-binaural', codecs: 'mp4a.40.2', bandwidth: 260000 },
    { group_id: 'audio-atmos-2768', codecs: 'ec-3', bandwidth: 768000 },
    { group_id: 'audio-alac-stereo-44100-16', codecs: 'alac', sample_rate: 44100, bit_depth: 16, bandwidth: 900000 },
    { group_id: 'audio-alac-stereo-48000-24', codecs: 'alac', sample_rate: 48000, bit_depth: 24, bandwidth: 1500000 },
    { group_id: 'audio-alac-stereo-192000-24', codecs: 'alac', sample_rate: 192000, bit_depth: 24, bandwidth: 5000000 },
  ];
  const pick = (quality, spatial = 'off', list = variants) => pickPlayable(list, { quality, spatial }).group_id;
  assert.equal(pick('hires'), 'audio-alac-stereo-192000-24');
  assert.equal(pick('lossless'), 'audio-alac-stereo-48000-24');
  assert.equal(pick('high'), 'audio-stereo-256');
  assert.equal(pick('efficient'), 'audio-HE-stereo-64');
  // a song without ALAC (or only the /webplayback AAC 256) falls back to AAC
  const aacOnly = variants.filter((v) => /^audio-stereo-256$/.test(v.group_id));
  assert.equal(pick('hires', 'off', aacOnly), 'audio-stereo-256');
  assert.equal(pick('efficient', 'off', aacOnly), 'audio-stereo-256');
  // Dolby Atmos: always → first unless High Efficiency; auto follows JOC rendering
  assert.equal(pick('high', 'always'), 'audio-atmos-2768');
  assert.equal(pick('efficient', 'always'), 'audio-HE-stereo-64');
  assert.equal(pick('hires', 'auto'), 'audio-alac-stereo-192000-24');
  useJocSettings({ get: () => ({ mode: 'binaural', gain: 0, dataset: 'D2' }), set: () => {} });
  try {
    assert.equal(pick('hires', 'auto'), 'audio-atmos-2768');
    assert.equal(pick('hires', 'off'), 'audio-alac-stereo-192000-24');
  } finally {
    useJocSettings(null);
  }
  // unplayable variants are skipped
  global.MediaSource = { isTypeSupported: (mime) => !/alac|flac/.test(mime) };
  assert.equal(pick('hires'), 'audio-stereo-256');
});

test('the non-spatial volume trim attenuates only the audio element and never spatial tracks or the slider value', () => {
  const player = Object.assign(Object.create(AmPlayer.prototype), {
    volume: 0.8, audio: { volume: 1 }, pcm: null, current: { codecs: 'alac' }, mixGain: 1, mixer: { volumeChanged() {} },
  });
  const apply = () => player.applyVolume();
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
    player.pcm = null;
    // binaural / downmix AAC come from the Atmos mix and are about as quiet, so they are not attenuated either
    for (const group of ['audio-stereo-256-binaural', 'audio-stereo-128-downmix', 'audio-HE-stereo-64-binaural']) {
      player.current = { codecs: 'mp4a.40.2', variant: { group_id: group } };
      apply();
      assert.equal(player.audio.volume, 0.8, group);
    }
    player.current = { id: '1468058171:audio-stereo-256-downmix', codecs: 'mp4a.40.2' };
    apply();
    assert.equal(player.audio.volume, 0.8);
    player.current = { codecs: 'mp4a.40.2', variant: { group_id: 'audio-stereo-256' } };
    apply();
    assert.ok(Math.abs(player.audio.volume - 0.8 * 10 ** (-6 / 20)) < 1e-9);
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

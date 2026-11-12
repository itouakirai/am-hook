// Run with: node --test tests/alac_check.mjs
// Offline: covers the album page's ALAC check (web/alac-check.mjs) with synthetic fMP4 data and a stubbed fetch:
// escape-frame tail classification (the real tails from AppleMusicDecrypt#136), moof / init parsing, the FairPlay
// prefetch-key detection of multi-DRM playlists, the analysis verdicts, and a whole checkTrack run that must never request /key.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  checkSources, checkTrack, classifyTail, compareAlac, createFragmentScanner, createLimiter, firstSegmentPrefetch, frameLayout, interpretAnalysis, parseFragmentHead, parseInit,
  pickAlac, tagValue,
} from '../../web/alac-check.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ---------- synthetic MP4 ---------- */

const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u16 = (v) => [(v >>> 8) & 255, v & 255];
const box = (type, ...parts) => {
  const body = parts.flat();
  return [...u32(body.length + 8), ...[...type].map((c) => c.charCodeAt(0)), ...body];
};
const full = (version, flags, ...parts) => [version, ...u32(flags).slice(1), ...parts.flat()];
const hex = (s) => s.split(' ').map((b) => parseInt(b, 16));

/** ALAC frameLength 16, stereo: one frame of PCM is 64 bytes (16-bit) or 96 bytes (24-bit) */
function init({ bits = 16, rate = 44100, created = 3870721646, software = '1.25.36.42 (1.25.36.48ib-250916) Linux' } = {}) {
  const cookie = [...u32(16), 0, bits, 40, 10, 14, 2, ...u16(255), ...u32(0), ...u32(1411200), ...u32(rate)];
  const enca = box('enca', Array(6).fill(0), u16(1), Array(8).fill(0), u16(2), u16(16), Array(4).fill(0), u32(rate << 16 >>> 0),
    box('alac', full(0, 0, cookie)), box('sinf', box('frma', [...'alac'].map((c) => c.charCodeAt(0)))));
  const stsd = box('stsd', full(0, 0, u32(1)), enca);
  const mdhd = box('mdhd', full(0, 0, u32(created), u32(created), u32(rate), u32(0), Array(4).fill(0)));
  const trak = box('trak', box('mdia', mdhd, box('minf', box('stbl', stsd))));
  const swre = box('swre', full(0, 0), u16(0x55c4), [...software].map((c) => c.charCodeAt(0)), [0]);
  const mvhd = box('mvhd', full(0, 0, u32(created), u32(created), u32(1000), u32(0), Array(80).fill(0)));
  return Uint8Array.from([...box('ftyp', [...'M4A '].map((c) => c.charCodeAt(0)), u32(0)), ...box('moov', mvhd, trak, box('udta', swre))]);
}

/** moof + mdat with the given sample payloads; every sample lasts 16 ticks */
function fragment(samples, baseTime) {
  const tfhd = box('tfhd', full(0, 0x02001a, u32(1), u32(1), u32(16), u32(64)));
  const tfdt = box('tfdt', full(1, 0, u32(0), u32(baseTime)));
  const trunBody = (offset) => full(0, 0x201, u32(samples.length), u32(offset), ...samples.map((s) => u32(s.length)));
  // moof header, mfhd, traf header, tfhd, tfdt, trun
  const moofLength = 8 + 16 + 8 + tfhd.length + tfdt.length + 8 + trunBody(0).length;
  const moof = box('moof', box('mfhd', full(0, 0, u32(1))), box('traf', tfhd, tfdt, box('trun', trunBody(moofLength + 8))));
  assert.equal(moof.length, moofLength);
  return Uint8Array.from([...moof, ...box('mdat', ...samples)]);
}

/** escape frame of `bytes` bytes ending in `tail` (the rest is arbitrary, as if encrypted) */
const escape = (bytes, tail) => [...Array(bytes - tail.length).fill(0x5a), ...tail];

/* ---------- tails ---------- */

test('escape frame tails from AppleMusicDecrypt#136 are classified like the issue', () => {
  const s16 = frameLayout({ frameLength: 4096, channels: 2, bits: 16 });
  const s24 = frameLayout({ frameLength: 4096, channels: 2, bits: 24 });
  assert.deepEqual([s16.pcmBytes, s16.escapeBytes, s24.pcmBytes, s24.escapeBytes], [16384, 16388, 24576, 24580]);
  const verdict = (tail, layout) => classifyTail(Uint8Array.from(hex(tail)), layout.escapeBytes, layout);
  // Don't Look Back (24-bit), Live My Life and Shell It Down (16-bit): glibc chunk sizes instead of the END tag
  assert.equal(verdict('10 60 00 00', s24), 'noEnd');
  assert.equal(verdict('50 80 00 00', s16), 'noEnd');
  assert.equal(verdict('00 00 00 00', s16), 'noEnd');
  assert.equal(verdict('01 00 04 00', s16), 'noEnd');
  // Shadows In The Night frame 2287: tail bits 111111101, the END-tag check alone passes
  assert.equal(verdict('00 5f 2d fd', s24), 'hidden');
  // Healthy escape frames end in 111 + six zero bits, whatever the last sample is
  assert.equal(verdict('12 34 57 c0', s16), 'ok');
  assert.equal(verdict('ff ff ff c0', s24), 'ok');
  assert.equal(verdict('12 34 56 c0', s16), 'noEnd', 'the first END bit is the lowest bit of the second-last byte');
  // Compressed frames larger than one frame of PCM: the END tag cannot be located
  assert.equal(classifyTail(Uint8Array.from(hex('00 00 00 c0')), 16386, s16), 'oversize');
});

/* ---------- parsing ---------- */

test('init: packaging date, packager, timescale and ALAC cookie', () => {
  const info = parseInit(init({ bits: 24, rate: 192000 }));
  assert.equal(info.created.toISOString(), '2026-08-28T00:27:26.000Z');
  assert.equal(info.software, '1.25.36.42 (1.25.36.48ib-250916) Linux');
  assert.deepEqual([info.timescale, info.frameLength, info.bits, info.channels, info.rate, info.avgBitrate], [192000, 16, 24, 2, 192000, 1411200]);
  assert.throws(() => parseInit(init().subarray(0, 200)), /Truncated|Missing/);
});

test('moof: sample offsets, sizes and times; asks for more bytes when the moof is cut', () => {
  const frag = fragment([[1, 2, 3], [4, 5], [6]], 4096);
  const { samples } = parseFragmentHead(frag);
  const moofEnd = frag.length - 8 - 6;
  assert.deepEqual(samples, [
    { offset: moofEnd + 8, size: 3, time: 4096 },
    { offset: moofEnd + 11, size: 2, time: 4112 },
    { offset: moofEnd + 13, size: 1, time: 4128 },
  ]);
  assert.deepEqual(parseFragmentHead(frag.subarray(0, 40)), { needed: moofEnd });
  assert.deepEqual(parseFragmentHead(frag.subarray(0, 4)), { needed: 16 });
  assert.throws(() => parseFragmentHead(Uint8Array.from(box('mdat', [0]))), /moof/);
});

test('first segment key: only the FairPlay key counts in multi-DRM playlists', () => {
  const widevine = '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"';
  const prefetch = '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://itunes.apple.com/P000000000/s1/e1",KEYFORMAT="com.apple.streamingkeydelivery"';
  const track = '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://itunes.apple.com/p1/c6",KEYFORMAT="com.apple.streamingkeydelivery"';
  const playlist = (...keys) => ['#EXTM3U', ...keys, '#EXT-X-MAP:URI="a.mp4",BYTERANGE="10@0"', '#EXTINF:15,', '#EXT-X-BYTERANGE:5@10', 'a.mp4'].join('\n');
  assert.equal(firstSegmentPrefetch(playlist(prefetch)), true);
  assert.equal(firstSegmentPrefetch(playlist(prefetch, widevine)), true);
  assert.equal(firstSegmentPrefetch(playlist(track, widevine)), false);
  assert.equal(firstSegmentPrefetch(playlist(widevine)), false);
});

test('best ALAC variant: sample rate, then bit depth, then bandwidth', () => {
  const v = (codecs, sample_rate, bit_depth, bandwidth) => ({ codecs, sample_rate, bit_depth, bandwidth });
  assert.deepEqual(pickAlac([v('mp4a.40.2', 0, 0, 256000), v('alac', 48000, 24, 2), v('alac', 192000, 24, 1), v('alac', 44100, 16, 3), v('ec-3', 48000, 0, 9)]), v('alac', 192000, 24, 1));
  assert.equal(pickAlac([v('mp4a.40.2', 0, 0, 256000)]), null);
});

/* ---------- analysis verdicts ---------- */

test('analysis verdicts need a steep drop before claiming upsampling or a lossy source', () => {
  const report = (rate, bandLimit, wallDb, extra = {}) => ({ rate, bits: 24, effectiveBits: 24, peakDb: -1, bandLimit, wallDb, spectrum: [0], ...extra });
  const band = (...args) => interpretAnalysis(report(...args)).band;
  assert.equal(band(192000, 96000, 0), 'full');
  assert.deepEqual(interpretAnalysis(report(96000, 22359, 74)), { bits: { effective: 24, padded: false }, band: 'upsampled', source: 44100 });
  assert.equal(interpretAnalysis(report(192000, 23900, 60)).source, 48000);
  assert.equal(interpretAnalysis(report(192000, 46000, 40)).source, 96000);
  // Norah Jones "Seven Years" (24/96): an anti-alias filter at 43.5 kHz is genuine hi-res content
  assert.equal(band(96000, 43523, 29), 'hires');
  assert.equal(band(192000, 78141, 6), 'hires');
  assert.equal(band(96000, 22000, 10), 'low', 'a gentle roll-off is no evidence');
  assert.equal(band(44100, 16247, 40), 'cutoff');
  assert.equal(band(44100, 20134, 30), 'low', 'a 20 kHz low-pass is common in CD masters');
  assert.equal(band(44100, 22050, 0), 'full');
  assert.equal(band(44100, 0, 0, { peakDb: -70 }), 'quiet');
  assert.equal(band(44100, 0, 0, { effectiveBits: null, peakDb: null }), 'quiet');
  assert.deepEqual(interpretAnalysis(report(44100, 22050, 0, { effectiveBits: 16 })).bits, { effective: 16, padded: true });
});

/* ---------- whole track ---------- */

/** wrapper.js and decrypt.js are browser scripts: run them with just enough globals to get their parsers */
function loadBrowserScripts() {
  globalThis.window = globalThis;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  for (const file of ['web/wrapper.js', 'web/decrypt/decrypt.js']) vm.runInThisContext(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });
}

test('checkTrack finds damaged escape frames from moofs and tails only, without /key', async () => {
  loadBrowserScripts();
  const base = 'https://aod.itunes.apple.com/itunes-assets/x/';
  const healthy = escape(68, hex('12 34 57 c0'));
  const segments = [
    fragment([[1, 2, 3], healthy, [4, 5]], 0),
    fragment([escape(68, hex('10 60 00 00')), [6], escape(68, hex('00 5f 2d fd')), escape(66, hex('00 00 00 c0'))], 48),
  ];
  const head = init();
  const file = Uint8Array.from([...head, ...segments.flatMap((segment) => [...segment])]);
  const ranges = [];
  let offset = head.length;
  const media = ['#EXTM3U', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://itunes.apple.com/P000000000/s1/e1"', `#EXT-X-MAP:URI="a_m.mp4",BYTERANGE="${head.length}@0"`];
  segments.forEach((segment, i) => {
    if (i === 1) media.push('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://itunes.apple.com/p1/c6"');
    media.push('#EXTINF:0.001,', `#EXT-X-BYTERANGE:${segment.length}@${offset}`, 'a_m.mp4');
    offset += segment.length;
  });
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac-stereo-44100-16",NAME="songEnhanced",SAMPLE-RATE=44100,BIT-DEPTH=16',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="alac",AUDIO="audio-alac-stereo-44100-16"',
    'P1_A123_audio_en_gr1411_alac.m3u8',
  ].join('\n');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const range = options.headers && options.headers.Range;
    if (/\/key\b/.test(url)) throw new Error('the check must not request /key');
    if (url === `${base}master.m3u8`) return new Response(master);
    if (url === `${base}P1_A123_audio_en_gr1411_alac.m3u8`) return new Response(media.join('\n'));
    if (url === `${base}a_m.mp4` && range) {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range).map(Number);
      ranges.push(end - start + 1);
      return new Response(file.slice(start, end + 1), { status: 206 });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const progress = [];
    const result = await checkTrack(`${base}master.m3u8`, { adamId: '123', limit: createLimiter(2), onProgress: (p) => progress.push(p) });
    assert.equal(result.status, 'done');
    assert.equal(result.frames, 7);
    assert.equal(result.info.software, '1.25.36.42 (1.25.36.48ib-250916) Linux');
    assert.deepEqual(result.escapes.map(({ frame, time, size, tail, verdict }) => [frame, time, size, tail, verdict]), [
      [1, 16 / 44100, 68, '12 34 57 c0', 'ok'],
      [3, 48 / 44100, 68, '10 60 00 00', 'noEnd'],
      [5, 80 / 44100, 68, '00 5f 2d fd', 'hidden'],
      [6, 96 / 44100, 66, '00 00 00 c0', 'oversize'],
    ]);
    assert.equal(result.analysis, null, 'no analyzer, no decoding');

    // While downloading the same bytes go through the scanner, in any order, with no requests of its own
    const scanner = createFragmentScanner(segments.length);
    scanner.segment(1, segments[1]);
    scanner.init(head);
    scanner.segment(0, segments[0]);
    const scanned = scanner.result(result.variant);
    assert.deepEqual([scanned.frames, scanned.escapes, scanned.info], [result.frames, result.escapes, result.info]);
    const partial = createFragmentScanner(2);
    partial.init(head);
    partial.segment(0, segments[0]);
    assert.throws(() => partial.result(result.variant), /Missing segment 1/);
    assert.ok(ranges.every((n) => n <= 1024 + 16 * 2 || n === head.length || n === 4), `only init, moof heads and 4-byte tails: ${ranges}`);
    assert.deepEqual(progress.at(-1), { phase: 'scan', done: 2, total: 2 });
    assert.equal((await checkTrack(`${base}none.m3u8`, {}).catch((e) => e)).message, 'HTTP 404');
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ---------- web API and wrapper-lite masters ---------- */

test('checkSources checks the web and wrapper-lite masters, once when their best ALAC is the same file', async () => {
  loadBrowserScripts();
  const base = 'https://aod.itunes.apple.com/itunes-assets/x/';
  const segment = fragment([[1, 2, 3], escape(68, hex('10 60 00 00'))], 0);
  const head = init();
  const file = Uint8Array.from([...head, ...segment]);
  const media = ['#EXTM3U', `#EXT-X-MAP:URI="a_m.mp4",BYTERANGE="${head.length}@0"`, '#EXTINF:0.001,', `#EXT-X-BYTERANGE:${segment.length}@${head.length}`, 'a_m.mp4'].join('\n');
  const stream = (rate, uri) => [
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac-stereo-${rate}-24",NAME="x",SAMPLE-RATE=${rate},BIT-DEPTH=24`,
    `#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="alac",AUDIO="audio-alac-stereo-${rate}-24"`, uri];
  // Like song 1679278167: the web API's master only has 24/48, the wrapper-lite one (another packaging) also 24/96
  const web = ['#EXTM3U', ...stream(48000, 'P1_alac48.m3u8')].join('\n');
  const wrapperVariants = window.AmWrapper.parseSongMaster(['#EXTM3U', ...stream(96000, 'P3_alac96.m3u8'), ...stream(48000, 'P3_alac48.m3u8')].join('\n'), `${base}P3.m3u8`);
  const realFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url, options = {}) => {
    requested.push(url);
    if (url === `${base}P1.m3u8`) return new Response(web);
    if (/alac\d+\.m3u8$/.test(url)) return new Response(media);
    const range = options.headers && options.headers.Range;
    if (url === `${base}a_m.mp4` && range) {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range).map(Number);
      return new Response(file.slice(start, end + 1), { status: 206 });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const both = await checkSources('1', { web: `${base}P1.m3u8`, wrapper: { masterUrl: `${base}P3.m3u8`, variants: wrapperVariants } }, { limit: createLimiter(4) });
    assert.equal(both.masters.web.variant.sample_rate, 48000);
    assert.equal(both.masters.wrapper.variant.sample_rate, 96000);
    assert.equal(compareAlac(both.masters.wrapper.variant, both.masters.web.variant) > 0, true);
    assert.deepEqual(both.streams.map((s) => [s.sources, s.variant.uri, s.result.escapes.map((e) => e.verdict)]), [
      [['web'], 'P1_alac48.m3u8', ['noEnd']],
      [['wrapper'], 'P3_alac96.m3u8', ['noEnd']],
    ]);

    // Same media m3u8 from both: checked once
    requested.length = 0;
    const same = await checkSources('1', { web: `${base}P1.m3u8`, wrapper: { masterUrl: `${base}P1.m3u8`, variants: window.AmWrapper.parseSongMaster(web, `${base}P1.m3u8`) } }, {});
    assert.deepEqual(same.streams.map((s) => s.sources), [['web', 'wrapper']]);
    assert.equal(requested.filter((u) => u.endsWith('alac48.m3u8')).length, 1);

    // A failing source is reported, the other one is still checked
    window.AmWrapper.songMaster = async () => { throw new Error('wrapper down'); };
    const down = await checkSources('1', { web: `${base}P1.m3u8`, wrapper: true }, {});
    assert.equal(down.masters.wrapper.error, 'wrapper down');
    assert.equal(down.streams.length, 1);

    const tag = tagValue(both.streams[1].result, { repair: true, checked: new Date('2026-10-21T00:00:00Z') });
    assert.match(tag, /^result=damaged; noEnd=1; hidden=0; oversize=0; frames=2; escapes=1; format=16\/44100; bad=#1@0\.000:noEnd; packaged=2026-08-28T00:27:26Z; /);
    assert.match(tag, /; endTagRepair=on; checked=2026-10-21T00:00:00Z; by=am-hook$/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

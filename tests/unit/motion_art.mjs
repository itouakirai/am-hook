// 动态封面下载的纯函数部分（web/download/motion.mjs、web/motion-art.mjs 的解析）与封面菜单反推模板（web/amp.mjs 的 artworkTemplate）。
// 离线，只需 Node：node --test tests/unit/motion_art.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMaster, parseMedia } from '../../web/motion-art.mjs';
import { motionSources, motionChoices, pickMotion, motionQuality, motionEstimate, codecFamily } from '../../web/download/motion.mjs';
import { artworkTemplate } from '../../web/amp.mjs';

const BASE = 'https://mvod.itunes.apple.com/itunes-assets/HLSMusic126/v4/aa/P1_default.m3u8';
const inf = (avg, peak, codec, res, range = 'SDR', audio = '') =>
  `#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=${avg},BANDWIDTH=${peak},VIDEO-RANGE=${range},CODECS="${codec}"${audio},FRAME-RATE=24.000,RESOLUTION=${res}`;
const MASTER = [
  '#EXTM3U',
  '#EXT-X-I-FRAME-STREAM-INF:AVERAGE-BANDWIDTH=1,BANDWIDTH=1,CODECS="avc1.64001f",RESOLUTION=486x486,URI="iframes.m3u8"',
  inf(2151458, 2487185, 'avc1.64001f', '768x768'), 'avc_768.m3u8',
  inf(3897178, 4228721, 'avc1.640020', '1080x1080'), 'avc_1080_a.m3u8',
  inf(9588589, 9660608, 'avc1.640020', '1080x1080'), 'avc_1080_b.m3u8',
  inf(3680770, 3900000, 'hvc1.2.20000000.L123.B0', '1080x1080'), 'hevc_1080.m3u8',
  inf(6613380, 7000000, 'hvc1.2.20000000.H150.B0', '2160x2160'), 'hevc_2160_a.m3u8',
  inf(19571568, 20000000, 'hvc1.2.20000000.H150.B0', '2160x2160'), 'hevc_2160_b.m3u8',
  inf(25000000, 26000000, 'hvc1.2.20000000.H150.B0', '2160x2160', 'PQ'), 'hevc_2160_pq.m3u8',
  // 竖版带静音音轨组：只取视频编码
  inf(4145090, 5000000, 'hvc1.2.20000000.L123.B0,mp4a.40.2', '1078x1438', 'SDR', ',AUDIO="audio-stereo-160"'), 'hevc_tall.m3u8',
].join('\n');

test('parseMaster: video variants with size, average bandwidth and range', () => {
  const v = parseMaster(MASTER, BASE);
  assert.equal(v.length, 8);
  assert.deepEqual(v[0], {
    url: 'https://mvod.itunes.apple.com/itunes-assets/HLSMusic126/v4/aa/avc_768.m3u8', codec: 'avc1.64001f', size: 768, width: 768, height: 768,
    bandwidth: 2487185, average: 2151458, range: 'SDR',
  });
  assert.equal(v[7].codec, 'hvc1.2.20000000.L123.B0');
  assert.equal(v[7].size, 1438);
});

test('parseMedia: byte ranges and duration', () => {
  const media = parseMedia([
    '#EXTM3U', '#EXT-X-MAP:URI="v.mp4",BYTERANGE="899@0"',
    '#EXTINF:2.83333,', '#EXT-X-BYTERANGE:3404753@899', 'v.mp4',
    '#EXTINF:2.875,', '#EXT-X-BYTERANGE:3421465', 'v.mp4',
  ].join('\n'), BASE);
  assert.deepEqual(media.init, { url: 'https://mvod.itunes.apple.com/itunes-assets/HLSMusic126/v4/aa/v.mp4', start: 0, end: 898 });
  assert.deepEqual(media.segments.map((s) => [s.start, s.end]), [[899, 3405651], [3405652, 6827116]]);
  assert.ok(Math.abs(media.duration - 5.70833) < 1e-6);
});

test('motionChoices: one per codec, size and range, highest bitrate first', () => {
  const choices = motionChoices(parseMaster(MASTER, BASE));
  assert.deepEqual(choices.map((v) => `${motionQuality(v)}@${v.average}`), [
    '2160×2160 HEVC@19571568', '2160×2160 HEVC PQ@25000000', '1078×1438 HEVC@4145090', '1080×1080 HEVC@3680770',
    '1080×1080 H.264@9588589', '768×768 H.264@2151458',
  ]);
});

test('pickMotion: codec preference, short-side cap, SDR first', () => {
  const all = parseMaster(MASTER, BASE);
  const v = all.slice(0, 7); // 方形的各档（竖版在实际中是另一个 master）
  assert.equal(pickMotion(v, { codec: 'hevc', max: 2160 }).average, 19571568);
  assert.equal(pickMotion(v, { codec: 'hevc', max: 1080 }).url.endsWith('hevc_1080.m3u8'), true);
  assert.equal(pickMotion(v, { codec: 'avc', max: 2160 }).average, 9588589);
  assert.equal(pickMotion(v, { codec: 'avc', max: 720 }).width, 768, 'all larger: the smallest');
  // 没有 H.264 时用 HEVC
  assert.equal(codecFamily(pickMotion(v.filter((x) => codecFamily(x.codec) === 'hevc'), { codec: 'avc', max: 2160 }).codec), 'hevc');
  // 竖版 1078×1438 按短边算
  assert.equal(pickMotion([all[7]], { codec: 'hevc', max: 1080 }).width, 1078);
  assert.equal(motionEstimate({ average: 8e6 }, 20), 20e6);
});

test('motionSources: shapes from editorialVideo, one per source', () => {
  const sq = { video: 'https://x/sq.m3u8' };
  assert.deepEqual(motionSources({ motionDetailSquare: sq, motionSquareVideo1x1: sq, motionDetailTall: { video: 'https://x/t.m3u8' } }).map((s) => [s.kind, s.src]),
    [['square', 'https://x/sq.m3u8'], ['tall', 'https://x/t.m3u8']]);
  assert.deepEqual(motionSources({ motionArtistWide16x9: { video: 'https://x/w.m3u8' }, motionArtistSquare1x1: { video: 'https://x/a.m3u8' } }).map((s) => s.kind),
    ['square', 'wide']);
  assert.deepEqual(motionSources(undefined), []);
});

test('artworkTemplate: page image address back to a template', () => {
  const p = 'https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/9b/d8/9c/x/23UMGIM71510.rgb.jpg/';
  assert.equal(artworkTemplate(`${p}632x632bb.jpg`), `${p}{w}x{h}bb.{f}`);
  assert.equal(artworkTemplate(`${p}296x296cc.webp`), `${p}{w}x{h}bb.{f}`);
  assert.equal(artworkTemplate(`${p}600x600bb-60.jpg`), `${p}{w}x{h}bb.{f}`);
  assert.equal(artworkTemplate(`${p}1000x1000SC.DN01.jpg?l=en-US`), `${p}{w}x{h}SC.DN01.{f}?l=en-US`);
  assert.equal(artworkTemplate('https://example.com/a/632x632bb.jpg'), '');
  assert.equal(artworkTemplate('blob:https://x/1'), '');
});

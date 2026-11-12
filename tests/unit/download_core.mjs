// 批量下载的纯函数部分：ZIP（含 ZIP64）、iTunes 标签（ilst）、文件名模板、音质选择与 MV 的选轨。离线，只需 Node：
//   node --test tests/download_core.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildZip, zipParts, crc32, crc32Blob } from '../../web/download/zip.mjs';
import { buildIlst } from '../../web/download/mp4-tags.mjs';
import { formatPath, formatName, sanitize, fitFolder, fitFile, stripAlbumSuffix } from '../../web/download/naming.mjs';
import { pickMvVideo, pickMvAudio, mvQualityVars } from '../../web/mv/hls.mjs';
// prefs.mjs 在加载时监听 storage 事件（其他标签页修改设置）；Node 中没有全局的 addEventListener
globalThis.addEventListener ??= () => {};
const { pickVariant, fallbackChain, DEFAULT_FALLBACK } = await import('../../web/prefs.mjs');

const enc = new TextEncoder();

/** 读出 ZIP 的中央目录：[{ name, crc, size, offset }]，并按本地文件头取出内容 */
async function readZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer);
  let eocd = buf.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  let count = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    assert.equal(view.getUint32(loc, true), 0x07064b50);
    const rec = Number(view.getBigUint64(loc + 8, true));
    assert.equal(view.getUint32(rec, true), 0x06064b50);
    count = Number(view.getBigUint64(rec + 32, true));
    cdOffset = Number(view.getBigUint64(rec + 48, true));
  }
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(p, true), 0x02014b50);
    const crc = view.getUint32(p + 16, true);
    let size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    let offset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (extraLen) {
      const x = p + 46 + nameLen;
      assert.equal(view.getUint16(x, true), 1);
      size = Number(view.getBigUint64(x + 4, true));
      offset = Number(view.getBigUint64(x + 20, true));
    }
    assert.equal(view.getUint32(offset, true), 0x04034b50);
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    const start = offset + 30 + localName + localExtra;
    out.push({ name, crc, size, data: buf.subarray(start, start + size) });
    p += 46 + nameLen + extraLen;
  }
  return out;
}

test('crc32 matches the reference value', async () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(enc.encode('6789'), crc32(enc.encode('12345'))), 0xcbf43926);
  assert.equal(await crc32Blob(new Blob([enc.encode('123456789')])), 0xcbf43926);
});

test('store-only zip round-trips entries, renames duplicates and keeps UTF-8 names', async () => {
  const song = new Uint8Array(70_000).map((_, i) => i * 7);
  const zip = await buildZip([
    { name: '1-01 晴天.m4a', data: new Blob([song]), crc: crc32(song) },
    { name: '1-01 晴天.lrc', data: enc.encode('[00:01.00]故事的小黄花') },
    { name: 'cover.jpg', data: new Blob([enc.encode('jpeg')]) },
    { name: 'cover.jpg', data: enc.encode('second') },
  ]);
  const entries = await readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ['1-01 晴天.m4a', '1-01 晴天.lrc', 'cover.jpg', 'cover (2).jpg']);
  assert.deepEqual([...entries[0].data], [...song]);
  for (const e of entries) assert.equal(e.crc, crc32(e.data), e.name);
});

test('zip64 records are written when an offset passes 4 GiB', async () => {
  // Only sizes matter for the layout: a stand-in for a 4.5 GiB file on disk.
  const big = { size: 4.5 * 2 ** 30 };
  const parts = await zipParts([{ name: 'big.m4a', data: big, crc: 0 }, { name: 'after.txt', data: enc.encode('x') }]);
  assert.equal(parts[1], big);
  const local2 = new DataView(parts[2].buffer);
  assert.equal(local2.getUint32(0, true), 0x04034b50);
  // The second entry starts past 4 GiB: its central record carries a zip64 extra with the real offset.
  const cd2 = parts[5];
  const v = new DataView(cd2.buffer);
  assert.equal(v.getUint32(42, true), 0xffffffff);
  const nameLen = v.getUint16(28, true);
  // local header of big.m4a: 30 bytes + name (7) + zip64 extra (20), then the data
  assert.equal(Number(v.getBigUint64(46 + nameLen + 20, true)), 30 + 'big.m4a'.length + 20 + big.size);
  const tail = Buffer.concat(parts.slice(6).map((p) => Buffer.from(p))).toString('latin1');
  assert.ok(tail.startsWith('PK\x06\x06'), 'zip64 end record');
  assert.ok(tail.includes('PK\x06\x07'), 'zip64 locator');
});

/** ilst → [[type, payload]]（payload 为 data box 的值） */
function items(ilst) {
  const out = [];
  const view = new DataView(ilst.buffer, ilst.byteOffset, ilst.byteLength);
  for (let p = 0; p < ilst.length;) {
    const size = view.getUint32(p);
    const type = Buffer.from(ilst.subarray(p + 4, p + 8)).toString('latin1');
    let q = p + 8;
    if (type === '----') {
      const meanSize = view.getUint32(q); q += meanSize;
      const nameSize = view.getUint32(q);
      const name = Buffer.from(ilst.subarray(q + 12, q + nameSize)).toString('utf8'); q += nameSize;
      out.push([`----:${name}`, Buffer.from(ilst.subarray(q + 16, p + size)).toString('utf8')]);
    } else {
      assert.equal(Buffer.from(ilst.subarray(q + 4, q + 8)).toString('latin1'), 'data');
      out.push([type, ilst.subarray(q + 16, p + size), view.getUint32(q + 8)]);
    }
    p += size;
  }
  return out;
}

test('ilst items use iTunes atoms and data types', () => {
  const cover = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const ilst = buildIlst({
    title: '晴天', artist: '周杰伦', album: '叶惠美', albumArtist: '周杰伦', track: [3, 11], disc: [1, 1], date: '2003-07-31',
    genre: '流行', rating: 1, songId: '536035716', albumId: '536035714', artistId: '300117743', label: 'JVR', isrc: 'TWK970300303',
    upc: '0000', lyrics: '[00:01.00]x', cover: { bytes: cover, type: 'png' }, sort: { title: '晴天' }, empty: '',
  });
  const map = new Map(items(ilst).map(([k, ...v]) => [k, v]));
  assert.equal(Buffer.from(map.get('\xa9nam')[0]).toString(), '晴天');
  assert.equal(map.get('\xa9nam')[1], 1);
  assert.deepEqual([...map.get('trkn')[0]], [0, 0, 0, 3, 0, 11, 0, 0]);
  assert.deepEqual([...map.get('disk')[0]], [0, 0, 0, 1, 0, 1]);
  assert.deepEqual([...map.get('rtng')[0]], [1]);
  assert.equal(map.get('cnID')[0].length, 4);
  assert.equal(new DataView(map.get('cnID')[0].buffer, map.get('cnID')[0].byteOffset).getUint32(0), 536035716);
  assert.equal(map.get('plID')[0].length, 8);
  assert.equal(map.get('covr')[1], 14);
  assert.deepEqual([...map.get('covr')[0]], [...cover]);
  assert.equal(map.get('----:ISRC')[0], 'TWK970300303');
  assert.equal(map.get('----:LABEL')[0], 'JVR');
  assert.equal(Buffer.from(map.get('sonm')[0]).toString(), '晴天');
  assert.ok(!map.has('soar'));
  assert.deepEqual([...map.get('stik')[0]], [1]);
});

test('music video ilst: stik 6 and the reference PERFORMER / RELEASETIME fields', () => {
  const map = new Map(items(buildIlst({ title: 'MV', mediaType: 6, custom: { PERFORMER: 'A', RELEASETIME: '2020-01-01', EMPTY: '' } })).map(([k, ...v]) => [k, v]));
  assert.deepEqual([...map.get('stik')[0]], [6]);
  assert.equal(map.get('----:PERFORMER')[0], 'A');
  assert.equal(map.get('----:RELEASETIME')[0], '2020-01-01');
  assert.ok(!map.has('----:EMPTY'));
});

test('music video tracks follow the reference mv-max and mv-audio-type', () => {
  const video = (res, bw, codecs = 'hvc1.2.4.L150.90,mp4a.40.2', range = 'SDR') => ({ RESOLUTION: res, 'AVERAGE-BANDWIDTH': String(bw), CODECS: codecs, 'VIDEO-RANGE': range });
  const videos = [video('1920x1080', 8e6), video('3840x2160', 20e6, 'dvh1.05.06,ec-3', 'PQ'), video('3840x2160', 18e6), video('1280x720', 4e6)];
  assert.equal(pickMvVideo(videos, 2160), videos[1]);
  assert.equal(pickMvVideo(videos, 1080), videos[0]);
  assert.equal(pickMvVideo(videos, 480), videos[3], 'lowest when all are taller');

  const audio = (group, uri, codec) => ({ 'GROUP-ID': group, URI: uri, codec });
  const audios = [audio('audio-stereo-256', 'a_gr1_.m3u8', 'mp4a.40.2'), audio('audio-stereo-256', 'b_gr3_.m3u8', 'mp4a.40.2'),
    audio('audio-HE-stereo-64', 'c.m3u8', 'mp4a.40.5'), audio('audio-ac3', 'd.m3u8', 'ac-3'), audio('audio-atmos', 'e.m3u8', 'ec-3'), audio('audio-x', 'f.m3u8', '')];
  assert.equal(pickMvAudio(audios, 'atmos'), audios[4]);
  assert.equal(pickMvAudio(audios, 'ac3'), audios[3]);
  assert.equal(pickMvAudio(audios, 'aac'), audios[1], 'the larger _gr{n}_ wins a tie');
  assert.equal(pickMvAudio(audios.slice(0, 3), 'atmos'), audios[1], 'falls back to AAC');
  assert.equal(pickMvAudio([audios[5]], 'atmos'), null);

  assert.equal(mvQualityVars(videos[1], audios[4]).quality, '2160p HEVC Dolby Vision · Dolby Atmos');
  assert.equal(mvQualityVars(video('1920x1080', 1, 'avc1.640028', 'PQ'), audios[2]).quality, '1080p H.264 HDR10 · HE-AAC 64kbps');
  assert.equal(mvQualityVars(videos[0], audios[3]).codec, 'HEVC');
});

test('file name templates: padding, subfolders, sanitizing', () => {
  const vars = { title: 'AC/DC: Back?', artist: 'AC/DC', album: 'X', tracknum: 3, disk: 1, explicit: '', index: 7 };
  assert.deepEqual(formatPath('{disk}-{tracknum:02d} {title}', vars), ['1-03 AC_DC_ Back_']);
  assert.deepEqual(formatPath('{artist}/{album}', vars), ['AC_DC', 'X']);
  assert.deepEqual(formatPath('Disc {disk}/{tracknum:02d}. {title} {explicit}', vars), ['Disc 1', '03. AC_DC_ Back_']);
  assert.deepEqual(formatPath('{index:03d} {nope}', vars), ['007 {nope}']);
  assert.equal(formatName('{artist}/{album}', vars), 'AC_DC - X');
  assert.deepEqual(formatPath('../{title}', { title: '' }), ['_']);
  assert.equal(sanitize('CON'), '_CON');
  assert.equal(sanitize('name. . '), 'name');
  assert.equal(sanitize('A COMPLETE ~ALL SINGLES~'), 'A COMPLETE ~ALL SINGLES～');
  assert.equal(sanitize('..hidden\u200b name'), 'hidden name');
  assert.equal([...sanitize('a'.repeat(300))].length, 180);
  assert.equal([...sanitize('长'.repeat(300))].length, 80);
  assert.equal(sanitize('x\u0085y\ufffe\ud800z'), 'x_yz');
  assert.equal(sanitize('COM\u00b9'), '_COM\u00b9');
  assert.equal(sanitize('Thumbs.db'), '_Thumbs.db');
  assert.equal(sanitize('Live.Local'), 'Live_Local');
  assert.equal(sanitize('\u3000Title\u3000'), 'Title');
});

test('stripAlbumSuffix: only the trailing " - EP" / " - Single" Apple Music adds', () => {
  assert.equal(stripAlbumSuffix('Wake Me Up - Single'), 'Wake Me Up');
  assert.equal(stripAlbumSuffix('Amore (Special Edition) - EP'), 'Amore (Special Edition)');
  assert.equal(stripAlbumSuffix('Title  -  EP '), 'Title');
  // 名字本身的文字：没有「 - 」分隔、大小写不同、不在末尾、连字符没有空格
  for (const keep of ['夏のせい ep', 'Night - ep', 'Single - EP Remixes', 'Re-Single', 'The EP', '- Single', 'EP']) {
    assert.equal(stripAlbumSuffix(keep), keep);
  }
  // 只去一次：「X - EP - Single」之类的名字只去掉 Apple 附加的那一个
  assert.equal(stripAlbumSuffix('X - EP - Single'), 'X - EP');
  assert.equal(stripAlbumSuffix(undefined), '');
});

test('file name templates: total path length stays within the Windows limit', () => {
  const length = (segments) => segments.join('/').length;
  assert.deepEqual(fitFolder(['Artist', 'Album']), ['Artist', 'Album']);
  assert.deepEqual(fitFile(['Artist', 'Album'], ['01 Title']), ['01 Title']);
  const folder = fitFolder(['A'.repeat(120), 'B'.repeat(60) + ' ~x~']);
  assert.ok(length(folder) <= 90);
  assert.equal(folder[1].length, 44);  // 最长的一段先截
  assert.ok(!/[.~ ]$/.test(folder[1]));
  const file = fitFile(folder, ['Disc 1', '01 ' + '长'.repeat(170)]);
  assert.deepEqual(file[0], 'Disc 1');
  assert.ok(length([...folder, ...file]) + '.ttml.crswap'.length <= 150);
  // 截断不会拆开代理对
  assert.ok([...fitFile([], ['😀'.repeat(100)])[0]].every((c) => c === '😀'));
});

/* ---------- 音质选择 ---------- */
const variant = (group_id, extra = {}) => ({ group_id, bandwidth: 0, sample_rate: null, bit_depth: null, ...extra });
const MASTER = [
  variant('audio-alac-stereo-44100-16', { sample_rate: 44100, bit_depth: 16 }),
  variant('audio-alac-stereo-96000-24', { sample_rate: 96000, bit_depth: 24 }),
  variant('audio-alac-stereo-192000-24', { sample_rate: 192000, bit_depth: 24 }),
  variant('audio-atmos-2448'),
  variant('audio-atmos-2768'),
  variant('audio-stereo-256'),
  variant('audio-stereo-128'),
  variant('audio-HE-stereo-64'),
  variant('audio-stereo-256-binaural'),
  variant('audio-HE-stereo-32'),
];
// /webplayback 的 AAC-LC 256（wrapper.js 的 webplaybackVariant）：没有 master 时唯一的变体
const WIDEVINE = [variant('audio-stereo-256', { bandwidth: 256000, widevine: true })];
const options = (o) => ({ codec: 'alac', alacMax: 192000, atmosMax: 2768, fallback: true, fallbackOrder: {}, ...o });
const pick = (variants, o) => {
  const r = pickVariant(variants, options(o));
  return r && [r.variant.group_id, r.fallback];
};

test('pickVariant: preferred quality within the ALAC / Atmos / bitrate caps', () => {
  assert.deepEqual(pick(MASTER, {}), ['audio-alac-stereo-192000-24', false]);
  assert.deepEqual(pick(MASTER, { alacMax: 96000 }), ['audio-alac-stereo-96000-24', false]);
  assert.deepEqual(pick(MASTER, { alacMax: 48000 }), ['audio-alac-stereo-44100-16', false]);
  assert.deepEqual(pick(MASTER, { codec: 'atmos' }), ['audio-atmos-2768', false]);
  assert.deepEqual(pick(MASTER, { codec: 'atmos', atmosMax: 2448 }), ['audio-atmos-2448', false]);
  assert.deepEqual(pick(MASTER, { codec: 'aac' }), ['audio-stereo-256', false]);
  assert.deepEqual(pick(MASTER, { codec: 'aac-128' }), ['audio-stereo-128', false]);
  assert.deepEqual(pick(MASTER, { codec: 'aac-he' }), ['audio-HE-stereo-64', false]);
  assert.deepEqual(pick(MASTER, { codec: 'aac-binaural' }), ['audio-stereo-256-binaural', false]);
});

test('pickVariant: default fallback order, and no fallback when switched off', () => {
  const stereo = MASTER.filter((v) => !/alac|atmos/.test(v.group_id));
  assert.deepEqual(pick(stereo, { codec: 'atmos' }), ['audio-stereo-256', true]);
  assert.deepEqual(pick(stereo, { codec: 'atmos', fallback: false }), null);
  assert.deepEqual(pick(stereo, { codec: 'aac-downmix-128' }), ['audio-stereo-128', true]);
  // 全景声的上限低于所有变体时同样算没有
  assert.deepEqual(pick(MASTER, { codec: 'atmos', atmosMax: 2448, fallback: false }), ['audio-atmos-2448', false]);
  assert.deepEqual(pick([variant('audio-atmos-2768'), ...stereo], { codec: 'atmos', atmosMax: 2448 }), ['audio-stereo-256', true]);
});

test('pickVariant: custom fallback order per preferred quality', () => {
  const stereo = MASTER.filter((v) => !/alac|atmos/.test(v.group_id));
  assert.deepEqual(pick(stereo, { codec: 'atmos', fallbackOrder: { atmos: ['aac-he', 'aac'] } }), ['audio-HE-stereo-64', true]);
  // 只对该首选音质生效
  assert.deepEqual(pick(stereo, { codec: 'alac', fallbackOrder: { atmos: ['aac-he'] } }), ['audio-stereo-256', true]);
  // 空顺序：不降级
  assert.deepEqual(pick(stereo, { codec: 'atmos', fallbackOrder: { atmos: [] } }), null);
  // 关闭降级时自定义顺序也不用
  assert.deepEqual(fallbackChain(options({ fallback: false, fallbackOrder: { alac: ['aac'] } })), []);
  assert.deepEqual(fallbackChain(options({})), DEFAULT_FALLBACK.alac);
});

test('pickVariant: a song with only the Widevine AAC-LC 256 follows the fallback setting', () => {
  // 首选 AAC 256：不算降级
  assert.deepEqual(pick(WIDEVINE, { codec: 'aac', fallback: false }), ['audio-stereo-256', false]);
  // 关闭降级：跳过（https://music.apple.com/cn/song/stay-with-me/1569279827 之前仍会降级下载）
  for (const codec of ['alac', 'atmos', 'aac-128', 'aac-he', 'aac-binaural']) {
    assert.equal(pick(WIDEVINE, { codec, fallback: false }), null, codec);
  }
  // 开启降级：按顺序中的 AAC 256 下载；顺序中没有 AAC 256 时同样跳过
  assert.deepEqual(pick(WIDEVINE, { codec: 'alac' }), ['audio-stereo-256', true]);
  assert.equal(pick(WIDEVINE, { codec: 'alac', fallbackOrder: { alac: ['aac-he', 'aac-128'] } }), null);
});

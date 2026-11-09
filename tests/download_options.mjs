// 下载选项：专辑名、文件名、封面请求与标签；模拟目录与音频数据，离线，只需 Node：
//   node --test tests/download_options.mjs
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) };
globalThis.addEventListener = () => {};
globalThis.location = { origin: 'https://am-hook.test' };
globalThis.document = { createElement: () => ({ style: {}, click() {}, remove() {} }), body: { append() {} } };
const nativeTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const timer = nativeTimeout(fn, ms, ...args);
  if (ms === 60_000) timer.unref(); // Blob URL 的延迟回收不阻止测试进程退出
  return timer;
};

let song;
let captured;
const requests = [];
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.startsWith(location.origin + '/amp/')) return Response.json({ data: [song] });
  requests.push(url);
  return new Response(url.endsWith('.png') ? PNG : JPEG);
};
globalThis.window = {
  AmI18n: { t: (key) => key, catalogLang: () => 'ja' },
  AmWrapper: { songMaster: async () => ({ variants: [{ group_id: 'audio-stereo-256', url: 'audio' }] }) },
  AmDecrypt: {
    openTrack: async () => ({ size: 1 }),
    download: async (_track, { tags }) => {
      captured = await tags();
      return { file: new Blob([captured]), dispose() {} };
    },
  },
};

const { prefs, DEFAULTS } = await import('../src/ui/prefs.mjs');
// 部分资源的文件名与对外地址不同（mv-hls.mjs → /assets/mv/hls.mjs），按服务端的资源表解析 import
const table = await readFile(new URL('../src/assets.rs', import.meta.url), 'utf8');
const assets = new Map([...table.matchAll(/asset!\("([^"]+)",\s*\w+,\s*"([^"]+)"\)/g)].map(([, url, file]) => [url, file]));
const source = (await readFile(new URL('../src/ui/downloads.mjs', import.meta.url), 'utf8')).replace(/from '(\.\/[^']+)'/g, (_, relative) => {
  const file = assets.get(new URL(relative, 'https://am-hook.test/assets/downloads.mjs').pathname);
  assert.ok(file, relative);
  return `from '${new URL('../src/ui/' + file, import.meta.url).href}'`;
});
const { downloads, coverUrl, mvTags } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

/** ilst → Map<atom, { type, value }>；UTF-8 字段解码为文字，其余保留字节 */
function tags(ilst) {
  const buf = Buffer.from(ilst);
  const out = new Map();
  for (let p = 0; p < buf.length;) {
    const size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const dataType = buf.readUInt32BE(p + 16);
    const value = buf.subarray(p + 24, p + size);
    out.set(type, { type: dataType, value: dataType === 1 ? value.toString('utf8') : value });
    p += size;
  }
  return out;
}

function resource(album, artwork = 'https://art.test/cover.jpg/{w}x{h}bb.jpg') {
  return { id: '2', type: 'songs', attributes: { name: 'Track', artistName: 'Artist', albumName: album,
    trackNumber: 1, discNumber: 1, hasLyrics: false, artwork: { url: artwork }, playParams: {} },
    relationships: { albums: { data: [{ id: '1', attributes: { name: album, artistName: 'Artist', trackCount: 1 } }] } } };
}

async function run(album, options = {}, kind = 'album', artwork) {
  song = resource(album, artwork);
  captured = null;
  requests.length = 0;
  prefs.reset('download');
  prefs.set('download', { codec: 'aac', retries: 0, embed: ['album', 'cover'], saveCover: false,
    sortTags: true, songFile: '{album} - {title}', playlistFile: '{album} - {title}', ...options });
  const job = await downloads.add({ kind, id: '1', country: 'jp',
    resource: { attributes: { name: kind === 'playlist' ? 'My Mix - EP' : album, artwork: song.attributes.artwork } }, tracks: [song] });
  for (let i = 0; i < 200 && !job.saved && !job.prepError && !job.packError && downloads.jobState(job) !== 'error'; i++) await delay(10);
  assert.equal(job.prepError, '');
  assert.ok(job.saved, job.packError || job.tasks.map((task) => task.error).join(', '));
  return { job, tags: tags(captured) };
}

afterEach(() => { downloads.clearFinished(); prefs.reset('download'); });

test('defaults and old tag selections survive settings validation', () => {
  assert.equal(DEFAULTS.download.normalizeAlbumName, false);
  assert.ok(DEFAULTS.download.embed.includes('cover'));
  const value = prefs.set('download', { embed: ['album'], coverFormat: 'original', saveCoverFormat: 'original', normalizeAlbumName: true });
  assert.deepEqual(value.embed, ['album']);
  assert.equal(value.coverFormat, 'original');
  assert.equal(value.saveCoverFormat, 'original');
  assert.equal(value.normalizeAlbumName, true);
  const saved = JSON.parse(storage.get('am-hook:settings')).download;
  assert.deepEqual(saved, value);
  const invalid = prefs.set('download', { normalizeAlbumName: 'true', coverFormat: 'webp' });
  assert.equal(invalid.normalizeAlbumName, false);
  assert.equal(invalid.coverFormat, 'jpg');
});

test('cover format follows the source path, supports fixed rendition extensions and ignores query strings', () => {
  const prefix = 'https://art.test/';
  for (const [path, format, expected] of [
    ['cover.png/{w}x{h}bb.jpg', 'original', 'cover.png/600x600bb.png'],
    ['cover.jpg/{w}x{h}bb.png', 'original', 'cover.jpg/600x600bb.jpg'],
    ['cover.PNG/{w}x{h}{c}.{f}', 'original', 'cover.PNG/600x600bb.png'],
    ['cover.JPEG/{w}x{h}bb.{f}', 'original', 'cover.JPEG/600x600bb.jpg'],
    ['opaque/{w}x{h}bb.{f}?name=fake.png', 'original', 'opaque/600x600bb.jpg?name=fake.png'],
    ['cover.tif/{w}x{h}bb.{f}', 'original', 'cover.tif/600x600bb.jpg'],
    ['cover.jpg/{w}x{h}bb.jpg?x=1#art', 'png', 'cover.jpg/600x600bb.png?x=1#art'],
    ['cover.png/{w}x{h}bb.png', 'jpg', 'cover.png/600x600bb.jpg'],
    ['cover.png', 'original', 'cover.png'],
  ]) assert.equal(coverUrl(prefix + path, format, 600), prefix + expected);
  assert.equal(coverUrl('', 'original', 600), '');
});

test('normalized album names reach tags, sort tags, filename variables and ZIP names', async () => {
  for (const [name, expected] of [['夏のせい ep', '夏のせい ep'], ['Wake Me Up - Single', 'Wake Me Up'], ['Amore (Special Edition) - EP', 'Amore (Special Edition)']]) {
    const { job, tags: values } = await run(name, { normalizeAlbumName: true });
    assert.equal(values.get('\xa9alb').value, expected);
    assert.equal(values.get('soal').value, expected);
    assert.deepEqual(job.tasks[0].path, [`${expected} - Track.m4a`]);
    assert.deepEqual(job.folder, [`Artist - ${expected}`]);
    assert.equal(job.zipName, `Artist - ${expected}.zip`);
    assert.equal(job.tasks[0].song.attributes.albumName, name);
    assert.equal(job.collection.name, name);
  }
});

test('disabled normalization preserves suffixes and playlist titles stay unchanged', async () => {
  const original = await run('Album - EP');
  assert.equal(original.tags.get('\xa9alb').value, 'Album - EP');
  const playlist = await run('Album - EP', { normalizeAlbumName: true, playlistAlbumInfo: false }, 'playlist');
  assert.equal(playlist.tags.get('\xa9alb').value, 'My Mix - EP');
  assert.equal(playlist.job.zipName, 'My Mix - EP.zip');
  const albumInfo = await run('Album - EP', { normalizeAlbumName: true }, 'playlist');
  assert.equal(albumInfo.tags.get('\xa9alb').value, 'Album');
  assert.equal(albumInfo.job.zipName, 'My Mix - EP.zip');
});

test('embedded and saved covers are independent, including PNG bytes and MP4 types', async () => {
  const artwork = 'https://art.test/source.png/{w}x{h}bb.jpg';
  const { tags: embedded, job } = await run('Album', { coverFormat: 'original', saveCover: true, saveCoverFormat: 'jpg' }, 'album', artwork);
  assert.equal(embedded.get('covr').type, 14);
  assert.deepEqual(embedded.get('covr').value, Buffer.from(PNG));
  assert.equal(requests.length, 2);
  assert.ok(Buffer.from(await job.zip.arrayBuffer()).includes(Buffer.from('cover.jpg')));
  const external = await run('Album', { embed: ['album'], saveCover: true, saveCoverFormat: 'original' }, 'album', artwork);
  assert.ok(!external.tags.has('covr'));
  assert.deepEqual(requests, ['https://art.test/source.png/3000x3000bb.png']);
  assert.ok(Buffer.from(await external.job.zip.arrayBuffer()).includes(Buffer.from('cover.png')));
  const none = await run('Album', { embed: ['album'] });
  assert.ok(!none.tags.has('covr'));
  assert.deepEqual(requests, []);
  const jpeg = await run('Album');
  assert.equal(jpeg.tags.get('covr').type, 13);
});

test('standalone MV tags use the same normalization and embed selection', async () => {
  const mv = resource('Video Album - EP');
  prefs.set('download', { normalizeAlbumName: true, embed: ['album'] });
  requests.length = 0;
  const values = tags(await mvTags(mv, new AbortController().signal));
  assert.equal(values.get('\xa9alb').value, 'Video Album');
  assert.ok(!values.has('covr'));
  assert.deepEqual(requests, []);
});

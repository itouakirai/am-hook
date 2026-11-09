// 下载管理器：专辑、歌单与单曲的批量下载（浏览器内解密），带完整的 iTunes 标签、封面与歌词。
// 与播放条一样常驻（app.mjs 挂载下载中心，见 download-center.mjs），站内跳转时下载不中断；关闭或刷新标签页会中断。
//
// 每首歌：wrapper-lite 取 master → 按设置选音质 → 浏览器内解密（decrypt.js）→ 同时取元数据、封面与歌词 →
// defrag 时由 media.wasm 把标签写进 moov（mp4-tags.mjs）→ 按保存方式保存：
//   zip：整张专辑 / 歌单打成一个 ZIP（不复制数据，见 zip.mjs）；folder：写入选定的本地文件夹（File System Access API）；
//   files：每首歌完成后由浏览器逐个保存。参考 apple-music-downloader 与 amd.wol.moe 的下载设置（设置中心，prefs.mjs）。
//
// 专辑 / 歌单中的 MV（以及单独下载的 MV）同参考实现：wrapper-lite 取 MV master → 按 mvMax / mvAudio 选视频与音轨 →
// mv/engine.mjs 解密、合并并 defrag（标签同样写进 moov，stik 为音乐视频）→ 与歌曲一样保存为 .mp4。
//
//   downloads.add(spec)          spec：{ kind: 'album' | 'playlist' | 'song' | 'music-video', id, country, resource?, tracks?, select?, codec?, variant? }
//                                resource / tracks 为页面已取到的 amp-api 资源（省略时这里获取）；select：只下载这些曲目 id
//                                （省略时为全部歌曲，以及设置允许时的 MV）；codec：覆盖设置中的首选音质；variant：单曲指定的音质（master 的 GROUP-ID）
//   downloads.jobs               全部任务（只读）；job.tasks 为其中各曲目
//   downloads.cancel(job, task?) / retry(job, task?) / remove(job) / clearFinished() / save(job)
//   downloads.onChange(fn)       状态变化（节流）后回调
//   downloads.stats()            { active, queued, done, failed, total, ratio, speed }
//   downloads.folder             保存到文件夹：{ supported, name(), pick() }

import { prefs, classify, pickVariant } from './prefs.mjs';
import { buildIlst, imageType } from './mp4-tags.mjs';
import { buildZip, crc32 } from './zip.mjs';
import { formatPath, formatName, fitFolder, fitFile } from './naming.mjs';
import { ttmlToLrc } from './lrc.mjs';
import { parseMaster, pickMvVideo, pickMvAudio, mvQualityVars } from './mv/hls.mjs';
import { createFragmentScanner, tagValue, DEFECTS } from './alac-check.mjs';

const { AmDecrypt, AmWrapper, AmI18n } = window;
const t = (key, vars) => AmI18n.t(key, vars);
const encoder = new TextEncoder();

/* ---------- amp-api ---------- */
async function amp(path, params) {
  const url = new URL('/amp' + path, location.origin);
  for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== '') url.searchParams.set(key, value);
  let res = await fetch(url);
  // 地区不支持该语言时去掉 l
  if (res.status === 400 && url.searchParams.has('l')) {
    url.searchParams.delete('l');
    res = await fetch(url);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error((data && ((data.errors && data.errors[0] && data.errors[0].detail) || data.msg)) || `HTTP ${res.status}`);
  return data;
}

/** 关联资源下一页（rel.next）全部取完 */
async function allPages(first, next, params) {
  let list = first || [];
  for (let more = next; more;) {
    const page = await amp(more, params);
    list = list.concat(page.data || []);
    more = page.next;
  }
  return list;
}

const playableSong = (r) => r && r.type === 'songs' && r.attributes && r.attributes.playParams;
const playableMv = (r) => r && r.type === 'music-videos' && r.attributes && r.attributes.playParams;
const playable = (r) => playableSong(r) || playableMv(r);
/** 只有一首（一个 MV）的任务：不打包，不建专辑文件夹（保存到文件夹时除外） */
const single = (job) => job.kind === 'song' || job.kind === 'music-video';

/* ---------- 音质 ---------- */
/** 文件名变量 codec / quality / bit_depth / sample_rate */
function qualityVars(v) {
  const { kind, rank } = classify(v);
  const kbps = Number((v.group_id.match(/(?:stereo|atmos)-(\d+)/i) || [])[1]) || 0;
  if (kind === 'alac') {
    const khz = v.sample_rate ? String(v.sample_rate / 1000).replace(/\.0+$/, '') : '';
    return { codec: 'ALAC', quality: ['ALAC', v.bit_depth && `${v.bit_depth}bit`, khz && `${khz}kHz`].filter(Boolean).join(' '),
      bit_depth: v.bit_depth || '', sample_rate: v.sample_rate || '', sample_rate_kHz: khz };
  }
  if (kind === 'atmos') return { codec: 'ATMOS', quality: `Dolby Atmos ${rank >= 1000 ? rank % 1000 : rank}kbps`, bit_depth: '', sample_rate: '', sample_rate_kHz: '' };
  const name = kind.startsWith('he') ? 'HE-AAC' : 'AAC';
  const tag = kind.endsWith('binaural') ? ' Binaural' : kind.endsWith('downmix') ? ' Downmix' : '';
  return { codec: name.replace('-', ''), quality: `${name}${tag} ${kbps}kbps`, bit_depth: '', sample_rate: '', sample_rate_kHz: '' };
}

/* ---------- 封面 ---------- */
/** artwork.url 模板 → 指定格式（jpg / png）与尺寸的下载地址 */
export function coverUrl(template, format, size) {
  if (!template) return '';
  const f = (format === 'source' ? sourceFormat(template) : format) === 'png' ? 'png' : 'jpg';
  // size 为 'original' 时取原始尺寸：{w}x{h}bb（或 {c}）换成 0x0ss；自带其他裁切码（如 SC.DN01）的模板保持裁切，按 3000 取
  let t = template;
  if (size === 'original') {
    if (/\{w\}x\{h\}(\{c\}|bb)/.test(t)) t = t.replace(/\{w\}x\{h\}(\{c\}|bb)/, '0x0ss');
    else size = 3000;
  }
  // 歌曲/专辑的模板多数把扩展名写死（{w}x{h}bb.jpg），没有 {f}，要改写结尾的扩展名才能拿到 png
  // jpg 带上 -100（bb-100.jpg）按 100% 质量转码，不带时约 85%；已有的 -NN 质量后缀先去掉
  return t.replace('{w}', size).replace('{h}', size).replace('{c}', 'bb').replace('{f}', f)
    .replace(/\{[a-z]+\}/g, '').replace(/(-\d{1,3})?\.(jpe?g|png|webp)(?=$|[?#])/i, f === 'jpg' ? '-100.jpg' : '.png');
}

/** 原图格式：取最后一段（{w}x{h}bb.{f}）之前那一段的扩展名；png / tif 等无损格式取 png，其余（含识别不出）取 jpg */
function sourceFormat(template) {
  const m = template.match(/\.([a-z0-9]+)\/[^/]*$/i);
  return m && /^(png|tiff?|bmp|psd)$/i.test(m[1]) ? 'png' : 'jpg';
}

/** 同一张封面在一个任务中只下载一次 */
function fetchCover(cache, url, signal) {
  if (!url) return Promise.resolve(null);
  if (!cache.has(url)) {
    const p = fetch(url, { signal }).then(async (res) => {
      if (!res.ok) throw new Error(`cover HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes, type: imageType(bytes) };
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return cache.get(url);
}

/* ---------- 保存到文件夹（File System Access API），所选文件夹保存在 IndexedDB ---------- */
const DB_NAME = 'am-hook-downloads';
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { db.close(); resolve(req && req.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

let folderHandle;
const folderReady = (async () => {
  try { folderHandle = (await idb('readonly', (s) => s.get('folder'))) || null; } catch { folderHandle = null; }
})();

const folder = {
  supported: typeof window.showDirectoryPicker === 'function',
  name: () => (folderHandle ? folderHandle.name : ''),
  ready: folderReady,
  /** 选择文件夹（需要用户操作触发） */
  async pick() {
    const handle = await window.showDirectoryPicker({ id: 'am-hook-downloads', mode: 'readwrite' });
    folderHandle = handle;
    try { await idb('readwrite', (s) => s.put(handle, 'folder')); } catch {}
    notify();
    return handle;
  },
  async forget() {
    folderHandle = null;
    try { await idb('readwrite', (s) => s.delete('folder')); } catch {}
    notify();
  },
  /** 取得可写的文件夹：没有时让用户选择，已选择的请求写入权限（同样需要在用户操作中调用） */
  async writable() {
    await folderReady;
    if (!folderHandle) return folder.pick();
    const opts = { mode: 'readwrite' };
    if ((await folderHandle.queryPermission(opts)) === 'granted' || (await folderHandle.requestPermission(opts)) === 'granted') return folderHandle;
    throw new Error(t('dlc.folderDenied'));
  },
};

async function dirFor(root, segments, create = true) {
  let dir = root;
  for (const name of segments) dir = await dir.getDirectoryHandle(name, { create });
  return dir;
}

async function fileExists(root, path) {
  try {
    const dir = await dirFor(root, path.slice(0, -1), false);
    await dir.getFileHandle(path[path.length - 1]);
    return true;
  } catch {
    return false;
  }
}

async function writeFile(root, path, data) {
  const dir = await dirFor(root, path.slice(0, -1));
  const handle = await dir.getFileHandle(path[path.length - 1], { create: true });
  const writable = await handle.createWritable();
  try {
    if (data instanceof Blob) await data.stream().pipeTo(writable, { preventClose: true });
    else await writable.write(data);
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
}

/* ---------- 交给浏览器保存（与歌曲页相同：保存期间保留临时文件，任务移除或关闭标签页时再删除） ---------- */
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // 浏览器开始读取之前不能撤销
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/* ---------- 状态 ---------- */
const jobs = [];
const listeners = new Set();
let notifyTimer = 0;
function notify() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = 0;
    for (const fn of listeners) {
      try { fn(); } catch (err) { console.error(err); }
    }
  }, 100);
}

let seq = 0;
const ACTIVE = new Set(['resolving', 'downloading', 'tagging', 'saving']);
const SETTLED = new Set(['done', 'skipped', 'error', 'cancelled']);

/** 下载速度：最近几秒内的字节数 */
const samples = [];
let bytesTotal = 0;
function addBytes(n) {
  bytesTotal += n;
  const now = performance.now();
  samples.push([now, bytesTotal]);
  while (samples.length > 2 && now - samples[0][0] > 4000) samples.shift();
}
function speed() {
  if (samples.length < 2) return 0;
  const [t0, b0] = samples[0];
  const [t1, b1] = samples[samples.length - 1];
  if (performance.now() - t1 > 3000) return 0;
  return t1 > t0 ? ((b1 - b0) * 1000) / (t1 - t0) : 0;
}

export function jobState(job) {
  if (job.state === 'preparing' || job.state === 'packing') return job.state;
  if (job.prepError) return 'error';
  const tasks = job.tasks;
  if (job.cancelled && !tasks.length) return 'cancelled';
  if (tasks.some((x) => ACTIVE.has(x.state))) return 'running';
  if (tasks.some((x) => x.state === 'queued')) return 'queued';
  if (!tasks.length) return 'error';
  if (tasks.every((x) => x.state === 'cancelled')) return 'cancelled';
  if (tasks.some((x) => x.state === 'error' || x.state === 'cancelled')) return tasks.some((x) => x.state === 'done') ? 'partial' : 'error';
  return 'done';
}

/** 任务进度 0–1：已完成曲目 + 进行中曲目的字节比例 */
export function jobProgress(job) {
  const tasks = job.tasks.filter((x) => x.state !== 'cancelled');
  if (!tasks.length) return 0;
  let sum = 0;
  for (const x of tasks) {
    if (x.state === 'done' || x.state === 'skipped') sum += 1;
    else if (x.state === 'downloading' && x.total) sum += 0.95 * (x.done / x.total);
    else if (x.state === 'tagging' || x.state === 'saving') sum += 0.97;
  }
  return sum / tasks.length;
}

/* ---------- 新任务 ---------- */
async function add(spec) {
  const options = prefs.get('download');
  if (spec.codec) options.codec = spec.codec;
  // 只有一首歌的单曲下载不打包
  let mode = options.saveMode;
  if (mode === 'folder' && !folder.supported) mode = 'zip';
  const job = {
    id: `j${++seq}`,
    kind: spec.kind,
    cid: spec.id,
    country: (spec.country || AmI18n.storefront || 'us').toLowerCase(),
    title: (spec.resource && spec.resource.attributes && spec.resource.attributes.name) || spec.title || '',
    subtitle: '',
    artwork: '',
    created: Date.now(),
    options,
    mode,
    variant: spec.variant || '',
    spec,
    state: 'preparing',
    tasks: [],
    folder: [],
    outputs: [],
    covers: new Map(),
    disposers: [],
    ctl: new AbortController(),
    dir: null,
    packed: false,
  };
  // 写入文件夹需要在用户操作（点击）中取得权限，所以先于其他异步操作
  if (mode === 'folder') {
    try {
      job.dir = await folder.writable();
    } catch (err) {
      if (err && err.name === 'AbortError') return null; // 取消了选择
      job.mode = 'zip';
      job.notice = t('dlc.folderFallback', { msg: err.message || String(err) });
    }
  }
  jobs.unshift(job);
  notify();
  prepare(job, spec);
  return job;
}

/** 取得专辑 / 歌单与各曲目的完整元数据，生成曲目任务 */
async function prepare(job, spec) {
  job.state = 'preparing';
  job.prepError = '';
  notify();
  try {
    const cc = job.country;
    const l = job.options.metaLang || (await Promise.resolve(AmI18n.catalogLang(cc)).catch(() => undefined));
    job.lang = l;
    let collection = spec.resource || null;
    let list = spec.tracks || null;
    if (job.kind === 'album' && (!collection || !list)) {
      const data = await amp(`/v1/catalog/${cc}/albums/${job.cid}`, { l, include: 'tracks,artists' });
      collection = data.data && data.data[0];
      if (!collection) throw new Error('album not found');
      const rel = collection.relationships && collection.relationships.tracks;
      list = await allPages(rel && rel.data, rel && rel.next, { l });
    } else if (job.kind === 'playlist' && (!collection || !list)) {
      const data = await amp(`/v1/catalog/${cc}/playlists/${job.cid}`, { l, include: 'tracks,curator', 'limit[tracks]': 300 });
      collection = data.data && data.data[0];
      if (!collection) throw new Error('playlist not found');
      const rel = collection.relationships && collection.relationships.tracks;
      list = await allPages(rel && rel.data, rel && rel.next, { l });
    } else if (single(job) && !list) {
      list = [{ id: String(job.cid), type: job.kind === 'song' ? 'songs' : 'music-videos', attributes: { playParams: {} } }];
    }
    // 位置（歌单中的序号）按原列表计算，再按选择过滤；尚未发行的曲目跳过，没有指定选择时 MV 按设置
    const wanted = (r) => (spec.select ? spec.select.includes(r.id) && playable(r) : playableSong(r) || (job.options.mv && playableMv(r)));
    const entries = list.map((r, i) => ({ r, index: i + 1 })).filter(({ r }) => wanted(r));
    if (!entries.length) throw new Error(t('dlc.noSongs'));
    const ca = (collection && collection.attributes) || {};
    job.title ||= ca.name || '';
    job.collection = {
      name: ca.name || '',
      artist: ca.artistName || ca.curatorName || '',
      id: job.cid,
      artwork: ((ca.editorialArtwork && ca.editorialArtwork.staticDetailSquare) || ca.artwork || {}).url || '',
      // 专辑本身：MV 的 amp-api 资源不一定带所属专辑，这时用它的 UPC、版权与厂牌
      attributes: job.kind === 'album' ? ca : null,
      // 专辑的碟数：所有曲目（不只是选中的）中最大的碟号
      discCount: job.kind === 'album' ? Math.max(1, ...list.map((r) => (r.attributes && r.attributes.discNumber) || 1)) : 0,
      total: list.filter(playable).length,
    };

    // 完整属性（作曲、ISRC、碟号、所属专辑的 UPC / 版权 / 厂牌）一次取 100 首；歌曲与 MV 分开请求
    const meta = new Map();
    for (const type of ['songs', 'music-videos']) {
      const ids = entries.filter(({ r }) => r.type === type).map(({ r }) => r.id);
      for (let i = 0; i < ids.length; i += 100) {
        const data = await amp(`/v1/catalog/${cc}/${type}`, { ids: ids.slice(i, i + 100).join(','), include: 'albums,artists', l });
        for (const song of data.data || []) meta.set(song.id, song);
      }
    }
    job.ctl.signal.throwIfAborted();
    job.tasks = entries.map(({ r, index }) => {
      const song = meta.get(r.id) || r;
      const a = song.attributes || {};
      return {
        id: r.id,
        mv: r.type === 'music-videos',
        index,
        name: a.name || r.id,
        artist: a.artistName || '',
        artwork: (a.artwork && a.artwork.url) || job.collection.artwork,
        song,
        state: 'queued',
        done: 0,
        total: 0,
        attempts: 0,
        quality: '',
        // 下载时检测 ALAC 的结论：{ bad }（缺陷帧数）或 { failed: true }；未检测时为 null
        check: null,
        error: '',
      };
    });
    const first = job.tasks[0].song;
    const fa = first.attributes || {};
    if (single(job)) {
      job.title = fa.name || job.title;
      job.subtitle = fa.artistName || '';
      job.artwork = (fa.artwork && fa.artwork.url) || '';
    } else {
      job.subtitle = job.collection.artist;
      job.artwork = job.collection.artwork || (fa.artwork && fa.artwork.url) || '';
    }
    job.folder = folderPath(job);
    job.state = 'ready';
  } catch (err) {
    job.state = 'ready';
    if (job.ctl.signal.aborted) {
      job.cancelled = true;
    } else {
      job.prepError = (err && err.message) || String(err);
    }
  }
  notify();
  pump();
}

/* ---------- 文件名 ---------- */
function albumOf(song) {
  return (song.relationships && song.relationships.albums && song.relationships.albums.data && song.relationships.albums.data[0]) || null;
}

/** 曲目的标签与文件名变量 */
function trackInfo(job, task) {
  const a = task.song.attributes || {};
  const album = albumOf(task.song);
  const aa = (album && album.attributes) || (job.kind === 'album' && job.collection.attributes) || {};
  const artist = task.song.relationships && task.song.relationships.artists && task.song.relationships.artists.data && task.song.relationships.artists.data[0];
  const playlistTags = job.kind === 'playlist' && !job.options.playlistAlbumInfo;
  const discCount = job.kind === 'album' ? job.collection.discCount : 0;
  return {
    mv: !!task.mv,
    title: a.name || '',
    artist: a.artistName || '',
    album: playlistTags ? job.collection.name : a.albumName || aa.name || '',
    albumArtist: playlistTags ? job.collection.artist : aa.artistName || a.albumArtistName || a.artistName || '',
    composer: a.composerName || '',
    genre: (a.genreNames || [])[0] || '',
    date: a.releaseDate || aa.releaseDate || '',
    track: playlistTags ? [task.index, job.collection.total] : [a.trackNumber || 0, aa.trackCount || 0],
    disc: playlistTags ? [1, 1] : [a.discNumber || 0, discCount],
    copyright: aa.copyright || '',
    label: aa.recordLabel || '',
    upc: aa.upc || '',
    isrc: a.isrc || '',
    rating: a.contentRating === 'explicit' ? 1 : a.contentRating === 'clean' ? 2 : 0,
    songId: task.id,
    albumId: album ? album.id : (job.kind === 'album' ? job.cid : ''),
    artistId: artist ? artist.id : '',
    compilation: !!aa.isCompilation,
    artwork: (a.artwork && a.artwork.url) || aa.artwork && aa.artwork.url || job.collection.artwork,
  };
}

function nameVars(job, task, info, quality) {
  return {
    title: info.title, artist: info.artist, album: info.album, album_artist: info.albumArtist, composer: info.composer, genre: info.genre,
    tracknum: info.track[0] || '', tracktotal: info.track[1] || '', disk: info.disc[0] || '', disktotal: info.disc[1] || '',
    year: (info.date || '').slice(0, 4), release_date: info.date, explicit: info.rating === 1 ? '[E]' : '',
    song_id: info.songId, album_id: info.albumId, artist_id: info.artistId, isrc: info.isrc, upc: info.upc,
    record_label: info.label, copyright: info.copyright,
    playlist: job.kind === 'playlist' ? job.collection.name : '', playlist_id: job.kind === 'playlist' ? job.cid : '',
    curator: job.kind === 'playlist' ? job.collection.artist : '', index: task.index,
    ...quality,
  };
}

/** 任务的文件夹（ZIP 名）：专辑 / 歌单按模板；单曲保存到文件夹时放进其专辑文件夹（同参考实现），单独的 MV 不放 */
function folderPath(job) {
  return fitFolder(templateFolder(job));
}

function templateFolder(job) {
  const o = job.options;
  if (job.kind === 'playlist') return formatPath(o.playlistFolder, { playlist: job.collection.name, playlist_id: job.cid, curator: job.collection.artist });
  if (job.kind === 'music-video') return [];
  // 专辑文件夹按其中的歌曲命名（MV 的属性可能不带所属专辑）
  const task = job.tasks.find((x) => !x.mv) || job.tasks[0];
  const info = trackInfo(job, task);
  const vars = nameVars(job, task, info, {});
  if (job.kind === 'album') return formatPath(o.albumFolder, vars);
  return job.mode === 'folder' ? formatPath(o.albumFolder, vars) : [];
}

function filePath(job, task, info, quality) {
  const o = job.options;
  const template = job.kind === 'album' ? o.songFile : job.kind === 'playlist' ? o.playlistFile : o.singleFile;
  const path = fitFile(job.folder, formatPath(template, nameVars(job, task, info, quality)));
  path[path.length - 1] += task.mv ? '.mp4' : '.m4a';
  return path;
}

/* ---------- 下载一首歌 ---------- */
let running = 0;

function nextTask() {
  // 先建的任务先下载
  for (let i = jobs.length - 1; i >= 0; i--) {
    const job = jobs[i];
    if (job.state !== 'ready' || job.prepError) continue;
    const task = job.tasks.find((x) => x.state === 'queued' && !x.waiting);
    if (task) return [job, task];
  }
  return null;
}

function pump() {
  const limit = prefs.get('download').concurrency;
  while (running < limit) {
    const next = nextTask();
    if (!next) break;
    running++;
    const [job, task] = next;
    runTask(job, task).finally(() => {
      running--;
      settle(job);
      pump();
    });
  }
  notify();
}

async function runTask(job, task) {
  const o = job.options;
  task.ctl = new AbortController();
  const signal = AbortSignal.any ? AbortSignal.any([task.ctl.signal, job.ctl.signal]) : task.ctl.signal;
  if (!AbortSignal.any) job.ctl.signal.addEventListener('abort', () => task.ctl.abort(), { once: true });
  task.attempts++;
  task.error = '';
  task.check = null;
  task.done = 0;
  task.total = 0;
  try {
    task.state = 'resolving';
    notify();
    const info = trackInfo(job, task);
    const result = await (task.mv ? downloadVideo : downloadSong)(job, task, info, signal);
    if (!result) {
      task.state = 'skipped';
      task.saved = true;
      return;
    }
    task.result = result;
    job.disposers.push(() => result.dispose());
    task.state = 'saving';
    notify();
    await deliver(job, task);
    task.state = 'done';
  } catch (err) {
    const aborted = (err && err.name === 'AbortError') || signal.aborted;
    if (task.result) { task.result.dispose(); task.result = null; }
    if (aborted) {
      task.state = 'cancelled';
    } else if (!err.final && task.attempts <= o.retries) {
      // 自动重试：稍等再排队
      task.state = 'queued';
      task.waiting = true;
      task.error = (err && err.message) || String(err);
      setTimeout(() => { task.waiting = false; pump(); }, 1500 * task.attempts);
    } else {
      task.state = 'error';
      task.error = (err && err.message) || String(err);
      console.warn('[am-hook] 下载失败', task.id, err);
    }
  } finally {
    task.ctl = null;
    notify();
  }
}

/** 保存到文件夹且已存在同名文件时跳过 */
async function exists(job, task) {
  return job.mode === 'folder' && job.options.skipExisting && job.dir && fileExists(job.dir, [...job.folder, ...task.path]);
}

/** 封面：拿不到时不影响下载，只是不写入 */
function coverFor(job, info, signal, wanted) {
  return wanted
    ? fetchCover(job.covers, coverUrl(info.artwork, job.options.coverFormat, job.options.coverOriginal ? 'original' : job.options.coverSize), signal).catch((err) => { console.warn('[am-hook] 封面获取失败', err); return null; })
    : Promise.resolve(null);
}

/** 歌曲：按设置选音质 → 浏览器内解密；已存在而跳过时返回 null */
async function downloadSong(job, task, info, signal) {
  const o = job.options;
  const { variants } = await AmWrapper.songMaster(task.id, signal);
  let picked;
  if (job.variant) {
    const v = variants.find((x) => x.group_id === job.variant);
    picked = v ? { variant: v, fallback: false } : null;
  } else picked = pickVariant(variants, o);
  if (!picked) throw Object.assign(new Error(t('dlc.noVariant')), { final: true });
  const v = picked.variant;
  const quality = qualityVars(v);
  task.quality = quality.quality + (picked.fallback ? ` · ${t('dlc.fallback')}` : '');
  task.path = filePath(job, task, info, quality);
  if (await exists(job, task)) return null;

  const track = await AmDecrypt.openTrack(v.url, signal);
  track.repair = o.alacRepair;
  task.total = track.size;
  task.state = 'downloading';
  notify();

  // 封面、歌词与 ALAC 检测（设置中心「下载时检测 ALAC」）与音频同时获取
  const embed = new Set(o.embed);
  // amp-api 明确标出没有歌词（hasLyrics: false）的歌曲不去 wrapper-lite 取；没有这个字段时照常获取
  const noLyrics = task.song && task.song.attributes && task.song.attributes.hasLyrics === false;
  const wantLyrics = (embed.has('lyrics') || o.saveLyrics) && !noLyrics;
  const coverPromise = coverFor(job, info, signal, embed.has('cover'));
  // 另存的封面也与音频同时获取，打包时直接用缓存
  if (o.saveCover && job.kind !== 'playlist') fetchCover(job.covers, coverUrl(info.artwork, o.saveCoverFormat, o.saveCoverOriginal ? 'original' : o.saveCoverSize), signal).catch(() => {});
  const lyricsPromise = wantLyrics ? fetchLyrics(job, task, signal, /atmos|binaural|downmix/i.test(v.group_id)) : Promise.resolve(null);
  const finishCheck = o.alacCheckTag && classify(v).kind === 'alac' ? checkWhileDownloading(task, track, v, o) : null;
  // tags() 在全部分段下载完之后才调用，检测所需的数据这时已经齐了
  const tags = async () => {
    const [cover, lyrics] = await Promise.all([coverPromise, lyricsPromise]);
    const check = finishCheck && finishCheck();
    task.lyrics = lyrics;
    return buildIlst(tagsFor(info, embed, o, cover, lyrics, check ? { [o.alacCheckTagName]: check } : null));
  };

  let last = 0;
  return AmDecrypt.download(track, {
    signal,
    memory: !o.opfs,
    tags,
    onProgress: (done) => {
      addBytes(done - last);
      last = done;
      task.done = done;
      notify();
    },
    onDefrag: () => { task.state = 'tagging'; notify(); },
  });
}

/**
 * 下载 ALAC 时检测原样帧：下载取得的原始分段在解密、修复之前经 track.inspect 交给 createFragmentScanner
 * （alac-check.mjs），不另发请求，结论与「检测 ALAC」相同。返回 finish()：全部分段下载完后调用，
 * 给出写入标签的文字（见 tagValue；检测失败时为 result=error），结论同时记在 task.check，显示在下载中心
 */
function checkWhileDownloading(task, track, v, o) {
  const scanner = createFragmentScanner(track.segments.length);
  const index = new Map(track.segments.map((segment, i) => [segment, i]));
  track.inspect = (piece, bytes) => {
    if (piece.init) scanner.init(bytes);
    else if (index.has(piece)) scanner.segment(index.get(piece), bytes);
  };
  return () => {
    try {
      const result = scanner.result(v);
      task.check = { bad: result.escapes.filter((e) => DEFECTS.has(e.verdict)).length };
      return tagValue(result, { repair: o.alacRepair });
    } catch (err) {
      console.warn('[am-hook] ALAC 检测失败', task.id, err);
      task.check = { failed: true };
      return `result=error; error=${String((err && err.message) || err).replace(/[;=]/g, ' ')}; by=am-hook`;
    } finally {
      notify();
    }
  };
}

/**
 * MV：wrapper-lite 取 master → 按 mvMax / mvAudio 选轨 → mv/engine.mjs 下载、解密、合并并写入标签
 * （封面为 MV 自己的缩略图，同参考实现）；需要 OPFS
 */
async function downloadVideo(job, task, info, signal) {
  const o = job.options;
  if (!AmDecrypt.opfsSupported()) throw Object.assign(new Error(t('set.mvNoOpfs')), { final: true });
  const { masterUrl, masterBody } = await AmWrapper.mvMaster(task.id, signal);
  const master = parseMaster(masterBody, masterUrl);
  const video = pickMvVideo(master.videos, o.mvMax);
  const audio = pickMvAudio(master.audios, o.mvAudio);
  if (!video || !audio) throw Object.assign(new Error(t('dlc.noVariant')), { final: true });
  const quality = mvQualityVars(video, audio);
  task.quality = `MV · ${quality.quality}`;
  task.path = filePath(job, task, info, quality);
  if (await exists(job, task)) return null;

  // MV 引擎（含字幕解析）只在需要时加载
  const { downloadMV } = await import('./mv/engine.mjs');
  task.state = 'downloading';
  notify();
  const embed = new Set(o.embed);
  const coverPromise = coverFor(job, info, signal, embed.has('cover'));
  let last = 0;
  return downloadMV(task.id, video, audio, {
    signal,
    // 打包为 ZIP 时顺便计算 CRC-32，不必再读一遍
    crc: job.mode === 'zip' && !single(job),
    tags: async () => buildIlst(tagsFor(info, embed, o, await coverPromise, null)),
    // 进度按分段计；总大小按已下载的比例估算
    onProgress: (ratio, bytes) => {
      addBytes(bytes - last);
      last = bytes;
      task.done = bytes;
      task.total = ratio > 0 ? Math.max(bytes, Math.round(bytes / ratio)) : 0;
      notify();
    },
    onDefrag: () => { task.state = 'tagging'; notify(); },
  });
}

/** 歌词获取失败（不含没有歌词的 404）时的总尝试次数 */
const LYRICS_ATTEMPTS = 3;

/** 等待 ms 毫秒；取消时立即以 AbortError 结束 */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/**
 * 歌词：wrapper-lite 返回逐字 TTML，按设置转为 LRC（嵌入的也是 LRC）；获取失败时间隔 1 秒、2 秒重试。
 * spatial：下载的是空间音频版本（全景声、双耳、缩混），LRC 按 TTML 的 lyricOffset 推迟；另存的 TTML 原样保留（自带这个偏移）
 */
async function fetchLyrics(job, task, signal, spatial) {
  const o = job.options;
  try {
    const lang = o.lyricsLang || job.lang || undefined;
    let ttml;
    for (let attempt = 1; ; attempt++) {
      try {
        ttml = await AmWrapper.lyrics(task.id, lang, signal);
        break;
      } catch (err) {
        if (signal.aborted || attempt >= LYRICS_ATTEMPTS) throw err;
        console.warn(`[am-hook] 歌词获取失败，${attempt} 秒后重试`, err);
        await wait(1000 * attempt, signal);
      }
    }
    if (!ttml) return null;
    let lrc = '';
    try {
      lrc = ttmlToLrc(ttml, { syllable: o.syllable, translation: o.lyricsTranslation, pronunciation: o.lyricsPronunciation, spatial });
    } catch (err) {
      console.warn('[am-hook] 歌词转换失败', err);
    }
    return { ttml, lrc };
  } catch (err) {
    // 取消时下载本身会结束，这里不再抛出（没有人等待这个 Promise 时会成为未处理的拒绝）
    if (!signal.aborted) console.warn('[am-hook] 歌词获取失败', err);
    return null;
  }
}

/** custom：歌曲的其他自定义字段（如 ALAC 检测结果） */
function tagsFor(info, embed, o, cover, lyrics, custom = null) {
  const on = (f) => embed.has(f);
  return {
    title: on('title') ? info.title : '',
    artist: on('artist') ? info.artist : '',
    album: on('album') ? info.album : '',
    albumArtist: on('album_artist') ? info.albumArtist : '',
    composer: on('composer') ? info.composer : '',
    genre: on('genre') ? info.genre : '',
    date: on('created') ? info.date : '',
    track: on('tracknum') ? info.track : null,
    disc: on('disk') ? info.disc : null,
    lyrics: on('lyrics') && lyrics ? lyrics.lrc : '',
    cover: on('cover') ? cover : null,
    copyright: on('copyright') ? info.copyright : '',
    label: on('record_company') ? info.label : '',
    upc: on('upc') ? info.upc : '',
    isrc: on('isrc') ? info.isrc : '',
    rating: on('rtng') ? info.rating : null,
    songId: on('song_id') ? info.songId : '',
    albumId: on('album_id') ? info.albumId : '',
    artistId: on('artist_id') ? info.artistId : '',
    compilation: on('album') && info.compilation,
    sort: o.sortTags ? { title: info.title, artist: info.artist, album: info.album, albumArtist: info.albumArtist, composer: info.composer } : null,
    // MV：媒体类型为音乐视频；另写参考实现的 PERFORMER 与 RELEASETIME
    mediaType: info.mv ? 6 : 1,
    custom: info.mv ? { PERFORMER: on('artist') ? info.artist : '', RELEASETIME: on('created') ? info.date : '' } : custom,
  };
}

/** MV 页自己下载时的标签，与这里单独下载 MV 的相同：resource 为 music-videos 资源（含 albums、artists 关系） */
export async function mvTags(resource, signal) {
  const options = prefs.get('download');
  const job = { kind: 'music-video', cid: resource.id, options, covers: new Map(), collection: { name: '', artist: '', artwork: '', attributes: null, discCount: 0, total: 1 } };
  const info = trackInfo(job, { id: resource.id, mv: true, index: 1, song: resource });
  const embed = new Set(options.embed);
  const cover = await coverFor(job, info, signal, embed.has('cover'));
  return buildIlst(tagsFor(info, embed, options, cover, null));
}

/** 歌词文件（与歌曲同名、扩展名不同） */
function lyricsFile(job, task) {
  const o = job.options;
  if (!o.saveLyrics || !task.lyrics) return null;
  const text = o.lyricsFormat === 'ttml' ? task.lyrics.ttml : task.lyrics.lrc;
  if (!text) return null;
  const path = [...task.path];
  path[path.length - 1] = path[path.length - 1].replace(/\.m4a$/, `.${o.lyricsFormat}`);
  return { path, data: encoder.encode(text) };
}

/** 一首歌完成后：文件夹模式立即写入并删除临时文件；逐个保存模式交给浏览器；ZIP 模式留到最后打包 */
async function deliver(job, task) {
  const lyrics = lyricsFile(job, task);
  if (job.mode === 'folder' && job.dir) {
    await writeFile(job.dir, [...job.folder, ...task.path], task.result.file);
    if (lyrics) await writeFile(job.dir, [...job.folder, ...lyrics.path], lyrics.data);
    task.result.dispose();
    task.result = null;
    task.saved = true;
  } else if (job.mode === 'files' || single(job)) {
    saveBlob(task.result.file, task.path.join(' - '));
    if (lyrics) saveBlob(new Blob([lyrics.data]), lyrics.path.join(' - '));
    task.saved = true;
  } else {
    task.extra = lyrics;
  }
}

/* ---------- 全部曲目结束后：封面、播放列表与 ZIP ---------- */
function settle(job) {
  if (job.state !== 'ready' || job.packed) return;
  const state = jobState(job);
  if (state === 'running' || state === 'queued') return;
  // 有失败的曲目时等用户决定（重试或仍然保存）；全部完成时自动保存
  if (state === 'done') finalize(job);
  notify();
}

function m3u(job) {
  const lines = ['#EXTM3U'];
  for (const task of job.tasks) {
    if (!(task.state === 'done' || task.state === 'skipped') || !task.path) continue;
    const a = task.song.attributes || {};
    lines.push(`#EXTINF:${Math.round((a.durationInMillis || 0) / 1000)},${a.artistName || ''} - ${a.name || ''}`, task.path.join('/'));
  }
  return encoder.encode(lines.join('\n') + '\n');
}

async function extras(job) {
  const o = job.options;
  const out = [];
  // 专辑 / 歌单的封面；单曲保存到文件夹时为其专辑的封面；单独的 MV 不另存（缩略图已写入标签）
  if (o.saveCover && (!single(job) || (job.kind === 'song' && job.mode === 'folder'))) {
    const song = job.tasks.find((x) => !x.mv);
    const art = job.kind === 'playlist' || !song ? job.collection.artwork : trackInfo(job, song).artwork;
    const cover = await fetchCover(job.covers, coverUrl(art, o.saveCoverFormat, o.saveCoverOriginal ? 'original' : o.saveCoverSize), job.ctl.signal).catch(() => null);
    if (cover) out.push({ path: [`cover.${cover.type === 'png' ? 'png' : 'jpg'}`], data: cover.bytes });
  }
  if (job.kind === 'playlist' && o.m3u) out.push({ path: [`${fitFile(job.folder, [formatName(o.playlistFolder, { playlist: job.collection.name, playlist_id: job.cid, curator: job.collection.artist })])[0]}.m3u8`], data: m3u(job) });
  return out;
}

async function finalize(job, force = false) {
  if (job.packed && !force) return;
  job.packed = true;
  job.state = 'packing';
  notify();
  try {
    const files = await extras(job);
    if (job.mode === 'folder' && job.dir) {
      for (const f of files) await writeFile(job.dir, [...job.folder, ...f.path], f.data);
    } else if (job.mode === 'files' || single(job)) {
      for (const f of files) saveBlob(new Blob([f.data]), f.path.join(' - '));
    } else {
      const entries = [];
      for (const task of job.tasks) {
        if (task.state !== 'done' || !task.result) continue;
        entries.push({ name: task.path.join('/'), data: task.result.file, crc: task.result.crc });
        if (task.extra) entries.push({ name: task.extra.path.join('/'), data: task.extra.data, crc: crc32(task.extra.data) });
      }
      for (const f of files) entries.push({ name: f.path.join('/'), data: f.data, crc: crc32(f.data) });
      job.zip = await buildZip(entries);
      job.zipName = `${job.folder.join(' - ') || 'am-hook'}.zip`;
      saveBlob(job.zip, job.zipName);
    }
    job.saved = true;
  } catch (err) {
    job.packError = (err && err.message) || String(err);
  } finally {
    job.state = 'ready';
    notify();
  }
}

/* ---------- 操作 ---------- */
function cancel(job, task) {
  if (task) {
    if (task.ctl) task.ctl.abort();
    else if (task.state === 'queued') task.state = 'cancelled';
    settle(job);
    notify();
    return;
  }
  job.ctl.abort();
  for (const x of job.tasks) if (x.state === 'queued') x.state = 'cancelled';
  if (job.state === 'preparing') job.cancelled = true;
  notify();
}

function retry(job, task) {
  if (job.prepError || job.cancelled && !job.tasks.length) {
    job.ctl = new AbortController();
    job.cancelled = false;
    prepare(job, job.spec);
    return;
  }
  if (job.ctl.signal.aborted) job.ctl = new AbortController();
  const targets = task ? [task] : job.tasks.filter((x) => x.state === 'error' || x.state === 'cancelled');
  for (const x of targets) {
    x.state = 'queued';
    x.attempts = 0;
    x.error = '';
  }
  job.packed = false;
  job.saved = false;
  job.packError = '';
  pump();
}

function dispose(job) {
  for (const fn of job.disposers.splice(0)) {
    try { fn(); } catch {}
  }
  job.zip = null;
}

function remove(job) {
  cancel(job);
  dispose(job);
  const i = jobs.indexOf(job);
  if (i >= 0) jobs.splice(i, 1);
  notify();
}

function clearFinished() {
  for (const job of [...jobs]) {
    const state = jobState(job);
    if (state !== 'running' && state !== 'queued' && state !== 'preparing' && state !== 'packing') remove(job);
  }
}

/** 再次保存（ZIP 或单曲文件）；有失败曲目时「仍然保存」已完成的部分 */
function save(job) {
  if (job.zip) { saveBlob(job.zip, job.zipName); return; }
  if (single(job) || job.mode === 'files') {
    for (const task of job.tasks) if (task.result) saveBlob(task.result.file, task.path.join(' - '));
    return;
  }
  finalize(job, true);
}

function stats() {
  let active = 0, queued = 0, done = 0, failed = 0, total = 0;
  let progress = 0;
  for (const job of jobs) {
    const state = jobState(job);
    for (const x of job.tasks) {
      if (x.state === 'cancelled') continue;
      total++;
      if (ACTIVE.has(x.state)) active++;
      else if (x.state === 'queued') queued++;
      else if (x.state === 'done' || x.state === 'skipped') done++;
      else if (x.state === 'error') failed++;
    }
    if (state === 'preparing') queued++;
    progress += jobProgress(job) * job.tasks.filter((x) => x.state !== 'cancelled').length;
  }
  return { active, queued, done, failed, total, ratio: total ? progress / total : 0, speed: speed() };
}

export const downloads = {
  get jobs() { return jobs; },
  add,
  cancel,
  retry,
  remove,
  clearFinished,
  save,
  stats,
  jobState,
  jobProgress,
  folder,
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  /** 正在下载或排队中的曲目（id → task），歌曲页、专辑页用来在曲目行上显示进度 */
  taskFor(songId) {
    for (const job of jobs) {
      const task = job.tasks.find((x) => x.id === songId && !SETTLED.has(x.state));
      if (task) return { job, task };
    }
    return null;
  },
  busy() {
    return jobs.some((job) => { const s = jobState(job); return s === 'running' || s === 'queued' || s === 'preparing' || s === 'packing'; });
  },
};

// 设置中修改同时下载数后立即生效
prefs.onChange((section) => { if (section === 'download') pump(); });
// 下载在当前标签页内进行，关闭或刷新会中断
addEventListener('beforeunload', (e) => { if (downloads.busy()) e.preventDefault(); });
// 关闭标签页时删除临时文件（OPFS 中没删掉的，下次由 AmDecrypt.collectGarbage 回收）
addEventListener('pagehide', () => { for (const job of jobs) dispose(job); });

window.AmDownloads = downloads;

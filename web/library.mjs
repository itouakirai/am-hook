// 资料库与歌单（与 music.apple.com 的「资料库」「歌单」相同），全部保存在本浏览器的 IndexedDB 中，服务端不保存任何数据。
// 启动时整库读入内存，读取都是同步的；修改先改内存、立即通知界面，再写入 IndexedDB；
// 同一浏览器的其他标签页经 BroadcastChannel 收到通知后重新读取。IndexedDB 不可用时（如部分隐私模式）只保存在内存中，
// persistent() 为 false，页面据此提示。
//
// 曲目快照 track（资料库中的歌曲 / MV 与歌单中的曲目共用）：
//   { kind: 'song' | 'music-video', id, country, name, artist, artists: [{ name, href }], album, albumId, albumHref,
//     href, artwork, bgColor, duration, explicit }
//   href / albumHref / artists[].href 为本站页面路径（/https://music.apple.com/...），artwork 为 amp-api 的 {w}x{h} 图片模板。
// 资料库条目 item：曲目快照，或
//   专辑 { kind: 'album', id, country, name, artist, artistHref, href, artwork, bgColor, releaseDate, trackCount }
//   Apple Music 歌单 { kind: 'playlist', id: 'pl.…', country, name, curator, href, artwork, bgColor, folderId }
//   喜爱的艺人 { kind: 'artist', id, country, name, href, artwork }（艺人只在喜爱时保存，其余艺人由歌曲、专辑归纳）
//   均带 addedAt 与 favorite（喜爱的时间，毫秒；0 为未喜爱）。键为 `${kind}:${id}`。
// 本地歌单 playlist：{ id: 'p.…', name, description, folderId, favorite, createdAt, updatedAt, tracks: [{ uid, addedAt, ...track }] }
// 歌单文件夹 folder：{ id: 'f.…', name, parentId, createdAt, updatedAt }（可以嵌套；folderId / parentId 为空表示在最上层）
//
// 喜爱（与 Apple Music 相同）：喜爱的条目同时加入资料库；「喜爱的歌曲」歌单由喜爱的歌曲组成，按喜爱时间倒序。
// 删除文件夹时连同其中的子文件夹与歌单一起删除（与 Apple Music 相同）。
//
// 导入 / 导出文件（JSON）：{ format: 'am-hook-library', version: 1, exportedAt, items: [...], playlists: [...], folders: [...] }，
// 导出单个歌单或文件夹时只含这些歌单、文件夹（与文件夹里的 Apple Music 歌单）。favorite、folderId、folders 与艺人条目是
// 后来加入的可选字段，旧版本导入时忽略它们，版本号仍为 1。
// 导入时逐条校验，链接只接受本站的 Apple Music 页面路径，图片只接受 https 地址；指向不存在的文件夹时放到最上层。

export const FORMAT = 'am-hook-library';
export const FORMAT_VERSION = 1;

const DB_NAME = 'am-hook-library';
const DB_VERSION = 2;
const CHANNEL = 'am-hook-library';
/** 单个歌单与整个资料库的上限，避免导入异常文件时占满存储 */
const MAX_TRACKS = 10000;
const MAX_ITEMS = 100000;
const MAX_FOLDERS = 1000;

/** key → item */
const items = new Map();
/** id → playlist */
const lists = new Map();
/** id → folder */
const dirs = new Map();
const listeners = new Set();
let db = null;
let channel = null;

/* ---------- 校验与规范化：本地写入与导入共用，保证存下的数据可以直接放进页面 ---------- */
const SITE_PATH = /^\/https:\/\/music\.apple\.com\/[a-z]{2}\/(?:song|album|music-video|playlist|artist)\/[^\s"'<>\\]*$/;
const ART = /^https:\/\/[^\s"'<>\\()]+$/;
const COLOR = /^[0-9a-f]{6}$/i;
const PLAYLIST_ID = /^p\.[0-9A-Za-z_-]{1,64}$/;
const FOLDER_ID = /^f\.[0-9A-Za-z_-]{1,64}$/;
const CATALOG_PLAYLIST_ID = /^pl\.[0-9A-Za-z_-]{1,64}$/;
const NUMERIC_ID = /^[0-9]{1,20}$/;

const str = (value, max = 300) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const href = (value) => { const s = str(value, 600); return SITE_PATH.test(s) ? s : ''; };
const art = (value) => { const s = str(value, 600); return ART.test(s) ? s : ''; };
const color = (value) => (typeof value === 'string' && COLOR.test(value) ? value.toLowerCase() : '');
const country = (value) => (typeof value === 'string' && /^[a-z]{2}$/i.test(value) ? value.toLowerCase() : 'us');
const time = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback);
const folderRef = (value) => (typeof value === 'string' && FOLDER_ID.test(value) ? value : '');

function cleanTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'music-video' ? 'music-video' : raw.kind === 'song' ? 'song' : '';
  const id = str(raw.id, 20);
  if (!kind || !NUMERIC_ID.test(id)) return null;
  const albumId = str(raw.albumId, 20);
  return {
    kind,
    id,
    country: country(raw.country),
    name: str(raw.name) || id,
    artist: str(raw.artist),
    artists: (Array.isArray(raw.artists) ? raw.artists : []).slice(0, 20)
      .map((a) => a && { name: str(a.name), href: href(a.href) })
      .filter((a) => a && a.name),
    album: str(raw.album),
    albumId: NUMERIC_ID.test(albumId) ? albumId : '',
    albumHref: href(raw.albumHref),
    href: href(raw.href),
    artwork: art(raw.artwork),
    bgColor: color(raw.bgColor),
    duration: Number.isFinite(raw.duration) && raw.duration > 0 ? Math.round(raw.duration) : 0,
    explicit: raw.explicit === true,
  };
}

function cleanItem(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  let item = null;
  if (raw.kind === 'song' || raw.kind === 'music-video') {
    item = cleanTrack(raw);
  } else if (raw.kind === 'album') {
    const id = str(raw.id, 20);
    if (!NUMERIC_ID.test(id)) return null;
    item = {
      kind: 'album', id, country: country(raw.country), name: str(raw.name) || id, artist: str(raw.artist),
      artistHref: href(raw.artistHref), href: href(raw.href), artwork: art(raw.artwork), bgColor: color(raw.bgColor),
      releaseDate: str(raw.releaseDate, 10), trackCount: Number.isInteger(raw.trackCount) && raw.trackCount > 0 ? raw.trackCount : 0,
    };
  } else if (raw.kind === 'playlist') {
    const id = str(raw.id, 70);
    if (!CATALOG_PLAYLIST_ID.test(id)) return null;
    item = {
      kind: 'playlist', id, country: country(raw.country), name: str(raw.name) || id, curator: str(raw.curator),
      href: href(raw.href), artwork: art(raw.artwork), bgColor: color(raw.bgColor), folderId: folderRef(raw.folderId),
    };
  } else if (raw.kind === 'artist') {
    const id = str(raw.id, 20);
    if (!NUMERIC_ID.test(id)) return null;
    item = { kind: 'artist', id, country: country(raw.country), name: str(raw.name) || id, href: href(raw.href), artwork: art(raw.artwork) };
  }
  if (!item) return null;
  item.addedAt = time(raw.addedAt, now);
  item.favorite = time(raw.favorite, 0);
  // 艺人条目只表示「喜爱」，没有喜爱时间的视为无效
  if (item.kind === 'artist' && !item.favorite) return null;
  item.key = keyOf(item.kind, item.id);
  return item;
}

function cleanPlaylist(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const createdAt = time(raw.createdAt, now);
  const uids = new Set();
  const tracks = [];
  for (const entry of (Array.isArray(raw.tracks) ? raw.tracks : []).slice(0, MAX_TRACKS)) {
    const track = cleanTrack(entry);
    if (!track) continue;
    let uid = str(entry.uid, 40);
    if (!/^[0-9A-Za-z_-]{4,40}$/.test(uid) || uids.has(uid)) uid = randomId(12);
    uids.add(uid);
    tracks.push({ uid, addedAt: time(entry.addedAt, createdAt), ...track });
  }
  return {
    id: PLAYLIST_ID.test(raw.id) ? raw.id : `p.${randomId(14)}`,
    name: str(raw.name, 200),
    description: str(raw.description, 4000),
    folderId: folderRef(raw.folderId),
    favorite: time(raw.favorite, 0),
    createdAt,
    updatedAt: Math.max(createdAt, time(raw.updatedAt, createdAt)),
    tracks,
  };
}

function cleanFolder(raw, now) {
  if (!raw || typeof raw !== 'object' || !FOLDER_ID.test(raw.id)) return null;
  const createdAt = time(raw.createdAt, now);
  return {
    id: raw.id,
    name: str(raw.name, 200),
    parentId: folderRef(raw.parentId) === raw.id ? '' : folderRef(raw.parentId),
    createdAt,
    updatedAt: Math.max(createdAt, time(raw.updatedAt, createdAt)),
  };
}

/** crypto.randomUUID 只在安全上下文可用（http://<局域网 IP> 不行），getRandomValues 都可用 */
function randomId(length) {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export const keyOf = (kind, id) => `${kind}:${id}`;

/* ---------- IndexedDB ---------- */
const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const STORES = ['items', 'playlists', 'folders'];

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // 版本 1：items、playlists；版本 2：folders
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('playlists')) d.createObjectStore('playlists', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

async function loadAll() {
  const tx = db.transaction(STORES, 'readonly');
  const [storedItems, storedLists, storedDirs] = await Promise.all(STORES.map((name) => request(tx.objectStore(name).getAll())));
  items.clear();
  lists.clear();
  dirs.clear();
  for (const item of storedItems) items.set(item.key, { favorite: 0, ...item });
  for (const list of storedLists) lists.set(list.id, { folderId: '', favorite: 0, ...list });
  for (const dir of storedDirs) dirs.set(dir.id, dir);
}

/** 依次提交的写入：同一对象存储上的事务按创建顺序执行，后写的不会被先写的覆盖 */
function persist({ putItems = [], deleteItems = [], putLists = [], deleteLists = [], putDirs = [], deleteDirs = [], clear = false }) {
  if (!db) return Promise.resolve();
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORES, 'readwrite');
    } catch (err) {
      console.warn('[am-hook] 资料库写入失败', err);
      resolve();
      return;
    }
    const [itemStore, listStore, dirStore] = STORES.map((name) => tx.objectStore(name));
    if (clear) { itemStore.clear(); listStore.clear(); dirStore.clear(); }
    for (const key of deleteItems) itemStore.delete(key);
    for (const id of deleteLists) listStore.delete(id);
    for (const id of deleteDirs) dirStore.delete(id);
    for (const item of putItems) itemStore.put(item);
    for (const list of putLists) listStore.put(list);
    for (const dir of putDirs) dirStore.put(dir);
    tx.oncomplete = () => {
      if (channel) channel.postMessage('changed');
      resolve();
    };
    tx.onerror = tx.onabort = () => {
      console.warn('[am-hook] 资料库写入失败', tx.error);
      resolve();
    };
  });
}

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error(err); }
  }
}

/** 读入资料库（只进行一次）；失败时保留空的内存资料库 */
export const ready = (async () => {
  try {
    if (!globalThis.indexedDB) throw new Error('IndexedDB unavailable');
    db = await openDb();
    // 其他标签页升级数据库版本时先关闭，避免阻塞
    db.onversionchange = () => { db.close(); db = null; };
    await loadAll();
    if (globalThis.BroadcastChannel) {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = () => { if (db) loadAll().then(emit, (err) => console.warn('[am-hook] 资料库读取失败', err)); };
    }
  } catch (err) {
    db = null;
    console.warn('[am-hook] 资料库只保存在内存中', err);
  }
  emit();
})();

/** 是否保存在 IndexedDB 中（否则关闭标签页后丢失） */
export const persistent = () => !!db;

/** 资料库或歌单变化（含其他标签页的修改）后回调；返回取消函数 */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ---------- 资料库 ---------- */
/** kind 省略时为全部条目 */
export function libraryItems(kind) {
  const all = [...items.values()];
  return kind ? all.filter((item) => item.kind === kind) : all;
}

export const libraryItem = (kind, id) => items.get(keyOf(kind, id)) || null;

/** 是否在资料库中；专辑只要有其中的歌曲就算（与 Apple Music 相同，添加单曲后专辑也出现在资料库里） */
export function inLibrary(kind, id) {
  if (items.has(keyOf(kind, id))) return true;
  if (kind !== 'album') return false;
  for (const item of items.values()) if (item.albumId === id && (item.kind === 'song' || item.kind === 'music-video')) return true;
  return false;
}

/** 添加条目（见文件开头），已有的更新信息、保留添加时间、喜爱与所在文件夹；返回新增的数量 */
export function addToLibrary(records) {
  if (items.size + records.length > MAX_ITEMS) throw new Error('library is full');
  const now = Date.now();
  const puts = [];
  let added = 0;
  for (const raw of records) {
    const old = items.get(keyOf(raw.kind, raw.id));
    // 艺人条目只表示喜爱，新加的艺人在 setFavorite 里写入
    const item = cleanItem({ ...raw, addedAt: undefined, favorite: old ? old.favorite : (raw.kind === 'artist' ? now : 0) }, now);
    if (!item) continue;
    if (old) {
      item.addedAt = old.addedAt;
      if (old.folderId) item.folderId = old.folderId;
    } else {
      added++;
    }
    items.set(item.key, item);
    puts.push(item);
  }
  if (puts.length) { emit(); persist({ putItems: puts }); }
  return added;
}

/** 从资料库删除；专辑连同其中的歌曲与 MV 一起删除（与 Apple Music 的「从资料库中删除」相同）。返回删除的数量 */
export function removeFromLibrary(kind, id) {
  const keys = [keyOf(kind, id)];
  if (kind === 'album') {
    for (const item of items.values()) if (item.albumId === id && (item.kind === 'song' || item.kind === 'music-video')) keys.push(item.key);
  }
  const removed = keys.filter((key) => items.delete(key));
  if (removed.length) { emit(); persist({ deleteItems: removed }); }
  return removed.length;
}

/* ---------- 喜爱 ---------- */
/** 资料库条目（歌曲、MV、专辑、Apple Music 歌单、艺人）是否喜爱 */
export function isFavorite(kind, id) {
  const item = items.get(keyOf(kind, id));
  return !!(item && item.favorite);
}

/**
 * 喜爱 / 取消喜爱资料库条目。条目不在资料库时先加入 records（与 Apple Music 相同，喜爱即加入资料库；
 * 专辑的 records 含其中的曲目）。取消喜爱的艺人从资料库删除（艺人条目只表示喜爱），其余条目保留在资料库中。
 */
export function setFavorite(kind, id, on, records = []) {
  const key = keyOf(kind, id);
  if (on && !items.has(key)) addToLibrary(records);
  const item = items.get(key);
  if (!item) return;
  if (!on && kind === 'artist') { removeFromLibrary(kind, id); return; }
  const next = { ...item, favorite: on ? Date.now() : 0 };
  items.set(key, next);
  emit();
  persist({ putItems: [next] });
}

/** 喜爱的歌曲（「喜爱的歌曲」歌单），最近喜爱的在前 */
export function favoriteSongs() {
  return libraryItems('song').filter((item) => item.favorite).sort((a, b) => b.favorite - a.favorite);
}

/* ---------- 本地歌单 ---------- */
/** 按最近修改排在前面（与「添加到歌单」菜单相同）；sort 为 'name' 时按名称 */
export function playlists(sort = 'updated') {
  const all = [...lists.values()];
  if (sort === 'name') return all.sort((a, b) => a.name.localeCompare(b.name) || b.createdAt - a.createdAt);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export const playlist = (id) => lists.get(id) || null;

function savePlaylist(list, touch = true) {
  if (touch) list.updatedAt = Math.max(Date.now(), list.updatedAt + 1);
  lists.set(list.id, list);
  emit();
  return persist({ putLists: [list] });
}

/** 新建歌单，返回歌单；tracks 为曲目快照，folderId 为所在文件夹 */
export function createPlaylist({ name = '', description = '', tracks = [], folderId = '' } = {}) {
  const now = Date.now();
  const list = cleanPlaylist({ name, description, createdAt: now, updatedAt: now, tracks: tracks.map((track) => ({ ...track, addedAt: now })) }, now);
  list.id = `p.${randomId(14)}`;
  list.folderId = dirs.has(folderId) ? folderId : '';
  lists.set(list.id, list);
  emit();
  persist({ putLists: [list] });
  return list;
}

/** 修改名称、描述 */
export function updatePlaylist(id, { name, description }) {
  const list = lists.get(id);
  if (!list) return;
  const next = { ...list };
  if (name !== undefined) next.name = str(name, 200);
  if (description !== undefined) next.description = str(description, 4000);
  savePlaylist(next);
}

export function deletePlaylist(id) {
  if (!lists.delete(id)) return;
  emit();
  persist({ deleteLists: [id] });
}

/** 喜爱 / 取消喜爱本地歌单（不改变修改时间） */
export function setPlaylistFavorite(id, on) {
  const list = lists.get(id);
  if (list) savePlaylist({ ...list, favorite: on ? Date.now() : 0 }, false);
}

/** 复制歌单（名称加后缀 suffix，放在同一文件夹），返回新歌单 */
export function duplicatePlaylist(id, suffix) {
  const list = lists.get(id);
  if (!list) return null;
  return createPlaylist({ name: `${list.name} ${suffix}`.trim(), description: list.description, tracks: list.tracks, folderId: list.folderId });
}

/**
 * 添加曲目到歌单末尾。与 Apple Music 一样默认跳过歌单里已有的曲目（options.duplicates 为 true 时照样添加）。
 * 返回 { added, skipped }
 */
export function addToPlaylist(id, tracks, { duplicates = false } = {}) {
  const list = lists.get(id);
  if (!list) return { added: 0, skipped: 0 };
  const now = Date.now();
  const have = new Set(list.tracks.map((track) => keyOf(track.kind, track.id)));
  const next = { ...list, tracks: list.tracks.slice() };
  let added = 0;
  let skipped = 0;
  for (const raw of tracks) {
    const track = cleanTrack(raw);
    if (!track) continue;
    const key = keyOf(track.kind, track.id);
    if (!duplicates && have.has(key)) { skipped++; continue; }
    if (next.tracks.length >= MAX_TRACKS) break;
    have.add(key);
    next.tracks.push({ uid: randomId(12), addedAt: now, ...track });
    added++;
  }
  if (added) savePlaylist(next);
  return { added, skipped };
}

/** 按 uid 删除歌单中的曲目（同一首歌可以出现多次，uid 区分各次） */
export function removeFromPlaylist(id, uids) {
  const list = lists.get(id);
  if (!list) return;
  const drop = new Set(uids);
  const tracks = list.tracks.filter((track) => !drop.has(track.uid));
  if (tracks.length !== list.tracks.length) savePlaylist({ ...list, tracks });
}

/** 把下标 from 的曲目移到 to */
export function movePlaylistTrack(id, from, to) {
  const list = lists.get(id);
  if (!list || from === to || from < 0 || to < 0 || from >= list.tracks.length || to >= list.tracks.length) return;
  const tracks = list.tracks.slice();
  tracks.splice(to, 0, ...tracks.splice(from, 1));
  savePlaylist({ ...list, tracks });
}

/* ---------- 歌单文件夹 ---------- */
/** 全部文件夹（按名称） */
export function folders() {
  return [...dirs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt);
}

export const folder = (id) => dirs.get(id) || null;

/** 文件夹的上级链（从最上层到自身）；用于路径显示 */
export function folderPath(id) {
  const path = [];
  for (let dir = dirs.get(id); dir && path.length < MAX_FOLDERS; dir = dirs.get(dir.parentId)) path.unshift(dir);
  return path;
}

/** 文件夹及其全部子文件夹的 id */
function subtree(id) {
  const ids = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const dir of dirs.values()) {
      if (dir.parentId && ids.has(dir.parentId) && !ids.has(dir.id)) { ids.add(dir.id); grew = true; }
    }
  }
  return ids;
}

/**
 * 文件夹的直接内容：{ folders, playlists, catalog }（子文件夹、本地歌单、Apple Music 歌单）；
 * id 为空时为最上层
 */
export function folderChildren(id = '') {
  return {
    folders: folders().filter((dir) => dir.parentId === id),
    playlists: playlists('name').filter((list) => list.folderId === id),
    catalog: libraryItems('playlist').filter((item) => (item.folderId || '') === id),
  };
}

/** 文件夹（含子文件夹）里的歌单数量：{ folders, playlists } */
export function folderCounts(id) {
  const ids = subtree(id);
  ids.delete(id);
  const inside = (folderId) => folderId === id || ids.has(folderId);
  return {
    folders: ids.size,
    playlists: playlists().filter((list) => inside(list.folderId)).length + libraryItems('playlist').filter((item) => inside(item.folderId)).length,
  };
}

/** 新建文件夹，返回文件夹 */
export function createFolder({ name = '', parentId = '' } = {}) {
  if (dirs.size >= MAX_FOLDERS) throw new Error('too many folders');
  const now = Date.now();
  const dir = { id: `f.${randomId(14)}`, name: str(name, 200), parentId: dirs.has(parentId) ? parentId : '', createdAt: now, updatedAt: now };
  dirs.set(dir.id, dir);
  emit();
  persist({ putDirs: [dir] });
  return dir;
}

export function renameFolder(id, name) {
  const dir = dirs.get(id);
  if (!dir) return;
  const next = { ...dir, name: str(name, 200), updatedAt: Date.now() };
  dirs.set(id, next);
  emit();
  persist({ putDirs: [next] });
}

/** 能否把文件夹 id 移到 parentId 中（不能移到自身或自己的子文件夹里） */
export const canMoveFolder = (id, parentId) => !parentId || (dirs.has(parentId) && !subtree(id).has(parentId));

/**
 * 移动到文件夹（folderId 为空时移到最上层）。entry：{ type: 'playlist' | 'catalog' | 'folder', id }，
 * catalog 为添加到资料库的 Apple Music 歌单（id 为 pl.…）。返回是否移动
 */
export function moveToFolder(entry, folderId = '') {
  if (folderId && !dirs.has(folderId)) return false;
  if (entry.type === 'folder') {
    const dir = dirs.get(entry.id);
    if (!dir || dir.parentId === folderId || !canMoveFolder(entry.id, folderId)) return false;
    const next = { ...dir, parentId: folderId, updatedAt: Date.now() };
    dirs.set(dir.id, next);
    emit();
    persist({ putDirs: [next] });
    return true;
  }
  if (entry.type === 'playlist') {
    const list = lists.get(entry.id);
    if (!list || list.folderId === folderId) return false;
    savePlaylist({ ...list, folderId }, false);
    return true;
  }
  const item = items.get(keyOf('playlist', entry.id));
  if (!item || (item.folderId || '') === folderId) return false;
  const next = { ...item, folderId };
  items.set(next.key, next);
  emit();
  persist({ putItems: [next] });
  return true;
}

/** 删除文件夹，连同其中的子文件夹、本地歌单与 Apple Music 歌单（从资料库删除）。返回删除的歌单数 */
export function deleteFolder(id) {
  if (!dirs.has(id)) return 0;
  const ids = subtree(id);
  const dropLists = playlists().filter((list) => ids.has(list.folderId)).map((list) => list.id);
  const dropItems = libraryItems('playlist').filter((item) => ids.has(item.folderId)).map((item) => item.key);
  for (const dirId of ids) dirs.delete(dirId);
  for (const listId of dropLists) lists.delete(listId);
  for (const key of dropItems) items.delete(key);
  emit();
  persist({ deleteDirs: [...ids], deleteLists: dropLists, deleteItems: dropItems });
  return dropLists.length + dropItems.length;
}

/**
 * 导入后修复文件夹引用：指向不存在的文件夹时放到最上层，文件夹之间有环时把环上的一个移到最上层。
 * 返回需要写回的 { putItems, putLists, putDirs }
 */
function repairFolders() {
  const putDirs = [];
  const putLists = [];
  const putItems = [];
  for (const dir of dirs.values()) {
    if (dir.parentId && !dirs.has(dir.parentId)) { dir.parentId = ''; putDirs.push(dir); }
  }
  for (const dir of dirs.values()) {
    const seen = new Set([dir.id]);
    for (let p = dirs.get(dir.parentId); p; p = dirs.get(p.parentId)) {
      if (seen.has(p.id)) { p.parentId = ''; putDirs.push(p); break; }
      seen.add(p.id);
    }
  }
  for (const list of lists.values()) {
    if (list.folderId && !dirs.has(list.folderId)) { list.folderId = ''; putLists.push(list); }
  }
  for (const item of items.values()) {
    if (item.kind === 'playlist' && item.folderId && !dirs.has(item.folderId)) { item.folderId = ''; putItems.push(item); }
  }
  return { putDirs, putLists, putItems };
}

/** 清空资料库与全部歌单、文件夹 */
export function clearAll() {
  items.clear();
  lists.clear();
  dirs.clear();
  emit();
  return persist({ clear: true });
}

/* ---------- 导入与导出 ---------- */
/**
 * 导出数据。scope 省略时为整个资料库；{ playlists: [id] } 为这些歌单；{ folder: id } 为该文件夹及其全部内容
 * （子文件夹、本地歌单，以及其中的 Apple Music 歌单条目；最上层文件夹的 parentId 清空）
 */
export function exportData(scope) {
  const strip = ({ key, ...item }) => item;
  const base = { format: FORMAT, version: FORMAT_VERSION, exportedAt: new Date().toISOString() };
  if (!scope) {
    return {
      ...base,
      items: [...items.values()].sort((a, b) => a.addedAt - b.addedAt).map(strip),
      playlists: playlists().reverse(),
      folders: [...dirs.values()].sort((a, b) => a.createdAt - b.createdAt),
    };
  }
  if (scope.folder) {
    const ids = dirs.has(scope.folder) ? subtree(scope.folder) : new Set();
    return {
      ...base,
      items: libraryItems('playlist').filter((item) => ids.has(item.folderId)).map(strip),
      playlists: playlists().reverse().filter((list) => ids.has(list.folderId)),
      folders: [...ids].map((id) => (id === scope.folder ? { ...dirs.get(id), parentId: '' } : dirs.get(id))),
    };
  }
  return { ...base, items: [], playlists: (scope.playlists || []).map((id) => lists.get(id)).filter(Boolean).map((list) => ({ ...list, folderId: '' })), folders: [] };
}

/**
 * 解析导入文件的文本：校验格式并规范化每一条，无效的条目丢弃。
 * 返回 { items, playlists, folders, dropped }；不是本格式或版本过新时抛出 Error（message 为 'format' / 'version'）。
 */
export function parseImport(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('format'); }
  if (!data || typeof data !== 'object' || data.format !== FORMAT) throw new Error('format');
  if (!Number.isInteger(data.version) || data.version > FORMAT_VERSION) throw new Error('version');
  const now = Date.now();
  const rawItems = Array.isArray(data.items) ? data.items.slice(0, MAX_ITEMS) : [];
  const rawLists = Array.isArray(data.playlists) ? data.playlists.slice(0, 1000) : [];
  const rawDirs = Array.isArray(data.folders) ? data.folders.slice(0, MAX_FOLDERS) : [];
  const parsedItems = rawItems.map((raw) => cleanItem(raw, now)).filter(Boolean);
  const parsedLists = rawLists.map((raw) => cleanPlaylist(raw, now)).filter(Boolean);
  const parsedDirs = rawDirs.map((raw) => cleanFolder(raw, now)).filter(Boolean);
  const rawTracks = rawLists.reduce((sum, raw) => sum + (raw && Array.isArray(raw.tracks) ? raw.tracks.length : 0), 0);
  const keptTracks = parsedLists.reduce((sum, list) => sum + list.tracks.length, 0);
  return {
    items: parsedItems,
    playlists: parsedLists,
    folders: parsedDirs,
    dropped: (rawItems.length - parsedItems.length) + (rawLists.length - parsedLists.length) + (rawDirs.length - parsedDirs.length)
      + Math.max(0, rawTracks - keptTracks),
  };
}

/**
 * 导入 parseImport 的结果。replace 为 true 时先清空现有资料库、歌单与文件夹；
 * 否则合并：资料库条目按键合并（保留较早的添加时间，喜爱取较新的一方），同一 id 的歌单、文件夹保留修改时间较新的一份。
 * 返回 { items, playlists, folders }：实际新增 / 更新的数量
 */
export async function importData(parsed, { replace = false } = {}) {
  if (replace) { items.clear(); lists.clear(); dirs.clear(); }
  const putItems = [];
  const putLists = [];
  const putDirs = [];
  for (const item of parsed.items) {
    const old = items.get(item.key);
    if (old) {
      item.addedAt = Math.min(old.addedAt, item.addedAt);
      item.favorite = Math.max(old.favorite || 0, item.favorite || 0);
      if (item.kind === 'playlist' && !item.folderId) item.folderId = old.folderId || '';
    }
    items.set(item.key, item);
    putItems.push(item);
  }
  for (const dir of parsed.folders || []) {
    const old = dirs.get(dir.id);
    if (old && old.updatedAt >= dir.updatedAt) continue;
    dirs.set(dir.id, dir);
    putDirs.push(dir);
  }
  for (const list of parsed.playlists) {
    const old = lists.get(list.id);
    if (old && old.updatedAt >= list.updatedAt) continue;
    lists.set(list.id, list);
    putLists.push(list);
  }
  const repaired = repairFolders();
  emit();
  await persist({
    clear: replace,
    putItems: [...new Set([...putItems, ...repaired.putItems])],
    putLists: [...new Set([...putLists, ...repaired.putLists])],
    putDirs: [...new Set([...putDirs, ...repaired.putDirs])],
  });
  return { items: putItems.length, playlists: putLists.length, folders: putDirs.length };
}

/* ---------- 页面用的小工具 ---------- */
/** 图片模板 → 指定尺寸的地址 */
export function artUrl(template, w, h = w) {
  return template ? template.replace('{w}', w).replace('{h}', h).replace('{c}', 'bb').replace('{f}', 'jpg') : '';
}

/** 曲目快照 → 播放队列条目（见 AmPlayer.playQueue） */
export function entryOf(track) {
  return {
    track: track.id,
    country: track.country,
    name: track.name,
    artist: track.artist,
    artists: track.artists,
    album: track.album,
    href: track.href,
    albumHref: track.albumHref,
    artwork: artUrl(track.artwork, 600),
    duration: track.duration,
  };
}

/** Apple Music 原始地址（本站页面路径去掉开头的 /） */
export const appleUrl = (path) => (path ? path.slice(1) : '');

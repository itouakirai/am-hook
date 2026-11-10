// 歌词字体：歌词界面（panel.mjs）用的字体与设置中心「播放 › 歌词字体」（views/settings-fonts.mjs）的字体库。
//
// 字体库里的每一项（entry）来自四个地方（origin）：
//   upload   上传的字体文件（ttf / otf / woff / woff2 / ttc，同一家族的多个字重一起上传时合成一项）
//   url      网址：字体文件，或含 @font-face 的 CSS（Google Fonts、cn-font-split 的 result.css 等）
//   catalog  中文网字计划（https://chinese-font.netlify.app）的字体，即它的 result.css
//   local    电脑上已安装的字体（Local Font Access API，或手动输入名称），只记名称，不保存数据
// 字体数据只保存在这个浏览器的 IndexedDB（am-hook-fonts）里：上传的文件整个保存；CSS 字体按 unicode-range 分片，
// 用到哪片（歌词里出现的字）才下载哪片，下载后存入 IndexedDB，以后离线也能用，也可以一次全部下载。
// 每个字面（face）用 CSS Font Loading API 注册为 FontFace（家族名 amhf-<id>），按需加载。
//
//   lyricFonts.ready              载入字体库后 resolve
//   lyricFonts.entries            字体库（按添加时间）
//   lyricFonts.selected()         歌词正在用的一项（null 为默认字体）；select(id | '') 修改
//   lyricFonts.cssFamily(entry)   font-family 的值（不含后备字体）；familyValue() 为歌词界面用的完整值
//   lyricFonts.register(entry)    把字体注册到 document.fonts（重复调用无副作用）
//   lyricFonts.usage(entry)       { files, faces, bytes }：已保存的分片 / 文件数与占用
//   lyricFonts.onChange(fn)       字体库、选择或占用变化后回调 fn(kind)：'library' | 'select' | 'usage'
//   addFiles / addUrl / addCatalog / addLocal / remove / downloadAll  修改字体库
//   queryLocalFonts()             读取已安装的字体（按家族分组），不支持时抛出 { code: 'unsupported' }

const DB_NAME = 'am-hook-fonts';
const SELECT_KEY = 'am-hook:lyrics-font';
const PREFS_KEY = 'am-hook:lyrics-prefs';
const CHANNEL = 'am-hook-fonts';
/** 中文网字计划的 CDN（旧域名 chinese-fonts-cdn 即将退役） */
export const CATALOG_CDN = 'https://cn-font.claude-code-best.win/packages';
export const CATALOG_SITE = 'https://chinese-font.netlify.app';
export const FONT_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2', '.ttc', '.otc'];
/** 单个字体文件的上限（CJK 全字库一般 10–30 MB） */
const MAX_FILE = 80 * 1024 * 1024;

export const alias = (id) => `amhf-${id}`;
const quote = (family) => `"${String(family).replace(/["\\]/g, '\\$&')}"`;

/* ---------- IndexedDB：fonts（字体库，键为 id）与 files（字体数据，键为 `${id}/${字面序号}`） ---------- */
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const d = request.result;
        if (!d.objectStoreNames.contains('fonts')) d.createObjectStore('fonts', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}
const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function tx(stores, mode, fn) {
  const d = await db();
  const t = d.transaction(stores, mode);
  const result = fn(...[].concat(stores).map((name) => t.objectStore(name)));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new DOMException('aborted', 'AbortError'));
  });
  return result;
}
const fileRange = (id) => IDBKeyRange.bound(`${id}/`, `${id}/\uffff`);
const fileKey = (id, index) => `${id}/${index}`;

/** 一个字体的已保存数据：Map(字面序号 → Blob) */
async function filesOf(id) {
  const d = await db();
  const store = d.transaction('files').objectStore('files');
  const [keys, values] = await Promise.all([done(store.getAllKeys(fileRange(id))), done(store.getAll(fileRange(id)))]);
  return new Map(keys.map((key, i) => [Number(String(key).split('/')[1]), values[i]]));
}

/* ---------- 变化通知（本页与其他标签页） ---------- */
const listeners = new Set();
function emit(kind, { broadcast = true } = {}) {
  for (const fn of listeners) {
    try { fn(kind); } catch (error) { console.error(error); }
  }
  if (broadcast && kind !== 'select') channel?.postMessage(kind);
}
let channel = null;
try { channel = new BroadcastChannel(CHANNEL); } catch { /* 不支持时只在本页生效 */ }
channel?.addEventListener('message', async ({ data }) => {
  if (data === 'library') await reload();
  else if (data === 'usage') { for (const entry of entries) usageCache.delete(entry.id); }
  emit(data, { broadcast: false });
});
addEventListener('storage', (event) => {
  if (event.key !== SELECT_KEY) return;
  const entry = lyricFonts.selected();
  if (entry) register(entry).catch(() => {});
  emit('select', { broadcast: false });
});

/* ---------- 字体库 ---------- */
let entries = [];
async function reload() {
  try {
    const list = await tx('fonts', 'readonly', (store) => done(store.getAll()));
    entries = list.sort((a, b) => a.added - b.added);
  } catch (error) {
    console.warn('[am-hook] 读取字体库失败', error);
    entries = [];
  }
  return entries;
}
async function put(entry) {
  await tx('fonts', 'readwrite', (store) => store.put(entry));
  const i = entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) entries[i] = entry; else entries.push(entry);
  emit('library');
  return entry;
}
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 选择保存为 { id, family }：family 是它的 font-family，字体库还没从 IndexedDB 读出来时歌词界面先用它 */
function savedSelection() {
  try { return JSON.parse(localStorage.getItem(SELECT_KEY) || 'null') || {}; } catch { return {}; }
}
const selectedId = () => savedSelection().id || '';

/* ---------- 注册到 document.fonts ---------- */
/** id → { faces: FontFace[], urls: blob URL[], ready: Promise } */
const registered = new Map();
/** FontFace → { id, index, url, saved }：按需加载完成后把分片存进 IndexedDB */
const faceInfo = new WeakMap();

async function register(entry) {
  if (!entry || entry.origin === 'local') return;
  if (registered.has(entry.id)) return registered.get(entry.id).ready;
  const record = { faces: [], urls: [], ready: null };
  registered.set(entry.id, record);
  record.ready = (async () => {
    const saved = await filesOf(entry.id).catch(() => new Map());
    entry.faces.forEach((face, index) => {
      const blob = saved.get(index);
      let source;
      if (blob) {
        const url = URL.createObjectURL(blob);
        record.urls.push(url);
        source = `url("${url}")${face.format ? ` format("${face.format}")` : ''}`;
      } else if (face.url) {
        source = `url(${JSON.stringify(face.url)})${face.format ? ` format("${face.format}")` : ''}`;
      } else {
        return; // 文件丢失（被浏览器清理）
      }
      const descriptors = { style: face.style || 'normal', weight: String(face.weight || '400'), display: 'swap' };
      if (face.unicodeRange) descriptors.unicodeRange = face.unicodeRange;
      if (face.stretch) descriptors.stretch = face.stretch;
      let fontFace;
      try {
        fontFace = new FontFace(alias(entry.id), source, descriptors);
      } catch (error) {
        console.warn('[am-hook] 字体字面无效', entry.name, error);
        return;
      }
      faceInfo.set(fontFace, { id: entry.id, index, url: face.url, saved: !!blob });
      document.fonts.add(fontFace);
      record.faces.push(fontFace);
    });
  })();
  return record.ready;
}

function unregister(id) {
  const record = registered.get(id);
  if (!record) return;
  registered.delete(id);
  for (const face of record.faces) document.fonts.delete(face);
  for (const url of record.urls) URL.revokeObjectURL(url);
}

/** 按需加载的分片：浏览器加载完成后再取一次（命中 HTTP 缓存）存进 IndexedDB */
const pendingSaves = new Set();
let usageTimer = 0;
function usageChanged(id) {
  usageCache.delete(id);
  clearTimeout(usageTimer);
  usageTimer = setTimeout(() => emit('usage'), 400);
}
document.fonts.addEventListener('loadingdone', (event) => {
  for (const face of event.fontfaces) {
    const info = faceInfo.get(face);
    if (!info || info.saved || !info.url || pendingSaves.has(face)) continue;
    pendingSaves.add(face);
    saveFace(info.id, info.index, info.url)
      .then((ok) => { if (ok) info.saved = true; })
      .catch((error) => console.warn('[am-hook] 字体分片保存失败', error))
      .finally(() => pendingSaves.delete(face));
  }
});

async function saveFace(id, index, url, signal) {
  const response = await fetch(url, { cache: 'force-cache', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  // 下载期间被删除的字体不再保存
  if (!entries.some((e) => e.id === id)) return false;
  await tx('files', 'readwrite', (store) => store.put(blob, fileKey(id, index)));
  usageChanged(id);
  return true;
}

/* ---------- 占用 ---------- */
const usageCache = new Map();
async function usage(entry) {
  if (entry.origin === 'local') return { files: 0, faces: 0, bytes: 0 };
  if (!usageCache.has(entry.id)) {
    usageCache.set(entry.id, filesOf(entry.id).then((files) => {
      let bytes = 0;
      for (const blob of files.values()) bytes += blob.size || 0;
      return { files: files.size, faces: entry.faces.length, bytes };
    }).catch(() => ({ files: 0, faces: entry.faces.length, bytes: 0 })));
  }
  return usageCache.get(entry.id);
}

/* ---------- 解析字体文件：家族名、子家族名、字重、斜体、可变字重轴 ---------- */
const tag4 = (view, offset) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 表目录：tag → () => Promise<DataView>；woff2 的表经过 Brotli 压缩，读不了，返回 null */
async function sfntTables(buffer) {
  const view = new DataView(buffer);
  const magic = view.getUint32(0);
  if (magic === 0x774f4632) return { format: 'woff2', tables: null };
  if (magic === 0x774f4646) {
    const count = view.getUint16(12);
    const tables = {};
    for (let i = 0; i < count; i++) {
      const at = 44 + i * 20;
      const offset = view.getUint32(at + 4);
      const compressed = view.getUint32(at + 8);
      const length = view.getUint32(at + 12);
      tables[tag4(view, at)] = async () => {
        const slice = new Uint8Array(buffer, offset, compressed);
        const bytes = compressed < length ? await inflate(slice) : slice;
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      };
    }
    return { format: 'woff', tables };
  }
  let base = 0;
  let format = magic === 0x4f54544f ? 'opentype' : 'truetype';
  if (magic === 0x74746366) { // ttcf：取第一个字体
    base = view.getUint32(12);
    format = 'collection';
  } else if (magic !== 0x00010000 && magic !== 0x4f54544f && magic !== 0x74727565) {
    throw Object.assign(new Error('not a font'), { code: 'notFont' });
  }
  const count = view.getUint16(base + 4);
  const tables = {};
  for (let i = 0; i < count; i++) {
    const at = base + 12 + i * 16;
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    tables[tag4(view, at)] = async () => new DataView(buffer, offset, Math.min(length, buffer.byteLength - offset));
  }
  return { format, tables };
}

const ZH_LANGS = new Set([0x0804, 0x0404, 0x0c04, 0x1004, 0x1404]);
const JA_KO_LANGS = new Set([0x0411, 0x0412]);
function readNames(view) {
  const count = view.getUint16(2);
  const strings = view.getUint16(4);
  const found = {};
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    const platform = view.getUint16(at);
    const lang = view.getUint16(at + 4);
    const nameId = view.getUint16(at + 6);
    const length = view.getUint16(at + 8);
    const offset = strings + view.getUint16(at + 10);
    if (![1, 2, 4, 16, 17].includes(nameId) || offset + length > view.byteLength) continue;
    let text = '';
    if (platform === 3 || platform === 0) {
      for (let j = 0; j + 1 < length; j += 2) text += String.fromCharCode(view.getUint16(offset + j));
    } else if (platform === 1 && lang === 0) {
      for (let j = 0; j < length; j++) text += String.fromCharCode(view.getUint8(offset + j));
    } else continue;
    text = text.replace(/\0/g, '').trim();
    if (!text) continue;
    // 0：英文，1：中文，2：日文 / 韩文
    const kind = platform === 3 && ZH_LANGS.has(lang) ? 'zh' : platform === 3 && JA_KO_LANGS.has(lang) ? 'cjk' : (platform === 3 && lang === 0x0409) || platform === 1 ? 'en' : 'other';
    (found[nameId] ||= {})[kind] ||= text;
  }
  const pick = (id, prefer) => {
    const names = found[id];
    if (!names) return '';
    for (const kind of prefer) if (names[kind]) return names[kind];
    return Object.values(names)[0];
  };
  return { found, pick };
}

const WEIGHT_WORDS = [
  [/hairline|thin/i, 100], [/extra[-\s]?light|ultra[-\s]?light/i, 200], [/semi[-\s]?light|demi[-\s]?light/i, 350], [/light/i, 300],
  [/medium/i, 500], [/semi[-\s]?bold|demi[-\s]?bold/i, 600], [/extra[-\s]?bold|ultra[-\s]?bold/i, 800],
  [/black|heavy/i, 900], [/bold/i, 700], [/细体|細體/, 300], [/中黑|中粗/, 500], [/粗体|粗體/, 700], [/特粗|超粗/, 900],
];
/** 没法读取时从名称里猜：字重、斜体、是否可变字体 */
export function guessStyle(name) {
  const text = String(name);
  const weight = WEIGHT_WORDS.find(([pattern]) => pattern.test(text))?.[1] ?? 400;
  return {
    weight: /(^|[-_\s])(vf|variable)([-_\s.]|$)/i.test(text) ? '100 900' : String(weight),
    style: /italic|oblique|斜/i.test(text) ? 'italic' : 'normal',
  };
}

/** 读取字体文件的信息：{ format, family, familyEn, subfamily, weight, style }，读不到的项按文件名猜 */
export async function fontInfo(buffer, fileName = '') {
  const base = fileName.replace(/\.[^.]+$/, '');
  const guessed = guessStyle(base);
  const { format, tables } = await sfntTables(buffer);
  const info = { format, family: base, familyEn: base, subfamily: '', weight: guessed.weight, style: guessed.style };
  if (!tables) return info;
  const zhFirst = ['zh', 'cjk', 'en', 'other'];
  if (tables.name) {
    try {
      const { pick } = readNames(await tables.name());
      info.family = pick(16, zhFirst) || pick(1, zhFirst) || base;
      info.familyEn = pick(16, ['en', 'other', 'zh', 'cjk']) || pick(1, ['en', 'other', 'zh', 'cjk']) || info.family;
      info.subfamily = pick(17, ['en', 'other', 'zh', 'cjk']) || pick(2, ['en', 'other', 'zh', 'cjk']) || '';
    } catch { /* 名称表损坏时用文件名 */ }
  }
  if (tables['OS/2']) {
    try {
      const os2 = await tables['OS/2']();
      const weight = os2.getUint16(4);
      if (weight >= 1 && weight <= 1000) info.weight = String(weight);
      info.style = os2.getUint16(62) & 1 ? 'italic' : (/italic|oblique/i.test(info.subfamily) ? 'italic' : 'normal');
    } catch { /* 用猜的 */ }
  }
  if (tables.fvar) {
    try {
      const fvar = await tables.fvar();
      const axesAt = fvar.getUint16(4);
      const axisCount = fvar.getUint16(8);
      const axisSize = fvar.getUint16(10);
      for (let i = 0; i < axisCount; i++) {
        const at = axesAt + i * axisSize;
        if (tag4(fvar, at) !== 'wght') continue;
        const min = Math.round(fvar.getInt32(at + 4) / 65536);
        const max = Math.round(fvar.getInt32(at + 12) / 65536);
        if (min > 0 && max >= min) info.weight = min === max ? String(min) : `${min} ${max}`;
      }
    } catch { /* 当作静态字体 */ }
  }
  return info;
}

/* ---------- 解析 @font-face CSS ---------- */
/** 取出 CSS 里的 @font-face，返回出现最多的家族的字面 [{ url, format, weight, style, stretch, unicodeRange }] */
export function parseFontCss(text, baseUrl) {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const faces = [];
  for (const [, body] of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const decl = {};
    for (const [, key, value] of body.matchAll(/([\w-]+)\s*:\s*((?:url\([^)]*\)|"[^"]*"|'[^']*'|[^;])+)/g)) decl[key.toLowerCase()] = value.trim();
    if (!decl.src) continue;
    let chosen = null;
    for (const match of decl.src.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)\s*(?:format\(\s*['"]?([\w-]+)['"]?\s*\))?/g)) {
      const raw = match[2];
      const format = (match[3] || '').toLowerCase();
      if (format && !['woff2', 'woff', 'truetype', 'opentype', 'collection', 'woff2-variations', 'truetype-variations'].includes(format)) continue;
      let url;
      try { url = new URL(raw, baseUrl).href; } catch { continue; }
      chosen = { url, format: format.replace('-variations', '') };
      break;
    }
    if (!chosen) continue;
    faces.push({
      family: (decl['font-family'] || '').replace(/^['"]|['"]$/g, ''),
      ...chosen,
      weight: (decl['font-weight'] || '400').replace(/\bnormal\b/, '400').replace(/\bbold\b/, '700'),
      style: /italic|oblique/.test(decl['font-style'] || '') ? 'italic' : 'normal',
      ...(decl['font-stretch'] ? { stretch: decl['font-stretch'] } : {}),
      ...(decl['unicode-range'] ? { unicodeRange: decl['unicode-range'] } : {}),
    });
  }
  const counts = new Map();
  for (const face of faces) counts.set(face.family, (counts.get(face.family) || 0) + 1);
  const family = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { family: family || '', faces: faces.filter((face) => face.family === family).map(({ family: _, ...face }) => face) };
}

/** 取一个 CSS 并解析；CSS 里的相对地址按跳转后的最终地址解析 */
const cssCache = new Map();
export function fetchFontCss(url, signal) {
  if (!cssCache.has(url)) {
    const promise = fetch(url, { signal }).then(async (response) => {
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'http', status: response.status });
      const parsed = parseFontCss(await response.text(), response.url || url);
      if (!parsed.faces.length) throw Object.assign(new Error('no @font-face'), { code: 'noFaces' });
      return parsed;
    });
    cssCache.set(url, promise);
    promise.catch(() => cssCache.delete(url));
  }
  return cssCache.get(url);
}

/* ---------- 预览：临时注册（不保存），用于中文网字计划的字体详情 ---------- */
let previewFaces = [];
export async function previewCss(url, signal) {
  const { faces } = await fetchFontCss(url, signal);
  for (const face of previewFaces) document.fonts.delete(face);
  previewFaces = faces.map((face) => {
    const descriptors = { style: face.style, weight: face.weight, display: 'swap' };
    if (face.unicodeRange) descriptors.unicodeRange = face.unicodeRange;
    const fontFace = new FontFace('amhf-preview', `url(${JSON.stringify(face.url)})${face.format ? ` format("${face.format}")` : ''}`, descriptors);
    document.fonts.add(fontFace);
    return fontFace;
  });
  return 'amhf-preview';
}

/* ---------- 修改字体库 ---------- */
function fontError(code, extra = {}) {
  return Object.assign(new Error(code), { code, ...extra });
}

/** 上传的文件：同一家族（名称表的英文家族名）的多个文件合成一项。返回 { added: entry[], failed: [{ name, code }] } */
async function addFiles(files) {
  const groups = new Map();
  const failed = [];
  for (const file of files) {
    try {
      if (file.size > MAX_FILE) throw fontError('tooLarge');
      const buffer = await file.arrayBuffer();
      const info = await fontInfo(buffer, file.name);
      // 先试着交给浏览器解析一次（OTS 会拒绝损坏或不支持的字体）
      await new FontFace('amhf-probe', buffer).load();
      const key = info.familyEn.toLowerCase();
      if (!groups.has(key)) groups.set(key, { info, files: [] });
      groups.get(key).files.push({ file, info });
    } catch (error) {
      failed.push({ name: file.name, code: error.code || 'invalid' });
    }
  }
  const added = [];
  for (const { info, files: list } of groups.values()) {
    const id = newId();
    list.sort((a, b) => parseInt(a.info.weight, 10) - parseInt(b.info.weight, 10));
    const entry = {
      id, origin: 'upload', added: Date.now(),
      name: info.family,
      fileNames: list.map(({ file }) => file.name),
      faces: list.map(({ info: face }) => ({ weight: face.weight, style: face.style, format: face.format === 'collection' ? 'collection' : face.format, label: face.subfamily })),
    };
    await tx('files', 'readwrite', (store) => list.forEach(({ file }, i) => store.put(file.slice(0, file.size, file.type || 'font/sfnt'), fileKey(id, i))));
    usageCache.delete(id);
    added.push(await put(entry));
  }
  if (added.length) requestPersist();
  return { added, failed };
}

/** 网址：CSS（含 @font-face）或字体文件（下载后保存）。name 省略时取 CSS 的家族名或文件名 */
async function addUrl(raw, { name, origin = 'url', page } = {}) {
  let url;
  try { url = new URL(raw.trim(), location.href).href; } catch { throw fontError('badUrl'); }
  if (!/^(https?|data):/.test(url)) throw fontError('badUrl');
  const existing = entries.find((e) => e.url === url);
  if (existing) return existing;
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw fontError('cors');
  }
  if (!response.ok) throw fontError('http', { status: response.status });
  const type = response.headers.get('content-type') || '';
  const buffer = await response.arrayBuffer();
  const head = new TextDecoder().decode(buffer.slice(0, 4096));
  const id = newId();
  if (/css/.test(type) || /\.css(\?|$)/i.test(url) || /@font-face|@import/i.test(head)) {
    const parsed = parseFontCss(new TextDecoder().decode(buffer), response.url || url);
    if (!parsed.faces.length) throw fontError('noFaces');
    cssCache.set(url, Promise.resolve(parsed));
    return put({ id, origin, added: Date.now(), url, page, name: name || parsed.family || new URL(url).hostname, faces: parsed.faces });
  }
  if (buffer.byteLength > MAX_FILE) throw fontError('tooLarge');
  const fileName = decodeURIComponent(new URL(response.url || url).pathname.split('/').pop() || 'font');
  let info;
  try {
    info = await fontInfo(buffer, fileName);
    await new FontFace('amhf-probe', buffer).load();
  } catch {
    throw fontError('notFont');
  }
  await tx('files', 'readwrite', (store) => store.put(new Blob([buffer], { type: type || 'font/sfnt' }), fileKey(id, 0)));
  requestPersist();
  return put({
    id, origin, added: Date.now(), url, name: name || info.family,
    faces: [{ url, weight: info.weight, style: info.style, format: info.format === 'collection' ? 'collection' : info.format, label: info.subfamily }],
  });
}

/** 中文网字计划的一个字体：{ name, pkg, dir } */
const catalogCss = ({ pkg, dir }) => `${CATALOG_CDN}/${encodeURIComponent(pkg)}/dist/${encodeURIComponent(dir)}/result.css`;
async function addCatalog(item) {
  const entry = await addUrl(catalogCss(item), {
    name: item.label ? `${item.name} ${item.label}` : item.name,
    origin: 'catalog',
    page: `${CATALOG_SITE}/zh-cn/fonts/${encodeURIComponent(item.pkg)}/${encodeURIComponent(item.dir)}`,
  });
  requestPersist();
  return entry;
}

/** 已安装的字体：只记家族名（样式按歌词的字重由系统选择） */
async function addLocal(family, styles = []) {
  const name = family.trim();
  if (!name) throw fontError('empty');
  const existing = entries.find((e) => e.origin === 'local' && e.family.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  return put({ id: newId(), origin: 'local', added: Date.now(), name, family: name, styles, faces: [] });
}

async function remove(id) {
  unregister(id);
  await tx(['fonts', 'files'], 'readwrite', (fonts, files) => { fonts.delete(id); files.delete(fileRange(id)); });
  entries = entries.filter((e) => e.id !== id);
  usageCache.delete(id);
  if (selectedId() === id) select('');
  emit('library');
}

/** 把 CSS 字体还没保存的分片全部下载（离线可用）；onProgress(已保存, 总数) */
async function downloadAll(id, { signal, onProgress } = {}) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  const saved = await filesOf(id);
  const todo = entry.faces.map((face, index) => ({ face, index })).filter(({ face, index }) => face.url && !saved.has(index));
  let count = entry.faces.length - todo.length;
  onProgress?.(count, entry.faces.length);
  let failed = 0;
  const worker = async () => {
    while (todo.length) {
      if (signal?.aborted) throw signal.reason || new DOMException('aborted', 'AbortError');
      const { face, index } = todo.shift();
      try {
        await saveFace(id, index, face.url, signal);
        count += 1;
        onProgress?.(count, entry.faces.length);
      } catch (error) {
        if (signal?.aborted) throw error;
        failed += 1;
      }
    }
  };
  // 已注册的字面仍指向网络地址（命中 HTTP 缓存），下次打开页面时改用保存的数据
  await Promise.all(Array.from({ length: 6 }, worker));
  usageChanged(id);
  if (failed) throw fontError('partial', { failed });
}

/** 请求持久化存储，避免浏览器在空间不足时清理字体（Chromium 静默决定；不会弹窗的浏览器才自动请求） */
let persistAsked = false;
function requestPersist() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  if (!/Firefox\//.test(navigator.userAgent)) navigator.storage.persist().catch(() => {});
}

/* ---------- 已安装的字体 ---------- */
/** Local Font Access API：[{ family, styles: [{ style, fullName, postscriptName }] }]，按家族名排序 */
async function queryLocalFonts() {
  if (typeof window.queryLocalFonts !== 'function') throw fontError('unsupported');
  let list;
  try {
    list = await window.queryLocalFonts();
  } catch (error) {
    throw fontError(error?.name === 'SecurityError' || error?.name === 'NotAllowedError' ? 'denied' : 'failed');
  }
  const families = new Map();
  for (const font of list) {
    if (!families.has(font.family)) families.set(font.family, { family: font.family, styles: [] });
    families.get(font.family).styles.push({ style: font.style, fullName: font.fullName, postscriptName: font.postscriptName });
  }
  return [...families.values()].sort((a, b) => a.family.localeCompare(b.family));
}

/** 用画布量宽度判断某个家族名是否可用（与三种通用字体都不同才算可用） */
let probeCanvas = null;
export function isInstalled(family) {
  probeCanvas ||= document.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmwwwwwww永字八法あア가ÆΩ';
  return ['monospace', 'serif', 'sans-serif'].some((generic) => {
    probeCanvas.font = `72px ${generic}`;
    const base = probeCanvas.measureText(sample).width;
    probeCanvas.font = `72px ${quote(family)}, ${generic}`;
    return probeCanvas.measureText(sample).width !== base;
  });
}

/* ---------- 选择 ---------- */
function select(id) {
  const entry = id && entries.find((e) => e.id === id);
  try {
    if (entry) localStorage.setItem(SELECT_KEY, JSON.stringify({ id, family: lyricFonts.cssFamily(entry) }));
    else localStorage.removeItem(SELECT_KEY);
  } catch { /* 只在本次会话生效 */ }
  if (entry) register(entry).catch(() => {});
  emit('select');
}

/** 歌词的字重（panel.mjs 的歌词选项），预览按它显示 */
export function lyricsWeight() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}').weight || 600; } catch { return 600; }
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? (bytes / 1024 ** i < 10 ? 1 : 0) : 0)} ${units[i]}`;
}

export const lyricFonts = {
  ready: null,
  get entries() { return entries; },
  selected() {
    const id = selectedId();
    return (id && entries.find((e) => e.id === id)) || null;
  },
  select,
  cssFamily(entry) {
    if (!entry) return '';
    return entry.origin === 'local' ? quote(entry.family) : quote(alias(entry.id));
  },
  /** 歌词界面的 font-family：选定的字体，缺字时依次用默认字体（--lyrics-system-font，见 app.css） */
  familyValue() {
    const saved = savedSelection();
    const family = loaded ? this.cssFamily(this.selected()) : (saved.id && saved.family) || '';
    return family ? `${family}, var(--lyrics-system-font)` : '';
  },
  /** 某个字面是否属于选定的字体（歌词界面据此在加载完成后重新排版） */
  isSelectedFace(face) {
    const entry = this.selected();
    return !!entry && (faceInfo.get(face)?.id === entry.id || face.family.replace(/^["']|["']$/g, '') === alias(entry.id));
  },
  /**
   * 先加载选定字体里显示这段文字要用的字面（网络字体只下载 unicode-range 与文字相交的分片），最多等 timeout 毫秒。
   * 歌词界面等它完成后再排版，避免分片陆续到达时一次次重新排版
   */
  async prepare(text, weight = lyricsWeight(), timeout = 3000) {
    await this.ready;
    const entry = this.selected();
    if (!entry || entry.origin === 'local' || !text) return;
    // 空格也要：它常在单独的拉丁分片里
    const chars = [...new Set(text.replace(/\s/g, ' '))].join('');
    const load = register(entry).then(() => document.fonts.load(`${weight} 16px ${quote(alias(entry.id))}`, chars));
    let timer = 0;
    await Promise.race([load.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, timeout); })]);
    clearTimeout(timer);
  },
  /** 字面的 unicode-range 是否含有 chars（Set<码位>）里的字 */
  faceCovers(face, chars) {
    const range = face.unicodeRange || '';
    if (!range || /^U\+0-10FFFF$/i.test(range.trim())) return true;
    return range.split(',').some((part) => {
      const m = /U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/i.exec(part.trim());
      if (!m) return false;
      const lo = parseInt(m[1].replace(/\?/g, '0'), 16);
      const hi = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, 'f'), 16);
      for (const code of chars) if (code >= lo && code <= hi) return true;
      return false;
    });
  },
  register,
  usage,
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  addFiles, addUrl, addCatalog, addLocal, remove, downloadAll, queryLocalFonts, catalogCss,
  storageEstimate: async () => {
    const estimate = await navigator.storage?.estimate?.().catch(() => null);
    const persisted = await navigator.storage?.persisted?.().catch(() => false);
    return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, persisted: !!persisted };
  },
  persist: () => navigator.storage?.persist?.().catch(() => false) ?? Promise.resolve(false),
};

let loaded = false;
lyricFonts.ready = (typeof indexedDB === 'undefined' ? Promise.resolve([]) : reload()).then(() => {
  loaded = true;
  const entry = lyricFonts.selected();
  if (entry) register(entry).catch((error) => console.warn('[am-hook] 歌词字体注册失败', error));
  emit('library', { broadcast: false });
  return entries;
});

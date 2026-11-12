// iTunes 风格的 MP4 标签（moov.udta.meta.ilst 的条目），由 media.wasm 在 defrag 时写入 moov（见 crates/am-media 的
// defrag::Options::tags），因此不需要第二遍改写文件。字段与参考实现 go-mp4tag 写入的相同。
//
//   buildIlst(tags) -> Uint8Array   tags 中缺省 / 空的字段不写；cover 为 { bytes, type: 'jpeg' | 'png' }

const encoder = new TextEncoder();
const TYPE_BINARY = 0;
const TYPE_UTF8 = 1;
const TYPE_JPEG = 13;
const TYPE_PNG = 14;
const TYPE_INT = 21;

/** box 类型：© 是 0xA9 单字节（Latin-1），不能按 UTF-8 编码 */
function fourcc(kind) {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = kind.charCodeAt(i) & 0xff;
  return out;
}

function box(kind, ...parts) {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(fourcc(kind), 4);
  let at = 8;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function intBytes(value, width) {
  const b = new Uint8Array(width);
  const view = new DataView(b.buffer);
  if (width === 1) view.setInt8(0, value);
  else if (width === 2) view.setInt16(0, value);
  else if (width === 4) view.setUint32(0, value >>> 0);
  else view.setBigUint64(0, BigInt(value));
  return b;
}

/** data box：类型（4 字节，首字节为版本 0）+ locale（0）+ 值 */
const data = (type, value) => box('data', u32(type), u32(0), value);
const item = (kind, type, value) => box(kind, data(type, value));
const text = (kind, value) => item(kind, TYPE_UTF8, encoder.encode(value));

/** 自定义字段（----，mean 为 com.apple.iTunes），如 ISRC、UPC、LABEL */
function freeform(name, value) {
  return box('----', box('mean', u32(0), encoder.encode('com.apple.iTunes')), box('name', u32(0), encoder.encode(name)), data(TYPE_UTF8, encoder.encode(value)));
}

const present = (v) => v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && Number.isNaN(v));
/** 数字 ID：只接受十进制数字串或安全整数 */
const numericId = (v) => (present(v) && /^\d{1,19}$/.test(String(v)) ? String(v) : null);

/**
 * tags：{ title, artist, album, albumArtist, composer, genre, date, track: [n, total], disc: [n, total], lyrics,
 *   cover: { bytes, type }, copyright, label, upc, isrc, rating（0 无 / 1 explicit / 2 clean）, songId, albumId, artistId,
 *   compilation, sort: { title, artist, album, albumArtist, composer }, mediaType（stik：1 音乐，6 音乐视频，缺省为 1）,
 *   custom: { 名称: 值 }（其他 com.apple.iTunes 自定义字段，如 MV 的 PERFORMER、RELEASETIME） }
 */
export function buildIlst(tags) {
  const items = [];
  const add = (cond, fn) => { if (cond) items.push(fn()); };
  add(present(tags.title), () => text('\xa9nam', tags.title));
  add(present(tags.artist), () => text('\xa9ART', tags.artist));
  add(present(tags.album), () => text('\xa9alb', tags.album));
  add(present(tags.albumArtist), () => text('aART', tags.albumArtist));
  add(present(tags.composer), () => text('\xa9wrt', tags.composer));
  add(present(tags.genre), () => text('\xa9gen', tags.genre));
  add(present(tags.date), () => text('\xa9day', tags.date));
  if (tags.track && tags.track[0] > 0) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setUint16(2, Math.min(tags.track[0], 0xffff));
    new DataView(b.buffer).setUint16(4, Math.min(tags.track[1] || 0, 0xffff));
    items.push(item('trkn', TYPE_BINARY, b));
  }
  if (tags.disc && tags.disc[0] > 0) {
    const b = new Uint8Array(6);
    new DataView(b.buffer).setUint16(2, Math.min(tags.disc[0], 0xffff));
    new DataView(b.buffer).setUint16(4, Math.min(tags.disc[1] || 0, 0xffff));
    items.push(item('disk', TYPE_BINARY, b));
  }
  add(tags.compilation, () => item('cpil', TYPE_INT, intBytes(1, 1)));
  // 媒体类型：音乐或音乐视频
  items.push(item('stik', TYPE_INT, intBytes(tags.mediaType || 1, 1)));
  add(present(tags.rating), () => item('rtng', TYPE_INT, intBytes(tags.rating, 1)));
  add(present(tags.copyright), () => text('cprt', tags.copyright));
  if (present(tags.label)) {
    items.push(text('\xa9pub', tags.label));
    items.push(freeform('LABEL', tags.label));
  }
  add(present(tags.isrc), () => freeform('ISRC', tags.isrc));
  add(present(tags.upc), () => freeform('UPC', tags.upc));
  for (const [name, value] of Object.entries(tags.custom || {})) add(present(value), () => freeform(name, String(value)));
  const songId = numericId(tags.songId);
  const albumId = numericId(tags.albumId);
  const artistId = numericId(tags.artistId);
  // cnID / atID 为 32 位，plID 为 64 位（与 iTunes 相同）；超出 32 位的 ID 不写
  add(songId && Number(songId) <= 0xffffffff, () => item('cnID', TYPE_INT, intBytes(Number(songId), 4)));
  add(albumId, () => item('plID', TYPE_INT, intBytes(albumId, 8)));
  add(artistId && Number(artistId) <= 0xffffffff, () => item('atID', TYPE_INT, intBytes(Number(artistId), 4)));
  const sort = tags.sort || {};
  add(present(sort.title), () => text('sonm', sort.title));
  add(present(sort.artist), () => text('soar', sort.artist));
  add(present(sort.album), () => text('soal', sort.album));
  add(present(sort.albumArtist), () => text('soaa', sort.albumArtist));
  add(present(sort.composer), () => text('soco', sort.composer));
  add(present(tags.lyrics), () => text('\xa9lyr', tags.lyrics));
  if (tags.cover && tags.cover.bytes && tags.cover.bytes.length) {
    items.push(item('covr', tags.cover.type === 'png' ? TYPE_PNG : TYPE_JPEG, tags.cover.bytes));
  }
  const out = new Uint8Array(items.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of items) { out.set(b, at); at += b.length; }
  return out;
}

/** 由文件头判断图片类型 */
export function imageType(bytes) {
  return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? 'png' : 'jpeg';
}

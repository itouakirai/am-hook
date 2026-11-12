// 不压缩（store）的 ZIP，用于把一张专辑 / 一个歌单打包为一个文件。
// 条目的内容不复制：最终 Blob 由各条目的 Blob（可以是 OPFS 中的 File，浏览器保存时从磁盘读取）与头部字节拼成，
// 专辑再大也不占内存。CRC-32 由 media-worker 在 defrag 时顺带算出，小文件（歌词、封面）在这里计算。
// 总大小或偏移超过 4 GiB、条目超过 65535 个时写 ZIP64 扩展。
//
//   crc32(bytes, crc?)                         CRC-32（可分段累计）
//   crc32Blob(blob)                            异步：分块读取 Blob 计算 CRC-32
//   buildZip(entries, { date }) -> Blob        entries: [{ name, data: Blob | Uint8Array, crc? }]

const TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

export function crc32(bytes, crc = 0) {
  let c = ~crc;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

export async function crc32Blob(blob) {
  let crc = 0;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return crc;
    crc = crc32(value, crc);
  }
}

const MAX32 = 0xffffffff;
const encoder = new TextEncoder();

/** MS-DOS 日期时间（本地时间，2 秒精度） */
function dosTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

class Writer {
  constructor(size) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
    this.at = 0;
  }
  u16(v) { this.view.setUint16(this.at, v, true); this.at += 2; }
  u32(v) { this.view.setUint32(this.at, v, true); this.at += 4; }
  u64(v) { this.view.setBigUint64(this.at, BigInt(v), true); this.at += 8; }
  raw(b) { this.bytes.set(b, this.at); this.at += b.length; }
}

/** 同一目录下重名的条目加上序号（a.m4a、a (2).m4a） */
function uniqueNames(entries) {
  const seen = new Set();
  return entries.map((e) => {
    let name = e.name;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = e.name.replace(/(\.[^./]*)?$/, (ext) => ` (${n})${ext || ''}`);
    seen.add(name.toLowerCase());
    return { ...e, name };
  });
}

/** entries 的 crc 缺省时（Uint8Array 或 crc 为 null 的 Blob）在这里计算，Blob 需要 await */
export async function buildZip(input, options) {
  return new Blob(await zipParts(input, options), { type: 'application/zip' });
}

/** ZIP 的各部分（头部字节与条目数据，按顺序拼接即为 ZIP）；条目数据只要有 size（Blob）或 length（Uint8Array） */
export async function zipParts(input, { date = new Date() } = {}) {
  const entries = uniqueNames(input);
  const { time, date: day } = dosTime(date);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data;
    const size = data instanceof Uint8Array ? data.length : data.size;
    const crc = e.crc ?? (data instanceof Uint8Array ? crc32(data) : await crc32Blob(data));
    const name = encoder.encode(e.name);
    const zip64 = size >= MAX32 || offset >= MAX32;
    // 本地文件头
    const local = new Writer(30 + name.length + (zip64 ? 20 : 0));
    local.u32(0x04034b50);
    local.u16(zip64 ? 45 : 20);
    local.u16(0x0800); // 文件名为 UTF-8
    local.u16(0); // store
    local.u16(time);
    local.u16(day);
    local.u32(crc);
    local.u32(zip64 ? MAX32 : size);
    local.u32(zip64 ? MAX32 : size);
    local.u16(name.length);
    local.u16(zip64 ? 20 : 0);
    local.raw(name);
    if (zip64) { local.u16(0x0001); local.u16(16); local.u64(size); local.u64(size); }
    parts.push(local.bytes, data);
    central.push({ name, crc, size, offset, zip64 });
    offset += local.bytes.length + size;
  }
  // 中央目录
  const cdStart = offset;
  for (const c of central) {
    const w = new Writer(46 + c.name.length + (c.zip64 ? 28 : 0));
    w.u32(0x02014b50);
    w.u16(c.zip64 ? 45 : 20); // version made by（MS-DOS）
    w.u16(c.zip64 ? 45 : 20);
    w.u16(0x0800);
    w.u16(0);
    w.u16(time);
    w.u16(day);
    w.u32(c.crc);
    w.u32(c.zip64 ? MAX32 : c.size);
    w.u32(c.zip64 ? MAX32 : c.size);
    w.u16(c.name.length);
    w.u16(c.zip64 ? 28 : 0);
    w.u16(0); // comment
    w.u16(0); // disk
    w.u16(0); // internal attributes
    w.u32(0); // external attributes
    w.u32(c.zip64 ? MAX32 : c.offset);
    w.raw(c.name);
    if (c.zip64) { w.u16(0x0001); w.u16(24); w.u64(c.size); w.u64(c.size); w.u64(c.offset); }
    parts.push(w.bytes);
    offset += w.bytes.length;
  }
  const cdSize = offset - cdStart;
  const count = central.length;
  if (count > 0xffff || cdStart >= MAX32 || cdSize >= MAX32) {
    const record = new Writer(56 + 20);
    record.u32(0x06064b50);
    record.u64(44);
    record.u16(45);
    record.u16(45);
    record.u32(0);
    record.u32(0);
    record.u64(count);
    record.u64(count);
    record.u64(cdSize);
    record.u64(cdStart);
    // ZIP64 结束记录定位器
    record.u32(0x07064b50);
    record.u32(0);
    record.u64(offset);
    record.u32(1);
    parts.push(record.bytes);
  }
  const end = new Writer(22);
  end.u32(0x06054b50);
  end.u16(0);
  end.u16(0);
  end.u16(Math.min(count, 0xffff));
  end.u16(Math.min(count, 0xffff));
  end.u32(Math.min(cdSize, MAX32));
  end.u32(Math.min(cdStart, MAX32));
  end.u16(0);
  parts.push(end.bytes);
  return parts;
}

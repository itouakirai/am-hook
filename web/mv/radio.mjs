// 电台的 HLS 播放与下载：直播电台（Apple Music 1、各地广播、直播过的视频节目）与广播单集（点播，音频或视频）。
// 与 MV 共用媒体 Worker（engine.mjs 的 Core：Widevine / PlayReady 请求、CENC / CBCS 解密与 defrag），区别在于：
//   - HLS 地址与 license 服务器来自 /v1/play/assets（station.mjs 的 playAssets），license 由服务端带上 media-user-token
//     直接请求 Apple（wrapper-lite 不支持电台的 license）；先试 Widevine，再试 PlayReady；
//   - 地址可能是 master（视频：分离或合在一起的音轨；音频：几种码率），也可能直接是 media playlist；
//   - 直播没有 #EXT-X-ENDLIST：从窗口末尾附近开始，按 TARGETDURATION 刷新列表，只往后追加；
//     与 MusicKit 相同，分片里的 emsg（ID3：TIT2 / TPE1 / TALB，PRIV com.apple.radio.adamid）是当前播放的歌曲。
// 下载只用于点播（有 ENDLIST），与 MV 相同写入 OPFS 再 defrag（engine.mjs 的 downloadStreams）。
import { attributes, fetchResource } from '/assets/mv/hls.mjs';
import { Core, downloadStreams } from '/assets/mv/engine.mjs';
import { requestLicense } from '/assets/station.mjs';

const WIDEVINE_KEYFORMAT = 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const PLAYREADY_KEYFORMAT = 'com.microsoft.playready';
const WIDEVINE_SYSTEM_ID = 'edef8ba979d64acea3c827dcd51d21ed';
const PLAYREADY_SYSTEM_ID = '9a04f07998404286ab92e65be0885f95';
/** 直播从窗口末尾往前第几个分片开始（与 hls.js 的 liveSyncDurationCount 相同） */
const LIVE_START_SEGMENTS = 3;

function absolute(uri, base) {
  const u = new URL(uri, base);
  if (u.protocol !== 'https:') throw new Error('Expected an HTTPS media URL');
  return u.href;
}

const isVideoCodec = (c) => /^(avc|hvc|hev|dvh|dvhe|av01|vp09)/.test(c);
const isAudioCodec = (c) => /^(mp4a|ac-3|ec-3|ac-4|opus|flac|alac)/i.test(c);
const splitCodecs = (value) => String(value || '').split(',').map((c) => c.trim()).filter(Boolean);

/**
 * master playlist → { videos, audios }；不是 master（直接是 media playlist）时为 null。
 * 视频轨 { kind: 'video' | 'muxed', url, codecs, … }：有单独音轨组时为 video，否则音频合在视频里（muxed）；
 * 音频轨 { kind: 'audio', url, codecs, … }：EXT-X-MEDIA 的音轨，没有视频时为各码率的 STREAM-INF
 */
export function parseRadioMaster(text, url) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid HLS playlist');
  if (!/^#EXT-X-STREAM-INF:/m.test(text)) return null;
  const variants = [], media = []; let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attributes(line.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI) media.push({ ...a, url: absolute(a.URI, url) });
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) pending = attributes(line.slice(18));
    else if (line && !line.startsWith('#') && pending) {
      variants.push({ ...pending, url: absolute(line, url) });
      pending = null;
    }
  }
  const bandwidth = (v) => Number(v['AVERAGE-BANDWIDTH'] || v.BANDWIDTH || 0);
  const videos = [], audios = [];
  for (const v of variants) {
    const codecs = splitCodecs(v.CODECS);
    const video = v.RESOLUTION || codecs.some(isVideoCodec);
    if (!video) {
      // 纯音频的 STREAM-INF（音频电台的几种码率）；音轨在 EXT-X-MEDIA 里时 STREAM-INF 的地址可能就是它
      if (!media.some((m) => m.url === v.url)) audios.push({ ...v, kind: 'audio', codecs: codecs.filter(isAudioCodec).join(',') || 'mp4a.40.2' });
      continue;
    }
    const separate = v.AUDIO && media.some((m) => m['GROUP-ID'] === v.AUDIO);
    videos.push({ ...v, kind: separate ? 'video' : 'muxed', codecs: (separate ? codecs.filter(isVideoCodec) : codecs).join(',') });
  }
  for (const m of media) {
    const codec = variants.filter((v) => v.AUDIO === m['GROUP-ID']).flatMap((v) => splitCodecs(v.CODECS)).find(isAudioCodec) || '';
    audios.push({ ...m, kind: 'audio', codecs: codec });
  }
  videos.sort((a, b) => bandwidth(b) - bandwidth(a));
  audios.sort((a, b) => bandwidth(b) - bandwidth(a));
  if (!videos.length && !audios.length) throw new Error('No playable streams in the HLS master playlist');
  return { videos, audios };
}

/** 视频轨默认搭配的音轨：同一音轨组里 DEFAULT=YES 的那条 */
export function radioAudioFor(video, audios) {
  if (!video || video.kind !== 'video') return null;
  return audios.find((a) => a['GROUP-ID'] === video.AUDIO && a.DEFAULT === 'YES') || audios.find((a) => a['GROUP-ID'] === video.AUDIO) || audios[0] || null;
}

/**
 * media playlist（点播或直播）→ { segments, targetDuration, mediaSequence, ended }。
 * 分片 { url, range?, duration, seq, start, init, key, discontinuity }：start 为在本列表中的起点（直播时随窗口滑动，不可直接比较），
 * key 为 keyset 的 ID（同一段分片同时列出 Widevine 与 PlayReady 的 EXT-X-KEY），keysets 为 ID → { widevine?, playready?, fairplay? }
 */
export function parseRadioMedia(text, url) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid HLS media playlist');
  const segments = [], keysets = new Map();
  let init = null, keyset = null, duration, range, time = 0, previous = null, seq = 0, mediaSequence = 0, targetDuration = 6;
  let keysOpen = false, discontinuity = false, ended = false;
  function resource(uri, spec) {
    const r = { url: absolute(uri, url) };
    if (spec) {
      const m = /^(\d+)(?:@(\d+))?$/.exec(spec.trim());
      if (!m) throw new Error('Invalid HLS byte range');
      const offset = m[2] === undefined ? (previous?.url === r.url ? previous.end : NaN) : Number(m[2]);
      const length = Number(m[1]);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length <= 0) throw new Error('Invalid HLS byte range offset');
      r.range = { offset, length }; previous = { url: r.url, end: offset + length };
    } else previous = null;
    return r;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-KEY:')) {
      const a = attributes(line.slice(11));
      // 连续的几行 EXT-X-KEY（各个 DRM）属于同一组，遇到分片后再出现时是新的一组（换 key）
      if (!keysOpen) { keyset = {}; keysOpen = true; }
      if (a.METHOD === 'NONE') { keyset = null; continue; }
      if (!keyset) keyset = {};
      const format = String(a.KEYFORMAT || '').toLowerCase();
      const uri = a.URI || '';
      if (format === WIDEVINE_KEYFORMAT || (!format && uri.startsWith('data:'))) keyset.widevine = uri;
      else if (format === PLAYREADY_KEYFORMAT) keyset.playready = uri;
      else if (uri.startsWith('skd://')) keyset.fairplay = uri;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attributes(line.slice(11)); init = resource(a.URI, a.BYTERANGE);
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSequence = seq = Number(line.slice(22)) || 0;
    else if (line.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(line.slice(22)) || targetDuration;
    else if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
    else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.slice(17);
    else if (line === '#EXT-X-DISCONTINUITY') discontinuity = true;
    else if (line === '#EXT-X-ENDLIST') ended = true;
    else if (line && !line.startsWith('#')) {
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Missing HLS segment duration');
      if (!init) throw new Error('Only fragmented MP4 radio streams are supported');
      keysOpen = false;
      let key = null;
      if (keyset && (keyset.widevine || keyset.playready || keyset.fairplay)) {
        key = keyset.widevine || keyset.playready || keyset.fairplay;
        if (!keysets.has(key)) keysets.set(key, { ...keyset });
      }
      segments.push({ ...resource(line, range), duration, seq: seq++, start: time, init, key, discontinuity });
      time += duration; duration = undefined; range = undefined; discontinuity = false;
    }
  }
  if (!segments.length) throw new Error('Empty HLS media playlist');
  return { segments, keysets, targetDuration, mediaSequence, ended, duration: time };
}

/* ---------- 初始化分片：pssh 与编码 ---------- */

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const fourcc = (bytes, at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

/** bytes[start, end) 中的各个 box：[{ type, start, data, end }]（data 为内容起点） */
function boxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = [];
  for (let p = start; p + 8 <= end;) {
    let size = view.getUint32(p), header = 8;
    if (size === 1) { if (p + 16 > end) break; size = Number(view.getBigUint64(p + 8)); header = 16; }
    else if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type: fourcc(bytes, p + 4), start: p, data: p + header, end: p + size });
    p += size;
  }
  return out;
}
const child = (bytes, box, ...path) => path.reduce((b, type) => b && boxes(bytes, b.data, b.end).find((c) => c.type === type), box);

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 初始化分片 moov 里的 pssh → keyset（播放列表没有写 EXT-X-KEY 的 data URI 时用） */
export function keysetFromInit(raw) {
  const moov = boxes(raw).find((b) => b.type === 'moov');
  if (!moov) return null;
  const keyset = {};
  for (const box of boxes(raw, moov.data, moov.end).filter((b) => b.type === 'pssh')) {
    const system = hex(raw.subarray(box.data + 4, box.data + 20));
    const uri = `data:text/plain;base64,${base64(raw.subarray(box.start, box.end))}`;
    if (system === WIDEVINE_SYSTEM_ID) keyset.widevine ||= uri;
    else if (system === PLAYREADY_SYSTEM_ID) keyset.playready ||= uri;
  }
  return keyset.widevine || keyset.playready ? keyset : null;
}

/** 初始化分片是否加密（样本描述为 encv / enca） */
function encryptedInit(raw) {
  const moov = boxes(raw).find((b) => b.type === 'moov');
  if (!moov) return false;
  return boxes(raw, moov.data, moov.end).filter((b) => b.type === 'trak').some((trak) => {
    const stsd = child(raw, trak, 'mdia', 'minf', 'stbl', 'stsd');
    return !!stsd && boxes(raw, stsd.data + 8, stsd.end).some((e) => e.type === 'encv' || e.type === 'enca');
  });
}

/** MPEG-4 描述符的长度（1～4 字节，每字节 7 位） */
function descriptorLength(bytes, p) {
  let length = 0, i = 0;
  for (; i < 4; i++) { const b = bytes[p + i]; length = (length << 7) | (b & 0x7f); if (!(b & 0x80)) break; }
  return [length, p + i + 1];
}

/** esds → mp4a.40.<AOT> */
function mp4aCodec(bytes, entry) {
  const esds = boxes(bytes, entry.data + 28, entry.end).find((b) => b.type === 'esds');
  if (!esds) return 'mp4a.40.2';
  let p = esds.data + 4;
  const take = (tag) => { if (bytes[p] !== tag) return false; const [, next] = descriptorLength(bytes, p + 1); p = next; return true; };
  if (!take(0x03)) return 'mp4a.40.2';
  const flags = bytes[p + 2]; p += 3;
  if (flags & 0x80) p += 2; if (flags & 0x40) p += 1 + bytes[p]; if (flags & 0x20) p += 2;
  if (!take(0x04)) return 'mp4a.40.2';
  const oti = bytes[p]; p += 13;
  if (oti !== 0x40 || !take(0x05)) return `mp4a.${oti.toString(16)}`;
  let aot = bytes[p] >> 3;
  if (aot === 31) aot = 32 + (((bytes[p] & 7) << 3) | (bytes[p + 1] >> 5));
  return `mp4a.40.${aot}`;
}

/** 解密后的初始化分片 → MSE 用的 codecs（播放列表没有写 CODECS 时）；认不出时为 '' */
export function codecsFromInit(raw) {
  const moov = boxes(raw).find((b) => b.type === 'moov');
  if (!moov) return '';
  const list = [];
  for (const trak of boxes(raw, moov.data, moov.end).filter((b) => b.type === 'trak')) {
    const stsd = child(raw, trak, 'mdia', 'minf', 'stbl', 'stsd');
    const entry = stsd && boxes(raw, stsd.data + 8, stsd.end)[0];
    if (!entry) continue;
    if (entry.type === 'mp4a') list.push(mp4aCodec(raw, entry));
    else if (entry.type === 'ec-3' || entry.type === 'ac-3' || entry.type === 'ac-4') list.push(entry.type);
    else if (entry.type === 'Opus') list.push('opus');
    else if (entry.type === 'fLaC') list.push('flac');
    else if (entry.type === 'avc1' || entry.type === 'avc3') {
      const avcC = boxes(raw, entry.data + 78, entry.end).find((b) => b.type === 'avcC');
      if (avcC) list.push(`${entry.type}.${hex(raw.subarray(avcC.data + 1, avcC.data + 4))}`);
    } else if (entry.type === 'hvc1' || entry.type === 'hev1') {
      const hvcC = boxes(raw, entry.data + 78, entry.end).find((b) => b.type === 'hvcC');
      if (!hvcC) continue;
      const d = hvcC.data, b1 = raw[d + 1];
      const space = ['', 'A', 'B', 'C'][b1 >> 6], tier = b1 & 0x20 ? 'H' : 'L', profile = b1 & 0x1f;
      // general_profile_compatibility_flags 按位反转后以十六进制书写
      let compat = new DataView(raw.buffer, raw.byteOffset + d + 2, 4).getUint32(0), reversed = 0;
      for (let i = 0; i < 32; i++) { reversed = (reversed << 1) | (compat & 1); compat >>>= 1; }
      const constraints = [...raw.subarray(d + 6, d + 12)];
      while (constraints.length && !constraints[constraints.length - 1]) constraints.pop();
      list.push([entry.type, `${space}${profile}`, (reversed >>> 0).toString(16), `${tier}${raw[d + 12]}`, ...constraints.map((c) => c.toString(16))].join('.'));
    }
  }
  return list.join(',');
}

/* ---------- emsg / ID3：直播电台当前播放的歌曲 ---------- */

function cString(bytes, p, end) {
  let q = p;
  while (q < end && bytes[q]) q++;
  return [new TextDecoder().decode(bytes.subarray(p, q)), q + 1];
}

/** ID3 文本帧的编码：0 Latin-1，1 带 BOM 的 UTF-16，2 UTF-16BE，3 UTF-8 */
function id3Text(data) {
  const body = data.subarray(1);
  const label = ['latin1', 'utf-16', 'utf-16be', 'utf-8'][data[0]] || 'utf-8';
  try { return new TextDecoder(label).decode(body).replace(/\0+$/, '').split('\0')[0].trim(); } catch { return ''; }
}

const syncsafe = (b, p) => ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f);

/** ID3v2.3 / 2.4 → { title, performer, album, adamIds: { storefront: adamId } } */
export function parseId3(bytes) {
  if (bytes.length < 10 || fourcc(bytes, 0).slice(0, 3) !== 'ID3') return null;
  const major = bytes[3], end = Math.min(bytes.length, 10 + syncsafe(bytes, 6));
  let p = 10;
  if (bytes[5] & 0x40) p += major === 4 ? syncsafe(bytes, p) : 4 + new DataView(bytes.buffer, bytes.byteOffset + p, 4).getUint32(0);
  const out = { title: '', performer: '', album: '', adamIds: {} };
  while (p + 10 <= end) {
    const id = fourcc(bytes, p);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = major === 4 ? syncsafe(bytes, p + 4) : new DataView(bytes.buffer, bytes.byteOffset + p + 4, 4).getUint32(0);
    const data = bytes.subarray(p + 10, Math.min(end, p + 10 + size));
    if (id === 'TIT2') out.title = id3Text(data);
    else if (id === 'TPE1') out.performer = id3Text(data);
    else if (id === 'TALB') out.album = id3Text(data);
    else if (id === 'PRIV') {
      const [owner, at] = cString(data, 0, data.length);
      // 「地区:歌曲 ID」的逗号列表（MusicKit 的 storefrontAdamIds）
      if (owner === 'com.apple.radio.adamid') {
        for (const part of new TextDecoder().decode(data.subarray(at)).split(',')) {
          const [sf, adamId] = part.split(':', 2).map((s) => (s || '').trim());
          if (sf && adamId && adamId !== '0' && !(sf in out.adamIds)) out.adamIds[sf] = adamId;
        }
      }
    }
    p += 10 + size;
  }
  return out.title || out.performer ? out : null;
}

/** 分片里 moof 之前的 emsg（version 1，MusicKit 只认这一种）→ [{ time, id3 }]，time 为秒（媒体时间） */
export function parseEmsgs(raw) {
  const out = [];
  for (const box of boxes(raw)) {
    if (box.type === 'moof') break;
    if (box.type !== 'emsg' || raw[box.data] !== 1) continue;
    const view = new DataView(raw.buffer, raw.byteOffset + box.data, box.end - box.data);
    const timescale = view.getUint32(4), time = view.getUint32(8) * 2 ** 32 + view.getUint32(12);
    let p = box.data + 24;
    [, p] = cString(raw, p, box.end); // scheme_id_uri
    [, p] = cString(raw, p, box.end); // value
    const id3 = parseId3(raw.subarray(p, box.end));
    if (id3) out.push({ time: timescale ? time / timescale : 0, id3 });
  }
  return out;
}

/* ---------- 单条媒体流 ---------- */

/**
 * 一条 media playlist：拉取与刷新播放列表、初始化分片、内容密钥与解密。
 * ctx：{ core, asset, stationId, signal }；name / base 为媒体 Worker 中的流名与合并时的轨道编号
 */
class RadioStream {
  constructor(ctx, track, name, base) {
    Object.assign(this, { ctx, track, name, base });
    this.keys = new Map(); this.keysets = new Map(); this.initRef = ''; this.init = null; this.firstRaw = null;
  }
  async load() {
    const res = await fetch(this.track.url, { signal: this.ctx.signal });
    if (!res.ok) throw new Error(`Playlist HTTP ${res.status}`);
    const { keysets, ...playlist } = parseRadioMedia(await res.text(), res.url || this.track.url);
    // 直播刷新时保留已有的 keyset（含初始化分片 pssh 得来的）
    for (const [id, keyset] of keysets) this.keysets.set(id, keyset);
    Object.assign(this, playlist);
    return this;
  }
  /** 当前序号之后的分片（直播刷新后窗口已滑动，按序号找） */
  after(seq) { return this.segments.find((s) => s.seq > seq) || null; }
  bySeq(seq) { return this.segments.find((s) => s.seq === seq) || null; }
  /** 分片的初始化分片与上一个不同时（第一次、换了 EXT-X-MAP）取来交给媒体 Worker，返回解密后的初始化分片，没有变化时为 null */
  async prepareInit(segment) {
    const ref = JSON.stringify(segment.init);
    if (ref === this.initRef) return null;
    const raw = await fetchResource(segment.init, this.ctx.signal);
    // 播放列表没有写 data URI 时用初始化分片里的 pssh；都没有而又加密的，只能是 FairPlay
    if (!segment.key && encryptedInit(raw)) {
      const keyset = keysetFromInit(raw);
      if (!keyset) throw new Error('This stream is only available with FairPlay');
      const id = keyset.widevine || keyset.playready;
      this.keysets.set(id, keyset);
      this.initKey = id;
    }
    this.init = await this.ctx.core.call('init', this.name, raw, this.base);
    this.initRef = ref;
    if (!this.track.codecs) this.track.codecs = codecsFromInit(this.init);
    return this.init;
  }
  keyOf(segment) { return segment.key || this.initKey || null; }
  async key(segment) {
    const id = this.keyOf(segment);
    if (!id) return new Uint8Array(16);
    if (!this.keys.has(id)) {
      const pending = acquireKey(this.ctx, this.keysets.get(id) || {});
      pending.catch(() => this.keys.delete(id));
      this.keys.set(id, pending);
    }
    return this.keys.get(id);
  }
  /** 一个分片：{ raw（原始字节，下载时用）, clear（解密后的 moof + mdat）, emsgs } */
  async fragment(segment, mux = false, sequence = 0) {
    const raw = segment === this.segments[0] && this.firstRaw ? this.firstRaw : await fetchResource(segment, this.ctx.signal);
    const emsgs = parseEmsgs(raw);
    const key = await this.key(segment);
    const clear = await this.ctx.core.call('fragment', this.name, raw, key, mux, sequence);
    return { clear, emsgs };
  }
}

/** keyset → 内容密钥：先 Widevine 再 PlayReady；media-user-token 被拒绝（TokenError）时直接抛出，由页面请用户重填 */
async function acquireKey({ core, asset, stationId, signal }, keyset) {
  if (!keyset.widevine && !keyset.playready) {
    throw new Error(keyset.fairplay ? 'This stream is only available with FairPlay' : 'No Widevine or PlayReady key for this stream');
  }
  const errors = [];
  for (const drm of ['widevine', 'playready']) {
    const uri = keyset[drm];
    if (!uri) continue;
    let challenge = null;
    try {
      challenge = await core.call('challenge', uri, drm);
      const license = await requestLicense(asset, { adamId: stationId, challenge: challenge.challenge, uri, drm, signal });
      return await core.call('license', challenge.session, license);
    } catch (error) {
      if (error.name === 'TokenError' || error.name === 'AbortError') throw error;
      errors.push(`${drm}: ${error.message}`);
    } finally {
      if (challenge && !signal.aborted) core.call('closeSession', challenge.session).catch(() => {});
    }
  }
  throw new Error(`License failed (${errors.join('; ')})`);
}

/* ---------- 打开电台 ---------- */

/**
 * asset（playAssets 的结果）→ { master, videos, audios, single }：master 时列出各轨道，否则只有一条 media playlist（single，
 * kind 为 audio 或 muxed，取决于电台的 mediaKind）
 */
export async function openRadio(asset, { video = false, signal } = {}) {
  const res = await fetch(asset.url, { signal });
  if (!res.ok) throw new Error(`Playlist HTTP ${res.status}`);
  const text = await res.text();
  const url = res.url || asset.url;
  const master = parseRadioMaster(text, url);
  if (master) return { ...master, single: null };
  const single = { kind: video ? 'muxed' : 'audio', url, codecs: '' };
  return { videos: video ? [single] : [], audios: video ? [] : [single], single };
}

/** 选择的轨道 → 要拉取的流：视频（分离的音轨另开一条）或只有音频 */
function selectedTracks(videoTrack, audioTrack) {
  if (videoTrack && videoTrack.kind === 'video' && audioTrack) return [videoTrack, audioTrack];
  return [videoTrack || audioTrack].filter(Boolean);
}

function mimeOf(track) {
  const codecs = track.codecs || (track.kind === 'audio' ? 'mp4a.40.2' : '');
  return `${track.kind === 'audio' ? 'audio' : 'video'}/mp4${codecs ? `; codecs="${codecs}"` : ''}`;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function event(target, name, signal, action) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { target.removeEventListener(name, ok); target.removeEventListener('error', fail); signal.removeEventListener('abort', abort); };
    const ok = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('MediaSource decoding failed')); };
    const abort = () => { cleanup(); reject(signal.reason); };
    if (signal.aborted) return abort();
    target.addEventListener(name, ok, { once: true }); target.addEventListener('error', fail, { once: true }); signal.addEventListener('abort', abort, { once: true });
    try { action?.(); } catch (e) { cleanup(); reject(e); }
  });
}

function contains(buffer, time) {
  for (let i = 0; i < buffer.length; i++) if (time >= buffer.start(i) - 0.05 && time < buffer.end(i) - 0.05) return buffer.end(i);
  return null;
}

/* ---------- 播放 ---------- */

/**
 * 电台播放（MSE）。onStatus(key)：'buffering' | 'playing' | 'pressPlay' | 'live'；onError(error)；
 * onMetadata({ title, performer, album, adamIds })：直播电台当前播放的歌曲（emsg）
 */
export class RadioPlayback {
  constructor(video, { onStatus, onError, onMetadata } = {}) {
    Object.assign(this, { video, onStatus: onStatus || (() => {}), onError: onError || (() => {}), onMetadata: onMetadata || (() => {}) });
    this.controller = new AbortController(); this.core = new Core(); this.cues = [];
  }
  /** asset、stationId：见 openRadio / station.mjs；videoTrack / audioTrack：openRadio 列出的轨道 */
  async start({ asset, stationId, videoTrack, audioTrack }) {
    const signal = this.controller.signal, video = this.video;
    const ctx = { core: this.core, asset, stationId, signal };
    const tracks = selectedTracks(videoTrack, audioTrack);
    if (!tracks.length) throw new Error('No stream selected');
    this.streams = await Promise.all(tracks.map((track, i) => new RadioStream(ctx, track, i ? 'audio' : track.kind === 'audio' ? 'audio' : 'video', i ? 100 : 1).load()));
    this.live = !this.streams.every((s) => s.ended);
    // 直播：各条流从窗口末尾往前 LIVE_START_SEGMENTS 个分片处的同一序号开始（分片按序号对齐）
    const first = this.streams[0];
    const startSeq = this.live ? first.segments[Math.max(0, first.segments.length - LIVE_START_SEGMENTS)].seq : first.segments[0].seq;
    for (const s of this.streams) {
      s.next = this.live ? (s.bySeq(startSeq) || s.segments[Math.max(0, s.segments.length - LIVE_START_SEGMENTS)]) : s.segments[0];
      s.timeline = 0; // 已追加分片的累计时长（直播的当前位置，用于 emsg）
    }
    // 先取得初始化分片与 key：codecs 没写在播放列表里时要从初始化分片读出
    const inits = [];
    for (const s of this.streams) { inits.push(await s.prepareInit(s.next)); await s.key(s.next); }
    const types = this.streams.map((s) => mimeOf(s.track));
    if (!globalThis.MediaSource || types.some((t) => !MediaSource.isTypeSupported(t))) {
      throw new Error(`This browser cannot play ${types.join(' + ')}`);
    }
    this.source = new MediaSource(); this.url = URL.createObjectURL(this.source);
    await event(this.source, 'sourceopen', signal, () => { video.src = this.url; });
    if (!this.live) this.source.duration = Math.max(...this.streams.map((s) => s.duration));
    this.buffers = types.map((t) => this.source.addSourceBuffer(t));
    for (let i = 0; i < this.buffers.length; i++) await event(this.buffers[i], 'updateend', signal, () => this.buffers[i].appendBuffer(inits[i]));
    this.onStatus('buffering');
    this.mediaError = () => this.fail(new Error(video.error?.message || 'Decoding failed'));
    video.addEventListener('error', this.mediaError);
    this.timeUpdate = () => this.showCues();
    video.addEventListener('timeupdate', this.timeUpdate);
    this.done = this.streams.map(() => false);
    this.streams.forEach((s, i) => (this.live ? this.pumpLive(s, i) : this.pumpVod(s, i)).catch((e) => { if (!signal.aborted) this.fail(e); }));
    if (this.live) this.refreshLoop().catch((e) => { if (!signal.aborted) this.fail(e); });
    video.play().catch(() => this.onStatus('pressPlay'));
  }
  fail(error) { this.stop(); this.onError(error); }
  async append(index, data) {
    const buffer = this.buffers[index], signal = this.controller.signal;
    try {
      await event(buffer, 'updateend', signal, () => buffer.appendBuffer(data));
    } catch (error) {
      // 缓冲区满：清掉已播放的部分再试一次
      if (error.name !== 'QuotaExceededError') throw error;
      const now = this.video.currentTime;
      await event(buffer, 'updateend', signal, () => buffer.remove(0, Math.max(0, now - 5)));
      await event(buffer, 'updateend', signal, () => buffer.appendBuffer(data));
    }
    if (!this.started && this.buffers.every((b) => b.buffered.length)) {
      this.started = true;
      const start = Math.max(...this.buffers.map((b) => b.buffered.start(0)));
      if (this.video.currentTime < start) this.video.currentTime = start;
    }
  }
  async trim(index) {
    const buffer = this.buffers[index], now = this.video.currentTime, signal = this.controller.signal;
    if (now > 35 && buffer.buffered.length && buffer.buffered.start(0) < now - 35) {
      await event(buffer, 'updateend', signal, () => buffer.remove(0, now - 30));
    }
  }
  /** 点播：与 MV 相同，按播放位置拉取，支持拖动 */
  async pumpVod(stream, index) {
    const signal = this.controller.signal, buffer = this.buffers[index]; let next = 0;
    while (!signal.aborted) {
      const now = this.video.currentTime;
      const end = contains(buffer.buffered, now);
      if (end === null && now < stream.duration - 0.1) {
        next = stream.segments.findIndex((s) => s.start + s.duration > now + 0.01);
        this.done[index] = false;
      }
      if (buffer.buffered.length && buffer.buffered.end(buffer.buffered.length - 1) > now + 60) {
        await event(buffer, 'updateend', signal, () => buffer.remove(now + 45, Infinity));
      }
      if (next < 0 || next >= stream.segments.length || (end !== null && end - now > 25)) {
        this.done[index] = next >= stream.segments.length;
        if (this.done.every(Boolean) && this.source.readyState === 'open' && this.buffers.every((b) => !b.updating)) this.source.endOfStream();
        await delay(150, signal); continue;
      }
      await this.trim(index);
      const segment = stream.segments[next];
      const init = await stream.prepareInit(segment);
      if (init) await this.append(index, init);
      const { clear } = await stream.fragment(segment);
      signal.throwIfAborted();
      await this.append(index, clear);
      next++; this.onStatus('playing');
    }
  }
  /** 直播：按序号依次追加，领先播放位置 3 个分片时等待；落到窗口之外（网络慢、后台）时跳到窗口末尾附近 */
  async pumpLive(stream, index) {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      const buffer = this.buffers[index], now = this.video.currentTime;
      const end = buffer.buffered.length ? buffer.buffered.end(buffer.buffered.length - 1) : 0;
      const segment = stream.next;
      if (!segment || end - now > Math.max(3 * stream.targetDuration, 12)) { await delay(250, signal); this.jumpGap(); continue; }
      await this.trim(index);
      const init = await stream.prepareInit(segment);
      if (init) await this.append(index, init);
      let fragment;
      try {
        fragment = await stream.fragment(segment);
      } catch (error) {
        // 分片已从 CDN 窗口里移除：跳到最新的几个分片
        if (!/HTTP 4\d\d/.test(error.message)) throw error;
        stream.next = stream.segments[Math.max(0, stream.segments.length - LIVE_START_SEGMENTS)];
        continue;
      }
      signal.throwIfAborted();
      if (index === 0) for (const { id3 } of fragment.emsgs) this.cues.push({ at: stream.timeline, id3 });
      await this.append(index, fragment.clear);
      stream.timeline += segment.duration;
      stream.next = stream.after(segment.seq);
      this.onStatus('live');
      this.jumpGap();
      this.showCues();
    }
  }
  /** 直播列表按 TARGETDURATION 刷新；没有新分片时半个周期后再试 */
  async refreshLoop() {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      const target = Math.max(1, this.streams[0].targetDuration);
      await delay(target * 1000, signal);
      for (const s of this.streams) {
        const last = s.segments[s.segments.length - 1].seq;
        const waiting = !s.next;
        await s.load().catch((e) => { if (e.name === 'AbortError') throw e; });
        if (waiting) s.next = s.after(last);
        if (s.ended) this.live = false;
      }
    }
  }
  /** 播放位置落在缓冲区之间的空隙（跳过了分片）时跳到后面最近的一段 */
  jumpGap() {
    const video = this.video, now = video.currentTime;
    if (!this.buffers || !this.started || video.paused) return;
    const buffered = this.buffers[0].buffered;
    if (contains(buffered, now) !== null) return;
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) > now && buffered.start(i) - now < 30) { video.currentTime = buffered.start(i) + 0.05; return; }
    }
  }
  /** 播放位置到达时显示 emsg 里的歌曲 */
  showCues() {
    const now = this.video.currentTime;
    let latest = null;
    while (this.cues.length && this.cues[0].at <= now + 0.25) latest = this.cues.shift();
    if (latest) this.onMetadata(latest.id3);
  }
  stop() {
    this.controller.abort(); this.core.close();
    this.video.removeEventListener('error', this.mediaError);
    this.video.removeEventListener('timeupdate', this.timeUpdate);
    this.video.pause(); this.video.removeAttribute('src'); this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
  }
}

/* ---------- 下载（点播） ---------- */

/**
 * 广播单集下载为 MP4（视频）或 M4A（只有音频）：与 MV 下载相同的 OPFS 写入与 defrag。返回 { file, crc, dispose }
 * opts：{ asset, stationId, videoTrack, audioTrack, signal, onProgress, onDefrag, tags }
 */
export async function downloadRadio({ asset, stationId, videoTrack, audioTrack, signal, onProgress, onDefrag, tags }) {
  const tracks = selectedTracks(videoTrack, audioTrack);
  return downloadStreams({
    signal, onProgress, onDefrag, tags,
    bandwidth: Number(tracks[0]['AVERAGE-BANDWIDTH'] || tracks[0].BANDWIDTH || 0),
    prepare: async (core) => {
      const ctx = { core, asset, stationId, signal };
      const out = [];
      for (const [i, track] of tracks.entries()) {
        const stream = await new RadioStream(ctx, track, i ? 'audio' : track.kind === 'audio' ? 'audio' : 'video', i ? 100 : 1).load();
        if (!stream.ended) throw new Error('Live streams cannot be downloaded');
        if (stream.segments.some((s) => JSON.stringify(s.init) !== JSON.stringify(stream.segments[0].init))) {
          throw new Error('Changing initialization segments are not supported');
        }
        await stream.prepareInit(stream.segments[0]);
        // downloadStreams 按 segment.key 取 keys 里的密钥（解析好的 Uint8Array）
        const keys = new Map();
        for (const segment of stream.segments) {
          const id = stream.keyOf(segment);
          if (id && !keys.has(id)) keys.set(id, await stream.key(segment));
        }
        for (const segment of stream.segments) segment.key = stream.keyOf(segment);
        stream.firstRaw = await fetchResource(stream.segments[0], signal);
        out.push({ name: stream.name, segments: stream.segments, keys, init: stream.init, firstRaw: stream.firstRaw, duration: stream.duration });
      }
      return out;
    },
  });
}

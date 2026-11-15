// 动态封面下载。专辑 / 歌单的 editorialVideo（motionDetailSquare / motionDetailTall …）与艺人的 motionArtist* 都是
// 无加密的 fMP4 HLS（同一文件 + BYTERANGE，mvod.itunes.apple.com 允许跨域与 Range），每档清晰度一个视频变体
// （H.264 最高 1080p，HEVC 最高 2160p / 2048×2732）。下载时选一个变体，取 init 与全部分片，
// 再经 media.wasm（media/media-worker.js 的 defragVideo，与 MV 相同的 isom 布局）改写为普通 MP4：
// 片段的时间戳不从 0 开始（截自长视频），fMP4 原样保存时部分播放器开头黑屏或无法循环。
// 部分竖版封面另带静音音轨（实测 -91 dB），只取视频，与官网播放时一样。
//
//   motionSources(editorialVideo)      → [{ kind: 'square' | 'tall' | 'wide', src, preview }]（同一片源只列一次）
//   loadMotion(src, signal)            → { variants, duration }（同一 master 只取一次）
//   motionChoices(variants)            → 供选择的变体：每种编码、分辨率与动态范围保留码率最高的一个
//   pickMotion(variants, { codec, max }) → 按设置选的变体
//   downloadMotion(variant, { signal, onProgress }) → { file, size, crc, dispose }

import { parseMaster, parseMedia } from '../motion-art.mjs';

/** editorialVideo 的键 → 形状；同一形状按顺序取第一个有片源的 */
const KEYS = [
  ['square', ['motionDetailSquare', 'motionSquareVideo1x1', 'motionArtistSquare1x1']],
  ['tall', ['motionDetailTall', 'motionTallVideo3x4']],
  ['wide', ['motionArtistFullscreen16x9', 'motionArtistWide16x9', 'motionArtistSingular16x9', 'motionWideVideo21x9']],
];

/** 保存到专辑 / 歌单文件夹时的文件名（同参考实现 apple-music-downloader 的 save-animated-artwork） */
export const MOTION_FILES = { square: 'square_animated_artwork.mp4', tall: 'tall_animated_artwork.mp4', wide: 'wide_animated_artwork.mp4' };

export function motionSources(video) {
  const out = [];
  const seen = new Set();
  if (!video) return out;
  for (const [kind, keys] of KEYS) {
    const hit = keys.map((key) => video[key]).find((v) => v && v.video && !seen.has(v.video));
    if (!hit) continue;
    seen.add(hit.video);
    out.push({ kind, src: hit.video, preview: hit.previewFrame || null });
  }
  return out;
}

/** 编码家族：hevc（含杜比视界）/ avc / other */
export function codecFamily(codec) {
  if (/^(hvc1|hev1|dvh1|dvhe)/i.test(codec || '')) return 'hevc';
  if (/^avc[13]/i.test(codec || '')) return 'avc';
  return 'other';
}

const FAMILY_ORDER = { hevc: 0, avc: 1, other: 2 };

async function fetchText(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Motion artwork HTTP ${res.status}`);
  return res.text();
}

const cache = new Map();
/** master 的视频变体与时长（时长取自其中一个 media playlist，各变体相同），用来估算文件大小 */
export function loadMotion(src, signal) {
  if (!cache.has(src)) {
    const p = (async () => {
      const variants = parseMaster(await fetchText(src, signal), src).filter((v) => v.width && v.height);
      if (!variants.length) throw new Error('No motion artwork variant');
      let duration = 0;
      try {
        const smallest = [...variants].sort((a, b) => a.average - b.average)[0];
        duration = parseMedia(await fetchText(smallest.url, signal), smallest.url).duration;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
      }
      return { variants, duration };
    })();
    p.catch(() => cache.delete(src));
    cache.set(src, p);
  }
  return cache.get(src);
}

/** 菜单里列出的最小短边：更小的（360、408、456 等缩略图档）只在该编码没有更大的时列出 */
const MIN_CHOICE = 480;

/** 每种编码、分辨率与动态范围保留码率最高的一个；HEVC 在前，各组内分辨率从高到低 */
export function motionChoices(variants) {
  const best = new Map();
  const short = (v) => Math.min(v.width, v.height);
  const big = new Set(variants.filter((v) => short(v) >= MIN_CHOICE).map((v) => codecFamily(v.codec)));
  for (const v of variants) {
    if (short(v) < MIN_CHOICE && big.has(codecFamily(v.codec))) continue;
    const key = `${codecFamily(v.codec)}|${v.width}x${v.height}|${v.range}`;
    const had = best.get(key);
    if (!had || v.average > had.average) best.set(key, v);
  }
  return [...best.values()].sort((a, b) => FAMILY_ORDER[codecFamily(a.codec)] - FAMILY_ORDER[codecFamily(b.codec)]
    || b.width * b.height - a.width * a.height || (a.range === 'SDR' ? -1 : 0) - (b.range === 'SDR' ? -1 : 0) || b.average - a.average);
}

/**
 * codec：'hevc' | 'avc'（没有这种编码时用另一种）；max：短边上限（像素，2160 / 1440 / 1080 / 720），
 * 都超过时取最小的。有 SDR 时只在 SDR 中选（HDR 在普通屏幕上发灰）；同一分辨率取码率最高的
 */
export function pickMotion(variants, { codec = 'hevc', max = 2160 } = {}) {
  let list = variants.filter((v) => codecFamily(v.codec) === codec);
  if (!list.length) list = variants.filter((v) => codecFamily(v.codec) !== 'other');
  if (!list.length) list = variants;
  if (list.some((v) => v.range === 'SDR')) list = list.filter((v) => v.range === 'SDR');
  const short = (v) => Math.min(v.width, v.height);
  const fit = list.filter((v) => short(v) <= max);
  const pool = fit.length ? fit : [list.reduce((a, b) => (short(b) < short(a) ? b : a))];
  return pool.reduce((a, b) => (b.width * b.height > a.width * a.height || (b.width * b.height === a.width * a.height && b.average > a.average) ? b : a));
}

/** 文件名与下载中心用的简短描述，如「2160×2160 HEVC」 */
export function motionQuality(v) {
  const name = { hevc: 'HEVC', avc: 'H.264', other: (v.codec || '').split('.')[0] }[codecFamily(v.codec)];
  return `${v.width}×${v.height} ${name}${v.range && v.range !== 'SDR' ? ` ${v.range}` : ''}`;
}

/** 估算的文件大小（字节）：平均码率 × 时长 */
export function motionEstimate(v, duration) {
  return duration ? Math.round((v.average / 8) * duration) : 0;
}

async function fetchBytes(piece, signal) {
  const headers = piece.start === undefined ? {} : { Range: `bytes=${piece.start}-${piece.end}` };
  const res = await fetch(piece.url, { headers, signal, priority: 'low' });
  if (!res.ok) throw new Error(`Motion artwork HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** 同时请求的分片数（每片约 3 秒，最高档约 7 MB） */
const PARALLEL = 4;

/**
 * 下载一个变体并改写为普通 MP4。onProgress(done, total)：total 由 BYTERANGE 算出，没有时为 0。
 * 改写失败时保存原样的 fMP4（仍可播放）。返回 { file, size, crc, dispose }，crc 为 ZIP 用的 CRC-32（可能为 null）
 */
export async function downloadMotion(variant, { signal, onProgress } = {}) {
  const media = parseMedia(await fetchText(variant.url, signal), variant.url);
  const pieces = [media.init, ...media.segments];
  const total = pieces.every((p) => p.start !== undefined) ? pieces.reduce((n, p) => n + p.end - p.start + 1, 0) : 0;
  const parts = new Array(pieces.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < pieces.length) {
      const i = next++;
      parts[i] = await fetchBytes(pieces[i], signal);
      done += parts[i].byteLength;
      if (onProgress) onProgress(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, pieces.length) }, worker));
  signal?.throwIfAborted();
  const fragmented = new Blob(parts, { type: 'video/mp4' });
  let file = fragmented;
  let crc = null;
  const { Core } = await import('../mv/engine.mjs');
  const core = new Core();
  const abort = () => core.close();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const out = await core.call('defragVideo', fragmented);
    file = out.blob;
    crc = out.crc;
    core.recycle();
  } catch (err) {
    core.close();
    if (signal?.aborted) throw err;
    console.warn('[am-hook] 动态封面改写为普通 MP4 失败，保存原样的 fMP4', err);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  signal?.throwIfAborted();
  return { file: new Blob([file], { type: 'video/mp4' }), size: file.size, crc, dispose() {} };
}

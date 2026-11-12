// 动态封面（专辑 / 歌单 editorialVideo.motionDetailSquare / motionDetailTall，艺人头部 motionArtist*），复刻 music.apple.com 的 amp-ambient-video：
// 静音循环播放、淡入盖在静态封面上；与官网 MotionVideo 的播放条件相同：进入视口、页面处于活动状态（可见且窗口未失焦）、
// 没有打开全屏界面（这里是歌词界面）、系统未开启「减少动态效果」，任一不满足即暂停。
// 片源是无加密的 fMP4 HLS（单文件 + BYTERANGE，mvod.itunes.apple.com 允许跨域与 Range），用 MSE 逐段追加。

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// 页面活动状态（官网 TVe）：初始取页面是否可见，之后 blur → 否、focus → 是、visibilitychange → 是否可见
let pageActive = document.visibilityState === 'visible';
const activeListeners = new Set();
const setActive = (value) => { pageActive = value; for (const fn of activeListeners) fn(); };
document.addEventListener('visibilitychange', () => setActive(document.visibilityState === 'visible'));
addEventListener('blur', () => setActive(false));
addEventListener('focus', () => setActive(true));

/** 全屏界面（歌词）打开时暂停（官网 pauseForFullScreenModal） */
const fullscreenOpen = () => document.body.classList.contains('lyrics-open');

function attributes(value) {
  const result = {};
  for (const m of value.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/g)) result[m[1]] = m[2] ?? m[3];
  return result;
}

/** master 中的视频变体：[{ url, codec, size }]，size 为较长边像素 */
export function parseMaster(text, base) {
  const variants = [];
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) pending = attributes(line.slice(18));
    else if (line && !line.startsWith('#') && pending) {
      const [w, h] = (pending.RESOLUTION || '0x0').split('x').map(Number);
      variants.push({ url: new URL(line, base).href, codec: (pending.CODECS || '').split(',')[0], size: Math.max(w, h), bandwidth: Number(pending.BANDWIDTH) || 0 });
      pending = null;
    }
  }
  return variants;
}

/** media playlist：init 与各分片（同一文件内的字节区间） */
export function parseMedia(text, base) {
  let init = null;
  let range = null;
  let previous = null;
  const segments = [];
  const resource = (uri, spec) => {
    const url = new URL(uri, base).href;
    if (!spec) return { url };
    const [length, offset] = spec.split('@').map(Number);
    const start = Number.isFinite(offset) ? offset : previous && previous.url === url ? previous.end : 0;
    previous = { url, end: start + length };
    return { url, start, end: start + length - 1 };
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = attributes(line.slice(11));
      init = resource(a.URI, a.BYTERANGE);
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.slice(17);
    else if (line.startsWith('#EXT-X-KEY:') && !/METHOD=NONE/.test(line)) throw new Error('Encrypted motion artwork is not supported');
    else if (line && !line.startsWith('#')) {
      segments.push(resource(line, range));
      range = null;
    }
  }
  if (!init || !segments.length) throw new Error('Invalid motion artwork playlist');
  return { init, segments };
}

/** 选浏览器能解码、且不小于显示尺寸的最小变体（与官网一样按容器大小取清晰度） */
export function pickVariant(variants, target, isSupported) {
  const playable = variants.filter((v) => v.size && isSupported(v.codec));
  if (!playable.length) return null;
  playable.sort((a, b) => a.size - b.size || a.bandwidth - b.bandwidth);
  return playable.find((v) => v.size >= target) || playable[playable.length - 1];
}

async function fetchBytes(resource, signal) {
  const headers = resource.start === undefined ? {} : { Range: `bytes=${resource.start}-${resource.end}` };
  const res = await fetch(resource.url, { headers, signal });
  if (!res.ok) throw new Error(`Motion artwork HTTP ${res.status}`);
  return res.arrayBuffer();
}

const MediaSourceImpl = globalThis.ManagedMediaSource || globalThis.MediaSource;
const mime = (codec) => `video/mp4; codecs="${codec}"`;

/**
 * 在 container 中挂载动态封面，返回 { destroy }。container 里原有的静态封面保留为占位，视频开始播放后淡入覆盖。
 */
export function mountMotionArt(container, { src }) {
  const video = document.createElement('video');
  Object.assign(video, { muted: true, loop: true, playsInline: true, autoplay: false, disablePictureInPicture: true, disableRemotePlayback: true });
  video.defaultMuted = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('aria-hidden', 'true');
  video.className = 'motion-video';
  const controller = new AbortController();
  let objectUrl = null;
  let loading = null;
  let visible = false;
  let destroyed = false;

  const shouldPlay = () => !destroyed && visible && pageActive && !fullscreenOpen() && !reducedMotion.matches;

  async function load() {
    const master = await (await fetch(src, { signal: controller.signal })).text();
    const box = container.getBoundingClientRect();
    const target = Math.max(box.width, box.height) * Math.min(devicePixelRatio || 1, 2);
    if (MediaSourceImpl) {
      const variant = pickVariant(parseMaster(master, src), target, (codec) => MediaSourceImpl.isTypeSupported(mime(codec)));
      if (!variant) throw new Error('No playable motion artwork variant');
      const media = parseMedia(await (await fetch(variant.url, { signal: controller.signal })).text(), variant.url);
      const ms = new MediaSourceImpl();
      objectUrl = URL.createObjectURL(ms);
      video.src = objectUrl;
      await new Promise((resolve) => ms.addEventListener('sourceopen', resolve, { once: true }));
      const sb = ms.addSourceBuffer(mime(variant.codec));
      const append = (buffer) => new Promise((resolve, reject) => {
        sb.addEventListener('updateend', resolve, { once: true });
        sb.addEventListener('error', reject, { once: true });
        sb.appendBuffer(buffer);
      });
      // 先放 init + 第一段就能开始播放，其余分片依次追加
      await append(await fetchBytes(media.init, controller.signal));
      for (const [i, segment] of media.segments.entries()) {
        const bytes = await fetchBytes(segment, controller.signal);
        await append(bytes);
        // 循环片段是从长视频中截出的，分片时间戳不从 0 开始（如 10s–20s）：整体平移到 0，否则 0 处无数据无法起播
        if (i === 0 && sb.buffered.length && sb.buffered.start(0) > 0.05) {
          const offset = -sb.buffered.start(0);
          await new Promise((resolve) => { sb.addEventListener('updateend', resolve, { once: true }); sb.remove(0, Infinity); });
          sb.timestampOffset = offset;
          await append(bytes);
        }
        if (i === 0) sync();
      }
      if (ms.readyState === 'open') ms.endOfStream();
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src; // Safari 原生 HLS
    } else {
      throw new Error('Motion artwork needs MSE or native HLS');
    }
  }

  function sync() {
    if (!shouldPlay()) { video.pause(); return; }
    // 首次可见时才开始下载
    if (!loading) {
      loading = load().catch((err) => {
        if (!destroyed && err.name !== 'AbortError') console.warn('[am-hook] 动态封面不可用', err);
        video.remove();
      });
    }
    if (video.src) video.play().catch(() => {});
  }

  video.addEventListener('playing', () => video.classList.add('ready'));
  const observer = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    sync();
  });
  observer.observe(container);
  const onChange = () => sync();
  activeListeners.add(onChange);
  reducedMotion.addEventListener('change', onChange);
  // 歌词界面开关（body.lyrics-open）
  const bodyObserver = new MutationObserver(onChange);
  bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  container.append(video);

  return {
    video,
    destroy() {
      destroyed = true;
      controller.abort();
      observer.disconnect();
      bodyObserver.disconnect();
      activeListeners.delete(onChange);
      reducedMotion.removeEventListener('change', onChange);
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
  };
}

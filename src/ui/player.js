/*
 * am-hook 简易在线播放器
 *
 * 播放方式按优先级：
 *   1. MSE：浏览器直接从 Apple CDN 获取 media m3u8 与分段，在 Worker 中用 wasm 解密（decrypt.js）
 *      后逐段喂给 SourceBuffer。只缓冲当前位置之后 ~45s，拖动时直接定位到对应 segment。
 *   2. EC-3 回退：原生 MSE 不可用时，按需加载 ec3.wasm，解码为 5.1/7.1 PCM。
 *   3. ALAC 回退：浏览器不支持 ALAC 时转为 FLAC-in-MP4 后交给 MSE。
 */
(function (global) {
  'use strict';

  const AHEAD_SECONDS = 45;
  // ALAC -> FLAC expands each source segment into several fMP4 fragments.
  // Keep this window small enough that the current and chained next track do
  // not fill the browser's SourceBuffer quota before eviction can run.
  const FLAC_AHEAD_SECONDS = 14;
  // Chrome's audio SourceBuffer quota is about 12 MB. When the played part
  // cannot free enough, its garbage collector deletes from the buffer's end,
  // leaving a hole in audio already recorded as appended. 96 kHz / 24-bit FLAC
  // reaches ~576 KB/s, so limit the window by measured bytes, not only seconds.
  const FLAC_BUFFER_BYTES = 8 * 1024 * 1024;
  const FLAC_MIN_AHEAD_SECONDS = 4;
  const FLAC_BEHIND_SECONDS = 2;
  const BEHIND_SECONDS = 30;
  /** 分段加载失败后自动重试的次数（间隔 3、6、12、24、48 秒），之后等用户点「立即重试」 */
  const MAX_RETRIES = 5;

  /**
   * 失败后的自动重试（MseEngine 与 PcmEngine 共用），状态记在引擎上：failures、retryAt、gaveUp、retryTimer。
   * 间隔从 3 秒起按连续失败次数翻倍，加 ±20% 抖动，避免故障期间所有客户端同步打过去；
   * 重试 MAX_RETRIES 次仍失败后停止（gaveUp），等用户点「立即重试」。等待期间引擎不应自行加载（retryAt / gaveUp）
   */
  function scheduleRetry(engine, run) {
    clearTimeout(engine.retryTimer);
    if (engine.failures >= MAX_RETRIES) {
      engine.gaveUp = true;
      return;
    }
    const delay = 3000 * 2 ** engine.failures * (0.8 + Math.random() * 0.4);
    engine.failures++;
    engine.retryAt = Date.now() + delay;
    engine.retryTimer = setTimeout(() => {
      engine.retryAt = null;
      if (engine.onRetry) engine.onRetry();
      run();
    }, delay);
  }

  /** 成功、手动重试或换曲：清空重试状态 */
  function resetRetry(engine) {
    clearTimeout(engine.retryTimer);
    engine.retryTimer = null;
    engine.failures = 0;
    engine.retryAt = null;
    engine.gaveUp = false;
  }

  /** time 所在 segment 下标 */
  function segmentAt(segments, time) {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].time <= time) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function mimeFor(codecs) {
    return `audio/mp4; codecs="${codecs || 'mp4a.40.2'}"`;
  }

  // 运行时确认播放失败的编码（检测结果不可靠时以实际结果为准）
  const failedCodecs = new Set();

  /**
   * JOC 对象渲染（E-AC-3 Dolby Atmos，见 joc-decode-worker.js）的设置：{ mode: off / speaker / binaural, gain（dB）, dataset }。
   * app.mjs 用 useJocSettings 接上 prefs.mjs 的 'joc' 分组（{ get, set }）；没有接上时（如 Node 测试）按关闭处理
   */
  const JOC_OFF = { mode: 'off', gain: 0, dataset: 'D2' };
  let jocStore = null;
  function useJocSettings(store) { jocStore = store; }
  function jocSettings() { return jocStore ? jocStore.get() : JOC_OFF; }

  function isEc3(codecs) { return /^(ec-3|ec3)$/i.test(String(codecs)); }
  /** JOC 的两种输出：joc2 = Speaker 2.0，jocbin = 双耳 */
  function isJocMode(mode) { return mode === 'joc2' || mode === 'jocbin'; }
  /** 自己调度 PCM（Web Audio）的播放方式：内置 EC-3 解码与 JOC 渲染 */
  function isPcmMode(mode) { return mode === 'ec3' || isJocMode(mode); }

  /**
   * 该编码在当前浏览器中可尝试的播放方式（按优先级），空数组表示不支持。
   * 全部由浏览器端解密；EC-3 按 JOC（设置中心开启时：双耳 -> Speaker 2.0）-> MSE -> PCM 检测，ALAC 可回退为 FLAC。
   */
  function detectModes(codecs) {
    if (failedCodecs.has(codecs)) return [];
    const mime = mimeFor(codecs);
    const modes = [];
    const decrypt = global.AmDecrypt && global.AmDecrypt.supported();
    const MS = global.ManagedMediaSource || global.MediaSource;
    const pcm = decrypt && global.Worker && global.WebAssembly && (global.AudioContext || global.webkitAudioContext);
    const joc = isEc3(codecs) && pcm ? jocSettings().mode : 'off';
    // 双耳失败（如 HRTF 无效）时退回 Speaker 2.0，再失败才用浏览器自己的解码
    if (joc === 'binaural') modes.push('jocbin');
    if (joc !== 'off') modes.push('joc2');
    if (MS && MS.isTypeSupported && MS.isTypeSupported(mime) && decrypt) modes.push('mse');
    if (isEc3(codecs)) {
      if (pcm) modes.push('ec3');
      return modes;
    }
    if (String(codecs).toLowerCase() === 'alac' && MS && MS.isTypeSupported &&
        MS.isTypeSupported(mimeFor('flac')) && global.Worker && decrypt) modes.push('flac');
    return modes;
  }

  function detectMode(codecs) {
    return detectModes(codecs)[0] || null;
  }

  /** 界面文案（i18n.js）；未加载时直接返回 key */
  function t(key, vars) {
    return global.AmI18n ? global.AmI18n.t(key, vars) : key;
  }

  /** 不能在浏览器内播放时给用户的建议 */
  function fallbackHint() {
    return t('player.hintDownload');
  }

  /** 建一个元素：className 可为空，children 中的空值跳过 */
  function el(doc, tag, className, ...children) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    node.append(...children.filter((child) => child != null && child !== false && child !== ''));
    return node;
  }

  /**
   * 播放音质的设置（设置中心「播放」，prefs.mjs 的 playbackFor）：{ quality: efficient / high / lossless / hires, spatial: auto / always / off,
   * transition: off / automix / crossfade（歌曲之间的过渡，见 Mixer）, crossfade（交叉淡化的秒数）}，quality 已按当前网络（Wi-Fi / 移动数据）取好。
   * app.mjs 用 usePlaybackSettings 接上（{ get, set }，set 供待播清单里的 AutoMix 开关修改 transition）；
   * 没有接上时（如 Node 测试）为最高音质、自动、不做过渡
   */
  const PLAYBACK_DEFAULT = { quality: 'hires', spatial: 'auto', transition: 'off', crossfade: 6 };
  let playbackStore = null;
  function usePlaybackSettings(store) { playbackStore = store; }
  function playbackSettings() { return playbackStore ? playbackStore.get() : PLAYBACK_DEFAULT; }

  /** 队列是否优先选杜比全景声：始终，或自动（开启 JOC 对象渲染时）；「高效」音质下不选（码率是 HE-AAC 的十倍以上） */
  function preferAtmos(settings = playbackSettings()) {
    if (settings.quality === 'efficient' || settings.spatial === 'off') return false;
    return settings.spatial === 'always' || jocSettings().mode !== 'off';
  }

  /* ---------- 播放队列的曲目：逐首解析 master，按播放音质设置选浏览器能播放的变体 ---------- */
  function rankVariant(v) {
    const g = v.group_id.toLowerCase();
    // 优先全景声时排在 ALAC 前面（音质详情的列表顺序与队列的最后退路）
    const atmosFirst = preferAtmos();
    if (g.includes('alac')) return atmosFirst ? 1 : 0;
    if (g.includes('atmos')) return atmosFirst ? 0 : 1;
    return g.includes('he-') ? 3 : 2;
  }

  /** 变体的种类：alac / atmos / aac（AAC-LC 立体声）/ he（HE-AAC 立体声）/ other（双耳、缩混等） */
  function variantKind(v) {
    const g = v.group_id.toLowerCase();
    if (g.includes('alac')) return 'alac';
    if (g.includes('atmos') && !g.includes('downmix')) return 'atmos';
    if (g.includes('binaural') || g.includes('downmix')) return 'other';
    return g.includes('he-') ? 'he' : 'aac';
  }

  function sampleRate(v) {
    return v.sample_rate || Number((v.group_id.match(/alac-stereo-(\d+)/i) || [])[1]) || 0;
  }

  /** 各播放音质依次尝试的种类（alac 带采样率上限）；都没有时退到 sortVariants 的顺序 */
  const QUALITY_STEPS = {
    hires: [['alac', 192000], ['aac'], ['he']],
    lossless: [['alac', 48000], ['aac'], ['he']],
    high: [['aac'], ['he'], ['alac', 48000]],
    efficient: [['he'], ['aac'], ['alac', 48000]],
  };

  /** 按播放音质设置从 master 的变体中选浏览器能播放的一个；没有可播放的返回 undefined */
  function pickPlayable(variants, settings = playbackSettings()) {
    const playable = variants.filter((v) => detectMode(v.codecs));
    const steps = [...(preferAtmos(settings) ? [['atmos']] : []), ...(QUALITY_STEPS[settings.quality] || QUALITY_STEPS.hires)];
    for (const [kind, maxRate] of steps) {
      const list = playable.filter((v) => variantKind(v) === kind && (!maxRate || sampleRate(v) <= maxRate));
      if (!list.length) continue;
      // 同类取最高：ALAC 按采样率与位深，其余按码率
      const rank = (v) => (kind === 'alac' ? sampleRate(v) * 100 + (v.bit_depth || 0) : v.bandwidth || 0);
      return list.reduce((best, v) => (rank(v) > rank(best) ? v : best));
    }
    return sortVariants(playable)[0];
  }

  function variantLabel(v) {
    const g = v.group_id.toLowerCase();
    if (g.includes('alac')) {
      const spec = [v.bit_depth && `${v.bit_depth}-bit`, v.sample_rate && `${(v.sample_rate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`].filter(Boolean).join(' / ');
      return `ALAC${spec ? ' · ' + spec : ''}`;
    }
    if (g.includes('atmos')) {
      // GROUP-ID 形如 atmos-2768：首位是版本号，后三位才是码率（768 kbps）
      const raw = Number((g.match(/atmos-(\d+)/) || [])[1]) || 0;
      const kbps = raw >= 1000 ? raw % 1000 : raw;
      return `Dolby Atmos${kbps ? ' · ' + kbps + ' kbps' : ''}`;
    }
    const kbps = Number((g.match(/stereo-(\d+)/) || [])[1]) || 0;
    return `${g.includes('he-') ? 'HE-AAC' : 'AAC'}${kbps ? ' · ' + kbps + ' kbps' : ''}`;
  }

  /** 变体名称后的附加标签（双耳渲染、全景声的立体声缩混） */
  function variantTags(v) {
    const g = v.group_id.toLowerCase();
    return [g.includes('binaural') && t('q.binaural'), g.includes('downmix') && t('q.downmix')].filter(Boolean);
  }

  /** CODECS 的通用名称：alac → ALAC，ec-3 → E-AC-3，mp4a.40.2 → AAC-LC 等 */
  function codecName(codecs) {
    const c = String(codecs || '').toLowerCase();
    if (c === 'alac') return 'ALAC';
    if (c === 'ec-3' || c === 'ec3') return 'E-AC-3';
    if (c === 'ac-3') return 'AC-3';
    if (c === 'mp4a.40.2') return 'AAC-LC';
    if (c === 'mp4a.40.5') return 'HE-AAC';
    if (c === 'mp4a.40.29') return 'HE-AAC v2';
    return codecs || '';
  }

  function formatRate(bps) {
    if (!bps) return '';
    return bps >= 1e6 ? `${(bps / 1e6).toFixed(2)} Mbps` : `${Math.round(bps / 1000)} kbps`;
  }

  /**
   * 艺人行（如「KAROL G, Judeline & rusowsky」）中每位艺人的名字链接到其艺人页，分隔符保持原样；
   * 名字对不上（如译名不同）而只有一位艺人时，整行链接到该艺人。artists: [{ name, href }]
   */
  function artistNodes(text, artists, doc = global.document) {
    const named = (artists || []).filter((a) => a && a.name && a.href).sort((a, b) => b.name.length - a.name.length);
    const link = (artist, label = artist.name) => Object.assign(doc.createElement('a'), { href: artist.href, textContent: label });
    const word = /[\p{L}\p{N}]/u;
    const nodes = [];
    let plain = '';
    let linked = false;
    for (let i = 0; i < text.length;) {
      // 名字前后不能紧挨字母或数字，避免把长名字里的一段当成另一位艺人
      const hit = (i === 0 || !word.test(text[i - 1])) && named.find((a) => text.startsWith(a.name, i)
        && !word.test(text[i + a.name.length] || ''));
      if (hit) {
        if (plain) nodes.push(plain);
        plain = '';
        nodes.push(link(hit));
        i += hit.name.length;
        linked = true;
      } else plain += text[i++];
    }
    if (plain) nodes.push(plain);
    if (text && !linked && named.length === 1) return [link(named[0], text)];
    return nodes;
  }

  /**
   * 音质标签：ALAC 高于 48 kHz 为 Hi-Res Lossless，其余 ALAC 为 Lossless；杜比全景声为 Dolby Atmos，
   * 其双耳渲染版本为 Spatial Audio；AAC、HE-AAC 与全景声的立体声缩混为 AAC
   */
  function qualityBadge(v) {
    const g = ((v && v.group_id) || '').toLowerCase();
    if (!g) return '';
    if (g.includes('alac')) return v.sample_rate > 48000 ? 'hires' : 'lossless';
    if (g.includes('atmos') && !g.includes('downmix')) return g.includes('binaural') ? 'spatial' : 'atmos';
    return 'lossy';
  }

  /** 音质标志的文字说明；图标本身在 app.css 的 .q-icon--{key} 里（每个页面都加载 app.css，不另发请求） */
  const QUALITY_BADGES = {
    hires: 'Hi-Res Lossless',
    lossless: 'Lossless',
    atmos: 'Dolby Atmos',
    spatial: 'Spatial Audio',
    lossy: 'AAC',
    adm: 'Apple Digital Master',
  };

  /** 音质标志元素（播放条与各页面共用），key 取自 qualityBadge；未知 key 返回 null */
  function qualityIcon(key, doc = global.document) {
    const label = QUALITY_BADGES[key];
    if (!label) return null;
    const node = Object.assign(doc.createElement('span'), { className: `q-icon q-icon--${key}`, title: label });
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', label);
    return node;
  }

  /** 换歌后开始滚动前的停留时间（与 music.apple.com 相同） */
  const MARQUEE_DELAY = 3000;

  /**
   * 播放条（以及全屏播放界面标题行，见 lyrics/panel.mjs）的滚动字幕，照 music.apple.com 播放条（LCD）的 marquee 组件实现：
   *   放得下时静止；放不下时右侧渐隐，换歌 3 秒后滚动一遍（约 20px/s，副本首尾相接），滚完回到开头；
   *   鼠标移入时暂停（方便点击移动中的链接），移出后继续，已停下时再滚一遍。
   *   滚动时两侧渐隐，原文完全移出后去掉左侧渐隐（is-near-end）。
   * 结构：.marquee-line > .marquee-line__mask > .marquee-line__scroller > 原文 + aria-hidden 副本
   */
  class Marquee {
    constructor(host) {
      const doc = host.ownerDocument;
      const view = doc.defaultView;
      const div = (className) => Object.assign(doc.createElement('div'), { className });
      this.line = div('marquee-line inactive');
      this.mask = div('marquee-line__mask');
      this.scroller = div('marquee-line__scroller');
      this.text = Object.assign(doc.createElement('span'), { className: 'marquee-line__text' });
      this.copy = Object.assign(doc.createElement('span'), { className: 'marquee-line__text' });
      const chunk = div('marquee-line__chunk');
      const copyChunk = div('marquee-line__chunk marquee-line__chunk--copy');
      copyChunk.setAttribute('aria-hidden', 'true');
      chunk.append(this.text);
      copyChunk.append(this.copy);
      this.scroller.append(chunk, copyChunk);
      this.mask.append(this.scroller);
      this.line.append(this.mask);
      host.replaceChildren(this.line);
      this.active = false;
      this.timer = 0;
      this.reducedMotion = view.matchMedia('(prefers-reduced-motion: reduce)');
      this.line.addEventListener('mouseenter', () => { if (this.active) this.line.classList.add('is-paused'); });
      this.line.addEventListener('mouseleave', () => this.play());
      this.scroller.addEventListener('animationend', () => this.reset());
      new view.IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting && this.line.classList.contains('is-animating')) this.line.classList.add('is-near-end');
      }, { root: this.mask, threshold: 0 }).observe(this.text);
      // 播放条宽度变化（窗口缩放、歌词界面开关）时重新判断是否放得下
      new view.ResizeObserver(() => this.measure()).observe(this.line);
    }

    /** 换上新内容，放不下时 3 秒后滚动一遍 */
    set(nodes) {
      clearTimeout(this.timer);
      this.reset();
      this.line.classList.remove('is-paused');
      this.text.replaceChildren(...nodes);
      this.copy.replaceChildren(...[...this.text.childNodes].map((node) => node.cloneNode(true)));
      for (const link of this.copy.querySelectorAll('a')) link.tabIndex = -1;
      if (this.measure()) this.timer = setTimeout(() => this.play(), MARQUEE_DELAY);
    }

    measure() {
      const width = this.text.getBoundingClientRect().width;
      // 播放条隐藏时宽度都是 0，按放得下处理
      this.active = width > this.line.clientWidth + 0.5;
      this.line.classList.toggle('active', this.active);
      this.line.classList.toggle('inactive', !this.active);
      if (this.active) {
        const gap = parseFloat(getComputedStyle(this.scroller).getPropertyValue('--marquee-line-padding')) || 0;
        this.scroller.style.setProperty('--marquee-scroll-width', String(width + gap));
      } else this.reset();
      return this.active;
    }

    play() {
      const classes = this.line.classList;
      if (!this.active || this.reducedMotion.matches) return;
      if (classes.contains('is-animating')) classes.remove('is-paused');
      else {
        classes.remove('is-paused', 'is-near-end');
        classes.add('is-animating');
      }
    }

    reset() {
      this.line.classList.remove('is-animating', 'is-near-end');
    }
  }

  /** entry: { track, country, name, artist, artists, album, href, albumHref, artwork } → play() 使用的 item */
  /** 就地打乱 list[start..]（Fisher-Yates） */
  function shuffleFrom(list, start) {
    for (let i = list.length - 1; i > start; i--) {
      const j = start + Math.floor(Math.random() * (i - start + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }

  /** 音质从高到低：ALAC、Atmos、AAC、HE-AAC，同类按码率 */
  function sortVariants(variants) {
    return variants.slice().sort((a, b) => rankVariant(a) - rankVariant(b) || (b.bandwidth || 0) - (a.bandwidth || 0));
  }

  /** 某个变体对应的播放条目字段（换音质时与原条目的歌曲信息合并） */
  function variantItem(track, v) {
    return {
      id: `${track}:${v.group_id}`,
      codecs: v.codecs,
      m3u8Url: v.m3u8Url || v.url,
      label: variantLabel(v),
      badge: qualityBadge(v),
      variant: v,
    };
  }

  async function resolveEntry(entry) {
    const { variants } = await global.AmWrapper.songMaster(entry.track);
    const best = pickPlayable(variants);
    if (!best) throw Object.assign(new Error(t('album.noPlayable', { name: entry.name })), { noPlayable: true });
    return {
      ...variantItem(entry.track, best),
      // 这首歌的全部音质，全屏播放界面的音质详情里可切换
      variants,
      track: entry.track,
      country: entry.country,
      title: entry.name,
      artist: entry.artist,
      artists: entry.artists,
      album: entry.album,
      href: entry.href,
      albumHref: entry.albumHref,
      artwork: entry.artwork,
    };
  }

  /** 空闲的 FLAC 转码 Worker：换曲时复用，不必每首都重新加载 flac.wasm 与 flac-init.bin；空闲 30 秒后终止 */
  const idleFlacWorkers = [];

  class FlacTranscoder {
    constructor() {
      this.worker = idleFlacWorkers.pop() || new Worker('/assets/flac-transcode-worker.js');
      clearTimeout(this.worker.idleTimer);
      this.pending = new Map();
      this.seq = 0;
      this.worker.onmessage = ({ data }) => {
        const job = this.pending.get(data.id);
        if (!job) return;
        this.pending.delete(data.id);
        if (data.ok) job.resolve(data.result);
        else job.reject(new Error(data.error));
      };
      this.worker.onerror = (event) => {
        for (const job of this.pending.values()) job.reject(new Error(event.message || 'FLAC Worker failed'));
        this.pending.clear();
      };
    }

    run(op, buf) {
      // 销毁后 Worker 可能已交给别的曲目，不能再向它发消息
      if (!this.worker) return Promise.reject(new DOMException('stale', 'AbortError'));
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, op, buf }, [buf]);
      });
    }

    destroy() {
      const worker = this.worker;
      if (!worker) return;
      this.worker = null;
      // 没有进行中的任务时放回空闲列表（当前曲目与预载的下一首最多同时用两个），否则终止
      if (this.pending.size || idleFlacWorkers.length >= 2) {
        worker.terminate();
        for (const job of this.pending.values()) job.reject(new DOMException('stale', 'AbortError'));
        this.pending.clear();
        return;
      }
      worker.onmessage = worker.onerror = null;
      worker.postMessage({ op: 'reset' });
      worker.idleTimer = setTimeout(() => {
        idleFlacWorkers.splice(idleFlacWorkers.indexOf(worker), 1);
        worker.terminate();
      }, 30000);
      idleFlacWorkers.push(worker);
    }
  }

  class Ec3Decoder {
    constructor() {
      this.worker = new Worker('/assets/ec3-decode-worker.js');
      this.pending = new Map();
      this.seq = 0;
      this.worker.onmessage = ({ data }) => {
        const job = this.pending.get(data.id);
        if (!job) return;
        this.pending.delete(data.id);
        if (data.ok) job.resolve(data.result);
        else job.reject(new Error(data.error));
      };
      this.worker.onerror = (event) => {
        for (const job of this.pending.values()) job.reject(new Error(event.message || 'EC-3 Worker failed'));
        this.pending.clear();
      };
    }

    decode(buf) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, op: 'decode', buf }, [buf]);
      });
    }

    flush() {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, op: 'flush' });
      });
    }

    destroy() {
      this.worker.terminate();
      for (const job of this.pending.values()) job.reject(new DOMException('stale', 'AbortError'));
      this.pending.clear();
    }
  }

  /** 空闲的 JOC Worker：换曲时复用，ec3.wasm、joc.wasm 与 HRTF 不必重新加载；空闲 30 秒后终止 */
  const idleJocWorkers = [];

  /** joc-decode-worker.js 的主线程一侧：每个请求一个 id，按 id 回复 */
  class JocDecoder {
    constructor() {
      this.worker = idleJocWorkers.pop() || new Worker('/assets/joc-decode-worker.js', { type: 'module' });
      clearTimeout(this.worker.idleTimer);
      this.pending = new Map();
      this.seq = 0;
      /** 低延迟模式的事件（primed / scene / peak / error，没有 id），见 JocLiveEngine */
      this.onEvent = null;
      this.worker.onmessage = ({ data }) => {
        if (data.event) { if (this.onEvent) this.onEvent(data); return; }
        const job = this.pending.get(data.id);
        if (!job) return;
        // 分段分批渲染：每批先交给 onPart，整段结束才 resolve
        if (data.part) { if (job.onPart) job.onPart(data.result); return; }
        this.pending.delete(data.id);
        if (data.ok) job.resolve(data.result);
        else job.reject(new Error(data.error));
      };
      this.worker.onerror = (event) => {
        for (const job of this.pending.values()) job.reject(new Error(event.message || 'JOC Worker failed'));
        this.pending.clear();
        this.broken = true;
      };
    }

    request(op, payload = {}, transfer = [], onPart = null) {
      if (!this.worker) return Promise.reject(new DOMException('stale', 'AbortError'));
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, onPart });
        this.worker.postMessage({ id, op, ...payload }, transfer);
      });
    }

    /** options: { mode: 'speaker' | 'binaural', gainDb, dataset, controls, port（低延迟模式，放进 transfer）, live } */
    open(options, transfer = []) { return this.request('open', options, transfer); }
    /** 不等回复的消息（交互控制每帧都可能发） */
    post(op, payload = {}) { if (this.worker) this.worker.postMessage({ op, ...payload }); }
    /** 解一个分段：已渲染的部分分批交给 onPart({ frames, samples, peak })；被 abort 时结果为 { aborted: true } */
    decode(buf, onPart) { return this.request('decode', { buf }, [buf], onPart); }
    /** 让进行中的分段在下一批之前停下（Seek 开始时，不必等它解完） */
    abort() { if (this.worker) this.worker.postMessage({ op: 'abort' }); }
    /** Seek：清空渲染器与 EC-3 解码器，之后输出的前 skipFrames 帧丢掉（预滚） */
    reset(skipFrames) { return this.request('reset', { skipFrames }); }
    setGain(gainDb) { return this.request('gain', { gainDb }); }
    /** 输入结束：取回渲染器还留着的帧（双耳的 961 样本延迟与房间尾音） */
    finish() { return this.request('finish'); }

    destroy() {
      const worker = this.worker;
      if (!worker) return;
      this.worker = null;
      // 有进行中的任务（或 Worker 出过错）时终止，否则关闭流后放回空闲列表
      if (this.pending.size || this.broken || idleJocWorkers.length) {
        worker.terminate();
        for (const job of this.pending.values()) job.reject(new DOMException('stale', 'AbortError'));
        this.pending.clear();
        return;
      }
      worker.onmessage = worker.onerror = null;
      worker.postMessage({ op: 'close' });
      worker.idleTimer = setTimeout(() => {
        idleJocWorkers.splice(idleJocWorkers.indexOf(worker), 1);
        worker.terminate();
      }, 30000);
      idleJocWorkers.push(worker);
    }
  }

  /**
   * EC-3 与 JOC 都是 48 kHz：AudioContext 也用 48 kHz，设备采样率不同时由浏览器在输出端整体重采样
   * （AudioBuffer 与上下文采样率不同时，各 AudioBufferSourceNode 只做线性插值）。不支持该选项的浏览器用默认值。
   * latencyHint 见各引擎的 latencyHint
   */
  function pcmContext(latencyHint) {
    const Context = global.AudioContext || global.webkitAudioContext;
    try { return new Context({ sampleRate: 48000, latencyHint }); } catch { return new Context(); }
  }

  /** Bounded, on-demand multichannel PCM playback for EC-3. */
  class PcmEngine {
    /** 提前排好约 20 秒的音频，输出端用大缓冲（Android 上 outputLatency 约 0.3 秒）省电、不易断音 */
    get latencyHint() { return 'playback'; }

    constructor(onUpdate, onError, onEnded) {
      this.onUpdate = onUpdate;
      this.onError = onError;
      this.onEnded = onEnded;
      this.context = pcmContext(this.latencyHint);
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      /** 音量调节前的整个混音；歌词背景的节拍律动从这里取样（见 AmPlayer.pulseSource） */
      this.mix = this.context.createGain();
      this.mix.connect(this.gain);
      /** 各 AudioBufferSourceNode 接到这里（JocEngine 在 mix 前面加一级淡入淡出） */
      this.input = this.mix;
      this.nodes = new Set();
      this.paused = true;
      this.anchorTime = 0;
      this.anchorContextTime = this.context.currentTime + 0.03;
      this.loadedUntil = 0;
      this.generation = 0;
      /** 加载出错后等待恢复（与 MseEngine 相同，见 fail / recovered）；retryMode 为恢复方式：'pump' 接着加载，'seek' 从当前位置重新开始 */
      this.failed = false;
      this.failures = 0;
      this.retryAt = null;
      this.gaveUp = false;
      /** 出错后缓冲播完而暂停：恢复后自动继续播放 */
      this.stalled = false;
      this.timer = setInterval(() => {
        if (!this.paused && this.duration && this.currentTime >= this.duration) {
          this.pause();
          if (this.onEnded) this.onEnded();
        }
        // 出错后已排好的缓冲照常播放，播完才停下等待重试，免得时钟跑到音频前面
        if (!this.paused && this.failed && !this.seeking && this.currentTime >= this.loadedUntil - 0.05) {
          this.pause();
          this.stalled = true;
        }
        if (!this.paused) this.pump();
        this.onUpdate();
      }, 200);
      // Resume during the click gesture, before the asynchronous playlist request.
      this.started = this.context.resume().then(() => this.context.suspend());
    }

    get currentTime() {
      const time = this.paused ? this.anchorTime
        : this.anchorTime + Math.max(0, this.context.currentTime - this.anchorContextTime);
      return Math.min(this.duration || Infinity, time);
    }

    set currentTime(value) { const pending = this.seek(value); if (pending) pending.catch(() => {}); }

    async load(url) {
      const gen = this.generation;
      await this.started;
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      this.controller = new AbortController();
      this.playlist = await global.AmDecrypt.openTrack(url, this.controller.signal);
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      this.duration = this.playlist.duration;
      this.decoder = new Ec3Decoder();
      this.nextIndex = 0;
      await this.pump(true);
    }

    async pump(first = false) {
      if (this.busy || this.waitingRetry || !this.playlist || !this.decoder) return;
      this.busy = true;
      const gen = this.generation;
      const required = first;
      let decoding = false;
      try {
        const { segments } = this.playlist;
        while (this.nextIndex < segments.length && (first || segments[this.nextIndex].time < this.currentTime + 12)) {
          const seg = segments[this.nextIndex];
          decoding = false;
          const encrypted = await this.playlist.load(seg, this.controller.signal);
          if (gen !== this.generation) return;
          decoding = true;
          const decoded = await this.decoder.decode(encrypted);
          if (gen !== this.generation) return;
          const { channels, rate, samples, chunks } = decoded;
          if (this.channels && (this.channels !== channels || this.rate !== rate)) {
            throw new Error('EC-3 channel layout changed during playback');
          }
          this.channels = channels;
          this.rate = rate;
          let sampleOffset = 0;
          for (const chunk of chunks) {
            const chunkTime = seg.time + sampleOffset / rate;
            const offset = Math.max(0, this.currentTime - chunkTime);
            sampleOffset += chunk.samples;
            if (offset >= chunk.samples / rate) {
              chunk.pcm = null;
              continue;
            }
            const data = new Float32Array(chunk.pcm);
            const buffer = this.context.createBuffer(channels, chunk.samples, rate);
            for (let ch = 0; ch < channels; ch++) {
              // FFmpeg's 7.1 order puts back channels before side channels;
              // Web Audio uses side channels before back channels.
              const sourceCh = channels === 8 ? [0, 1, 2, 3, 6, 7, 4, 5][ch] : ch;
              buffer.copyToChannel(data.subarray(sourceCh * chunk.capacity, sourceCh * chunk.capacity + chunk.samples), ch);
            }
            chunk.pcm = null;
            const node = this.context.createBufferSource();
            node.buffer = buffer;
            node.connect(this.input);
            node.onended = () => { this.nodes.delete(node); node.disconnect(); };
            this.nodes.add(node);
            const when = Math.max(this.context.currentTime + 0.01,
              this.anchorContextTime + chunkTime - this.anchorTime);
            node.start(when, offset);
          }
          this.loadedUntil = Math.max(this.loadedUntil, seg.time + samples / rate);
          this.nextIndex++;
          first = false;
          this.recovered();
          this.onUpdate();
          if (required) break;
        }
      } catch (error) {
        if (required && gen === this.generation) throw error;
        if (error.name !== 'AbortError' && gen === this.generation) this.failLoading(error, decoding);
      } finally {
        this.busy = false;
      }
    }

    /** 等待自动重试或已停止重试：不自行加载 */
    get waitingRetry() { return Boolean(this.retryAt || this.gaveUp); }

    /**
     * 后台加载出错：取分段（含 key）出错时接着加载，已排好的缓冲继续播放；
     * 解码出错时解码器状态不可靠，停下后从当前位置重新开始
     */
    failLoading(error, decoding) {
      if (!decoding) { this.fail(error, 'pump'); return; }
      const resume = !this.paused || this.stalled;
      this.pause();
      this.fail(error, 'seek', resume);
    }

    /**
     * 加载出错：提示后按 MseEngine 的节奏自动重试（scheduleRetry）。mode 为恢复方式：
     * 'pump'（后台加载分段出错）接着加载，已排好的缓冲继续播放；'seek'（Seek 或解码出错）从 anchorTime 重新开始，
     * resume 为之后是否继续播放
     */
    fail(error, mode, resume = false) {
      // 已在等待重新开始（如 Worker 报错的同时进行中的加载也失败）：不重复计数
      if (this.waitingRetry && (this.retryMode === 'seek' || mode === 'pump')) return;
      if (!this.failed && this.onError) this.onError(error);
      this.failed = true;
      this.retryMode = mode;
      this.retryResume = resume;
      scheduleRetry(this, () => this.retry());
      if (this.onRetry) this.onRetry();
    }

    retry() {
      if (this.retryMode !== 'seek') { this.pump(); return; }
      const task = this.seek(this.anchorTime, this.retryResume);
      if (task) task.catch(() => {});
    }

    /** 失败后立即重试，并重新计算自动重试次数 */
    retryNow() {
      if (!this.failed) return;
      resetRetry(this);
      if (this.onRetry) this.onRetry();
      this.retry();
    }

    /** 出错后又加载成功：清除错误；因缓冲播完而暂停的继续播放 */
    recovered() {
      if (!this.failed) return;
      this.failed = false;
      resetRetry(this);
      if (this.onRecover) this.onRecover();
      if (this.stalled) this.play().catch(() => {});
    }

    async play() {
      if (this.seeking) { this.resumeAfterSeek = true; return this.seekTask; }
      // 出错后用户点播放：立即重试
      if (this.failed) {
        if (this.retryMode === 'seek') {
          this.retryResume = true;
          this.retryNow();
          // 结果由 fail / recovered 处理
          if (this.seekTask) await this.seekTask.catch(() => {});
          return;
        }
        if (this.waitingRetry) {
          resetRetry(this);
          if (this.onRetry) this.onRetry();
        }
      }
      this.stalled = false;
      await this.context.resume();
      this.paused = false;
      this.onUpdate();
      this.pump();
    }

    pause() {
      this.stalled = false;
      if (this.seeking) { this.resumeAfterSeek = false; return; }
      if (this.paused) return;
      this.anchorTime = this.currentTime;
      this.anchorContextTime = this.context.currentTime;
      this.paused = true;
      this.context.suspend();
      this.onUpdate();
    }

    /** resume：重试时（retry）指定之后是否继续播放；用户 Seek 时不传，同时作为立即重试 */
    seek(time, resume) {
      if (!this.playlist) return;
      this.generation++;
      const gen = this.generation;
      if (resume === undefined && this.waitingRetry) {
        resetRetry(this);
        if (this.onRetry) this.onRetry();
      }
      this.resumeAfterSeek = resume !== undefined ? resume
        : !this.paused || this.stalled || (this.seeking && this.resumeAfterSeek);
      this.stalled = false;
      this.seeking = true;
      this.paused = true;
      this.stopNodes();
      this.anchorTime = Math.max(0, Math.min(time, this.duration));
      this.anchorContextTime = this.context.currentTime + 0.03;
      this.loadedUntil = this.anchorTime;
      const restart = this.locate(this.anchorTime);
      this.onUpdate();
      const task = (async () => {
        await this.context.suspend();
        while (this.busy && gen === this.generation) await new Promise((resolve) => setTimeout(resolve, 10));
        if (gen !== this.generation) return;
        await restart();
        if (gen !== this.generation) return;
        this.anchorContextTime = this.context.currentTime + 0.03;
        await this.pump(true);
        if (gen === this.generation && this.resumeAfterSeek) {
          await this.context.resume();
          this.paused = false;
          this.onUpdate();
          this.pump();
        }
      })().catch((error) => {
        if (gen === this.generation && error.name !== 'AbortError') this.fail(error, 'seek', this.resumeAfterSeek);
        throw error;
      })
        .finally(() => { if (gen === this.generation) { this.seeking = false; this.seekTask = null; } });
      this.seekTask = task;
      return task;
    }

    /** Seek 时停掉已排好的缓冲 */
    stopNodes() {
      for (const node of this.nodes) { try { node.stop(); } catch {} node.disconnect(); }
      this.nodes.clear();
    }

    /** Seek：从哪个分段开始解码（nextIndex），返回重置解码器的异步函数 */
    locate(time) {
      this.nextIndex = segmentAt(this.playlist.segments, time);
      return () => this.decoder.flush();
    }

    destroy() {
      this.generation++;
      clearInterval(this.timer);
      resetRetry(this);
      if (this.controller) this.controller.abort();
      if (this.decoder) this.decoder.destroy();
      for (const node of this.nodes) { try { node.stop(); } catch {} node.disconnect(); }
      this.nodes.clear();
      this.context.close();
    }
  }

  /**
   * JOC 对象渲染播放（E-AC-3 Dolby Atmos）：EC-3 解码、对象重建与渲染都在 Worker（joc-decode-worker.js）里完成，
   * 主线程只把渲染好的立体声排进 Web Audio。时钟、暂停与 Seek 的流程沿用 PcmEngine，区别在于：
   *   - 渲染器的输出是连续的（双耳内核在开头扣掉 961 个样本的延迟），缓冲按 cursor 首尾相接排列，不按分段时间；
   *   - 每个分段（约 15 秒）分批渲染，每批到了就排上，开始播放与 Seek 不必等整段解完；
   *   - Seek 从目标前 64 个 syncframe（约 2 秒）开始解码以重建渲染器状态，Worker 丢掉目标之前的输出；
   *   - 解码跟不上（缓冲来晚了）时整体顺延时钟，不让缓冲互相重叠；
   *   - 输入结束时取回渲染器留着的帧，只播到曲目时长为止（之后的房间尾音丢掉）；
   *   - Seek 与开始播放时短暂淡出 / 淡入，换渲染状态不出爆音；
   *   - 输出模式、HRTF 与衰减可以在播放中修改（reconfigure / setGain）。
   */
  class JocEngine extends PcmEngine {
    /** options: { mode: 'speaker' | 'binaural', gainDb, dataset, onClip(peak) } */
    constructor(onUpdate, onError, onEnded, options) {
      super(onUpdate, onError, onEnded);
      this.mode = options.mode === 'binaural' ? 'binaural' : 'speaker';
      this.gainDb = Number(options.gainDb) || 0;
      this.dataset = options.dataset;
      this.controls = options.controls || null;
      this.onClip = options.onClip || null;
      this.envelope = this.context.createGain();
      this.envelope.connect(this.mix);
      this.input = this.envelope;
      this.rate = 48000;
      this.channels = 2;
      /** 下一个缓冲的位置（曲目时间）；Seek 后第一个缓冲到来前为 null */
      this.cursor = null;
      this.finished = false;
      this.fadeIn = false;
      this.clipped = false;
    }

    async load(url) {
      const gen = this.generation;
      await this.started;
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      this.controller = new AbortController();
      this.playlist = await global.AmDecrypt.openTrack(url, this.controller.signal);
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      this.duration = this.playlist.duration;
      this.decoder = new JocDecoder();
      await this.openDecoder();
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      this.nextIndex = 0;
      this.fadeIn = true;
      await this.pump(true);
    }

    /** 打开（或换模式后重新打开）Worker 里的渲染器 */
    openDecoder() {
      return this.decoder.open({ mode: this.mode, gainDb: this.gainDb, dataset: this.dataset, controls: this.controls });
    }

    setGain(gainDb) {
      this.gainDb = Number(gainDb) || 0;
      if (this.decoder) this.decoder.setGain(this.gainDb).catch(() => {});
    }

    /**
     * 双耳的交互控制（声场界面，见 joc-scene.mjs）：{ yaw, pitch, roll, x, y, z, focus, height, gains }。
     * 这里的缓冲提前约 20 秒渲染，要等排好的音频放完才听得到；JocLiveEngine 低延迟时立刻听到
     */
    setControls(controls) {
      this.controls = controls;
      if (this.decoder) this.decoder.post('controls', { controls });
    }

    /** 对象场景只有低延迟模式提供 */
    sceneAt() { return null; }
    watchScene() {}

    /** 播放中换输出模式或 HRTF：Worker 重新打开渲染器，从当前位置 Seek（预滚按新的状态重建） */
    reconfigure({ mode, dataset }) {
      this.mode = mode === 'binaural' ? 'binaural' : 'speaker';
      this.dataset = dataset;
      if (!this.playlist || !this.decoder) return Promise.resolve();
      this.reopen = true;
      return this.seek(this.currentTime);
    }

    stopNodes() {
      // 先在 8 ms 内把淡入淡出级降到 0 再停，旧缓冲不会被截断出爆音；新缓冲开始时淡入（见 schedule）
      const now = this.context.currentTime;
      const gain = this.envelope.gain;
      try {
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(gain.value, now);
        gain.linearRampToValueAtTime(0, now + 0.008);
      } catch {}
      for (const node of this.nodes) {
        try { node.stop(now + 0.012); } catch { try { node.stop(); } catch {} }
      }
      this.nodes.clear();
      this.fadeIn = true;
    }

    locate(time) {
      this.cursor = null;
      this.finished = false;
      // 与参考实现的流式 API 相同：从目标前 64 个 syncframe 开始解码，重建 QMF、对象矩阵与双耳的状态；
      // 所在分段里更早的部分由 Worker 直接跳过（不解码）
      const preroll = (64 * 1536) / this.rate;
      this.nextIndex = segmentAt(this.playlist.segments, Math.max(0, time - preroll));
      const segment = this.playlist.segments[this.nextIndex];
      const skip = Math.max(0, Math.round((time - (segment ? segment.time : time)) * this.rate));
      // 进行中的分段在下一批之前停下，下面等 busy 结束时不必等它解完
      this.decoder.abort();
      return async () => {
        if (this.reopen) {
          await this.openDecoder();
          this.reopen = false;
        }
        await this.decoder.reset(skip);
      };
    }

    /** 把一段交错的立体声排在曲目时间 start 处，返回它的时长（秒） */
    schedule(frames, samples, start) {
      const buffer = this.context.createBuffer(2, samples, this.rate);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (let i = 0; i < samples; i++) {
        left[i] = frames[i * 2];
        right[i] = frames[i * 2 + 1];
      }
      const node = this.context.createBufferSource();
      node.buffer = buffer;
      node.connect(this.input);
      node.onended = () => { this.nodes.delete(node); node.disconnect(); };
      this.nodes.add(node);
      let when = this.anchorContextTime + start - this.anchorTime;
      // 来晚了（解码跟不上或分段加载慢）：时钟整体顺延，进度停在这里等音频，而不是让后面的缓冲叠在一起
      const earliest = this.context.currentTime + 0.02;
      if (when < earliest) {
        this.anchorContextTime += earliest - when;
        when = earliest;
      }
      if (this.fadeIn) {
        this.fadeIn = false;
        const gain = this.envelope.gain;
        gain.cancelScheduledValues(when);
        gain.setValueAtTime(0, when);
        gain.linearRampToValueAtTime(1, when + 0.02);
      }
      node.start(when);
      return samples / this.rate;
    }

    /** 削波提示：渲染输出乘上播放器音量后才是送到设备的电平，超过满刻度时每首提示一次 */
    checkClip(peak) {
      if (this.clipped || !this.onClip || !(peak * this.gain.gain.value > 1)) return;
      this.clipped = true;
      this.onClip(peak);
    }

    /**
     * 加载并渲染之后的分段，保持当前位置之后约 20 秒（Apple Music 的分段约 15 秒）。每段分批渲染，每批到了就排进 Web Audio。
     * first（开始播放与 Seek）：排上第一批音频就返回，这一段的其余部分与之后的分段在后台继续；
     * 预滚可能整段落在目标之前（没有输出），这时接着解下一段，排上音频才算完成，否则恢复播放后时钟会跑在音频前面
     */
    pump(first = false) {
      if (this.busy || this.waitingRetry || !this.playlist || !this.decoder) return Promise.resolve();
      this.busy = true;
      const gen = this.generation;
      let ready = null;
      let decoding = false;
      const started = first ? new Promise((resolve, reject) => { ready = { resolve, reject }; }) : null;
      const settle = () => { if (ready) { ready.resolve(); ready = null; } };
      const run = (async () => {
        const { segments } = this.playlist;
        while (this.nextIndex < segments.length && (first || segments[this.nextIndex].time < this.currentTime + 20)) {
          const seg = segments[this.nextIndex];
          decoding = false;
          const encrypted = await this.playlist.load(seg, this.controller.signal);
          if (gen !== this.generation) return;
          decoding = true;
          const decoded = await this.decoder.decode(encrypted, (part) => {
            if (gen !== this.generation || !part.samples) return;
            // Seek 后第一批从目标开始（之前的预滚已在 Worker 里丢掉），之后首尾相接
            const start = this.cursor !== null ? this.cursor : Math.max(seg.time, this.anchorTime);
            this.cursor = start + this.schedule(part.frames, part.samples, start);
            this.loadedUntil = Math.max(this.loadedUntil, this.cursor);
            this.checkClip(part.peak);
            settle();
          });
          if (gen !== this.generation || decoded.aborted) return;
          this.nextIndex++;
          if (this.cursor !== null) first = false;
          this.recovered();
          this.onUpdate();
        }
        if (this.nextIndex >= segments.length && !this.finished) {
          this.finished = true;
          const tail = await this.decoder.finish();
          if (gen !== this.generation) return;
          // 双耳内核留着的最后 961 个样本属于曲目；之后的房间尾音超出时长，播放在时长处结束
          const start = this.cursor !== null ? this.cursor : this.anchorTime;
          const frames = Math.min(tail.samples, Math.round(Math.max(0, (this.duration || 0) - start) * this.rate));
          if (frames > 0) {
            this.cursor = start + this.schedule(tail.frames, frames, start);
            this.loadedUntil = Math.max(this.loadedUntil, this.cursor);
          }
        }
      })().catch((error) => {
        // 第一批之前出错交给调用方（换下一种播放方式或报错），之后的错误在这里报告
        if (ready && gen === this.generation) { ready.reject(error); ready = null; return; }
        if (error.name !== 'AbortError' && gen === this.generation) this.failLoading(error, decoding);
      }).finally(() => {
        this.busy = false;
        settle();
      });
      return started || run;
    }
  }

  /**
   * JOC 的低延迟播放：双耳的交互控制（转头、走动、独奏 / 静音、聚焦、高度，见 joc-scene.mjs）要立刻听到，
   * 不能像 JocEngine 那样提前约 20 秒渲染排好。Worker 只把分段拆成 syncframe 排队，按 AudioWorklet
   * （joc-output-worklet.js）报回的播放进度逐帧渲染，提前约 0.1 秒；音频经 MessagePort 直接从 Worker 送到 AudioWorklet。
   *   - 时钟仍按上下文时间：一轮（打开或 Seek）的第一批音频渲染好（primed）后，告诉 AudioWorklet 从 anchorContextTime 开始；
   *     断粮时 AudioWorklet 报回缺的帧数，时钟整体顺延；
   *   - 输入结束时 Worker 送出渲染器留着的帧，播放在时长处结束（PcmEngine 的计时器）；
   *   - 对象场景（每个 syncframe 的位置与电平）按曲目时间排队，声场界面按当前时间取（sceneAt）。
   * 没有 AudioWorklet（非安全上下文）或上下文不是 48 kHz 时退回 JocEngine 的做法，控制项要等已排好的音频放完才生效
   */
  class JocLiveEngine extends JocEngine {
    constructor(onUpdate, onError, onEnded, options) {
      super(onUpdate, onError, onEnded, options);
      this.node = null;
      this.liveTried = false;
      /** 当前一轮的 epoch（Worker 的 primed 带来），旧轮的场景按它丢掉 */
      this.epoch = -1;
      this.primedWaiter = null;
      /** 曲目时间 → 对象场景：[{ time, data }]，data 见 joc-decode-worker.js 的 SCENE_FLOATS */
      this.scenes = [];
      this.sceneBase = 0;
      this.sceneWanted = false;
    }

    /**
     * 交互控制要过输出端的缓冲才听得到：Android Chrome 上 'playback' 的 outputLatency 约 0.35 秒，
     * 且每次成块拉走音频，Worker 跟不上而断粮、提前量一路加大；'interactive' 约 0.04 秒，不断粮
     */
    get latencyHint() { return 'interactive'; }

    /** 是否走低延迟（AudioWorklet）；load 之后才确定 */
    get live() { return Boolean(this.node); }

    async openDecoder() {
      const options = { mode: this.mode, gainDb: this.gainDb, dataset: this.dataset, controls: this.controls };
      const transfer = [];
      if (!this.liveTried) {
        this.liveTried = true;
        const port = await this.attachOutput();
        if (port) { options.port = port; transfer.push(port); }
        this.decoder.onEvent = (data) => this.event(data);
      } else {
        options.live = this.live;
      }
      const result = await this.decoder.open(options, transfer);
      if (this.sceneWanted) this.decoder.post('scene', { on: true });
      return result;
    }

    /** 创建 AudioWorklet 输出端，返回交给 Worker 的 MessagePort；不可用时返回 null（退回 JocEngine 的做法） */
    async attachOutput() {
      const context = this.context;
      if (!context.audioWorklet || typeof global.AudioWorkletNode !== 'function' || context.sampleRate !== this.rate) return null;
      try {
        await context.audioWorklet.addModule('/assets/joc-output-worklet.js');
        const node = new global.AudioWorkletNode(context, 'joc-output', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        node.connect(this.input);
        // 断粮：输出的是静音，时钟整体顺延，进度停在这里等音频
        node.port.onmessage = ({ data }) => { if (data.stall && !this.paused) this.anchorContextTime += data.stall / this.rate; };
        const channel = new MessageChannel();
        node.port.postMessage({ port: channel.port1 }, [channel.port1]);
        this.node = node;
        return channel.port2;
      } catch {
        return null;
      }
    }

    event(data) {
      const waiter = this.primedWaiter;
      if (data.event === 'primed') {
        this.primedWaiter = null;
        if (waiter) waiter.primed(data.epoch);
      } else if (data.event === 'error' && waiter) {
        // 第一批之前出错：交给等着的 load / Seek（换下一种播放方式或报错）
        this.primedWaiter = null;
        waiter.fail(new Error(data.error));
      } else if (data.event === 'scene') {
        if (data.epoch !== this.epoch) return;
        /** Worker 比播放位置提前渲染的帧数（声场界面显示延迟） */
        this.lead = data.lead;
        this.scenes.push({ time: this.sceneBase + data.at / this.rate, data: data.data });
        if (this.scenes.length > 256) this.scenes.splice(0, this.scenes.length - 256);
      } else if (data.event === 'peak') {
        this.checkClip(data.peak);
      } else if (data.event === 'error' && !this.waitingRetry) {
        this.failLoading(new Error(data.error), true);
      }
    }

    /** 第一批音频已渲染好：AudioWorklet 从 anchorContextTime（对应 anchorTime）开始播放，并淡入 */
    start(epoch) {
      this.epoch = epoch;
      // 暂停（加载、Seek）期间上下文时间可能已走过原定的起点
      if (this.paused) this.anchorContextTime = Math.max(this.anchorContextTime, this.context.currentTime + 0.02);
      const when = this.anchorContextTime;
      this.node.port.postMessage({ start: when, epoch });
      this.sceneBase = this.anchorTime;
      this.scenes = [];
      if (this.fadeIn) {
        this.fadeIn = false;
        const gain = this.envelope.gain;
        gain.cancelScheduledValues(when);
        gain.setValueAtTime(0, when);
        gain.linearRampToValueAtTime(1, when + 0.02);
      }
    }

    stopNodes() {
      if (!this.node) { super.stopNodes(); return; }
      // AudioWorklet 里排着的旧音频由 Worker 的 reset（flush）清掉；这里先在 8 ms 内淡出
      const now = this.context.currentTime;
      const gain = this.envelope.gain;
      try {
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(gain.value, now);
        gain.linearRampToValueAtTime(0, now + 0.008);
      } catch {}
      this.fadeIn = true;
      this.scenes = [];
    }

    /** 声场界面打开时才要每帧的场景 */
    watchScene(on) {
      this.sceneWanted = Boolean(on);
      if (!on) this.scenes = [];
      if (this.decoder) this.decoder.post('scene', { on: this.sceneWanted });
    }

    /** 当前播放位置的对象场景（Float32Array，见 SCENE_FLOATS）；更早的出队 */
    sceneAt(time = this.currentTime) {
      let index = -1;
      while (index + 1 < this.scenes.length && this.scenes[index + 1].time <= time) index++;
      if (index < 0) return null;
      if (index > 0) this.scenes.splice(0, index);
      return this.scenes[0].data;
    }

    /**
     * 加载之后的分段（当前位置之后约 20 秒），解密后交给 Worker 排队（不等渲染）。
     * first（开始播放与 Seek）：等这一轮的第一批音频渲染好（primed）再返回，期间接着排后面的分段——
     * 预滚可能整段落在目标之前，没有后面的分段就等不到音频
     */
    pump(first = false) {
      if (!this.node) return super.pump(first);
      if (this.busy || this.waitingRetry || !this.playlist || !this.decoder) return Promise.resolve();
      this.busy = true;
      const gen = this.generation;
      let ready = null;
      let decoding = false;
      const started = first ? new Promise((resolve, reject) => { ready = { resolve, reject }; }) : null;
      if (first) {
        // 上一轮还没等到就又 Seek 了：让它结束（它的 Seek 已过时）
        if (this.primedWaiter) this.primedWaiter.primed(null);
        this.primedWaiter = {
          primed: (epoch) => {
            if (epoch !== null && gen === this.generation) this.start(epoch);
            if (ready) { ready.resolve(); ready = null; }
          },
          fail: (error) => { if (ready) { ready.reject(error); ready = null; } },
        };
      }
      const run = (async () => {
        const { segments } = this.playlist;
        while (this.nextIndex < segments.length && segments[this.nextIndex].time < this.currentTime + 20) {
          const seg = segments[this.nextIndex];
          decoding = false;
          const encrypted = await this.playlist.load(seg, this.controller.signal);
          if (gen !== this.generation) return;
          decoding = true;
          await this.decoder.decode(encrypted);
          if (gen !== this.generation) return;
          this.nextIndex++;
          const next = segments[this.nextIndex];
          this.loadedUntil = Math.max(this.loadedUntil, next ? next.time : this.duration || 0);
          this.recovered();
          this.onUpdate();
        }
        if (this.nextIndex >= segments.length && !this.finished) {
          this.finished = true;
          await this.decoder.finish();
        }
      })().catch((error) => {
        // 第一批之前出错交给调用方（换下一种播放方式或报错），之后的错误在这里报告
        if (ready && gen === this.generation) { ready.reject(error); ready = null; return; }
        if (error.name !== 'AbortError' && gen === this.generation) this.failLoading(error, decoding);
      }).finally(() => {
        this.busy = false;
        // 换了一轮（Seek）：旧的等待不会再有 primed
        if (ready && gen !== this.generation) { ready.resolve(); ready = null; }
      });
      return started || run;
    }

    destroy() {
      if (this.node) {
        this.node.port.postMessage({ close: true });
        this.node.disconnect();
      }
      super.destroy();
    }
  }

  /**
   * MSE 播放。与 music.apple.com（MusicKit）相同，整个队列共用一个 MediaSource / SourceBuffer：
   * 当前曲目的分段全部追加后，把下一首（setNext）的 init 与分段以 timestampOffset 接在它的缓冲末尾，
   * <audio> 不换 src、不暂停、不触发 ended，播放位置越过接缝时 onTrackChange 通知播放器换曲目信息。
   * 这样 Android 后台切歌时媒体会话一直处于播放状态，通知栏的媒体卡片不会消失，也不需要在后台重新 play()。
   * 引擎自身的 playlist / transcoder / base 等字段即当前曲目；next 为已接上或待接上的下一首，字段相同。
   */
  class MseEngine {
    constructor(audio) {
      this.audio = audio;
      this.generation = 0;
      this.base = 0;
      this.quotaWaitUntil = 0;
      this.flacByteRate = 0;
      this.next = null;
      this.nextSerial = 0;
      this.trackSerial = 0;
      this.stallLastTime = null;
      this.failures = 0;
      this.retryAt = null;
      this.gaveUp = false;
    }

    /** m3u8Url：Apple CDN 上的原始 media m3u8 */
    async load(m3u8Url, codecs, onError, transcode = false) {
      const gen = ++this.generation;
      this.destroy(false);
      this.onError = onError;
      this.controller = new AbortController();
      const playlist = await global.AmDecrypt.openTrack(m3u8Url, this.controller.signal);
      if (gen !== this.generation) return;
      this.playlist = playlist;
      this.base = 0;
      this.trackId = ++this.trackSerial;
      this.mime = mimeFor(transcode ? 'flac' : codecs);
      if (transcode) this.transcoder = new FlacTranscoder();

      const MS = global.ManagedMediaSource || global.MediaSource;
      const ms = new MS();
      this.ms = ms;
      this.objectUrl = URL.createObjectURL(ms);
      if (global.ManagedMediaSource && MS === global.ManagedMediaSource) this.audio.disableRemotePlayback = true;
      this.audio.src = this.objectUrl;
      await new Promise((resolve) => ms.addEventListener('sourceopen', resolve, { once: true }));
      if (gen !== this.generation) return;

      ms.duration = playlist.duration;
      this.sb = ms.addSourceBuffer(this.mime);
      this.sbMime = this.mime;
      this.initBuf = await this.fetchRange(playlist.init, gen);
      await this.append(this.initBuf, gen);
      this.initId = this.trackId;

      // 只记录成功追加的分段；时间戳与 EXTINF 有偏差时避免反复拉取。
      this.appendedSegments = new Set();
      this.pendingSegments = new Map();
      this.segmentController = new AbortController();
      this.seekSerial = 0;
      this.pumpSerial = 0;
      this.onTick = () => { this.checkBoundary(); this.pump(gen); };
      this.onSeeking = () => {
        this.checkBoundary();
        this.interrupt(gen);
      };
      this.onWaiting = () => this.watchStall(gen);
      this.audio.addEventListener('timeupdate', this.onTick);
      this.audio.addEventListener('seeking', this.onSeeking);
      this.audio.addEventListener('waiting', this.onWaiting);
      this.audio.addEventListener('stalled', this.onWaiting);
      this.pump(gen);
    }

    /** 中止进行中的分段请求并从播放位置重新缓冲（拖动进度、放弃已接上的下一首时） */
    interrupt(gen) {
      if (!this.sb) return;
      this.quotaWaitUntil = 0;
      this.stallLastTime = null;
      this.seekSerial++;
      const seekSerial = this.seekSerial;
      this.pumpSerial++;
      this.segmentController.abort();
      this.segmentController = new AbortController();
      this.appendedSegments.clear();
      this.pendingSegments.clear();
      if (this.next) {
        this.next.appendedSegments.clear();
        this.next.pendingSegments.clear();
      }
      if (this.sb.updating) {
        this.sb.addEventListener('updateend', () => {
          if (gen !== this.generation || seekSerial !== this.seekSerial) return;
          this.busy = false;
          this.pump(gen);
        }, { once: true });
      } else {
        this.busy = false;
        this.pump(gen);
      }
    }

    /** 播放位置之后连续缓冲的秒数 */
    bufferedAhead() {
      const now = this.audio.currentTime;
      const b = this.sb.buffered;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= now + 0.1 && b.end(i) > now) return b.end(i) - now;
      }
      return 0;
    }

    /**
     * 播放因缓冲耗尽停住后 timeupdate 不再触发，pump 也就不再被调用。此时若 pump 在等配额（quotaWaitUntil
     * 要等播放前进），或已记为追加的分段被浏览器按配额淘汰（FLAC 码率高，appendedSegments 仍认为已就绪），
     * 会一直卡住，直到拖动进度触发 interrupt。这里检测到卡住时自动恢复，停住期间每秒复查一次。
     */
    watchStall(gen) {
      clearTimeout(this.stallTimer);
      const a = this.audio;
      if (gen !== this.generation || !this.sb || a.paused || a.seeking || a.ended) {
        this.stallLastTime = null;
        return;
      }
      const now = a.currentTime;
      // readyState may remain HAVE_FUTURE_DATA after an MSE gap. Actual clock
      // movement is more reliable than that value for deciding if playback is stuck.
      if (this.stallLastTime === null) this.stallLastTime = now;
      if (now > this.stallLastTime + 0.25) {
        this.stallLastTime = null;
        return;
      }
      this.stallTimer = setTimeout(() => this.watchStall(gen), 1000);
      if (this.busy) return; // 正在取数据，取完 pump 会自行继续
      this.quotaWaitUntil = 0;
      // 当前曲目结尾处（等下一首）不算卡住
      const atEnd = a.currentTime >= this.base + this.playlist.duration - 0.5;
      // 播放位置没有缓冲：已记为追加的数据被浏览器按配额淘汰，记录不可信，从播放位置重新缓冲。
      // 不能先看 target()：窗口后面还有分段待追加时只会继续往前追加，空洞永远补不上
      if (!atEnd && this.bufferedAhead() < 0.3) { this.interrupt(gen); return; }
      const target = this.target();
      if (target && !target.tail) { this.pump(gen); return; }
      // 认为都已就绪却没有缓冲：同上，从播放位置重新缓冲
      if (!atEnd) this.interrupt(gen);
    }

    /**
     * 设置队列中的下一首（item 带 m3u8Url、codecs、mode，见 resolveEntry），null 表示没有。
     * 只打开 media m3u8；当前曲目缓冲到结尾后，下一首的分段在 pump 里按缓冲窗口追加。
     * 编码不同时需要 SourceBuffer.changeType，不支持时不接续（播完后由播放器按原方式切歌）。
     */
    async setNext(item) {
      const serial = ++this.nextSerial;
      const gen = this.generation;
      this.dropNext();
      if (!item || !this.sb || (item.mode !== 'mse' && item.mode !== 'flac')) return false;
      const transcode = item.mode === 'flac';
      const mime = mimeFor(transcode ? 'flac' : item.codecs);
      if (mime !== this.mime && typeof this.sb.changeType !== 'function') return false;
      const playlist = await global.AmDecrypt.openTrack(item.m3u8Url, this.controller.signal);
      if (gen !== this.generation || serial !== this.nextSerial) return false;
      this.next = {
        item, playlist, mime,
        trackId: ++this.trackSerial,
        transcoder: transcode ? new FlacTranscoder() : null,
        base: null,
        initBuf: null,
        appendedSegments: new Set(),
        pendingSegments: new Map(),
      };
      this.pump(gen);
      return true;
    }

    /** 放弃下一首；已接上的部分从缓冲中移除，并让媒体重新在当前曲目末尾结束 */
    dropNext() {
      const next = this.next;
      if (!next) return;
      this.next = null;
      if (next.transcoder) next.transcoder.destroy();
      if (next.base === null) return;
      this.discardFrom = next.base;
      if (this.initId === next.trackId) this.initId = null;
      this.interrupt(this.generation);
    }

    /** 播放位置越过接缝时切到下一首 */
    checkBoundary() {
      const next = this.next;
      if (!next || next.base === null || this.audio.currentTime < next.base - 0.05) return;
      this.promote();
    }

    promote() {
      const next = this.next;
      this.next = null;
      const old = this.transcoder;
      Object.assign(this, {
        playlist: next.playlist,
        mime: next.mime,
        trackId: next.trackId,
        transcoder: next.transcoder,
        base: next.base,
        initBuf: next.initBuf,
        appendedSegments: next.appendedSegments,
        pendingSegments: next.pendingSegments,
      });
      if (old) old.destroy();
      if (this.onTrackChange) this.onTrackChange(next.item);
    }

    /** 手动下一首：下一首已接上时直接跳到接缝处，不重新加载 */
    skipToNext() {
      const next = this.next;
      if (!next || next.base === null) return false;
      this.audio.currentTime = next.base;
      this.promote();
      return true;
    }

    /** 获取并解密一个分段；track 为当前曲目（this）或下一首 */
    async fetchRange(range, gen, signal = this.controller.signal, track = this) {
      let buf = await track.playlist.load(range, signal);
      signal.throwIfAborted();
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      if (track.transcoder) buf = await track.transcoder.run(range.init ? 'open' : 'transcode', buf);
      signal.throwIfAborted();
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      return buf;
    }

    append(buf, gen) {
      return new Promise((resolve, reject) => {
        if (gen !== this.generation || !this.sb) return reject(new DOMException('stale', 'AbortError'));
        const done = () => { this.sb.removeEventListener('error', fail); resolve(); };
        const fail = () => { this.sb.removeEventListener('updateend', done); reject(new Error(t('player.errorAppend'))); };
        this.sb.addEventListener('updateend', done, { once: true });
        this.sb.addEventListener('error', fail, { once: true });
        try {
          this.sb.appendBuffer(buf); // readyState 为 ended 时追加会自动重新打开
        } catch (err) {
          this.sb.removeEventListener('updateend', done);
          this.sb.removeEventListener('error', fail);
          reject(err);
        }
      });
    }

    remove(start, end, gen) {
      return new Promise((resolve) => {
        this.sb.addEventListener('updateend', resolve, { once: true });
        this.sb.remove(start, end);
      }).then(() => { if (gen !== this.generation) throw new DOMException('stale', 'AbortError'); });
    }

    isBuffered(seg, base = this.base) {
      const b = this.sb.buffered;
      const from = base + seg.time + 0.25;
      const to = base + seg.time + Math.max(seg.duration - 0.25, 0.3);
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= from && b.end(i) >= to) return true;
      }
      return false;
    }

    /** 当前曲目缓冲的实际结尾（下一首从这里接上，无缝且不重叠）；取不到时按 EXTINF 计算 */
    bufferedEnd() {
      const { segments, duration } = this.playlist;
      const last = this.base + segments[segments.length - 1].time;
      const b = this.sb.buffered;
      for (let i = b.length - 1; i >= 0; i--) {
        if (b.start(i) <= last + 0.25 && b.end(i) > last) return b.end(i);
      }
      return this.base + duration;
    }

    /** 移除播放位置之前的缓冲；只有 slack 秒以内的已播数据时不单独发起 remove */
    async evict(gen, slack = 0) {
      const cut = this.audio.currentTime - (this.transcoder ? FLAC_BEHIND_SECONDS : BEHIND_SECONDS);
      if (cut <= 1 || this.sb.updating) return;
      const b = this.sb.buffered;
      if (!b.length || b.start(0) >= cut - slack) return;
      await this.remove(0, cut, gen);
    }

    /** FLAC 缓冲窗口（秒）：按实测码率让已播部分、窗口与窗口末尾的整段合计不超过 FLAC_BUFFER_BYTES */
    flacAhead(segment) {
      if (!this.flacByteRate) return FLAC_AHEAD_SECONDS;
      const seconds = FLAC_BUFFER_BYTES / this.flacByteRate - FLAC_BEHIND_SECONDS - 1 - (segment ? segment.duration : 0);
      return Math.min(FLAC_AHEAD_SECONDS, Math.max(FLAC_MIN_AHEAD_SECONDS, seconds));
    }

    ready(i, track = this) {
      // A nearly complete buffered range can still have queued FLAC fragments.
      // Finish those before starting the next segment: backfilling them later
      // changes MSE's append position and lets quota eviction remove future audio.
      if (track.pendingSegments.has(i)) return false;
      return this.isBuffered(track.playlist.segments[i], track.base) || track.appendedSegments.has(i);
    }

    /** 下一个要追加的分段：先当前曲目，结尾之后是下一首；都在缓冲窗口内已就绪时返回 null */
    target() {
      const now = this.audio.currentTime;
      const flacQueue = this.transcoder || (this.next && this.next.transcoder);
      const { segments } = this.playlist;
      const startIndex = segmentAt(segments, now - this.base);
      const ahead = flacQueue ? this.flacAhead(segments[startIndex]) : AHEAD_SECONDS;
      for (let i = startIndex; i < segments.length; i++) {
        if (this.base + segments[i].time > now + ahead) return null;
        if (!this.ready(i)) return { track: this, index: i };
      }
      const next = this.next;
      if (!next) return { tail: true, startIndex };
      const base = next.base === null ? this.base + this.playlist.duration : next.base;
      if (base > now + ahead) return { tail: true, startIndex };
      if (next.base === null) return { track: next, index: 0 };
      const nextSegments = next.playlist.segments;
      for (let i = 0; i < nextSegments.length; i++) {
        if (base + nextSegments[i].time > now + ahead) return null;
        if (!this.ready(i, next)) return { track: next, index: i };
      }
      return null;
    }

    /** 让 SourceBuffer 解析 track 的分段：必要时切换编码、重新追加 init，并设置时间偏移 */
    async useTrack(track, gen) {
      if (this.initId === track.trackId) return;
      // 下一首的 base 在 init 追加成功后才确定：此前播放到接缝不会切换曲目（见 checkBoundary）
      const base = track.base === null ? this.bufferedEnd() : track.base;
      if (!track.initBuf) track.initBuf = await this.fetchRange(track.playlist.init, gen, this.segmentController.signal, track);
      if (track.mime !== this.sbMime) {
        this.sb.changeType(track.mime);
        this.sbMime = track.mime;
      }
      this.sb.timestampOffset = base;
      await this.append(track.initBuf, gen);
      track.base = base;
      this.initId = track.trackId;
      // 允许在下一首里拖动到尚未缓冲的位置
      const end = base + track.playlist.duration;
      if (this.ms.readyState === 'open' && !this.sb.updating && !(this.ms.duration >= end)) {
        try { this.ms.duration = end; } catch {}
      }
    }

    async pump(gen) {
      if (this.busy || gen !== this.generation || !this.sb) return;
      // 失败后等待重试或已停止重试：timeupdate 等触发的 pump 不能绕过退避
      if (this.retryAt || this.gaveUp) return;
      // 配额已满：等播放前进、已播部分可以淘汰后再试，不在每次 timeupdate 重复追加
      if (this.audio.currentTime < this.quotaWaitUntil) return;
      if (this.discardFrom !== undefined && this.discardFrom !== null) {
        const from = this.discardFrom;
        this.busy = true;
        try {
          if (this.sb.updating) await new Promise((resolve) => this.sb.addEventListener('updateend', resolve, { once: true }));
          await this.remove(from, Infinity, gen);
          if (this.ms.readyState === 'open' && !this.sb.updating) this.ms.duration = from;
        } catch {}
        if (this.discardFrom === from) this.discardFrom = null;
        this.busy = false;
        if (gen !== this.generation) return;
      }
      const next = this.target();
      if (!next) return;
      if (next.tail) {
        // After seeking, earlier segments may never have been loaded. Signal
        // EOF once the remaining audio is appended so the decoder can flush
        // its final samples. A later seek/append reopens the MediaSource.
        // 有下一首（已打开或还在准备）时不结束：数据暂时没到（如断网）时停在接缝处等待，
        // 媒体保持播放状态而不是 ended，网络恢复后自动接上，与 MusicKit 相同。
        const { segments } = this.playlist;
        const tailDone = segments.every((_, i) => i < next.startIndex || this.ready(i));
        if (tailDone && !this.next && !this.expectNext && this.ms.readyState === 'open' && !this.sb.updating) {
          try { this.ms.endOfStream(); } catch {}
        }
        return;
      }

      const { track, index: target } = next;
      this.busy = true;
      const pumpSerial = ++this.pumpSerial;
      const seekSerial = this.seekSerial;
      const signal = this.segmentController.signal;
      // 下一首在请求期间成为当前曲目（promote）时数据仍然有效；被放弃时作废
      const stale = () => seekSerial !== this.seekSerial
        || (track.trackId !== this.trackId && !(this.next && this.next.trackId === track.trackId));
      let waitForPlayback = false;
      try {
        await this.useTrack(track, gen);
        if (stale()) throw new DOMException('stale seek', 'AbortError');
        const segments = track.playlist.segments;
        if (track.transcoder) {
          let queue = track.pendingSegments.get(target);
          if (!queue) {
            queue = await this.fetchRange(segments[target], gen, signal, track);
            if (stale()) throw new DOMException('stale seek', 'AbortError');
            track.pendingSegments.set(target, queue);
            // 取峰值：码率高的段落也不能让窗口超出配额
            const seconds = segments[target].duration;
            if (seconds > 0) {
              const rate = queue.reduce((sum, buf) => sum + buf.byteLength, 0) / seconds;
              this.flacByteRate = Math.max(this.flacByteRate, rate);
            }
          }
          while (queue.length) {
            if (stale()) throw new DOMException('stale seek', 'AbortError');
            // 先主动淘汰已播部分：等到 QuotaExceededError 时，浏览器已经从缓冲末尾删过未播的数据
            await this.evict(gen, 1);
            if (stale()) throw new DOMException('stale seek', 'AbortError');
            try {
              await this.append(queue[0], gen);
            } catch (err) {
              if (!err || err.name !== 'QuotaExceededError') throw err;
              await this.evict(gen);
              if (stale()) throw new DOMException('stale seek', 'AbortError');
              try {
                await this.append(queue[0], gen);
              } catch (retryError) {
                if (!retryError || retryError.name !== 'QuotaExceededError') throw retryError;
                waitForPlayback = true;
                this.quotaWaitUntil = this.audio.currentTime + 2;
                break;
              }
            }
            if (stale()) throw new DOMException('stale seek', 'AbortError');
            queue.shift();
          }
          if (!queue.length) {
            track.pendingSegments.delete(target);
            track.appendedSegments.add(target);
          }
        } else {
          const buf = await this.fetchRange(segments[target], gen, signal, track);
          if (stale()) throw new DOMException('stale seek', 'AbortError');
          try {
            await this.append(buf, gen);
          } catch (err) {
            if (err && err.name === 'QuotaExceededError') {
              await this.evict(gen);
              if (stale()) throw new DOMException('stale seek', 'AbortError');
              await this.append(buf, gen);
            } else {
              throw err;
            }
          }
          if (stale()) throw new DOMException('stale seek', 'AbortError');
          track.appendedSegments.add(target);
        }
        resetRetry(this);
        if (this.failed) {
          this.failed = false;
          if (this.onRecover) this.onRecover();
        }
      } catch (err) {
        if (pumpSerial === this.pumpSerial && (!err || err.name !== 'AbortError')) {
          this.busy = false;
          // 网络中断、wrapper-lite 暂不可用等错误：提示后自动重试（scheduleRetry），不让缓冲耗尽后一直卡住
          if (!this.failed && this.onError) this.onError(err);
          this.failed = true;
          scheduleRetry(this, () => this.pump(gen));
          if (this.onRetry) this.onRetry();
          return;
        }
      }
      if (pumpSerial === this.pumpSerial) {
        this.busy = false;
        if (!waitForPlayback && gen === this.generation) this.pump(gen);
      }
    }

    /** 失败后立即重试，并重新计算自动重试次数 */
    retryNow() {
      if (!this.failed) return;
      resetRetry(this);
      if (this.onRetry) this.onRetry();
      this.pump(this.generation);
    }

    destroy(bump = true) {
      if (bump) this.generation++;
      this.nextSerial++;
      clearTimeout(this.retryTimer);
      clearTimeout(this.stallTimer);
      if (this.controller) this.controller.abort();
      if (this.segmentController) this.segmentController.abort();
      if (this.transcoder) this.transcoder.destroy();
      if (this.next && this.next.transcoder) this.next.transcoder.destroy();
      if (this.onTick) {
        this.audio.removeEventListener('timeupdate', this.onTick);
        this.audio.removeEventListener('seeking', this.onSeeking);
        this.audio.removeEventListener('waiting', this.onWaiting);
        this.audio.removeEventListener('stalled', this.onWaiting);
      }
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.onTick = this.onSeeking = this.onWaiting = this.controller = this.segmentController = this.objectUrl = this.sb = this.ms = this.playlist = this.transcoder = this.pendingSegments = this.appendedSegments = null;
      this.next = this.initBuf = this.initId = this.discardFrom = null;
      this.base = 0;
      this.quotaWaitUntil = 0;
      this.flacByteRate = 0;
      this.stallLastTime = null;
      this.busy = false;
      this.failed = false;
      resetRetry(this);
    }
  }

  /**
   * <audio> 的播放控制，时间相对当前曲目：MSE 接续播放时整个队列在同一条时间线上，
   * 当前曲目从 base()（MseEngine.base）开始；其他方式 base 为 0。
   */
  class AudioClock {
    constructor(audio, base) {
      this.audio = audio;
      this.base = base;
    }

    get currentTime() { return Math.max(0, this.audio.currentTime - this.base()); }
    set currentTime(value) { this.audio.currentTime = this.base() + value; }
    get paused() { return this.audio.paused; }
    get readyState() { return this.audio.readyState; }
    play() { return this.audio.play(); }
    pause() { this.audio.pause(); }
  }

  /* ---------- 歌曲之间的过渡（AutoMix / 交叉淡化）：两首歌同时播放一段，按 automix.js 的规划调节各自的音量 ---------- */

  /** <audio> 播放的方式（MSE、ALAC → FLAC）；其余是 PCM 引擎（EC-3、JOC） */
  function isElementMode(mode) { return mode === 'mse' || mode === 'flac'; }

  /** 提前多久（秒，上一首的时间）开始准备下一首：打开 m3u8、取 key 与开头的分段，停在开始播放的位置 */
  const PREROLL_LEAD = 25;
  /** 等下一首准备好最多多久 */
  const PREROLL_TIMEOUT = 20000;
  /** 混音期间更新音量的间隔（毫秒）；离开始还远时同样用它检查，开销只是几次比较 */
  const MIX_TICK = 40;
  /** 手动下一首（下一首已准备好）时的快速交叉淡化（秒） */
  const SKIP_FADE = 1.2;
  /** 变速对齐后回到原速用的时间（毫秒） */
  const RATE_GLIDE = 4000;

  let volumeControllable = null;
  /** 能否单独调节 <audio> 的音量：iOS Safari 的 volume 只读（始终为 1），这时不做过渡，按无缝衔接播放 */
  function canControlVolume() {
    if (volumeControllable === null) {
      try {
        const probe = new global.Audio();
        probe.volume = 0.5;
        volumeControllable = Math.abs(probe.volume - 0.5) < 0.01;
      } catch {
        volumeControllable = false;
      }
    }
    return volumeControllable;
  }

  /**
   * 一首在播放（或已准备好）的曲目，与播放方式无关：<audio> 方式为 deck（{ audio, mse, clock }），PCM 方式为 engine。
   * 音量为播放器的基础音量（滑块与 ALAC / AAC 补偿，见 AmPlayer.baseGain）乘过渡的增益
   */
  class Voice {
    constructor(player, item, mode, { deck = null, engine = null }) {
      this.player = player;
      this.item = item;
      this.mode = mode;
      this.deck = deck;
      this.engine = engine;
      this.gain = 1;
      if (deck) deck.voice = this;
    }

    get time() { return this.deck ? Math.max(0, this.deck.audio.currentTime - this.deck.mse.base) : this.engine.currentTime; }
    get paused() { return this.deck ? this.deck.audio.paused : this.engine.paused; }
    get ended() { return this.deck ? this.deck.audio.ended : this.engine.duration > 0 && this.engine.currentTime >= this.engine.duration; }
    get duration() { return this.deck ? (this.deck.mse.playlist ? this.deck.mse.playlist.duration : 0) : this.engine.duration || 0; }
    get rate() { return this.deck ? this.deck.audio.playbackRate : 1; }

    /** 能开始播放：<audio> 缓冲到了开始位置之后，PCM 已解码好开头（preroll 完成即是） */
    get ready() { return this.deck ? this.deck.audio.readyState >= 3 && !this.deck.audio.seeking : true; }

    /** 过渡的增益 0–1 */
    setGain(gain) {
      this.gain = gain;
      const value = this.player.baseGain(this.item, this.mode) * gain;
      if (this.deck) this.deck.audio.volume = Math.min(1, Math.max(0, value));
      else {
        const param = this.engine.gain.gain;
        param.cancelScheduledValues(this.engine.context.currentTime);
        param.setTargetAtTime(value, this.engine.context.currentTime, 0.012);
      }
    }

    /** 播放速度（只有 <audio> 能变速并保持音高） */
    setRate(rate) {
      if (!this.deck) return;
      const audio = this.deck.audio;
      if ('preservesPitch' in audio) audio.preservesPitch = true;
      if (Math.abs(audio.playbackRate - rate) > 1e-4) audio.playbackRate = rate;
    }

    play() { return this.deck ? this.deck.audio.play() : this.engine.play(); }

    /** 停止并释放：<audio> 的 deck 交还播放器复用，PCM 引擎销毁 */
    release() {
      if (this.released) return;
      this.released = true;
      if (this.deck) this.player.releaseDeck(this.deck);
      else this.engine.destroy();
    }
  }

  /**
   * 执行 AutoMix / 交叉淡化（规划见 automix.js）。状态：
   *   entry    交给它处理的下一首（队列条目）；规划结果为不过渡时退回 MseEngine 的无缝衔接（AmPlayer.chainNext），entry 保留
   *   pending  已规划的过渡：{ entry, item, modes, mode, plan, inputs, voice, state }，state 为
   *            planned（等到开始前 PREROLL_LEAD 秒）→ loading（准备下一首）→ ready（停在开始位置）→ started
   *   tail     正在淡出的上一首：{ voice, incoming, plan, start（开始时上一首的时间）}；下一首在开始的同时成为当前曲目
   *   glide    变速对齐后慢慢回到原速：{ voice, from, at }
   * 开始时上一首从播放器上摘下（AmPlayer.detachVoice），下一首接上（adoptVoice）；用户暂停、拖动进度、换歌时上一首立即退出。
   */
  class Mixer {
    constructor(player) {
      this.player = player;
      this.entry = null;
      this.serial = 0;
      this.pending = null;
      this.tail = null;
      this.glide = null;
      this.timer = null;
      /** 最近一次过渡的规划（调试用，见 window.AmApp.player.mixer.last） */
      this.last = null;
      /** 调用 play() 到真正出声的延迟（秒），按播放方式分开，每次过渡实测后修正（见 updateTail）；watch 提前这么多开始 */
      this.latency = { element: 0.05, pcm: 0.05 };
    }

    /** 是否由它处理 entry（设置开启、浏览器支持，且不是同一张专辑按顺序的下一首） */
    wants(entry) {
      return !!entry && playbackSettings().transition !== 'off' && canControlVolume()
        && !!global.AmAutomix && !this.player.continuous(entry);
    }

    /** 混音中（上一首还在淡出） */
    get mixing() { return !!this.tail; }

    prepare(entry) {
      this.cancel();
      const player = this.player;
      // 当前曲目还在加载（时长未知）：加载完成后 start() 会再调用 prepareNext
      if (player.attempting || !(player.duration() > 0)) return;
      const serial = ++this.serial;
      this.entry = entry;
      const out = player.current;
      const settings = playbackSettings();
      const { fetchAnalysis } = global.AmAutomix;
      Promise.all([
        resolveEntry(entry),
        fetchAnalysis(out.track, out.country || 'us'),
        fetchAnalysis(entry.track, entry.country || 'us'),
      ])
        .then(([item, a, b]) => {
          if (serial !== this.serial) return;
          const modes = detectModes(item.codecs);
          if (!modes.length) { this.fallback(entry); return; }
          const inputs = {
            a, b,
            options: {
              mode: settings.transition,
              seconds: settings.crossfade,
              outDuration: player.duration(),
              inDuration: (entry.duration || 0) / 1000 || (b && b.length) || 0,
            },
          };
          const plan = this.replan(inputs, modes[0]);
          if (plan.kind === 'gapless') {
            console.info('[am-hook] AutoMix: 不过渡', plan.reason, entry.name);
            this.fallback(entry);
            return;
          }
          this.pending = { serial, entry, item, modes, mode: modes[0], plan, inputs, voice: null, state: 'planned' };
          this.run();
        })
        .catch((err) => {
          if (serial !== this.serial) return;
          // 网络错误稍后重试；其他错误（如不可播放）放弃过渡
          if (!(err instanceof TypeError)) { this.fallback(entry); return; }
          this.retryTimer = setTimeout(() => {
            if (serial !== this.serial) return;
            this.entry = null;
            player.prepareNext();
          }, 3000);
        });
    }

    replan(inputs, mode) {
      return global.AmAutomix.plan(inputs.a, inputs.b, { ...inputs.options, stretch: isElementMode(mode) });
    }

    /** 不过渡：交回 MseEngine 的无缝衔接（entry 保留，队列不变时不再规划） */
    fallback(entry) {
      this.pending = null;
      this.player.chainNext(entry);
    }

    /** 放弃还没开始的过渡（已开始的淡出照常完成） */
    cancel() {
      this.serial++;
      this.entry = null;
      clearTimeout(this.retryTimer);
      clearTimeout(this.beginTimer);
      const pending = this.pending;
      this.pending = null;
      if (pending && pending.voice) pending.voice.release();
    }

    /** 换歌、重新开始播放：一切过渡立即结束 */
    reset() {
      this.cancel();
      this.stopTail();
      if (this.glide) { this.glide.voice.setRate(1); this.glide = null; }
      this.stop();
    }

    run() {
      if (!this.timer) this.timer = setInterval(() => this.tick(), MIX_TICK);
    }

    stop() {
      clearInterval(this.timer);
      this.timer = null;
    }

    tick() {
      const pending = this.pending;
      if (pending && pending.state !== 'started') this.watch(pending);
      if (this.tail) this.updateTail();
      if (this.glide) this.updateGlide();
      if (!this.pending && !this.tail && !this.glide) this.stop();
    }

    /** 过渡开始前：到时间准备下一首，准备好后在 x0 开始 */
    watch(pending) {
      const transport = this.player.transport();
      const now = transport.currentTime;
      const { plan } = pending;
      if (pending.state === 'planned' && now >= plan.x0 - PREROLL_LEAD) this.preroll(pending);
      if (pending.state !== 'ready' || transport.paused) return;
      // 拖到了过渡之后：已经来不及按规划混音，快速淡过去
      if (now > plan.x0 + 0.5) { this.begin(pending, this.quickPlan(pending, SKIP_FADE)); return; }
      const wait = plan.x0 - now - this.latency[pending.voice && pending.voice.deck ? 'element' : 'pcm'];
      if (wait <= 0.005) { this.begin(pending, plan); return; }
      // 最后一段用 setTimeout 精确到毫秒（MIX_TICK 的粒度对拍子来说太粗）
      if (wait < (MIX_TICK * 2) / 1000 && !this.beginTimer) {
        this.beginTimer = setTimeout(() => {
          this.beginTimer = null;
          if (this.pending === pending && !this.player.transport().paused) this.begin(pending, plan);
        }, wait * 1000);
      }
    }

    /** 从现在起 seconds 秒的等功率交叉淡化（不超过上一首剩下的时长）；seconds 为 0 时直接切过去 */
    quickPlan(pending, seconds) {
      const now = this.player.transport().currentTime;
      const left = Math.max(0, this.player.duration() - now);
      const d = Math.min(seconds, left);
      return { ...pending.plan, kind: 'skip', x0: now, x1: now + d, rate: 1, beat: null, out: { from: 0, to: d }, in: { from: 0, to: Math.min(d, 0.4) } };
    }

    async preroll(pending) {
      pending.state = 'loading';
      const player = this.player;
      const at = pending.plan.entry;
      for (const mode of pending.modes) {
        let voice = null;
        try {
          voice = await player.prerollVoice(pending.item, mode, at);
          if (this.pending !== pending) { voice.release(); return; }
          pending.voice = voice;
          const deadline = Date.now() + PREROLL_TIMEOUT;
          while (!voice.ready) {
            if (Date.now() > deadline) throw new Error('preroll timeout');
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (this.pending !== pending) return; // cancel 已释放
          }
          // 实际用的播放方式与规划时不同（如 MSE 不支持而用 FLAC）：能否变速也可能不同，重新规划
          if (mode !== pending.mode) {
            pending.mode = mode;
            const plan = this.replan(pending.inputs, mode);
            if (plan.kind !== 'gapless') pending.plan = plan;
          }
          pending.state = 'ready';
          return;
        } catch (err) {
          if (this.pending !== pending) return;
          pending.voice = null;
          if (voice) voice.release();
          console.warn(`[am-hook] AutoMix: 下一首用 ${mode} 准备失败`, err);
        }
      }
      // 都准备不了：不过渡，播完后照常切歌（next(true)）
      if (this.pending === pending) this.pending = null;
    }

    /** 开始过渡：下一首开始播放并成为当前曲目，上一首按规划淡出 */
    async begin(pending, plan) {
      if (pending.state !== 'ready') return;
      pending.state = 'started';
      clearTimeout(this.beginTimer);
      this.beginTimer = null;
      const player = this.player;
      const voice = pending.voice;
      const d = plan.x1 - plan.x0;
      voice.setGain(d > 0 ? global.AmAutomix.fadeInGain(plan.in, 0) : 1);
      voice.setRate(plan.rate);
      const actual = player.transport().currentTime;
      try {
        await voice.play();
      } catch (err) {
        console.warn('[am-hook] AutoMix: 下一首无法开始播放', err);
        if (this.pending === pending) this.pending = null;
        voice.release();
        return;
      }
      if (this.pending !== pending) { voice.release(); return; }
      this.pending = null;
      const outgoing = player.detachVoice();
      // 按规划开始的（不是拖动或手动下一首）：时间轴以规划的 x0 为准，开始的误差由相位锁修正
      const start = plan.kind !== 'skip' && Math.abs(actual - plan.x0) < 0.3 ? plan.x0 : actual;
      this.last = { ...plan, start, actual, from: player.current && player.current.title, to: pending.item.title };
      console.info('[am-hook] AutoMix', this.last);
      // 上一首已经播完或这是一次直接切换：不需要淡出
      if (outgoing && (d <= 0 || outgoing.ended)) outgoing.release();
      else if (outgoing) {
        this.stopTail();
        this.tail = { voice: outgoing, incoming: voice, plan, start };
      }
      player.mixGain = d > 0 ? voice.gain : 1;
      player.adoptVoice(pending.entry, pending.item, pending.mode, voice);
      if (!this.tail && plan.rate !== 1) this.glide = { voice, from: plan.rate, at: performance.now() };
      this.run();
      if (this.tail) this.updateTail();
    }

    /** 混音中：按上一首的时间算两边的增益；重叠期间下一首按规划的速度播放，并把相位锁在上一首的拍子上 */
    updateTail() {
      const tail = this.tail;
      const player = this.player;
      const { voice: out, incoming, plan, start } = tail;
      const d = plan.x1 - plan.x0;
      const tau = out.time - start;
      const expected = plan.entry + tau * plan.rate;
      // 下一首已不是当前曲目、被暂停或被拖动了进度，或上一首播完：上一首退出
      if (!player.isCurrentVoice(incoming) || incoming.paused || out.paused || out.ended || tau >= d
        || Math.abs(incoming.time - expected) > 1.5) {
        this.stopTail();
        return;
      }
      const { fadeOutGain, fadeInGain } = global.AmAutomix;
      out.setGain(fadeOutGain(plan.out, tau));
      player.setMixGain(fadeInGain(plan.in, tau));
      // 下一首真正出声比 play() 返回晚（<audio> 约 0.1–0.2 秒）：开始 0.8 秒后两边的时钟都稳定了，量出滞后，下次提前这么多开始
      if (!tail.measured && tau > 0.8 && plan.kind !== 'skip') {
        tail.measured = true;
        const lag = tau - (incoming.time - plan.entry) / plan.rate;
        const kind = incoming.deck ? 'element' : 'pcm';
        if (Math.abs(lag) < 0.5) this.latency[kind] = Math.min(0.4, Math.max(0, this.latency[kind] + lag * 0.7));
        if (this.last) this.last.lag = lag;
      }
      // 相位锁（对齐了拍子的过渡）：误差（下一首超前为正，秒）在约 0.5 秒内消掉，速度最多偏离规划的 3%（保持音高，听不出来）；
      // 每 0.25 秒才改一次 playbackRate（每次修改浏览器都要重新调整变速算法）
      const now = performance.now();
      if (plan.beat && incoming.deck && tau > 0.5 && !(now - (tail.rateAt || 0) < 250)) {
        tail.rateAt = now;
        const error = incoming.time - expected;
        incoming.setRate(plan.rate * (1 - Math.max(-0.03, Math.min(0.03, error * 2))));
      }
    }

    stopTail() {
      const tail = this.tail;
      if (!tail) return;
      this.tail = null;
      // 先静音再停止：被打断时上一首还有声音，直接停会有爆音
      tail.voice.setGain(0);
      setTimeout(() => tail.voice.release(), 60);
      const player = this.player;
      player.renderAutomix();
      if (player.isCurrentVoice(tail.incoming)) {
        player.setMixGain(1);
        if (tail.incoming.rate !== 1) this.glide = { voice: tail.incoming, from: tail.incoming.rate, at: performance.now() };
      }
    }

    /** 变速对齐之后：用 RATE_GLIDE 慢慢回到原速 */
    updateGlide() {
      const glide = this.glide;
      const { voice, from, at } = glide;
      if (!this.player.isCurrentVoice(voice)) { this.glide = null; return; }
      const now = performance.now();
      if (now - (glide.rateAt || 0) < 200) return;
      glide.rateAt = now;
      const x = Math.min(1, (now - at) / RATE_GLIDE);
      const eased = x * x * (3 - 2 * x);
      voice.setRate(from + (1 - from) * eased);
      if (x >= 1) { voice.setRate(1); this.glide = null; }
    }

    /**
     * 手动下一首（或上一首播完，auto）：下一首已准备好时快速交叉淡化过去（播完时直接切换），不重新加载。
     * 返回是否已处理
     */
    skip(auto = false) {
      const pending = this.pending;
      if (!pending || pending.state !== 'ready' || pending.entry !== this.player.upcomingEntry()) return false;
      const paused = this.player.transport().paused;
      this.begin(pending, this.quickPlan(pending, auto || paused ? 0 : SKIP_FADE));
      return true;
    }

    /** 音量滑块变了：淡出中的上一首跟着变 */
    volumeChanged() {
      if (this.tail) this.tail.voice.setGain(this.tail.voice.gain);
    }
  }

  const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  const ICON_LOADING = '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';
  const ICON_QUEUE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h11M4 11h11M4 16h7"/><path d="M16 14.5v5.5"/><circle cx="14" cy="20" r="2"/><path d="M16 14.5 20 13"/></svg>';
  const ICON_CHECK = '<svg class="quality-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const ICON_GRIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 8h14M5 12h14M5 16h14"/></svg>';
  const ICON_REMOVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M7 12h10"/></svg>';
  const ICON_SHUFFLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h3c2.2 0 3.4 1 4.5 2.8l3 4.4C14.6 16 15.8 17 18 17h2.5"/><path d="M3 17h3c1.6 0 2.7-.6 3.6-1.6M14.4 8.6C15.3 7.6 16.4 7 18 7h2.5"/><path d="m18 4 3 3-3 3M18 14l3 3-3 3"/></svg>';
  const ICON_REPEAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12V9.5A3.5 3.5 0 0 1 7.5 6H20"/><path d="m17 3 3 3-3 3"/><path d="M20 12v2.5a3.5 3.5 0 0 1-3.5 3.5H4"/><path d="m7 21-3-3 3-3"/></svg>';
  const ICON_REPEAT_ONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12V9.5A3.5 3.5 0 0 1 7.5 6H20"/><path d="m17 3 3 3-3 3"/><path d="M20 12v2.5a3.5 3.5 0 0 1-3.5 3.5H4"/><path d="m7 21-3-3 3-3"/><path d="M11 10.5 12.5 9.5v5" stroke-width="1.8"/></svg>';
  /** AutoMix（∞）：路径带 pathLength，混音中沿着 8 字流动（见 app.css 的 .queue-automix.mixing） */
  const ICON_AUTOMIX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path pathLength="100" d="M12 12c-1.9-2.6-3.8-3.9-5.6-3.9a3.9 3.9 0 0 0 0 7.8c1.8 0 3.7-1.3 5.6-3.9Zm0 0c1.9 2.6 3.8 3.9 5.6 3.9a3.9 3.9 0 0 0 0-7.8c-1.8 0-3.7 1.3-5.6 3.9Z"/></svg>';

  /**
   * 页面底部播放条。
   * 与 music.apple.com 相同，整站是单页应用（app.html），播放条只有一个实例并常驻；
   * 各页面视图经 scope() 使用它，站内跳转时播放不中断。
   */
  class AmPlayer {
    /** 播放条上的歌名、艺人、专辑链接由前端路由（app.mjs）接管，文档不刷新，播放不中断 */
    constructor(root) {
      this.root = root;
      /**
       * <audio> 方式的播放器（deck：{ audio, mse, clock }）。平时只用一个；过渡（Mixer）时下一首在另一个 deck 上准备、开始，
       * 之后它成为当前的 deck（useDeck），this.audio / this.mse / this.clock 总是指向当前的那个，媒体事件只处理当前 deck 的
       */
      this.decks = [];
      this.useDeck(this.makeDeck());
      /** 过渡中当前曲目的增益（0–1，淡入），平时为 1；见 applyVolume */
      this.mixGain = 1;
      this.mixer = new Mixer(this);
      /** 已交给 MseEngine 接续播放的下一首在队列中的条目（见 prepareNext） */
      this.nextEntry = null;
      this.nextSerial = 0;
      this.pcm = null;
      /**
       * 双耳的交互控制（声场界面 joc-scene.mjs 修改，交给 JocEngine）：头部朝向（弧度，左转 / 抬头为正）、站位（米，右 / 前 / 上）、
       * 聚焦（0..1）、高度倍率与 16 路增益（LFE 与 15 个对象，由 solo / mute 里的编号算出，0 为 LFE）。
       * 朝向与站位跨曲目保留，增益、独奏与静音每首重新开始（对象编号因曲而异）
       */
      this.spatial = { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0, focus: 0, height: 1, gains: new Array(16).fill(1), solo: [], mute: [] };
      this.spatialListeners = new Set();
      /** 声场界面是否打开（铺满视口，盖住歌词界面；歌词界面据此停掉自己的动画，见 lyrics/panel.mjs） */
      this.sceneOpen = false;
      this.sceneListeners = new Set();
      this.$ = (sel) => root.querySelector(sel);
      // 歌名、「艺人 — 专辑」两行滚动字幕
      const title = this.$('.player-title');
      const titleHost = Object.assign(root.ownerDocument.createElement('span'), { className: 'marquee marquee--primary' });
      title.replaceChildren(titleHost);
      this.titleMarquee = new Marquee(titleHost);
      // 音质详情（全屏播放界面里点音质标志弹出，见 renderQualityPanel）；app.html 把它放在全屏播放界面里
      this.qualityPanel = root.ownerDocument.getElementById('quality-panel')
        || root.appendChild(Object.assign(root.ownerDocument.createElement('div'), { className: 'quality-panel', hidden: true }));
      /** 各歌曲的全部音质（track → Promise<variants>），条目里没带 variants 时（如歌曲页播放）打开详情才取 */
      this.variantCache = new Map();
      this.$('.player-sub').classList.add('marquee', 'marquee--secondary');
      this.subMarquee = new Marquee(this.$('.player-sub'));
      this.listeners = new Set();
      this.unsupportedListeners = new Set();
      this.playToken = 0;
      /** 播放队列：{ entries, pos }，entries 见 resolveEntry；pendingTrack 为正在解析的曲目 */
      this.queue = null;
      this.queueSerial = 0;
      this.pendingTrack = null;
      /** 随机播放（true / false）与重复播放（off / all / one），与 Apple Music 相同，下次打开时保留 */
      this.shuffle = false;
      this.repeat = 'off';
      try {
        this.shuffle = localStorage.getItem('am-hook:shuffle') === '1';
        const repeat = localStorage.getItem('am-hook:repeat');
        if (repeat === 'all' || repeat === 'one') this.repeat = repeat;
      } catch {}
      new ResizeObserver(() => this.layout()).observe(root);
      this.bindUi();
      this.bindQueueUi();
      this.bindKeys(root.ownerDocument);
      /** 音量滑块的值（0–1）；audio 元素上的实际音量还要乘 ALAC / AAC 的补偿，见 applyVolume */
      this.volume = 1;
      try {
        const v = parseFloat(localStorage.getItem('am-hook:volume'));
        if (v >= 0 && v <= 1) this.volume = v;
      } catch {}
      this.applyVolume();
      this.renderVolume();
      if (global.AmI18n) global.AmI18n.onChange(() => this.renderLang());
    }

    /** 切换界面语言后重绘播放条上的文字 */
    renderLang() {
      this.renderToggle();
      this.renderVolume();
      if (this.current) {
        this.renderMode();
        this.renderTrackText();
      }
      this.renderError();
      this.renderQueueLang();
    }

    /**
     * 与 music.apple.com 的播放条相同：第一行歌名（链接到歌曲页），第二行「艺人 — 专辑」，
     * 各位艺人与专辑名分别链接到艺人页、专辑页；过长时滚动（见 Marquee）；音质显示为歌名旁的小标签
     */
    renderTrackText() {
      const c = this.current;
      const doc = this.root.ownerDocument;
      const link = (href, text) => (href ? Object.assign(doc.createElement('a'), { href, textContent: text }) : text);
      this.titleMarquee.set([link(c.href, c.title || t('player.unknownTitle'))]);
      const artists = c.artist ? artistNodes(c.artist, c.artists, doc) : [];
      const album = c.album ? [link(c.albumHref, c.album)] : [];
      this.subMarquee.set([...artists, ...(artists.length && album.length ? [' — '] : []), ...album]);
    }

    renderArtwork(item) {
      const art = this.$('.player-art');
      if (item.artwork) {
        if (art.getAttribute('src') !== item.artwork) art.src = item.artwork;
      } else if (art.hasAttribute('src')) {
        art.removeAttribute('src');
      }
    }

    /**
     * 音质标志：全屏播放界面里进度条下方居中的小框（AMLL 的 AudioQualityTag），显示 Hi-Res Lossless / Lossless /
     * Dolby Atmos / Spatial Audio / AAC 图标，没有音质标签时显示播放方式；浮在页面底部的播放条不显示它（app.css）。
     * 点击弹出音质详情（renderQualityPanel）
     */
    renderMode() {
      if (!this.current) return;
      const c = this.current;
      const badge = this.$('.player-mode');
      const doc = this.root.ownerDocument;
      const icon = qualityIcon(c.badge, doc);
      if (icon) icon.removeAttribute('title');
      const label = icon ? icon.getAttribute('aria-label') : this.modeText();
      // JOC 渲染时图标后面注明，否则看不出没有走浏览器自己的解码
      const joc = isJocMode(c.mode) ? t(c.mode === 'jocbin' ? 'player.jocBadgeBinaural' : 'player.jocBadgeSpeaker') : '';
      badge.replaceChildren(icon || label, ...(joc ? [el(doc, 'span', 'player-mode-joc', joc)] : []));
      badge.hidden = false;
      badge.title = t('player.qualityInfo');
      badge.setAttribute('aria-label', `${t('player.qualityInfo')}: ${[label, joc, c.label].filter(Boolean).join(' · ')}`);
      this.renderQualityPanel();
    }

    /** 播放方式：MSE · ALAC（浏览器直接解码）、ALAC → FLAC（转码）、E-AC-3 → 5.1 PCM（解码为多声道 PCM）、E-AC-3 → JOC（对象渲染） */
    modeText() {
      const c = this.current;
      if (c.mode === 'joc2') return `E-AC-3 → ${t('player.jocSpeaker')}`;
      if (c.mode === 'jocbin') return `E-AC-3 → ${t('player.jocBinaural', { dataset: this.pcm ? this.pcm.dataset : jocSettings().dataset })}`;
      if (c.mode === 'flac') return 'ALAC → FLAC';
      if (c.mode === 'ec3') {
        const channels = this.pcm && this.pcm.channels;
        return `E-AC-3 → ${channels ? t('player.pcmChannels', { n: channels - 1 }) : t('player.pcmMode')}`;
      }
      return `MSE · ${codecName(c.codecs)}`;
    }

    /**
     * 音质详情：当前音质（图标、名称与位深 / 采样率）、播放方式及说明、码率与声道；下面是这首歌的全部音质，
     * 点击切换（从当前位置继续，待播清单不变），当前浏览器不能播放的置灰
     */
    renderQualityPanel() {
      const panel = this.qualityPanel;
      const c = this.current;
      if (panel.hidden || !c) return;
      const doc = this.root.ownerDocument;
      const v = c.variant || {};
      const joc = isJocMode(c.mode);
      const rows = [
        [t('player.mode'), this.modeText()],
        [t('player.bitrate'), formatRate(v.bandwidth)],
        [t('player.channels'), v.channels ? String(v.channels).split('/')[0] : ''],
        [t('player.jocGain'), joc ? `${jocSettings().gain} dB` : ''],
      ].filter(([, value]) => value);
      const note = joc ? [t('player.jocNotice'), c.mode === 'joc2' && this.jocFallback && t('player.jocHrtfMissing')].filter(Boolean).join(' ')
        : t(c.mode === 'ec3' ? 'player.pcmNotice' : c.mode === 'flac' ? 'player.flacNotice' : 'player.mseNotice');
      const list = el(doc, 'div', 'quality-panel-list');
      panel.replaceChildren(
        el(doc, 'div', 'quality-panel-head', qualityIcon(c.badge, doc), el(doc, 'span', 'quality-panel-label', c.label || codecName(c.codecs))),
        el(doc, 'dl', 'quality-panel-specs', ...rows.flatMap(([key, value]) => [el(doc, 'dt', '', key), el(doc, 'dd', '', value)])),
        el(doc, 'p', 'quality-panel-note', note),
        ...(isEc3(c.codecs) && jocStore ? this.jocSwitch(doc) : []),
        el(doc, 'h3', 'quality-panel-heading', t('player.qualities')),
        list);
      const state = this.variantsOf(c);
      if (state.loading) list.append(el(doc, 'p', 'quality-panel-status', t('player.qualitiesLoading')));
      else if (state.error) list.append(el(doc, 'p', 'quality-panel-status', t('player.qualitiesFailed', { msg: state.error })));
      for (const variant of sortVariants(state.variants || [])) {
        const id = `${c.track}:${variant.group_id}`;
        const playable = detectModes(variant.codecs).length > 0;
        const spec = [codecName(variant.codecs), formatRate(variant.bandwidth), ...variantTags(variant), !playable && t('row.downloadOnly')];
        const button = el(doc, 'button', 'quality-option',
          qualityIcon(qualityBadge(variant), doc),
          el(doc, 'span', 'quality-option-text',
            el(doc, 'span', 'quality-option-name', variantLabel(variant)),
            el(doc, 'span', 'quality-option-spec', spec.filter(Boolean).join(' · '))));
        button.type = 'button';
        button.disabled = !playable;
        if (!playable) button.title = t('row.unsupported');
        if (id === c.id) {
          button.setAttribute('aria-current', 'true');
          button.insertAdjacentHTML('beforeend', ICON_CHECK);
        }
        button.addEventListener('click', () => this.switchVariant(variant));
        list.append(button);
      }
      this.placeQualityPanel();
    }

    /**
     * 歌曲的全部音质：{ variants } / { loading } / { error }。条目带着 variants（队列播放）时直接用，
     * 否则（如歌曲页播放）向 wrapper-lite 取一次 master，按歌曲缓存，取回后重绘详情
     */
    variantsOf(item) {
      if (item.variants) return { variants: item.variants };
      const cached = this.variantCache.get(item.track);
      if (cached) return cached;
      const state = { loading: true };
      this.variantCache.set(item.track, state);
      if (this.variantCache.size > 20) this.variantCache.delete(this.variantCache.keys().next().value);
      global.AmWrapper.songMaster(item.track)
        .then(({ variants }) => { state.variants = variants; }, (err) => { state.error = err.message || String(err); })
        .finally(() => {
          state.loading = false;
          if (this.current && this.current.track === item.track) this.renderQualityPanel();
        });
      return state;
    }

    /** 音质详情里的 JOC 开关（E-AC-3 曲目）：关闭 / Speaker 2.0 / 双耳，与设置中心的「播放方式」是同一项 */
    jocSwitch(doc) {
      const current = jocSettings().mode;
      const group = el(doc, 'div', 'quality-panel-joc');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', t('player.jocHeading'));
      for (const [mode, key] of [['off', 'set.joc.off'], ['speaker', 'set.joc.speaker'], ['binaural', 'set.joc.binaural']]) {
        const button = el(doc, 'button', 'quality-panel-joc-option', t(key));
        button.type = 'button';
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(current === mode));
        button.addEventListener('click', () => { if (jocSettings().mode !== mode) jocStore.set({ mode }); });
        group.append(button);
      }
      // 声场界面：虚拟头部与对象（双耳），不是双耳时打开会先切过去
      const spatial = el(doc, 'button', 'quality-panel-spatial',
        el(doc, 'span', 'quality-panel-spatial-name', t('player.spatialOpen')),
        el(doc, 'span', 'quality-panel-spatial-hint', t('player.spatialHint')));
      spatial.type = 'button';
      spatial.addEventListener('click', () => {
        this.closeQualityPanel();
        this.openSpatial().catch((err) => this.showError(err.message || String(err)));
      });
      return [el(doc, 'h3', 'quality-panel-heading', t('player.jocHeading')), group, spatial];
    }

    /** 声场界面用：正在用 JOC 播放时的引擎（JocLiveEngine，live 为 true 时低延迟）；否则为 null */
    spatialEngine() { return this.pcm instanceof JocEngine ? this.pcm : null; }

    /** 修改双耳的交互控制（只带变了的字段），立即交给引擎，并通知声场界面 */
    setSpatial(patch) {
      this.spatial = { ...this.spatial, ...patch };
      const engine = this.spatialEngine();
      if (engine) engine.setControls(this.spatial);
      this.emitSpatial();
    }

    onSpatial(fn) { this.spatialListeners.add(fn); return () => this.spatialListeners.delete(fn); }
    emitSpatial() { for (const fn of this.spatialListeners) fn(this.spatial); }
    onSceneOpen(fn) { this.sceneListeners.add(fn); return () => this.sceneListeners.delete(fn); }
    /** joc-scene.mjs 打开 / 关闭声场界面时调用 */
    setSceneOpen(on) {
      if (this.sceneOpen === on) return;
      this.sceneOpen = on;
      for (const fn of this.sceneListeners) fn(on);
    }

    /** 打开声场界面（按需加载 joc-scene.mjs）；不是双耳渲染时先切到双耳 */
    async openSpatial() {
      if (jocStore && jocSettings().mode !== 'binaural') jocStore.set({ mode: 'binaural' });
      const scene = await import('/assets/joc-scene.mjs');
      scene.open(this);
    }

    /**
     * JOC 设置变了（设置中心、音质详情或其他标签页，见 app.mjs）：正在用 JOC 播放时，衰减立即生效，换输出方式或 HRTF
     * 从当前位置继续；在 JOC 与浏览器自己的解码之间切换要换播放方式，正在播放时从当前位置重新开始，暂停时等下次播放
     */
    jocChanged() {
      const c = this.current;
      const joc = jocSettings();
      const previous = this.jocMode;
      this.jocMode = joc.mode;
      this.applyVolume();
      if (!c) return;
      if (isEc3(c.codecs)) {
        const pcm = this.pcm instanceof JocEngine ? this.pcm : null;
        const mode = joc.mode === 'binaural' ? 'binaural' : 'speaker';
        const reconfigure = pcm && (mode !== pcm.mode || (mode === 'binaural' && joc.dataset !== pcm.dataset));
        if (pcm && joc.gain !== pcm.gainDb) pcm.setGain(joc.gain);
        // 还在选择播放方式（加载中）时，方式或 HRTF 变了就按新设置重新开始
        if (this.attempting && (joc.mode !== previous || reconfigure)) { this.replay(); return; }
        if (pcm && joc.mode !== 'off') {
          if (reconfigure) {
            this.jocFallback = false;
            this.pcm.clipped = false;
            this.pcm.reconfigure({ mode, dataset: joc.dataset }).catch(() => {});
            c.mode = mode === 'binaural' ? 'jocbin' : 'joc2';
          }
        } else if (joc.mode !== previous) {
          if (this.transport().paused) this.jocStale = true;
          else { this.replay(); return; }
        }
      }
      this.renderMode();
    }

    /**
     * 播放音质的设置或网络（Wi-Fi / 移动数据）变了（app.mjs）：当前曲目照常播完，从下一首起按新设置选音质；
     * 已经为接续准备好的下一首按新设置重新准备
     */
    playbackChanged() {
      this.renderModes();
      if (!this.nextEntry && !this.mixer.entry) return;
      this.nextEntry = null;
      // 过渡的方式或时长也可能变了：重新规划（已经开始的淡出照常完成）
      this.mixer.cancel();
      this.prepareNext();
    }

    /** 按当前设置重新选择播放方式，从当前位置继续播放当前曲目 */
    replay() {
      this.jocStale = false;
      const { mode, duration, ...item } = this.current;
      return this.start(item, { force: true });
    }

    /** 换成同一首歌的另一种音质 */
    switchVariant(variant) {
      const c = this.current;
      if (!c || c.id === `${c.track}:${variant.group_id}`) return;
      const { mode, duration, ...item } = c;
      this.play({ ...item, ...variantItem(c.track, variant) });
    }

    openQualityPanel() {
      if (!this.current) return;
      const state = this.variantCache.get(this.current.track);
      if (state && state.error) this.variantCache.delete(this.current.track); // 上次没取到：重新取
      this.qualityPanel.hidden = false;
      this.$('.player-mode').setAttribute('aria-expanded', 'true');
      this.renderQualityPanel();
    }

    closeQualityPanel(focusBadge) {
      if (this.qualityPanel.hidden) return;
      this.qualityPanel.hidden = true;
      const badge = this.$('.player-mode');
      badge.setAttribute('aria-expanded', 'false');
      if (focusBadge) badge.focus({ preventScroll: true });
    }

    /** 详情浮在音质标志上方（放不下时在下方），水平居中对准标志，不超出视口（四周各留 16px）；标志不可见时收起 */
    placeQualityPanel() {
      const panel = this.qualityPanel;
      if (panel.hidden) return;
      const badge = this.$('.player-mode').getBoundingClientRect();
      if (!badge.width) { this.closeQualityPanel(); return; }
      const { clientWidth, clientHeight } = this.root.ownerDocument.documentElement;
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const x = Math.max(16, Math.min(badge.left + badge.width / 2 - width / 2, clientWidth - 16 - width));
      const above = badge.top - 10 - height;
      const y = above >= 16 ? above : Math.min(badge.bottom + 10, clientHeight - 16 - height);
      panel.style.left = `${x}px`;
      panel.style.top = `${Math.max(16, y)}px`;
    }

    /** 音量 0–1，记在本地；喇叭图标的声波按音量显示 0–3 条 */
    setVolume(volume) {
      this.volume = volume;
      this.applyVolume();
      try { localStorage.setItem('am-hook:volume', String(volume)); } catch {}
      this.renderVolume();
    }

    /**
     * 把音量交给输出：PCM（EC-3 / JOC）用滑块的值；audio 元素播放 ALAC / AAC 时再乘设置中心的补偿（只衰减，不会削波），
     * 让它与通常更小声的全景声接近。经 MSE 播放的 E-AC-3 不补偿。换曲目（含无缝接续）与设置变化时调用
     */
    applyVolume() {
      const c = this.current;
      this.audio.volume = Math.min(1, Math.max(0, this.baseGain(c, 'mse') * this.mixGain));
      if (this.pcm) {
        const param = this.pcm.gain.gain;
        if (param.cancelScheduledValues && this.pcm.context) param.cancelScheduledValues(this.pcm.context.currentTime);
        param.value = this.volume * this.mixGain;
      }
      this.mixer.volumeChanged();
    }

    /** 某首歌的基础音量（不含过渡的增益）：PCM 为滑块的值，<audio> 播放 ALAC / AAC 时再乘补偿 */
    baseGain(item, mode) {
      if (isPcmMode(mode)) return this.volume;
      const db = item && !isEc3(item.codecs) ? Number(jocSettings().stereoGain) || 0 : 0;
      return this.volume * 10 ** (Math.min(0, db) / 20);
    }

    /** 过渡中当前曲目的增益（Mixer 每次更新调用）；PCM 用平滑过渡，免得逐级跳变 */
    setMixGain(gain) {
      this.mixGain = gain;
      const c = this.current;
      if (c && isPcmMode(c.mode) && this.pcm) {
        const param = this.pcm.gain.gain;
        param.cancelScheduledValues(this.pcm.context.currentTime);
        param.setTargetAtTime(this.volume * gain, this.pcm.context.currentTime, 0.012);
      } else {
        this.audio.volume = Math.min(1, Math.max(0, this.baseGain(c, 'mse') * gain));
      }
    }

    renderVolume() {
      const volume = this.volume;
      const input = this.$('.volume');
      input.value = volume;
      input.style.setProperty('--volume', `${volume * 100}%`);
      this.$('.player-volume').dataset.level = volume === 0 ? 0 : Math.min(3, Math.ceil(volume * 3));
      const label = t(volume === 0 ? 'player.unmute' : 'player.mute');
      const button = this.$('.volume-toggle');
      button.setAttribute('aria-label', label);
      button.title = label;
    }

    transport() { return this.current && isPcmMode(this.current.mode) && this.pcm ? this.pcm : this.clock; }

    /**
     * 歌词背景的节拍律动（lyrics/pulse.mjs）在哪里取样：PCM 播放为其上下文里音量调节前的混音节点，
     * MSE 播放为 <audio>（只旁路截取，不改变它的输出）；没有曲目时为 null
     */
    pulseSource() {
      if (!this.current) return null;
      return isPcmMode(this.current.mode) ? (this.pcm && this.pcm.mix) || null : this.audio;
    }

    updatePcm() {
      this.renderToggle();
      this.renderProgress();
      this.renderMode();
      this.emit();
    }

    onChange(fn) { this.listeners.add(fn); }
    emit() {
      this.listeners.forEach((fn) => fn(this.current, !this.transport().paused));
      this.renderModes();
      this.renderQueue();
    }

    /** 新建一个 <audio> 的 deck（见构造函数）；媒体事件只在它是当前 deck 时处理 */
    makeDeck() {
      const audio = new Audio();
      audio.preload = 'auto';
      const mse = new MseEngine(audio);
      /** voice：占用它的、不是当前曲目的 Voice（准备中的下一首、淡出中的上一首），空闲时为 null */
      const deck = { audio, mse, clock: null, voice: null };
      mse.onTrackChange = (item) => { if (this.mse === mse) this.advance(item); };
      deck.clock = new AudioClock(audio, () => (this.current && isElementMode(this.current.mode) ? mse.base : 0));
      const on = (ev, fn) => audio.addEventListener(ev, () => { if (this.audio === audio) fn(); });
      ['timeupdate', 'progress', 'durationchange', 'loadedmetadata'].forEach((ev) => on(ev, () => this.renderProgress()));
      ['play', 'pause', 'playing', 'waiting', 'ended'].forEach((ev) => on(ev, () => { this.renderToggle(); this.emit(); }));
      on('ended', () => this.ended());
      on('error', () => {
        // 尝试阶段的错误由 play() 统一处理（会自动换下一种播放方式）
        if (!this.attempting && this.current && this.current.mode !== 'mse' && audio.getAttribute('src')) {
          this.showError(() => t('player.errorGeneric', { hint: fallbackHint() }));
        }
      });
      this.decks.push(deck);
      return deck;
    }

    useDeck(deck) {
      deck.voice = null;
      this.deck = deck;
      this.audio = deck.audio;
      this.mse = deck.mse;
      this.clock = deck.clock;
    }

    /** 空闲的 deck（不是当前的、也没有被准备中或淡出中的曲目占用）；没有就新建 */
    idleDeck() {
      return this.decks.find((d) => d !== this.deck && !d.voice) || this.makeDeck();
    }

    /** 过渡时下一首用的 deck：先占上，Voice 创建后改为它 */
    claimDeck() {
      const deck = this.idleDeck();
      deck.voice = 'claimed';
      return deck;
    }

    /** deck 不再使用：停止并清空，留着下次过渡再用 */
    releaseDeck(deck) {
      deck.voice = null;
      if (deck === this.deck) return;
      deck.mse.destroy();
      deck.audio.pause();
      deck.audio.removeAttribute('src');
      deck.audio.load();
      deck.audio.playbackRate = 1;
    }

    bindUi() {
      this.$('.player-toggle').addEventListener('click', () => this.toggle());
      this.$('.skip-prev').addEventListener('click', () => this.previous());
      this.$('.skip-next').addEventListener('click', () => this.next());
      this.$('.player-shuffle').addEventListener('click', () => this.setShuffle(!this.shuffle));
      this.$('.player-repeat').addEventListener('click', () => this.cycleRepeat());
      this.$('.volume').addEventListener('input', (e) => this.setVolume(Number(e.target.value)));
      this.$('.player-mode').addEventListener('click', () => (this.qualityPanel.hidden ? this.openQualityPanel() : this.closeQualityPanel()));

      // 音量：鼠标移入、键盘聚焦时展开滑块；点喇叭静音 / 恢复，触屏上第一下只展开
      const volume = this.$('.player-volume');
      const volumeButton = this.$('.volume-toggle');
      const expand = (on) => volume.classList.toggle('expanded', on);
      let tapExpands = false;
      volume.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') expand(true); });
      volume.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !volume.querySelector(':focus-visible')) expand(false); });
      volume.addEventListener('focusin', () => expand(true));
      volume.addEventListener('focusout', (e) => { if (!volume.contains(e.relatedTarget)) expand(false); });
      volumeButton.addEventListener('pointerdown', (e) => { tapExpands = e.pointerType !== 'mouse' && !volume.classList.contains('expanded'); });
      volumeButton.addEventListener('click', () => {
        if (tapExpands) { tapExpands = false; expand(true); return; }
        if (this.volume > 0) {
          this.unmuteVolume = this.volume;
          this.setVolume(0);
        } else {
          this.setVolume(this.unmuteVolume || 0.5);
        }
      });

      const seek = this.$('.seek');
      const ratioAt = (e) => {
        const r = seek.getBoundingClientRect();
        return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      };
      seek.addEventListener('pointerdown', (e) => {
        if (!this.duration()) return;
        seek.setPointerCapture(e.pointerId);
        seek.classList.add('dragging');
        this.dragRatio = ratioAt(e);
        this.renderProgress();
      });
      seek.addEventListener('pointermove', (e) => {
        if (this.dragRatio === undefined) return;
        this.dragRatio = ratioAt(e);
        this.renderProgress();
      });
      const release = () => {
        if (this.dragRatio === undefined) return;
        this.transport().currentTime = this.dragRatio * this.duration();
        this.dragRatio = undefined;
        seek.classList.remove('dragging');
      };
      seek.addEventListener('pointerup', release);
      seek.addEventListener('pointercancel', release);
      seek.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') { this.seekBy(-5); e.preventDefault(); }
        if (e.key === 'ArrowRight') { this.seekBy(5); e.preventDefault(); }
      });

      if ('mediaSession' in navigator) {
        const ms = navigator.mediaSession;
        ms.setActionHandler('play', () => this.transport().play());
        ms.setActionHandler('pause', () => this.transport().pause());
        ms.setActionHandler('seekbackward', () => this.seekBy(-10));
        ms.setActionHandler('seekforward', () => this.seekBy(10));
        try { ms.setActionHandler('seekto', (d) => { this.transport().currentTime = d.seekTime; }); } catch {}
        try {
          ms.setActionHandler('nexttrack', () => this.next());
          ms.setActionHandler('previoustrack', () => this.previous());
        } catch {}
      }
    }

    /** 空格播放 / 暂停，左右方向键快退 / 快进 */
    bindKeys(doc) {
      // 待播清单面板：按 Esc 或点击面板与播放条以外的地方时收起；音质详情、音量滑块同样点别处收起
      doc.addEventListener('pointerdown', (e) => {
        if (!this.qualityPanel.hidden && !e.target.closest('.player-mode, .quality-panel')) this.closeQualityPanel();
        if (!this.$('.player-volume').contains(e.target)) this.$('.player-volume').classList.remove('expanded');
        // data-queue-keep：全屏播放界面底部的开关（待播清单开关移到了那里，见 lyrics/panel.mjs），点击时不先收起清单
        if (this.queuePanel.hidden || this.queuePanel.contains(e.target) || this.root.contains(e.target)
          || e.target.closest?.('[data-queue-keep]')) return;
        this.closeQueue();
      });
      doc.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this.qualityPanel.hidden) { e.preventDefault(); this.closeQualityPanel(true); return; }
        // preventDefault：歌词界面里打开清单时，Esc 只收起清单（见 lyrics/panel.mjs）
        if (e.key === 'Escape' && !this.queuePanel.hidden) { e.preventDefault(); this.closeQueue(true); return; }
        if (!this.current || e.defaultPrevented || e.target.closest('input, textarea, button, a, [role="slider"]')) return;
        if (e.code === 'Space') { e.preventDefault(); this.toggle(); }
        if (e.key === 'ArrowLeft') this.seekBy(-5);
        if (e.key === 'ArrowRight') this.seekBy(5);
      });
    }

    /**
     * 待播清单，布局与交互参照 music.apple.com 的「待播清单」侧栏：
     * 标题与「清除」、55px 的行（封面 / 歌名与艺人 / 时长），悬停时封面左上角出现移除按钮；
     * 鼠标单击选中、双击播放，拖动整行调整顺序；触屏点按播放，拖动右侧把手调整顺序（与 iOS 相同）。
     * 键盘：↑/↓ 选择，Enter 播放，Delete 移除，Alt+↑/↓ 移动。
     * 窄屏时随机 / 重复按钮从播放条移到清单标题旁（与手机版相同）。
     * 面板浮在播放条上方。
     */
    bindQueueUi() {
      const doc = this.root.ownerDocument;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'player-queue';
      button.innerHTML = ICON_QUEUE;
      button.setAttribute('aria-expanded', 'false');
      this.$('.player-right').insertBefore(button, this.$('.player-volume'));

      const panel = doc.createElement('section');
      panel.className = 'queue-panel';
      panel.id = 'queue-panel';
      panel.hidden = true;
      panel.innerHTML = '<header class="queue-head"><h2 class="queue-title"></h2>'
        + `<button class="queue-automix" type="button" aria-pressed="false">${ICON_AUTOMIX}<span class="queue-automix-label"></span></button>`
        + `<div class="queue-switches"><button class="player-switch player-shuffle" type="button" aria-pressed="false">${ICON_SHUFFLE}</button>`
        + '<button class="player-switch player-repeat" type="button" aria-pressed="false"></button></div>'
        + '<button class="queue-clear" type="button"></button></header>'
        + '<p class="queue-empty" hidden></p><ol class="queue-list"></ol>';
      doc.body.appendChild(panel);
      button.setAttribute('aria-controls', panel.id);
      this.queueButton = button;
      this.queuePanel = panel;
      this.queueKey = '';
      this.queueSelected = null;

      button.addEventListener('click', () => (panel.hidden ? this.openQueue() : this.closeQueue()));
      panel.querySelector('.player-shuffle').addEventListener('click', () => this.setShuffle(!this.shuffle));
      panel.querySelector('.player-repeat').addEventListener('click', () => this.cycleRepeat());
      panel.querySelector('.queue-automix').addEventListener('click', () => this.toggleAutomix());
      panel.querySelector('.queue-clear').addEventListener('click', () => {
        if (this.queue) {
          this.queue.entries.splice(this.queue.pos + 1);
          if (this.queue.ordered) this.queue.ordered = this.queue.entries.slice();
          // 清空后电台也不再续上
          this.queue.more = null;
        }
        this.renderQueue(true);
        this.renderModes();
        this.prepareNext();
      });

      const list = panel.querySelector('.queue-list');
      const rowOf = (target) => target.closest('.queue-item');
      const indexOf = (row) => Number(row.dataset.index);
      let pointerType = 'mouse';
      list.addEventListener('click', (e) => {
        const row = rowOf(e.target);
        if (!row || !this.queue || this.queueDrag) return;
        if (e.target.closest('.queue-remove')) this.removeQueueEntry(indexOf(row));
        else if (pointerType === 'mouse') this.selectQueueRow(row);
        else this.playAt(indexOf(row));
      });
      list.addEventListener('dblclick', (e) => {
        const row = rowOf(e.target);
        if (row && this.queue && !e.target.closest('.queue-remove')) this.playAt(indexOf(row));
      });
      list.addEventListener('keydown', (e) => {
        const row = rowOf(e.target);
        if (!row || !this.queue || e.target !== row) return;
        const index = indexOf(row);
        const rows = [...list.querySelectorAll('.queue-item')];
        const at = rows.indexOf(row);
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.playAt(index); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.removeQueueEntry(index); return; }
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const step = e.key === 'ArrowUp' ? -1 : 1;
        if (!e.altKey) {
          const next = rows[at + step];
          if (next) { this.selectQueueRow(next); next.focus(); }
          return;
        }
        const to = index + step;
        if (to <= this.queue.pos || to >= this.queue.entries.length) return;
        this.moveQueueEntry(index, to);
        list.querySelector(`.queue-item[data-index="${to}"]`).focus();
      });

      // 拖动排序：经过其他行的中线时交换位置，松开后按新顺序写回队列。
      // 鼠标按住整行移动超过 4px 开始拖动；把手（触屏时显示）按下即开始。
      // 指针捕获放在列表上：拖动的行会在 DOM 中移动，移动会让行内元素失去捕获
      list.addEventListener('pointerdown', (e) => {
        pointerType = e.pointerType || 'mouse';
        const row = rowOf(e.target);
        if (!row || !this.queue || e.button !== 0 || e.target.closest('.queue-remove')) return;
        const entry = this.queue.entries[indexOf(row)];
        const grip = e.target.closest('.queue-grip');
        if (!entry || (!grip && pointerType !== 'mouse')) return;
        if (grip) e.preventDefault();
        const startY = e.clientY;
        let active = false;
        const begin = () => {
          active = true;
          list.setPointerCapture(e.pointerId);
          row.classList.add('dragging');
          list.classList.add('sorting');
          this.queueDrag = { row };
          this.selectQueueRow(row);
        };
        const move = (ev) => {
          if (!active) {
            if (Math.abs(ev.clientY - startY) < 4) return;
            begin();
          }
          ev.preventDefault();
          // 靠近列表上下边缘时自动滚动
          const box = list.getBoundingClientRect();
          if (ev.clientY < box.top + 28) list.scrollTop -= 8;
          else if (ev.clientY > box.bottom - 28) list.scrollTop += 8;
          for (const other of list.querySelectorAll('.queue-item:not(.dragging)')) {
            const r = other.getBoundingClientRect();
            const mid = r.top + r.height / 2;
            // other 在拖动行之前：指针越过它的中线往上时移到它前面；在之后：越过中线往下时移到它后面
            const above = other.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING;
            if (above && ev.clientY < mid) other.before(row);
            else if (!above && ev.clientY > mid) other.after(row);
          }
        };
        const end = () => {
          list.removeEventListener('pointermove', move);
          list.removeEventListener('pointerup', end);
          list.removeEventListener('pointercancel', end);
          if (!active) return;
          row.classList.remove('dragging');
          list.classList.remove('sorting');
          // 点击事件在 pointerup 之后触发，等它过去再允许点击
          setTimeout(() => { this.queueDrag = null; }, 0);
          // 拖动期间可能已播完一首（pos 变化）或队列被替换，按曲目重新定位
          const q = this.queue;
          const from = q ? q.entries.indexOf(entry) : -1;
          const to = q ? q.pos + 1 + [...list.querySelectorAll('.queue-item')].indexOf(row) : -1;
          if (q && from > q.pos && to > q.pos && to < q.entries.length && to !== from) this.moveQueueEntry(from, to);
          else this.renderQueue(true);
        };
        list.addEventListener('pointermove', move);
        list.addEventListener('pointerup', end);
        list.addEventListener('pointercancel', end);
        if (grip) begin();
      });

      this.renderQueueLang();
    }

    /** 选中一行（鼠标单击、方向键），重绘后按曲目保留 */
    selectQueueRow(row) {
      this.queueSelected = this.queue ? this.queue.entries[Number(row.dataset.index)] : null;
      for (const other of this.queuePanel.querySelectorAll('.queue-item')) other.classList.toggle('selected', other === row);
    }

    /** 把队列中 from 处的曲目移到 to（均在当前曲目之后） */
    moveQueueEntry(from, to) {
      const entries = this.queue.entries;
      const [entry] = entries.splice(from, 1);
      entries.splice(to, 0, entry);
      this.renderQueue(true);
      this.prepareNext();
    }

    removeQueueEntry(index) {
      const q = this.queue;
      const [entry] = q.entries.splice(index, 1);
      if (q.ordered) q.ordered.splice(q.ordered.indexOf(entry), 1);
      this.renderQueue(true);
      this.renderModes();
      this.prepareNext();
      // 焦点移到原位置的下一行，没有时回到上一行或清单按钮
      const rows = this.queuePanel.querySelectorAll('.queue-item');
      const next = rows[Math.min(index - q.pos - 1, rows.length - 1)];
      if (next) { this.selectQueueRow(next); next.focus(); } else this.queueButton.focus();
    }

    openQueue() {
      this.queuePanel.hidden = false;
      this.queueButton.setAttribute('aria-expanded', 'true');
      this.renderQueue(true);
      this.placeQueue();
      this.queuePanel.querySelector('.queue-list').scrollTop = 0;
    }

    closeQueue(refocus = false) {
      if (this.queuePanel.hidden) return;
      this.queuePanel.hidden = true;
      this.queuePanel.classList.remove('in-lyrics');
      Object.assign(this.queuePanel.style, { top: '', left: '', width: '' });
      this.root.ownerDocument.querySelector('.lyrics-overlay.queue-open')?.classList.remove('queue-open');
      this.queueButton.setAttribute('aria-expanded', 'false');
      this.queueSelected = null;
      if (refocus) this.queueButton.focus();
    }

    /**
     * 面板右边缘与播放条对齐，底部在播放条上方；播放条隐藏时收起。
     * 播放条并入全屏播放界面时（待播清单开关也移到界面里，见 lyrics/panel.mjs），清单占据歌词的位置
     * （界面里的 .lyrics-queue-slot；.queue-open / .in-lyrics 的样式见 app.css）；开关不可见时收起。
     */
    placeQueue() {
      if (this.queuePanel.hidden) return;
      const host = this.root.closest('.lyrics-overlay');
      if (this.root.hidden || (host && !this.queueButton.offsetParent)) { this.closeQueue(); return; }
      const win = this.root.ownerDocument.defaultView;
      this.queuePanel.classList.toggle('in-lyrics', !!host);
      if (host) {
        // 先加 queue-open：界面据此切换布局（如竖向布局改为小封面），再按切换后的位置摆放
        host.classList.add('queue-open');
        const slot = host.querySelector('.lyrics-queue-slot').getBoundingClientRect();
        const width = this.root.ownerDocument.documentElement.clientWidth;
        Object.assign(this.queuePanel.style, {
          top: `${slot.top}px`, bottom: `${win.innerHeight - slot.bottom}px`,
          left: `${slot.left}px`, right: `${width - slot.right}px`, width: 'auto',
        });
        return;
      }
      this.queuePanel.style.top = '';
      this.queuePanel.style.left = '';
      this.queuePanel.style.width = '';
      const bar = this.root.getBoundingClientRect();
      this.queuePanel.style.right = `${Math.max(12, win.innerWidth - bar.right)}px`;
      this.queuePanel.style.bottom = `${win.innerHeight - bar.top + 10}px`;
    }

    renderQueueLang() {
      const label = t('player.queue');
      this.queueButton.setAttribute('aria-label', label);
      this.queueButton.title = label;
      this.queuePanel.setAttribute('aria-label', label);
      this.queuePanel.querySelector('.queue-title').textContent = label;
      this.queuePanel.querySelector('.queue-clear').textContent = t('player.queueClear');
      this.queuePanel.querySelector('.queue-empty').textContent = t('player.queueEmpty');
      this.renderModes();
      this.renderQueue(true);
    }

    /** 面板打开时重绘列表；队列与播放状态未变时跳过，拖动中不重绘 */
    renderQueue(force = false) {
      if (!this.queuePanel || this.queuePanel.hidden || (this.queueDrag && !force)) return;
      const q = this.queue;
      const upcoming = q ? q.entries.slice(q.pos + 1) : [];
      const key = q ? `${q.pos}|${q.entries.map((e) => e.track).join(',')}` : '';
      if (!force && key === this.queueKey) return;
      this.queueKey = key;
      this.queuePanel.querySelector('.queue-empty').hidden = upcoming.length > 0;
      this.queuePanel.querySelector('.queue-clear').hidden = !upcoming.length;
      const doc = this.root.ownerDocument;
      const list = this.queuePanel.querySelector('.queue-list');
      const focused = doc.activeElement && list.contains(doc.activeElement);
      list.replaceChildren(...upcoming.map((entry, i) => {
        const li = doc.createElement('li');
        li.className = 'queue-item';
        li.classList.toggle('selected', entry === this.queueSelected);
        li.dataset.index = String(q.pos + 1 + i);
        li.tabIndex = 0;
        li.title = t('player.queueHint');
        li.innerHTML = '<span class="queue-art-wrap"><img class="queue-art" alt="" loading="lazy" draggable="false">'
          + `<button class="queue-remove" type="button">${ICON_REMOVE}</button></span>`
          + '<span class="queue-text"><span class="queue-name"></span><span class="queue-artist"></span></span>'
          + `<span class="queue-time"></span><span class="queue-grip" aria-hidden="true">${ICON_GRIP}</span>`;
        const art = li.querySelector('.queue-art');
        if (entry.artwork) art.src = entry.artwork; else art.removeAttribute('src');
        li.querySelector('.queue-name').textContent = entry.name || t('player.unknownTitle');
        li.querySelector('.queue-artist').textContent = entry.artist || '';
        li.querySelector('.queue-time').textContent = entry.duration ? formatTime(entry.duration / 1000) : '';
        const remove = li.querySelector('.queue-remove');
        remove.tabIndex = -1;
        remove.setAttribute('aria-label', t('player.queueRemove', { name: entry.name || '' }));
        remove.title = t('player.queueRemove', { name: entry.name || '' });
        return li;
      }));
      if (focused && !list.contains(doc.activeElement)) this.queueButton.focus();
    }

    /* ---------- 随机播放与重复播放：状态保存在本地，与 Apple Music 相同，开启时按钮反色 ---------- */

    /** 开启随机时打乱当前曲目之后的歌曲并记住原顺序；关闭时从当前曲目在原顺序中的位置继续 */
    setShuffle(on) {
      this.shuffle = on;
      try { localStorage.setItem('am-hook:shuffle', on ? '1' : '0'); } catch {}
      const q = this.queue;
      if (q && on && !q.ordered) {
        q.ordered = q.entries.slice();
        shuffleFrom(q.entries, q.pos + 1);
      } else if (q && !on && q.ordered) {
        const rest = new Set(q.entries.slice(q.pos + 1));
        const at = q.ordered.indexOf(q.entries[q.pos]);
        q.entries.splice(q.pos + 1, Infinity, ...q.ordered.slice(at + 1).filter((entry) => rest.has(entry)));
        q.ordered = null;
      }
      this.renderModes();
      this.renderQueue(true);
      this.prepareNext();
    }

    /** 关 → 全部重复 → 单曲重复 → 关 */
    cycleRepeat() {
      this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
      try { localStorage.setItem('am-hook:repeat', this.repeat); } catch {}
      this.renderModes();
      this.prepareNext();
    }

    /** 播放条与清单标题旁的随机 / 重复按钮，以及上一首 / 下一首是否可用 */
    renderModes() {
      if (!this.queuePanel) return;
      const shuffleLabel = t('player.shuffle');
      const repeatLabel = t(`player.repeat.${this.repeat}`);
      for (const scope of [this.root, this.queuePanel]) {
        for (const btn of scope.querySelectorAll('.player-shuffle')) {
          btn.setAttribute('aria-pressed', String(this.shuffle));
          btn.setAttribute('aria-label', shuffleLabel);
          btn.title = shuffleLabel;
        }
        for (const btn of scope.querySelectorAll('.player-repeat')) {
          btn.setAttribute('aria-pressed', String(this.repeat !== 'off'));
          btn.setAttribute('aria-label', repeatLabel);
          btn.title = repeatLabel;
          if (btn.dataset.mode !== this.repeat) {
            btn.dataset.mode = this.repeat;
            btn.innerHTML = this.repeat === 'one' ? ICON_REPEAT_ONE : ICON_REPEAT;
          }
        }
      }
      const prev = this.$('.skip-prev');
      const next = this.$('.skip-next');
      if (prev) prev.disabled = !this.current;
      if (next) next.disabled = !this.hasNext();
      this.renderAutomix();
    }

    /**
     * 待播清单标题旁的 AutoMix 开关：开启时（AutoMix 或交叉淡化）反色，名称随方式变化；混音进行中时图标流动。
     * 浏览器不能调节 <audio> 音量时（iOS Safari）不显示
     */
    renderAutomix() {
      const button = this.queuePanel && this.queuePanel.querySelector('.queue-automix');
      if (!button) return;
      const mode = playbackSettings().transition || 'off';
      const supported = !!playbackStore && canControlVolume();
      button.hidden = !supported;
      const label = t(mode === 'crossfade' ? 'player.crossfade' : 'player.automix');
      button.querySelector('.queue-automix-label').textContent = label;
      button.setAttribute('aria-pressed', String(mode !== 'off'));
      button.title = t(mode === 'off' ? 'player.automixOff' : 'player.automixOn', { name: label });
      button.classList.toggle('mixing', this.mixer.mixing);
    }

    /** 开关过渡：开启时为 AutoMix（交叉淡化在设置中心选），从下一首起生效 */
    toggleAutomix() {
      if (!playbackStore || !playbackStore.set) return;
      const mode = playbackSettings().transition || 'off';
      playbackStore.set({ transition: mode === 'off' ? 'automix' : 'off' });
      this.renderAutomix();
    }

    hasNext() {
      const q = this.queue;
      return !!this.current && (!!(q && q.entries[q.pos + 1]) || this.repeat === 'all');
    }

    /** 下一首；auto 为播放到结尾时自动切换（单曲重复只在这时生效，手动下一首照常切歌） */
    next(auto = false) {
      if (!this.current) return;
      const q = this.queue;
      if (auto && this.repeat === 'one') { this.restart(); return; }
      // 下一首已接在当前曲目之后时直接跳到接缝处，不重新加载（后台从通知栏切歌也不中断）
      if (this.nextEntry && this.nextEntry === this.upcomingEntry() && this.mse.skipToNext()) return;
      // 过渡已经准备好下一首：手动下一首快速淡过去，播完时直接接上
      if (this.mixer.skip(auto)) return;
      if (q && q.entries[q.pos + 1]) { this.playAt(q.pos + 1); return; }
      if (this.repeat !== 'all') return;
      if (q && q.entries.length > 1) this.playAt(0); else this.restart();
    }

    /** 与 Apple Music 相同：已播放超过 3 秒时回到开头，否则上一首（全部重复时从第一首回到最后一首） */
    previous() {
      if (!this.current) return;
      const q = this.queue;
      const first = !q || q.pos === 0;
      if (this.transport().currentTime > 3 || (first && (this.repeat !== 'all' || !q || q.entries.length < 2))) { this.restart(); return; }
      this.playAt(first ? q.entries.length - 1 : q.pos - 1);
    }

    restart() {
      const transport = this.transport();
      transport.currentTime = 0;
      if (transport.paused) transport.play().catch((err) => this.showError(err.message));
    }

    /** 显示播放条，页面按其高度留出底部空间（通知、错误信息换行时高度会变） */
    show() {
      this.root.hidden = false;
      this.layout();
    }

    /** 播放条上边缘的位置（视口坐标），隐藏或并入歌词界面（不再浮在页面底部）时为 Infinity */
    barTop() {
      return this.root.hidden || this.root.closest('.lyrics-controls') ? Infinity : this.root.getBoundingClientRect().top;
    }

    layout() {
      // 播放错误浮在播放条上方，页面底部同样给它留出空间
      const bar = this.root.getBoundingClientRect();
      const msg = this.$('.player-msg');
      const top = msg.hidden || this.root.closest('.lyrics-controls') ? bar.top : Math.min(bar.top, msg.getBoundingClientRect().top);
      const { body } = this.root.ownerDocument;
      body.style.setProperty('--player-height', `${bar.bottom - top}px`);
      body.classList.toggle('has-player', !this.root.hidden);
      this.placeQueue();
      this.placeQualityPanel();
    }

    /** 页面视图使用的接口：用法与 AmPlayer 相同，视图卸载（signal 中止）时注册的回调随之移除 */
    scope(signal) {
      const player = this;
      const scoped = (set) => (fn) => {
        if (signal.aborted) return;
        set.add(fn);
        signal.addEventListener('abort', () => set.delete(fn), { once: true });
      };
      return {
        get current() { return player.current; },
        get pendingTrack() { return player.pendingTrack; },
        get audio() { return player.audio; },
        transport: () => player.transport(),
        barTop: () => player.barTop(),
        play: (item) => player.play(item),
        playQueue: (entries, pos, options) => player.playQueue(entries, pos, options),
        toggle: () => player.toggle(),
        pause: () => player.pause(),
        onChange: scoped(this.listeners),
        onUnsupported: scoped(this.unsupportedListeners),
      };
    }

    duration() {
      if (this.current && this.current.duration) return this.current.duration;
      return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    }

    /**
     * item: { id, codecs, m3u8Url, label, badge, variant, variants, title, artist, artists, album, href, albumHref, artwork }
     * artists: [{ name, href }]，各位艺人的名字与本站艺人页路径；href / albumHref 为本站歌曲页、专辑页路径；
     * badge 为音质标签（见 qualityBadge）；variant 为所播音质的 master 变体（码率、声道等），variants 为这首歌的全部音质
     * （音质详情里切换用，省略时打开详情再取）；以上均可省略
     * m3u8Url 为 CDN 原始地址（浏览器解密）
     */
    async play(item) {
      // 单独播放另一首歌时结束队列；同一首歌切换音质时保留
      if (this.queue && item.track !== this.queue.entries[this.queue.pos].track) this.clearQueue();
      return this.start(item);
    }

    /**
     * entries：按原顺序排列的曲目（见 resolveEntry）；从 pos 开始，播完一首自动播放下一首。
     * options.shuffle 同时开启 / 关闭随机播放（页面上的「随机播放」「播放」按钮），省略时沿用当前状态。
     * 随机播放时 pos 处的歌曲排在最前，其余打乱；原顺序记在 ordered 中，关闭随机时恢复。
     * options.more：电台这类没有尽头的队列，async () => 下一批条目，剩下不到 2 首时取来接在队尾（见 extendQueue）。
     */
    playQueue(entries, pos = 0, options = {}) {
      if (typeof options.shuffle === 'boolean' && options.shuffle !== this.shuffle) {
        this.shuffle = options.shuffle;
        try { localStorage.setItem('am-hook:shuffle', this.shuffle ? '1' : '0'); } catch {}
      }
      this.queue = { entries, pos, ordered: null, more: options.more || null, extending: false };
      if (this.shuffle) {
        this.queue.ordered = entries.slice();
        entries.unshift(...entries.splice(pos, 1));
        shuffleFrom(entries, 1);
        this.queue.pos = 0;
      }
      return this.playAt(this.queue.pos);
    }

    /** 有 more 的队列（电台）：当前曲目之后不到 2 首时取下一批接在队尾；同时只取一次，取不到时下次换曲再试 */
    extendQueue() {
      const q = this.queue;
      if (!q || !q.more || q.extending || q.entries.length - q.pos > 2) return;
      q.extending = true;
      Promise.resolve()
        .then(() => q.more())
        .then((entries) => {
          if (this.queue !== q || !entries || !entries.length) return;
          q.entries.push(...entries);
          if (q.ordered) q.ordered.push(...entries);
          this.renderQueue(true);
          this.renderModes();
          this.prepareNext();
        })
        .catch((err) => console.warn('[am-hook] 取不到电台的下一批歌曲', err))
        .finally(() => { q.extending = false; });
    }

    clearQueue() {
      this.queue = null;
      this.queueSerial++;
      this.pendingTrack = null;
      this.prepareNext();
    }

    /** 播完当前曲目后要播放的队列条目（与 next(true) 一致）；单曲重复或没有时为 null */
    upcomingEntry() {
      const q = this.queue;
      if (!q || this.repeat === 'one') return null;
      return q.entries[q.pos + 1] || (this.repeat === 'all' && q.entries.length > 1 ? q.entries[0] : null);
    }

    /**
     * 准备当前曲目之后的过渡。队列、随机、重复变化后重新调用；下一首不变时不重复请求。
     * 设置中开启了 AutoMix / 交叉淡化时交给 Mixer（规划为不过渡时它再交回 chainNext），否则无缝接续（chainNext）
     */
    prepareNext() {
      const entry = this.current ? this.upcomingEntry() : null;
      if (this.mixer.wants(entry)) {
        if (this.mixer.entry === entry) return;
        this.chainNext(null);
        this.mixer.prepare(entry);
        return;
      }
      this.mixer.cancel();
      this.chainNext(entry);
    }

    /**
     * 同一张专辑按顺序播放的下一首：专辑里的衔接是编排好的（连在一起的曲目、现场专辑、古典的乐章），不做过渡。
     * 随机播放、歌单与电台里恰好相邻的同专辑曲目照常过渡
     */
    continuous(entry) {
      const q = this.queue;
      if (!q || this.shuffle || !entry || q.entries[q.pos + 1] !== entry) return false;
      const album = global.AmAutomix ? global.AmAutomix.albumOf(q.entries[q.pos]) : '';
      return !!album && album === global.AmAutomix.albumOf(entry);
    }

    /**
     * 与 music.apple.com 相同，提前解析下一首并交给 MseEngine，在当前曲目之后无缝接上（entry 为 null 时放弃接续）。
     * 只有 MSE / FLAC 方式能接续，其他情况仍由 ended 事件按原方式切歌。
     */
    chainNext(upcoming) {
      const entry = this.current && isElementMode(this.current.mode) && this.mse.sb ? upcoming : null;
      if (entry && entry === this.nextEntry) return;
      const serial = ++this.nextSerial;
      clearTimeout(this.nextRetry);
      this.nextEntry = entry;
      this.mse.setNext(null);
      // 准备期间当前曲目不结束（见 MseEngine.pump），数据断档时停在接缝处等待
      this.mse.expectNext = !!entry;
      const giveUp = () => {
        this.nextEntry = null;
        this.mse.expectNext = false;
        this.mse.pump(this.mse.generation); // 没有可接续的下一首：照常结束，由 ended 切歌
      };
      if (!entry) { giveUp(); return; }
      resolveEntry(entry)
        .then((item) => {
          if (serial !== this.nextSerial) return null;
          const mode = detectMode(item.codecs);
          return this.mse.setNext({ ...item, mode });
        })
        .then((chained) => { if (serial === this.nextSerial && !chained) giveUp(); })
        .catch((err) => {
          if (serial !== this.nextSerial) return;
          // 网络错误（fetch 抛出 TypeError）稍后重试；歌曲不可播放等其他错误放弃接续
          if (!(err instanceof TypeError)) { giveUp(); return; }
          this.nextRetry = setTimeout(() => {
            if (serial !== this.nextSerial) return;
            this.nextEntry = null;
            // Mixer 交回来的（规划为不过渡）：直接重试接续，prepareNext 会因 Mixer 已有这首而跳过
            if (this.mixer.entry === entry) this.chainNext(entry); else this.prepareNext();
          }, 3000);
        });
    }

    /** MseEngine 播放到下一首（接缝处或 skipToNext）：更新队列位置与曲目信息，再准备之后的一首 */
    advance(item) {
      const q = this.queue;
      const pos = q ? q.entries.indexOf(this.nextEntry) : -1;
      if (pos >= 0) q.pos = pos;
      this.nextEntry = null;
      this.queueSerial++;
      this.pendingTrack = null;
      this.current = { ...item, duration: this.mse.playlist.duration };
      this.applyVolume();
      this.showError('');
      this.renderTrackText();
      this.renderArtwork(item);
      this.renderMode();
      this.updateMediaSession();
      this.renderToggle();
      this.renderProgress();
      this.emit();
      this.prepareNext();
      this.extendQueue();
    }

    async playAt(pos) {
      const entry = this.queue.entries[pos];
      this.queue.pos = pos;
      this.extendQueue();
      const serial = ++this.queueSerial;
      this.pendingTrack = entry.track;
      this.emit();
      try {
        const item = await resolveEntry(entry);
        if (serial !== this.queueSerial) return;
        this.pendingTrack = null;
        await this.start(item);
      } catch (err) {
        if (serial !== this.queueSerial) return;
        this.pendingTrack = null;
        this.showError(() => (err.noPlayable ? err.message : t('album.trackFailed', { name: entry.name, msg: err.message })));
      }
      this.emit();
    }

    /** options.force：同一首同一音质也重新开始（JOC 设置变化后换播放方式，见 replay） */
    async start(item, { force = false } = {}) {
      if (!force && this.current && this.current.id === item.id) { this.toggle(); return; }
      this.jocMode = jocSettings().mode;
      this.jocStale = false;
      this.jocFallback = false;
      const modes = detectModes(item.codecs);
      if (!modes.length) {
        this.showError(() => t('player.errorCodec', { codecs: item.codecs, hint: fallbackHint() }));
        return;
      }
      const token = ++this.playToken;
      // 同一首歌切换音质时从当前位置继续；专辑页换曲（track 不同）从头播放
      const resumeAt = this.current && this.current.track === item.track ? this.transport().currentTime : 0;
      this.current = { ...item, mode: modes[0], duration: 0 };
      this.applyVolume();
      this.show();
      this.showError('');
      this.renderTrackText();
      this.renderArtwork(item);
      this.setLoading(true);
      this.emit();
      this.updateMediaSession();

      // 依次尝试各播放方式，前一种因编码/格式不支持失败时自动换下一种
      let lastError = null;
      for (const mode of modes) {
        if (token !== this.playToken) return;
        this.current.mode = mode;
        this.current.duration = 0;
        this.renderMode();
        this.attempting = true;
        try {
          await this.tryMode(mode, item, resumeAt, token);
          this.attempting = false;
          this.renderProgress();
          if (token === this.playToken) {
            this.nextEntry = null; // 新的 MediaSource 上还没有接任何曲目
            this.prepareNext();
          }
          return;
        } catch (err) {
          this.attempting = false;
          if (token !== this.playToken) return;
          if (err && err.name === 'NotAllowedError') {
            this.setLoading(false);
            this.showError(() => t('player.errorAutoplay'));
            return;
          }
          lastError = err;
          // 双耳不可用时退回 Speaker 2.0，音质详情里说明原因
          if (mode === 'jocbin') this.jocFallback = true;
          console.warn(`[am-hook] ${mode} 播放失败，尝试下一种方式`, err);
        }
      }

      this.teardown();
      failedCodecs.add(item.codecs);
      this.unsupportedListeners.forEach((fn) => fn(item.codecs));
      const detail = lastError && lastError.message ? ` (${lastError.message})` : '';
      this.showError(() => t('player.errorFailed', { label: item.label || item.codecs, codecs: item.codecs, hint: fallbackHint() }) + detail);
      this.emit();
    }

    teardown() {
      // 过渡中的另一首（淡出中的上一首、准备中的下一首）一起停掉
      this.mixer.reset();
      this.mixGain = 1;
      this.mse.destroy();
      if (this.pcm) { this.pcm.destroy(); this.pcm = null; }
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.audio.playbackRate = 1;
    }

    /**
     * 新建 PCM 引擎（EC-3 / JOC），回调只在它是当前引擎时生效（过渡中另一首的引擎不影响播放条）。
     * JOC 的交互控制：同一首歌沿用当前的，换歌时增益、独奏与静音重新开始（成为当前曲目时才交给声场界面，见 adoptVoice）
     */
    createPcm(mode, item) {
      let engine = null;
      const current = (fn) => (...args) => { if (this.pcm === engine) return fn(...args); };
      const onUpdate = current(() => this.updatePcm());
      const onError = current((err) => this.showError(err.message || String(err)));
      const onEnded = current(() => this.ended());
      if (mode === 'ec3') engine = new PcmEngine(onUpdate, onError, onEnded);
      else {
        const joc = jocSettings();
        const controls = this.spatial.track === item.track ? this.spatial
          : { ...this.spatial, track: item.track, gains: new Array(16).fill(1), solo: [], mute: [] };
        engine = new JocLiveEngine(onUpdate, onError, onEnded, {
          mode: mode === 'jocbin' ? 'binaural' : 'speaker',
          gainDb: joc.gain,
          dataset: joc.dataset,
          controls,
          onClip: current(() => this.showError(() => t('player.jocClip'))),
        });
      }
      engine.onRecover = current(() => this.showError(''));
      engine.onRetry = current(() => this.renderError());
      return engine;
    }

    /** JOC 引擎成为当前引擎：声场界面改用这首歌的交互控制 */
    useSpatialOf(engine) {
      if (!(engine instanceof JocEngine) || engine.controls === this.spatial) return;
      this.spatial = engine.controls;
      this.emitSpatial();
    }

    async tryMode(mode, item, resumeAt, token) {
      this.teardown();
      if (isPcmMode(mode)) {
        this.pcm = this.createPcm(mode, item);
        this.useSpatialOf(this.pcm);
        this.pcm.gain.gain.value = this.volume;
        await this.pcm.load(item.m3u8Url);
        if (token !== this.playToken) return;
        this.current.duration = this.pcm.duration;
        if (resumeAt > 0) await this.pcm.seek(resumeAt);
        await this.pcm.play();
        return;
      }
      this.mse.onRecover = () => this.showError('');
      this.mse.onRetry = () => this.renderError();
      await this.mse.load(item.m3u8Url, item.codecs, (err) => this.showError(err.message || String(err)), mode === 'flac');
      if (token !== this.playToken) return;
      this.current.duration = this.mse.playlist ? this.mse.playlist.duration : 0;
      if (resumeAt > 0) this.audio.currentTime = resumeAt;
      await this.audio.play();
    }

    /* ---------- 过渡（Mixer）：准备下一首、摘下上一首、接上下一首 ---------- */

    /**
     * 在当前曲目之外准备 item（mode 方式），停在 at 秒处、音量为 0；返回 Voice。
     * <audio> 方式用空闲的 deck（claimDeck），PCM 方式新建引擎。失败时释放并抛出
     */
    async prerollVoice(item, mode, at) {
      if (isPcmMode(mode)) {
        const engine = this.createPcm(mode, item);
        engine.gain.gain.value = 0;
        try {
          await engine.load(item.m3u8Url);
          if (at > 0) await engine.seek(at, false);
        } catch (err) {
          engine.destroy();
          throw err;
        }
        return new Voice(this, item, mode, { engine });
      }
      const deck = this.claimDeck();
      const { audio, mse } = deck;
      audio.volume = 0;
      audio.playbackRate = 1;
      const current = (fn) => (...args) => { if (this.mse === mse) fn(...args); };
      mse.onRecover = current(() => this.showError(''));
      mse.onRetry = current(() => this.renderError());
      try {
        await mse.load(item.m3u8Url, item.codecs, current((err) => this.showError(err.message || String(err))), mode === 'flac');
        if (!mse.playlist) throw new DOMException('stale', 'AbortError');
        if (at > 0) audio.currentTime = at;
      } catch (err) {
        this.releaseDeck(deck);
        throw err;
      }
      return new Voice(this, item, mode, { deck });
    }

    /** 当前曲目从播放条上摘下，交给 Mixer 淡出：之后它的事件与回调不再影响播放条。没有在播放的曲目时为 null */
    detachVoice() {
      const c = this.current;
      if (!c) return null;
      if (isPcmMode(c.mode)) {
        const engine = this.pcm;
        if (!engine) return null;
        this.pcm = null;
        return new Voice(this, c, c.mode, { engine });
      }
      if (!this.mse.playlist) return null;
      this.mse.setNext(null);
      return new Voice(this, c, c.mode, { deck: this.deck });
    }

    /** 过渡开始：准备好的下一首（voice）成为当前曲目，与 advance 一样更新队列位置与曲目信息 */
    adoptVoice(entry, item, mode, voice) {
      this.playToken++;
      if (voice.deck) this.useDeck(voice.deck);
      else {
        // 上一首的 <audio> 正在淡出：当前 deck 换成空闲的，那边的事件（如 ended）不再影响播放条
        if (this.deck.voice) this.useDeck(this.idleDeck());
        this.pcm = voice.engine;
        this.useSpatialOf(voice.engine);
      }
      const q = this.queue;
      const pos = q ? q.entries.indexOf(entry) : -1;
      if (pos >= 0) q.pos = pos;
      this.nextEntry = null;
      this.queueSerial++;
      this.pendingTrack = null;
      this.jocMode = jocSettings().mode;
      this.jocStale = false;
      this.jocFallback = isEc3(item.codecs) && jocSettings().mode === 'binaural' && mode !== 'jocbin';
      this.current = { ...item, mode, duration: voice.duration };
      this.applyVolume();
      this.showError('');
      this.renderTrackText();
      this.renderArtwork(item);
      this.renderMode();
      this.updateMediaSession();
      this.renderToggle();
      this.renderProgress();
      this.emit();
      this.prepareNext();
      this.extendQueue();
    }

    /** voice 是否就是当前曲目 */
    isCurrentVoice(voice) {
      return voice.deck ? this.deck === voice.deck && isElementMode(this.current && this.current.mode)
        : !!voice.engine && this.pcm === voice.engine;
    }

    /** 某编码经实际尝试确认无法播放时回调 */
    onUnsupported(fn) { this.unsupportedListeners.add(fn); }

    /** 当前曲目播放到结尾（audio 与 EC-3 PCM 两种方式）：按重复模式播放下一首或重新播放 */
    ended() { if (this.current) this.next(true); }

    toggle() {
      if (!this.current) return;
      const transport = this.transport();
      // 暂停时改了 JOC 设置：按新的播放方式从当前位置开始
      if (this.jocStale && transport.paused) { this.replay(); return; }
      if (transport.paused) transport.play().catch((err) => this.showError(err.message)); else transport.pause();
    }

    /** 其他媒体（如 MV）开始播放时暂停 */
    pause() {
      if (this.current && !this.transport().paused) this.transport().pause();
    }

    seekBy(delta) {
      const d = this.duration();
      if (!d) return;
      const transport = this.transport();
      transport.currentTime = Math.min(Math.max(0, transport.currentTime + delta), d - 0.1);
    }

    setLoading(on) {
      this.loading = on;
      this.renderToggle();
    }

    renderToggle() {
      const a = this.transport();
      const waiting = this.loading && a.paused || (!a.paused && !isPcmMode(this.current.mode) && a.readyState < 3);
      if (!a.paused) this.loading = false;
      const btn = this.$('.player-toggle');
      btn.innerHTML = waiting ? ICON_LOADING : (a.paused ? ICON_PLAY : ICON_PAUSE);
      // 全屏播放界面按它换成 AMLL 的图标（见 app.css）
      btn.dataset.state = waiting ? 'loading' : (a.paused ? 'play' : 'pause');
      btn.setAttribute('aria-label', t(a.paused ? 'player.play' : 'player.pause'));
    }

    renderProgress() {
      const d = this.duration();
      const transport = this.transport();
      const t = this.dragRatio !== undefined ? this.dragRatio * d : transport.currentTime;
      const ratio = d ? Math.min(1, t / d) : 0;
      this.$('.seek-fill').style.width = `${ratio * 100}%`;
      this.$('.seek-thumb').style.left = `${ratio * 100}%`;
      let bufEnd = 0;
      if (this.current && isPcmMode(this.current.mode) && this.pcm) {
        bufEnd = this.pcm.loadedUntil;
      } else {
        const b = this.audio.buffered;
        const now = this.audio.currentTime;
        for (let i = 0; i < b.length; i++) {
          if (b.start(i) <= now + 0.5) bufEnd = Math.max(bufEnd, b.end(i) - (now - transport.currentTime));
        }
      }
      this.$('.seek-buffer').style.width = `${d ? Math.min(1, bufEnd / d) * 100 : 0}%`;
      this.$('.time-cur').textContent = formatTime(t);
      // showRemaining：右侧显示剩余时间（全屏播放界面里点总时长切换，见 lyrics/panel.mjs）
      this.$('.time-total').textContent = this.showRemaining && d ? `-${formatTime(d - Math.min(t, d))}` : formatTime(d);
      const seek = this.$('.seek');
      seek.setAttribute('aria-valuemax', String(Math.round(d)));
      seek.setAttribute('aria-valuenow', String(Math.round(t)));
      seek.setAttribute('aria-valuetext', `${formatTime(t)} / ${formatTime(d)}`);
      if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) {
        try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(transport.currentTime, d), playbackRate: 1 }); } catch {}
      }
    }

    updateMediaSession() {
      if (!('mediaSession' in navigator) || !global.MediaMetadata) return;
      const source = this.current.artwork || '';
      if (source !== this.mediaArtSource) {
        if (this.mediaArtController) this.mediaArtController.abort();
        if (this.mediaArtUrl) URL.revokeObjectURL(this.mediaArtUrl);
        this.mediaArtSource = source;
        this.mediaArtController = this.mediaArtUrl = this.mediaArtType = null;
        if (source) {
          // Reuse one local image for every quality of the same song.
          const controller = new AbortController();
          this.mediaArtController = controller;
          fetch(source, { signal: controller.signal, cache: 'force-cache' })
            .then((response) => {
              if (!response.ok) throw new Error(`Artwork HTTP ${response.status}`);
              return response.blob();
            })
            .then((blob) => {
              if (controller.signal.aborted || this.mediaArtSource !== source) return;
              this.mediaArtUrl = URL.createObjectURL(blob);
              this.mediaArtType = blob.type || 'image/jpeg';
              this.writeMediaMetadata();
            })
            .catch(() => {}); // The player bar still displays the original image.
        }
      }
      this.writeMediaMetadata();
    }

    writeMediaMetadata() {
      const c = this.current;
      const state = {
        title: c.title || '',
        artist: c.artist || '',
        album: c.album || '',
        artwork: this.mediaArtUrl || '',
      };
      const previous = this.mediaMetadataState;
      if (previous && Object.keys(state).every((key) => state[key] === previous[key])) return;
      this.mediaMetadataState = state;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: state.title,
        artist: state.artist,
        album: state.album,
        artwork: this.mediaArtUrl
          ? [{ src: this.mediaArtUrl, sizes: '600x600', type: this.mediaArtType }]
          : [],
      });
    }

    /** msg 可以是函数，切换语言时重新求值 */
    showError(msg) {
      this.errorMsg = msg || null;
      this.renderError();
      if (msg) {
        this.show();
        this.setLoading(false);
      }
    }

    renderError() {
      const el = this.$('.player-msg');
      const msg = this.errorMsg;
      el.textContent = typeof msg === 'function' ? msg() : (msg || '');
      // 分段加载失败（MseEngine / PcmEngine 自动重试中或已停止）：错误后面显示重试状态与「立即重试」
      const engine = this.pcm || this.mse;
      const retrying = !!msg && engine.failed;
      clearInterval(this.retryTick);
      if (retrying) {
        const status = document.createElement('span');
        status.className = 'player-retry-status';
        el.append(' ', status);
        const update = () => {
          const { retryAt, gaveUp } = engine;
          status.textContent = gaveUp ? t('player.retryStopped')
            : retryAt ? t('player.retryIn', { s: Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)) })
            : t('player.retrying');
        };
        update();
        if (engine.retryAt) this.retryTick = setInterval(update, 1000);
        if (engine.retryAt || engine.gaveUp) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'player-retry';
          button.textContent = t('player.retryNow');
          button.addEventListener('click', () => engine.retryNow());
          el.append(' ', button);
        }
      }
      el.hidden = !msg;
      this.layout();
    }
  }

  const api = { AmPlayer, Marquee, artistNodes, qualityBadge, qualityIcon, segmentAt, formatTime, detectMode, detectModes, mimeFor, useJocSettings, usePlaybackSettings };
  if (typeof module !== 'undefined' && module.exports) module.exports = { ...api, MseEngine, PcmEngine, JocEngine, JocLiveEngine, Mixer, Voice, sortVariants, pickPlayable };
  else global.AmHook = api;
})(typeof window !== 'undefined' ? window : globalThis);

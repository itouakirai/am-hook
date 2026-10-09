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
   * 该编码在当前浏览器中可尝试的播放方式（按优先级），空数组表示不支持。
   * 全部由浏览器端解密；EC-3 按 MSE -> PCM 检测，ALAC 可回退为 FLAC。
   */
  function detectModes(codecs) {
    if (failedCodecs.has(codecs)) return [];
    const mime = mimeFor(codecs);
    const modes = [];
    const decrypt = global.AmDecrypt && global.AmDecrypt.supported();
    const MS = global.ManagedMediaSource || global.MediaSource;
    if (MS && MS.isTypeSupported && MS.isTypeSupported(mime) && decrypt) modes.push('mse');
    if (/^(ec-3|ec3)$/i.test(String(codecs))) {
      if (decrypt && global.Worker && global.WebAssembly &&
          (global.AudioContext || global.webkitAudioContext)) modes.push('ec3');
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

  function modeLabel(mode) {
    return mode === 'ec3' ? t('player.pcmMode') : mode.toUpperCase();
  }

  /* ---------- 播放队列的曲目：逐首解析 master，选浏览器能播放的最高音质 ---------- */
  function rankVariant(v) {
    const g = v.group_id.toLowerCase();
    return g.includes('alac') ? 0 : g.includes('atmos') ? 1 : g.includes('he-') ? 3 : 2;
  }

  function variantLabel(v) {
    const g = v.group_id.toLowerCase();
    if (g.includes('alac')) {
      const spec = [v.bit_depth && `${v.bit_depth}-bit`, v.sample_rate && `${(v.sample_rate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`].filter(Boolean).join(' / ');
      return `ALAC${spec ? ' · ' + spec : ''}`;
    }
    if (g.includes('atmos')) return 'Dolby Atmos';
    const kbps = Number((g.match(/stereo-(\d+)/) || [])[1]) || 0;
    return `${g.includes('he-') ? 'HE-AAC' : 'AAC'}${kbps ? ' · ' + kbps + ' kbps' : ''}`;
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

  async function resolveEntry(entry) {
    const { variants } = await global.AmWrapper.songMaster(entry.track);
    const best = variants
      .map((v) => ({ ...v, mode: detectMode(v.codecs) }))
      .filter((v) => v.mode)
      .sort((a, b) => rankVariant(a) - rankVariant(b) || (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    if (!best) throw Object.assign(new Error(t('album.noPlayable', { name: entry.name })), { noPlayable: true });
    return {
      id: `${entry.track}:${best.group_id}`,
      track: entry.track,
      country: entry.country,
      codecs: best.codecs,
      m3u8Url: best.url,
      label: variantLabel(best),
      badge: qualityBadge(best),
      title: entry.name,
      artist: entry.artist,
      artists: entry.artists,
      album: entry.album,
      href: entry.href,
      albumHref: entry.albumHref,
      artwork: entry.artwork,
    };
  }

  class FlacTranscoder {
    constructor() {
      this.worker = new Worker('/assets/flac-transcode-worker.js');
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
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, op, buf }, [buf]);
      });
    }

    destroy() {
      this.worker.terminate();
      for (const job of this.pending.values()) job.reject(new DOMException('stale', 'AbortError'));
      this.pending.clear();
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

  /** Bounded, on-demand multichannel PCM playback for EC-3. */
  class PcmEngine {
    constructor(onUpdate, onError, onEnded) {
      this.onUpdate = onUpdate;
      this.onError = onError;
      this.onEnded = onEnded;
      this.context = new (global.AudioContext || global.webkitAudioContext)();
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      this.nodes = new Set();
      this.paused = true;
      this.anchorTime = 0;
      this.anchorContextTime = this.context.currentTime + 0.03;
      this.loadedUntil = 0;
      this.generation = 0;
      this.timer = setInterval(() => {
        if (!this.paused && this.duration && this.currentTime >= this.duration) {
          this.pause();
          if (this.onEnded) this.onEnded();
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
      if (this.busy || this.failed || !this.playlist || !this.decoder) return;
      this.busy = true;
      const gen = this.generation;
      const required = first;
      try {
        const { segments } = this.playlist;
        while (this.nextIndex < segments.length && (first || segments[this.nextIndex].time < this.currentTime + 12)) {
          const seg = segments[this.nextIndex];
          const encrypted = await this.playlist.load(seg, this.controller.signal);
          if (gen !== this.generation) return;
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
            node.connect(this.gain);
            node.onended = () => { this.nodes.delete(node); node.disconnect(); };
            this.nodes.add(node);
            const when = Math.max(this.context.currentTime + 0.01,
              this.anchorContextTime + chunkTime - this.anchorTime);
            node.start(when, offset);
          }
          this.loadedUntil = Math.max(this.loadedUntil, seg.time + samples / rate);
          this.nextIndex++;
          first = false;
          this.onUpdate();
          if (required) break;
        }
      } catch (error) {
        if (required && gen === this.generation) throw error;
        if (error.name !== 'AbortError' && gen === this.generation) {
          this.failed = true;
          this.pause();
          this.onError(error);
        }
      } finally {
        this.busy = false;
      }
    }

    async play() {
      if (this.seeking) { this.resumeAfterSeek = true; return this.seekTask; }
      this.failed = false;
      await this.context.resume();
      this.paused = false;
      this.onUpdate();
      this.pump();
    }

    pause() {
      if (this.seeking) { this.resumeAfterSeek = false; return; }
      if (this.paused) return;
      this.anchorTime = this.currentTime;
      this.anchorContextTime = this.context.currentTime;
      this.paused = true;
      this.context.suspend();
      this.onUpdate();
    }

    seek(time) {
      if (!this.playlist) return;
      this.generation++;
      const gen = this.generation;
      this.failed = false;
      this.resumeAfterSeek = !this.paused || (this.seeking && this.resumeAfterSeek);
      this.seeking = true;
      this.paused = true;
      for (const node of this.nodes) { try { node.stop(); } catch {} node.disconnect(); }
      this.nodes.clear();
      this.anchorTime = Math.max(0, Math.min(time, this.duration));
      this.anchorContextTime = this.context.currentTime + 0.03;
      this.loadedUntil = this.anchorTime;
      this.nextIndex = segmentAt(this.playlist.segments, this.anchorTime);
      this.onUpdate();
      const task = (async () => {
        await this.context.suspend();
        while (this.busy && gen === this.generation) await new Promise((resolve) => setTimeout(resolve, 10));
        if (gen !== this.generation) return;
        await this.decoder.flush();
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
        if (gen === this.generation && error.name !== 'AbortError') {
          this.failed = true;
          this.onError(error);
        }
        throw error;
      })
        .finally(() => { if (gen === this.generation) { this.seeking = false; this.seekTask = null; } });
      this.seekTask = task;
      return task;
    }

    destroy() {
      this.generation++;
      clearInterval(this.timer);
      if (this.controller) this.controller.abort();
      if (this.decoder) this.decoder.destroy();
      for (const node of this.nodes) { try { node.stop(); } catch {} node.disconnect(); }
      this.nodes.clear();
      this.context.close();
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
        if (this.failed) {
          this.failed = false;
          if (this.onRecover) this.onRecover();
        }
      } catch (err) {
        if (pumpSerial === this.pumpSerial && (!err || err.name !== 'AbortError')) {
          this.busy = false;
          // 网络中断等错误：提示后继续重试，不让缓冲耗尽后一直卡住
          if (!this.failed && this.onError) this.onError(err);
          this.failed = true;
          clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => this.pump(gen), 3000);
          return;
        }
      }
      if (pumpSerial === this.pumpSerial) {
        this.busy = false;
        if (!waitForPlayback && gen === this.generation) this.pump(gen);
      }
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

  const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  const ICON_LOADING = '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';
  const ICON_QUEUE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h11M4 11h11M4 16h7"/><path d="M16 14.5v5.5"/><circle cx="14" cy="20" r="2"/><path d="M16 14.5 20 13"/></svg>';
  const ICON_GRIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 8h14M5 12h14M5 16h14"/></svg>';
  const ICON_REMOVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M7 12h10"/></svg>';
  const ICON_SHUFFLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h3c2.2 0 3.4 1 4.5 2.8l3 4.4C14.6 16 15.8 17 18 17h2.5"/><path d="M3 17h3c1.6 0 2.7-.6 3.6-1.6M14.4 8.6C15.3 7.6 16.4 7 18 7h2.5"/><path d="m18 4 3 3-3 3M18 14l3 3-3 3"/></svg>';
  const ICON_REPEAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12V9.5A3.5 3.5 0 0 1 7.5 6H20"/><path d="m17 3 3 3-3 3"/><path d="M20 12v2.5a3.5 3.5 0 0 1-3.5 3.5H4"/><path d="m7 21-3-3 3-3"/></svg>';
  const ICON_REPEAT_ONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12V9.5A3.5 3.5 0 0 1 7.5 6H20"/><path d="m17 3 3 3-3 3"/><path d="M20 12v2.5a3.5 3.5 0 0 1-3.5 3.5H4"/><path d="m7 21-3-3 3-3"/><path d="M11 10.5 12.5 9.5v5" stroke-width="1.8"/></svg>';

  /**
   * 页面底部播放条。
   * 与 music.apple.com 相同，整站是单页应用（app.html），播放条只有一个实例并常驻；
   * 各页面视图经 scope() 使用它，站内跳转时播放不中断。
   */
  class AmPlayer {
    /** 播放条上的歌名、艺人、专辑链接由前端路由（app.mjs）接管，文档不刷新，播放不中断 */
    constructor(root) {
      this.root = root;
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.mse = new MseEngine(this.audio);
      this.mse.onTrackChange = (item) => this.advance(item);
      this.clock = new AudioClock(this.audio, () => (this.current && (this.current.mode === 'mse' || this.current.mode === 'flac') ? this.mse.base : 0));
      /** 已交给 MseEngine 接续播放的下一首在队列中的条目（见 prepareNext） */
      this.nextEntry = null;
      this.nextSerial = 0;
      this.pcm = null;
      this.$ = (sel) => root.querySelector(sel);
      // 歌名、「艺人 — 专辑」两行滚动字幕；音质标签在歌名右侧，不参与滚动
      const title = this.$('.player-title');
      const titleHost = Object.assign(root.ownerDocument.createElement('span'), { className: 'marquee marquee--primary' });
      this.quality = Object.assign(root.ownerDocument.createElement('span'), { className: 'player-quality', hidden: true });
      title.replaceChildren(titleHost, this.quality);
      this.titleMarquee = new Marquee(titleHost);
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
      try {
        const v = parseFloat(localStorage.getItem('am-hook:volume'));
        if (v >= 0 && v <= 1) this.audio.volume = v;
      } catch {}
      this.$('.volume').value = this.audio.volume;
      if (global.AmI18n) global.AmI18n.onChange(() => this.renderLang());
    }

    /** 切换界面语言后重绘播放条上的文字 */
    renderLang() {
      this.renderToggle();
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
      // 音质标志（Lossless / Hi-Res Lossless / Dolby Atmos / Spatial Audio / AAC），具体规格放在悬停提示里
      const icon = qualityIcon(c.badge, doc);
      if (icon) icon.removeAttribute('title');
      this.quality.replaceChildren(...(icon ? [icon] : []));
      this.quality.title = c.label || '';
      this.quality.hidden = !icon;
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

    renderMode() {
      if (!this.current) return;
      const ec3 = this.current.mode === 'ec3';
      const channels = this.pcm && this.pcm.channels;
      this.$('.player-mode').textContent = ec3 && channels
        ? t('player.pcmChannels', { n: channels - 1 }) : modeLabel(this.current.mode);
      const notice = this.$('.player-notice');
      const noticeKey = ec3 ? 'player.pcmNotice'
        : this.current.mode === 'flac' ? 'player.flacNotice' : null;
      notice.textContent = noticeKey ? t(noticeKey) : '';
      notice.hidden = !noticeKey;
    }

    transport() { return this.current && this.current.mode === 'ec3' && this.pcm ? this.pcm : this.clock; }

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

    bindUi() {
      const a = this.audio;
      this.$('.player-toggle').addEventListener('click', () => this.toggle());
      this.$('.skip-prev').addEventListener('click', () => this.previous());
      this.$('.skip-next').addEventListener('click', () => this.next());
      this.$('.player-shuffle').addEventListener('click', () => this.setShuffle(!this.shuffle));
      this.$('.player-repeat').addEventListener('click', () => this.cycleRepeat());
      this.$('.volume').addEventListener('input', (e) => {
        a.volume = Number(e.target.value);
        if (this.pcm) this.pcm.gain.gain.value = a.volume;
        try { localStorage.setItem('am-hook:volume', String(a.volume)); } catch {}
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

      ['timeupdate', 'progress', 'durationchange', 'loadedmetadata'].forEach((ev) => a.addEventListener(ev, () => this.renderProgress()));
      ['play', 'pause', 'playing', 'waiting', 'ended'].forEach((ev) => a.addEventListener(ev, () => { this.renderToggle(); this.emit(); }));
      a.addEventListener('ended', () => this.ended());
      a.addEventListener('error', () => {
        // 尝试阶段的错误由 play() 统一处理（会自动换下一种播放方式）
        if (!this.attempting && this.current && this.current.mode !== 'mse' && this.audio.getAttribute('src')) {
          this.showError(() => t('player.errorGeneric', { hint: fallbackHint() }));
        }
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
      // 待播清单面板：按 Esc 或点击面板与播放条以外的地方时收起
      doc.addEventListener('pointerdown', (e) => {
        if (this.queuePanel.hidden || this.queuePanel.contains(e.target) || this.root.contains(e.target)) return;
        this.closeQueue();
      });
      doc.addEventListener('keydown', (e) => {
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
      this.$('.player-right').insertBefore(button, this.$('.player-mode'));

      const panel = doc.createElement('section');
      panel.className = 'queue-panel';
      panel.id = 'queue-panel';
      panel.hidden = true;
      panel.innerHTML = '<header class="queue-head"><h2 class="queue-title"></h2>'
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
      panel.querySelector('.queue-clear').addEventListener('click', () => {
        if (this.queue) {
          this.queue.entries.splice(this.queue.pos + 1);
          if (this.queue.ordered) this.queue.ordered = this.queue.entries.slice();
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
      this.queuePanel.style.top = '';
      this.root.ownerDocument.querySelector('.lyrics-overlay.queue-open')?.classList.remove('queue-open');
      this.queueButton.setAttribute('aria-expanded', 'false');
      this.queueSelected = null;
      if (refocus) this.queueButton.focus();
    }

    /**
     * 面板右边缘与播放条对齐，底部在播放条上方；播放条隐藏时收起。
     * 播放条并入歌词界面时：手机上（界面里有待播清单开关）同 music.apple.com，清单占据标题行以下、控件以上的区域
     * （.queue-open / .in-lyrics 的样式见 app.css）；桌面的歌词界面没有这个开关，收起。
     */
    placeQueue() {
      if (this.queuePanel.hidden) return;
      const host = this.root.closest('.lyrics-overlay');
      if (this.root.hidden || (host && !this.queueButton.offsetParent)) { this.closeQueue(); return; }
      const win = this.root.ownerDocument.defaultView;
      this.queuePanel.classList.toggle('in-lyrics', !!host);
      if (host) {
        host.classList.add('queue-open');
        this.queuePanel.style.right = '0px';
        this.queuePanel.style.top = `${host.querySelector('.lyrics-side').getBoundingClientRect().bottom}px`;
        this.queuePanel.style.bottom = `${win.innerHeight - this.root.getBoundingClientRect().top}px`;
        return;
      }
      this.queuePanel.style.top = '';
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
      const height = `${this.root.getBoundingClientRect().height}px`;
      const { body } = this.root.ownerDocument;
      body.style.setProperty('--player-height', height);
      body.classList.toggle('has-player', !this.root.hidden);
      this.placeQueue();
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
     * item: { id, codecs, m3u8Url, label, badge, title, artist, artists, album, href, albumHref, artwork }
     * artists: [{ name, href }]，各位艺人的名字与本站艺人页路径；href / albumHref 为本站歌曲页、专辑页路径；
     * badge 为音质标签（见 qualityBadge）；以上均可省略
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
     */
    playQueue(entries, pos = 0, options = {}) {
      if (typeof options.shuffle === 'boolean' && options.shuffle !== this.shuffle) {
        this.shuffle = options.shuffle;
        try { localStorage.setItem('am-hook:shuffle', this.shuffle ? '1' : '0'); } catch {}
      }
      this.queue = { entries, pos, ordered: null };
      if (this.shuffle) {
        this.queue.ordered = entries.slice();
        entries.unshift(...entries.splice(pos, 1));
        shuffleFrom(entries, 1);
        this.queue.pos = 0;
      }
      return this.playAt(this.queue.pos);
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
     * 与 music.apple.com 相同，提前解析下一首并交给 MseEngine，在当前曲目之后无缝接上。
     * 队列、随机、重复变化后重新调用；下一首不变时不重复请求。只有 MSE / FLAC 方式能接续，
     * 其他情况仍由 ended 事件按原方式切歌。
     */
    prepareNext() {
      const entry = this.current && (this.current.mode === 'mse' || this.current.mode === 'flac') && this.mse.sb
        ? this.upcomingEntry() : null;
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
            this.prepareNext();
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
      this.showError('');
      this.renderTrackText();
      this.renderArtwork(item);
      this.renderMode();
      this.updateMediaSession();
      this.renderToggle();
      this.renderProgress();
      this.emit();
      this.prepareNext();
    }

    async playAt(pos) {
      const entry = this.queue.entries[pos];
      this.queue.pos = pos;
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

    async start(item) {
      if (this.current && this.current.id === item.id) { this.toggle(); return; }
      const modes = detectModes(item.codecs);
      if (!modes.length) {
        this.showError(() => t('player.errorCodec', { codecs: item.codecs, hint: fallbackHint() }));
        return;
      }
      const token = ++this.playToken;
      // 同一首歌切换音质时从当前位置继续；专辑页换曲（track 不同）从头播放
      const resumeAt = this.current && this.current.track === item.track ? this.transport().currentTime : 0;
      this.current = { ...item, mode: modes[0], duration: 0 };
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
      this.mse.destroy();
      if (this.pcm) { this.pcm.destroy(); this.pcm = null; }
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }

    async tryMode(mode, item, resumeAt, token) {
      this.teardown();
      if (mode === 'ec3') {
        this.pcm = new PcmEngine(() => this.updatePcm(), (err) => this.showError(err.message || String(err)), () => this.ended());
        this.pcm.gain.gain.value = this.audio.volume;
        await this.pcm.load(item.m3u8Url);
        if (token !== this.playToken) return;
        this.current.duration = this.pcm.duration;
        if (resumeAt > 0) await this.pcm.seek(resumeAt);
        await this.pcm.play();
        return;
      }
      this.mse.onRecover = () => this.showError('');
      await this.mse.load(item.m3u8Url, item.codecs, (err) => this.showError(err.message || String(err)), mode === 'flac');
      if (token !== this.playToken) return;
      this.current.duration = this.mse.playlist ? this.mse.playlist.duration : 0;
      if (resumeAt > 0) this.audio.currentTime = resumeAt;
      await this.audio.play();
    }

    /** 某编码经实际尝试确认无法播放时回调 */
    onUnsupported(fn) { this.unsupportedListeners.add(fn); }

    /** 当前曲目播放到结尾（audio 与 EC-3 PCM 两种方式）：按重复模式播放下一首或重新播放 */
    ended() { if (this.current) this.next(true); }

    toggle() {
      if (!this.current) return;
      const transport = this.transport();
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
      const waiting = this.loading && a.paused || (!a.paused && this.current.mode !== 'ec3' && a.readyState < 3);
      if (!a.paused) this.loading = false;
      const btn = this.$('.player-toggle');
      btn.innerHTML = waiting ? ICON_LOADING : (a.paused ? ICON_PLAY : ICON_PAUSE);
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
      if (this.current && this.current.mode === 'ec3' && this.pcm) {
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
      this.$('.time-total').textContent = formatTime(d);
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
      el.hidden = !msg;
    }
  }

  const api = { AmPlayer, Marquee, artistNodes, qualityBadge, qualityIcon, segmentAt, formatTime, detectMode, detectModes, mimeFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = { ...api, MseEngine };
  else global.AmHook = api;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * am-hook 简易在线播放器
 *
 * 播放方式按优先级：
 *   1. MSE：解析去加密后的 media m3u8，按 BYTERANGE 用 Range 请求逐段喂给 SourceBuffer。
 *      只缓冲当前位置之后 ~45s，拖动时直接定位到对应 segment，适合所有 MSE 支持的编码。
 *   2. 原生 HLS（Safari）：直接把 media m3u8 交给 <audio>，可播放 ALAC / E-AC-3。
 *   3. 直连：<audio src=media file>，依赖浏览器对 fMP4 的渐进式播放。
 */
(function (global) {
  'use strict';

  const AHEAD_SECONDS = 45;
  const BEHIND_SECONDS = 30;

  /** 默认 media m3u8 是每段独立 URL 的通用写法；MSE / Safari 用原始 EXT-X-MAP + BYTERANGE 写法 */
  function byterangeUrl(m3u8Url) {
    return m3u8Url + (m3u8Url.includes('?') ? '&' : '?') + 'hook=byterange';
  }

  /** 解析 media m3u8（已去除 EXT-X-KEY），返回 init 段与各 segment 的字节 / 时间范围 */
  function parseMediaPlaylist(text, baseUrl) {
    let init = null;
    let duration = 0;
    let pendingDuration = null;
    let next = 0;
    const segments = [];
    const byterange = (value, fallbackOffset) => {
      const [len, off] = value.replace(/"/g, '').split('@');
      const start = off === undefined ? fallbackOffset : Number(off);
      return { start, end: start + Number(len) - 1 };
    };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('#EXT-X-MAP:')) {
        const uri = /URI="([^"]+)"/.exec(line);
        const range = /BYTERANGE="([^"]+)"/.exec(line);
        if (!uri || !range) throw new Error('media m3u8 缺少 EXT-X-MAP BYTERANGE');
        init = { url: new URL(uri[1], baseUrl).href, ...byterange(range[1], 0) };
        next = init.end + 1;
      } else if (line.startsWith('#EXTINF:')) {
        pendingDuration = parseFloat(line.slice(8));
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        const r = byterange(line.slice(17), next);
        next = r.end + 1;
        const dur = pendingDuration || 0;
        segments.push({ ...r, time: duration, duration: dur });
        duration += dur;
        pendingDuration = null;
      }
    }
    if (!init || segments.length === 0) throw new Error('media m3u8 中没有可播放的分段');
    return { init, segments, duration, url: init.url };
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
   * 该编码在当前浏览器中可尝试的播放方式（按优先级），空数组表示不支持。
   * 注意：canPlayType('application/vnd.apple.mpegurl') 只说明浏览器能播 HLS，
   * 不代表能解码其中的编码（新版 Chrome/Edge 原生支持 HLS 但不支持 ALAC），
   * 所以 HLS / 直连都必须同时通过编码检测。
   */
  function detectModes(codecs, audio) {
    if (failedCodecs.has(codecs)) return [];
    const mime = mimeFor(codecs);
    const modes = [];
    const MS = global.ManagedMediaSource || global.MediaSource;
    if (MS && MS.isTypeSupported && MS.isTypeSupported(mime)) modes.push('mse');
    if (audio && audio.canPlayType(mime) !== '') {
      if (audio.canPlayType('application/vnd.apple.mpegurl') !== '') modes.push('hls');
      modes.push('direct');
    }
    return modes;
  }

  function detectMode(codecs, audio) {
    return detectModes(codecs, audio)[0] || null;
  }

  class MseEngine {
    constructor(audio) {
      this.audio = audio;
      this.generation = 0;
    }

    async load(m3u8Url, codecs, onError) {
      const gen = ++this.generation;
      this.destroy(false);
      this.onError = onError;
      const res = await fetch(m3u8Url);
      if (!res.ok) throw new Error(`获取 media m3u8 失败（HTTP ${res.status}）`);
      const playlist = parseMediaPlaylist(await res.text(), res.url || m3u8Url);
      if (gen !== this.generation) return;
      this.playlist = playlist;

      const MS = global.ManagedMediaSource || global.MediaSource;
      const ms = new MS();
      this.ms = ms;
      this.objectUrl = URL.createObjectURL(ms);
      if (global.ManagedMediaSource && MS === global.ManagedMediaSource) this.audio.disableRemotePlayback = true;
      this.audio.src = this.objectUrl;
      await new Promise((resolve) => ms.addEventListener('sourceopen', resolve, { once: true }));
      if (gen !== this.generation) return;

      ms.duration = playlist.duration;
      this.sb = ms.addSourceBuffer(mimeFor(codecs));
      await this.append(await this.fetchRange(playlist.init, gen), gen);

      // 每个 segment 最多尝试追加 2 次，防止时间戳与 EXTINF 不一致时反复拉取同一段；拖动后重置
      this.attempts = new Map();
      this.onTick = () => this.pump(gen);
      this.onSeeking = () => { this.attempts.clear(); this.pump(gen); };
      this.audio.addEventListener('timeupdate', this.onTick);
      this.audio.addEventListener('seeking', this.onSeeking);
      this.pump(gen);
    }

    async fetchRange(range, gen) {
      this.controller = new AbortController();
      const res = await fetch(this.playlist.url, {
        headers: { Range: `bytes=${range.start}-${range.end}` },
        signal: this.controller.signal,
      });
      if (!res.ok) throw new Error(`分段请求失败（HTTP ${res.status}）`);
      const buf = await res.arrayBuffer();
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      return buf;
    }

    append(buf, gen) {
      return new Promise((resolve, reject) => {
        if (gen !== this.generation || !this.sb) return reject(new DOMException('stale', 'AbortError'));
        const done = () => { this.sb.removeEventListener('error', fail); resolve(); };
        const fail = () => { this.sb.removeEventListener('updateend', done); reject(new Error('SourceBuffer 追加失败，浏览器可能不支持该编码')); };
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

    isBuffered(seg) {
      const b = this.sb.buffered;
      const from = seg.time + 0.25;
      const to = seg.time + Math.max(seg.duration - 0.25, 0.3);
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= from && b.end(i) >= to) return true;
      }
      return false;
    }

    async evict(gen) {
      const cut = this.audio.currentTime - BEHIND_SECONDS;
      if (cut <= 1 || this.sb.updating) return;
      await new Promise((resolve) => {
        this.sb.addEventListener('updateend', resolve, { once: true });
        this.sb.remove(0, cut);
      });
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
    }

    ready(i) {
      return this.isBuffered(this.playlist.segments[i]) || (this.attempts.get(i) || 0) >= 2;
    }

    async pump(gen) {
      if (this.busy || gen !== this.generation || !this.sb) return;
      const { segments } = this.playlist;
      const now = this.audio.currentTime;
      let target = -1;
      for (let i = segmentAt(segments, now); i < segments.length; i++) {
        if (segments[i].time > now + AHEAD_SECONDS) break;
        if (!this.ready(i)) { target = i; break; }
      }
      if (target < 0) {
        const allDone = segments.every((_, i) => this.ready(i));
        if (allDone && this.ms.readyState === 'open' && !this.sb.updating) {
          try { this.ms.endOfStream(); } catch {}
        }
        return;
      }

      this.busy = true;
      this.attempts.set(target, (this.attempts.get(target) || 0) + 1);
      try {
        const buf = await this.fetchRange(segments[target], gen);
        try {
          await this.append(buf, gen);
        } catch (err) {
          if (err && err.name === 'QuotaExceededError') {
            await this.evict(gen);
            await this.append(buf, gen);
          } else {
            throw err;
          }
        }
      } catch (err) {
        if (!err || err.name !== 'AbortError') {
          this.busy = false;
          if (this.onError) this.onError(err);
          return;
        }
      }
      this.busy = false;
      if (gen === this.generation) this.pump(gen);
    }

    destroy(bump = true) {
      if (bump) this.generation++;
      if (this.controller) this.controller.abort();
      if (this.onTick) {
        this.audio.removeEventListener('timeupdate', this.onTick);
        this.audio.removeEventListener('seeking', this.onSeeking);
      }
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.onTick = this.onSeeking = this.controller = this.objectUrl = this.sb = this.ms = this.playlist = null;
      this.busy = false;
    }
  }

  const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
  const ICON_LOADING = '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';

  /** 页面底部播放条 */
  class AmPlayer {
    constructor(root) {
      this.root = root;
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.mse = new MseEngine(this.audio);
      this.$ = (sel) => root.querySelector(sel);
      this.listeners = new Set();
      this.unsupportedListeners = new Set();
      this.playToken = 0;
      this.bindUi();
      try {
        const v = parseFloat(localStorage.getItem('am-hook:volume'));
        if (v >= 0 && v <= 1) this.audio.volume = v;
      } catch {}
      this.$('.volume').value = this.audio.volume;
    }

    onChange(fn) { this.listeners.add(fn); }
    emit() { this.listeners.forEach((fn) => fn(this.current, !this.audio.paused)); }

    bindUi() {
      const a = this.audio;
      this.$('.player-toggle').addEventListener('click', () => this.toggle());
      this.$('.skip-back').addEventListener('click', () => this.seekBy(-10));
      this.$('.skip-fwd').addEventListener('click', () => this.seekBy(10));
      this.$('.volume').addEventListener('input', (e) => {
        a.volume = Number(e.target.value);
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
        a.currentTime = this.dragRatio * this.duration();
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
      a.addEventListener('error', () => {
        // 尝试阶段的错误由 play() 统一处理（会自动换下一种播放方式）
        if (!this.attempting && this.current && this.current.mode !== 'mse' && this.audio.getAttribute('src')) {
          this.showError('播放出错，请换一个音质，或点击该音质的 VLC 按钮用 VLC 播放。');
        }
      });

      document.addEventListener('keydown', (e) => {
        if (!this.current || e.target.closest('input, textarea, button, a, [role="slider"]')) return;
        if (e.code === 'Space') { e.preventDefault(); this.toggle(); }
        if (e.key === 'ArrowLeft') this.seekBy(-5);
        if (e.key === 'ArrowRight') this.seekBy(5);
      });

      if ('mediaSession' in navigator) {
        const ms = navigator.mediaSession;
        ms.setActionHandler('play', () => a.play());
        ms.setActionHandler('pause', () => a.pause());
        ms.setActionHandler('seekbackward', () => this.seekBy(-10));
        ms.setActionHandler('seekforward', () => this.seekBy(10));
        try { ms.setActionHandler('seekto', (d) => { a.currentTime = d.seekTime; }); } catch {}
      }
    }

    duration() {
      if (this.current && this.current.duration) return this.current.duration;
      return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    }

    /** item: { id, codecs, m3u8Url, fileUrl, label, title, artist, album, artwork } */
    async play(item) {
      if (this.current && this.current.id === item.id) { this.toggle(); return; }
      const modes = detectModes(item.codecs, this.audio);
      if (!modes.length) {
        this.showError(`当前浏览器不支持 ${item.codecs} 编码，可点击该音质的 VLC 按钮用 VLC 播放。`);
        return;
      }
      const token = ++this.playToken;
      const resumeAt = this.current ? this.audio.currentTime : 0;
      this.current = { ...item, mode: modes[0], duration: 0 };
      this.root.hidden = false;
      document.body.classList.add('has-player');
      this.showError('');
      this.$('.player-title').textContent = item.title || '未知歌曲';
      this.$('.player-sub').textContent = [item.artist, item.label].filter(Boolean).join(' · ');
      this.$('.player-art').src = item.artwork || '';
      this.setLoading(true);
      this.emit();
      this.updateMediaSession();

      // 依次尝试各播放方式，前一种因编码/格式不支持失败时自动换下一种
      let lastError = null;
      for (const mode of modes) {
        if (token !== this.playToken) return;
        this.current.mode = mode;
        this.current.duration = 0;
        this.$('.player-mode').textContent = { mse: 'MSE', hls: 'HLS', direct: '直连' }[mode];
        this.attempting = true;
        try {
          await this.tryMode(mode, item, resumeAt, token);
          this.attempting = false;
          this.renderProgress();
          return;
        } catch (err) {
          this.attempting = false;
          if (token !== this.playToken) return;
          if (err && err.name === 'NotAllowedError') {
            this.setLoading(false);
            this.showError('浏览器阻止了自动播放，请点击播放按钮。');
            return;
          }
          lastError = err;
          console.warn(`[am-hook] ${mode} 播放失败，尝试下一种方式`, err);
        }
      }

      this.teardown();
      failedCodecs.add(item.codecs);
      this.unsupportedListeners.forEach((fn) => fn(item.codecs));
      this.showError(`当前浏览器无法播放 ${item.label || item.codecs}（${item.codecs}），可点击该音质的 VLC 按钮用 VLC 播放。`
        + (lastError && lastError.message ? `（${lastError.message}）` : ''));
      this.emit();
    }

    teardown() {
      this.mse.destroy();
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }

    async tryMode(mode, item, resumeAt, token) {
      this.teardown();
      if (mode === 'mse') {
        await this.mse.load(byterangeUrl(item.m3u8Url), item.codecs, (err) => this.showError(err.message || String(err)));
        if (token !== this.playToken) return;
        this.current.duration = this.mse.playlist ? this.mse.playlist.duration : 0;
      } else {
        this.audio.src = mode === 'hls' ? byterangeUrl(item.m3u8Url) : item.fileUrl;
      }
      if (resumeAt > 0) this.audio.currentTime = resumeAt;
      await this.audio.play();
    }

    /** 某编码经实际尝试确认无法播放时回调 */
    onUnsupported(fn) { this.unsupportedListeners.add(fn); }

    toggle() {
      if (!this.current) return;
      if (this.audio.paused) this.audio.play().catch((err) => this.showError(err.message)); else this.audio.pause();
    }

    seekBy(delta) {
      const d = this.duration();
      if (!d) return;
      this.audio.currentTime = Math.min(Math.max(0, this.audio.currentTime + delta), d - 0.1);
    }

    setLoading(on) {
      this.loading = on;
      this.renderToggle();
    }

    renderToggle() {
      const a = this.audio;
      const waiting = this.loading && a.paused || (!a.paused && a.readyState < 3);
      if (!a.paused) this.loading = false;
      const btn = this.$('.player-toggle');
      btn.innerHTML = waiting ? ICON_LOADING : (a.paused ? ICON_PLAY : ICON_PAUSE);
      btn.setAttribute('aria-label', a.paused ? '播放' : '暂停');
    }

    renderProgress() {
      const d = this.duration();
      const t = this.dragRatio !== undefined ? this.dragRatio * d : this.audio.currentTime;
      const ratio = d ? Math.min(1, t / d) : 0;
      this.$('.seek-fill').style.width = `${ratio * 100}%`;
      this.$('.seek-thumb').style.left = `${ratio * 100}%`;
      const b = this.audio.buffered;
      let bufEnd = 0;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= this.audio.currentTime + 0.5) bufEnd = Math.max(bufEnd, b.end(i));
      }
      this.$('.seek-buffer').style.width = `${d ? Math.min(1, bufEnd / d) * 100 : 0}%`;
      this.$('.time-cur').textContent = formatTime(t);
      this.$('.time-total').textContent = formatTime(d);
      const seek = this.$('.seek');
      seek.setAttribute('aria-valuemax', String(Math.round(d)));
      seek.setAttribute('aria-valuenow', String(Math.round(t)));
      seek.setAttribute('aria-valuetext', `${formatTime(t)} / ${formatTime(d)}`);
      if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) {
        try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(this.audio.currentTime, d), playbackRate: 1 }); } catch {}
      }
    }

    updateMediaSession() {
      if (!('mediaSession' in navigator) || !global.MediaMetadata) return;
      const c = this.current;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: c.title || '',
        artist: c.artist || '',
        album: c.album || '',
        artwork: c.artwork ? [{ src: c.artwork, sizes: '600x600', type: 'image/jpeg' }] : [],
      });
    }

    showError(msg) {
      const el = this.$('.player-msg');
      el.textContent = msg;
      el.hidden = !msg;
      if (msg) {
        this.root.hidden = false;
        document.body.classList.add('has-player');
        this.setLoading(false);
      }
    }
  }

  const api = { AmPlayer, parseMediaPlaylist, segmentAt, formatTime, detectMode, detectModes, mimeFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.AmHook = api;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * am-hook 简易在线播放器
 *
 * 播放方式按优先级：
 *   1. MSE：浏览器直接从 Apple CDN 获取 media m3u8 与分段，在 Worker 中用 wasm 解密（decrypt.js）
 *      后逐段喂给 SourceBuffer。只缓冲当前位置之后 ~45s，拖动时直接定位到对应 segment。
 *   2. 原生 HLS（Safari）：把服务端解密的 media m3u8 交给 <audio>，可播放 ALAC / E-AC-3。
 *   3. 直连：<audio src=服务端解密的 media file>，依赖浏览器对 fMP4 的渐进式播放。
 *   2、3 需要服务端以 --hook 启动（item 带 hookM3u8Url / hookFileUrl）。
 */
(function (global) {
  'use strict';

  const AHEAD_SECONDS = 45;
  const BEHIND_SECONDS = 30;

  /** 服务端默认 media m3u8 是每段独立 URL 的通用写法；Safari 原生 HLS 用原始 EXT-X-MAP + BYTERANGE 写法 */
  function byterangeUrl(m3u8Url) {
    return m3u8Url + (m3u8Url.includes('?') ? '&' : '?') + 'hook=byterange';
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
  function detectModes(codecs, audio, hook) {
    if (failedCodecs.has(codecs)) return [];
    const mime = mimeFor(codecs);
    const modes = [];
    const MS = global.ManagedMediaSource || global.MediaSource;
    if (MS && MS.isTypeSupported && MS.isTypeSupported(mime) && global.AmDecrypt && global.AmDecrypt.supported()) modes.push('mse');
    if (hook && audio && audio.canPlayType(mime) !== '') {
      if (audio.canPlayType('application/vnd.apple.mpegurl') !== '') modes.push('hls');
      modes.push('direct');
    }
    if (String(codecs).toLowerCase() === 'alac' && MS && MS.isTypeSupported &&
        MS.isTypeSupported(mimeFor('flac')) && global.Worker && global.AmDecrypt && global.AmDecrypt.supported()) modes.push('flac');
    return modes;
  }

  /** hook：服务端是否以 --hook 启动（决定能否使用原生 HLS / 直连） */
  function detectMode(codecs, audio, hook) {
    return detectModes(codecs, audio, hook)[0] || null;
  }

  /** 界面文案（i18n.js）；未加载时直接返回 key */
  function t(key, vars) {
    return global.AmI18n ? global.AmI18n.t(key, vars) : key;
  }

  /** 不能在浏览器内播放时给用户的建议 */
  function fallbackHint(item) {
    return t(item && item.hookM3u8Url ? 'player.hintExternal' : 'player.hintDownload');
  }

  function modeLabel(mode) {
    return mode === 'direct' ? t('player.direct') : mode.toUpperCase();
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

  class MseEngine {
    constructor(audio) {
      this.audio = audio;
      this.generation = 0;
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
      this.sb = ms.addSourceBuffer(mimeFor(transcode ? 'flac' : codecs));
      await this.append(await this.fetchRange(playlist.init, gen), gen);

      // 每个 segment 最多尝试追加 2 次，防止时间戳与 EXTINF 不一致时反复拉取同一段；拖动后重置
      this.attempts = new Map();
      this.pendingSegments = new Map();
      this.seekSerial = 0;
      this.onTick = () => this.pump(gen);
      this.onSeeking = () => {
        this.seekSerial++;
        this.attempts.clear();
        this.pendingSegments.clear();
        this.pump(gen);
      };
      this.audio.addEventListener('timeupdate', this.onTick);
      this.audio.addEventListener('seeking', this.onSeeking);
      this.pump(gen);
    }

    /** 获取并解密一个分段 */
    async fetchRange(range, gen) {
      let buf = await this.playlist.load(range, this.controller.signal);
      if (gen !== this.generation) throw new DOMException('stale', 'AbortError');
      if (this.transcoder) buf = await this.transcoder.run(range.init ? 'open' : 'transcode', buf);
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
      const cut = this.audio.currentTime - (this.transcoder ? 2 : BEHIND_SECONDS);
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
      const ahead = this.transcoder ? 14 : AHEAD_SECONDS;
      for (let i = segmentAt(segments, now); i < segments.length; i++) {
        if (segments[i].time > now + ahead) break;
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
      const seekSerial = this.seekSerial;
      let waitForPlayback = false;
      try {
        if (this.transcoder) {
          let queue = this.pendingSegments.get(target);
          if (!queue) {
            this.attempts.set(target, (this.attempts.get(target) || 0) + 1);
            queue = await this.fetchRange(segments[target], gen);
            if (seekSerial !== this.seekSerial) throw new DOMException('stale seek', 'AbortError');
            this.pendingSegments.set(target, queue);
          }
          while (queue.length) {
            if (seekSerial !== this.seekSerial) throw new DOMException('stale seek', 'AbortError');
            try {
              await this.append(queue[0], gen);
            } catch (err) {
              if (!err || err.name !== 'QuotaExceededError') throw err;
              await this.evict(gen);
              try {
                await this.append(queue[0], gen);
              } catch (retryError) {
                if (!retryError || retryError.name !== 'QuotaExceededError') throw retryError;
                waitForPlayback = true;
                break;
              }
            }
            if (seekSerial !== this.seekSerial) throw new DOMException('stale seek', 'AbortError');
            queue.shift();
          }
          if (!queue.length) {
            this.pendingSegments.delete(target);
            this.attempts.set(target, 2);
          }
        } else {
          this.attempts.set(target, (this.attempts.get(target) || 0) + 1);
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
        }
      } catch (err) {
        if (!err || err.name !== 'AbortError') {
          this.busy = false;
          if (this.onError) this.onError(err);
          return;
        }
      }
      this.busy = false;
      if (!waitForPlayback && gen === this.generation) this.pump(gen);
    }

    destroy(bump = true) {
      if (bump) this.generation++;
      if (this.controller) this.controller.abort();
      if (this.transcoder) this.transcoder.destroy();
      if (this.onTick) {
        this.audio.removeEventListener('timeupdate', this.onTick);
        this.audio.removeEventListener('seeking', this.onSeeking);
      }
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.onTick = this.onSeeking = this.controller = this.objectUrl = this.sb = this.ms = this.playlist = this.transcoder = this.pendingSegments = null;
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
      if (global.AmI18n) global.AmI18n.onChange(() => this.renderLang());
    }

    /** 切换界面语言后重绘播放条上的文字 */
    renderLang() {
      this.renderToggle();
      if (this.current) {
        this.$('.player-mode').textContent = modeLabel(this.current.mode);
        this.$('.player-title').textContent = this.current.title || t('player.unknownTitle');
      }
      this.renderError();
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
          const item = this.current;
          this.showError(() => t('player.errorGeneric', { hint: fallbackHint(item) }));
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

    /**
     * item: { id, codecs, m3u8Url, hookM3u8Url, hookFileUrl, label, title, artist, album, artwork }
     * m3u8Url 为 CDN 原始地址（浏览器解密）；hook* 为服务端解密地址，仅 --hook 时存在。
     */
    async play(item) {
      if (this.current && this.current.id === item.id) { this.toggle(); return; }
      const modes = detectModes(item.codecs, this.audio, !!item.hookM3u8Url);
      if (!modes.length) {
        this.showError(() => t('player.errorCodec', { codecs: item.codecs, hint: fallbackHint(item) }));
        return;
      }
      const token = ++this.playToken;
      const resumeAt = this.current ? this.audio.currentTime : 0;
      this.current = { ...item, mode: modes[0], duration: 0 };
      this.root.hidden = false;
      document.body.classList.add('has-player');
      this.showError('');
      this.$('.player-title').textContent = item.title || t('player.unknownTitle');
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
        this.$('.player-mode').textContent = modeLabel(mode);
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
      this.showError(() => t('player.errorFailed', { label: item.label || item.codecs, codecs: item.codecs, hint: fallbackHint(item) }) + detail);
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
      if (mode === 'mse' || mode === 'flac') {
        await this.mse.load(item.m3u8Url, item.codecs, (err) => this.showError(err.message || String(err)), mode === 'flac');
        if (token !== this.playToken) return;
        this.current.duration = this.mse.playlist ? this.mse.playlist.duration : 0;
      } else {
        this.audio.src = mode === 'hls' ? byterangeUrl(item.hookM3u8Url) : item.hookFileUrl;
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
      btn.setAttribute('aria-label', t(a.paused ? 'player.play' : 'player.pause'));
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

    /** msg 可以是函数，切换语言时重新求值 */
    showError(msg) {
      this.errorMsg = msg || null;
      this.renderError();
      if (msg) {
        this.root.hidden = false;
        document.body.classList.add('has-player');
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

  const api = { AmPlayer, segmentAt, formatTime, detectMode, detectModes, mimeFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.AmHook = api;
})(typeof window !== 'undefined' ? window : globalThis);

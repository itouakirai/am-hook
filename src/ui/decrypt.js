/*
 * am-hook 浏览器端解密
 *
 * 服务端只提供 master m3u8（/parse）与轨道解密模板（/key），其余全部在浏览器完成：
 *   - media m3u8 与分片直接从 Apple CDN 获取（aod.itunes.apple.com 允许跨域 + Range）；
 *   - 解密在 Worker 池中由 hook.wasm（crates/am-wasm）完成，不阻塞页面；
 *   - 下载时解密结果按原始偏移写入 OPFS 文件，完成后以磁盘文件交给浏览器保存，
 *     大文件也不会占用大量内存；不支持 OPFS 时退回内存 Blob。
 * 解密不改变字节长度，产物与服务端 --hook 模式的 media file 完全一致。
 */
(function (global) {
  'use strict';

  const FIXED_KEY_URI = 'skd://itunes.apple.com/P000000000/s1/e1';
  const WORKER_URL = '/assets/hook-worker.js';
  const OPFS_DIR = 'am-hook-downloads';
  const DOWNLOAD_CONCURRENCY = 4;
  /** 保存完成后 OPFS 临时文件保留多久（浏览器需要时间把它复制到下载目录） */
  const KEEP_SAVED_MS = 10 * 60 * 1000;
  /** 页面加载时清理超过该时长的残留临时文件（上次中断的下载等） */
  const STALE_MS = 60 * 60 * 1000;

  /** 界面文案（i18n.js）；未加载时直接返回 key */
  function t(key, vars) {
    return global.AmI18n ? global.AmI18n.t(key, vars) : key;
  }

  const currentLang = () => (global.AmI18n ? global.AmI18n.lang : 'zh');

  /* ---------- Worker RPC ---------- */

  class WorkerClient {
    constructor() {
      this.worker = new Worker(WORKER_URL);
      this.seq = 0;
      this.pending = new Map();
      this.worker.onmessage = (e) => {
        const { id, ok, result, error, name } = e.data;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (ok) p.resolve(result);
        else p.reject(Object.assign(new Error(error), { name: name || 'Error' }));
      };
      this.worker.onerror = (e) => this.failAll(new Error(e.message || t('err.worker')));
    }

    /** 每条消息都带上当前界面语言，Worker 据此返回对应语言的错误信息 */
    call(op, args = {}, transfer = []) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, op, lang: currentLang(), ...args }, transfer);
      });
    }

    failAll(err) {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    }

    terminate() {
      this.worker.terminate();
      this.failAll(new DOMException('Worker terminated', 'AbortError'));
    }
  }

  /** 解密 Worker 池：任务排队，空闲 Worker 依次领取；每个 Worker 各自一个 wasm 实例 */
  class DecryptPool {
    constructor(size) {
      this.size = size;
      this.count = 0;
      this.idle = [];
      this.queue = [];
    }

    run(args) {
      return new Promise((resolve, reject) => {
        this.queue.push({ args, resolve, reject });
        this.dispatch();
      });
    }

    dispatch() {
      while (this.queue.length) {
        let worker = this.idle.pop();
        if (!worker && this.count < this.size) {
          worker = new WorkerClient();
          this.count++;
        }
        if (!worker) return;
        const job = this.queue.shift();
        worker.call('decrypt', job.args, [job.args.buf])
          .then(job.resolve, job.reject)
          .finally(() => { this.idle.push(worker); this.dispatch(); });
      }
    }
  }

  const pool = new DecryptPool(Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)));

  /* ---------- 模板 ---------- */

  const templates = new Map();

  /** 轨道解密模板（wrapper-lite /key 的 data JSON 文本），同一 key 只请求一次 */
  function fetchTemplate(adamId, uri) {
    const cacheKey = `${adamId} ${uri}`;
    if (!templates.has(cacheKey)) {
      const p = fetch(`/key?adamId=${encodeURIComponent(adamId)}&uri=${encodeURIComponent(uri)}`).then(async (res) => {
        const text = await res.text();
        if (!res.ok) {
          let msg = '';
          try { msg = JSON.parse(text).msg; } catch {}
          throw new Error(t('err.template', { msg: msg || `HTTP ${res.status}` }));
        }
        return text;
      });
      p.catch(() => templates.delete(cacheKey));
      templates.set(cacheKey, p);
    }
    return templates.get(cacheKey);
  }

  /* ---------- media m3u8 ---------- */

  /**
   * 解析 Apple 原始 media m3u8（含 EXT-X-KEY），返回 init 段与各 segment 的字节 / 时间范围。
   * 每个 segment 记录其适用的 key：fixed（内嵌固定模板）、track（轨道模板）或 null（未加密）。
   */
  function parseMediaPlaylist(text, playlistUrl) {
    const fileName = new URL(playlistUrl).pathname.split('/').pop();
    const adamId = (/_A(\d+)_/.exec(fileName) || [])[1] || '';
    let init = null;
    let keyUri = null;
    let currentKey = null;
    let duration = 0;
    let pendingDuration = null;
    let next = 0;
    const segments = [];
    const byterange = (value, fallbackOffset) => {
      const [len, off] = value.replace(/"/g, '').trim().split('@');
      const start = off === undefined ? fallbackOffset : Number(off);
      return { start, end: start + Number(len) - 1 };
    };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('#EXT-X-KEY:')) {
        const method = (/METHOD=([^,]+)/.exec(line) || [])[1];
        const uri = (/URI="([^"]+)"/.exec(line) || [])[1];
        currentKey = method === 'NONE' || !uri ? null : uri;
        if (currentKey && currentKey !== FIXED_KEY_URI && !keyUri) keyUri = currentKey;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const uri = /URI="([^"]+)"/.exec(line);
        const range = /BYTERANGE="([^"]+)"/.exec(line);
        if (!uri || !range) throw new Error(t('err.m3u8Map'));
        init = { url: new URL(uri[1], playlistUrl).href, ...byterange(range[1], 0), init: true };
        next = init.end + 1;
      } else if (line.startsWith('#EXTINF:')) {
        pendingDuration = parseFloat(line.slice(8));
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        const r = byterange(line.slice(17), next);
        next = r.end + 1;
        const dur = pendingDuration || 0;
        const key = currentKey === FIXED_KEY_URI ? 'fixed' : currentKey ? 'track' : null;
        segments.push({ ...r, time: duration, duration: dur, key });
        duration += dur;
        pendingDuration = null;
      }
    }
    if (!init || segments.length === 0) throw new Error(t('err.m3u8Empty'));
    if (segments.some((s) => s.key === 'track') && (!keyUri || !adamId)) throw new Error(t('err.m3u8Key'));
    return { url: init.url, adamId, keyUri, init, segments, duration, size: segments[segments.length - 1].end + 1 };
  }

  /* ---------- 轨道 ---------- */

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
    });
  }

  const isAbort = (err) => err && err.name === 'AbortError';

  class Track {
    /** 从 CDN 获取并解析 media m3u8，同时预取轨道模板 */
    static async open(m3u8Url, signal) {
      const res = await fetch(m3u8Url, { signal });
      if (!res.ok) throw new Error(t('err.m3u8Http', { status: res.status }));
      const track = new Track(parseMediaPlaylist(await res.text(), res.url || m3u8Url));
      track.template().catch(() => {});
      return track;
    }

    constructor(playlist) {
      Object.assign(this, playlist);
    }

    template() {
      return this.keyUri ? fetchTemplate(this.adamId, this.keyUri) : Promise.resolve(null);
    }

    /** Range 请求一个分段的原始字节，网络错误最多重试 3 次 */
    async fetchPiece(piece, signal) {
      const length = piece.end - piece.start + 1;
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(this.url, { headers: { Range: `bytes=${piece.start}-${piece.end}` }, signal });
          if (!res.ok) throw new Error(t('err.segmentHttp', { status: res.status }));
          let buf = await res.arrayBuffer();
          // 上游忽略 Range 时自行截取
          if (res.status === 200 && buf.byteLength > length) buf = buf.slice(piece.start, piece.end + 1);
          if (buf.byteLength !== length) throw new Error(t('err.segmentLength', { got: buf.byteLength, want: length }));
          return buf;
        } catch (err) {
          if (isAbort(err) || attempt >= 3) throw err;
          await sleep(500 * 2 ** attempt, signal);
        }
      }
    }

    /** 解密一个分段（init 段只做 box 改写），返回长度不变的 ArrayBuffer；buf 会被转移给 Worker */
    async decryptPiece(piece, buf) {
      if (piece.init) return pool.run({ kind: 'init', buf });
      const init = await this.initData();
      if (piece.key === 'fixed') return pool.run({ kind: 'frag', key: 'fixed', init, buf });
      if (piece.key === 'track') return pool.run({ kind: 'frag', key: this.keyUri, template: await this.template(), init, buf });
      return pool.run({ kind: 'frag', init, buf });
    }

    initData(signal) {
      if (!this.initPromise) {
        const pending = this.fetchPiece(this.init, signal).then(buf => this.decryptPiece(this.init, buf));
        this.initPromise = pending;
        pending.catch(() => { if (this.initPromise === pending) this.initPromise = null; });
      }
      return this.initPromise;
    }

    async load(piece, signal) {
      // Keep the cached init attached: callers may transfer their copy to a worker.
      if (piece.init) return (await this.initData(signal)).slice(0);
      const [buf] = await Promise.all([this.fetchPiece(piece, signal), this.initData(signal), piece.key === 'track' ? this.template() : null]);
      return this.decryptPiece(piece, buf);
    }
  }

  /* ---------- 下载 ---------- */

  function opfsSupported() {
    return !!(global.isSecureContext && navigator.storage && navigator.storage.getDirectory);
  }

  async function opfsDir() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(OPFS_DIR, { create: true });
  }

  async function removeOpfsFile(name) {
    try { await (await opfsDir()).removeEntry(name); } catch {}
  }

  /** 解密结果写入 OPFS：由专用 Worker 持有同步访问句柄，按偏移乱序写入 */
  class OpfsSink {
    static async open(size) {
      if (navigator.storage.estimate) {
        const { quota, usage } = await navigator.storage.estimate();
        if (quota && quota - (usage || 0) < size * 1.05) throw new Error('OPFS 剩余配额不足');
      }
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.m4a`;
      const worker = new WorkerClient();
      try {
        await worker.call('file-open', { dir: OPFS_DIR, name });
      } catch (err) {
        worker.terminate();
        await removeOpfsFile(name);
        throw err;
      }
      return new OpfsSink(worker, name);
    }

    constructor(worker, name) {
      this.kind = 'opfs';
      this.worker = worker;
      this.name = name;
    }

    write(at, buf) {
      return this.worker.call('file-write', { at, buf }, [buf]);
    }

    async finish() {
      await this.worker.call('file-close');
      this.worker.terminate();
      return (await (await opfsDir()).getFileHandle(this.name)).getFile();
    }

    async abort() {
      try { await this.worker.call('file-close'); } catch {}
      this.worker.terminate();
      await removeOpfsFile(this.name);
    }

    cleanup() {
      removeOpfsFile(this.name);
    }
  }

  /** 不支持 OPFS 时的退路：每段存成 Blob（浏览器可将大 Blob 转存到磁盘），最后按偏移拼接 */
  class MemorySink {
    constructor() {
      this.kind = 'memory';
      this.parts = [];
    }

    write(at, buf) {
      this.parts.push([at, new Blob([buf])]);
    }

    finish() {
      this.parts.sort((a, b) => a[0] - b[0]);
      return new Blob(this.parts.map((p) => p[1]), { type: 'audio/mp4' });
    }

    abort() {
      this.parts = [];
    }

    cleanup() {}
  }

  async function openSink(size) {
    if (opfsSupported()) {
      try {
        return await OpfsSink.open(size);
      } catch (err) {
        console.warn('[am-hook] OPFS 不可用，改用内存缓存下载', err);
      }
    }
    return new MemorySink();
  }

  function saveFile(file, fileName, cleanup) {
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => { URL.revokeObjectURL(url); cleanup(); }, KEEP_SAVED_MS);
  }

  /**
   * 下载并解密整条轨道，完成后触发浏览器保存。
   * onProgress(doneBytes, totalBytes)；返回 { storage: 'opfs' | 'memory', size }。
   */
  async function download(track, fileName, { signal, onProgress } = {}) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal.reason);
    if (signal) {
      if (signal.aborted) throw signal.reason;
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const pieces = [track.init, ...track.segments];
    const sink = await openSink(track.size);
    let next = 0;
    let done = 0;
    const lane = async () => {
      while (next < pieces.length) {
        ctl.signal.throwIfAborted();
        const piece = pieces[next++];
        const buf = await track.load(piece, ctl.signal);
        ctl.signal.throwIfAborted();
        await sink.write(piece.start, buf);
        done += piece.end - piece.start + 1;
        if (onProgress) onProgress(done, track.size);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, pieces.length) }, () => lane().catch((err) => {
        // 任一分段失败即取消其余分段
        ctl.abort(err);
        throw err;
      })));
      const file = await sink.finish();
      saveFile(file, fileName, () => sink.cleanup());
      return { storage: sink.kind, size: track.size };
    } catch (err) {
      ctl.abort(err);
      await sink.abort();
      throw ctl.signal.reason || err;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** 清理上次中断遗留的 OPFS 临时文件（正在被其他标签页写入的文件无法删除，会被跳过） */
  async function cleanupStale() {
    if (!opfsSupported()) return;
    try {
      const dir = await opfsDir();
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'file') continue;
        try {
          if (Date.now() - (await handle.getFile()).lastModified > STALE_MS) await dir.removeEntry(name);
        } catch {}
      }
    } catch {}
  }

  /** 当前环境能否在浏览器内解密 */
  function supported() {
    return typeof Worker !== 'undefined' && typeof WebAssembly === 'object';
  }

  global.AmDecrypt = {
    Track,
    openTrack: (url, signal) => Track.open(url, signal),
    parseMediaPlaylist,
    download,
    cleanupStale,
    opfsSupported,
    supported,
  };
})(typeof window !== 'undefined' ? window : globalThis);

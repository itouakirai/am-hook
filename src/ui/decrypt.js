/*
 * am-hook 浏览器端解密
 *
 * wrapper-lite 只提供 master m3u8 地址与轨道解密模板（经 wrapper.js，服务端转发或直连本地 wrapper-lite），其余全部在浏览器完成：
 *   - media m3u8 与分片直接从 Apple CDN 获取（aod.itunes.apple.com 允许跨域 + Range）；
 *   - 解密在 Worker 池中由 hook.wasm（crates/am-wasm）完成，不阻塞页面；
 *   - 下载时解密结果按原始偏移写入 OPFS 文件，完成后以磁盘文件交给页面保存，
 *     大文件也不会占用大量内存；不支持 OPFS 时退回内存 Blob。
 * 解密不改变字节长度；
 * 下载最后再像参考实现 rip.go 那样用 DefragmentMP4 解碎片为普通 MP4（ftyp, moov, mdat）。
 */
(function (global) {
  'use strict';

  const FIXED_KEY_URI = 'skd://itunes.apple.com/P000000000/s1/e1';
  const WORKER_URL = '/assets/hook-worker.js';
  /** 媒体 Worker（media.wasm，crates/am-media），与 MV 共用，其中含移植自参考实现的 defrag */
  const MEDIA_WORKER_URL = '/assets/media-worker.js';
  const OPFS_DIR = 'am-hook-downloads';
  const DOWNLOAD_CONCURRENCY = 4;
  /** 每个下载持有的 Web Lock 名前缀（与 MV 的 am-hook-mv- 同一机制） */
  const LOCK_PREFIX = 'am-hook-song-';
  /** 浏览器不支持 Web Locks 时，只回收超过该时长未改动的临时文件 */
  const STALE_MS = 24 * 60 * 60 * 1000;

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

  /** 轨道解密模板（wrapper-lite /key 的 data JSON 文本，见 wrapper.js），同一 key 只请求一次 */
  function fetchTemplate(adamId, uri) {
    const cacheKey = `${adamId} ${uri}`;
    if (!templates.has(cacheKey)) {
      const p = global.AmWrapper.key(adamId, uri).catch((error) => {
        throw new Error(t('err.template', { msg: error.message }));
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

  /**
   * 删除临时文件。刚被终止的 Worker 要过一会儿才释放同步访问句柄，期间删除会失败，
   * 因此按退避重试约 3 秒；文件不存在即视为成功，仍删不掉的留给 collectGarbage。
   */
  async function removeOpfsFile(name) {
    let dir;
    try { dir = await opfsDir(); } catch { return; }
    for (let wait = 50; ; wait *= 2) {
      try {
        await dir.removeEntry(name);
        return;
      } catch (err) {
        if ((err && err.name === 'NotFoundError') || wait > 1600) return;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  /**
   * 每个下载持有以其文件 id 命名的 Web Lock，直到文件被删除。标签页关闭或崩溃时浏览器
   * 自动释放锁，因此没有被持有锁的临时文件就是垃圾。返回释放函数。
   */
  function hold(id) {
    if (!navigator.locks) return Promise.resolve(() => {});
    let release;
    const held = new Promise((r) => { release = r; });
    return new Promise((resolve) => {
      navigator.locks.request(LOCK_PREFIX + id, () => { resolve(release); return held; }).catch(() => resolve(() => {}));
    });
  }

  /** 解密结果写入 OPFS：由专用 Worker 持有同步访问句柄，按偏移乱序写入 */
  class OpfsSink {
    static async open(size) {
      if (navigator.storage.estimate) {
        const { quota, usage } = await navigator.storage.estimate();
        // 解碎片时碎片文件与输出文件同时存在，峰值约为两倍文件大小
        if (quota && quota - (usage || 0) < size * 2.1) throw new Error('OPFS 剩余配额不足');
      }
      const id = crypto.randomUUID();
      const name = `${id}.m4a`;
      const unlock = await hold(id);
      const worker = new WorkerClient();
      try {
        await worker.call('file-open', { dir: OPFS_DIR, name });
      } catch (err) {
        worker.terminate();
        await removeOpfsFile(name);
        unlock();
        throw err;
      }
      return new OpfsSink(worker, name, unlock);
    }

    constructor(worker, name, unlock) {
      this.kind = 'opfs';
      this.worker = worker;
      this.name = name;
      this.unlock = unlock;
    }

    write(at, buf) {
      return this.worker.call('file-write', { at, buf }, [buf]);
    }

    async finish() {
      await this.worker.call('file-close');
      this.closeWorker();
    }

    closeWorker() {
      if (!this.worker) return;
      this.worker.terminate();
      this.worker = null;
    }

    /** 把 fMP4 解碎片到同目录新文件并删除 fMP4，返回最终 File */
    async defrag(signal) {
      const input = this.name;
      this.output = input.replace(/\.m4a$/, '-defrag.m4a');
      try {
        await defragInWorker([input, this.output, OPFS_DIR], signal);
      } finally {
        await removeOpfsFile(input);
      }
      this.name = this.output;
      this.output = null;
      return (await (await opfsDir()).getFileHandle(this.name)).getFile();
    }

    async abort() {
      if (this.worker) {
        try { await this.worker.call('file-close'); } catch {}
        this.closeWorker();
      }
      await removeOpfsFile(this.name);
      if (this.output) await removeOpfsFile(this.output);
      this.unlock();
    }

    cleanup() {
      return removeOpfsFile(this.name).finally(this.unlock);
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
      this.blob = new Blob(this.parts.map((p) => p[1]), { type: 'audio/mp4' });
      this.parts = [];
    }

    /** 无 OPFS 时 Worker 直接读 Blob、返回新 Blob */
    defrag(signal) {
      const blob = this.blob;
      this.blob = null;
      return defragInWorker([blob], signal);
    }

    abort() {
      this.parts = [];
      this.blob = null;
    }

    cleanup() {}
  }

  async function openSink(size) {
    if (opfsSupported()) {
      await collectGarbage();
      try {
        return await OpfsSink.open(size);
      } catch (err) {
        console.warn('[am-hook] OPFS 不可用，改用内存缓存下载', err);
      }
    }
    return new MemorySink();
  }

  /**
   * 在媒体 Worker 中运行参考实现的 DefragmentMP4（歌曲用法：M4A ftyp、每个 trun 一个 chunk、
   * 不做 MV 那样的按时间交错）。args 为 [输入文件名, 输出文件名, OPFS 目录] 或 [Blob]；取消时直接终止 Worker。
   */
  function defragInWorker(args, signal) {
    signal.throwIfAborted();
    const worker = new Worker(MEDIA_WORKER_URL);
    let onAbort;
    return new Promise((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      worker.onmessage = ({ data }) => (data.error ? reject(new Error(t('err.defrag', { msg: data.error }))) : resolve(data.result));
      worker.onerror = (e) => reject(new Error(t('err.defrag', { msg: e.message || t('err.worker') })));
      worker.postMessage({ id: 1, method: 'defragSong', args });
    }).finally(() => {
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
    });
  }

  /**
   * 下载并解密整条轨道并解碎片，约定与 MV 的 downloadMV 相同。
   * onProgress(doneBytes, totalBytes)；onDefrag() 在开始解碎片时调用；
   * 返回 { file, storage: 'opfs' | 'memory', size, dispose }：由页面保存 file，
   * 不再需要时调用 dispose() 删除 OPFS 临时文件并释放 Web Lock。
   */
  async function download(track, { signal, onProgress, onDefrag } = {}) {
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
      await sink.finish();
      if (onDefrag) onDefrag();
      const file = await sink.defrag(ctl.signal);
      return { file, storage: sink.kind, size: file.size, dispose: () => sink.cleanup() };
    } catch (err) {
      ctl.abort(err);
      await sink.abort();
      throw ctl.signal.reason || err;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 回收关闭的标签页、被终止的 Worker 或未完成的清理遗留的 OPFS 临时文件：
   * 没有被持有 Web Lock 的即为垃圾；不支持 Web Locks 时只删除一天未改动的文件。
   */
  async function collectGarbage() {
    if (!opfsSupported()) return;
    try {
      const dir = await opfsDir();
      const found = [];
      for await (const [name, handle] of dir.entries()) {
        const match = handle.kind === 'file' && name.match(/^(.+?)(?:-defrag)?\.m4a$/);
        if (match) found.push([name, match[1], handle]);
      }
      // 先列文件再查锁：下载总是先拿锁再建文件，列到的文件若仍在使用，此时锁必已持有；
      // 反过来先查锁，查询之后才新建的下载会被误判为垃圾
      const held = navigator.locks ? new Set((await navigator.locks.query()).held.map((l) => l.name)) : null;
      const garbage = [];
      for (const [name, id, handle] of found) {
        if (held ? held.has(LOCK_PREFIX + id) : Date.now() - (await handle.getFile()).lastModified < STALE_MS) continue;
        garbage.push(name);
      }
      // 遍历结束后再删除：遍历目录时修改目录的行为未定义
      for (const name of garbage) await dir.removeEntry(name).catch(() => {});
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
    collectGarbage,
    opfsSupported,
    supported,
  };
})(typeof window !== 'undefined' ? window : globalThis);

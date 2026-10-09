import { parseMedia, fetchResource } from './hls.mjs';
import { BrowserCaptions } from './captions.mjs';

export class Core {
  constructor() {
    this.worker = new Worker('/assets/media-worker.js'); this.pending = new Map(); this.next = 0;
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id); if (!p) return;
      this.pending.delete(data.id); data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
    };
    this.worker.onerror = e => this.close(new Error(e.message || 'MV worker failed'));
  }
  call(method, ...args) {
    if (!this.worker) return Promise.reject(new Error('MV worker is closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.next; this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
  }
  close(error = new DOMException('Cancelled', 'AbortError')) {
    this.worker?.terminate(); this.worker = null;
    for (const p of this.pending.values()) p.reject(error); this.pending.clear();
  }
}
export async function fetchMaster(id, signal) {
  return window.AmWrapper.mvMaster(id, signal);
}
export function mime(track, video) {
  const codecs = video ? (track.CODECS || '').split(',').filter(c => /^(avc|hvc|hev|dvh|dvhe|av01)/.test(c)).join(',') : track.codec;
  return `${video ? 'video' : 'audio'}/mp4; codecs="${codecs}"`;
}
async function prepare(core, id, track, name, signal) {
  const res = await fetch(track.url, { signal });
  if (!res.ok) throw new Error(`Playlist HTTP ${res.status}`);
  const playlist = parseMedia(await res.text(), track.url);
  const initRef = JSON.stringify(playlist.init);
  if (playlist.segments.some(s => JSON.stringify(s.init) !== initRef)) throw new Error('Changing initialization segments are not supported');
  const keys = new Map();
  for (const uri of new Set(playlist.segments.map(s => s.key).filter(Boolean))) {
    const challenge = await core.call('challenge', uri);
    try {
      const data = await window.AmWrapper.license({ adamId: id, uri: challenge.uri, challenge: challenge.challenge, 'drm-type': 'pr' }, signal);
      keys.set(uri, await core.call('license', challenge.session, data.license));
    } finally { if (!signal.aborted) await core.call('closeSession', challenge.session); }
  }
  const raw = await fetchResource(playlist.init, signal);
  const init = await core.call('init', name, raw, name === 'video' ? 1 : 100);
  // Prime decode origins from segment zero even when the user's first action is a seek.
  const firstRaw = await fetchResource(playlist.segments[0], signal);
  const firstClear = await core.call('fragment', name, firstRaw, keys.get(playlist.segments[0].key) || new Uint8Array(16), false, 0);
  return { ...playlist, keys, init, name, track, firstRaw, firstClear };
}
async function preparePair(core, id, video, audio, signal) {
  // Sequential initialization avoids duplicate work after a failed license.
  return [await prepare(core, id, video, 'video', signal), await prepare(core, id, audio, 'audio', signal)];
}
async function fragment(core, stream, segment, signal, mux = false, sequence = 0) {
  if (segment === stream.segments[0] && !mux) return stream.firstClear;
  const raw = segment === stream.segments[0] ? stream.firstRaw : await fetchResource(segment, signal);
  return core.call('fragment', stream.name, raw, stream.keys.get(segment.key) || new Uint8Array(16), mux, sequence);
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
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

export class Playback {
  constructor(video, onStatus, onError) {
    this.video = video; this.onStatus = onStatus; this.onError = onError;
    this.controller = new AbortController(); this.core = new Core();
  }
  async start(id, videoTrack, audioTrack, captionMetadata = []) {
    const signal = this.controller.signal, video = this.video;
    const types = [mime(videoTrack, true), mime(audioTrack, false)];
    if (!globalThis.MediaSource || types.some(t => !MediaSource.isTypeSupported(t))) throw new Error('Selected codec is not supported by this browser; select another video/audio track or download it.');
    this.streams = await preparePair(this.core, id, videoTrack, audioTrack, signal);
    this.source = new MediaSource(); this.url = URL.createObjectURL(this.source);
    await event(this.source, 'sourceopen', signal, () => { video.src = this.url; });
    this.source.duration = Math.max(...this.streams.map(s => s.duration));
    this.buffers = types.map(t => this.source.addSourceBuffer(t));
    this.done = [false, false];
    for (let i = 0; i < 2; i++) await event(this.buffers[i], 'updateend', signal, () => this.buffers[i].appendBuffer(this.streams[i].init));
    this.captions = new BrowserCaptions(video, this.streams[0].init, captionMetadata.filter(m => m['GROUP-ID'] === videoTrack['CLOSED-CAPTIONS']));
    this.onStatus('buffering');
    this.mediaError = () => this.fail(new Error(video.error?.message || 'Video decoding failed'));
    video.addEventListener('error', this.mediaError);
    this.streams.forEach((s, i) => this.pump(s, i).catch(e => { if (!signal.aborted) this.fail(e); }));
    // Autoplay can be blocked after license acquisition; native controls remain available.
    video.play().catch(() => this.onStatus('pressPlay'));
  }
  fail(error) { this.stop(); this.onError(error); }
  async pump(stream, index) {
    const signal = this.controller.signal, buffer = this.buffers[index]; let next = 0;
    while (!signal.aborted) {
      const now = this.video.currentTime;
      const end = contains(buffer.buffered, now);
      if (end === null && now < stream.duration - 0.1) {
        next = stream.segments.findIndex(s => s.start + s.duration > now + 0.01);
        this.done[index] = false;
      }
      // Seeking backwards must also discard distant future islands.
      if (buffer.buffered.length && buffer.buffered.end(buffer.buffered.length - 1) > now + 60) {
        await event(buffer, 'updateend', signal, () => buffer.remove(now + 45, Infinity));
      }
      if (next < 0 || next >= stream.segments.length || (end !== null && end - now > 25)) {
        this.done[index] = next >= stream.segments.length;
        if (this.done.every(Boolean) && this.source.readyState === 'open' && this.buffers.every(b => !b.updating)) this.source.endOfStream();
        await delay(150, signal); continue;
      }
      const segment = stream.segments[next];
      // Evict old frames so memory does not grow with video length.
      if (now > 35 && buffer.buffered.length && buffer.buffered.start(0) < now - 35) {
        await event(buffer, 'updateend', signal, () => buffer.remove(0, now - 30));
      }
      const data = await fragment(this.core, stream, segment, signal);
      signal.throwIfAborted();
      // A seek may have happened during a slow CDN request. The next loop selects its segment.
      await event(buffer, 'updateend', signal, () => buffer.appendBuffer(data));
      if (index === 0) this.captions.append(data, next, segment.start, segment.start + segment.duration);
      if (!this.started && this.buffers.every(b => b.buffered.length)) {
        this.started = true;
        const start = Math.max(...this.buffers.map(b => b.buffered.start(0)));
        if (this.video.currentTime < start) this.video.currentTime = start;
      }
      next++; this.onStatus('playing');
    }
  }
  stop() {
    this.controller.abort(); this.core.close();
    this.captions?.destroy();
    this.video.removeEventListener('error', this.mediaError);
    this.video.pause(); this.video.removeAttribute('src'); this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
  }
}

function moofCount(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let count = 0;
  for (let p = 0; p + 8 <= bytes.length;) {
    let size = view.getUint32(p); if (size === 1) size = Number(view.getBigUint64(p + 8));
    if (size < 8 || p + size > bytes.length) throw new Error('Invalid output fragment');
    if (view.getUint32(p + 4) === 0x6d6f6f66) count++; p += size;
  }
  return count;
}
const PREFIX = 'am-hook-mv-', STALE_MS = 24 * 3600e3;
// Each download holds a Web Lock named after its files until they are disposed. The browser
// drops the lock when the tab closes or crashes, so an unlocked entry is garbage.
function hold(uuid) {
  if (!navigator.locks) return Promise.resolve(() => {});
  let release; const held = new Promise(r => { release = r; });
  return new Promise(resolve => {
    navigator.locks.request(PREFIX + uuid, () => { resolve(release); return held; }).catch(() => resolve(() => {}));
  });
}
// A just-terminated worker releases its sync access handles a moment later and deletion fails until then,
// so retry with backoff for about 3 s. A missing file counts as removed; anything left goes to collectGarbage.
async function remove(root, name) {
  for (let wait = 50; ; wait *= 2) {
    try { await root.removeEntry(name); return; } catch (e) {
      if (e?.name === 'NotFoundError' || wait > 1600) return;
      await new Promise(r => setTimeout(r, wait));
    }
  }
}
// Removes OPFS files left by closed tabs, killed workers or an unfinished pagehide cleanup.
// Without Web Locks, only entries untouched for a day are removed.
export async function collectGarbage() {
  if (!navigator.storage?.getDirectory) return;
  try {
    const root = await navigator.storage.getDirectory();
    const found = [];
    for await (const [name, handle] of root.entries()) {
      const match = handle.kind === 'file' && name.match(/^am-hook-mv-(.+?)\.f?mp4$/);
      if (match) found.push([name, match[1], handle]);
    }
    // List before querying locks: a download takes its lock before creating files, so any listed file
    // still in use is locked by now. Querying first would treat a download started in between as garbage.
    const held = navigator.locks ? new Set((await navigator.locks.query()).held.map(l => l.name)) : null;
    const garbage = [];
    for (const [name, uuid, handle] of found) {
      if (held ? held.has(PREFIX + uuid) : Date.now() - (await handle.getFile()).lastModified < STALE_MS) continue;
      garbage.push(name);
    }
    // Delete after iterating: mutating a directory while iterating it is unspecified.
    for (const name of garbage) await root.removeEntry(name).catch(() => {});
  } catch { /* best effort */ }
}
export async function downloadMV(id, video, audio, { signal, onProgress, onDefrag }) {
  if (!navigator.storage?.getDirectory) throw new Error('OPFS requires HTTPS or localhost and a supported browser');
  await collectGarbage();
  const root = await navigator.storage.getDirectory();
  const uuid = crypto.randomUUID(), fragmented = `${PREFIX}${uuid}.fmp4`, name = `${PREFIX}${uuid}.mp4`;
  const unlock = await hold(uuid);
  let handle;
  try { handle = await root.getFileHandle(fragmented, { create: true }); } catch (e) { unlock(); throw e; }
  const core = new Core(); let writer, complete = false;
  const abort = () => core.close(); signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    writer = await handle.createWritable();
    const streams = await preparePair(core, id, video, audio, signal);
    const duration = Math.max(...streams.map(s => s.duration));
    // The fragmented file and the progressive copy coexist while defragmenting: about twice the output size.
    const estimate = Number(video['AVERAGE-BANDWIDTH'] || video.BANDWIDTH) / 8 * duration;
    const { quota, usage } = await navigator.storage.estimate?.() ?? {};
    if (quota && estimate && quota - (usage || 0) < estimate * 2.1) throw new Error('Not enough OPFS storage quota for this download');
    const init = await core.call('muxInit', 'video', 'audio', duration);
    await writer.write(init);
    const queue = streams.flatMap(s => s.segments.map(segment => ({ stream: s, segment })))
      .sort((a, b) => a.segment.start - b.segment.start || (a.stream.name === 'video' ? -1 : 1));
    let sequence = 1, bytes = init.length, done = 0;
    for (const { stream, segment } of queue) {
      signal.throwIfAborted();
      const data = await fragment(core, stream, segment, signal, true, sequence);
      sequence += moofCount(data); await writer.write(data); bytes += data.length;
      onProgress(++done / queue.length, bytes);
    }
    signal.throwIfAborted(); await writer.close(); writer = null;
    // Rewrite the interleaved fragments as a progressive MP4 (ftyp, moov, mdat).
    onDefrag?.();
    await core.call('defrag', fragmented, name);
    signal.throwIfAborted();
    const file = await (await root.getFileHandle(name)).getFile(); complete = true;
    return { file, dispose: () => remove(root, name).finally(unlock) };
  } finally {
    signal.removeEventListener('abort', abort); core.close();
    if (writer) await writer.abort().catch(() => {});
    await remove(root, fragmented);
    if (!complete) { await remove(root, name); unlock(); }
  }
}

// Artist-uploaded videos (music.apple.com/{cc}/post/{id}) are unencrypted progressive MP4s with moov first,
// served with CORS and Range support, so the browser plays them directly like music.apple.com does.
export class DirectPlayback {
  constructor(video, onStatus, onError) { this.video = video; this.onStatus = onStatus; this.onError = onError; }
  async start(url) {
    const video = this.video;
    this.mediaError = () => { const message = video.error?.message || 'Video decoding failed'; this.stop(); this.onError(new Error(message)); };
    this.waiting = () => this.onStatus('buffering');
    this.playing = () => this.onStatus('playing');
    video.addEventListener('error', this.mediaError); video.addEventListener('waiting', this.waiting); video.addEventListener('playing', this.playing);
    this.onStatus('buffering'); video.src = url;
    video.play().catch(e => { if (e.name !== 'AbortError') this.onStatus('pressPlay'); });
  }
  stop() {
    const video = this.video;
    video.removeEventListener('error', this.mediaError); video.removeEventListener('waiting', this.waiting); video.removeEventListener('playing', this.playing);
    video.pause(); video.removeAttribute('src'); video.load();
  }
}
// Streams a progressive MP4 to OPFS (same naming and locks as MV downloads, so collectGarbage covers it);
// without OPFS (plain-HTTP LAN access) it falls back to an in-memory Blob.
export async function downloadDirect(url, { signal, onProgress }) {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`Video HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  let bytes = 0;
  const progress = new TransformStream({ transform(chunk, controller) {
    bytes += chunk.length; onProgress(total ? bytes / total : 0, bytes); controller.enqueue(chunk);
  } });
  const body = res.body.pipeThrough(progress, { signal });
  if (!navigator.storage?.getDirectory) {
    const file = await new Response(body).blob();
    return { file: new File([file], 'video.mp4', { type: 'video/mp4' }), dispose: async () => {} };
  }
  await collectGarbage();
  const root = await navigator.storage.getDirectory();
  const uuid = crypto.randomUUID(), name = `${PREFIX}${uuid}.mp4`;
  const unlock = await hold(uuid);
  let complete = false;
  try {
    const { quota, usage } = await navigator.storage.estimate?.() ?? {};
    if (quota && total && quota - (usage || 0) < total * 1.05) throw new Error('Not enough OPFS storage quota for this download');
    const handle = await root.getFileHandle(name, { create: true });
    await body.pipeTo(await handle.createWritable(), { signal });
    const file = await handle.getFile(); complete = true;
    return { file, dispose: () => remove(root, name).finally(unlock) };
  } finally {
    if (!complete) { await remove(root, name); unlock(); }
  }
}

/* PlayReady and Widevine licenses, MP4 decryption, muxing and defragmentation (media.wasm, crates/am-media) run here, away from the UI thread.
 * Messages: { id, method, args } -> { id, result } | { id, error }. */
'use strict';

const encoder = new TextEncoder(), decoder = new TextDecoder();
// Host files for defrag: FileSystemSyncAccessHandle or an in-memory stand-in.
const files = new Map();
let wasm;
const memory = () => new Uint8Array(wasm.memory.buffer);
const imports = { env: {
  random_fill: (ptr, len) => { crypto.getRandomValues(new Uint8Array(wasm.memory.buffer, ptr, len)); },
  file_size: h => files.get(h).getSize(),
  file_read: (h, ptr, len, at) => files.get(h).read(new Uint8Array(wasm.memory.buffer, ptr, len), { at }),
  file_write: (h, ptr, len, at) => files.get(h).write(new Uint8Array(wasm.memory.buffer, ptr, len), { at }),
} };
const module = fetch('/assets/media/media.wasm').then(res => {
  if (!res.ok) throw new Error(`WASM HTTP ${res.status}`);
  return res.arrayBuffer();
}).then(bytes => WebAssembly.compile(bytes));
// A trap leaves the instance unusable; the next call starts a fresh one.
async function instance() {
  if (!wasm) wasm = (await WebAssembly.instantiate(await module, imports)).exports;
  return wasm;
}

/** Calls fn with byte/string arguments copied into wasm memory (each as ptr, len); returns a copy of the result. */
function invoke(fn, ...args) {
  const held = [];
  const flat = args.flatMap(a => {
    if (typeof a === 'string') a = encoder.encode(a);
    if (!(a instanceof Uint8Array)) return [a];
    const ptr = wasm.media_alloc(a.length);
    memory().set(a, ptr); held.push([ptr, a.length]);
    return [ptr, a.length];
  });
  try {
    if (!wasm[fn](...flat)) {
      const ptr = wasm.media_error_ptr();
      throw new Error(decoder.decode(memory().subarray(ptr, ptr + wasm.media_error_len())));
    }
    const ptr = wasm.media_result_ptr();
    return memory().slice(ptr, ptr + wasm.media_result_len());
  } finally { for (const [ptr, len] of held) wasm.media_free(ptr, len); }
}
const size = bytes => Number(new DataView(bytes.buffer).getBigUint64(0));

function withFiles(input, output, fn) {
  files.set(1, input); files.set(2, output);
  try { return fn(1, 2); } finally { files.clear(); }
}

// CRC-32 (ZIP) of the defrag output, updated as the core writes it front to back, so
// packaging an album as a ZIP needs no second read of the file.
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crcWriter(target) {
  let crc = ~0, next = 0, ordered = true;
  return {
    getSize: () => target.getSize(),
    write(view, opts) {
      if (opts.at !== next) ordered = false;
      for (let i = 0; i < view.length; i++) crc = CRC_TABLE[(crc ^ view[i]) & 0xff] ^ (crc >>> 8);
      next = opts.at + view.length;
      return target.write(view, opts);
    },
    // null if the core ever wrote out of order (the caller then reads the file to compute it)
    crc: () => (ordered ? (~crc) >>> 0 : null),
  };
}

// Synchronous OPFS handles are worker-only; the core streams through them without buffering the file.
async function defrag(song, input, output, dir, tags, crc = !!song) {
  let folder = await navigator.storage.getDirectory();
  if (dir) folder = await folder.getDirectoryHandle(dir);
  const source = await (await folder.getFileHandle(input)).createSyncAccessHandle();
  let target;
  try {
    target = await (await folder.getFileHandle(output, { create: true })).createSyncAccessHandle();
    target.truncate(0);
    // MV files skip the CRC unless they go into a ZIP
    const writer = crc ? crcWriter(target) : target;
    const length = size(withFiles(source, writer, (i, o) => invoke('media_defrag', i, o, song, tags || new Uint8Array(0))));
    target.flush();
    return { size: length, crc: crc ? writer.crc() : null };
  } finally { source.close(); target?.close(); }
}
// Without OPFS (e.g. plain HTTP), the same code reads a Blob's bytes and returns a Blob.
async function defragBlob(blob, tags) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), parts = [];
  let length = 0;
  const source = { getSize: () => bytes.length, read: (view, { at }) => { const part = bytes.subarray(at, at + view.length); view.set(part); return part.length; } };
  const writer = crcWriter({ getSize: () => length, write: (view, { at }) => {
    if (at !== length) return -1;
    parts.push(view.slice()); length += view.length; return view.length;
  } });
  withFiles(source, writer, (i, o) => invoke('media_defrag', i, o, 1, tags || new Uint8Array(0)));
  return { blob: new Blob(parts, { type: blob.type }), size: length, crc: writer.crc() };
}

const methods = {
  // challenge(uri, drm?) -> { session, uri, challenge }: drm 'widevine' (CENC songs) or PlayReady by default (MVs).
  challenge: (uri, drm) => JSON.parse(decoder.decode(invoke('media_challenge', drm === 'widevine' ? 1 : 0, uri, Math.floor(Date.now() / 1000)))),
  license: (session, license) => invoke('media_license', session, license),
  closeSession: session => { invoke('media_close_session', session); },
  init: (name, raw, base) => invoke('media_init', name, raw, base),
  fragment: (name, raw, key, mux, sequence) => invoke('media_fragment', name, raw, key, mux ? 1 : 0, sequence),
  muxInit: (video, audio, duration) => invoke('media_mux_init', video, audio, duration),
  release: name => { invoke('media_release', name); },
  // defrag(input, output, tags?, crc?) -> { size, crc }: the MV layout; crc is null unless asked for.
  defrag: (input, output, tags, crc) => defrag(0, input, output, undefined, tags, !!crc),
  // defragSong(blob, tags) -> { blob, size, crc } or defragSong(input, output, dir, tags) -> { size, crc }:
  // the reference song layout; tags (Uint8Array, may be omitted) are the ilst items (see mp4-tags.mjs).
  defragSong: (...args) => args[0] instanceof Blob ? defragBlob(args[0], args[1]) : defrag(1, ...args),
};
self.onmessage = async ({ data: { id, method, args } }) => {
  try {
    if (!Object.hasOwn(methods, method)) throw new Error('Unknown media operation');
    await instance();
    const result = await methods[method](...args);
    self.postMessage({ id, result }, result instanceof Uint8Array ? [result.buffer] : []);
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) wasm = null;
    self.postMessage({ id, error: error.message });
  }
};

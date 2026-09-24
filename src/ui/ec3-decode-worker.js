/* E-AC-3 fMP4 packets -> planar float PCM. The decoder is loaded only for EC-3 playback. */
'use strict';

let modulePromise;
let decoder;
let ctx = 0;

function boxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let p = start; p + 8 <= end;) {
    let size = view.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    let header = 8;
    if (size === 1) { size = Number(view.getBigUint64(p + 8)); header = 16; }
    else if (size === 0) size = end - p;
    if (size < header || p + size > end) throw new Error(`Invalid MP4 ${type} box`);
    out.push({ type, start: p, body: p + header, end: p + size });
    p += size;
  }
  return out;
}

function child(bytes, parent, type) {
  const result = boxes(bytes, parent.body, parent.end).find((box) => box.type === type);
  if (!result) throw new Error(`Missing MP4 ${type} box`);
  return result;
}

function top(bytes, type) { return child(bytes, { body: 0, end: bytes.length }, type); }

function samplesFromFragment(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moof = top(bytes, 'moof');
  const traf = child(bytes, moof, 'traf');
  const tfhd = child(bytes, traf, 'tfhd');
  const flags = view.getUint32(tfhd.body) & 0xffffff;
  let cursor = tfhd.body + 8;
  if (flags & 0x01) cursor += 8;
  if (flags & 0x02) cursor += 4;
  const defaultSize = flags & 0x10 ? view.getUint32(cursor + (flags & 0x08 ? 4 : 0)) : 0;
  const out = [];
  let nextData = top(bytes, 'mdat').body;
  for (const trun of boxes(bytes, traf.body, traf.end).filter((box) => box.type === 'trun')) {
    const runFlags = view.getUint32(trun.body) & 0xffffff;
    const count = view.getUint32(trun.body + 4);
    if (count > 100000) throw new Error('Too many EC-3 samples');
    let pos = trun.body + 8;
    let data = nextData;
    if (runFlags & 0x01) { data = moof.start + view.getInt32(pos); pos += 4; }
    if (runFlags & 0x04) pos += 4;
    for (let i = 0; i < count; i++) {
      if (runFlags & 0x100) pos += 4;
      const size = runFlags & 0x200 ? view.getUint32(pos) : defaultSize;
      if (runFlags & 0x200) pos += 4;
      if (runFlags & 0x400) pos += 4;
      if (runFlags & 0x800) pos += 4;
      if (!size || pos > trun.end || data < 0 || data + size > bytes.length) throw new Error('Invalid EC-3 sample range');
      out.push(bytes.subarray(data, data + size));
      data += size;
    }
    nextData = data;
  }
  if (!out.length) throw new Error('No EC-3 samples in fragment');
  return out;
}

async function ensureDecoder() {
  if (!modulePromise) modulePromise = Promise.all([
    import('/assets/ec3-runtime.mjs'),
    fetch('/assets/ec3.wasm').then((response) => {
      if (!response.ok) throw new Error(`EC-3 WASM HTTP ${response.status}`);
      return response.arrayBuffer();
    }),
  ]).then(([runtime, wasmBinary]) => runtime.default({ wasmBinary: new Uint8Array(wasmBinary) }));
  const module = await modulePromise;
  if (!decoder) {
    const wrap = (name, args) => module.cwrap(name, 'number', args);
    decoder = {
      module,
      open: wrap('init_decoder', ['number']),
      packet: wrap('configure_decode_packet', ['number', 'number']),
      decode: wrap('decode_packet', ['number', 'bigint']),
      format: wrap('get_decoded_format', ['number']),
      plane: wrap('get_decoded_plane_ptr', ['number', 'number']),
      channels: wrap('get_decoded_channels', ['number']),
      rate: wrap('get_decoded_sample_rate', ['number']),
      count: wrap('get_decoded_sample_count', ['number']),
      flush: wrap('flush_decoder', ['number']),
      close: wrap('close_decoder', ['number']),
    };
  }
  return decoder;
}

async function decodeFragment(buffer) {
  const d = await ensureDecoder();
  if (!ctx) {
    ctx = d.open(1); // 1 = E-AC-3, not AC-3.
    if (!ctx) throw new Error('Cannot open EC-3 decoder');
  }
  const frames = [];
  let channels = 0;
  let rate = 0;
  let total = 0;
  for (const packet of samplesFromFragment(new Uint8Array(buffer))) {
    const ptr = d.packet(ctx, packet.length);
    if (!ptr) throw new Error('EC-3 packet allocation failed');
    d.module.HEAPU8.set(packet, ptr);
    const result = d.decode(ctx, 0n);
    if (result < 0) throw new Error(`EC-3 decode failed (${result})`);
    if (d.format(ctx) !== 8) throw new Error('EC-3 decoder returned non-planar float PCM');
    const n = d.count(ctx);
    const ch = d.channels(ctx);
    const hz = d.rate(ctx);
    if (!(ch === 6 || ch === 8) || hz < 8000 || hz > 192000 || n < 1 || n > 8192) {
      throw new Error(`Unsupported EC-3 PCM format: ${ch} channels, ${hz} Hz`);
    }
    if (channels && (channels !== ch || rate !== hz)) throw new Error('EC-3 channel layout changed mid-segment');
    channels = ch; rate = hz;
    const planes = [];
    for (let i = 0; i < ch; i++) {
      const p = d.plane(ctx, i);
      if (!p) throw new Error('Missing EC-3 PCM plane');
      planes.push(new Float32Array(d.module.HEAPU8.slice(p, p + n * 4).buffer));
    }
    frames.push({ planes, count: n });
    total += n;
  }
  const pcm = new Float32Array(total * channels);
  let offset = 0;
  for (const frame of frames) {
    for (let ch = 0; ch < channels; ch++) pcm.set(frame.planes[ch], ch * total + offset);
    offset += frame.count;
  }
  return { pcm: pcm.buffer, channels, rate, samples: total };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.op === 'flush' && decoder && ctx) { decoder.flush(ctx); self.postMessage({ id: data.id, ok: true }); return; }
    const result = await decodeFragment(data.buf);
    self.postMessage({ id: data.id, ok: true, result }, [result.pcm]);
  } catch (error) {
    self.postMessage({ id: data.id, ok: false, error: error.message || String(error) });
  }
};

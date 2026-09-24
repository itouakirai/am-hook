/* ALAC fMP4 -> FLAC fMP4 for MSE. Loaded only when an ALAC track is played. */
'use strict';

const FLAC_WASM_URL = '/assets/flac.wasm';
// Minimal ftyp+moov reference from an FFmpeg FLAC fMP4; patchInit fills stream-specific fields.
const FLAC_INIT_URL = '/assets/flac-init.bin';
const MAX_FRAGMENT_BYTES = 1_500_000;
let wasmPromise;
let templatePromise;
let codec;
let sequence = 0;
let inputTimescale = 0;

function boxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = [];
  for (let p = start; p + 8 <= end;) {
    let size = view.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) throw new Error('Truncated MP4 large-size box');
      size = Number(view.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) throw new Error(`Invalid MP4 ${type} box`);
    result.push({ type, start: p, body: p + header, end: p + size });
    p += size;
  }
  return result;
}

function child(bytes, parent, type) {
  const found = boxes(bytes, parent.body, parent.end).find((box) => box.type === type);
  if (!found) throw new Error(`Missing MP4 ${type} box`);
  return found;
}

function top(bytes, type) {
  const found = boxes(bytes).find((box) => box.type === type);
  if (!found) throw new Error(`Missing MP4 ${type} box`);
  return found;
}

function fourcc(str) {
  return Uint8Array.from(str, (char) => char.charCodeAt(0));
}

function be32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function be64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

function join(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

function box(type, ...parts) {
  const payload = join(parts);
  return join([be32(payload.length + 8), fourcc(type), payload]);
}

async function wasm() {
  if (!wasmPromise) {
    wasmPromise = fetch(FLAC_WASM_URL).then(async (response) => {
      if (!response.ok) throw new Error(`FLAC WASM HTTP ${response.status}`);
      return (await WebAssembly.instantiate(await response.arrayBuffer())).instance.exports;
    });
  }
  return wasmPromise;
}

async function initTemplate() {
  if (!templatePromise) {
    templatePromise = fetch(FLAC_INIT_URL).then(async (response) => {
      if (!response.ok) throw new Error(`FLAC init HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    });
  }
  return templatePromise;
}

function withWasmInput(w, bytes, fn) {
  const ptr = w.flac_alloc(bytes.length);
  if (!ptr) throw new Error('FLAC WASM allocation failed');
  try {
    new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
    return fn(ptr, bytes.length);
  } finally {
    w.flac_free(ptr, bytes.length);
  }
}

function cookieFromInit(bytes) {
  const moov = top(bytes, 'moov');
  const trak = child(bytes, moov, 'trak');
  const mdia = child(bytes, trak, 'mdia');
  const mdhd = child(bytes, mdia, 'mdhd');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const timescaleOffset = mdhd.body + (bytes[mdhd.body] === 1 ? 20 : 12);
  inputTimescale = view.getUint32(timescaleOffset);
  if (!inputTimescale) throw new Error('Invalid ALAC track timescale');
  const stsd = child(bytes, child(bytes, child(bytes, mdia, 'minf'), 'stbl'), 'stsd');
  const entry = boxes(bytes, stsd.body + 8, stsd.end).find((item) => item.type === 'alac');
  if (!entry) throw new Error('Missing ALAC sample entry');
  const atom = boxes(bytes, entry.body + 28, entry.end).find((item) => item.type === 'alac');
  if (!atom) throw new Error('Missing ALAC magic cookie');
  return bytes.subarray(atom.start, atom.end);
}

function patchInit(template, rate, channels, bits, maxBlock) {
  const out = template.slice();
  const view = new DataView(out.buffer);
  const moov = top(out, 'moov');
  const trak = child(out, moov, 'trak');
  const mdia = child(out, trak, 'mdia');
  const mdhd = child(out, mdia, 'mdhd');
  view.setUint32(mdhd.body + 12, rate);
  const stsd = child(out, child(out, child(out, mdia, 'minf'), 'stbl'), 'stsd');
  const entry = child(out, { body: stsd.body + 8, end: stsd.end }, 'fLaC');
  view.setUint16(entry.start + 24, channels);
  view.setUint16(entry.start + 26, bits);
  // AudioSampleEntry's 16.16 field cannot represent rates above 65535.
  let entryRate = rate;
  while (entryRate > 65535 && entryRate % 2 === 0) entryRate /= 2;
  if (entryRate > 65535) entryRate = 65535;
  view.setUint32(entry.start + 32, entryRate << 16);
  const dfla = child(out, { body: entry.body + 28, end: entry.end }, 'dfLa');
  const streamInfo = dfla.body + 8; // FullBox(4) + metadata header(4)
  view.setUint16(streamInfo, 16);
  view.setUint16(streamInfo + 2, maxBlock);
  out.fill(0, streamInfo + 4, streamInfo + 10); // unknown frame sizes
  const packed = (BigInt(rate) << 44n) | (BigInt(channels - 1) << 41n) | (BigInt(bits - 1) << 36n);
  view.setBigUint64(streamInfo + 10, packed); // unknown total samples
  out.fill(0, streamInfo + 18, streamInfo + 34); // unknown MD5
  return out.buffer;
}

function sourceSamples(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moof = top(bytes, 'moof');
  const traf = child(bytes, moof, 'traf');
  const tfhd = child(bytes, traf, 'tfhd');
  const tfdt = child(bytes, traf, 'tfdt');
  const flags = view.getUint32(tfhd.body) & 0xffffff;
  let cursor = tfhd.body + 8;
  if (flags & 0x01) cursor += 8; // base_data_offset
  if (flags & 0x02) cursor += 4; // sample_description_index
  const defaultDuration = flags & 0x08 ? view.getUint32(cursor) : 0;
  if (flags & 0x08) cursor += 4;
  const defaultSize = flags & 0x10 ? view.getUint32(cursor) : 0;
  const baseTime = bytes[tfdt.body] === 1 ? view.getBigUint64(tfdt.body + 4) : BigInt(view.getUint32(tfdt.body + 4));
  const samples = [];
  let nextData = moof.start;
  for (const trun of boxes(bytes, traf.body, traf.end).filter((item) => item.type === 'trun')) {
    const runFlags = view.getUint32(trun.body) & 0xffffff;
    const count = view.getUint32(trun.body + 4);
    if (count > 100000) throw new Error('Too many ALAC samples');
    let pos = trun.body + 8;
    let data = nextData;
    if (runFlags & 0x01) {
      data = moof.start + view.getInt32(pos);
      pos += 4;
    }
    if (runFlags & 0x04) pos += 4;
    for (let i = 0; i < count; i++) {
      const duration = runFlags & 0x100 ? view.getUint32(pos) : defaultDuration;
      if (runFlags & 0x100) pos += 4;
      const size = runFlags & 0x200 ? view.getUint32(pos) : defaultSize;
      if (runFlags & 0x200) pos += 4;
      if (runFlags & 0x400) pos += 4;
      if (runFlags & 0x800) pos += 4;
      if (!size || data < 0 || data + size > bytes.length || pos > trun.end) throw new Error('Invalid ALAC sample range');
      samples.push({ bytes: bytes.subarray(data, data + size), duration });
      data += size;
    }
    nextData = data;
  }
  if (!samples.length) throw new Error('No ALAC samples in fragment');
  return { baseTime, samples };
}

function muxFragment(frames, baseTime) {
  const payload = join(frames.map((item) => item.bytes));
  const mfhd = box('mfhd', be32(0), be32(++sequence));
  const tfhd = box('tfhd', be32(0x020000), be32(1));
  const tfdt = box('tfdt', be32(0x01000000), be64(baseTime));
  const entries = frames.flatMap((item) => [be32(item.duration), be32(item.bytes.length)]);
  let trun = box('trun', be32(0x00000301), be32(frames.length), be32(0), ...entries);
  let moof = box('moof', mfhd, box('traf', tfhd, tfdt, trun));
  trun = box('trun', be32(0x00000301), be32(frames.length), be32(moof.length + 8), ...entries);
  moof = box('moof', mfhd, box('traf', tfhd, tfdt, trun));
  return boxPair(moof, box('mdat', payload)).buffer;
}

function boxPair(a, b) { return join([a, b]); }

async function openTrack(buf) {
  const w = await wasm();
  const cookie = cookieFromInit(new Uint8Array(buf));
  if (!withWasmInput(w, cookie, (ptr, len) => w.flac_open(ptr, len))) throw new Error('Unsupported ALAC track');
  codec = w;
  sequence = 0;
  return patchInit(await initTemplate(), w.flac_rate(), w.flac_channels(), w.flac_bits(), w.flac_max_block());
}

async function transcode(buf) {
  if (!codec) throw new Error('ALAC transcoder is not open');
  const { baseTime, samples } = sourceSamples(new Uint8Array(buf));
  const rate = codec.flac_rate();
  const start = baseTime * BigInt(rate) / BigInt(inputTimescale);
  const output = [];
  let frames = [];
  let frameBytes = 0;
  let fragmentStart = start;
  let sampleNumber = start;
  for (const sample of samples) {
    const encoded = withWasmInput(codec, sample.bytes, (ptr, len) => {
      if (!codec.flac_encode(ptr, len, Number(sampleNumber & 0xffffffffn), Number(sampleNumber >> 32n))) {
        throw new Error('ALAC packet decoding failed');
      }
      return new Uint8Array(codec.memory.buffer, codec.flac_frame_ptr(), codec.flac_frame_len()).slice();
    });
    const duration = codec.flac_samples();
    if (sample.duration && Math.abs(Number(BigInt(sample.duration) * BigInt(rate) / BigInt(inputTimescale)) - duration) > 1) {
      throw new Error('ALAC sample duration mismatch');
    }
    if (frames.length && frameBytes + encoded.length > MAX_FRAGMENT_BYTES) {
      output.push(muxFragment(frames, fragmentStart));
      frames = [];
      frameBytes = 0;
      fragmentStart = sampleNumber;
    }
    frames.push({ bytes: encoded, duration });
    frameBytes += encoded.length;
    sampleNumber += BigInt(duration);
  }
  if (frames.length) output.push(muxFragment(frames, fragmentStart));
  return output;
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = async ({ data }) => {
    const { id, op, buf } = data;
    try {
      const result = op === 'open' ? await openTrack(buf) : await transcode(buf);
      self.postMessage({ id, ok: true, result }, Array.isArray(result) ? result : [result]);
    } catch (error) {
      self.postMessage({ id, ok: false, error: error.message || String(error) });
    }
  };
}

if (typeof module !== 'undefined') module.exports = { boxes, cookieFromInit, patchInit, sourceSamples, muxFragment, openTrack, transcode };

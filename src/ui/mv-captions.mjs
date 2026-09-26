import Cea608Parser from './cea608.mjs';

// Apple MV captions are QuickTime c608 samples (cdat/cdt2), not video SEI.
// Read only caption samples from the already decrypted fragments, without IO.
function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = p => view.getUint32(p);
  const u64 = p => {
    const n = Number(view.getBigUint64(p));
    if (!Number.isSafeInteger(n)) throw new Error('Caption offset exceeds safe integer range');
    return n;
  };
  const type = p => String.fromCharCode(...bytes.subarray(p, p + 4));
  function boxes(start = 0, end = bytes.length) {
    const out = [];
    for (let p = start; p < end;) {
      if (p + 8 > end) throw new Error('Truncated caption MP4 box');
      let size = u32(p), header = 8;
      if (size === 1) { if (p + 16 > end) throw new Error('Truncated extended box'); size = u64(p + 8); header = 16; }
      if (size === 0) size = end - p;
      if (size < header || p + size > end) throw new Error('Invalid caption MP4 box size');
      out.push({ type: type(p + 4), start: p, data: p + header, end: p + size }); p += size;
    }
    return out;
  }
  const child = (parent, name) => parent && boxes(parent.data, parent.end).find(b => b.type === name);
  return { view, u32, u64, type, boxes, child };
}

export function captionTracks(init) {
  const r = reader(init), moov = r.boxes().find(b => b.type === 'moov');
  if (!moov) return [];
  const tracks = [], mvex = r.child(moov, 'mvex');
  const defaults = new Map((mvex ? r.boxes(mvex.data, mvex.end) : []).filter(b => b.type === 'trex')
    .map(b => [r.u32(b.data + 4), { duration: r.u32(b.data + 12), size: r.u32(b.data + 16) }]));
  for (const trak of r.boxes(moov.data, moov.end).filter(b => b.type === 'trak')) {
    const tkhd = r.child(trak, 'tkhd'), mdia = r.child(trak, 'mdia');
    const mdhd = r.child(mdia, 'mdhd'), minf = r.child(mdia, 'minf');
    const stsd = r.child(r.child(minf, 'stbl'), 'stsd');
    if (!tkhd || !mdhd || !stsd) continue;
    const entries = r.boxes(stsd.data + 8, stsd.end);
    if (!entries.some(b => b.type === 'c608')) continue;
    const id = r.u32(tkhd.data + (init[tkhd.data] === 1 ? 20 : 12));
    const timescale = r.u32(mdhd.data + (init[mdhd.data] === 1 ? 20 : 12));
    if (!timescale) throw new Error('Invalid caption timescale');
    tracks.push({ id, timescale, ...(defaults.get(id) || { duration: 0, size: 0 }) });
  }
  return tracks;
}

export function captionPackets(bytes, tracks) {
  if (!tracks.length) return [];
  const r = reader(bytes), packets = [], top = r.boxes();
  const mdats = top.filter(b => b.type === 'mdat');
  for (const moof of top.filter(b => b.type === 'moof')) {
    for (const traf of r.boxes(moof.data, moof.end).filter(b => b.type === 'traf')) {
      const tfhd = r.child(traf, 'tfhd'), tfdt = r.child(traf, 'tfdt');
      if (!tfhd || !tfdt) continue;
      const track = tracks.find(t => t.id === r.u32(tfhd.data + 4));
      if (!track) continue;
      const flags = r.u32(tfhd.data) & 0xffffff;
      let p = tfhd.data + 8, base = moof.start, duration = track.duration, size = track.size;
      if (flags & 1) { base = r.u64(p); p += 8; }
      if (flags & 2) p += 4;
      if (flags & 8) { duration = r.u32(p); p += 4; }
      if (flags & 16) { size = r.u32(p); p += 4; }
      if (p > tfhd.end) throw new Error('Truncated caption tfhd');
      let dts = bytes[tfdt.data] === 1 ? r.u64(tfdt.data + 4) : r.u32(tfdt.data + 4);
      let offset = null;
      for (const trun of r.boxes(traf.data, traf.end).filter(b => b.type === 'trun')) {
        const f = r.u32(trun.data) & 0xffffff, count = r.u32(trun.data + 4);
        p = trun.data + 8;
        if (f & 1) { offset = base + r.view.getInt32(p); p += 4; }
        if (f & 4) p += 4;
        if (offset === null) throw new Error('Missing caption sample data offset');
        // Bound work even for a malformed zero-size/default-value sample table.
        if (count > bytes.length / 2) throw new Error('Invalid caption sample count');
        for (let i = 0; i < count; i++) {
          let sampleDuration = duration, sampleSize = size, cts = 0;
          if (f & 0x100) { sampleDuration = r.u32(p); p += 4; }
          if (f & 0x200) { sampleSize = r.u32(p); p += 4; }
          if (f & 0x400) p += 4;
          if (f & 0x800) { cts = bytes[trun.data] === 1 ? r.view.getInt32(p) : r.u32(p); p += 4; }
          if (p > trun.end || !mdats.some(m => offset >= m.data && offset + sampleSize <= m.end)) throw new Error('Caption sample outside media data');
          for (const box of r.boxes(offset, offset + sampleSize)) {
            if (box.type !== 'cdat' && box.type !== 'cdt2') continue;
            if ((box.end - box.data) % 2) throw new Error('Incomplete CEA-608 byte pair');
            packets.push({ track: track.id, field: box.type === 'cdat' ? 1 : 3,
              time: (dts + cts) / track.timescale, bytes: bytes.slice(box.data, box.end) });
          }
          offset += sampleSize; dts += sampleDuration;
        }
      }
    }
  }
  return packets.sort((a, b) => a.time - b.time);
}

export class CaptionDecoder {
  constructor(emit) { this.emit = emit; this.parsers = new Map(); }
  parser(id, field) {
    const key = `${id}:${field}`;
    if (!this.parsers.has(key)) {
      const output = channel => ({ reset() {}, dispatchCue() {}, newCue: (start, end, screen) => {
        if (start === null || end <= start) return;
        screen.rows.forEach((row, line) => {
          const text = row.chars.map(c => c.uchar).join('').trim();
          if (text) this.emit({ track: id, channel, start, end, line, text });
        });
      } });
      this.parsers.set(key, new Cea608Parser(field, output(field), output(field + 1)));
    }
    return this.parsers.get(key);
  }
  add(packets) { for (const p of packets) this.parser(p.track, p.field).addData(p.time, p.bytes); }
  split(time) { for (const parser of this.parsers.values()) parser.cueSplitAtTime(time); }
  reset() { this.parsers.clear(); }
}

export class BrowserCaptions {
  constructor(video, init, metadata = []) {
    this.video = video; this.tracks = captionTracks(init); this.metadata = metadata;
    this.nodes = new Map(); this.cache = new Map(); this.last = -1; this.replaying = false;
    this.decoder = new CaptionDecoder(cue => {
      if (!this.replaying) { this.collecting.push(cue); this.cue(cue); }
    });
  }
  cue(data) {
    const key = `${data.track}:${data.channel}`;
    let node = this.nodes.get(key);
    if (!node) {
      const meta = this.metadata.find(m => m['INSTREAM-ID'] === `CC${data.channel}`);
      node = document.createElement('track'); node.kind = 'captions';
      node.label = meta?.NAME || `CC${data.channel}`; node.srclang = meta?.LANGUAGE || '';
      node.default = this.nodes.size === 0;
      node.captionCues = new Map();
      node.captionReady = false;
      // A source-less <track> asynchronously enters the failed load state and
      // Chrome can clear cues on a mode change. Load an empty, valid WebVTT first.
      node.captionUrl = URL.createObjectURL(new Blob(['WEBVTT\n\n'], { type: 'text/vtt' }));
      node.src = node.captionUrl;
      node.onload = () => {
        node.captionReady = true;
        for (const cue of node.captionCues.values()) node.track.addCue(cue);
        if (!node.default) node.track.mode = 'disabled';
      };
      this.video.append(node); node.track.mode = node.default ? 'showing' : 'hidden';
      this.nodes.set(key, node);
    }
    const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cue = new VTTCue(Math.max(0, data.start), data.end, escape(data.text));
    cue.id = `${data.start}:${data.end}:${data.line}:${data.text}`;
    // Native line snapping keeps bottom captions above the player's control bar.
    cue.snapToLines = true; cue.line = data.line >= 8 ? data.line - 15 : data.line;
    cue.position = 50; cue.align = 'center'; cue.size = 90;
    const previous = node.captionCues.get(cue.id);
    if (previous && node.captionReady) {
      try { node.track.removeCue(previous); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
    }
    if (node.captionReady) node.track.addCue(cue);
    node.captionCues.set(cue.id, cue);
  }
  append(bytes, index, start, end) {
    if (!this.tracks.length) return;
    if (this.cache.has(index)) {
      // MSE back-buffer removal may evict native cues as well. Reinstall fresh cue
      // objects when replaying a cached segment, replacing rather than duplicating.
      for (const cue of this.cache.get(index).cues) this.cue(cue);
      this.last = -1; return;
    }
    const packets = captionPackets(bytes, this.tracks);
    if (index !== this.last + 1) {
      this.decoder.reset(); this.replaying = true;
      // Recover pop-on/roll-up state from already loaded contiguous predecessors.
      let first = index; while (this.cache.has(first - 1)) first--;
      for (let i = first; i < index; i++) this.decoder.add(this.cache.get(i).packets);
      this.decoder.split(start); this.replaying = false;
    }
    this.collecting = [];
    this.decoder.add(packets); this.decoder.split(end);
    this.cache.set(index, { packets, cues: this.collecting }); this.last = index;
  }
  destroy() {
    for (const node of this.nodes.values()) {
      node.onload = null; node.track.mode = 'disabled'; node.remove(); URL.revokeObjectURL(node.captionUrl);
    }
    this.nodes.clear(); this.cache.clear(); this.decoder.reset();
  }
}

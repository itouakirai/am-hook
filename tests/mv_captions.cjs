// Offline caption extraction/decoding regression tests. No network or WASM required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const box = (type, ...parts) => { const data = Buffer.concat(parts); return Buffer.concat([u32(data.length + 8), Buffer.from(type), data]); };
const full = (type, flags, ...parts) => box(type, u32(flags), ...parts);
const trackID = 2, timescale = 1000;
const init = box('moov', box('trak',
  full('tkhd', 0, u32(0), u32(0), u32(trackID)),
  box('mdia', full('mdhd', 0, u32(0), u32(0), u32(timescale)),
    box('minf', box('stbl', full('stsd', 0, u32(1), box('c608', Buffer.alloc(8))))))),
  box('mvex', full('trex', 0, u32(trackID), u32(1), u32(1000), u32(0), u32(0))));
const hello = [0x14, 0x20, 0x48, 0x45, 0x4c, 0x4c, 0x4f, 0x00, 0x14, 0x2f];
const erase = [0x14, 0x2c];
function fragment(samples, { base = 0, field = 'cdat', cts = null, defaultSize = false } = {}) {
  const data = samples.map(s => box(field, Buffer.from(s)));
  const tfhd = full('tfhd', defaultSize ? 0x020010 : 0x020000, u32(trackID), ...(defaultSize ? [u32(data[0].length)] : []));
  const trun = offset => full('trun', 1 | (defaultSize ? 0 : 0x200) | (cts !== null ? 0x01000800 : 0),
    u32(data.length), u32(offset), ...data.flatMap(d => [...(defaultSize ? [] : [u32(d.length)]), ...(cts !== null ? [u32(cts)] : [])]));
  const moof = offset => box('moof', box('traf', tfhd, full('tfdt', 0, u32(base)), trun(offset)));
  return Buffer.concat([moof(moof(0).length + 8), box('mdat', ...data)]);
}
(async () => {
  const source = fs.readFileSync('src/ui/mv-captions.mjs', 'utf8').replace('./cea608.mjs', pathToFileURL(path.resolve('src/ui/mv-cea608.mjs')).href);
  const { captionTracks, captionPackets, CaptionDecoder, BrowserCaptions } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const tracks = captionTracks(init);
  assert.deepEqual(tracks, [{ id: 2, timescale: 1000, duration: 1000, size: 0 }]);
  const packets = captionPackets(fragment([hello, erase]), tracks);
  assert.deepEqual(packets.map(p => p.time), [0, 1]);
  assert.deepEqual(Array.from(packets[0].bytes), hello);
  const cues = [], decoder = new CaptionDecoder(c => cues.push(c));
  decoder.add(packets);
  assert.equal(cues[0].text, 'HELLO'); assert.equal(cues[0].start, 0); assert.equal(cues[0].end, 1);
  decoder.reset(); cues.length = 0;
  decoder.add(captionPackets(fragment([hello], { field: 'cdt2', base: 1000, cts: -100, defaultSize: true }), tracks));
  decoder.split(2);
  assert.equal(cues[0].channel, 3); assert.equal(cues[0].start, 0.9); assert.equal(cues[0].end, 2);
  assert.throws(() => captionPackets(fragment([hello]).subarray(0, -1), tracks), /size/);
  assert.throws(() => captionPackets(fragment([[0x14]]), tracks), /pair/);
  assert.deepEqual(captionPackets(new Uint8Array(), []), []);

  // Track lifecycle, subtitle opt-out, repeated fragments and decoder state across seeks.
  const nodes = [];
  global.document = { createElement: () => ({ track: { mode: '', cues: [], addCue(c) { this.cues.push(c); }, removeCue(c) { const i = this.cues.indexOf(c); if (i < 0) throw new DOMException('Missing cue', 'NotFoundError'); this.cues.splice(i, 1); } }, remove() { nodes.splice(nodes.indexOf(this), 1); } }) };
  global.VTTCue = class { constructor(start, end, text) { Object.assign(this, { startTime: start, endTime: end, text }); } };
  const captions = new BrowserCaptions({ append: n => nodes.push(n) }, init, [{ 'INSTREAM-ID': 'CC1', NAME: 'English', LANGUAGE: 'en' }]);
  captions.append(fragment([hello]), 0, 0, 1);
  assert.equal(nodes[0].track.cues.length, 0, 'wait for native WebVTT initialization before adding cues');
  nodes[0].onload();
  assert.equal(nodes.length, 1); assert.equal(nodes[0].track.mode, 'showing'); assert.equal(nodes[0].label, 'English');
  const count = nodes[0].track.cues.length;
  captions.append(fragment([hello]), 0, 0, 1);
  assert.equal(nodes[0].track.cues.length, count, 're-appending does not duplicate cues');
  nodes[0].track.cues.length = 0; // Simulate native cue eviction alongside the MSE back buffer.
  captions.append(fragment([hello]), 0, 0, 1);
  assert.equal(nodes[0].track.cues.length, count, 'backward seek restores evicted native cues');
  nodes[0].track.mode = 'disabled';
  captions.append(fragment([[0, 0]], { base: 1000 }), 1, 1, 2);
  assert.equal(nodes[0].track.mode, 'disabled', 'buffering respects the subtitle switch');
  assert.equal(nodes[0].track.cues.at(-1).text, 'HELLO', 'cached predecessor recovers displayed caption');
  captions.append(fragment([[0, 0]], { base: 10000 }), 10, 10, 11);
  assert(nodes[0].track.cues.every(c => c.startTime < 10), 'a seek cannot carry old text into a gap');
  captions.destroy(); assert.equal(nodes.length, 0, 'stop/switch removes subtitle tracks');
  console.log('MV captions: c608 extraction, CEA-608 decoding, timestamp/field handling, seek state, toggle and cleanup passed.');
})().catch(e => { console.error(e); process.exitCode = 1; });

// Live source-repair regression. Start am-hook --hook with wrapper-lite, then:
// AM_HOOK_URL=http://127.0.0.1:8888 node tests/alac_source_recovery.cjs <playwright-path>
// Compares server Range output, browser workers, and unmodified temari plaintext.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.argv[2] || 'playwright');
const { sourceSamples } = require('../src/ui/flac-transcode-worker.js');
const origin = process.env.AM_HOOK_URL || 'http://127.0.0.1:8888';

(async () => {
  const w = (await WebAssembly.instantiate(fs.readFileSync(`${__dirname}/../src/ui/hook.wasm`))).instance.exports;
  const input = (bytes, fn) => {
    const ptr = w.hook_alloc(bytes.length);
    try {
      new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
      return fn(ptr, bytes.length);
    } finally { w.hook_free(ptr, bytes.length); }
  };
  let handle = 0, repaired = 0, packets = 0;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.exposeFunction('setTemplate', json => {
      handle = input(Buffer.from(json), (ptr, len) => w.hook_template_load(ptr, len));
      assert(handle);
    });
    await page.exposeFunction('verifySource', (encrypted, clear, fixed) => {
      const before = input(Buffer.from(encrypted, 'base64'), (ptr, len) => {
        assert.equal(w.hook_decrypt_fragment(fixed ? w.hook_fixed_template() : handle, ptr, len), 1);
        return Buffer.from(new Uint8Array(w.memory.buffer, ptr, len));
      });
      const after = Buffer.from(clear, 'base64');
      assert.equal(after.length, before.length);
      const raw = sourceSamples(before).samples;
      const output = sourceSamples(after).samples;
      assert.equal(raw.length, output.length);
      const expected = Buffer.from(before);
      for (let i = 0; i < raw.length; i++) {
        packets++;
        const a = raw[i].bytes, b = output[i].bytes;
        assert.equal(a.length, b.length);
        assert.equal(raw[i].duration, output[i].duration);
        if (Buffer.from(a).equals(Buffer.from(b))) continue;
        // This regression track's damaged packets are 4096-frame, 16-bit stereo
        // escape elements: 23 header bits, then 131072 PCM bits, then TYPE_END.
        assert.equal(a.length, 16388);
        assert.equal(a[0], 0x20);
        assert.equal(a[1], 0);
        assert.equal(a[2] & 0xfe, 2);
        assert.equal(raw[i].duration, 4096);
        const end = 23 + 4096 * 2 * 16;
        for (let bit = 0; bit < end; bit++) {
          const mask = 0x80 >> (bit % 8);
          assert.equal(a[bit >> 3] & mask, b[bit >> 3] & mask, 'PCM/header changed');
        }
        for (let bit = end; bit < end + 3; bit++) assert(b[bit >> 3] & (0x80 >> (bit % 8)));
        expected.set(b, a.byteOffset - before.byteOffset);
        repaired++;
      }
      assert.deepEqual(after, expected, 'bytes outside repaired packets changed');
    });
    await page.goto(`${origin}/https://music.apple.com/cn/song/_/1691044818`);
    await page.evaluate(async () => {
      const base64 = buf => {
        let s = ''; const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return btoa(s);
      };
      const data = await (await fetch('/parse/1691044818')).json();
      if (!data.hook) throw new Error('This test requires --hook');
      const url = new URL(data.variants.find(v => v.codecs === 'alac').uri, data.masterUrl).href;
      const track = await AmDecrypt.openTrack(url);
      await setTemplate(await track.template());
      // Seek/download-style access: a fragment can be requested before init.
      for (let start = 0; start < track.segments.length; start += 4) {
        await Promise.all(track.segments.slice(start, start + 4).map(async segment => {
          const encrypted = await track.fetchPiece(segment);
          const clear = await track.decryptPiece(segment, encrypted.slice(0));
          const response = await fetch('/' + track.url, { headers: { Range: `bytes=${segment.start}-${segment.end}` } });
          if (response.status !== 206) throw new Error('Server Range request failed');
          const server = new Uint8Array(await response.arrayBuffer()), web = new Uint8Array(clear);
          if (server.length !== web.length || server.some((v, i) => v !== web[i])) throw new Error('Browser/server mismatch');
          await verifySource(base64(encrypted), base64(clear), segment.key === 'fixed');
        }));
      }
    });
    assert.equal(packets, 2108);
    assert.equal(repaired, 25);
    console.log('PASS: 25 repaired packets, identical browser/server output, unchanged PCM and byte offsets');
  } finally {
    if (handle) w.hook_template_free(handle);
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

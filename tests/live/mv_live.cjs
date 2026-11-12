// Opt-in browser integration test. Requires am-hook, wrapper-lite and Apple CDN access.
// node tests/mv_live.cjs <playwright-package-path> [http://127.0.0.1:18888]
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:18888';

// Every c608 sample of the progressive output must be a sequence of whole atoms
// with byte pairs (FFmpeg's rule); recent FFmpeg rejects others and mpv stops.
function captionSamples(file) {
  const b = require('node:fs').readFileSync(file);
  const boxes = (start, end) => {
    const out = [];
    for (let p = start; p + 8 <= end;) {
      let size = b.readUInt32BE(p), header = 8;
      if (size === 1) { size = Number(b.readBigUInt64BE(p + 8)); header = 16; }
      out.push({ type: b.toString('latin1', p + 4, p + 8), data: p + header, end: p + size }); p += size;
    }
    return out;
  };
  const child = (box, ...path) => path.reduce((b, t) => b && boxes(b.data, b.end).find(c => c.type === t), box);
  const moov = boxes(0, b.length).find(x => x.type === 'moov');
  const samples = [];
  for (const trak of boxes(moov.data, moov.end).filter(x => x.type === 'trak')) {
    const stbl = child(trak, 'mdia', 'minf', 'stbl'), stsd = child(stbl, 'stsd');
    if (!boxes(stsd.data + 8, stsd.end).some(x => x.type === 'c608')) continue;
    const stsz = child(stbl, 'stsz'), stsc = child(stbl, 'stsc'), co = child(stbl, 'stco') || child(stbl, 'co64');
    const uniform = b.readUInt32BE(stsz.data + 4), count = b.readUInt32BE(stsz.data + 8);
    const size = i => uniform || b.readUInt32BE(stsz.data + 12 + 4 * i);
    const chunks = b.readUInt32BE(co.data + 4), wide = co.type === 'co64';
    const offset = i => wide ? Number(b.readBigUInt64BE(co.data + 8 + 8 * i)) : b.readUInt32BE(co.data + 8 + 4 * i);
    const runs = Array.from({ length: b.readUInt32BE(stsc.data + 4) }, (_, i) => ({
      first: b.readUInt32BE(stsc.data + 8 + 12 * i) - 1, per: b.readUInt32BE(stsc.data + 12 + 12 * i) }));
    for (let c = 0, s = 0; c < chunks; c++) {
      const per = runs.filter(r => r.first <= c).at(-1).per;
      for (let i = 0, p = offset(c); i < per; i++, s++) { samples.push(b.subarray(p, p + size(s))); p += size(s); }
    }
    assert.equal(samples.length, count);
  }
  return samples;
}
function validCaption(s) {
  if (s.length <= 8) return true;
  if (s.length < 10) return false;
  for (let p = 0; s.length - p >= 10;) {
    const size = s.readUInt32BE(p);
    if (size < 10 || size > s.length - p || size % 2) return false;
    p += size;
  }
  return true;
}
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage(); const errors = [], localRequests = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { const u = new URL(r.url()); if (u.origin === base) localRequests.push(u.pathname); });
    await page.goto(base);
    await page.locator('#input').fill('https://music.apple.com/cn/music-video/born-again-feat-doja-cat-raye/1794822079');
    await page.locator('button[type=submit]').click();
    await page.locator('#videos input').first().waitFor({ state: 'attached', timeout: 45000 });
    assert(await page.locator('#videos input').first().isChecked(), 'highest bitrate is selected');
    assert.equal(await page.locator('#audios input:checked').count(), 1);
    const labels = await page.locator('#videos label').allTextContents();
    const avc = labels.map((l, i) => l.includes('avc1') ? i : -1).filter(i => i >= 0).at(-1);
    assert(avc >= 0, 'AVC test track exists');
    await page.locator('#video-trigger').click();
    await page.locator('#videos .mv-option').nth(avc).click();
    assert(await page.locator('#videos input').nth(avc).isChecked());
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('video').currentTime > 3 || !document.querySelector('#error').hidden, null, { timeout: 90000 });
    assert(await page.locator('#error').isHidden(), await page.locator('#error').textContent());
    assert(await page.locator('video').evaluate(v => v.videoWidth > 0));
    await page.locator('video').evaluate(v => { v.currentTime = 100; });
    await page.waitForFunction(() => document.querySelector('video').currentTime > 103 || !document.querySelector('#error').hidden, null, { timeout: 60000 });
    assert(await page.locator('#error').isHidden(), await page.locator('#error').textContent());
    await page.locator('video').evaluate(v => { v.currentTime = 1; });
    await page.waitForFunction(() => document.querySelector('video').currentTime > 4 || !document.querySelector('#error').hidden, null, { timeout: 60000 });
    assert(await page.locator('#error').isHidden(), await page.locator('#error').textContent());
    console.log('Playback, forward seek and backward seek passed.');

    await page.locator('#download').click();
    await page.waitForFunction(() => document.querySelector('#progress').value > 0 || !document.querySelector('#error').hidden, null, { timeout: 60000 });
    assert(await page.locator('#error').isHidden(), await page.locator('#error').textContent());
    await page.locator('#cancel').click();
    await page.waitForFunction(() => !document.querySelector('#download').disabled);
    assert.equal(await page.evaluate(async () => { let n = 0; for await (const [name] of (await navigator.storage.getDirectory()).entries()) if (name.startsWith('am-hook-mv-')) n++; return n; }), 0, 'cancel removes partial OPFS output');

    const download = page.waitForEvent('download', { timeout: 180000 });
    await page.locator('#download').click();
    const file = await download; assert.equal(await file.failure(), null);
    await file.saveAs('target/mv-live.mp4');
    const captions = captionSamples('target/mv-live.mp4');
    assert(captions.length > 0, 'download keeps the c608 caption track');
    assert(captions.every(validCaption), 'every c608 sample is well-formed');
    assert(await page.locator('#error').isHidden(), await page.locator('#error').textContent());
    assert(localRequests.includes('/parse/mv/1794822079'), 'MV master is fetched by the server');
    assert(!localRequests.some(p => /mvod|\.m4s|\/key$/.test(p)), 'no MV segments or key extraction is proxied');
    assert.deepEqual(errors, []);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      await page.screenshot({ path: `target/mv-${width}.png`, fullPage: true });
    }
    console.log('OPFS cancellation, full MP4 download, well-formed captions, browser-only media requests and responsive layout passed. Output: target/mv-live.mp4');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

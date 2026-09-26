// Opt-in browser integration test. Requires am-hook, wrapper-lite and Apple CDN access.
// node tests/mv_live.cjs <playwright-package-path> [http://127.0.0.1:18888]
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:18888';
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
    await page.locator('#videos input').first().waitFor({ timeout: 45000 });
    assert(await page.locator('#videos input').first().isChecked(), 'highest bitrate is selected');
    assert.equal(await page.locator('#audios input:checked').count(), 1);
    const labels = await page.locator('#videos label').allTextContents();
    const avc = labels.map((l, i) => l.includes('avc1') ? i : -1).filter(i => i >= 0).at(-1);
    assert(avc >= 0, 'AVC test track exists');
    await page.locator('#videos input').nth(avc).check();
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
    assert(await page.locator('#error').isHidden(), await page.locator('#error').textContent());
    assert(localRequests.includes('/parse/mv/1794822079'), 'MV master is fetched by the server');
    assert(!localRequests.some(p => /mvod|\.m4s|\/key$/.test(p)), 'no MV segments or key extraction is proxied');
    assert.deepEqual(errors, []);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      await page.screenshot({ path: `target/mv-${width}.png`, fullPage: true });
    }
    console.log('OPFS cancellation, full MP4 download, browser-only media requests and responsive layout passed. Output: target/mv-live.mp4');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

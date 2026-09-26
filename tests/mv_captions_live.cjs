// node tests/mv_captions_live.cjs <playwright-package-path> [http://127.0.0.1:18888]
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:18888';
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/mv/1794822079?country=cn');
    await page.locator('#videos input').first().waitFor({ timeout: 45000 });
    const labels = await page.locator('#videos label').allTextContents();
    const avc = labels.map((v, i) => v.includes('avc1') ? i : -1).filter(i => i >= 0).at(-1);
    await page.locator('#videos input').nth(avc).check(); await page.locator('#play').click();
    await page.waitForFunction(() => [...document.querySelector('video').textTracks].some(t => t.cues?.length) || !document.querySelector('#error').hidden, null, { timeout: 90000 });
    assert(await page.locator('#error').isHidden(), await page.locator('#error').textContent());
    const track = await page.locator('video').evaluate(v => ({ label: v.textTracks[0].label, mode: v.textTracks[0].mode, cues: v.textTracks[0].cues.length }));
    assert.equal(track.label, 'English'); assert.equal(track.mode, 'showing'); assert(track.cues > 0);
    await page.locator('video').evaluate(v => { v.currentTime = 14; });
    await page.waitForFunction(() => { const v = document.querySelector('video'); return !v.seeking && v.currentTime > 14 && v.currentTime < 17 && v.textTracks[0].activeCues?.length > 0; }, null, { timeout: 45000 });
    await page.locator('video').evaluate(v => v.pause());
    await page.screenshot({ path: 'target/mv-captions-visible.png' });
    const text = await page.locator('video').evaluate(v => [...v.textTracks[0].activeCues].map(c => c.text).join('\n'));
    assert(text.length > 0);
    await page.locator('video').evaluate(v => { v.textTracks[0].mode = 'disabled'; v.currentTime = 100; v.play(); });
    await page.waitForFunction(() => document.querySelector('video').currentTime > 103 || !document.querySelector('#error').hidden, null, { timeout: 60000 });
    assert(await page.locator('#error').isHidden(), await page.locator('#error').textContent());
    assert.equal(await page.locator('video').evaluate(v => v.textTracks[0].mode), 'disabled');
    await page.locator('video').evaluate(v => { v.textTracks[0].mode = 'showing'; v.currentTime = 14; });
    await page.waitForFunction(expected => { const v = document.querySelector('video'); return !v.seeking && v.currentTime > 14 && v.currentTime < 17 && [...v.textTracks[0].activeCues || []].map(c => c.text).join('\n') === expected; }, text, { timeout: 45000 });
    await page.locator('video').evaluate(v => v.pause());
    assert.equal(await page.locator('video').evaluate(v => [...v.textTracks[0].activeCues].map(c => c.text).join('\n')), text);
    await page.locator('#videos input').first().check();
    assert.equal(await page.locator('video').evaluate(v => v.textTracks.length), 0, 'switching tracks removes old captions');
    assert.deepEqual(errors, []);
    console.log('Real MV captions: visible timed text, language label, toggle persistence, backward seek and cleanup passed.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

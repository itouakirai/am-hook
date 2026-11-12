// Run with: node tests/alac_check_ui.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook with access to amp-api and the Apple CDN (default http://127.0.0.1:8888); wrapper-lite is not used.
// Covers the album page's ALAC check: the escape frames of "Shadows In The Night (AJSE Extended Remix)" listed in
// AppleMusicDecrypt#136 (frame 2287 keeps a valid END tag over garbage padding, frame 2288 lost its END tag), the
// packaging date, the decoded first segment, no /key request at all, and the copied report.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const { openPage } = require('../support/app.cjs');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const shots = process.env.ALAC_CHECK_SHOTS;
const albumPath = '/https://music.apple.com/us/album/shadows-in-the-night-ajse-extended-remix/1896269091';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [scheme, width] of [['dark', 1280], ['light', 390]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, permissions: ['clipboard-read', 'clipboard-write'] });
      const page = await context.newPage();
      const errors = [];
      const keys = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => { if (/\/key(\?|$)/.test(new URL(request.url()).pathname + new URL(request.url()).search)) keys.push(request.url()); });
      await page.addInitScript(() => localStorage.setItem('am-hook:lang', 'en'));
      const frame = await openPage(page, base + albumPath);
      const button = frame.locator('.detail-extra .detail-circle-btn').first();
      await button.waitFor({ state: 'visible', timeout: 30000 });
      assert.equal(await button.getAttribute('title'), 'Check ALAC');
      await button.click();
      const dialog = frame.locator('.ac-dialog');
      await dialog.waitFor();
      // Nothing runs before Start; stopping and starting again must not let the stopped run touch the rows
      const run = dialog.locator('.dl-dialog-start');
      assert.equal(await run.textContent(), 'Check 2');
      assert.match(await dialog.locator('.dl-dialog-count').textContent(), /^Selected 2\/2$/);
      assert.match(await dialog.locator('.ac-head-meta').textContent(), /^US · Album ID 1896269091$/);
      await run.click();
      await run.click();
      assert.match(await run.textContent(), /^Check 2( again)?$/);
      await run.click();
      await frame.waitForFunction(() => document.querySelector('.ac-dialog .dl-dialog-start').textContent === 'Check 2 again', null, { timeout: 180000 });
      assert.match(await dialog.locator('.ac-head-meta').textContent(), /^US · Album ID 1896269091 · Checked .+ in \d+ s$/);

      const row = dialog.locator('.ac-row', { hasText: 'AJSE Extended Remix' });
      assert.equal(await row.locator('.ac-item .ac-status').textContent(), 'Damaged frames: 2');
      assert.equal(await dialog.locator('.dl-dialog-count').textContent(), 'Damaged tracks: 1, frames: 2');
      await row.locator('.ac-item').click();
      const cells = await row.locator('.ac-frames tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((td) => td.textContent)));
      assert.deepEqual(cells, [
        ['#2287', '3:15.157', 'Hidden damage', '00 5f 2d fd'],
        ['#2288', '3:15.243', 'END tag missing', '10 60 00 00'],
      ]);
      const detail = await row.locator('.ac-detail').textContent();
      assert.match(detail, /Web API24-bit \/ 48 kHzDamaged frames: 2/);
      assert.match(detail, /Packaged .*2026.* · 2994 frames, 2 escape · [\d.]+ [KM]B/);
      assert.match(await row.locator('.ac-stream .ac-meta').getAttribute('title'), /^1\.25\.36\.42/);
      assert.match(detail, /Bit depth: 24-bit \(no zero padding found\)/);
      assert.match(detail, /Bandwidth: reaches 24 kHz/);
      assert.equal(await row.locator('.ac-spectrum').count(), 1);
      if (shots) await page.screenshot({ path: path.join(shots, `alac-check-${scheme}.png`) });

      await dialog.locator('.dl-dialog-cancel', { hasText: 'Copy report' }).click();
      const report = await page.evaluate(() => navigator.clipboard.readText());
      assert.match(report, /^ALAC check: Shadows In The Night/);
      assert.match(report, /#2287 3:15\.157 Hidden damage \[00 5f 2d fd\]/);
      assert.match(report, /\(1\.25\.36\.42/);

      await dialog.locator('.dl-dialog-cancel', { hasText: 'Close' }).click();
      // the dialog's close event (stop and remove) is dispatched asynchronously
      await frame.locator('.ac-dialog').waitFor({ state: 'detached', timeout: 5000 });
      assert.deepEqual(keys, [], 'the check never requests /key');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('alac_check_ui ok');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

// Run with: node tests/app_ui.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook with access to music.apple.com / amp-api and an online wrapper-lite
// (default http://127.0.0.1:8888).
// Covers the single-page app (web/app.html + app.mjs, same as music.apple.com): every page URL gets the app,
// in-site links switch views without reloading the document, playback and the queue survive navigation,
// the address bar / title / Back button follow the page, keyboard shortcuts, lyrics for the playing song
// and language switching.
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');
const { openPage } = require('../support/app.cjs');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const albumPath = '/https://music.apple.com/cn/album/justice-triple-chucks-deluxe-deluxe-video-version/1561058084';

/** 常驻播放器的状态 */
const state = (page) => page.evaluate(() => {
  const p = window.AmApp.player;
  return {
    path: decodeURIComponent(location.pathname), title: document.title,
    track: p.current && p.current.track, paused: p.transport().paused, time: p.transport().currentTime,
    pos: p.queue ? p.queue.pos : null,
  };
});
const playing = () => { const p = window.AmApp.player; return !!p.current && !p.transport().paused && p.transport().currentTime > 0.3; };

(async () => {
  // Every page URL gets the app, whether or not the browser sends Sec-Fetch-* (plain HTTP on a LAN IP does not)
  for (const headers of [{}, { 'Sec-Fetch-Dest': 'document' }]) {
    const res = await fetch(base + albumPath, { headers });
    const html = await res.text();
    assert.match(html, /id="view"/);
    assert.match(html, /id="player"/);
    // 外壳引用的是内容哈希地址（src/assets.rs），原地址仍可访问
    assert.match(html, /\/assets\/h\/app\.[0-9a-f]{16}\.mjs/);
  }
  assert.equal((await fetch(base + '/assets/views/album.mjs')).status, 200);

  const status = await (await fetch(base + '/status')).json().catch(() => ({}));
  if (status.code !== 0) {
    console.log('wrapper-lite offline: app playback checks skipped');
    return;
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('am-hook:lang', 'zh'));
    const frame = await openPage(page, base + albumPath);
    await frame.waitForFunction(() => !document.getElementById('title').classList.contains('skeleton'), null, { timeout: 20000 });
    let s = await state(page);
    assert.equal(s.path, albumPath, 'address bar shows the page');
    assert.match(s.title, /Justice/, 'title follows the page');
    assert.equal(await page.locator('#player').count(), 1, 'a single player bar');
    assert.equal(await page.locator('iframe').count(), 0, 'no iframe');
    // 站内跳转不重新加载文档：标记在整个测试中保留
    await page.evaluate(() => { window.__noReload = true; });

    await frame.locator('#play-all').click();
    await page.waitForFunction(playing, null, { timeout: 60000 });
    const first = (await state(page)).track;
    assert.ok(await page.locator('#player').isVisible());
    assert.ok(await frame.locator('body.has-player').count(), 'page leaves room for the bar');
    assert.ok(await frame.locator('.track.playing').count(), 'playing row marked');

    // In-site navigation keeps playing
    await frame.locator('a.brand').click();
    await page.waitForFunction(() => location.pathname === '/', null, { timeout: 15000 });
    const before = (await state(page)).time;
    await page.waitForTimeout(2000);
    s = await state(page);
    assert.equal(s.paused, false, 'still playing after navigation');
    assert.ok(s.time > before + 1, 'playback position advancing');
    assert.ok(await frame.locator('body.has-player').count(), 'next page leaves room for the bar');
    assert.ok(await page.evaluate(() => window.__noReload), 'in-site navigation keeps the document');

    // Space inside the page toggles playback
    await frame.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.AmApp.player.transport().paused, null, { timeout: 5000 });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !window.AmApp.player.transport().paused, null, { timeout: 5000 });

    // The album queue continues after leaving the album page
    await page.evaluate(() => window.AmApp.player.ended());
    await page.waitForFunction((id) => { const p = window.AmApp.player; return p.current.track !== id && !p.transport().paused; }, first, { timeout: 60000 });
    assert.equal((await state(page)).pos, 1);

    // Back returns to the album with the playing row marked
    await page.goBack();
    await page.waitForFunction((path) => decodeURIComponent(location.pathname) === path, albumPath, { timeout: 15000 });
    await frame.locator('.track.playing').waitFor({ timeout: 30000 });

    // Lyrics of the playing song open from the player bar
    const lyrics = page.locator('#player .player-lyrics');
    assert.ok(await lyrics.isVisible(), 'lyrics button for the playing song');
    await lyrics.click();
    await page.locator('#lyrics-overlay:not([hidden])').waitFor({ timeout: 20000 });
    await page.keyboard.press('Escape');
    await page.locator('#lyrics-overlay').waitFor({ state: 'hidden' });

    // Song page: switching language updates the player bar; playing a single song ends the queue
    await frame.locator('.track:not(.video) .track-title').nth(2).click();
    await frame.locator('#variant-list .variant').first().waitFor({ timeout: 30000 });
    await frame.locator('[data-lang-toggle]').click();
    await page.waitForFunction(() => /Play|Pause/.test(document.querySelector('#player .player-toggle').getAttribute('aria-label')), null, { timeout: 5000 });
    await frame.locator('#play-best').click();
    await page.waitForFunction(() => { const p = window.AmApp.player; return !p.queue && !p.transport().paused && p.current.id.includes(':'); }, null, { timeout: 60000 });
    await frame.locator('.variant.playing').waitFor({ timeout: 5000 });

    assert.ok(await page.evaluate(() => window.__noReload), 'in-site navigation keeps the document');
    assert.deepEqual(errors, []);
    console.log('app UI ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });

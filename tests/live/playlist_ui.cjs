// Run with: node tests/playlist_ui.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook with access to music.apple.com / amp-api (default http://127.0.0.1:8888).
// In-page playback is checked too when wrapper-lite is online.
// Covers the playlist page: catalog data, chart track rows, shelves, language refetch, playback queue,
// invalid IDs, home-page link detection and the mobile layout.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const { openPage } = require('../support/app.cjs');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const shots = process.env.PLAYLIST_UI_SHOTS;
// 每周热门 100 首：全球 — an editorial chart playlist with motion artwork; its tracks change weekly, so no titles are asserted
const playlistLink = 'https://music.apple.com/cn/playlist/%E6%AF%8F%E5%91%A8%E7%83%AD%E9%97%A8-100-%E9%A6%96-%E5%85%A8%E7%90%83/pl.921750b485a6496ea58b16d46c097557';
const playlistPath = '/' + playlistLink;
const loaded = () => !document.getElementById('title').classList.contains('skeleton');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      let frame;
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((lang) => localStorage.setItem('am-hook:lang', lang), scheme === 'light' ? 'zh' : 'en');
      frame = await openPage(page, base + playlistPath);
      await frame.waitForFunction(loaded, null, { timeout: 20000 });

      assert.match(await frame.locator('#title').textContent(), /100/);
      assert.match(await frame.locator('#artist').textContent(), /Apple Music/);
      assert.ok((await frame.locator('#sub').textContent()).trim(), 'last-updated date shown');
      assert.ok(!(await frame.locator('#notes').isHidden()), 'description shown');
      const rows = await frame.locator('.pl-track').count();
      assert.ok(rows >= 90, `tracks listed (${rows})`);
      // Chart playlists number their rows; every row carries its own artwork, artist and album
      assert.ok(await frame.locator('#tracks').evaluate((node) => node.classList.contains('chart')));
      assert.equal(await frame.locator('.pl-track .track-rank').first().textContent(), '1');
      assert.ok(await frame.locator('.pl-track').first().locator('.track-art img').count(), 'row artwork');
      assert.ok((await frame.locator('.pl-track .track-artist').first().textContent()).trim(), 'row artist');
      assert.match(await frame.locator('.pl-track:not(.video) .track-title').first().getAttribute('href'), /^\/https:\/\/music\.apple\.com\/cn\/song\/[^/]+\/\d+$/);
      assert.match(await frame.locator('a.track-album').first().getAttribute('href'), /^\/https:\/\/music\.apple\.com\/cn\/album\/[^/]+\/\d+$/);
      assert.ok(await frame.locator('.track-album').first().isVisible(), 'album column on wide screens');
      assert.ok(await frame.locator('#play-all').isEnabled());
      assert.match(await frame.locator('#footer').textContent(), /\d/);
      // Featured artists shelf opens the artist pages here
      const artist = frame.locator('.shelf-item.artist').first();
      assert.match(await artist.getAttribute('href'), /^\/https:\/\/music\.apple\.com\/[a-z]{2}\/artist\/[^/]+\/\d+$/);
      assert.equal(await artist.getAttribute('target'), null);
      const tint = await frame.evaluate(() => document.body.style.getPropertyValue('--album-tint'));
      assert.match(tint, /^#[0-9a-f]{6}$/i, 'page tinted with artwork colour');
      await frame.locator('#art .motion-video.ready').waitFor({ timeout: 30000 });
      assert.ok(await frame.locator('#art .motion-video').evaluate((v) => !v.paused && v.muted && v.loop && v.currentTime > 0));
      if (shots) await page.screenshot({ path: path.join(shots, `playlist-${scheme}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      await page.close();
    }

    // Switching language refetches the catalog data in the new language
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      let frame;
      await page.addInitScript(() => localStorage.setItem('am-hook:lang', 'zh'));
      frame = await openPage(page, base + playlistPath);
      await frame.waitForFunction(loaded, null, { timeout: 20000 });
      const zhTitle = await frame.locator('#title').textContent();
      await frame.locator('[data-lang-toggle]').click();
      await frame.waitForFunction((before) => document.getElementById('title').textContent !== before, zhTitle, { timeout: 20000 });
      assert.match(await frame.locator('#title').textContent(), /[A-Za-z]/);
      assert.ok(await frame.locator('.pl-track').count() >= 90, 'tracks kept after refetch');
      await page.close();
    }

    // Playback: first track plays in page; its row is marked as playing
    const status = await (await fetch(base + '/status')).json().catch(() => ({}));
    if (status.code === 0) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      let frame = await openPage(page, base + playlistPath);
      await frame.locator('#play-all:not([disabled])').waitFor({ timeout: 20000 });
      const first = await frame.locator('.pl-track:not(.video) .track-title').first().textContent();
      await frame.locator('#play-all').click();
      await frame.locator('.pl-track.playing').first().waitFor({ timeout: 60000 });
      assert.ok(await page.locator('#player').isVisible());
      assert.equal(await page.locator('.player-title .marquee-line__chunk:not(.marquee-line__chunk--copy)').textContent(), first);
      if (shots) await page.screenshot({ path: path.join(shots, 'playlist-playing.png') });
      await page.close();
    } else {
      console.log('wrapper-lite offline: playback check skipped');
    }

    // Links without a slug open the same page; unknown playlist IDs show an error
    {
      const page = await browser.newPage();
      let frame = await openPage(page, base + '/https://music.apple.com/cn/playlist/pl.921750b485a6496ea58b16d46c097557');
      await frame.waitForFunction(loaded, null, { timeout: 20000 });
      assert.ok(await frame.locator('.pl-track').count() >= 90);
      frame = await openPage(page, base + '/https://music.apple.com/us/playlist/x/pl.00000000000000000000000000000000');
      await frame.locator('#alert.error').waitFor({ timeout: 20000 });
      assert.ok(await frame.locator('#tracks').isHidden());
      await page.close();
    }

    // Home page recognises playlist links and opens the playlist page
    {
      const page = await browser.newPage();
      let frame;
      await page.addInitScript(() => localStorage.setItem('am-hook:lang', 'en'));
      frame = await openPage(page, base + '/');
      await frame.locator('#input').fill(playlistLink);
      assert.match(await frame.locator('#detect').textContent(), /Playlist · CN/);
      await frame.locator('#input').press('Enter');
      await page.waitForURL('**/playlist/**/pl.921750b485a6496ea58b16d46c097557', { timeout: 10000, waitUntil: 'commit' });
      await page.close();
    }

    // Mobile: tall artwork, album column hidden, no horizontal scroll
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    let mobileFrame = await openPage(mobile, base + playlistPath);
    await mobileFrame.waitForFunction(loaded, null, { timeout: 20000 });
    await mobileFrame.locator('.pl-track').first().waitFor();
    assert.ok(await mobileFrame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll on mobile');
    assert.ok(await mobileFrame.evaluate(() => document.body.classList.contains('tall-art')), 'tall artwork layout on phones');
    assert.ok(await mobileFrame.locator('.track-album').first().isHidden(), 'album column hidden on phones');
    await mobileFrame.locator('#tall-art .motion-video.ready').waitFor({ timeout: 30000 });
    if (shots) await mobile.screenshot({ path: path.join(shots, 'playlist-mobile.png'), fullPage: true });
    await mobile.close();

    console.log('playlist UI ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });

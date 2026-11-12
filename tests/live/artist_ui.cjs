// Run with: node tests/artist_ui.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook with access to music.apple.com / amp-api (default http://127.0.0.1:8888).
// In-page playback is checked too when wrapper-lite is online.
// Covers the artist page: the three header styles (circular portrait, wide image, motion video), latest release,
// top songs, shelves with See All, the about section, language refetch, playback, links from other pages and mobile.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const { openPage } = require('../support/app.cjs');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const shots = process.env.ARTIST_UI_SHOTS;
// Header styles follow the catalog data, as on music.apple.com:
// Taylor Swift (cn) has only a portrait, The Weeknd (us) a centeredFullscreenBackground, Billie Eilish (us) a motionArtistWide16x9 video
const circularLink = 'https://music.apple.com/cn/artist/taylor-swift/159260351';
const widePath = '/https://music.apple.com/us/artist/the-weeknd/479756766';
const videoPath = '/https://music.apple.com/us/artist/billie-eilish/1065981054';
const loaded = () => !document.getElementById('name').classList.contains('skeleton');
const localPage = (kind) => new RegExp(`^/https://music\\.apple\\.com/[a-z]{2}/${kind}/[^/]+/${kind === 'playlist' ? 'pl\\.[\\w-]+' : '\\d+'}$`);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      let frame;
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((lang) => localStorage.setItem('am-hook:lang', lang), scheme === 'light' ? 'zh' : 'en');
      frame = await openPage(page, base + '/' + circularLink);
      await frame.waitForFunction(loaded, null, { timeout: 20000 });

      assert.equal(await frame.locator('#name').textContent(), 'Taylor Swift');
      assert.ok(await frame.locator('#hero').evaluate((node) => node.classList.contains('circular')), 'portrait-only artists get the circular header');
      assert.ok(await frame.locator('#portrait img').count(), 'circular portrait');
      assert.match(await frame.evaluate(() => document.body.style.getPropertyValue('--joe')), /^#[0-9a-f]{6}$/i, 'header tinted with artwork colour');
      assert.ok(await frame.evaluate(() => document.body.classList.contains('artist-themed')), 'artist theme applied');
      assert.match(await frame.locator('#latest').getAttribute('href'), localPage('album'));
      // The header backdrop must not paint over the section headings below it
      assert.ok(await frame.locator('#top-songs-title').evaluate((h) => {
        const r = h.getBoundingClientRect();
        return h.contains(document.elementFromPoint(r.left + 8, r.top + r.height / 2));
      }), 'top songs heading visible');
      const songs = await frame.locator('.ts-item').count();
      assert.ok(songs >= 10, `top songs listed (${songs})`);
      assert.match(await frame.locator('.ts-item .track-title').first().getAttribute('href'), localPage('song'));
      assert.ok(await frame.locator('#play-all').isEnabled());
      const shelves = await frame.locator('#shelves .shelf-section').count();
      assert.ok(shelves >= 3, `shelves from views (${shelves})`);
      for (const href of await frame.locator('#shelves .shelf-item').evaluateAll((items) => items.map((a) => a.getAttribute('href')))) {
        assert.match(href, /^\/https:\/\/music\.apple\.com\/[a-z]{2}\/(album|music-video|playlist|artist)\//, `shelf link ${href}`);
      }
      // See All pages through the view's next links and lays the shelf out as a grid
      const albums = frame.locator('#shelves .shelf-section').filter({ has: frame.locator('.shelf-all') }).first();
      const before = await albums.locator('.shelf-item').count();
      await albums.locator('.shelf-all').click();
      await albums.locator('.shelf.expanded').waitFor({ timeout: 30000 });
      assert.ok(await albums.locator('.shelf-item').count() > before, 'See All loads more items');
      assert.ok(await albums.locator('.shelf-all').isHidden());
      assert.ok(!(await frame.locator('#about').isHidden()), 'about section');
      const bio = await frame.locator('#bio-text').textContent();
      assert.ok(bio.length > 100, 'artist bio');
      assert.doesNotMatch(bio, /<\/?[a-z]+>/i, 'bio markup rendered as text');
      assert.ok(await frame.locator('#facts dt').count() >= 2, 'born / genre facts');
      if (shots) await page.screenshot({ path: path.join(shots, `artist-${scheme}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      await page.close();
    }

    // Wide header from editorialArtwork.centeredFullscreenBackground (crop code ea)
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      let frame = await openPage(page, base + widePath);
      await frame.waitForFunction(loaded, null, { timeout: 20000 });
      assert.ok(await frame.locator('#hero').evaluate((node) => node.classList.contains('wide')));
      assert.match(await frame.locator('#hero-art img.hero-img').getAttribute('src'), /ea\.jpg$/);
      assert.equal(await frame.locator('#portrait img').count(), 0);
      if (shots) await page.screenshot({ path: path.join(shots, 'artist-wide.png') });
      await page.close();
    }

    // Motion video header from editorialVideo.motionArtistWide16x9
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      let frame = await openPage(page, base + videoPath);
      await frame.waitForFunction(loaded, null, { timeout: 20000 });
      assert.ok(await frame.locator('#hero').evaluate((node) => node.classList.contains('video')));
      await frame.locator('#hero-art .motion-video.ready').waitFor({ timeout: 30000 });
      assert.ok(await frame.locator('#hero-art .motion-video').evaluate((v) => !v.paused && v.muted && v.loop));
      if (shots) await page.screenshot({ path: path.join(shots, 'artist-video.png') });
      await page.close();
    }

    // Switching language refetches the catalog data in the new language
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      let frame;
      await page.addInitScript(() => localStorage.setItem('am-hook:lang', 'zh'));
      frame = await openPage(page, base + '/' + circularLink);
      await frame.waitForFunction(loaded, null, { timeout: 20000 });
      const zhHeading = await frame.locator('#top-songs-title').textContent();
      await frame.locator('[data-lang-toggle]').click();
      await frame.waitForFunction((before) => document.getElementById('top-songs-title').textContent !== before, zhHeading, { timeout: 20000 });
      assert.match(await frame.locator('#top-songs-title').textContent(), /[A-Za-z]/);
      assert.match(await frame.locator('#about-title').textContent(), /^About /);
      await page.close();
    }

    // Playback: the top songs play in page; the playing row is marked
    const status = await (await fetch(base + '/status')).json().catch(() => ({}));
    if (status.code === 0) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      let frame = await openPage(page, base + '/' + circularLink);
      await frame.locator('#play-all:not([disabled])').waitFor({ timeout: 20000 });
      const first = await frame.locator('.ts-item .track-title').first().textContent();
      await frame.locator('#play-all').click();
      await frame.locator('.ts-item.playing').first().waitFor({ timeout: 60000 });
      assert.equal(await page.locator('.player-title .marquee-line__chunk:not(.marquee-line__chunk--copy)').textContent(), first);
      if (shots) await page.screenshot({ path: path.join(shots, 'artist-playing.png') });
      await page.close();
    } else {
      console.log('wrapper-lite offline: playback check skipped');
    }

    // Unknown artist IDs show an error
    {
      const page = await browser.newPage();
      let frame = await openPage(page, base + '/https://music.apple.com/us/artist/x/1');
      await frame.locator('#alert.error').waitFor({ timeout: 20000 });
      assert.ok(await frame.locator('#featured').isHidden());
      await page.close();
    }

    // Other pages link to the artist page: pasted links on the home page, artist names on album, song and MV pages
    {
      const page = await browser.newPage();
      let frame;
      await page.addInitScript(() => localStorage.setItem('am-hook:lang', 'en'));
      frame = await openPage(page, base + '/');
      await frame.locator('#input').fill(circularLink);
      assert.match(await frame.locator('#detect').textContent(), /Artist · CN/);
      await frame.locator('#input').press('Enter');
      await page.waitForURL('**/artist/taylor-swift/159260351', { timeout: 10000, waitUntil: 'commit' });
      frame = await openPage(page, base + '/https://music.apple.com/cn/album/justice-triple-chucks-deluxe-deluxe-video-version/1561058084');
      await frame.locator('#artist a').first().waitFor({ timeout: 20000 });
      assert.match(await frame.locator('#artist a').first().getAttribute('href'), localPage('artist'));
      // A song by three artists: each name links to its own artist page, separators stay text
      frame = await openPage(page, base + '/https://music.apple.com/cn/song/_/6796864754');
      await frame.locator('#subtitle a[href*="/artist/"]').first().waitFor({ timeout: 20000 });
      assert.deepEqual(await frame.locator('#subtitle a[href*="/artist/"]').evaluateAll((links) => links.map((a) => a.textContent)), ['KAROL G', 'Judeline', 'rusowsky']);
      assert.match(await frame.locator('#subtitle').textContent(), /^KAROL G, Judeline & rusowsky$/);
      frame = await openPage(page, base + '/https://music.apple.com/us/music-video/born-again-feat-doja-cat-raye/1794822079');
      await frame.locator('#artist a').first().waitFor({ timeout: 20000 });
      assert.match(await frame.locator('#artist a').first().getAttribute('href'), localPage('artist'));
      await page.close();
    }

    // Mobile: header and top songs fit, no horizontal scroll
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    let mobileFrame = await openPage(mobile, base + '/' + circularLink);
    await mobileFrame.waitForFunction(loaded, null, { timeout: 20000 });
    await mobileFrame.locator('.ts-item').first().waitFor();
    assert.ok(await mobileFrame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll on mobile');
    const box = await mobileFrame.locator('.ts-item').first().boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, 'first top song within the viewport');
    if (shots) await mobile.screenshot({ path: path.join(shots, 'artist-mobile.png'), fullPage: true });
    await mobile.close();

    console.log('artist UI ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });

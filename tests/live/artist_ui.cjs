// Run with: node tests/live/artist_ui.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook with access to music.apple.com / amp-api (default http://127.0.0.1:8888).
// In-page playback is checked too when wrapper-lite is online.
// Covers the artist page: the three header styles (circular portrait, wide image, motion video), latest release,
// top songs, shelves with See All, the about section, language refetch, playback, links from other pages and mobile;
// the See All page (…/see-all?section=, 100 per page, Show More follows next) for albums, top songs and pasted links.
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

/** 曲库语言（i18n.js 的 ampLang）改为该地区提供的英文 */
const catalogInEnglish = (page, cc) => page.evaluate(async (cc) => {
  const sf = (await window.AmI18n.storefronts())[cc];
  const tag = sf.tags.find((t) => t.startsWith('en') && t !== sf.default);
  if (!tag) throw new Error(`${cc} offers no English catalog: ${sf.tags}`);
  await window.AmI18n.setAmpLang(cc, tag);
}, cc);
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
      // A shelf with more items has a heading link to its See All page, as on music.apple.com
      const albums = frame.locator('#shelves .shelf-section').filter({ has: frame.locator('.shelf-heading-link') }).first();
      const seeAll = await albums.locator('.shelf-heading-link').getAttribute('href');
      assert.match(seeAll, /^\/https:\/\/music\.apple\.com\/cn\/artist\/[^/]+\/159260351\/see-all\?section=[a-z-]+$/, `See All link ${seeAll}`);
      if (await frame.locator('#top-songs-title .shelf-heading-link').count()) {
        assert.match(await frame.locator('#top-songs-title .shelf-heading-link').getAttribute('href'), /\/see-all\?section=top-songs$/);
      }
      assert.ok(!(await frame.locator('#about').isHidden()), 'about section');
      const bio = await frame.locator('#bio-text').textContent();
      assert.ok(bio.length > 100, 'artist bio');
      assert.doesNotMatch(bio, /<\/?[a-z]+>/i, 'bio markup rendered as text');
      assert.ok(await frame.locator('#facts dt').count() >= 2, 'born / genre facts');
      if (shots) await page.screenshot({ path: path.join(shots, `artist-${scheme}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      await page.close();
    }

    // See All page: heading link → grid with the artist name above the title; Show More follows next (100 per page);
    // back returns to the artist page. Beethoven (cn) has several hundred albums
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const frame = await openPage(page, base + '/https://music.apple.com/cn/artist/ludwig-van-beethoven/1130028');
      await frame.waitForFunction(loaded, null, { timeout: 20000 });
      const name = await frame.locator('#name').textContent();
      const full = frame.locator('#shelves .shelf-heading-link[href$="section=full-albums"]');
      await full.click();
      await frame.waitForURL(/\/1130028\/see-all\?section=full-albums$/);
      const items = frame.locator('#sections .ed-grid .shelf-item');
      await items.first().waitFor({ timeout: 30000 });
      assert.equal(await items.count(), 100, 'first page has 100 albums');
      assert.equal(await frame.locator('#owner').textContent(), name, 'artist name above the title');
      assert.match(await frame.locator('#owner').getAttribute('href'), /\/artist\/[^/]+\/1130028$/);
      assert.ok((await frame.locator('#title').textContent()).trim().length > 0, 'section title from with=attributes');
      // Own albums show the release year as subtitle
      assert.match(await items.first().locator('.shelf-sub').textContent(), /^\d{4}$/);
      const more = frame.locator('#more .browse-more-btn');
      assert.ok(await more.isVisible(), 'Show More button');
      // No automatic paging when scrolled to the bottom
      await frame.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      assert.equal(await items.count(), 100, 'no infinite scroll');
      await more.click();
      await frame.waitForFunction(() => document.querySelectorAll('#sections .ed-grid .shelf-item').length > 100, null, { timeout: 30000 });
      assert.equal(await items.count(), 200, 'Show More appends the next 100');
      const hrefs = await items.evaluateAll((nodes) => nodes.map((a) => a.getAttribute('href')));
      assert.equal(new Set(hrefs).size, hrefs.length, 'no duplicates across pages');
      if (shots) await page.screenshot({ path: path.join(shots, 'artist-see-all.png') });
      await page.goBack();
      await frame.waitForFunction(loaded, null, { timeout: 20000 });
      assert.equal(await frame.locator('#name').textContent(), name, 'back to the artist page');

      // Top songs: list with album column and no rank column; playable rows
      await openPage(page, base + '/https://music.apple.com/cn/artist/ludwig-van-beethoven/1130028/see-all?section=top-songs');
      const rows = frame.locator('#sections .ed-chart-list .pl-track');
      await rows.first().waitFor({ timeout: 30000 });
      assert.ok(await rows.count() > 10, 'top songs listed');
      assert.equal(await frame.locator('#sections .ed-chart-list .track-rank').count(), 0, 'no rank column');
      assert.match(await rows.first().locator('.track-title').getAttribute('href'), localPage('song'));

      // Official path form …/<section> and pasted links open the same page
      await openPage(page, base + '/https://music.apple.com/cn/artist/ludwig-van-beethoven/1130028/singles');
      await frame.locator('#sections .ed-grid .shelf-item').first().waitFor({ timeout: 30000 });
      assert.match(await frame.locator('#apple-link').getAttribute('href'), /\/1130028\/see-all\?section=singles$/);
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

    // Switching the UI language relabels the page; switching the catalog language (ampLang) refetches the data in it
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      let frame;
      await page.addInitScript(() => localStorage.setItem('am-hook:lang', 'zh'));
      frame = await openPage(page, base + '/' + circularLink);
      await frame.waitForFunction(loaded, null, { timeout: 20000 });
      const zhHeading = await frame.locator('#top-songs-title').textContent();
      await frame.locator('[data-lang-toggle]').click();
      await catalogInEnglish(page, 'cn');
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

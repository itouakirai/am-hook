// Run with: node tests/browse_ui.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook with access to music.apple.com / amp-api (default http://127.0.0.1:8888).
// In-page playback is checked too when wrapper-lite is online.
// Covers the editorial pages (views/browse.mjs): New (/new, groupings?name=music) with the same sections as music.apple.com/cn/new,
// shelf arrows, See All into a room (paged grid), Back, the link list, room / curator / grouping pages, links pasted on the home page,
// following the primary storefront, playback from a track shelf and the phone layout.
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const localPage = /^\/https:\/\/music\.apple\.com\/[a-z]{2}\/(song|music-video|album|playlist|artist|room|multi-room|grouping|curator|station|post)\//;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (sessionStorage.getItem('am-test')) return;
      sessionStorage.setItem('am-test', '1');
      localStorage.setItem('am-hook:lang', 'zh');
      localStorage.setItem('am-hook:storefront', 'cn');
    });
    await page.goto(base + '/');

    // The nav entry opens New in page; it follows the primary storefront
    await page.click('.nav-link[data-nav="new"]');
    await page.waitForSelector('.ed-section .ed-heading-link', { timeout: 30000 });
    assert.equal(new URL(page.url()).pathname, '/new');
    assert.equal(await page.locator('[data-nav="new"]').getAttribute('aria-current'), 'page');
    assert.equal((await page.locator('#title').textContent()).trim(), '新发现');
    assert.ok(await page.locator('.ed-hero').count() >= 3, 'hero cards');
    assert.ok(await page.locator('.ed-shelf.grid-T .ts-item').count() >= 8, 'track shelves');
    assert.ok(await page.locator('.ed-shelf.grid-G .card-wrap').count() >= 20, 'square lockups');
    assert.ok(await page.locator('.ed-links .ed-link').count() >= 3, 'link list');
    for (const href of await page.locator('#sections .shelf-item[href^="/"], #sections .track-title').evaluateAll((links) => links.map((a) => a.getAttribute('href')))) {
      assert.match(href, localPage, `local link ${href}`);
    }

    // Arrows page a shelf by its width
    const wrap = page.locator('.ed-shelf-wrap').nth(2);
    await wrap.hover();
    await wrap.locator('.ed-arrow.next').click();
    await page.waitForFunction((node) => node.scrollLeft > 300, await wrap.locator('.ed-shelf').elementHandle(), { timeout: 5000 });

    // See All opens the room (grid) and Back returns to New
    const heading = page.locator('.ed-heading-link').nth(1);
    const name = (await heading.textContent()).trim();
    await heading.click();
    await page.waitForSelector('.ed-grid', { timeout: 30000 });
    assert.match(new URL(page.url()).pathname, /^\/https:\/\/music\.apple\.com\/cn\/room\/\d+$/);
    assert.equal((await page.locator('#title').textContent()).trim(), name);
    assert.ok(await page.locator('.ed-grid > *').count() >= 6);
    await page.click('.nav-item-back [data-back]');
    await page.waitForSelector('.ed-hero', { timeout: 30000 });
    assert.equal(new URL(page.url()).pathname, '/new');
    assert.match(await page.locator('.ed-link').first().getAttribute('href'), /^\/https:\/\/music\.apple\.com\/cn\/(room|grouping)\/\d+$/);

    // Playback from a track shelf
    const status = await (await fetch(base + '/status')).json().catch(() => ({}));
    if (status.code === 0) {
      const row = page.locator('.ed-tracks-section .ts-item').first();
      await row.hover();
      await row.locator('.track-play').click();
      await page.locator('.ed-tracks-section .ts-item.playing').first().waitFor({ timeout: 60000 });
      await page.waitForFunction(() => !window.AmApp.player.transport().paused, null, { timeout: 60000 });
      await page.evaluate(() => window.AmApp.player.toggle());
    } else {
      console.log('wrapper-lite offline: playback not checked');
    }

    // Switching the primary storefront reloads New for it
    const before = await page.locator('.ed-hero-title').first().textContent();
    await page.evaluate(() => window.AmI18n.setStorefront('us'));
    await page.waitForFunction((text) => document.querySelector('.ed-hero-title')?.textContent !== text, before, { timeout: 30000 });
    assert.match(await page.locator('#apple-link').getAttribute('href'), /\/us\/new$/);
    await page.evaluate(() => window.AmI18n.setStorefront('cn'));

    // Room with songs (track grid, paged), genre curators room, curator with a grouping, grouping page
    for (const [path, check] of [
      ['/https://music.apple.com/cn/room/6818358804', '.ed-grid.grid-T .ts-item'],
      ['/https://music.apple.com/cn/room/6456176470', '.ed-grid.grid-G a[href*="/curator/"]'],
      ['/https://music.apple.com/cn/curator/apple-music-unplugged/1019400049', '.ed-section .ed-heading'],
      ['/https://music.apple.com/cn/grouping/170872', '.ed-shelf.grid-C .shelf-item.mv'],
    ]) {
      await page.evaluate((href) => window.AmApp.navigate(href), path);
      await page.waitForSelector(check, { timeout: 30000 });
      assert.ok((await page.locator('#title').textContent()).trim().length > 0, `title for ${path}`);
    }

    // Links pasted on the home page open the editorial pages
    await page.evaluate(() => window.AmApp.navigate('/'));
    await page.fill('#input', 'https://music.apple.com/cn/curator/apple-music-%E4%B8%8D%E6%8F%92%E7%94%B5/1019400049');
    assert.match(await page.locator('#detect').textContent(), /策展人 · CN/);
    await page.press('#input', 'Enter');
    await page.waitForSelector('.ed-section', { timeout: 30000 });
    assert.match(new URL(page.url()).pathname, /\/cn\/curator\/.+\/1019400049$/);

    // Top Charts: the Explore More link on New opens /new/top-charts (following the primary storefront)
    await page.evaluate(() => window.AmApp.navigate('/new'));
    await page.locator('.ed-link[href="/new/top-charts"]').click();
    await page.waitForSelector('.ed-shelf.grid-T .ts-item.ranked', { timeout: 30000 });
    assert.equal(new URL(page.url()).pathname, '/new/top-charts');
    assert.equal(await page.locator('[data-nav="charts"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('[data-nav="new"]').getAttribute('aria-current'), null);
    assert.ok(await page.locator('#nav').evaluate((nav) => nav.classList.contains('is-home')), 'Top Charts is a top-level page');
    assert.equal((await page.locator('#title').textContent()).trim(), '排行榜');
    // The sidebar entry opens the same page
    await page.evaluate(() => window.AmApp.navigate('/'));
    await page.click('.nav-link[data-nav="charts"]');
    await page.waitForSelector('.ed-shelf.grid-T .ts-item.ranked', { timeout: 30000 });
    assert.equal(new URL(page.url()).pathname, '/new/top-charts');
    assert.equal(await page.locator('.ed-section').count(), 6, 'songs, city, daily top 100, playlists, albums, videos');
    assert.equal((await page.locator('.ed-shelf.grid-T .ed-rank').first().textContent()).trim(), '1');
    assert.equal((await page.locator('.ed-shelf.grid-G .ed-ordinal').first().textContent()).trim(), '1', 'ranked playlists');
    assert.deepEqual(await page.locator('.ed-heading-link').evaluateAll((links) => links.map((a) => a.getAttribute('href'))),
      ['/new/top-charts/songs', '/new/top-charts/playlists', '/new/top-charts/albums', '/new/top-charts/music-videos']);
    if (status.code === 0) {
      const row = page.locator('.ed-shelf.grid-T .ts-item').nth(1);
      await row.hover();
      await row.locator('.track-play').click();
      await page.locator('.ed-shelf.grid-T .ts-item.playing').first().waitFor({ timeout: 60000 });
      await page.evaluate(() => window.AmApp.player.toggle());
    }

    // Songs See All: chart rows with ranks, a genre picker and paging past the first 50
    await page.locator('.ed-heading-link[href="/new/top-charts/songs"]').click();
    await page.waitForSelector('.ed-chart-list .pl-track', { timeout: 30000 });
    const allTitle = (await page.locator('#title').textContent()).trim();
    assert.ok(await page.locator('#tools select option').count() > 10, 'genres');
    assert.equal(await page.locator('#tools select').inputValue(), '34');
    await page.locator('#more').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll('.ed-chart-list .pl-track').length > 50, null, { timeout: 30000 });
    assert.equal((await page.locator('.ed-chart-list .track-rank').nth(50).textContent()).trim(), '51');
    await page.locator('#tools select').selectOption('14');
    await page.waitForFunction((before) => document.getElementById('title').textContent.trim() !== before && document.querySelector('.ed-chart-list .pl-track'), allTitle, { timeout: 30000 });
    assert.equal(new URL(page.url()).search, '?genreId=14');
    assert.equal(await page.locator('#tools select').inputValue(), '14');
    assert.match(await page.locator('#apple-link').getAttribute('href'), /\/cn\/new\/top-charts\/songs\?genreId=14$/);
    assert.deepEqual(errors, []);
    await page.close();

    // Phone: fixed-width shelf columns, no horizontal page scroll
    {
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await phone.addInitScript(() => localStorage.setItem('am-hook:storefront', 'cn'));
      await phone.goto(base + '/new');
      await phone.waitForSelector('.ed-shelf.grid-G .card-wrap', { timeout: 30000 });
      assert.equal(Math.round(await phone.locator('.ed-shelf.grid-G .card-wrap').first().evaluate((n) => n.getBoundingClientRect().width)), 144);
      assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page scroll');
      await phone.close();
    }
    console.log('browse UI ok');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

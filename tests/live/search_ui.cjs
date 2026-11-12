// Run with: node tests/search_ui.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook with access to music.apple.com / amp-api (default http://127.0.0.1:8888).
// Covers the home page search: suggestions, results, pagination, ?q= state and the mobile layout.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const { openPage, pageFrame } = require('../support/app.cjs');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const shots = process.env.SEARCH_UI_SHOTS;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let frame;
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.addInitScript(() => localStorage.setItem('am-hook:lang', 'en'));
    frame = await openPage(page, base + '/');

    // Links still go straight to the song page; keywords switch the button to "Search"
    const input = frame.locator('#input');
    await input.fill('https://music.apple.com/us/song/cruel-summer/1468058171');
    assert.equal(await frame.locator('#submit-label').textContent(), 'Parse');
    await input.fill('');

    // Suggestions come from /amp/v1/catalog/{sf}/search/suggestions
    await input.pressSequentially('born again', { delay: 20 });
    assert.equal(await frame.locator('#submit-label').textContent(), 'Search');
    await frame.locator('#suggest .suggest-item').first().waitFor({ timeout: 15000 });
    assert.equal(await input.getAttribute('aria-expanded'), 'true');
    assert.ok(await frame.locator('#suggest .suggest-term').count() > 0, 'term suggestions shown');
    await input.press('ArrowDown');
    assert.equal(await input.getAttribute('aria-activedescendant'), 'suggest-0');
    await input.press('Escape');
    assert.ok(await frame.locator('#suggest').isHidden());
    if (shots) {
      await input.press('End');
      await input.pressSequentially(' ', { delay: 20 });
      await frame.locator('#suggest .suggest-item').first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(shots, 'search-suggest.png') });
      await input.press('Escape');
    }

    // Results from /amp/v1/catalog/{sf}/search: groups follow meta.results.order, Top Results first
    await input.fill('born again');
    await input.press('Enter');
    await frame.locator('.song-row').first().waitFor({ timeout: 15000 });
    assert.equal(new URL(page.url()).searchParams.get('q'), 'born again');
    assert.match(await frame.locator('#results-title').textContent(), /born again/);
    const groupTitles = await frame.locator('.group-title').allTextContents();
    const order = ['Top Results', 'Artists', 'Albums', 'Songs', 'Playlists', 'Music Videos'];
    assert.equal(groupTitles[0], 'Top Results');
    assert.deepEqual(groupTitles, order.filter((title) => groupTitles.includes(title)), 'groups in Apple Music order');
    assert.ok(await frame.locator('.top-group .song-row').count() <= 6, 'at most 6 top results');
    const songGroup = frame.locator('.result-group', { has: frame.locator('.group-title', { hasText: /^Songs$/ }) });
    const songHref = await songGroup.locator('.song-row').first().getAttribute('href');
    assert.match(songHref, /^\/https:\/\/music\.apple\.com\/[a-z]{2}\/song\/[^/]+\/\d+$/);
    const mvCount = await frame.locator('.mv-card').count();
    if (mvCount) assert.match(await frame.locator('.mv-card').first().getAttribute('href'), /^\/https:\/\/music\.apple\.com\/[a-z]{2}\/music-video\/[^/]+\/\d+$/);

    if (shots) await page.screenshot({ path: path.join(shots, 'search-desktop.png'), fullPage: true });

    // 12 per group at first; "Load more" reveals the rest of the page, then follows the API's next link through the proxy
    const songRows = songGroup.locator('.song-row');
    const songs = await songRows.count();
    assert.ok(songs <= 12, 'songs preview capped at 12');
    const more = songGroup.locator('.load-more');
    for (let i = 0; i < 2 && await more.isVisible(); i++) {
      const before = await songRows.count();
      await more.click();
      await songRows.nth(before).waitFor({ timeout: 15000 });
    }

    // Artist and playlist groups open the artist / playlist pages
    await input.fill('taylor swift');
    await input.press('Enter');
    await frame.locator('.artist-card').first().waitFor({ timeout: 15000 });
    assert.match(await frame.locator('.artist-card').first().getAttribute('href'), /^\/https:\/\/music\.apple\.com\/[a-z]{2}\/artist\/[^/]+\/\d+$/);
    assert.ok(await frame.locator('.artist-card .album-thumb.round').count(), 'round artist avatars');
    const playlistHref = await frame.locator('.album-card[href*="/playlist/"]').first().getAttribute('href');
    assert.match(playlistHref, /^\/https:\/\/music\.apple\.com\/[a-z]{2}\/playlist\/[^/]+\/pl\.[\w-]+$/);
    if (shots) await frame.locator('.result-group', { has: frame.locator('.artist-card') }).screenshot({ path: path.join(shots, 'search-artists.png') });
    await input.fill('born again');
    await input.press('Enter');
    await page.waitForURL(/q=born\+again/, { timeout: 15000, waitUntil: 'commit' });

    // ?q= restores results on reload; Close clears it
    await page.reload();
    frame = await pageFrame(page);
    await frame.locator('.song-row').first().waitFor({ timeout: 15000 });
    assert.equal(await frame.locator('#input').inputValue(), 'born again');
    await frame.locator('#close-results').click();
    assert.ok(await frame.locator('#results').isHidden());
    assert.equal(new URL(page.url()).searchParams.get('q'), null);

    // Mobile: no horizontal scroll
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    let mobileFrame;
    await mobile.addInitScript(() => localStorage.setItem('am-hook:lang', 'zh'));
    mobileFrame = await openPage(mobile, base + '/?q=' + encodeURIComponent('taylor swift'));
    await mobileFrame.locator('.song-row').first().waitFor({ timeout: 15000 });
    assert.ok(await mobileFrame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll on mobile');
    if (shots) await mobile.screenshot({ path: path.join(shots, 'search-mobile.png'), fullPage: true });

    assert.deepEqual(errors, []);
    console.log(`search UI ok (${songs} songs, ${mvCount} music videos)`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });

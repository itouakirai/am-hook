// Run with: node tests/live/search_ui.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook with access to music.apple.com / amp-api (default http://127.0.0.1:8888).
// Covers the home page: Browse Categories bricks (collapsed to one row by default), the footer, search suggestions, results, pagination, ?q= state and the mobile layout.
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

    // Browse Categories (/amp/v1/recommendations/{sf}?name=search-landing): 16:9 bricks with a title, links open local pages.
    // The site's own For You brick (/home) comes first; `bricks` are the editorial ones, `allBricks` include it
    const allBricks = frame.locator('#brick-grid a.brick');
    const bricks = frame.locator('#brick-grid a.brick:not(.brick-for-you)');
    await bricks.first().waitFor({ timeout: 20000 });
    assert.equal(await allBricks.first().getAttribute('href'), '/home', 'For You brick first');
    assert.equal((await allBricks.first().locator('.brick-title').textContent()).trim(), 'For You');
    assert.ok(await bricks.count() >= 10, 'category bricks shown');
    assert.ok((await frame.locator('#categories-title').textContent()).trim(), 'categories title');
    const brickBox = await bricks.first().boundingBox();
    assert.ok(Math.abs(brickBox.width / brickBox.height - 16 / 9) < 0.05, 'bricks are 16:9');
    const hrefs = await bricks.evaluateAll((list) => list.map((a) => a.getAttribute('href')));
    assert.ok(hrefs.some((href) => /^\/https:\/\/music\.apple\.com\/[a-z]{2}\/curator\/[^/]+\/\d+$/.test(href)), 'curator bricks open the curator page');
    for (const href of hrefs) assert.ok(href.startsWith('/') || /^https:\/\//.test(href), `brick link ${href}`);
    assert.ok(await frame.locator('#brick-grid a.brick:not(.brick-for-you)[href^="/"]:not([target])').count() === hrefs.filter((h) => h.startsWith('/')).length, 'local bricks stay in the tab');
    await bricks.first().locator('img').evaluate((img) => img.decode());

    // Collapsed by default: only the first row shows, the toggle expands the rest and is remembered
    const toggle = frame.locator('#categories-toggle');
    const rowOf = () => allBricks.evaluateAll((list) => list.filter((a) => !a.hidden).map((a) => a.getBoundingClientRect().top));
    const columns = await frame.evaluate(() => getComputedStyle(document.querySelector('#brick-grid')).gridTemplateColumns.split(' ').length);
    let tops = await rowOf();
    assert.equal(tops.length, columns, 'collapsed grid shows one row');
    assert.ok(tops.every((top) => Math.abs(top - tops[0]) < 1), 'visible bricks share a row');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.match(await toggle.textContent(), new RegExp(`Show all ${await allBricks.count()} categories`));
    if (shots) await page.screenshot({ path: path.join(shots, 'home-categories.png') });
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal((await rowOf()).length, await allBricks.count(), 'expanded grid shows every brick');
    assert.equal(await frame.evaluate(() => localStorage.getItem('am-hook:categories-expanded')), '1');
    if (shots) await page.screenshot({ path: path.join(shots, 'home-expanded.png'), fullPage: true });

    // Footer: version from host.js linking to its release, Telegram group and GitHub
    const version = frame.locator('#footer-version');
    assert.match(await version.textContent(), /^v\d+\.\d+\.\d+/);
    assert.match(await version.getAttribute('href'), /\/am-hook\/releases\/tag\/v\d+\.\d+\.\d+/);
    assert.ok(await frame.locator('.home-footer a[href="https://t.me/apple_music_alac"]').isVisible(), 'Telegram link');
    assert.ok(await frame.locator('.home-footer a[href="https://github.com/itouakirai/am-hook"]').isVisible(), 'GitHub link');
    if (shots) await frame.locator('.home-footer').screenshot({ path: path.join(shots, 'home-footer.png') });

    // Opening a curator brick lands on the curator page; Back returns to the grid
    const curatorBrick = frame.locator('#brick-grid a.brick[href*="/curator/"]').first();
    const curatorName = (await curatorBrick.locator('.brick-title').textContent()).trim();
    await curatorBrick.click();
    await page.waitForURL(/\/curator\//, { waitUntil: 'commit' });
    await page.locator('#sections .ed-section').first().waitFor({ timeout: 20000 });
    assert.ok((await page.locator('#title').textContent()).includes(curatorName), `curator page title contains ${curatorName}`);
    await page.goBack();
    frame = await pageFrame(page);
    await frame.locator('#brick-grid a.brick:not(.brick-for-you)').first().waitFor({ timeout: 10000 });

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
    assert.ok(await frame.locator('#landing').isHidden(), 'categories hidden while searching');
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
    assert.ok(await frame.locator('#landing').isVisible(), 'categories back after closing the results');

    // Switching the storefront reloads the categories for that region (titles come back in its language)
    const firstBefore = await frame.locator('#brick-grid a.brick:not(.brick-for-you)').first().getAttribute('href');
    const sf = await frame.evaluate(() => window.AmI18n.storefront);
    const other = sf === 'us' ? 'jp' : 'us';
    await frame.evaluate((cc) => window.AmI18n.setStorefront(cc), other);
    await frame.waitForFunction(([cc, before]) => {
      const a = document.querySelector('#brick-grid a.brick:not(.brick-for-you)');
      return a && a.getAttribute('href') !== before && [...document.querySelectorAll('#brick-grid a.brick[href*="/curator/"]')].every((b) => b.getAttribute('href').includes(`/${cc}/`));
    }, [other, firstBefore], { timeout: 20000 });
    await frame.evaluate((cc) => window.AmI18n.setStorefront(cc), sf);

    // Mobile: no horizontal scroll
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    let mobileFrame;
    await mobile.addInitScript(() => localStorage.setItem('am-hook:lang', 'zh'));
    mobileFrame = await openPage(mobile, base + '/?q=' + encodeURIComponent('taylor swift'));
    await mobileFrame.locator('.song-row').first().waitFor({ timeout: 15000 });
    assert.ok(await mobileFrame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll on mobile');
    // Mobile landing: two brick columns, still no horizontal scroll (the example chips scroll inside their own row)
    await mobileFrame.locator('#close-results').click();
    await mobileFrame.locator('#brick-grid a.brick:not(.brick-for-you)').nth(1).waitFor({ timeout: 20000 });
    // Collapsed on a fresh profile: two columns × two rows
    assert.equal(await mobileFrame.locator('#brick-grid a.brick:not([hidden])').count(), 4, 'mobile collapsed grid shows two rows');
    const [b0, b1] = await Promise.all([0, 1].map((i) => mobileFrame.locator('#brick-grid a.brick').nth(i).boundingBox()));
    assert.ok(Math.abs(b0.y - b1.y) < 1 && b1.x > b0.x, 'two bricks per row on mobile');
    assert.ok(await mobileFrame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll on the mobile landing');
    if (shots) await mobile.screenshot({ path: path.join(shots, 'search-mobile.png'), fullPage: true });

    assert.deepEqual(errors, []);
    console.log(`search UI ok (${songs} songs, ${mvCount} music videos)`);
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });

// Opt-in browser test for For You (the Home page of music.apple.com, /home in views/browse.mjs). Needs a running am-hook with
// access to amp-api and an Apple Music media-user-token.
// node tests/run.mjs live for_you   (or: node tests/live/for_you_live.cjs <playwright-package-path> [base] [token-file])
//   base defaults to AM_HOOK_URL or http://127.0.0.1:8888; the token comes from token-file, AM_HOOK_MEDIA_USER_TOKEN,
//   target/test-media-user-token.txt or target/my-media-user-token.txt.
// Covers: the For You brick first in Browse Categories (hint without / with a token); /home without a token (the token dialog opens
// by itself, cancelling leaves the prompt on the page); entering the token in the dialog (stored in the HttpOnly cookie, not in
// localStorage); the shelves (Top Picks poster cards with reasons, cover shelves, every link opens in this site); See All into
// /home/see-all/<id>; Back; a pasted music.apple.com/{cc}/listen-now link; the phone layout; clearing the token from the dialog.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const tokenFile = process.argv[4] || ['test-media-user-token.txt', 'my-media-user-token.txt']
  .map((name) => path.join(__dirname, '../../target', name)).find((file) => fs.existsSync(file));
const token = (process.env.AM_HOOK_MEDIA_USER_TOKEN || (tokenFile && fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8') : '')).trim();
if (!token) { console.log('No media-user-token: skipped'); process.exit(0); }
const localPage = /^\/(?:https:\/\/music\.apple\.com\/[a-z]{2}\/(?:song|music-video|album|playlist|artist|room|multi-room|grouping|curator|station|post)\/|home\/see-all\/|new\/top-charts)/;
const shots = path.join(__dirname, '../../target/shots');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      if (sessionStorage.getItem('am-test')) return;
      sessionStorage.setItem('am-test', '1');
      localStorage.setItem('am-hook:lang', 'zh');
      localStorage.setItem('am-hook:storefront', 'us');
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    fs.mkdirSync(shots, { recursive: true });

    // Browse Categories: the For You brick comes first, before the editorial bricks, and says a token is needed
    await page.goto(base + '/');
    const brick = page.locator('#brick-grid > .brick').first();
    await page.locator('#brick-grid a.brick:not(.brick-for-you)').first().waitFor({ timeout: 30000 });
    assert.equal(await brick.getAttribute('href'), '/home');
    assert.equal((await brick.locator('.brick-title').textContent()).trim(), '为你推荐');
    assert.equal((await brick.locator('.brick-hint').textContent()).trim(), '需要 media-user-token');
    await page.screenshot({ path: path.join(shots, 'for-you-brick.png'), clip: { x: 0, y: 0, width: 1440, height: 900 } });

    // Without a token: the dialog opens by itself; cancelling leaves the prompt and its button on the page
    await brick.click();
    await page.waitForURL(`${base}/home`);
    const dialog = page.locator('dialog.lib-dialog');
    await dialog.waitFor({ timeout: 10000 });
    assert.match(await dialog.locator('.lib-dialog-message').textContent(), /为你推荐/);
    await dialog.locator('.lib-dialog-btn:not(.primary):not(.danger)').click();
    await page.locator('#token-box').waitFor();
    assert.match(await page.locator('#token-text').textContent(), /media-user-token/);
    assert.equal((await page.locator('#title').textContent()).trim(), '为你推荐');
    assert.equal(await page.locator('#sections > *').count(), 0);
    await page.screenshot({ path: path.join(shots, 'for-you-token.png') });

    // Entering the token: checked against /v1/me/storefront, kept in the HttpOnly cookie, then the shelves load
    await page.click('#token-edit');
    await dialog.locator('textarea').fill(`media-user-token=${token}; other=1`);
    await dialog.locator('.lib-dialog-btn.primary').click();
    await page.locator('#sections .ed-section').first().waitFor({ timeout: 30000 });
    assert.ok(await page.locator('#token-box').isHidden());
    const cookies = await context.cookies(base);
    assert.ok(cookies.some((c) => c.name === 'am-mut' && c.httpOnly && c.value === token), 'token cookie');
    assert.equal(await page.evaluate((tok) => Object.values(localStorage).some((v) => v.includes(tok)), token), false, 'no token in localStorage');
    assert.match(await page.evaluate(() => localStorage.getItem('am-hook:station-storefront')), /^[a-z]{2}$/);

    const headings = await page.locator('#sections .ed-heading').allTextContents();
    console.log('shelves:', headings.join(' | '));
    assert.ok(headings.length >= 5, 'several shelves');
    // Top Picks: tall poster cards with the reason above each card
    const posters = page.locator('.fy-poster-section .fy-poster-wrap');
    assert.ok(await posters.count() >= 3, 'poster cards');
    assert.ok((await posters.first().locator('.fy-reason').textContent()).trim(), 'reason above the card');
    const box = await posters.first().locator('.fy-poster').boundingBox();
    assert.ok(Math.abs(box.height / box.width - 4 / 3) < 0.02, `3:4 poster ${box.width}x${box.height}`);
    assert.ok(await page.locator('#sections .ed-shelf.grid-G .card-wrap').count() >= 20, 'cover shelves');
    for (const href of await page.locator('#sections a[href^="/"]').evaluateAll((links) => links.map((a) => a.getAttribute('href')))) {
      assert.match(href, localPage, `local link ${href}`);
    }
    const apple = await page.locator('#apple-link').getAttribute('href');
    assert.match(apple, /^https:\/\/music\.apple\.com\/[a-z]{2}\/home$/);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(shots, 'for-you.png') });

    // See All (e.g. Recently Played): every item of the shelf in a grid, then Back returns to For You
    const seeAll = page.locator('#sections .ed-heading-link[href^="/home/see-all/"]').first();
    if (await seeAll.count()) {
      const name = (await seeAll.textContent()).trim();
      const shelfCount = await seeAll.locator('xpath=ancestor::section').locator('.card-wrap').count();
      await seeAll.click();
      await page.waitForURL(/\/home\/see-all\//);
      await page.locator('#sections .ed-grid .card-wrap').first().waitFor({ timeout: 30000 });
      assert.equal((await page.locator('#title').textContent()).trim(), name);
      const gridCount = await page.locator('#sections .ed-grid .card-wrap').count();
      assert.ok(gridCount >= shelfCount, `see-all ${gridCount} >= shelf ${shelfCount}`);
      await page.goBack();
      await page.waitForURL(`${base}/home`);
      await page.locator('#sections .fy-poster-section').first().waitFor({ timeout: 10000 });
    } else {
      console.log('no shelf with See All: skipped');
    }

    // A pasted official link (old listen-now path) opens the same page; the brick now reads "picked for your account"
    await page.goto(base + '/');
    await page.locator('#brick-grid a.brick').first().waitFor();
    assert.equal((await page.locator('.brick-for-you .brick-hint').textContent()).trim(), '按你的账号推荐');
    await page.fill('#input', 'https://music.apple.com/cn/listen-now');
    await page.locator('#detect').waitFor();
    assert.match(await page.locator('#detect').textContent(), /为你推荐/);
    await page.press('#input', 'Enter');
    await page.waitForURL(`${base}/https://music.apple.com/cn/home`);
    await page.locator('#sections .ed-section').first().waitFor({ timeout: 30000 });

    // Phone layout: no horizontal page scroll, posters at their fixed column width
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll');
    const phone = await page.locator('.fy-poster').first().boundingBox();
    assert.ok(Math.abs(phone.width - 220) < 2, `phone poster width ${phone.width}`);
    await page.screenshot({ path: path.join(shots, 'for-you-phone.png') });
    await page.setViewportSize({ width: 1440, height: 900 });

    // Clearing the token from the dialog brings the prompt back and removes the cookie
    await page.goto(base + '/home');
    await page.locator('#sections .ed-section').first().waitFor({ timeout: 30000 });
    // 同一模块要经页面实际加载的哈希地址 import（否则是另一个实例）
    const clear = page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map((e) => e.name).find((u) => /\/assets\/h\/station\.[0-9a-f]+\.mjs$/.test(u));
      const mod = await import(url);
      return mod.askToken();
    });
    await dialog.waitFor();
    await dialog.locator('.lib-dialog-btn.danger').click();
    assert.equal(await clear, '');
    await page.locator('#token-box').waitFor();
    assert.ok(!(await context.cookies(base)).some((c) => c.name === 'am-mut'), 'cookie cleared');

    assert.deepEqual(errors, []);
    console.log('for_you_live passed');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });

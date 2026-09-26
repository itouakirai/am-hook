// Run with: node tests/ui_layout.cjs <path-to-playwright-package>
// Uses installed Chrome and local fixtures; no wrapper or Apple CDN required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.join(__dirname, '../src/ui');
const songPath = '/https://music.apple.com/us/song/_/123456789';
const variants = [
  { group_id: 'audio-alac-stereo', codecs: 'alac', bit_depth: 24, sample_rate: 96000 },
  { group_id: 'audio-atmos-2768', codecs: 'ec-3', channels: '6' },
  { group_id: 'audio-stereo-256', codecs: 'mp4a.40.2', channels: '2' },
].map(v => ({ ...v, uri: 'track.m3u8', file_uri: 'track.mp4' }));

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let scenarios = 0;
  try {
    for (const width of [320, 390, 768, 1440]) {
      for (const lang of ['zh', 'en']) {
        const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: lang === 'zh' ? 'light' : 'dark' });
        await context.addInitScript(lang => localStorage.setItem('am-hook:lang', lang), lang);
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.hostname === 'itunes.apple.com') return route.fulfill({ json: { results: [{ trackName: 'A song with a beautifully long title / 一首很长很长的歌曲名称', artistName: 'Artist', collectionName: 'The listening room', trackTimeMillis: 213000 }] } });
          if (url.pathname === '/status') return route.fulfill({ json: { code: 0, regions: ['us', 'cn'] } });
          if (url.pathname.startsWith('/parse/song/')) return route.fulfill({ json: { masterUrl: 'https://example.com/master.m3u8', hook: true, variants } });
          if (url.pathname.startsWith('/lyrics/')) return route.fulfill({ status: 404, json: { code: 1, msg: 'lyrics not found' } });
          const file = url.pathname.startsWith('/assets/lyrics/') ? path.join('lyrics', path.basename(url.pathname))
            : url.pathname.startsWith('/assets/') ? path.basename(url.pathname) : url.pathname === '/' ? 'home.html' : 'song.html';
          const type = file.endsWith('.css') ? 'text/css' : /\.m?js$/.test(file) ? 'text/javascript' : 'text/html';
          return route.fulfill({ body: fs.readFileSync(path.join(root, file)), contentType: type });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        const fits = async label => {
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: overflow at ${width}/${lang}`);
        };
        await page.goto('http://am.test/');
        await fits('home');
        if (width === 1440 && lang === 'zh') await page.screenshot({ path: 'target/ui-home.png', fullPage: true });
        await page.locator('#form button').click();
        assert.equal(await page.locator('#input').getAttribute('aria-invalid'), 'true');
        await page.locator('#input').fill('123456789');
        await page.locator('#form button').click();
        await page.waitForURL('**' + songPath);
        await page.locator('.variant').first().waitFor();
        await page.waitForFunction(() => !document.getElementById('title').classList.contains('skeleton'));
        await fits('song');
        await page.locator('.more-btn').first().click();
        const bounds = await page.locator('#menu').boundingBox();
        assert(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 844, 'menu must fit viewport');
        await page.keyboard.press('Escape');
        assert(await page.locator('.more-btn').first().evaluate(el => el === document.activeElement));
        await page.locator('[data-lang-toggle]').click();
        await fits('language switch');
        // Exercise the real fixed player layout with a multiline codec notice.
        await page.evaluate(() => {
          const p = document.getElementById('player');
          p.hidden = false;
          document.body.classList.add('has-player');
          p.querySelector('.player-title').textContent = 'Long song title '.repeat(10);
          p.querySelector('.player-notice').hidden = false;
          p.querySelector('.player-notice').textContent = AmI18n.t('player.pcmNotice');
        });
        await page.waitForTimeout(100);
        await fits('player');
        if (width === 390 && lang === 'en') await page.screenshot({ path: 'target/ui-mobile.png', fullPage: true });
        assert(await page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom) > document.getElementById('player').getBoundingClientRect().height), 'player clearance must include notices');
        await page.locator('.more-btn').last().click();
        await fits('menu with player');
        await page.keyboard.press('Escape');
        assert.deepEqual(errors, []);
        await context.close();
        scenarios++;
      }
    }
    console.log(`Passed ${scenarios} viewport/language scenarios: forms, overflow, menus, focus and player clearance.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

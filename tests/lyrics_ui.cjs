// Run with: node tests/lyrics_ui.cjs <path-to-playwright-package>
// Uses installed Chrome and a local TTML fixture; no wrapper or Apple CDN required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.join(__dirname, '../src/ui');
const variants = [{ group_id: 'audio-stereo-256', codecs: 'mp4a.40.2', channels: '2', uri: 'track.m3u8', file_uri: 'track.mp4' }];
const line = (key, begin, end, words, translation) => ({ key, begin, end, words, translation });
const lines = [
  line('L1', 1, 4, ['First ', 'line'], 'Primera línea'),
  line('L2', 5, 8, ['Second ', 'line'], 'Segunda línea'),
  line('L3', 9, 12, ['Third ', 'line'], 'Tercera línea'),
];
const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word" xml:lang="en"><head><metadata><iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><translations><translation type="subtitle" xml:lang="es">${
  lines.map(l => `<text for="${l.key}">${l.translation}</text>`).join('')
}</translation></translations><songwriters><songwriter>Writer A</songwriter><songwriter>Writer B</songwriter></songwriters></iTunesMetadata></metadata></head><body dur="00:14.000"><div begin="00:01.000" end="00:12.000">${
  lines.map(l => `<p begin="00:0${l.begin}.000" end="00:${String(l.end).padStart(2, '0')}.000" itunes:key="${l.key}" ttm:agent="v1">${
    l.words.map((w, i) => `<span begin="00:${String(l.begin + i).padStart(2, '0')}.000" end="00:${String(l.begin + i + 1).padStart(2, '0')}.000">${w.trim()}</span>${w.endsWith(' ') ? ' ' : ''}`).join('')
  }</p>`).join('')
}</div></body></tt>`;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let scenarios = 0;
  try {
    for (const width of [390, 1440]) {
      for (const hasLyrics of [true, false]) {
        const context = await browser.newContext({ viewport: { width, height: 844 } });
        await context.addInitScript(() => localStorage.setItem('am-hook:lang', 'zh'));
        const lyricRequests = [];
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.hostname === 'itunes.apple.com') return route.fulfill({ json: { results: [{ trackName: 'Lyric song', artistName: 'Artist' }] } });
          if (url.pathname === '/status') return route.fulfill({ json: { code: 0, regions: ['us'] } });
          if (url.pathname.startsWith('/parse/')) return route.fulfill({ json: { masterUrl: 'https://example.com/master.m3u8', hook: false, variants } });
          if (url.pathname.startsWith('/lyrics/')) {
            lyricRequests.push(url.pathname);
            return hasLyrics
              ? route.fulfill({ body: ttml, contentType: 'application/ttml+xml' })
              : route.fulfill({ status: 404, json: { code: 1, msg: 'lyrics not found' } });
          }
          const file = url.pathname.startsWith('/assets/lyrics/') ? path.join('lyrics', path.basename(url.pathname))
            : url.pathname.startsWith('/assets/') ? path.basename(url.pathname) : 'song.html';
          const type = file.endsWith('.css') ? 'text/css' : /\.m?js$/.test(file) ? 'text/javascript' : 'text/html';
          return route.fulfill({ body: fs.readFileSync(path.join(root, file)), contentType: type });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto('http://am.test/https://music.apple.com/us/song/_/123456789');
        await page.locator('.variant').first().waitFor();
        // Drive the lyric view from a fake transport; real decoding is covered elsewhere.
        await page.evaluate(() => {
          window.fakeTransport = { currentTime: 0, paused: false, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; } };
          player.current = { id: 'fake', mode: 'mse', title: 'Lyric song' };
          player.transport = () => window.fakeTransport;
          const bar = document.getElementById('player');
          bar.hidden = false;
          document.body.classList.add('has-player');
        });
        for (let i = 0; i < 50 && !lyricRequests.length; i++) await page.waitForTimeout(50);
        assert.deepEqual(lyricRequests, ['/lyrics/123456789']);
        if (!hasLyrics) {
          await page.waitForTimeout(300);
          assert(await page.locator('.player-lyrics').isHidden(), 'no lyrics: button stays hidden');
          assert.deepEqual(errors, []);
          await context.close();
          scenarios++;
          continue;
        }
        await page.locator('.player-lyrics:not([hidden])').click();
        await page.locator('#lyrics-overlay:not([hidden])').waitFor();
        assert.equal(await page.locator('.lyric-row').count(), 4, 'three lines and the credits row');
        assert.equal(await page.locator('.lyrics-title').textContent(), 'Lyric song');
        assert.equal(await page.locator('[data-option="pronunciation"]').isDisabled(), true);

        await page.evaluate(() => { fakeTransport.currentTime = 5.5; });
        await page.waitForFunction(() => document.querySelector('.lyric-row.current')?.dataset.key === 'L2');
        await page.locator('.lyric-row[data-key="L3"] .line-button').click();
        assert.equal(await page.evaluate(() => fakeTransport.currentTime), 9, 'clicking a line seeks the player');
        await page.waitForFunction(() => document.querySelector('.lyric-row.current')?.dataset.key === 'L3');

        await page.locator('[data-option="translation"]').click();
        assert.equal(await page.locator('[data-option="translation"]').getAttribute('aria-pressed'), 'true');
        await page.locator('.lyric-row[data-key="L3"] .translation-text').waitFor({ state: 'visible', timeout: 2000 });
        assert.equal(await page.locator('.credit-names').textContent(), 'Writer A、Writer B');
        await page.evaluate(() => AmI18n.toggle()); // the overlay covers the page's language button
        assert.equal(await page.locator('.credit-names').textContent(), 'Writer A, Writer B');
        assert.equal(await page.locator('.lyrics-close').getAttribute('aria-label'), 'Close lyrics');

        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
        const panel = await page.locator('.lyric-panel').boundingBox();
        const bar = await page.locator('#player').boundingBox();
        assert(panel.y + panel.height <= bar.y + 1, 'lyrics must stay above the player bar');
        if (width === 1440) await page.screenshot({ path: 'target/ui-lyrics.png' });

        await page.keyboard.press('Escape');
        assert(await page.locator('#lyrics-overlay').isHidden());
        assert(await page.locator('.player-lyrics').evaluate(el => el === document.activeElement), 'focus returns to the lyrics button');
        assert.deepEqual(errors, []);
        await context.close();
        scenarios++;
      }
    }
    console.log(`Passed ${scenarios} lyric scenarios: loading, line tracking, seeking, translation, language and layout.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

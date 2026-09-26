// node tests/mv_ui.cjs <path-to-playwright-package>
// Local fixtures exercise the actual MV page without wrapper-lite or Apple CDN.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.join(__dirname, '../src/ui');
const masterBody = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",NAME="Stereo",DEFAULT=YES,CHANNELS="2",URI="audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="surround",NAME="Surround",DEFAULT=YES,CHANNELS="6",URI="surround.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=3840x2160,CODECS="hvc1.2.4.L153.B0,ec-3",AUDIO="surround",VIDEO-RANGE=PQ
4k.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="stereo",FRAME-RATE=24
hd.m3u8`;
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    let scenarios = 0;
    for (const width of [320, 390, 768, 1440]) for (const lang of ['zh', 'en']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: lang === 'zh' ? 'light' : 'dark' });
      await context.addInitScript(lang => localStorage.setItem('am-hook:lang', lang), lang);
      let fail = false;
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname === 'itunes.apple.com') return route.fulfill({ json: { results: [{ trackId: 123, trackName: 'A beautifully long music video title / 一首很长的音乐视频名称', artistName: 'Artist / 艺术家', releaseDate: '2026-01-01', primaryGenreName: 'Pop', trackTimeMillis: 213000 }] } });
        if (url.pathname.startsWith('/parse/mv/')) return route.fulfill(fail ? { status: 500, json: { msg: 'Fixture failure' } } : { json: { code: 0, data: { masterBody, masterUrl: 'https://example.com/master.m3u8' } } });
        const file = url.pathname === '/assets/mv/style.css' ? 'mv.css'
          : url.pathname.startsWith('/assets/mv/') ? 'mv-' + path.basename(url.pathname)
          : url.pathname.startsWith('/assets/') ? path.basename(url.pathname) : 'mv.html';
        return route.fulfill({ body: fs.readFileSync(path.join(root, file)), contentType: file.endsWith('.css') ? 'text/css' : /\.m?js$/.test(file) ? 'text/javascript' : 'text/html' });
      });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      const fits = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow ${width}/${lang}`);
      await page.goto('http://am.test/mv/123');
      await page.locator('#videos input').first().waitFor();
      assert.equal(await page.locator('#video-count').textContent(), '2');
      assert(await page.locator('#audios input').nth(1).isChecked());
      assert(await page.locator('#play').isEnabled());
      await fits();
      await page.locator('#videos input').first().focus();
      await page.keyboard.press('ArrowDown');
      assert(await page.locator('#videos input').nth(1).isChecked());
      assert(await page.locator('#audios input').first().isChecked());
      assert(await page.locator('#videos input').nth(1).evaluate(el => el === document.activeElement));
      assert.match(await page.locator('#selection').textContent(), /1920x1080.*Stereo/);
      await page.locator('[data-lang-toggle]').click();
      assert(await page.locator('#videos input').nth(1).isChecked());
      await fits();
      if (width === 1440 || width === 390) await page.screenshot({ path: `target/mv-ui-${width}-${lang}.png`, fullPage: true });
      fail = true;
      await page.reload();
      await page.locator('#error').waitFor();
      assert(await page.locator('#play').isDisabled());
      assert.equal(await page.locator('.mv-empty').count(), 2);
      await page.locator('[data-lang-toggle]').click();
      await fits();
      assert.deepEqual(errors, []);
      await context.close(); scenarios++;
    }
    console.log(`MV UI: ${scenarios} viewport/language/theme scenarios passed, including keyboard selection, audio recommendation and loading errors.`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

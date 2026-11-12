// node tests/mv_ui.cjs <path-to-playwright-package>
// Local fixtures exercise the actual MV page without wrapper-lite or Apple CDN.
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');
const { serveWeb } = require('../support/web.cjs');
const masterBody = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",NAME="Stereo",DEFAULT=YES,CHANNELS="2",URI="audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="surround",NAME="Surround",DEFAULT=YES,CHANNELS="6",URI="surround.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=3840x2160,CODECS="hvc1.2.4.L153.B0,ec-3",AUDIO="surround",VIDEO-RANGE=PQ
4k.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="stereo",FRAME-RATE=24
hd.m3u8`;

/** 单页应用：页面地址返回 app.html，/assets/<path> 即 web/<path> */
const asset = serveWeb;
/** 切换界面语言：手机宽度（< 484px）下语言按钮在导航菜单里，先展开菜单，切换后收起 */
async function toggleLang(page) {
  const menu = page.locator('#nav-toggle');
  const mobile = await menu.isVisible();
  if (mobile) await menu.click();
  await page.locator('[data-lang-toggle]').click();
  if (mobile) await page.keyboard.press('Escape');
}
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
        // MV 信息经 /amp 代理取自 amp-api 的 music-videos 资源；地区语言信息取不到时页面退回默认写法
        if (/^\/amp\/v1\/catalog\/[a-z]{2}\/music-videos\//.test(url.pathname)) {
          return route.fulfill({ json: { data: [{ id: '123', type: 'music-videos', attributes: { name: 'A beautifully long music video title / 一首很长的音乐视频名称', artistName: 'Artist / 艺术家', releaseDate: '2026-01-01', genreNames: ['Pop'], durationInMillis: 213000 }, relationships: { artists: { data: [
            { id: '1', type: 'artists', attributes: { name: 'Artist', url: 'https://music.apple.com/us/artist/artist/1' } },
            { id: '2', type: 'artists', attributes: { name: '艺术家', url: 'https://music.apple.com/us/artist/yi-shu-jia/2' } }] } } }] } });
        }
        if (url.pathname.startsWith('/amp/')) return route.fulfill({ status: 404, json: { errors: [] } });
        if (url.pathname.startsWith('/parse/mv/')) return route.fulfill(fail ? { status: 500, json: { msg: 'Fixture failure' } } : { json: { code: 0, data: { masterBody, masterUrl: 'https://example.com/master.m3u8' } } });
        return asset(route, url);
      });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      const fits = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow ${width}/${lang}`);
      await page.goto('http://am.test/https://music.apple.com/us/music-video/_/123');
      await page.locator('#videos input').first().waitFor({ state: 'attached' });
      await page.waitForFunction(() => /beautifully long/.test(document.getElementById('title').textContent), null, { timeout: 5000 });
      // Each artist in the artist line links to its artist page; separators stay plain text
      assert.deepEqual(await page.locator('#artist a').evaluateAll(links => links.map(a => [a.textContent, a.getAttribute('href')])),
        [['Artist', '/https://music.apple.com/us/artist/artist/1'], ['艺术家', '/https://music.apple.com/us/artist/yi-shu-jia/2']]);
      assert.equal(await page.locator('#artist').textContent(), 'Artist / 艺术家');
      assert.equal(await page.locator('#video-count').textContent(), '2');
      assert(await page.locator('#audios input').nth(1).isChecked());
      assert(await page.locator('#play').isEnabled());
      // 两个下拉默认收起，触发按钮显示当前选中的轨道
      assert(await page.locator('#videos').isHidden());
      assert(await page.locator('#audios').isHidden());
      assert.match(await page.locator('#video-trigger').textContent(), /3840×2160/);
      assert.match(await page.locator('#audio-trigger').textContent(), /Surround/);
      await fits();
      // 展开后聚焦选中项；方向键切换时保持展开，Escape 收起并回到触发按钮
      await page.locator('#video-trigger').click();
      assert.equal(await page.locator('#video-trigger').getAttribute('aria-expanded'), 'true');
      assert(await page.locator('#videos input').first().evaluate(el => el === document.activeElement));
      await fits();
      await page.keyboard.press('ArrowDown');
      assert(await page.locator('#videos input').nth(1).isChecked());
      assert(await page.locator('#audios input').first().isChecked());
      assert(await page.locator('#videos input').nth(1).evaluate(el => el === document.activeElement));
      assert(await page.locator('#videos').isVisible());
      assert.match(await page.locator('#selection').textContent(), /1920x1080.*Stereo/);
      await page.keyboard.press('Escape');
      assert(await page.locator('#videos').isHidden());
      assert(await page.locator('#video-trigger').evaluate(el => el === document.activeElement));
      assert.match(await page.locator('#audio-trigger').textContent(), /Stereo/);
      // 同一时间只展开一个；鼠标点选后收起
      await page.locator('#video-trigger').click();
      await page.locator('#audio-trigger').click();
      assert(await page.locator('#videos').isHidden());
      await page.locator('#audios .mv-option').nth(1).click();
      assert(await page.locator('#audios input').nth(1).isChecked());
      assert(await page.locator('#audios').isHidden());
      assert(await page.locator('#videos input').nth(1).isChecked());
      await toggleLang(page);
      assert(await page.locator('#videos input').nth(1).isChecked());
      await fits();
      if (width === 1440 || width === 390) await page.screenshot({ path: `target/mv-ui-${width}-${lang}.png`, fullPage: true });
      fail = true;
      await page.reload();
      await page.locator('#error').waitFor();
      assert(await page.locator('#play').isDisabled());
      assert.equal(await page.locator('.mv-empty').count(), 2);
      await toggleLang(page);
      await fits();
      assert.deepEqual(errors, []);
      await context.close(); scenarios++;
    }
    // 艺人上传的视频（post 页）共用 MV 页：assetTokens 中的 MP4 按分辨率排列，没有音频轨道，下载原样保存
    for (const width of [390, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(() => localStorage.setItem('am-hook:lang', 'en'));
      const mp4 = Buffer.alloc(256 * 1024, 7);
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname === 'cdn.test') return route.fulfill({ body: mp4, contentType: 'video/x-m4v', headers: { 'Access-Control-Allow-Origin': '*' } });
        if (/^\/amp\/v1\/catalog\/us\/uploaded-videos\/42$/.test(url.pathname)) {
          return route.fulfill({ json: { data: [{ id: '42', type: 'uploaded-videos', attributes: { name: 'Interview / 访谈', uploadingBrandName: 'Apple Music Presents',
            uploadDate: '2026-09-21', durationInMilliseconds: 600000, playParams: { id: '42', kind: 'uploadedVideo' }, assetTokens: {
              sdVideo: 'https://cdn.test/a/mzvf_1.640x480.h264lc.U.f.m4v?accessKey=1', '1080pHdVideo': 'https://cdn.test/a/mzvf_2.1920w.h264lc.U.f.m4v?accessKey=2' } } }] } });
        }
        if (url.pathname.startsWith('/amp/')) return route.fulfill({ status: 404, json: { errors: [] } });
        return asset(route, url);
      });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto('http://am.test/https://music.apple.com/us/post/42');
      await page.locator('#videos input').first().waitFor({ state: 'attached' });
      assert.equal(await page.locator('#title').textContent(), 'Interview / 访谈');
      assert.equal(await page.locator('#artist').textContent(), 'Apple Music Presents');
      assert.equal(await page.locator('.eyebrow').textContent(), 'VIDEO');
      assert.equal(await page.locator('#apple-link').getAttribute('href'), 'https://music.apple.com/us/post/42');
      assert(await page.locator('#audio-tracks').isHidden());
      assert.equal(await page.locator('#video-count').textContent(), '2');
      // 大小来自 HEAD 的 Content-Length，码率按时长计算
      await page.waitForFunction(() => /Mbps/.test(document.getElementById('video-trigger').textContent));
      assert.match(await page.locator('#video-trigger').textContent(), /1080p.*1920×1080/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('#download').click();
      await page.locator('#save').waitFor();
      assert.match(await page.locator('#save').getAttribute('download'), /^Interview _ 访谈 \(42\)\.mp4$/);
      assert.equal(await page.evaluate(async () => (await (await fetch(document.getElementById('save').href)).arrayBuffer()).byteLength), mp4.length);
      assert.deepEqual(errors, []);
      await context.close(); scenarios++;
    }
    console.log(`MV UI: ${scenarios} viewport/language/theme scenarios passed, including keyboard selection, audio recommendation, loading errors and post pages.`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

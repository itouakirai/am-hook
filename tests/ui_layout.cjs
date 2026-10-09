// Run with: node tests/ui_layout.cjs <path-to-playwright-package>
// Uses installed Chrome and local fixtures; no wrapper or Apple CDN required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.join(__dirname, '../src/ui');
const songPath = '/https://music.apple.com/us/song/_/123456789';
const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac-stereo",NAME="Lossless",BIT-DEPTH=24,SAMPLE-RATE=96000
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-atmos-2768",NAME="Atmos",CHANNELS="6"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-stereo-256",NAME="Stereo",CHANNELS="2"
#EXT-X-STREAM-INF:CODECS="alac",AUDIO="audio-alac-stereo"
track.m3u8
#EXT-X-STREAM-INF:CODECS="ec-3",AUDIO="audio-atmos-2768"
track.m3u8
#EXT-X-STREAM-INF:CODECS="mp4a.40.2",AUDIO="audio-stereo-256"
track.m3u8
`;

/** 切换界面语言：手机宽度（< 484px）下语言按钮在导航菜单里，先展开菜单，切换后收起 */
async function toggleLang(page) {
  const menu = page.locator('#nav-toggle');
  const mobile = await menu.isVisible();
  if (mobile) {
    await menu.click();
    assert.equal(await menu.getAttribute('aria-expanded'), 'true', 'menu button expands the navigation');
  }
  await page.locator('[data-lang-toggle]').click();
  if (mobile) {
    await page.keyboard.press('Escape');
    assert.equal(await menu.getAttribute('aria-expanded'), 'false', 'Escape collapses the navigation');
    assert(await page.locator('#nav-content').evaluate(el => el.inert), 'collapsed menu content is inert');
  }
}

/** 导航：≥484px 为左侧边栏（返回在侧边栏里，页面在其右侧）；更窄时为 52px 顶栏（返回 / logo / 菜单按钮） */
async function checkNav(page, width) {
  const nav = await page.locator('#nav').boundingBox();
  if (width >= 484) {
    const expected = width >= 767.32 ? 260 : width * 0.338842975207;
    assert(Math.abs(nav.width - expected) < 1 && nav.x === 0, `sidebar is ${expected}px wide on the left`);
    assert(await page.locator('.nav-item-back .nav-link').isVisible(), 'Back is in the sidebar');
    assert(await page.locator('#nav-toggle').isHidden(), 'no menu button beside the sidebar');
    const pageBox = await page.locator('.page').boundingBox();
    assert(pageBox.x >= nav.width - 1, 'page content starts right of the sidebar');
  } else {
    assert(Math.round(nav.height) === 52 && Math.round(nav.width) === width, 'phone navigation is a 52px top bar');
    assert(await page.locator('.nav-header .top-back').isVisible(), 'Back is in the phone top bar');
    assert(await page.locator('#nav-toggle').isVisible(), 'menu button replaces the language button');
  }
}

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
          // 歌曲信息经 /amp 代理取自 amp-api 的 songs 资源；地区语言信息取不到时页面退回默认写法
          if (/^\/amp\/v1\/catalog\/[a-z]{2}\/songs\//.test(url.pathname)) {
            return route.fulfill({ json: { data: [{ id: url.pathname.split('/').pop(), type: 'songs', attributes: { name: 'A song with a beautifully long title / 一首很长很长的歌曲名称', artistName: 'Artist', albumName: 'The listening room', durationInMillis: 213000 }, relationships: { artists: { data: [{ id: '42', type: 'artists', attributes: { name: 'Artist', url: 'https://music.apple.com/us/artist/artist/42' } }] } } }] } });
          }
          if (url.pathname.startsWith('/amp/')) return route.fulfill({ status: 404, json: { errors: [] } });
          if (url.pathname === '/status') return route.fulfill({ json: { code: 0, regions: ['us', 'cn'] } });
          // 服务端只返回 master 地址，master m3u8 由页面直接获取并解析（wrapper.js）
          if (url.pathname.startsWith('/parse/song/')) return route.fulfill({ json: { code: 0, data: { masterUrl: 'https://example.com/master.m3u8' } } });
          if (url.href === 'https://example.com/master.m3u8') return route.fulfill({ body: master, contentType: 'application/vnd.apple.mpegurl' });
          if (url.pathname.startsWith('/lyrics/')) return route.fulfill({ status: 404, json: { code: 1, msg: 'lyrics not found' } });
          // 单页应用：页面地址返回 app.html，页面视图在 /assets/views/
          const file = url.pathname.startsWith('/assets/lyrics/') ? path.join('lyrics', path.basename(url.pathname))
            : url.pathname.startsWith('/assets/views/') ? path.join('views', path.basename(url.pathname))
            : url.pathname.startsWith('/assets/') ? path.basename(url.pathname) : 'app.html';
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
        // 首页只识别 Apple Music 链接，其余输入按关键词搜索
        await page.locator('#input').fill('https://music.apple.com/us/song/_/123456789');
        await page.locator('#form button').click();
        // 单页应用：站内跳转不触发 load 事件
        await page.waitForURL('**' + songPath, { waitUntil: 'commit' });
        await page.locator('.variant').first().waitFor();
        await page.waitForFunction(() => !document.getElementById('title').classList.contains('skeleton'));
        assert.match(await page.locator('#title').textContent(), /beautifully long title/, 'song metadata from the /amp fixture');
        assert.equal(await page.locator('#subtitle a[href="/https://music.apple.com/us/artist/artist/42"]').textContent(), 'Artist', 'artist name links to the artist page');
        await fits('song');
        await page.locator('.more-btn').first().click();
        const bounds = await page.locator('#menu').boundingBox();
        assert(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 844, 'menu must fit viewport');
        await page.keyboard.press('Escape');
        assert(await page.locator('.more-btn').first().evaluate(el => el === document.activeElement));
        await checkNav(page, width);
        await toggleLang(page);
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

// Run with: node tests/lyrics_ui.cjs <path-to-playwright-package>
// Uses installed Chrome and a local TTML fixture; no wrapper or Apple CDN required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.join(__dirname, '../src/ui');
const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-stereo-256",NAME="Stereo",CHANNELS="2"
#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS="mp4a.40.2",AUDIO="audio-stereo-256"
track.m3u8
`;
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
// AMLL TTML DB 的写法：翻译与音译写在行内（ttm:role），和声里也有行内翻译，作者在 amll:meta
const pad = n => String(n).padStart(2, '0');
const amllLines = [['L1', 1, 4, 'Amll first', '第一行'], ['L2', 5, 8, 'Amll second', '第二行'], ['L3', 9, 12, 'Amll third', '第三行']];
const amllTtml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:amll="http://www.example.com/ns/amll" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xml:lang="en"><head><metadata><ttm:agent type="person" xml:id="v1"/><amll:meta key="appleMusicId" value="123456789"/><amll:meta key="ttmlAuthorGithubLogin" value="lyricist"/></metadata></head><body dur="00:14.000"><div xmlns="" begin="00:01.000" end="00:12.000">${
  amllLines.map(([key, begin, end, text, tr]) => `<p begin="00:${pad(begin)}.000" end="00:${pad(end)}.000" ttm:agent="v1" itunes:key="${key}">${
    text.split(' ').map((w, i) => `<span begin="00:${pad(begin + i)}.000" end="00:${pad(begin + i + 1)}.000">${w}</span>`).join(' ')
  }<span ttm:role="x-translation" xml:lang="zh-CN">${tr}</span><span ttm:role="x-roman">${text.toLowerCase()}</span>${
    key === 'L2' ? '<span ttm:role="x-bg" begin="00:07.000" end="00:08.000"><span begin="00:07.000" end="00:08.000">(echo)</span><span ttm:role="x-translation" xml:lang="zh-CN">回声</span></span>' : ''
  }</p>`).join('')
}</div></body></tt>`;
// 对唱：head 里 ttm:agent 声明歌手（v1 带 ttm:name），每行一位歌手；v3 的 type 为 other，v1000 为合唱（group），L3 带和声（x-bg）
const duetLines = [['L1', 1, 3, 'v3', 'Duet one'], ['L2', 3, 5, 'v2', 'Duet two'], ['L3', 5, 7, 'v1', 'Duet three'], ['L4', 7, 9, 'v1000', 'Duet four'],
  ['L5', 9, 11, 'v2', 'Duet five'], ['L6', 11, 13, 'v2', 'Duet six'], ['L7', 13, 15, 'v1', 'Duet seven']];
const duetTtml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:amll="http://www.example.com/ns/amll" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xml:lang="en"><head><metadata><ttm:agent type="person" xml:id="v1"><ttm:name type="full">Singer A</ttm:name></ttm:agent><ttm:agent type="person" xml:id="v2"/><ttm:agent type="other" xml:id="v3"/><ttm:agent type="group" xml:id="v1000"/></metadata></head><body dur="00:16.000"><div xmlns="" begin="00:01.000" end="00:15.000">${
  duetLines.map(([key, begin, end, agent, text]) => `<p begin="00:${pad(begin)}.000" end="00:${pad(end)}.000" ttm:agent="${agent}" itunes:key="${key}">${
    text.split(' ').map((w, i) => `<span begin="00:${pad(begin + i)}.000" end="00:${pad(begin + i + 1)}.000">${w}</span>`).join(' ')
  }${
    key === 'L3' ? '<span ttm:role="x-bg" begin="00:06.000" end="00:07.000"><span begin="00:06.000" end="00:07.000">(ooh)</span></span>' : ''
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
        const amllRequests = [];
        let amllHasSong = true;
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.hostname === 'api.amll.dev') {
            amllRequests.push(url.pathname + url.search);
            const headers = { 'access-control-allow-origin': '*' };
            return amllHasSong
              ? route.fulfill({ headers, json: { status: 200, data: { id: 1, format: 'ttml', appleMusicIds: ['123456789'], authorUsernames: ['lyricist'], lyrics: amllTtml } } })
              : route.fulfill({ status: 404, headers, json: { status: 404, error: 'Not Found', message: 'No lyrics found for the provided query.' } });
          }
          // 歌曲信息经 /amp 代理取自 amp-api 的 songs 资源；地区语言信息取不到时页面退回默认写法
          if (/^\/amp\/v1\/catalog\/[a-z]{2}\/songs\//.test(url.pathname)) {
            return route.fulfill({ json: { data: [{ id: url.pathname.split('/').pop(), type: 'songs', attributes: { name: 'Lyric song', artistName: 'Artist' } }] } });
          }
          if (url.pathname.startsWith('/amp/')) return route.fulfill({ status: 404, json: { errors: [] } });
          if (url.pathname === '/status') return route.fulfill({ json: { code: 0, regions: ['us'] } });
          // 服务端只返回 master 地址，master m3u8 由页面直接获取并解析（wrapper.js）
          if (url.pathname.startsWith('/parse/song/')) return route.fulfill({ json: { code: 0, data: { masterUrl: 'https://example.com/master.m3u8' } } });
          if (url.href === 'https://example.com/master.m3u8') return route.fulfill({ body: master, contentType: 'application/vnd.apple.mpegurl' });
          if (url.pathname.startsWith('/lyrics/')) {
            lyricRequests.push(url.pathname);
            return hasLyrics
              ? route.fulfill({ body: ttml, contentType: 'application/ttml+xml' })
              : route.fulfill({ status: 404, json: { code: 1, msg: 'lyrics not found' } });
          }
          // 单页应用：页面地址返回 app.html，页面视图在 /assets/views/
          const file = url.pathname === '/assets/mv/style.css' ? 'mv.css'
            : url.pathname.startsWith('/assets/mv/') ? 'mv-' + path.basename(url.pathname)
            : url.pathname.startsWith('/assets/lyrics/') ? path.join('lyrics', path.basename(url.pathname))
            : url.pathname.startsWith('/assets/views/') ? path.join('views', path.basename(url.pathname))
            : url.pathname.startsWith('/assets/') ? path.basename(url.pathname) : 'app.html';
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
          // 歌词界面跟随正在播放的歌曲（current.track）
          const { player } = window.AmApp;
          player.current = { id: 'fake', track: '123456789', country: 'us', mode: 'mse', title: 'Lyric song', codecs: 'mp4a.40.2', badge: 'lossy', label: 'AAC · 256 kbps' };
          player.transport = () => window.fakeTransport;
          player.emit();
          const bar = document.getElementById('player');
          bar.hidden = false;
          document.body.classList.add('has-player');
          player.renderMode();
        });
        await page.locator('.player-lyrics:not([hidden])').waitFor();
        await page.waitForTimeout(300);
        assert.deepEqual(lyricRequests, [], 'lyrics are not fetched until requested');
        if (!hasLyrics) {
          await page.locator('.player-lyrics').click();
          await page.locator('#toast:not([hidden])').waitFor();
          assert.equal(await page.locator('#toast').textContent(), '这首歌没有歌词');
          assert(await page.locator('.player-lyrics').isHidden(), 'no lyrics: button hides');
          assert(await page.locator('#lyrics-overlay').isHidden());
          // 没有歌词时点击播放条仍展开界面（同 music.apple.com），只显示封面、标题与播放控件
          await page.locator('.player-track').click();
          await page.locator('#lyrics-overlay:not([hidden])').waitFor();
          assert(await page.locator('#lyrics-overlay').evaluate(el => el.classList.contains('lyrics-hidden')), 'no lyrics: the view opens without lyrics');
          await page.locator('.lyric-panel').waitFor({ state: 'hidden' });
          assert(await page.locator('#lyrics-overlay .player-lyrics').isHidden(), 'no lyrics: no lyrics toggle');
          assert(await page.locator('#lyrics-overlay.cover-mode').count(), 'no lyrics: cover mode');
          assert(await page.locator('.lyrics-fav').isVisible() && await page.locator('.lyrics-more').isVisible(), 'favorite and More buttons');
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
          assert.deepEqual(lyricRequests, ['/lyrics/123456789'], 'the 404 is not refetched');
          await page.keyboard.press('Escape');
          await page.locator('#lyrics-overlay').waitFor({ state: 'hidden' });
          assert.deepEqual(errors, []);
          await context.close();
          scenarios++;
          continue;
        }
        // 对唱：页面加载的 parseTTML（浏览器的 DOMParser）与 toAmllLines 处理 duetTtml，检查歌手声明与每行的显示侧；只在第一个场景（宽 390）检查
        if (width === 390) {
          const { agents, sides } = await page.evaluate(async xml => {
            const { parseTTML } = await import('/assets/lyrics/ttml.mjs');
            const { toAmllLines } = await import('/assets/lyrics/panel.mjs');
            const song = parseTTML(xml);
            // 每行的 isDuet（选项同歌词界面的默认值），和声行记为 'bg:<isDuet>'
            return { agents: song.agents, sides: toAmllLines(song, { translation: false, pronunciation: false }).map(l => l.isBG ? `bg:${l.isDuet}` : l.isDuet) };
          }, duetTtml);
          assert.deepEqual(agents, { v1: { id: 'v1', type: 'person', name: 'Singer A' }, v2: { id: 'v2', type: 'person' }, v3: { id: 'v3', type: 'other' }, v1000: { id: 'v1000', type: 'group' } });
          // 照 AMLL 逐行手推：L1 的 v3 是第一位主唱、type 为 other，在对唱侧；L2 v2、L3 v1 换人就换侧，L3 的和声跟随 L3；
          // L4 合唱不在对唱侧，也不打断交替（L5 的 v2 接着 L3 的 v1 换侧）；L6 同一位主唱不换侧；L7 v1 换侧
          assert.deepEqual(sides, [true, false, true, 'bg:true', false, false, false, true]);
        }
        // Narrow layout opens from the player bar, wide layout from the button; both fetch once
        await page.locator(width === 390 ? '.player-track' : '.player-lyrics').click();
        await page.locator('#lyrics-overlay:not([hidden])').waitFor();
        assert.deepEqual(lyricRequests, ['/lyrics/123456789']);
        // AMLL line wrappers use hashed CSS-module class names; match their stable suffixes
        const lineSel = '.amll-lyric-player [class*="_lyricLineWrapper"]:not([class*="_bottomLineWrapper"])';
        await page.locator(lineSel).first().waitFor();
        assert.equal(await page.locator(lineSel).count(), 3, 'three lyric lines');
        const activeLines = () => page.evaluate(sel => [...document.querySelectorAll(sel)]
          .filter(el => [el, ...el.querySelectorAll('*')].some(n => [...n.classList].some(c => c.endsWith('_active'))))
          .map(el => el.querySelector('[class*="_lyricMainLine"]').textContent.trim()), lineSel);
        // 横向布局（宽大于高）与竖向布局（高大于宽，显示歌词时标题在小封面旁）
        const vertical = width < 844;
        assert.equal(await page.locator(vertical ? '#lyrics-overlay.layout-v' : '#lyrics-overlay.layout-h').count(), 1, 'layout follows the aspect ratio');
        const headSel = vertical ? '.lyrics-head--compact' : '.lyrics-head--main';
        const titleSel = `${headSel} .lyrics-title`;
        assert(await page.locator(`${headSel} .lyrics-fav`).count(), 'favorite and More follow the visible title row');
        assert.equal(await page.locator(`${titleSel} .marquee-line__text`).first().textContent(), 'Lyric song');
        assert(await page.locator(`${titleSel} .marquee-line.inactive`).count(), 'a short title does not scroll');
        // 歌名过长时保持一行并滚动（同播放条的滚动字幕），不换行
        const titleHeight = (await page.locator(titleSel).boundingBox()).height;
        await page.evaluate(([sel, head]) => {
          const text = document.querySelector(`${sel} .marquee-line__text`);
          text.textContent = 'A very long song title that cannot possibly fit on a single line of the full-screen player';
          // 标题行宽度变化时重新判断是否放得下（ResizeObserver）
          const row = document.querySelector(head);
          row.style.maxWidth = `${row.getBoundingClientRect().width - 1}px`;
        }, [titleSel, headSel]);
        await page.locator(`${titleSel} .marquee-line.active`).waitFor({ timeout: 2000 });
        assert(Math.abs((await page.locator(titleSel).boundingBox()).height - titleHeight) < 1, 'a long title stays on one line');
        await page.screenshot({ path: `target/ui-lyrics-long-title-${width}.png` });
        await page.evaluate(([sel, head]) => {
          document.querySelector(`${sel} .marquee-line__text`).textContent = 'Lyric song';
          document.querySelector(head).style.maxWidth = '';
        }, [titleSel, headSel]);
        await page.locator(`${titleSel} .marquee-line.inactive`).waitFor({ timeout: 2000 });
        // 翻译菜单（同 music.apple.com）：点按钮弹出，歌曲没有的一项置灰，Esc 只关闭菜单
        const openMenu = async () => {
          await page.locator('.lyrics-translation-button').click();
          await page.locator('.lyrics-menu:not([hidden])').waitFor();
        };
        await openMenu();
        assert.equal(await page.locator('[data-option="pronunciation"]').isDisabled(), true, 'no pronunciation for this song');
        await page.keyboard.press('Escape');
        await page.locator('.lyrics-menu').waitFor({ state: 'hidden' });
        assert(await page.locator('#lyrics-overlay').isVisible(), 'Escape closes only the menu');

        await page.evaluate(() => { fakeTransport.currentTime = 5.5; });
        await page.waitForTimeout(300);
        assert.deepEqual(await activeLines(), ['Second line']);
        // 声场界面盖住歌词界面时逐帧循环停下，关闭后从当前位置接上
        await page.evaluate(() => { AmApp.player.setSceneOpen(true); fakeTransport.currentTime = 9.5; });
        await page.waitForTimeout(300);
        assert.deepEqual(await activeLines(), ['Second line'], 'lyrics stop updating under the sound field');
        await page.evaluate(() => AmApp.player.setSceneOpen(false));
        await page.waitForTimeout(300);
        assert.deepEqual(await activeLines(), ['Third line'], 'lyrics resume once the sound field closes');
        await page.locator(lineSel).filter({ hasText: 'Third line' }).click();
        assert.equal(await page.evaluate(() => fakeTransport.currentTime), 9, 'clicking a line seeks the player');
        await page.waitForTimeout(300);
        assert.deepEqual(await activeLines(), ['Third line']);

        await openMenu();
        await page.locator('[data-option="translation"]').click();
        assert(await page.locator('.lyrics-menu').isHidden(), 'choosing an option closes the menu');
        assert.equal(await page.locator('.lyrics-translation-button .amll-toggle-icon--on').count(), 1, 'the icon inverts while translations are shown');
        await openMenu();
        assert.equal(await page.locator('[data-option="translation"]').getAttribute('title'), await page.evaluate(() => AmI18n.t('lyrics.hideTranslation')));
        await page.keyboard.press('Escape');
        await page.locator('.lyrics-menu').waitFor({ state: 'hidden' });
        await page.locator(lineSel).filter({ hasText: 'Tercera línea' }).waitFor({ state: 'visible', timeout: 2000 });
        assert.equal(await page.locator('.credit-names').textContent(), 'Writer A、Writer B');
        await page.evaluate(() => AmI18n.toggle()); // the overlay covers the page's language button
        assert.equal(await page.locator('.credit-names').textContent(), 'Writer A, Writer B');
        assert.equal(await page.locator('.lyrics-close').getAttribute('aria-label'), 'Close lyrics');

        // 歌词选项：字号与字重在菜单里连续调整（菜单不关闭），保存在浏览器中
        const lyricStyle = () => page.locator('.amll-lyric-player').evaluate(el => {
          const style = getComputedStyle(el);
          return { size: parseFloat(style.fontSize), weight: style.fontWeight };
        });
        const prefs = () => page.evaluate(() => JSON.parse(localStorage.getItem('am-hook:lyrics-prefs') || 'null'));
        const base = await lyricStyle();
        assert.equal(base.weight, '600');
        await openMenu();
        await page.locator('[data-action="fontLarger"]').click();
        await page.locator('[data-action="fontLarger"]').click();
        await page.locator('[data-action="weightBolder"]').click();
        assert(await page.locator('.lyrics-menu').isVisible(), 'the menu stays open while adjusting');
        assert.deepEqual(await page.locator('.lyrics-menu-value').allTextContents(), ['120%', 'Bold']);
        const larger = await lyricStyle();
        assert(Math.abs(larger.size / base.size - 1.2) < 0.01, `font size scales: ${base.size} -> ${larger.size}`);
        assert.equal(larger.weight, '700');
        assert.deepEqual(await prefs(), { scale: 1.2, weight: 700, source: 'apple', backdrop: 'amll' });
        await page.locator(lineSel).filter({ hasText: 'Third line' }).waitFor({ state: 'visible', timeout: 2000 });
        await page.screenshot({ path: `target/ui-lyrics-options-${width}.png` });
        await page.locator('[data-action="weightBolder"]').click();
        assert(await page.locator('[data-action="weightBolder"]').isDisabled(), 'the heaviest weight disables Bolder');
        await page.locator('[data-action="fontSmaller"]').click();
        await page.locator('[data-action="fontSmaller"]').click();
        await page.locator('[data-action="weightLighter"]').click();
        await page.locator('[data-action="weightLighter"]').click();
        assert.deepEqual(await lyricStyle(), base, 'back to the default size and weight');

        // 下载正在显示的 TTML 原文
        const [appleDownload] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="download"]').click()]);
        assert.equal(appleDownload.suggestedFilename(), 'Lyric song.ttml');
        assert.equal(fs.readFileSync(await appleDownload.path(), 'utf8'), ttml);
        assert(await page.locator('.lyrics-menu').isHidden(), 'downloading closes the menu');

        // 歌词来源：默认不请求 AMLL 歌词库；未收录时提示并改用 Apple Music 歌词，菜单里说明原因
        assert.deepEqual(amllRequests, [], 'the AMLL TTML DB is only contacted when chosen');
        await openMenu();
        assert.equal(await page.locator('[data-action="source"][aria-checked="true"]').getAttribute('data-value'), 'apple');
        amllHasSong = false;
        await page.locator('[data-action="source"][data-value="amll"]').click();
        await page.locator('#toast:not([hidden])').filter({ hasText: 'AMLL' }).waitFor();
        assert.equal(await page.locator('#toast').textContent(), await page.evaluate(() => AmI18n.t('lyrics.amllMissing')));
        await openMenu();
        assert.equal(await page.locator('.lyrics-menu-note').textContent(), await page.evaluate(() => AmI18n.t('lyrics.amllMissing')));
        await page.locator(lineSel).filter({ hasText: 'Second line' }).waitFor({ state: 'visible', timeout: 2000 }); // Apple Music lyrics stay
        await page.locator('[data-action="source"][data-value="apple"]').click();
        assert.equal((await prefs()).source, 'apple');
        assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('lyrics-translation-button')), true, 'focus returns to the options button');
        // 收录时按 Apple Music 歌曲 ID 取歌词，行内翻译与和声照常显示
        amllHasSong = true;
        amllRequests.length = 0;
        await openMenu();
        await page.locator('[data-action="source"][data-value="amll"]').click();
        await page.locator(lineSel).filter({ hasText: 'Amll second' }).first().waitFor({ state: 'visible', timeout: 3000 });
        assert.deepEqual(amllRequests, ['/v1/lyrics/get?appleMusicId=123456789']);
        const mainLines = await page.evaluate(sel => [...document.querySelectorAll(sel)].map(el => el.querySelector('[class*="_lyricMainLine"]')?.textContent.trim()), lineSel);
        assert.deepEqual(mainLines, ['Amll first', 'Amll second', 'Amll third']);
        const playerText = await page.locator('.amll-lyric-player').textContent();
        assert(playerText.includes('echo') && !playerText.includes('(echo)') && playerText.includes('回声'), 'background vocal with its translation');
        assert(mainLines.every(text => !/第|amll/.test(text)), `inline translations stay out of the words: ${mainLines}`);
        await page.locator(lineSel).filter({ hasText: '第二行' }).first().waitFor({ state: 'visible', timeout: 2000 });
        assert((await page.locator('.lyrics-credits').textContent()).includes('@lyricist'), 'credits the AMLL TTML author');
        assert.equal((await prefs()).source, 'amll');
        await openMenu();
        const [amllDownload] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="download"]').click()]);
        assert.equal(fs.readFileSync(await amllDownload.path(), 'utf8'), amllTtml, 'downloads the AMLL TTML');
        await page.screenshot({ path: `target/ui-lyrics-amll-${width}.png` });
        // 换回 Apple Music：用已取到的歌词，不再请求
        await openMenu();
        await page.locator('[data-action="source"][data-value="apple"]').click();
        await page.locator(lineSel).filter({ hasText: 'Second line' }).waitFor({ state: 'visible', timeout: 3000 });
        assert.equal((await prefs()).source, 'apple');
        assert(!(await page.locator('.lyrics-credits').textContent()).includes('@lyricist'));

        // 背景：经典背景（引入 AMLL 前的 ArtworkBackdrop）与 AMLL 流动背景来回切换，每次换一块新画布
        await openMenu();
        assert.equal(await page.locator('[data-action="backdrop"][aria-checked="true"]').getAttribute('data-value'), 'amll');
        await page.locator('[data-action="backdrop"][data-value="classic"]').click();
        assert.equal((await prefs()).backdrop, 'classic');
        assert.equal(await page.locator('.lyrics-backdrop').count(), 1, 'the old canvas is replaced');
        // 经典背景下隐藏再显示歌词（applyVisibility 会调用背景的 setHasLyric），歌词照常显示
        await page.locator('.player-lyrics').click();
        await page.locator('.player-lyrics').click();
        await page.locator(lineSel).filter({ hasText: 'Second line' }).waitFor({ state: 'visible', timeout: 2000 });
        assert.deepEqual(errors, [], 'no page errors with the classic backdrop');
        await openMenu();
        assert.equal(await page.locator('[data-action="backdrop"][aria-checked="true"]').getAttribute('data-value'), 'classic');
        await page.locator('[data-action="backdrop"][data-value="amll"]').click();
        assert.equal((await prefs()).backdrop, 'amll');
        assert.equal(await page.locator('.lyrics-backdrop').count(), 1, 'the old canvas is replaced');

        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
        const panel = await page.locator('.lyric-panel').boundingBox();
        const bar = await page.locator('#player').boundingBox();
        const overlaps = (a, b) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
        // 手机上歌词区延伸到底部，控件叠在其下部（歌词在控件上方渐隐，见 app.css），只在宽屏检查
        if (width >= 484) assert(!overlaps(panel, bar), 'lyrics and the player controls must not overlap');
        assert(bar.y + bar.height <= 844, 'player controls stay on screen');
        assert(await page.locator('#lyrics-overlay .lyrics-controls #player').count(), 'the player moves into the lyrics view');
        // 音质标志在进度条下方，点击弹出音质详情，列出这首歌的音质（fixture 只有 AAC 256）；Esc 只收起详情
        await page.mouse.move(width / 2, 300);
        const qualityBadge = page.locator('#lyrics-overlay .player-mode');
        assert(await qualityBadge.locator('.q-icon--lossy').isVisible(), 'the quality badge shows the AAC icon');
        await qualityBadge.click();
        await page.locator('.quality-option').first().waitFor();
        const qualityPanel = await page.locator('.quality-panel').boundingBox();
        assert(qualityPanel.x >= 0 && qualityPanel.x + qualityPanel.width <= width && qualityPanel.y >= 0 && qualityPanel.y + qualityPanel.height <= 844, 'the quality panel fits the viewport');
        assert.equal(await page.locator('.quality-option').count(), 1, 'lists the qualities of the song');
        assert.match(await page.locator('.quality-panel-specs').textContent(), /MSE · AAC-LC/, 'shows the playback method');
        await page.waitForTimeout(300);
        await page.screenshot({ path: `target/ui-lyrics-quality-${width}.png` });
        await page.keyboard.press('Escape');
        assert(await page.locator('.quality-panel').isHidden(), 'Escape closes the quality panel');
        assert(await page.locator('#lyrics-overlay').isVisible(), 'Escape keeps the lyrics view open while closing the quality panel');
        await page.screenshot({ path: `target/ui-lyrics-${width}.png` });

        // 标题旁的喜爱与「更多」（同 music.apple.com 全屏播放界面）：喜爱正在播放的歌曲并加入资料库
        const fav = page.locator('.lyrics-fav');
        assert.equal(await fav.getAttribute('aria-pressed'), 'false');
        await fav.click();
        await page.locator('.lyrics-fav[aria-pressed="true"]').waitFor();
        assert(await page.evaluate(async () => {
          const library = await import('/assets/library.mjs');
          return library.isFavorite('song', '123456789') && library.inLibrary('song', '123456789');
        }), 'the playing song is favorited and added to the library');
        await page.locator('.lyrics-more').click();
        const moreMenu = page.locator('.menu');
        await moreMenu.waitFor();
        const menuText = await moreMenu.textContent();
        assert(menuText.includes('Undo Favorite') && menuText.includes('Delete from Library') && menuText.includes('Add to Playlist'), menuText);
        assert.equal(await moreMenu.locator('.menu-label', { hasText: /^Play$/ }).count(), 0, 'no Play item for the playing song');
        await page.keyboard.press('Escape');
        await moreMenu.waitFor({ state: 'hidden' });
        assert(await page.locator('#lyrics-overlay').isVisible(), 'Escape closes only the More menu');

        // 界面里的歌词按钮：隐藏歌词后封面与控件居中，选择保存在浏览器中，再次点击恢复
        const lyricToggle = page.locator('#lyrics-overlay .player-lyrics');
        assert.equal(await lyricToggle.getAttribute('aria-pressed'), 'true');
        assert.equal(await lyricToggle.getAttribute('aria-label'), 'Hide lyrics');
        await lyricToggle.click();
        assert(await page.locator('#lyrics-overlay.lyrics-hidden').count(), 'lyrics hidden');
        await page.locator('.lyric-panel').waitFor({ state: 'hidden' });
        assert(await page.locator('.lyrics-translation-menu').isHidden());
        assert(await page.locator('#lyrics-overlay.cover-mode').count(), 'cover mode');
        assert.equal(await lyricToggle.getAttribute('aria-label'), 'Show lyrics');
        assert.equal(await page.evaluate(() => localStorage.getItem('am-hook:lyrics-hidden')), '1');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width} without lyrics`);
        // 这里的歌曲没有封面（.lyrics-art 隐藏），检查标题行与控件；等标题行移入、左栏移到中间
        await page.waitForTimeout(900);
        const head = await page.locator('.lyrics-head--main').boundingBox();
        const cover = await page.locator('.lyrics-cover').boundingBox();
        assert(Math.abs(cover.x + cover.width / 2 - width / 2) < 2, `the cover is centered: ${JSON.stringify(cover)}`);
        const hiddenBar = await page.locator('#player').boundingBox();
        assert(hiddenBar.y + hiddenBar.height <= 844 && head.y >= 0 && head.y + head.height <= hiddenBar.y, 'title and controls fit on screen');
        await page.screenshot({ path: `target/ui-lyrics-hidden-${width}.png` });
        await lyricToggle.click();
        assert.equal(await page.locator('#lyrics-overlay.lyrics-hidden').count(), 0, 'lyrics shown again');
        await page.locator(lineSel).filter({ hasText: 'Third line' }).waitFor({ state: 'visible', timeout: 2000 });
        assert.equal(await page.evaluate(() => localStorage.getItem('am-hook:lyrics-hidden')), null);

        // 待播清单开关在界面底部：清单占据歌词的位置；竖向布局的随机 / 重复在清单标题旁，横向布局的在播放控件里；Esc 或歌词开关回到歌词
        const queueToggle = page.locator('#lyrics-overlay .player-queue');
        assert.equal(await page.locator('#lyrics-overlay .player-shuffle').isVisible(), !vertical, 'shuffle among the controls only in the horizontal layout');
        await queueToggle.click();
        await page.locator('#queue-panel.in-lyrics').waitFor();
        assert(await page.locator('#lyrics-overlay.queue-open').count(), 'queue replaces the lyrics');
        await page.locator('.lyric-panel').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#queue-panel .player-shuffle').isVisible(), vertical, 'shuffle and repeat in the queue only in the vertical layout');
        await page.waitForTimeout(900); // 清单滑入、标题行移入的动画
        const queue = await page.locator('#queue-panel').boundingBox();
        const controls = await page.locator('#player').boundingBox();
        if (vertical) {
          const title = await page.locator('.lyrics-head--compact').boundingBox();
          assert(queue.y >= title.y + title.height - 1 && queue.y + queue.height <= controls.y + 1, `queue sits between the title row and the controls: ${JSON.stringify({ queue, title, controls })}`);
        } else {
          assert(!overlaps(queue, controls) && queue.x >= width * 0.4, 'queue takes the lyrics column');
        }
        await page.screenshot({ path: `target/ui-lyrics-queue-${width}.png` });
        await page.keyboard.press('Escape');
        assert(await page.locator('#queue-panel').isHidden() && await page.locator('#lyrics-overlay').isVisible(), 'Escape closes only the queue');
        await queueToggle.click();
        await page.locator('#queue-panel.in-lyrics').waitFor();
        await queueToggle.click();
        assert(await page.locator('#queue-panel').isHidden(), 'the queue toggle closes the queue');
        await queueToggle.click();
        await lyricToggle.click();
        assert(await page.locator('#queue-panel').isHidden() && await page.locator('#lyrics-overlay.queue-open, #lyrics-overlay.lyrics-hidden').count() === 0, 'the lyrics toggle returns to the lyrics');

        await page.keyboard.press('Escape');
        await page.locator('#lyrics-overlay').waitFor({ state: 'hidden' });
        assert(await page.locator('#player .player-lyrics').count() && await page.locator('#player .player-queue').count(), 'the toggles return to the player bar');
        assert(await page.locator('.player-lyrics').evaluate(el => el === document.activeElement), 'focus returns to the lyrics button');
        await page.locator('.player-track').click();
        await page.locator('#lyrics-overlay:not([hidden])').waitFor();
        assert.deepEqual(lyricRequests, ['/lyrics/123456789'], 'reopening uses the cached lyrics');
        await page.locator('.seek').click();
        assert(await page.locator('#lyrics-overlay').isVisible(), 'the seek bar seeks instead of toggling lyrics');
        await page.keyboard.press('Escape');
        assert.deepEqual(errors, []);
        await context.close();
        scenarios++;
      }
    }
    console.log(`Passed ${scenarios} lyric scenarios: loading, line tracking, seeking, translation, language and layout.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

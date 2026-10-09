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
          if (url.pathname.startsWith('/parse/song/')) return route.fulfill({ json: { masterUrl: 'https://example.com/master.m3u8', variants } });
          if (url.pathname.startsWith('/lyrics/')) {
            lyricRequests.push(url.pathname);
            return hasLyrics
              ? route.fulfill({ body: ttml, contentType: 'application/ttml+xml' })
              : route.fulfill({ status: 404, json: { code: 1, msg: 'lyrics not found' } });
          }
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
        await page.goto('http://am.test/https://music.apple.com/us/song/_/123456789');
        await page.locator('.variant').first().waitFor();
        // Drive the lyric view from a fake transport; real decoding is covered elsewhere.
        await page.evaluate(() => {
          window.fakeTransport = { currentTime: 0, paused: false, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; } };
          // 歌词界面跟随正在播放的歌曲（current.track）
          const { player } = window.AmApp;
          player.current = { id: 'fake', track: '123456789', country: 'us', mode: 'mse', title: 'Lyric song' };
          player.transport = () => window.fakeTransport;
          player.emit();
          const bar = document.getElementById('player');
          bar.hidden = false;
          document.body.classList.add('has-player');
          const notice = bar.querySelector('.player-notice');
          notice.textContent = 'Playback notice';
          notice.hidden = false;
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
          assert(await page.locator('.lyric-panel').isHidden());
          assert(await page.locator('#lyrics-overlay .player-lyrics').isHidden(), 'no lyrics: no lyrics toggle');
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
        assert.equal(await page.locator('.lyrics-title .marquee-line__text').first().textContent(), 'Lyric song');
        assert(await page.locator('.lyrics-title .marquee-line.inactive').count(), 'a short title does not scroll');
        // 歌名过长时保持一行并滚动（同播放条的滚动字幕），不换行
        const titleHeight = (await page.locator('.lyrics-title').boundingBox()).height;
        await page.evaluate(() => {
          const text = document.querySelector('.lyrics-title .marquee-line__text');
          text.textContent = 'A very long song title that cannot possibly fit on a single line of the full-screen player';
          // 标题行宽度变化时重新判断是否放得下（ResizeObserver）
          const head = document.querySelector('.lyrics-head');
          head.style.maxWidth = `${head.getBoundingClientRect().width - 1}px`;
        });
        await page.locator('.lyrics-title .marquee-line.active').waitFor({ timeout: 2000 });
        assert(Math.abs((await page.locator('.lyrics-title').boundingBox()).height - titleHeight) < 1, 'a long title stays on one line');
        await page.screenshot({ path: `target/ui-lyrics-long-title-${width}.png` });
        await page.evaluate(() => {
          document.querySelector('.lyrics-title .marquee-line__text').textContent = 'Lyric song';
          document.querySelector('.lyrics-head').style.maxWidth = '';
        });
        await page.locator('.lyrics-title .marquee-line.inactive').waitFor({ timeout: 2000 });
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
        await page.locator(lineSel).filter({ hasText: 'Third line' }).click();
        assert.equal(await page.evaluate(() => fakeTransport.currentTime), 9, 'clicking a line seeks the player');
        await page.waitForTimeout(300);
        assert.deepEqual(await activeLines(), ['Third line']);

        await openMenu();
        await page.locator('[data-option="translation"]').click();
        assert(await page.locator('.lyrics-menu').isHidden(), 'choosing an option closes the menu');
        assert.equal(await page.locator('.lyrics-translation-button .invertible-mask--inverted').count(), 1, 'the icon inverts while translations are shown');
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
        assert(!overlaps(panel, bar), 'lyrics and the player controls must not overlap');
        assert(bar.y + bar.height <= 844, 'player controls stay on screen');
        assert(await page.locator('#lyrics-overlay .lyrics-controls #player').count(), 'the player moves into the lyrics view');
        assert(await page.locator('.player-notice').isHidden(), 'playback notices are hidden in the lyrics view');
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
        // 条目菜单（actions.mjs）没有 id，#menu 是页面上的另一个菜单
        const moreMenu = page.locator('.menu:not(#menu)');
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
        assert(await page.locator('.lyric-panel').isHidden() && await page.locator('.lyrics-translation-menu').isHidden());
        assert.equal(await lyricToggle.getAttribute('aria-label'), 'Show lyrics');
        assert.equal(await page.evaluate(() => localStorage.getItem('am-hook:lyrics-hidden')), '1');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width} without lyrics`);
        // 这里的歌曲没有封面（.lyrics-art 隐藏），检查标题行与控件
        const head = await page.locator('.lyrics-head').boundingBox();
        const hiddenBar = await page.locator('#player').boundingBox();
        assert(hiddenBar.y + hiddenBar.height <= 844 && head.y >= 0 && head.y + head.height <= hiddenBar.y, 'title and controls fit on screen');
        await page.screenshot({ path: `target/ui-lyrics-hidden-${width}.png` });
        await lyricToggle.click();
        assert.equal(await page.locator('#lyrics-overlay.lyrics-hidden').count(), 0, 'lyrics shown again');
        await page.locator(lineSel).filter({ hasText: 'Third line' }).waitFor({ state: 'visible', timeout: 2000 });
        assert.equal(await page.evaluate(() => localStorage.getItem('am-hook:lyrics-hidden')), null);

        // 待播清单开关只在手机的界面里：清单占据歌词的位置，随机 / 重复在清单标题旁；Esc 或歌词开关回到歌词
        const queueToggle = page.locator('#lyrics-overlay .player-queue');
        if (width === 390) {
          assert(await page.locator('#lyrics-overlay .player-shuffle').isHidden(), 'no shuffle among the phone controls');
          await queueToggle.click();
          await page.locator('#queue-panel.in-lyrics').waitFor();
          assert(await page.locator('#lyrics-overlay.queue-open').count(), 'queue replaces the lyrics');
          assert(await page.locator('#queue-panel .player-shuffle').isVisible() && await page.locator('#queue-panel .player-repeat').isVisible(), 'shuffle and repeat are in the queue');
          const queue = await page.locator('#queue-panel').boundingBox();
          const controls = await page.locator('#player').boundingBox();
          const title = await page.locator('.lyrics-side').boundingBox();
          assert(queue.y >= title.y + title.height - 1 && queue.y + queue.height <= controls.y + 1, 'queue sits between the title row and the controls');
          await page.screenshot({ path: 'target/ui-lyrics-queue-390.png' });
          await page.keyboard.press('Escape');
          assert(await page.locator('#queue-panel').isHidden() && await page.locator('#lyrics-overlay').isVisible(), 'Escape closes only the queue');
          await queueToggle.click();
          await lyricToggle.click();
          assert(await page.locator('#queue-panel').isHidden() && await page.locator('#lyrics-overlay.queue-open, #lyrics-overlay.lyrics-hidden').count() === 0, 'the lyrics toggle returns to the lyrics');
        } else {
          assert(await queueToggle.isHidden(), 'no queue toggle in the desktop view');
        }

        await page.keyboard.press('Escape');
        assert(await page.locator('#lyrics-overlay').isHidden());
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

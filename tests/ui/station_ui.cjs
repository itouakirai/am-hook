// node tests/station_ui.cjs <path-to-playwright-package>
// Local fixtures (no wrapper-lite, amp-api or Apple CDN) for Radio and the station pages (views/browse.mjs radio, views/station.mjs,
// station.mjs, mv/radio.mjs): the nav entry between Top Charts and Settings, the radio grouping with the live radio shelf and
// "Your Stations", the media-user-token prompt on the first station visit (rejected, then a pasted Cookie), track stations with
// more batches and an endless queue, episodes and live radio in the MV layout, and the token row in Settings.
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');
const { serveWeb } = require('../support/web.cjs');

/** 单页应用：页面地址返回 app.html，/assets/<path> 即 web/<path> */
const asset = serveWeb;

const art = (id) => ({ url: `https://img.test/${id}/{w}x{h}{c}.{f}`, width: 1080, height: 1080, bgColor: '336699' });
const station = (id, name, attributes = {}) => ({ id, type: 'stations', href: `/v1/catalog/cn/stations/${id}`, attributes: {
  name, artwork: art(id), url: `https://music.apple.com/cn/station/${encodeURIComponent(name)}/${id}`, mediaKind: 'audio', isLive: false,
  plainEditorialNotes: { short: `${name} short`, standard: `${name} standard` }, ...attributes } });
const TRACKS = station('ra.100', 'Pop Station', { kind: 'editorial', playParams: { format: 'tracks', id: 'ra.100', kind: 'radioStation' } });
const EPISODE = station('ra.200', 'An Episode', { kind: 'streaming', streamingRadioSubType: 'Episode', durationInMillis: 3600000,
  airTime: { start: '2026-10-01T10:00:00Z', end: '2026-10-01T11:00:00Z' },
  playParams: { format: 'stream', hasDrm: true, id: 'ra.200', kind: 'radioStation', mediaType: 0, stationHash: 'h200', streamingKind: 1 } });
const now = Date.now();
const LIVE = station('ra.300', 'Live One', { kind: 'streaming', isLive: true, stationProviderName: 'Apple Music',
  editorialArtwork: { brandLogo: art('logo300') },
  playParams: { format: 'stream', hasDrm: true, id: 'ra.300', kind: 'radioStation', mediaType: 0, stationHash: 'h300' } });
LIVE.relationships = { events: { data: [0, 1].map((i) => ({ id: `ra.300-${i}`, type: 'station-events', attributes: {
  title: `Show ${i}`, startTime: new Date(now + (i - 0.5) * 3600e3).toISOString(), endTime: new Date(now + (i + 0.5) * 3600e3).toISOString(),
  description: { standard: `About show ${i}` }, heroArtwork: art(`show${i}`) } })) } };
const PERSONAL = station('ra.u-abc', 'My Station', { kind: 'user', playParams: { format: 'tracks', id: 'ra.u-abc', kind: 'radioStation' } });

let songSeq = 0;
const song = () => {
  const id = String(1000 + ++songSeq);
  return { id, type: 'songs', attributes: { name: `Song ${id}`, artistName: 'Artist', albumName: 'Album', durationInMillis: 180000, artwork: art(id),
    url: `https://music.apple.com/cn/album/album/9/${id}?i=${id}`, playParams: { id, kind: 'song' } } };
};

const element = (id, kind, attributes = {}, relationships = {}) => ({ id, type: 'editorial-elements', attributes: { editorialElementKind: kind, ...attributes }, relationships });
const grouping = { data: [{ id: 'g', type: 'groupings', attributes: { name: 'Radio' }, relationships: { tabs: { data: [element('tab', '382', {}, { children: { data: [
  element('live', '488', { name: 'Live Radio' }, { children: { data: [element('l1', '489', {}, { contents: { data: [LIVE] } })] } }),
  element('swoosh', '326', { name: 'Episodes', displayStyle: 'expanded' }, { contents: { data: [EPISODE, TRACKS] } }),
] } })] } } }] };

const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.5"\n64/prog.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS="mp4a.40.2"\n256/prog.m3u8\n';

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
    for (const width of [390, 1440]) for (const lang of ['zh', 'en']) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript((l) => {
        if (sessionStorage.getItem('am-test')) return;
        sessionStorage.setItem('am-test', '1');
        localStorage.setItem('am-hook:lang', l);
        localStorage.setItem('am-hook:storefront', 'cn');
      }, lang);
      const seen = { token: [], license: 0 };
      await context.route('**/*', (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.hostname === 'img.test') return route.fulfill({ status: 404, body: '' });
        if (url.hostname === 'cdn.test') return route.fulfill({ body: master, contentType: 'application/vnd.apple.mpegurl', headers: { 'access-control-allow-origin': '*' } });
        if (url.pathname === '/status') return route.fulfill({ json: { code: 0, regions: ['cn'] } });
        if (url.pathname === '/amp/v1/editorial/cn/groupings') {
          assert.equal(url.searchParams.get('name'), 'radio');
          return route.fulfill({ json: grouping });
        }
        const one = url.pathname.match(/^\/amp\/v1\/catalog\/cn\/stations\/(ra\.[\w.-]+)$/);
        if (one) {
          const found = [TRACKS, EPISODE, LIVE, PERSONAL].find((s) => s.id === one[1]);
          return route.fulfill(found ? { json: { data: [found] } } : { status: 404, json: { errors: [{ detail: 'Not found' }] } });
        }
        if (url.pathname.startsWith('/amp/')) return route.fulfill({ status: 404, json: { errors: [] } });
        if (url.pathname.startsWith('/station/')) {
          const token = request.headers()['x-media-user-token'];
          seen.token.push(token);
          if (token !== 'good-token') return route.fulfill({ status: 401, json: { errors: [{ detail: 'Unauthorized' }] } });
          if (url.pathname === '/station/storefront') return route.fulfill({ json: { data: [{ id: 'cn', attributes: { name: '中国大陆' } }] } });
          if (url.pathname === '/station/recent') return route.fulfill({ json: { data: [EPISODE] } });
          if (url.pathname === '/station/catalog/cn/stations') {
            assert.equal(url.searchParams.get('filter[identity]'), 'personal');
            return route.fulfill({ json: { data: [PERSONAL] } });
          }
          if (url.pathname.startsWith('/station/next-tracks/')) {
            assert.equal(request.method(), 'POST');
            assert.equal(url.searchParams.get('limit'), '10');
            return route.fulfill({ json: { data: [song(), song()] } });
          }
          if (url.pathname === '/station/assets') {
            assert.equal(url.searchParams.get('keyFormat'), 'web');
            return route.fulfill({ json: { results: { assets: [{ url: 'https://cdn.test/index.m3u8', keyServerUrl: 'https://play.itunes.apple.com/WebObjects/MZPlay.woa/web/radio/versions/1/license' }] } } });
          }
          return route.fulfill({ status: 404, json: {} });
        }
        if (url.pathname.startsWith('/parse/') || url.pathname.startsWith('/lyrics/')) return route.fulfill({ status: 500, json: { code: 1, msg: 'Fixture failure' } });
        return asset(route, url);
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const fits = async (where) => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow ${where} ${width}/${lang}`);
      const zh = lang === 'zh';

      // The nav entry sits between Top Charts and Settings
      await page.goto('http://am.test/');
      assert.deepEqual(await page.locator('.nav-list > .nav-item > [data-nav]').evaluateAll((n) => n.map((a) => a.dataset.nav)).then((list) => list.slice(0, 5)),
        ['home', 'new', 'charts', 'radio', 'settings']);

      // Radio without a token: editorial content only, the live shelf, local station links
      await page.goto('http://am.test/radio');
      await page.locator('.ed-live').first().waitFor();
      assert.equal((await page.locator('#title').textContent()).trim(), zh ? '广播' : 'Radio');
      assert.equal(await page.locator('[data-nav="radio"]').getAttribute('aria-current'), 'page');
      assert.equal(await page.locator('.ed-live-badge').first().textContent(), zh ? '直播' : 'LIVE');
      assert.match(await page.locator('.ed-live').first().textContent(), /Live One.*Show 0/);
      assert.equal(await page.locator('.ed-live').first().getAttribute('href'), '/https://music.apple.com/cn/station/Live%20One/ra.300');
      assert.deepEqual(await page.locator('.ed-horizontal').evaluateAll((n) => n.map((a) => a.getAttribute('href'))),
        ['/https://music.apple.com/cn/station/An%20Episode/ra.200', '/https://music.apple.com/cn/station/Pop%20Station/ra.100']);
      assert.equal(seen.token.length, 0, 'no token requests without a token');
      await fits('radio');

      // First station visit asks for the token; a rejected token keeps the dialog open with the reason
      await page.locator('.ed-horizontal').nth(1).click();
      const dialog = page.locator('dialog.lib-dialog');
      await dialog.waitFor();
      await dialog.locator('textarea').fill('bad-token');
      await dialog.locator('.lib-dialog-btn.primary').click();
      await page.waitForFunction(() => /Unauthorized/.test(document.querySelector('dialog.lib-dialog .lib-dialog-message')?.textContent || ''));
      // A whole Cookie header also works
      await dialog.locator('textarea').fill('itspod=1; media-user-token=good-token; other=x');
      await dialog.locator('.lib-dialog-btn.primary').click();
      await page.locator('#tracks .pl-track').nth(1).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('am-hook:media-user-token')), 'good-token');
      assert.equal((await page.locator('#title').textContent()).trim(), 'Pop Station');
      assert.equal((await page.locator('#eyebrow').textContent()).trim(), zh ? '电台' : 'Station');
      assert.equal(await page.locator('[data-nav="radio"]').getAttribute('aria-current'), 'page');
      await page.locator('#more').click();
      await page.locator('#tracks .pl-track').nth(3).waitFor();
      assert.equal(await page.locator('#tracks .track-rank').nth(3).textContent(), '4');
      // New batch replaces the list
      const listed = await page.locator('#tracks .track-title').allTextContents();
      await page.locator('#refresh').click();
      await page.waitForFunction((before) => document.querySelectorAll('#tracks .pl-track').length === 2
        && !before.includes(document.querySelector('#tracks .track-title').textContent), listed);
      assert(await page.locator('#alert').isHidden());
      // Play queues the listed songs and, with fewer than 3 left, fetches the next batch into the queue and the page
      // (playback itself fails without wrapper-lite)
      await page.locator('#play-all').click();
      await page.waitForFunction(() => window.AmApp.player.queue && window.AmApp.player.queue.entries.length === 4);
      assert.equal(await page.locator('#tracks .pl-track').count(), 4);
      await fits('tracks');
      await toggleLang(page);
      assert.equal((await page.locator('#eyebrow').textContent()).trim(), zh ? 'Station' : '电台');
      await toggleLang(page);

      // Radio with a token: Your Stations (personal station first, then recently played)
      await page.goto('http://am.test/radio');
      await page.locator('.ed-live').first().waitFor();
      assert.equal(await page.locator('.ed-heading').first().textContent(), zh ? '你的电台' : 'Your Stations');
      assert.deepEqual(await page.locator('.ed-section').first().locator('.shelf-title').allTextContents(), ['My Station', 'An Episode']);

      // An episode: MV layout, the two audio variants (highest first), downloadable as M4A
      await page.goto('http://am.test/https://music.apple.com/cn/station/an-episode/ra.200');
      await page.waitForFunction(() => document.querySelector('#play') && !document.querySelector('#play').disabled);
      assert.equal(await page.locator('#audio-count').textContent(), '2');
      assert(await page.locator('#video-tracks').isHidden());
      assert.match(await page.locator('#audio-trigger').textContent(), /AAC.*256 kbps/);
      assert.match(await page.locator('#selection').textContent(), /AAC 256 kbps/);
      assert(await page.locator('#download').isVisible());
      assert.match(await page.locator('#download').textContent(), /M4A/);
      assert.equal((await page.locator('#kind-badge').textContent()).trim(), zh ? '广播单集' : 'Episode');
      await page.locator('#audio-trigger').click();
      await page.locator('#audios .mv-option').nth(1).click();
      assert.match(await page.locator('#selection').textContent(), /HE-AAC 64 kbps/);
      await fits('episode');

      // Live radio: no download, the schedule with the show on air now
      await page.goto('http://am.test/https://music.apple.com/cn/station/live-one/ra.300');
      await page.waitForFunction(() => document.querySelector('#play') && !document.querySelector('#play').disabled);
      assert(await page.locator('#download').isHidden());
      assert.equal(await page.locator('#schedule-list li').count(), 2);
      assert.equal(await page.locator('#schedule-list li.on-air').count(), 1);
      assert.equal((await page.locator('#artist').textContent()).trim(), 'Apple Music');
      await fits('live');
      if (width === 1440) await page.screenshot({ path: `target/station-ui-live-${lang}.png`, fullPage: true });

      // A rejected token on a station page offers to enter it again
      await page.evaluate(() => localStorage.setItem('am-hook:media-user-token', 'expired'));
      await page.goto('http://am.test/https://music.apple.com/cn/station/an-episode/ra.200');
      await dialog.waitFor();
      assert.match(await dialog.locator('.lib-dialog-message').textContent(), /Unauthorized/);
      await dialog.locator('.lib-dialog-btn:not(.primary):not(.danger)').click();
      await page.locator('#token-box').waitFor();
      assert(await page.locator('#play').isDisabled());

      // Settings shows whether a token is set and can clear it
      await page.evaluate(() => localStorage.setItem('am-hook:media-user-token', 'good-token'));
      await page.goto('http://am.test/settings');
      await page.locator('#user-token-value').waitFor();
      assert.match(await page.locator('#user-token-value').textContent(), /…-token$/);
      await page.locator('#user-token').click();
      await dialog.locator('.lib-dialog-btn.danger').click();
      await page.waitForFunction(() => !localStorage.getItem('am-hook:media-user-token'));
      assert.equal(await page.locator('#user-token-value').textContent(), zh ? '未填写' : 'Not set');

      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('station UI ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });

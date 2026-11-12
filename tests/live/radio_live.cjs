// Opt-in browser integration test for Radio and the station pages. Requires a running am-hook, a media-user-token and Apple CDN access.
// node tests/radio_live.cjs <playwright-package-path> [base] [token-file]
//   base defaults to AM_HOOK_URL or http://127.0.0.1:18888; the token comes from token-file, AM_HOOK_MEDIA_USER_TOKEN or target/my-media-user-token.txt.
// Covers: Radio with "Your Stations"; a genre station (batches of next tracks, the endless queue; playback when wrapper-lite is online);
// the personal station; an episode taken from the account's recently played radio (Widevine license through /station/license,
// MSE playback, seeking, M4A download decoded by the size of its mdat); and live radio simulated by serving a sliding window over the
// episode's encrypted segments without #EXT-X-ENDLIST (live edge, playlist refresh, continuous buffer, LIVE badge).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:18888').replace(/\/$/, '');
const tokenFile = process.argv[4] || path.join(__dirname, '../../target/my-media-user-token.txt');
const token = (process.env.AM_HOOK_MEDIA_USER_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8') : '')).trim();
if (!token) { console.log('No media-user-token: skipped'); process.exit(0); }

async function json(pathAndQuery, init = {}) {
  const res = await fetch(base + pathAndQuery, { ...init, headers: { 'X-Media-User-Token': token, ...(init.headers || {}) } });
  assert.ok(res.ok, `${pathAndQuery}: HTTP ${res.status}`);
  return res.json();
}

(async () => {
  const sf = (await json('/station/storefront')).data[0].id;
  const recent = (await json('/station/recent?limit=30')).data || [];
  const episode = recent.find((r) => r.attributes && r.attributes.streamingRadioSubType === 'Episode' && r.attributes.mediaKind === 'audio');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    await context.addInitScript(([tok, cc]) => {
      if (sessionStorage.getItem('am-test')) return;
      sessionStorage.setItem('am-test', '1');
      localStorage.setItem('am-hook:media-user-token', tok);
      localStorage.setItem('am-hook:storefront', cc);
      localStorage.setItem('am-hook:lang', 'en');
    }, [token, sf]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    // Radio: Your Stations first (personal station, then recently played), every station link opens here
    await page.goto(base + '/radio');
    await page.locator('.ed-section').first().waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.ed-heading').first().textContent(), 'Your Stations');
    for (const href of await page.locator('a[href*="/station/"]').evaluateAll((links) => links.map((a) => a.getAttribute('href')))) {
      assert.match(href, /^\/https:\/\/music\.apple\.com\/[a-z]{2}\/station\/(?:[^/]+\/)?ra\.[\w.-]+$/);
    }

    // A station from the radio grouping that plays tracks: batches of 10, Load more, the queue refills itself
    const grouping = await (await fetch(`${base}/amp/v1/editorial/${sf}/groupings?name=radio&platform=web&include[stations]=events,radio-show`)).json();
    const stations = [];
    (function walk(node) {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        if (node.type === 'stations' && node.attributes && node.attributes.playParams) stations.push(node);
        Object.values(node).forEach(walk);
      }
    })(grouping);
    const editorialId = (stations.find((s) => s.attributes.playParams.format === 'tracks') || { id: 'ra.686227433' }).id;
    await page.goto(`${base}/https://music.apple.com/${sf}/station/_/${editorialId}`);
    await page.locator('#tracks .pl-track').first().waitFor({ timeout: 30000 });
    const first = await page.locator('#tracks .pl-track').count();
    await page.click('#more');
    await page.waitForFunction((n) => document.querySelectorAll('#tracks .pl-track').length > n, first, { timeout: 30000 });
    await page.click('#play-all');
    await page.waitForFunction(() => window.AmApp.player.queue && window.AmApp.player.queue.entries.length > 1, null, { timeout: 30000 });
    const before = await page.evaluate(() => window.AmApp.player.queue.entries.length);
    await page.evaluate(() => { const p = window.AmApp.player; p.playAt(p.queue.entries.length - 1); });
    await page.waitForFunction((n) => window.AmApp.player.queue.entries.length > n, before, { timeout: 30000 });
    assert.equal(await page.locator('#tracks .pl-track').count(), await page.evaluate(() => window.AmApp.player.queue.entries.length));
    if ((await (await fetch(base + '/status')).json().catch(() => ({}))).code === 0) {
      await page.waitForFunction(() => window.AmApp.player.transport().currentTime > 1, null, { timeout: 90000 });
    } else console.log('wrapper-lite offline: track playback not checked');
    await page.evaluate(() => window.AmApp.player.pause());

    // Personal station
    const personal = (await json(`/station/catalog/${sf}/stations?filter%5Bidentity%5D=personal`)).data[0];
    await page.goto(`${base}/https://music.apple.com/${sf}/station/_/${personal.id}`);
    await page.locator('#tracks .pl-track').first().waitFor({ timeout: 30000 });
    assert.equal((await page.textContent('#eyebrow')).trim(), 'Personal Station');

    if (!episode) {
      console.log('No episode in recently played radio: episode and live checks skipped');
    } else {
      // Episode: Widevine license, playback, seeking and the M4A download
      const pagePath = `/https://music.apple.com/${sf}/station/_/${episode.id}`;
      await page.goto(base + pagePath);
      await page.waitForFunction(() => document.querySelector('#play') && !document.querySelector('#play').disabled, null, { timeout: 30000 });
      await page.click('#play');
      await page.waitForFunction(() => document.querySelector('#video').currentTime > 2, null, { timeout: 60000 });
      const end = episode.attributes.durationInMillis / 1000;
      await page.$eval('#video', (v, t) => { v.currentTime = t; }, Math.floor(end / 2));
      await page.waitForFunction((t) => document.querySelector('#video').currentTime > t + 1, Math.floor(end / 2), { timeout: 60000 });
      assert.equal(await page.$eval('#error', (n) => n.hidden), true);
      // Smallest variant for the download
      await page.click('#audio-trigger');
      await page.locator('#audios .mv-option').last().click();
      const download = page.waitForEvent('download', { timeout: 600000 });
      await page.click('#download');
      const file = path.join(__dirname, '../../target/radio-episode.m4a');
      await (await download).saveAs(file);
      const bytes = fs.readFileSync(file);
      const top = [];
      for (let p = 0; p + 8 <= bytes.length;) { const size = bytes.readUInt32BE(p); top.push(bytes.toString('latin1', p + 4, p + 8)); if (size < 8) break; p += size; }
      assert.deepEqual(top.slice(0, 3), ['ftyp', 'moov', 'mdat'], 'progressive M4A');
      assert.ok(bytes.length > end * 6000, `M4A size ${bytes.length}`);

      // Live radio, simulated over the same encrypted segments
      const asset = (await json(`/station/assets?${new URLSearchParams({ ...episode.attributes.playParams, keyFormat: 'web' })}`)).results.assets[0];
      const masterText = await (await fetch(asset.url)).text();
      const mediaUrl = new URL(masterText.split('\n').find((l) => l && !l.startsWith('#')), asset.url).href;
      const mediaText = await (await fetch(mediaUrl)).text();
      const keys = mediaText.split('\n').filter((l) => l.startsWith('#EXT-X-KEY')).join('\n');
      const map = new URL(mediaText.match(/#EXT-X-MAP:URI="([^"]+)"/)[1], mediaUrl).href;
      const segments = mediaText.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => new URL(l.trim(), mediaUrl).href);
      const t0 = Date.now();
      let refreshes = 0;
      await page.route(`**/amp/v1/catalog/${sf}/stations/${episode.id}**`, async (route) => {
        const res = await route.fetch();
        const data = await res.json();
        data.data[0].attributes.isLive = true;
        delete data.data[0].attributes.streamingRadioSubType;
        await route.fulfill({ response: res, json: data });
      });
      await page.route('**/station/assets?**', async (route) => {
        const res = await route.fetch();
        const data = await res.json();
        data.results.assets[0].url = 'https://live.example.test/master.m3u8';
        await route.fulfill({ response: res, json: data });
      });
      await page.route('https://live.example.test/**', (route) => {
        const headers = { 'access-control-allow-origin': '*' };
        if (route.request().url().endsWith('master.m3u8')) {
          return route.fulfill({ headers, contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS="mp4a.40.2"\nlive.m3u8\n' });
        }
        refreshes++;
        const seq = 10 + Math.floor((Date.now() - t0) / 16000);
        const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:16', `#EXT-X-MEDIA-SEQUENCE:${seq}`, keys, `#EXT-X-MAP:URI="${map}"`];
        for (let i = seq; i < seq + 6; i++) lines.push('#EXTINF:16.00000,', segments[i - 1]);
        return route.fulfill({ headers, contentType: 'application/vnd.apple.mpegurl', body: `${lines.join('\n')}\n` });
      });
      await page.goto(base + pagePath);
      await page.waitForFunction(() => document.querySelector('#play') && !document.querySelector('#play').disabled, null, { timeout: 30000 });
      assert.equal(await page.locator('#download').isHidden(), true, 'live radio cannot be downloaded');
      await page.click('#play');
      await page.waitForFunction(() => document.querySelector('#video').currentTime > 1, null, { timeout: 60000 });
      assert.equal(await page.locator('#live-badge').isVisible(), true);
      await page.waitForTimeout(36000);
      const live = await page.$eval('#video', (v) => ({ t: v.currentTime, ranges: v.buffered.length, paused: v.paused }));
      assert.ok(live.t > 30 && live.ranges === 1 && !live.paused, JSON.stringify(live));
      assert.ok(refreshes >= 3, `playlist refreshed ${refreshes} times`);
    }
    assert.deepEqual(errors, []);
    console.log('radio live ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });

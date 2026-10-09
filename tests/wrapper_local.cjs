// Run with: node tests/wrapper_local.cjs <path-to-playwright-package>
// Uses installed Chrome and local fixtures; no wrapper or Apple CDN required.
// Covers the local wrapper-lite mode (src/ui/wrapper.js + the wrapper-lite panel in settings.mjs): the browser
// sends wrapper-lite requests itself with Authorization and its own rate / concurrency limits, parses the song
// master m3u8 itself, and still has am-hook fetch the MV master (User-Agent: AM).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.join(__dirname, '../src/ui');

const WRAPPER = 'http://wrapper.test:12340';
const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-alac-stereo-44100-24",NAME="Lossless",CHANNELS="2",SAMPLE-RATE=44100,BIT-DEPTH=24
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1673776,BANDWIDTH=1788592,CODECS="alac",AUDIO="audio-alac-stereo-44100-24"
P100_A123_audio_alac.m3u8
`;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST', 'access-control-max-age': '600' };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => localStorage.setItem('am-hook:lang', 'en'));
    const wrapperRequests = [];
    const serverRequests = [];
    let wrapperActive = 0;
    let wrapperPeak = 0;
    let wrapperDelay = 60;
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === WRAPPER) {
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        wrapperRequests.push({ path: url.pathname + url.search, auth: request.headers().authorization, at: Date.now(), body: request.postData() });
        wrapperActive++;
        wrapperPeak = Math.max(wrapperPeak, wrapperActive);
        await new Promise((resolve) => setTimeout(resolve, wrapperDelay));
        wrapperActive--;
        const json = (body) => route.fulfill({ headers: cors, json: body });
        switch (url.pathname) {
          case '/status': return json({ code: 0, msg: 'SUCCESS', data: { regions: ['jp', 'us'] } });
          case '/m3u8': return json({ code: 0, data: { m3u8: 'https://aod.test/itunes-assets/P100_default.m3u8' } });
          case '/key': return json({ code: 0, data: { ctx: 'Y3R4', state: 'c3RhdGU=', rcx: '0x1' } });
          case '/lyrics': return url.searchParams.get('adamId') === '1'
            ? json({ code: 404, msg: 'no lyrics' })
            : json({ code: 0, data: { lyrics: '<tt>lyrics</tt>' } });
          case '/webplayback': return json({ code: 0, data: { m3u8: 'https://play.itunes.apple.com/WebObjects/MZPlay.woa/hls/master.m3u8' } });
          case '/license': return json({ code: 0, data: { license: 'bGljZW5zZQ==' } });
        }
        return route.fulfill({ status: 404, headers: cors, body: '' });
      }
      if (url.hostname === 'aod.test') return route.fulfill({ headers: cors, body: master, contentType: 'application/vnd.apple.mpegurl' });
      if (url.hostname !== 'am.test') return route.abort();
      serverRequests.push(url.pathname + url.search);
      if (url.pathname === '/parse/mv-master') {
        return route.fulfill({ json: { code: 0, data: { masterUrl: url.searchParams.get('url'), masterBody: '#EXTM3U\n' } } });
      }
      if (url.pathname === '/status') return route.fulfill({ json: { code: 0, regions: ['cn'] } });
      if (url.pathname.startsWith('/amp/') || url.pathname.startsWith('/lyrics/') || url.pathname.startsWith('/parse/')) {
        return route.fulfill({ status: 404, json: { code: 1, msg: 'server endpoint must not be used' } });
      }
      const file = url.pathname.startsWith('/assets/lyrics/') ? path.join('lyrics', path.basename(url.pathname))
        : url.pathname.startsWith('/assets/views/') ? path.join('views', path.basename(url.pathname))
        : url.pathname.startsWith('/assets/') ? path.basename(url.pathname) : 'app.html';
      const type = file.endsWith('.css') ? 'text/css' : /\.m?js$/.test(file) ? 'text/javascript' : 'text/html';
      return route.fulfill({ body: fs.readFileSync(path.join(root, file)), contentType: type });
    });

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://am.test/');
    // Server mode by default
    await page.locator('#nav-status.ok').waitFor();
    assert.equal(await page.locator('[data-setting-value="wrapper"]').textContent(), 'Server');
    assert(serverRequests.includes('/status'));

    // Switch to local in the panel; invalid values are rejected before saving
    await page.locator('[data-picker="wrapper"]').click();
    await page.locator('.picker-option', { hasText: 'Local' }).click();
    const inputs = page.locator('.picker-input');
    await inputs.nth(0).fill('ftp://wrapper.test');
    await page.locator('.picker-save').click();
    assert.match(await page.locator('.picker-result').textContent(), /http:\/\/ or https:\/\//);
    await inputs.nth(0).fill(WRAPPER + '/');
    await inputs.nth(1).fill('-1');
    await page.locator('.picker-save').click();
    assert.match(await page.locator('.picker-result').textContent(), /whole numbers/);
    await page.locator('.picker-input').nth(1).fill('3');
    await page.locator('.picker-input').nth(2).fill('2');
    await page.locator('.picker-input').nth(3).fill('secret-token');
    await page.locator('.picker-save').click();
    await page.locator('.picker-result.is-ok').waitFor();
    assert.equal(await page.locator('.picker-result').textContent(), 'Connected · 2 storefronts');
    assert.equal(await page.locator('[data-setting-value="wrapper"]').textContent(), 'Local · wrapper.test:12340');
    assert.deepEqual(await page.evaluate(() => AmI18n.regions), ['jp', 'us'], 'regions come from the local wrapper-lite');
    assert.equal(wrapperRequests[0].path, '/status');
    assert.equal(wrapperRequests[0].auth, 'Bearer secret-token', 'a bare token gets the Bearer scheme');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('am-hook-wrapper')));
    assert.deepEqual(saved, { local: true, url: WRAPPER, rate: 3, concurrency: 2, auth: 'secret-token' });

    // Settings survive a reload
    await page.reload();
    await page.locator('#nav-status.ok').waitFor();
    assert.equal(await page.locator('.wrapper-status-name').textContent(), 'wrapper-lite (Local)');

    // Every wrapper-lite call goes to the local wrapper-lite, the master m3u8 is parsed in the page
    wrapperRequests.length = 0;
    serverRequests.length = 0;
    const result = await page.evaluate(async () => {
      const w = window.AmWrapper;
      return {
        song: await w.songMaster('123'),
        key: await w.key('123', 'skd://itunes.apple.com/P100/k1'),
        lyrics: await w.lyrics('123', 'en-US'),
        noLyrics: await w.lyrics('1'),
        license: await w.license({ adamId: '5', uri: 'data:;base64,Yg==', challenge: 'YQ==', 'drm-type': 'pr' }),
        mv: await w.mvMaster('5'),
      };
    });
    assert.deepEqual(result.song, {
      masterUrl: 'https://aod.test/itunes-assets/P100_default.m3u8',
      variants: [{
        uri: 'P100_A123_audio_alac.m3u8', url: 'https://aod.test/itunes-assets/P100_A123_audio_alac.m3u8',
        group_id: 'audio-alac-stereo-44100-24', audio: 'Lossless', codecs: 'alac', bandwidth: 1673776,
        channels: '2', sample_rate: 44100, bit_depth: 24,
      }],
    });
    assert.deepEqual(JSON.parse(result.key), { ctx: 'Y3R4', state: 'c3RhdGU=', rcx: '0x1' });
    assert.equal(result.lyrics, '<tt>lyrics</tt>');
    assert.equal(result.noLyrics, null);
    assert.deepEqual(result.license, { license: 'bGljZW5zZQ==' });
    assert.deepEqual(result.mv, { masterUrl: 'https://play.itunes.apple.com/WebObjects/MZPlay.woa/hls/master.m3u8', masterBody: '#EXTM3U\n' });
    assert.deepEqual(wrapperRequests.map((r) => r.path.split('?')[0]), ['/m3u8', '/key', '/lyrics', '/lyrics', '/license', '/webplayback']);
    assert.equal(wrapperRequests.find((r) => r.path.startsWith('/lyrics')).path, '/lyrics?adamId=123&language=en-US');
    assert(wrapperRequests.every((r) => r.auth === 'Bearer secret-token'));
    assert.deepEqual(JSON.parse(wrapperRequests[4].body), { adamId: '5', uri: 'data:;base64,Yg==', challenge: 'YQ==', 'drm-type': 'pr' });
    // The MV master is still fetched by am-hook
    assert.deepEqual(serverRequests, ['/parse/mv-master?url=https%3A%2F%2Fplay.itunes.apple.com%2FWebObjects%2FMZPlay.woa%2Fhls%2Fmaster.m3u8']);

    // Rate (3/s) and concurrency (2) limits apply to the local wrapper-lite
    // 先等过上面请求所在的 1 秒窗口；响应放慢，能看出同时进行的请求数
    await page.waitForTimeout(1100);
    wrapperRequests.length = 0;
    wrapperPeak = 0;
    wrapperDelay = 400;
    await page.evaluate(() => Promise.all(Array.from({ length: 7 }, () => window.AmWrapper.status())));
    assert.equal(wrapperPeak, 2, 'at most 2 requests in flight');
    wrapperDelay = 60;
    const at = wrapperRequests.map((r) => r.at);
    for (let i = 3; i < at.length; i++) assert(at[i] - at[i - 3] >= 950, `request ${i} waited for the 1 s window`);

    // Credentials in the URL (https://token@host) become Basic auth, as reqwest does for --wrapper-url;
    // a separately set Authorization wins
    await page.waitForTimeout(1100);
    wrapperRequests.length = 0;
    const withUserinfo = await page.evaluate(async () => {
      const w = window.AmWrapper;
      w.save({ url: 'http://AAN_tok-en@wrapper.test:12340/', auth: '' });
      const regions = (await w.status()).regions;
      w.save({ auth: 'Bearer explicit' });
      await w.status();
      w.save({ url: 'http://AAN_tok-en@down.test:1', auth: '' });
      const error = await w.status().catch((e) => e.message);
      return { regions, error };
    });
    assert.deepEqual(withUserinfo.regions, ['jp', 'us']);
    // 每次保存后 app.mjs 也会重新检查状态，只比较先后用到的认证
    assert(wrapperRequests.every((r) => r.path === '/status'));
    assert.deepEqual([...new Set(wrapperRequests.map((r) => r.auth))], [
      'Basic ' + Buffer.from('AAN_tok-en:').toString('base64'),
      'Bearer explicit',
    ]);
    assert.match(withUserinfo.error, /Could not reach http:\/\/down\.test:1 /);
    assert(!withUserinfo.error.includes('AAN_tok-en'), 'the token is not shown in errors');
    await page.evaluate(() => window.AmWrapper.save({ url: 'http://wrapper.test:12340', auth: 'secret-token' }));
    await page.locator('#nav-status.ok').waitFor();

    // A wrapper-lite that cannot be reached is reported in the panel
    await page.locator('[data-picker="wrapper"]').click();
    await page.locator('.picker-input').nth(0).fill('http://down.test:1');
    await page.locator('.picker-input').nth(3).fill('');
    await page.locator('.picker-save').click();
    await page.locator('.picker-result.is-error').waitFor();
    assert.match(await page.locator('.picker-result').textContent(), /Could not reach http:\/\/down\.test:1/);
    await page.locator('#nav-status.bad').waitFor();

    // Back to the server
    await page.locator('.picker-option', { hasText: 'Server' }).click();
    assert(await page.locator('#picker').isHidden());
    await page.locator('#nav-status.ok').waitFor();
    assert.equal(await page.locator('[data-setting-value="wrapper"]').textContent(), 'Server');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('am-hook-wrapper')).local), false);

    assert.deepEqual(errors, []);
    console.log('Passed local wrapper-lite: panel validation, persistence, direct requests with Authorization, limits, song master parsing, MV master via am-hook.');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });

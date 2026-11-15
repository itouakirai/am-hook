// Live: needs a running am-hook with wrapper-lite and Apple access (default http://127.0.0.1:8888).
// node tests/run.mjs live csp_live   (or: node tests/live/csp_live.cjs <playwright-package-path> [base])
// The only live test that keeps the page's Content-Security-Policy (src/security.rs) in force — the others run with
// bypassCSP because Playwright's waitForFunction evaluates strings (see tests/support/playwright-bypass-csp.cjs).
// Covers: no CSP violations on the main pages, the lyrics view, ALAC playback (decrypt Worker + wasm),
// E-AC-3 PCM playback (decode Worker + wasm) and an MV page; security headers and compressed assets;
// the web app manifest (installable); the media-user-token HttpOnly cookie round trip.
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const ALBUM = '/https://music.apple.com/cn/album/justice-triple-chucks-deluxe-deluxe-video-version/1561058084';
const ATMOS_SONG = '/https://music.apple.com/cn/song/cruel-summer/1468058171';
const PAGES = ['/', '/new', '/radio', '/settings', '/library', ALBUM,
  '/https://music.apple.com/cn/playlist/top-100-global/pl.d25f5d1181894928af76c85c967f8f31',
  '/https://music.apple.com/us/artist/taylor-swift/159260351',
  '/https://music.apple.com/cn/music-video/peaches/1564531086'];

/** 不用 waitForFunction（CSP 不允许它在页面里求值字符串）：在 Node 里轮询 page.evaluate */
async function until(page, fn, arg, timeout = 60000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(fn, arg).catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

(async () => {
  // 响应头与压缩
  const shell = await fetch(base + '/', { headers: { 'accept-encoding': 'br, gzip' } });
  assert.equal(shell.headers.get('content-encoding'), 'br');
  assert.match(shell.headers.get('content-security-policy'), /^script-src 'self' 'wasm-unsafe-eval'; object-src 'none'/);
  for (const name of ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'cross-origin-opener-policy']) assert(shell.headers.get(name), name);
  const api = await fetch(base + '/amp/v1/storefronts?limit=1');
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff', 'API responses carry nosniff too');

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
      window.__csp = [];
      addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
      localStorage.setItem('am-hook:lang', 'en');
    });
    const page = await context.newPage();
    const problems = [];
    const watch = (target, where) => target.on('console', (m) => {
      if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(`${where}: ${m.text()}`);
    });
    watch(page, 'page');
    page.on('worker', (worker) => watch(worker, `worker ${worker.url()}`));
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    const violations = async (where) => {
      const list = await page.evaluate(() => window.__csp.splice(0));
      problems.push(...list.map((v) => `${where}: ${v}`));
    };

    for (const path of PAGES) {
      await page.goto(base + path);
      await page.locator('#view > .app-page').waitFor({ state: 'attached', timeout: 30000 });
      await page.waitForTimeout(1500);
      await violations(path);
    }
    console.log('· pages load without CSP violations');

    // 安装为应用：manifest 解析、没有可安装性错误
    const cdp = await context.newCDPSession(page);
    const manifest = await cdp.send('Page.getAppManifest');
    assert.deepEqual(manifest.errors, [], JSON.stringify(manifest.errors));
    assert.match(manifest.url, /\/assets\/h\/manifest\.[0-9a-f]{16}\.webmanifest$/);
    const parsed = JSON.parse(manifest.data);
    assert.equal(parsed.id, '/');
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    // 127.0.0.1 是安全上下文；headless 下可能报 in-incognito 之类与本站无关的错误，只检查 manifest 相关的
    const manifestErrors = installabilityErrors.filter((e) => /manifest|icon|start-url|display/i.test(e.errorId));
    assert.deepEqual(manifestErrors, [], JSON.stringify(installabilityErrors));
    console.log('· manifest installable', installabilityErrors.map((e) => e.errorId).join(',') || '');

    // ALAC（MSE + 解密 Worker 的 wasm）播放，并打开歌词界面
    const status = await (await fetch(base + '/status')).json().catch(() => ({}));
    if (status.code === 0) {
      await page.goto(base + ALBUM);
      await page.locator('#play-all:not([disabled])').waitFor({ timeout: 30000 });
      await page.locator('#play-all').click();
      await until(page, () => document.querySelector('.player-toggle')?.dataset.state === 'pause');
      const t0 = Number(await page.locator('#player .seek').getAttribute('aria-valuenow'));
      await page.waitForTimeout(2500);
      assert(Number(await page.locator('#player .seek').getAttribute('aria-valuenow')) > t0, 'ALAC playback advances');
      await page.locator('.player-lyrics').waitFor({ state: 'visible', timeout: 30000 });
      await page.locator('.player-lyrics').click();
      await page.waitForTimeout(2000);
      await violations('album playback + lyrics');
      console.log('· ALAC playback and lyrics view');

      // E-AC-3 → PCM（解码 Worker + wasm）
      await page.evaluate(() => localStorage.setItem('am-hook:settings', JSON.stringify({ playback: { spatial: 'always', transition: 'off' } })));
      await page.goto(base + ATMOS_SONG);
      const variant = page.locator('.variant', { hasText: 'ec-3' }).locator('.variant-play:not([disabled])').first();
      await variant.waitFor({ timeout: 30000 });
      await variant.click();
      await until(page, () => document.querySelector('.player-toggle')?.dataset.state === 'pause', null, 90000);
      const p0 = Number(await page.locator('#player .seek').getAttribute('aria-valuenow'));
      await page.waitForTimeout(2500);
      assert(Number(await page.locator('#player .seek').getAttribute('aria-valuenow')) > p0, 'E-AC-3 PCM playback advances');
      await violations('E-AC-3 playback');
      console.log('· E-AC-3 PCM playback');
    } else {
      console.log('· wrapper-lite offline: playback skipped');
    }

    // media-user-token：存进 HttpOnly cookie，脚本读不到；之后的请求由浏览器带上；DELETE 清除
    await page.goto(base + '/settings');
    await page.locator('#view > .app-page').waitFor({ state: 'attached' });
    const flow = await page.evaluate(async () => {
      const saved = await fetch('/station/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: '0.CspLiveTest' }) });
      const readable = document.cookie;
      const withCookie = await (await fetch('/station/storefront')).json().catch(() => ({}));
      await fetch('/station/token', { method: 'DELETE' });
      const without = await (await fetch('/station/storefront')).json().catch(() => ({}));
      return { saved: saved.status, readable, withCookie: withCookie.msg || '', without: without.msg || '' };
    });
    assert.equal(flow.saved, 204);
    assert(!/am-mut/.test(flow.readable), 'cookie is HttpOnly');
    assert.notEqual(flow.withCookie, 'media-user-token required', 'the cookie is sent to /station/*');
    assert.equal(flow.without, 'media-user-token required', 'DELETE clears the cookie');
    const cookies = await context.cookies(base);
    assert(!cookies.some((c) => /am-mut/.test(c.name)), 'no token cookie left');
    console.log('· media-user-token cookie round trip');

    await violations('end');
    assert.deepEqual(problems, []);
    console.log('CSP live ok');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });

// Live test for songs without a master m3u8 (only AAC-LC 256 through /webplayback, Widevine).
// Start am-hook with the default wrapper-lite (cn region), then run:
// node tests/aac_lc_live.cjs <path-to-playwright-package> [base]
// [base] defaults to AM_HOOK_URL or http://127.0.0.1:8888. Checks the song page (variant, playback,
// seeking) in server and local wrapper-lite modes, and writes the downloaded file to target/aac-lc-<id>.m4a
// (verify with ffprobe / ffmpeg).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const origin = process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888';
const ID = '1569279827'; // Stay With Me: wrapper-lite /m3u8 returns an .m4p, no master

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    for (const local of [false, true]) {
      const context = await browser.newContext();
      // Local mode: the browser talks to wrapper-lite itself (it must allow CORS).
      if (local) await context.addInitScript(() => localStorage.setItem('am-hook-wrapper', JSON.stringify({ local: true, url: 'http://127.0.0.1:12340' })));
      const page = await context.newPage();
      const errors = [], requests = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const licenses = [];
      page.on('request', (r) => {
        requests.push(r.url());
        if (/\/license$/.test(r.url())) licenses.push(JSON.parse(r.postData()));
      });
      await page.goto(`${origin}/https://music.apple.com/cn/song/stay-with-me/${ID}`);
      await page.waitForSelector('#variant-list .variant', { timeout: 60_000 });
      const rows = await page.locator('#variant-list .variant').allInnerTexts();
      assert.equal(rows.length, 1, rows.join('\n'));
      assert.match(rows[0], /AAC · 256 kbps/);
      assert.match(rows[0], /AAC-LC|仅 AAC-LC/);
      // No master: the .m4p from /m3u8 must not be downloaded.
      assert(!requests.some((u) => /\.m4p/.test(u)), 'fetched the .m4p');

      await page.locator('#play-best').click();
      await page.waitForFunction(() => window.AmApp.player.audio.currentTime > 2, null, { timeout: 60_000 });
      const state = await page.evaluate(() => ({ mode: window.AmApp.player.current?.mode, duration: window.AmApp.player.audio.duration }));
      assert(Math.abs(state.duration - 192.5) < 1, `duration ${state.duration}`);
      await page.evaluate(() => { window.AmApp.player.audio.currentTime = 150; });
      await page.waitForFunction(() => window.AmApp.player.audio.currentTime > 152, null, { timeout: 60_000 });
      const license = requests.filter((u) => /\/license$/.test(u));
      // One Widevine request (no drm-type) was enough: no PlayReady fallback.
      assert.equal(licenses.length, 1);
      assert.equal(licenses[0]['drm-type'], undefined);
      assert.equal(licenses[0].uri, 'data:;base64,AAAAAF2JT1MAHfdbtyOvVQ==');
      console.log(`PASS ${local ? 'local' : 'server'}: playback (${state.mode}), seek, Widevine license via ${license[0]}`);

      if (!local) {
        // Download (decrypt + defrag) and hand the bytes back for ffprobe.
        const bytes = await page.evaluate(async (id) => {
          const { variants } = await window.AmWrapper.songMaster(id);
          const track = await window.AmDecrypt.openTrack(variants[0].url);
          const { file, dispose } = await window.AmDecrypt.download(track, {});
          const data = new Uint8Array(await file.arrayBuffer());
          await dispose();
          let s = '';
          for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
          return btoa(s);
        }, ID);
        const out = path.join(__dirname, '..', '..', 'target', `aac-lc-${ID}.m4a`);
        const buf = Buffer.from(bytes, 'base64');
        fs.writeFileSync(out, buf);
        assert.equal(buf.toString('latin1', 4, 12), 'ftypM4A ');
        console.log(`PASS download: ${buf.length} bytes -> ${out}`);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

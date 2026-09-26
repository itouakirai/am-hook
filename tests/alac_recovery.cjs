// Live regression: start am-hook with the default wrapper-lite, then run:
// node tests/alac_recovery.cjs <path-to-playwright-package>
// AM_HOOK_URL optionally overrides http://127.0.0.1:8888.
// Uses the server's embedded WASM and the browser's CDN/decryption/MSE path.
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');
const origin = process.env.AM_HOOK_URL || 'http://127.0.0.1:8888';

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/https://music.apple.com/cn/song/_/1691044818`);
    await page.evaluate(async () => {
      const response = await fetch('/parse/1691044818');
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      const variant = data.variants.find(v => v.codecs === 'alac');
      if (!variant) throw new Error('ALAC variant unavailable');
      window.recoveryPlayer = player;
      window.recoveryEnded = false;
      player.audio.addEventListener('ended', () => { window.recoveryEnded = true; });
      await player.play({
        id: '1691044818', codecs: 'alac',
        m3u8Url: new URL(variant.uri, data.masterUrl).href,
      });
      // Traverse the entire track without seeking; 4x shortens the live test.
      player.audio.playbackRate = 4;
    });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      const state = await page.evaluate(() => ({
        time: recoveryPlayer.audio.currentTime,
        duration: recoveryPlayer.audio.duration,
        ended: recoveryEnded,
        error: recoveryPlayer.errorMsg || recoveryPlayer.audio.error?.message,
        mode: recoveryPlayer.current?.mode,
      }));
      assert.deepEqual(errors, []);
      assert(!state.error, state.error);
      assert.equal(state.mode, 'flac');
      if (state.ended) {
        assert(state.duration > 0 && Math.abs(state.time - state.duration) < 0.25);
        console.log(`PASS: 1691044818 ALAC -> FLAC reached ended at ${state.time.toFixed(3)}s`);
        return;
      }
    }
    throw new Error('Timed out before playback reached ended');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

// 离线场景：选择跟踪器类型、图标、取消、连接状态与回正行为。
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');
const { serveWeb } = require('../support/web.cjs');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/chromium', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.route('http://headtrack.test/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/assets/app.css"><script src="/assets/i18n.js"></script>' });
      return serveWeb(route, url);
    });
    await page.goto('http://headtrack.test/');
    await page.evaluate(async () => {
      window.AmI18n.t = (key) => ({
        'scene.trackersConnect': 'Connect Head Trackers', 'scene.trackersDisconnect': 'Disconnect Head Tracker',
        'scene.trackersBuds2Plus': 'Samsung Galaxy Buds2 and newer',
        'scene.trackersGoogle': 'Google Spatial Audio compatible headphones', 'scene.trackersUnsupported': 'Not supported yet',
        'scene.reset': 'Reset', 'scene.recenter': 'Recenter', 'scene.close': 'Close',
      })[key] || key;
      Object.defineProperty(navigator, 'serial', { configurable: true, value: {} });
      const { open } = await import('/assets/joc/scene.mjs');
      let listener;
      const player = {
        spatial: { yaw: 0, pitch: 0, roll: 0 },
        onSpatial(fn) { listener = fn; return () => {}; },
        setSpatial(patch) { this.spatial = { ...this.spatial, ...patch }; listener(this.spatial); },
        spatialEngine() { return null; }, setSceneOpen() {},
      };
      window.testPlayer = player;
      window.reopenScene = () => { window.scene = open(player); };
      window.scene = open(player);
      const tracker = window.scene.budsTracker;
      tracker.connect = async (service) => {
        window.selectedService = service;
        tracker.port = {};
        tracker.onStatus('connected');
      };
      tracker.disconnect = async () => { tracker.port = null; tracker.onStatus('disconnected'); };
      tracker.recenter = () => { window.recentered = true; };
    });
    const connect = page.getByRole('button', { name: 'Connect Head Trackers', exact: true });
    await connect.click();
    const dialog = page.locator('dialog');
    await dialog.waitFor({ state: 'visible' });
    assert(await page.getByRole('button', { name: /Google Spatial Audio/ }).isDisabled());
    assert.equal(await dialog.locator('img').count(), 3);
    await page.waitForFunction(() => [...document.querySelectorAll('dialog img')].every((img) => img.complete && img.naturalWidth > 0));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.joc-scene').count(), 1, 'Escape closes only the picker');
    await connect.click();
    await page.getByRole('button', { name: 'Samsung Galaxy Buds Pro', exact: true }).click();
    assert.equal(await page.evaluate(() => window.selectedService), '00001101-0000-1000-8000-00805f9b34fb');
    await page.getByRole('button', { name: 'Recenter', exact: true }).click();
    assert(await page.evaluate(() => window.recentered));
    await page.getByRole('button', { name: 'Disconnect Head Tracker', exact: true }).click();
    assert(await page.getByRole('button', { name: 'Reset', exact: true }).isVisible());
    assert.equal(await page.locator('[role="alert"]').textContent(), '');
    await connect.click();
    await page.getByRole('button', { name: 'Samsung Galaxy Buds2 and newer', exact: true }).click();
    assert.equal(await page.evaluate(() => window.selectedService), '2e73a4ad-332d-41fc-90e2-16bef06523f2');
    await page.evaluate(() => {
      window.savedTracker = window.scene.budsTracker;
      window.scene.close();
      window.savedTracker.onPose({ yaw: 0.7, pitch: 0.2, roll: 0.1 });
    });
    await page.waitForFunction(() => window.testPlayer.spatial.yaw === 0.7);
    assert(await page.evaluate(() => Boolean(window.savedTracker.port)), 'closing the view retains the connection');
    await page.evaluate(() => window.reopenScene());
    assert(await page.evaluate(() => window.scene.budsTracker === window.savedTracker), 'reopening reuses the tracker');
    assert(await page.getByRole('button', { name: 'Recenter', exact: true }).isVisible());
    await page.getByRole('button', { name: 'Disconnect Head Tracker', exact: true }).click();
    assert(await page.evaluate(() => window.savedTracker.port === null), 'explicit Disconnect still closes the connection');
    await page.evaluate(() => window.scene.close());
    console.log('Head tracker picker and persistence: icons, selection, recenter, hidden-view poses, reopening and explicit disconnect passed.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

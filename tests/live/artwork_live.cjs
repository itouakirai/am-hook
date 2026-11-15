// Run with: node tests/live/artwork_live.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook, the Apple CDN, wrapper-lite with the cn region (for the album download) and ffprobe on PATH.
// Covers motion artwork downloads (download/motion.mjs) and the cover menu (views/artwork-menu.mjs):
// right-click on the album header → still cover (original) and motion artwork (each quality) saved as progressive MP4s;
// Shift+right-click keeps the browser menu; a card cover inside a link opens the menu without navigating;
// touch long-press opens the menu as a bottom sheet and swallows the click; the album download dialog adds
// square_animated_artwork.mp4 / tall_animated_artwork.mp4 to the ZIP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.argv[2] || 'playwright');
const { openPage } = require('../support/app.cjs');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const ALBUM = '/https://music.apple.com/cn/album/1989-taylors-version-deluxe/1713845538';
const ARTIST = '/https://music.apple.com/cn/artist/taylor-swift/159260351';
const MORE = '.detail-extra .detail-circle-btn[aria-haspopup="menu"]';
const OUT = path.join(__dirname, '../../target/artwork_live');

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' });
  return JSON.parse(out);
}

/** progressive MP4 的顶层 box */
function topLevel(buf) {
  const list = [];
  for (let p = 0; p + 8 <= buf.length;) {
    const size = buf.readUInt32BE(p);
    list.push(buf.toString('latin1', p + 4, p + 8));
    if (size < 8) break;
    p += size;
  }
  return list;
}

function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    out[name] = buf.subarray(start, start + size);
    p += 46 + nameLen + extraLen;
  }
  return out;
}

async function newPage(browser, settings, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((s) => {
    localStorage.setItem('am-hook:lang', 'zh');
    if (s) localStorage.setItem('am-hook:settings', JSON.stringify({ download: s }));
  }, settings || null);
  return { page, errors };
}

function nextDownload(page) {
  const p = page.waitForEvent('download', { timeout: 300000 });
  p.catch(() => {});
  return p;
}

const menuLabels = (page) => page.locator('.menu:not([hidden]) .menu-label').allTextContents();

async function rightClick(page, selector) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.waitForSelector('.menu:not([hidden])');
}

async function save(download, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  await download.saveAs(file);
  return file;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    // 专辑头部：右键 → 菜单列出静态封面与方形、竖版动态封面
    {
      const { page, errors } = await newPage(browser, { saveMode: 'zip' });
      await openPage(page, base + ALBUM);
      await page.waitForSelector('#art[data-motion] img', { timeout: 30000 });
      await rightClick(page, '#art');
      assert.deepEqual(await menuLabels(page), ['保存封面', '保存动态封面（方形）', '保存动态封面（竖版 3:4）', '在新标签页中打开原图', '复制原图地址']);

      // 动态封面（方形）→ 清晰度列表：HEVC 在前，最高 2160×2160，附码率与估算大小
      await page.locator('.menu .menu-label', { hasText: '保存动态封面（方形）' }).click();
      await page.waitForSelector('.menu .menu-label >> text=/×/');
      const labels = (await menuLabels(page)).slice(1);
      assert.match(labels[0], /^2160×2160 HEVC$/);
      assert.ok(labels.some((l) => /^1080×1080 H\.264$/.test(l)), labels.join(', '));
      const hint = await page.locator('.menu .menu-item:nth-child(3) .menu-hint').textContent();
      assert.match(hint, /Mbps · ≈ \d+(\.\d)? MB/);

      // 选 1080×1080 H.264：下载中心出现任务，浏览器保存为普通 MP4（ftyp moov mdat），只有视频
      let download = nextDownload(page);
      await page.locator('.menu .menu-label', { hasText: /^1080×1080 H\.264$/ }).click();
      await page.waitForSelector('#downloads:not([hidden])');
      let file = await save(await download, 'square-avc.mp4');
      assert.match((await download).suggestedFilename(), /^1989 \(Taylor's Version\) \[Deluxe\] - square_animated_artwork 1080x1080 H\.264\.mp4$/);
      assert.deepEqual(topLevel(fs.readFileSync(file)).slice(0, 3), ['ftyp', 'moov', 'mdat']);
      let info = probe(file);
      assert.equal(info.streams.length, 1);
      assert.equal(info.streams[0].codec_name, 'h264');
      assert.equal(info.streams[0].width, 1080);
      assert.ok(Number(info.format.duration) > 5, info.format.duration);
      assert.ok(Math.abs(Number(info.streams[0].start_time)) < 0.1, `starts at 0: ${info.streams[0].start_time}`);

      // 竖版的最高档（HEVC）
      await rightClick(page, '#art');
      await page.locator('.menu .menu-label', { hasText: '竖版' }).click();
      await page.waitForSelector('.menu .menu-label >> text=/×/');
      const tallTop = (await menuLabels(page))[1];
      assert.match(tallTop, /^\d+×\d+ HEVC$/);
      download = nextDownload(page);
      await page.locator('.menu .menu-item:nth-child(3)').click();
      file = await save(await download, 'tall-hevc.mp4');
      info = probe(file);
      assert.equal(info.streams.length, 1, 'silent audio dropped');
      assert.equal(info.streams[0].codec_name, 'hevc');
      assert.ok(info.streams[0].height > info.streams[0].width);

      // 静态封面原图（原始格式）
      await rightClick(page, '#art');
      await page.locator('.menu .menu-label', { hasText: '保存封面' }).click();
      assert.deepEqual((await menuLabels(page)).slice(1), ['原图', '原图 · JPG', '原图 · PNG', '3000 px · JPG', '1500 px · JPG', '600 px · JPG']);
      download = nextDownload(page);
      await page.locator('.menu .menu-label', { hasText: /^原图 · JPG$/ }).click();
      file = await save(await download, 'cover.jpg');
      assert.match((await download).suggestedFilename(), / - cover\.jpg$/);
      const jpg = fs.readFileSync(file);
      assert.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff]);
      assert.ok(probe(file).streams[0].width >= 3000);

      // Shift + 右键保留浏览器菜单：不弹出这里的菜单
      await page.keyboard.press('Escape');
      const box = await page.locator('#art').boundingBox();
      await page.keyboard.down('Shift');
      await page.mouse.click(box.x + 20, box.y + 20, { button: 'right' });
      await page.keyboard.up('Shift');
      assert.equal(await page.locator('.menu:not([hidden])').count(), 0);
      // 下载中心：3 个封面任务，标题链接回本页
      await page.click('.dlc-bar-main');
      await page.waitForSelector('.dl-job');
      assert.equal(await page.locator('.dl-job').count(), 3);
      assert.equal(await page.locator('.dl-job-title').first().getAttribute('href'), new URL(page.url()).pathname);
      assert.deepEqual(errors, []);
      await page.context().close();
    }

    // 艺人页：卡片（链接）里的封面 → 菜单打开、页面不跳转；曲目行文字仍是浏览器菜单
    {
      const { page, errors } = await newPage(browser);
      await openPage(page, base + ARTIST);
      const card = page.locator('.card-wrap a img[src*="mzstatic"]').first();
      await card.waitFor({ timeout: 30000 });
      await card.scrollIntoViewIfNeeded();
      const url = page.url();
      const b = await card.boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 3, { button: 'right' });
      await page.waitForSelector('.menu:not([hidden])');
      assert.equal((await menuLabels(page))[0], '保存封面');
      await page.mouse.click(5, 5);
      assert.equal(page.url(), url);
      assert.deepEqual(errors, []);
      await page.context().close();
    }

    // 触屏长按：手机布局下菜单贴底，松手后的点按不打开链接
    {
      const { page, errors } = await newPage(browser, null, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      await openPage(page, base + ARTIST);
      const card = page.locator('.card-wrap a img[src*="mzstatic"]').first();
      await card.waitFor({ timeout: 30000 });
      await card.scrollIntoViewIfNeeded();
      const url = page.url();
      const b = await card.boundingBox();
      const cdp = await page.context().newCDPSession(page);
      const point = [{ x: b.x + b.width / 2, y: b.y + b.height / 3 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point });
      await page.waitForTimeout(800);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForSelector('.menu:not([hidden])');
      await page.waitForTimeout(500);
      assert.equal(page.url(), url, 'long-press did not follow the link');
      const menu = await page.locator('.menu').boundingBox();
      assert.ok(menu.y + menu.height > 844 - 60, 'bottom sheet');
      assert.equal((await menuLabels(page))[0], '保存封面');
      assert.deepEqual(errors, []);
      await page.context().close();
    }

    // 下载对话框：动态封面默认按设置勾选，ZIP 里有 square / tall_animated_artwork.mp4
    {
      const { page, errors } = await newPage(browser, { codec: 'aac', motion: true, motionTall: true, motionCodec: 'avc', motionMax: 720, saveCover: false });
      await openPage(page, base + ALBUM);
      await page.waitForSelector(`${MORE}:not([disabled])`, { timeout: 30000 });
      await page.click(MORE);
      await page.locator('.menu .menu-label').filter({ hasText: /^下载专辑$/ }).click();
      await page.waitForSelector('.dl-dialog[open]');
      const motions = page.locator('.dl-dialog-motion input');
      assert.equal(await motions.count(), 2);
      assert.deepEqual(await motions.evaluateAll((list) => list.map((x) => x.checked)), [true, true]);
      assert.match(await page.locator('.dl-dialog-motions').textContent(), /H\.264 · ≤ 720p/);
      await page.click('.dl-dialog-tools button:nth-of-type(2)');
      await page.locator('.dl-dialog-item:not(.is-disabled) input').nth(0).check();
      const download = nextDownload(page);
      await page.click('.dl-dialog-start');
      const zip = await download;
      const entries = unzip(fs.readFileSync(await zip.path()));
      assert.deepEqual(Object.keys(entries).sort(), ["1-01 Welcome To New York (Taylor's Version).m4a", 'square_animated_artwork.mp4', 'tall_animated_artwork.mp4']);
      for (const name of ['square_animated_artwork.mp4', 'tall_animated_artwork.mp4']) {
        assert.deepEqual(topLevel(entries[name]).slice(0, 3), ['ftyp', 'moov', 'mdat'], name);
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, name), entries[name]);
        const s = probe(path.join(OUT, name)).streams;
        assert.equal(s.length, 1);
        assert.equal(s[0].codec_name, 'h264');
        assert.ok(Math.min(s[0].width, s[0].height) <= 720, `${s[0].width}x${s[0].height}`);
      }
      // 下载中心的文件任务不编号，显示所选清晰度
      await page.click('.dlc-bar-main');
      await page.locator('.dl-job-toggle').first().click();
      await page.waitForSelector('.dl-task');
      const rows = await page.locator('.dl-task').allTextContents();
      assert.equal(await page.locator('.dl-task-index').last().textContent(), '', 'file tasks are not numbered');
      assert.ok(rows.some((r) => /动态封面（方形）.*×.*H\.264/.test(r)), rows.join('\n'));
      assert.deepEqual(errors, []);
      await page.context().close();
    }
    console.log('artwork_live: ok');
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

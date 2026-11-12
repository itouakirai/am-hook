// Run with: node tests/download_ui.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook, wrapper-lite with the cn region and access to the Apple CDN (default http://127.0.0.1:8888).
// Covers batch downloads: settings page, album download dialog → ZIP with iTunes tags / cover / lyrics, folder mode
// (the directory picker is replaced by an OPFS directory), playlist numbering and .m3u8, the song page, the More menu,
// music videos in an album (tagged .mp4, tracks one after another), the More menu on a music video,
// cancel / retry and cleanup of temporary files.
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');
const { openPage } = require('../support/app.cjs');

const base = (process.argv[3] || process.env.AM_HOOK_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const ALBUM = '/https://music.apple.com/cn/album/1989-taylors-version-deluxe/1713845538';
const PLAYLIST = '/https://music.apple.com/cn/playlist/x/pl.d467987f72384448b2bebe52c0b212d6';
// 第 23 首是 MV（96 秒）
const MV_ALBUM = '/https://music.apple.com/cn/album/speak-now-taylors-version/1690839749';

/** ZIP central directory → { name: Buffer } */
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

/** progressive MP4 → { topLevel: [...], tags: { atom: Buffer | string } } */
function mp4(buf) {
  const boxes = (s, e) => {
    const list = [];
    for (let p = s; p + 8 <= e;) {
      const size = buf.readUInt32BE(p);
      list.push({ kind: buf.toString('latin1', p + 4, p + 8), start: p, body: p + 8, end: p + size });
      p += size;
    }
    return list;
  };
  const top = boxes(0, buf.length);
  const child = (box, kind, skip = 0) => boxes(box.body + skip, box.end).find((b) => b.kind === kind);
  const moov = top.find((b) => b.kind === 'moov');
  // ISO meta 在子 box 前有 4 字节 version / flags
  const ilst = child(child(child(moov, 'udta'), 'meta'), 'ilst', 4);
  const tags = {};
  for (const item of boxes(ilst.body, ilst.end)) {
    const parts = boxes(item.body, item.end);
    if (item.kind === '----') {
      const name = parts.find((b) => b.kind === 'name');
      const data = parts.find((b) => b.kind === 'data');
      tags[`----:${buf.toString('utf8', name.body + 4, name.end)}`] = buf.toString('utf8', data.body + 8, data.end);
    } else {
      const data = parts[0];
      const type = buf.readUInt32BE(data.body);
      tags[item.kind] = type === 1 ? buf.toString('utf8', data.body + 8, data.end) : buf.subarray(data.body + 8, data.end);
    }
  }
  return { topLevel: top.map((b) => b.kind), tags };
}

async function newPage(browser, settings, init) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(([s, extra]) => {
    localStorage.setItem('am-hook:lang', 'zh');
    if (s) localStorage.setItem('am-hook:settings', JSON.stringify({ download: s }));
    if (extra) window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true });
  }, [settings, !!init]);
  return { page, errors };
}

/** 下一个下载；先挂上 catch，测试中途失败时不会被它的拒绝掩盖 */
function nextDownload(page) {
  const p = page.waitForEvent('download', { timeout: 600000 });
  p.catch(() => {});
  return p;
}

async function pickTracks(page, indexes) {
  // 头部「更多」→「下载专辑 / 下载歌单」
  await page.click('.detail-extra .detail-circle-btn');
  await page.locator('.menu .menu-label').filter({ hasText: /^下载(专辑|歌单)$/ }).click();
  await page.waitForSelector('.dl-dialog[open]');
  await page.click('.dl-dialog-tools button:nth-of-type(2)');
  const boxes = page.locator('.dl-dialog-item:not(.is-disabled) input');
  for (const i of indexes) await boxes.nth(i).check();
  assert.match(await page.locator('.dl-dialog-start').textContent(), new RegExp(`${indexes.length}`));
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    // 设置中心：导航里有入口，各分组都在
    {
      const { page, errors } = await newPage(browser);
      await openPage(page, `${base}/settings`);
      assert.equal(await page.locator('.nav-link[data-nav="settings"]').getAttribute('aria-current'), 'page');
      for (const id of ['general', 'playback', 'download', 'play-quality', 'spatial', 'quality', 'mv', 'save', 'naming', 'tags', 'cover', 'lyrics']) assert.ok(await page.locator(`#${id}`).count(), id);
      // 三个标签页：默认通用；播放页的音质挡位按 Wi-Fi / 移动数据分别保存
      assert.equal(await page.locator('#general').isVisible(), true);
      assert.equal(await page.locator('#download').isHidden(), true);
      await page.click('[data-tab="playback"]');
      assert.match(page.url(), /#playback$/);
      await page.click('#play-quality .set-tiers >> nth=1 >> .set-tier.is-efficient');
      await page.click('#spatial [role="radio"] >> nth=1');
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('am-hook:settings')).playback), { wifi: 'hires', cellular: 'efficient', spatial: 'always' });
      assert.equal(await page.locator('#play-quality .set-tiers >> nth=1 >> [aria-checked="true"]').textContent().then((s) => /HE-AAC/.test(s)), true);
      // 分组的 hash 打开其所在的标签页
      await openPage(page, `${base}/settings#naming`);
      assert.equal(await page.locator('#download').isVisible(), true);
      await page.selectOption('#quality select >> nth=0', 'aac');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('am-hook:settings')).download.codec), 'aac');
      await page.fill('.set-template >> nth=1', '{tracknum:02d}. {title}');
      await page.locator('.set-template >> nth=1').blur();
      assert.match(await page.locator('.set-preview >> nth=1').textContent(), /^02\. Blank Space\.m4a$/);
      assert.deepEqual(errors, []);
      await page.context().close();
    }

    // 专辑 → ZIP：标签、封面、歌词与进度
    {
      const { page, errors } = await newPage(browser, { codec: 'aac', coverSize: 600, saveLyrics: true });
      await openPage(page, base + ALBUM);
      await page.waitForSelector('.detail-extra .detail-circle-btn:not([disabled])', { timeout: 30000 });
      await pickTracks(page, [0, 1]);
      const download = nextDownload(page);
      await page.click('.dl-dialog-start');
      await page.waitForSelector('#downloads:not([hidden])');
      const file = await download;
      assert.equal(file.suggestedFilename(), "Taylor Swift - 1989 (Taylor's Version) [Deluxe].zip");
      const entries = unzip(require('node:fs').readFileSync(await file.path()));
      assert.deepEqual(Object.keys(entries).sort(), [
        "1-01 Welcome To New York (Taylor's Version).lrc", "1-01 Welcome To New York (Taylor's Version).m4a",
        "1-02 Blank Space (Taylor's Version).lrc", "1-02 Blank Space (Taylor's Version).m4a", 'cover.jpg']);
      const { topLevel, tags } = mp4(entries["1-02 Blank Space (Taylor's Version).m4a"]);
      assert.deepEqual(topLevel, ['ftyp', 'moov', 'mdat']);
      assert.equal(tags['\xa9nam'], "Blank Space (Taylor's Version)");
      assert.equal(tags.aART, 'Taylor Swift');
      assert.match(tags['\xa9wrt'], /Max Martin/);
      assert.deepEqual([...tags.trkn.subarray(2, 6)], [0, 2, 0, 22]);
      assert.equal(tags['----:ISRC'], 'USUG12306673');
      assert.equal(tags['----:UPC'], '00602458807400');
      assert.equal(tags.cnID.readUInt32BE(0), 1713845737);
      assert.ok(tags.covr.length > 10000, 'cover embedded');
      assert.match(tags['\xa9lyr'], /^\[00:0\d\.\d\d\]Nice to meet you/);
      assert.match(entries["1-02 Blank Space (Taylor's Version).lrc"].toString(), /^\[00:0\d\.\d\d\]Nice to meet you/);
      await page.click('.dlc-bar-main');
      assert.match(await page.locator('.dl-job-status').textContent(), /已保存/);
      assert.deepEqual(errors, []);
      await page.context().close();
    }

    // 专辑中的 MV：对话框中默认勾选，ZIP 中为带标签的 .mp4（stik 为音乐视频，封面为缩略图），各轨道依次写入（不交错）
    {
      const { page, errors } = await newPage(browser, { codec: 'aac', coverSize: 600, mvMax: 480, mvAudio: 'aac' });
      await openPage(page, base + MV_ALBUM);
      await page.waitForSelector('.detail-extra .detail-circle-btn:not([disabled])', { timeout: 30000 });
      await page.click('.detail-extra .detail-circle-btn');
      await page.locator('.menu .menu-label').filter({ hasText: /^下载专辑$/ }).click();
      await page.waitForSelector('.dl-dialog[open]');
      const mvItem = page.locator('.dl-dialog-item').filter({ has: page.locator('.dl-dialog-mv') });
      assert.equal(await mvItem.count(), 1);
      assert.ok(await mvItem.locator('input').isChecked(), 'MVs are checked by default');
      // 「不含 MV」取消勾选，再点一次恢复
      const toggle = page.locator('.dl-dialog-tools button').filter({ hasText: /MV/ });
      await toggle.click();
      assert.ok(!(await mvItem.locator('input').isChecked()));
      await page.click('.dl-dialog-tools button:nth-of-type(2)');
      await mvItem.locator('input').check();
      const download = nextDownload(page);
      await page.click('.dl-dialog-start');
      const file = await download;
      const entries = unzip(require('node:fs').readFileSync(await file.path()));
      const name = "1-23 Surprise Announcement (Taylor's Version).mp4";
      assert.deepEqual(Object.keys(entries).sort(), [name, 'cover.jpg']);
      const buf = entries[name];
      const { topLevel, tags } = mp4(buf);
      assert.deepEqual(topLevel, ['ftyp', 'moov', 'mdat']);
      assert.equal(buf.toString('latin1', 8, 12), 'isom');
      assert.equal(tags['\xa9nam'], "Surprise Announcement (Taylor's Version)");
      assert.equal(tags['\xa9alb'], "Speak Now (Taylor's Version)");
      assert.deepEqual([...tags.stik], [6]);
      assert.deepEqual([...tags.trkn.subarray(2, 6)], [0, 23, 0, 23]);
      assert.equal(tags['----:PERFORMER'], 'Taylor Swift');
      assert.equal(tags['----:UPC'], '00602455918284');
      assert.equal(tags.cnID.readUInt32BE(0), 1690841286);
      assert.ok(tags.covr.length > 5000, 'thumbnail embedded');
      // 每个 trak 的 chunk 偏移：视频的全部在音频之前
      const ranges = [];
      for (let p = buf.indexOf('stco'); p > 0; p = buf.indexOf('stco', p + 4)) {
        const n = buf.readUInt32BE(p + 8);
        ranges.push([buf.readUInt32BE(p + 12), buf.readUInt32BE(p + 8 + 4 * n)]);
      }
      assert.ok(ranges.length >= 2);
      for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i][0] > ranges[i - 1][1], 'tracks one after another');
      assert.match(await page.evaluate(() => window.AmDownloads.jobs[0].tasks[0].quality), /^MV · \d+p H\.264 · AAC 256kbps$/);
      assert.deepEqual(errors, []);
      await page.context().close();
    }

    // MV 的「更多」菜单：单独下载 MV
    {
      const { page, errors } = await newPage(browser, { mvMax: 480, mvAudio: 'aac' });
      await openPage(page, base + MV_ALBUM);
      await page.waitForSelector('.track .track-more');
      // 菜单在页面滚动时关闭：先滚到 MV 这一行并等滚动结束
      const more = page.locator('.track').filter({ hasText: 'Surprise Announcement' }).locator('.track-more');
      await more.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      await more.click();
      const download = nextDownload(page);
      await page.locator('.menu .menu-label').filter({ hasText: /^下载 MV$/ }).click();
      const file = await download;
      assert.equal(file.suggestedFilename(), "Taylor Swift - Surprise Announcement (Taylor's Version).mp4");
      assert.deepEqual([...mp4(require('node:fs').readFileSync(await file.path())).tags.stik], [6]);
      assert.deepEqual(errors, []);
      await page.context().close();
    }

    // 保存到文件夹：子文件夹模板、逐字歌词、跳过已存在的文件
    {
      const settings = { codec: 'aac', saveMode: 'folder', saveLyrics: true, syllable: true, coverSize: 300, songFile: 'Disc {disk}/{tracknum:02d} {title} [{codec}]' };
      const { page, errors } = await newPage(browser, settings, true);
      await openPage(page, base + ALBUM);
      await page.evaluate(async () => { try { await (await navigator.storage.getDirectory()).removeEntry('picked', { recursive: true }); } catch {} });
      await page.waitForSelector('.detail-extra .detail-circle-btn:not([disabled])', { timeout: 30000 });
      for (let round = 0; round < 2; round++) {
        await pickTracks(page, [2]);
        await page.click('.dl-dialog-start');
        await page.waitForFunction((n) => {
          const d = window.AmDownloads;
          return d.jobs.length === n && d.jobState(d.jobs[0]) === 'done' && d.jobs[0].saved;
        }, round + 1, { timeout: 600000 });
      }
      const states = await page.evaluate(() => window.AmDownloads.jobs.map((j) => j.tasks[0].state));
      assert.deepEqual(states, ['skipped', 'done'], 'second download skips the existing file');
      const files = await page.evaluate(async () => {
        const out = {};
        async function walk(dir, prefix) {
          for await (const [name, h] of dir.entries()) {
            if (h.kind === 'directory') await walk(h, `${prefix}${name}/`);
            else out[prefix + name] = name.endsWith('.lrc') ? await (await h.getFile()).text() : (await h.getFile()).size;
          }
        }
        await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('picked'), '');
        return out;
      });
      const folder = "Taylor Swift - 1989 (Taylor's Version) [Deluxe]";
      assert.ok(files[`${folder}/Disc 1/03 Style (Taylor's Version) [AAC].m4a`] > 1e6, JSON.stringify(Object.keys(files)));
      assert.ok(files[`${folder}/cover.jpg`] > 1000);
      assert.match(files[`${folder}/Disc 1/03 Style (Taylor's Version) [AAC].lrc`], /^\[\d\d:\d\d\.\d\d\]<\d\d:\d\d\.\d\d>\S+/);
      assert.deepEqual(errors, []);
      await page.context().close();
    }

    // 歌单：曲目号为歌单中的序号，附带 .m3u8
    {
      const { page, errors } = await newPage(browser, { codec: 'aac-he', coverSize: 300, playlistAlbumInfo: false });
      await openPage(page, base + PLAYLIST);
      await page.waitForSelector('.detail-extra .detail-circle-btn:not([disabled])', { timeout: 30000 });
      await pickTracks(page, [1]);
      const download = nextDownload(page);
      await page.click('.dl-dialog-start');
      const entries = unzip(require('node:fs').readFileSync(await (await download).path()));
      const names = Object.keys(entries);
      const song = names.find((n) => n.endsWith('.m4a'));
      assert.match(song, /^02\. /);
      const m3u = entries[names.find((n) => n.endsWith('.m3u8'))].toString();
      assert.ok(m3u.startsWith('#EXTM3U\n#EXTINF:') && m3u.includes(song), m3u);
      const { tags } = mp4(entries[song]);
      assert.equal(tags['\xa9alb'], '周杰伦代表作');
      assert.equal(tags.trkn.readUInt16BE(2), 2);
      assert.deepEqual(errors, []);
      await page.context().close();
    }

    // 歌曲页的音质行、「更多」菜单里的下载、取消与重试、临时文件清理
    {
      const { page, errors } = await newPage(browser, { codec: 'aac-he', coverSize: 300 });
      await openPage(page, `${base}/https://music.apple.com/cn/song/x/1713845554`);
      const row = page.locator('.variant', { hasText: 'HE-AAC · 64 kbps' }).first();
      // 页面滚动时会关闭菜单：先滚到该行再打开
      await row.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await row.locator('.more-btn').click();
      let download = nextDownload(page);
      await page.click('.menu .menu-item');
      await row.locator('.variant-progress:not([hidden])').waitFor({ timeout: 20000 });
      assert.equal((await download).suggestedFilename(), "Taylor Swift - Welcome To New York (Taylor's Version).m4a");

      // 站内跳转：下载在页面之间不中断
      await page.evaluate((href) => window.AmApp.navigate(href), ALBUM);
      await page.waitForSelector('.track .track-more');
      await page.locator('.track .track-more').nth(4).click();
      await page.locator('[role="menuitem"]').filter({ has: page.locator('.menu-label', { hasText: /^下载$/ }) }).click();
      await page.waitForFunction(() => window.AmDownloads.jobs[0].tasks.some((x) => x.state === 'downloading' && x.done > 0), null, { timeout: 60000 });
      await page.evaluate(() => window.AmDownloads.cancel(window.AmDownloads.jobs[0]));
      await page.waitForFunction(() => window.AmDownloads.jobState(window.AmDownloads.jobs[0]) === 'cancelled');
      await page.click('.dlc-bar-main');
      download = nextDownload(page);
      await page.click('.dl-job .dl-retry');
      assert.match((await download).suggestedFilename(), /All You Had To Do Was Stay/);
      await page.click('.dl-clear');
      await page.waitForTimeout(3500);
      const left = await page.evaluate(async () => {
        const out = [];
        for await (const [name] of (await (await navigator.storage.getDirectory()).getDirectoryHandle('am-hook-downloads')).entries()) out.push(name);
        return out;
      });
      assert.deepEqual(left, [], 'temporary files removed with the finished jobs');
      assert.equal(await page.locator('#downloads').isHidden(), true, 'download center hides when no jobs remain');
      assert.deepEqual(errors, []);
      await page.context().close();
    }
    console.log('Passed downloads: settings center, album ZIP with tags / cover / lyrics, folder mode with skip, playlist + m3u8, song page, More menu, music videos in an album and from the More menu, cancel / retry, cleanup.');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

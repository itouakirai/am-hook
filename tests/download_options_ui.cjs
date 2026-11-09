// Run with: node tests/download_options_ui.cjs <path-to-playwright-package> [base]
// Live: needs a running am-hook, wrapper-lite with the jp region and access to the Apple CDN (default http://127.0.0.1:8888).
// Covers download settings: cover tag selection, persistence and both languages, then album ZIPs
// with cleaned album names, embedded / saved covers and JPEG / PNG data types.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const { openPage } = require('./app.cjs');
const base = (process.argv[3] || 'http://127.0.0.1:8888').replace(/\/$/, '');
const out = path.resolve(__dirname, '../target/download-options');

/** ZIP central directory → Map<name, Buffer> */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entries = new Map();
  let p = buf.readUInt32LE(end + 16);
  for (let n = buf.readUInt16LE(end + 10); n > 0; n--) {
    const size = buf.readUInt32LE(p + 24), nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30);
    const offset = buf.readUInt32LE(p + 42);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    entries.set(buf.toString('utf8', p + 46, p + 46 + nameLen), buf.subarray(start, start + size));
    p += 46 + nameLen + extraLen + buf.readUInt16LE(p + 32);
  }
  return entries;
}

/** progressive MP4 → Map<atom, { type, value }> */
function mp4Tags(buf) {
  const boxes = (start, end) => {
    const list = [];
    for (let p = start; p + 8 <= end;) {
      const size = buf.readUInt32BE(p);
      assert.ok(size >= 8 && p + size <= end);
      list.push({ kind: buf.toString('latin1', p + 4, p + 8), body: p + 8, end: p + size });
      p += size;
    }
    return list;
  };
  const child = (box, kind, skip = 0) => boxes(box.body + skip, box.end).find((b) => b.kind === kind);
  const moov = boxes(0, buf.length).find((b) => b.kind === 'moov');
  const ilst = child(child(child(moov, 'udta'), 'meta'), 'ilst', 4);
  const tags = new Map();
  for (const item of boxes(ilst.body, ilst.end)) {
    const data = boxes(item.body, item.end).find((b) => b.kind === 'data');
    const type = buf.readUInt32BE(data.body);
    tags.set(item.kind, { type, value: type === 1 ? buf.toString('utf8', data.body + 8, data.end) : buf.subarray(data.body + 8, data.end) });
  }
  return tags;
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.addInitScript(() => localStorage.setItem('am-hook:lang', 'zh'));
    await openPage(page, `${base}/settings#cover`);
    const saved = page.getByRole('switch', { name: '另存封面文件', exact: true });
    const clean = page.getByRole('switch', { name: '清理专辑名后缀', exact: true });
    const coverCheck = page.locator('#tags .set-check').filter({ hasText: /^封面$/ }).locator('input');
    const formats = page.locator('#cover select');
    assert.ok(await coverCheck.isChecked());
    assert.ok(await saved.isChecked());
    assert.ok(!(await clean.isChecked()));
    await coverCheck.uncheck();
    assert.ok(await formats.nth(0).isVisible());
    assert.ok(await saved.isChecked());
    await coverCheck.check();
    await formats.nth(0).selectOption('original');
    await formats.nth(1).selectOption('original');
    await clean.locator('..').click();
    await page.reload();
    await page.waitForSelector('#cover');
    assert.ok(await coverCheck.isChecked());
    assert.ok(await clean.isChecked());
    assert.equal(await formats.nth(0).inputValue(), 'original');
    assert.equal(await formats.nth(1).inputValue(), 'original');
    await page.locator('#cover').screenshot({ path: path.join(out, 'cover-settings.png') });
    await page.locator('#tags').screenshot({ path: path.join(out, 'tag-settings.png') });

    // 页面使用内容哈希地址，复用已加载的 prefs 模块，避免产生另一份设置状态
    await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map((entry) => entry.name).find((url) => /\/prefs\.[^/]+\.mjs$/.test(url));
      if (!url) throw new Error('prefs module not loaded');
      window.testPrefs = (await import(url)).prefs;
    });
    await page.evaluate(() => window.AmI18n.setLang('en'));
    await page.getByRole('switch', { name: 'Save cover file', exact: true }).waitFor();
    assert.ok(await page.getByRole('switch', { name: 'Clean album suffixes', exact: true }).isChecked());
    await page.evaluate(() => window.AmI18n.setLang('zh'));
    console.log('PASS settings: defaults, cover tag selection, persistence and both languages');

    const fixtures = [
      { id: '1528253996', album: '夏のせい ep', embed: true, saved: true, format: 'original', type: 13 },
      { id: '6823578501', album: 'Wake Me Up', embed: false, saved: true, format: 'original' },
      { id: '6788717424', album: 'Amore (Special Edition)', embed: true, saved: false, format: 'png', type: 14 },
    ];
    for (const fixture of fixtures) {
      const catalog = await page.evaluate(async (id) => {
        const res = await fetch(`/amp/v1/catalog/jp/albums/${id}?include=tracks&l=ja`);
        const data = await res.json();
        if (!res.ok) throw new Error(JSON.stringify(data));
        return data.data[0];
      }, fixture.id);
      const track = catalog.relationships.tracks.data.find((r) => r.type === 'songs' && r.attributes.playParams);
      assert.ok(track, fixture.id);
      await page.evaluate((fixture) => {
        window.testPrefs.set('download', { codec: 'aac', normalizeAlbumName: true, embed: fixture.embed ? ['title', 'album', 'cover'] : ['title', 'album'],
          sortTags: true, saveCover: fixture.saved, coverFormat: fixture.format, saveCoverFormat: 'original',
          coverSize: 600, saveCoverSize: 600, saveLyrics: false, saveMode: 'zip', retries: 0 });
      }, fixture);
      const pending = page.waitForEvent('download', { timeout: 180000 });
      pending.catch(() => {});
      await page.evaluate(async ({ id, trackId }) => {
        window.testJob = await window.AmDownloads.add({ kind: 'album', id, country: 'jp', select: [trackId] });
      }, { id: fixture.id, trackId: track.id });
      await page.waitForFunction(() => window.testJob.saved || window.testJob.prepError || window.testJob.packError || window.AmDownloads.jobState(window.testJob) === 'error', null, { timeout: 180000 });
      const state = await page.evaluate(() => ({ saved: window.testJob.saved, prep: window.testJob.prepError,
        pack: window.testJob.packError, tasks: window.testJob.tasks.map((t) => ({ state: t.state, error: t.error })) }));
      assert.ok(state.saved, JSON.stringify(state));
      const download = await pending;
      assert.ok(download.suggestedFilename().endsWith(` - ${fixture.album}.zip`), download.suggestedFilename());
      const file = path.join(out, `${fixture.id}.zip`);
      await download.saveAs(file);
      const entries = unzip(fs.readFileSync(file));
      const audio = [...entries.keys()].find((name) => name.endsWith('.m4a'));
      const tags = mp4Tags(entries.get(audio));
      assert.equal(tags.get('\xa9alb').value, fixture.album);
      assert.equal(tags.get('soal').value, fixture.album);
      assert.equal(tags.has('covr'), fixture.embed);
      assert.equal(entries.has('cover.jpg'), fixture.saved);
      if (fixture.saved) assert.equal(entries.get('cover.jpg').subarray(0, 3).toString('hex'), 'ffd8ff');
      if (fixture.embed) {
        assert.equal(tags.get('covr').type, fixture.type);
        assert.equal(tags.get('covr').value.subarray(0, fixture.type === 14 ? 8 : 3).toString('hex'), fixture.type === 14 ? '89504e470d0a1a0a' : 'ffd8ff');
      }
      console.log(`PASS live album ${fixture.id}: ${fixture.album}, embedded=${fixture.embed}, saved=${fixture.saved}, format=${fixture.format}`);
      await page.evaluate(() => window.AmDownloads.clearFinished());
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });

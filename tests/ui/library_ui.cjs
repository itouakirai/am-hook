// Run with: node tests/library_ui.cjs <path-to-playwright-package>
// 资料库与歌单（web/library.mjs、views/library*.mjs）：用本地 fixture 与已安装的 Chrome，不需要 wrapper-lite 或 Apple CDN。
// 覆盖：专辑页「+」把专辑与曲目加入资料库、资料库各分类、新建歌单、「添加到歌单」子菜单、键盘排序、
// 刷新后数据仍在（IndexedDB）、导出 / 清空 / 导入（合并）、导入文件的链接校验、喜爱与「喜爱的歌曲」、
// 歌单文件夹（新建、嵌套、移动、拖放、删除）、旧版数据库（版本 1）升级，以及手机宽度下不横向溢出。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');

const { serveWeb } = require('../support/web.cjs');
const BASE = 'http://am.test';
const ALBUM_PATH = '/https://music.apple.com/us/album/test-album/100';
const art = (id) => ({ url: `https://img.test/${id}/{w}x{h}bb.jpg`, bgColor: '334455' });
const artist = { id: '42', type: 'artists', attributes: { name: 'Fixture Artist', url: 'https://music.apple.com/us/artist/fixture-artist/42' } };

function song(id, name, n) {
  return {
    id, type: 'songs',
    attributes: {
      name, artistName: 'Fixture Artist', albumName: 'Test Album', durationInMillis: 180000 + n * 1000, trackNumber: n, discNumber: 1,
      artwork: art('100'), playParams: { id, kind: 'song' }, url: `https://music.apple.com/us/album/test-album/100?i=${id}`,
    },
    relationships: { artists: { data: [artist] } },
  };
}

const album = {
  id: '100', type: 'albums',
  attributes: {
    name: 'Test Album', artistName: 'Fixture Artist', artwork: art('100'), url: 'https://music.apple.com/us/album/test-album/100',
    releaseDate: '2024-05-01', trackCount: 3, genreNames: ['Pop'], playParams: { id: '100', kind: 'album' },
  },
  relationships: {
    artists: { data: [artist] },
    tracks: { data: [song('101', 'First Song', 1), song('102', 'Second Song', 2), song('103', 'Third Song', 3)] },
  },
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-hook-library-'));
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await context.addInitScript(() => localStorage.setItem('am-hook:lang', 'en'));
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== BASE) return route.fulfill({ status: 404, body: '' });
      if (url.pathname === '/amp/v1/catalog/us/albums/100') return route.fulfill({ json: { data: [album] } });
      if (url.pathname.startsWith('/amp/')) return route.fulfill({ status: 404, json: { errors: [] } });
      if (url.pathname === '/status') return route.fulfill({ json: { code: 0, regions: ['us'] } });
      // 同源的空白页：在打开应用之前写入旧版数据库
      if (url.pathname === '/blank') return route.fulfill({ body: '<!doctype html><title>blank</title>', contentType: 'text/html' });
      if (url.pathname.startsWith('/lyrics/') || url.pathname.startsWith('/parse/')) return route.fulfill({ status: 404, json: { code: 1, msg: 'offline' } });
      // 单页应用：页面地址返回 app.html，/assets/<path> 即 web/<path>
      return serveWeb(route, url);
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const toast = async (pattern) => {
      await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('toast').textContent), pattern.source);
    };
    const rowTitles = () => page.locator('#view .lib-track .track-title').allTextContents();

    const menuLabel = (text) => page.locator('.menu .menu-label').filter({ hasText: new RegExp(`^${text}$`) });
    // 详情页头部的「更多」（旁边还有 ALAC 检测按钮）
    const headerMore = page.locator('.detail-extra .detail-circle-btn[aria-haspopup="menu"]');
    const openHeaderMenu = async () => {
      await page.waitForFunction(() => document.querySelector('.detail-extra .detail-circle-btn[aria-haspopup="menu"]')?.disabled === false);
      await headerMore.click();
      await page.locator('.menu:not([hidden])').waitFor();
    };

    // 1. 专辑页头部「更多」→「添加到资料库」：专辑与全部曲目加入资料库，菜单项变为「从资料库中删除」
    await page.goto(BASE + ALBUM_PATH);
    await openHeaderMenu();
    assert.equal(await page.locator('.detail-actions button:not([hidden])').count(), 4, 'album header keeps play, shuffle, Check ALAC and More');
    await menuLabel('Add to Library').click();
    await toast(/Added “Test Album”/);
    await openHeaderMenu();
    assert.equal(await menuLabel('Delete from Library').count(), 1, 'album is in the library');
    await page.keyboard.press('Escape');

    // 2. 资料库各分类：歌曲、专辑、艺人、最近添加
    await page.locator('#nav [data-nav="library:songs"]').click();
    await page.waitForURL('**/library/songs', { waitUntil: 'commit' });
    await page.locator('#view .lib-track').first().waitFor();
    assert.deepEqual(await rowTitles(), ['First Song', 'Second Song', 'Third Song'], 'songs sorted by title');
    assert.equal(await page.locator('#nav [data-nav="library:songs"]').getAttribute('aria-current'), 'page');
    await page.locator('#filter').fill('second');
    assert.deepEqual(await rowTitles(), ['Second Song'], 'filter narrows the list');
    await page.locator('#filter').fill('');
    await page.locator('#nav [data-nav="library:albums"]').click();
    await page.locator('#view .lib-grid .shelf-title').first().waitFor();
    assert.deepEqual(await page.locator('#view .lib-grid .shelf-title').allTextContents(), ['Test Album']);
    assert.equal(await page.locator('#view .lib-grid a.shelf-item').getAttribute('href'), ALBUM_PATH);
    await page.locator('#nav [data-nav="library:artists"]').click();
    await page.locator('#view .lib-artist-title').waitFor();
    assert.equal(await page.locator('#view .lib-artist-title').textContent(), 'Fixture Artist');
    assert.equal(await page.locator('#view .lib-artist-detail .lib-track').count(), 3, 'artist shows their songs');

    // 3. 侧边栏「+」→「新建歌单…」：对话框 → 创建后打开歌单页（空）
    await page.locator('[data-new-playlist]').click();
    await page.locator('.menu .menu-label').filter({ hasText: /^New Playlist…$/ }).click();
    await page.locator('.lib-dialog input[name="name"]').fill('Road Trip');
    await page.locator('.lib-dialog textarea[name="description"]').fill('Songs for the drive');
    await page.locator('.lib-dialog .primary').click();
    await page.waitForURL(/\/library\/playlist\/p\.[\w-]+$/, { waitUntil: 'commit' });
    const playlistUrl = page.url();
    await page.locator('#empty:not([hidden])').waitFor();
    assert.equal(await page.locator('#title').textContent(), 'Road Trip');
    assert.equal(await page.locator('#nav-playlists a').textContent(), 'Road Trip', 'sidebar lists the playlist');
    assert.equal(await page.locator('#nav-playlists a').getAttribute('aria-current'), 'page');

    // 4. 歌曲行「更多」→「添加到歌单」子菜单 → 歌单；重复添加时提示已存在
    const addToPlaylist = async (title) => {
      await page.locator('#view .lib-track', { hasText: title }).locator('.track-more').click();
      await page.locator('.menu .menu-item', { hasText: 'Add to Playlist' }).click();
      assert.equal(await page.locator('.menu .menu-back').textContent(), 'Add to Playlist', 'submenu has a back item');
      await page.locator('.menu .menu-item', { hasText: 'Road Trip' }).click();
    };
    await page.locator('#nav [data-nav="library:songs"]').click();
    await page.locator('#view .lib-track').first().waitFor();
    await addToPlaylist('First Song');
    await toast(/Added 1 to “Road Trip”/);
    await addToPlaylist('Third Song');
    await toast(/Added 1 to “Road Trip”/);
    await addToPlaylist('First Song');
    await toast(/Already in “Road Trip”/);

    // 5. 歌单页：两首，键盘排序（把手上按 ↑），从歌单中删除
    await page.locator('#nav-playlists a').click();
    await page.locator('#view .lib-track').nth(1).waitFor();
    assert.deepEqual(await rowTitles(), ['First Song', 'Third Song']);
    await page.locator('#view .lib-grip').nth(1).focus();
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.querySelector('#view .lib-track .track-title').textContent === 'Third Song');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('lib-grip')), true, 'focus stays on the moved handle');
    assert.equal(await page.locator('#notes-text').textContent(), 'Songs for the drive');

    // 6. 刷新后仍在（IndexedDB）
    await page.reload();
    await page.locator('#view .lib-track').nth(1).waitFor();
    assert.deepEqual(await rowTitles(), ['Third Song', 'First Song'], 'order persists across reloads');

    // 7. 导出整个资料库
    await page.goto(BASE + '/library/all-playlists');
    await page.locator('#view .lib-grid .shelf-title').first().waitFor();
    await page.locator('#lib-more').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.menu .menu-item', { hasText: 'Export Library' }).click()]);
    const exportFile = path.join(tmp, download.suggestedFilename());
    await download.saveAs(exportFile);
    const exported = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    assert.equal(exported.format, 'am-hook-library');
    assert.equal(exported.version, 1);
    assert.equal(exported.items.filter((item) => item.kind === 'song').length, 3);
    assert.equal(exported.items.filter((item) => item.kind === 'album').length, 1);
    assert.deepEqual(exported.playlists.map((list) => list.tracks.map((track) => track.name)), [['Third Song', 'First Song']]);

    // 8. 清空（确认对话框）→ 导入（合并）恢复
    await page.locator('#lib-more').click();
    await page.locator('.menu .menu-item', { hasText: 'Clear Library' }).click();
    await page.locator('.lib-dialog .primary').click();
    // 只剩固定在最前的「喜爱的歌曲」
    await page.waitForFunction(() => [...document.querySelectorAll('#view .lib-grid .shelf-title')].map((n) => n.textContent).join() === 'Favorite Songs');
    assert.equal(await page.locator('#nav-playlists a').count(), 0, 'sidebar empties too');
    await page.locator('#lib-more').click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.menu .menu-item', { hasText: 'Import' }).click()]);
    await chooser.setFiles(exportFile);
    await page.locator('.lib-dialog').waitFor();
    assert.match(await page.locator('.lib-dialog-message').textContent(), /4 library items, 1 playlists \(2 tracks\) and 0 folders/);
    await page.locator('.lib-dialog .primary').click();
    await toast(/Imported 4 library items, 1 playlists and 0 folders/);
    await page.goto(playlistUrl);
    await page.locator('#view .lib-track').nth(1).waitFor();
    assert.deepEqual(await rowTitles(), ['Third Song', 'First Song'], 'import restores the playlist with the same id');

    // 9. 导入文件的校验：危险链接被清除，无效条目被跳过
    const hostile = {
      format: 'am-hook-library', version: 1,
      items: [{ kind: 'song', id: 'not-a-number', name: 'bad' }],
      playlists: [{ id: 'p.shared1', name: 'Shared', tracks: [
        { kind: 'song', id: '555', name: 'Evil', href: 'javascript:alert(1)', artwork: 'javascript:alert(2)', artists: [{ name: 'X', href: 'https://evil.test/' }] },
      ] }],
    };
    const hostileFile = path.join(tmp, 'shared.am-hook-playlist.json');
    fs.writeFileSync(hostileFile, JSON.stringify(hostile));
    await page.goto(BASE + '/library/all-playlists');
    await page.locator('#view .lib-grid').waitFor();
    await page.locator('#lib-more').click();
    const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.menu .menu-item', { hasText: 'Import' }).click()]);
    await chooser2.setFiles(hostileFile);
    await page.locator('.lib-dialog').waitFor();
    assert.match(await page.locator('.lib-dialog-message').textContent(), /1 invalid entries will be skipped/);
    await page.locator('.lib-dialog .primary').click();
    await page.waitForURL('**/library/playlist/p.shared1', { waitUntil: 'commit' });
    await page.locator('#view .lib-track').first().waitFor();
    assert.equal(await page.locator('#view .lib-track a[href^="javascript"], #view .lib-track a[href^="https://evil"]').count(), 0, 'unsafe links dropped');
    assert.equal(await page.locator('#view .lib-track span.track-title').textContent(), 'Evil', 'title kept as plain text');

    // 10. 喜爱：歌曲行菜单「喜爱」→ 行内星形、「喜爱」筛选、「喜爱的歌曲」；专辑页「更多」→「喜爱」
    await page.goto(BASE + '/library/songs');
    await page.locator('#view .lib-track').nth(2).waitFor();
    await page.locator('#view .lib-track', { hasText: 'Second Song' }).locator('.track-more').click();
    await menuLabel('Favorite').click();
    await toast(/Favorited “Second Song”/);
    await page.locator('#view .lib-track', { hasText: 'Second Song' }).locator('.lib-fav').waitFor();
    await page.locator('#fav-only').click();
    assert.deepEqual(await rowTitles(), ['Second Song'], 'favorites filter');
    await page.locator('#fav-only').click();
    await page.locator('#nav [data-nav="library:favorite-songs"]').click();
    await page.waitForURL('**/library/favorite-songs', { waitUntil: 'commit' });
    await page.locator('#view .lib-track').first().waitFor();
    assert.equal(await page.locator('#title').textContent(), 'Favorite Songs');
    assert.deepEqual(await rowTitles(), ['Second Song']);
    assert.equal(await page.locator('.detail-actions button:not([hidden])').count(), 3, 'Favorite Songs header keeps three buttons');
    await page.locator('#more').click();
    assert.equal(await menuLabel('Edit…').count(), 0, 'Favorite Songs cannot be edited');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#view .lib-grip').count(), 0, 'Favorite Songs cannot be reordered');
    await page.locator('#view .lib-track .track-more').click();
    await menuLabel('Undo Favorite').click();
    await page.locator('#empty:not([hidden])').waitFor();
    assert.equal(await page.locator('#empty .lib-empty-title').textContent(), 'No favorite songs yet');
    await page.goto(BASE + ALBUM_PATH);
    await openHeaderMenu();
    await menuLabel('Favorite').click();
    await toast(/Favorited “Test Album”/);
    await openHeaderMenu();
    assert.equal(await menuLabel('Undo Favorite').count(), 1);
    await page.keyboard.press('Escape');
    await page.goto(BASE + '/library/albums');
    await page.locator('#fav-only').click();
    assert.deepEqual(await page.locator('#view .lib-grid .shelf-title').allTextContents(), ['Test Album'], 'favorite album listed');

    // 11. 歌单文件夹：+ → 新建文件夹 → 在其中新建子文件夹 → 歌单「移到文件夹」→ 侧边栏拖放 → 不能移进自己的子文件夹 → 删除
    await page.locator('[data-new-playlist]').click();
    await menuLabel('New Playlist Folder…').click();
    await page.locator('.lib-dialog input[name="name"]').fill('Mix');
    await page.locator('.lib-dialog .primary').click();
    await page.waitForURL(/\/library\/playlist-folder\/f\.[\w-]+$/, { waitUntil: 'commit' });
    const mixUrl = page.url();
    await page.locator('#view .lib-empty').waitFor();
    assert.equal(await page.locator('#title').textContent(), 'Mix');
    await page.locator('#lib-more').click();
    await menuLabel('New Playlist Folder…').click();
    await page.locator('.lib-dialog input[name="name"]').fill('Sub');
    await page.locator('.lib-dialog .primary').click();
    await page.waitForFunction(() => document.getElementById('title')?.textContent === 'Sub');
    assert.equal(await page.locator('#crumbs').textContent(), 'All Playlists › Mix', 'breadcrumb shows the parent folder');

    await page.goto(playlistUrl);
    await page.locator('#view .lib-track').first().waitFor();
    await page.locator('#more').click();
    await menuLabel('Move to Folder').click();
    await page.locator('.menu .menu-item', { hasText: 'Sub' }).click();
    await toast(/Moved to “Sub”/);
    assert.equal(await page.locator('#artist a').textContent(), 'Sub', 'playlist header links its folder');
    // 所在文件夹在侧边栏中自动展开
    await page.locator('#nav-playlists .nav-folder-children a', { hasText: 'Road Trip' }).waitFor();

    await page.locator('#nav-playlists a', { hasText: 'Shared' }).dragTo(page.locator('#nav-playlists .nav-folder-row', { hasText: 'Mix' }).first());
    await toast(/Moved to “Mix”/);
    await page.goto(mixUrl);
    await page.locator('#view .lib-grid .shelf-title').first().waitFor();
    assert.deepEqual(await page.locator('#view .lib-grid .shelf-title').allTextContents(), ['Sub', 'Shared'], 'folder lists subfolders first');
    await page.locator('#lib-more').click();
    await menuLabel('Move to Folder').click();
    assert.equal(await page.locator('.menu .menu-item', { hasText: 'Sub' }).count(), 0, 'a folder cannot move into its own subfolder');
    await page.keyboard.press('Escape');

    // 导出包含文件夹与歌单所在的文件夹
    await page.goto(BASE + '/library/all-playlists');
    await page.locator('#view .lib-grid').waitFor();
    await page.locator('#lib-more').click();
    const [download2] = await Promise.all([page.waitForEvent('download'), page.locator('.menu .menu-item', { hasText: 'Export Library' }).click()]);
    const exported2 = JSON.parse(fs.readFileSync(await download2.path(), 'utf8'));
    assert.deepEqual(exported2.folders.map((dir) => dir.name).sort(), ['Mix', 'Sub']);
    const mixId = exported2.folders.find((dir) => dir.name === 'Mix').id;
    assert.equal(exported2.folders.find((dir) => dir.name === 'Sub').parentId, mixId);
    assert.equal(exported2.playlists.find((list) => list.name === 'Shared').folderId, mixId);
    assert(exported2.items.some((item) => item.kind === 'album' && item.favorite > 0), 'favorites are exported');

    await page.goto(mixUrl);
    await page.locator('#view .lib-grid').waitFor();
    await page.locator('#lib-more').click();
    await menuLabel('Delete Folder…').click();
    assert.match(await page.locator('.lib-dialog-message').textContent(), /2 playlists and 1 subfolders/);
    await page.locator('.lib-dialog .primary').click();
    await page.waitForURL('**/library/all-playlists', { waitUntil: 'commit' });
    await page.locator('#view .lib-grid .shelf-title').first().waitFor();
    assert.deepEqual(await page.locator('#view .lib-grid .shelf-title').allTextContents(), ['Favorite Songs'], 'folder deleted with its playlists');
    assert.equal(await page.locator('#nav-playlists li').count(), 0);

    // 12. 手机宽度：资料库与歌单页不横向溢出
    await page.setViewportSize({ width: 360, height: 780 });
    for (const target of ['/library/songs', '/library/albums', '/library/artists', '/library/all-playlists', '/library/favorite-songs']) {
      await page.goto(target.startsWith('http') ? target : BASE + target);
      await page.locator('#view .app-page').waitFor({ state: 'attached' });
      await page.waitForTimeout(150);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow on ${target}`);
    }
    await page.screenshot({ path: 'target/ui-library-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(BASE + '/library/songs');
    await page.locator('#view .lib-track').first().waitFor();
    await page.screenshot({ path: 'target/ui-library.png' });

    assert.deepEqual(errors, []);
    await context.close();

    // 13. 旧版数据库（版本 1：只有 items 与 playlists）升级到版本 2：原有歌单保留，新增 folders
    const legacy = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await legacy.addInitScript(() => localStorage.setItem('am-hook:lang', 'en'));
    await legacy.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== BASE) return route.fulfill({ status: 404, body: '' });
      if (url.pathname === '/blank') return route.fulfill({ body: '<!doctype html><title>blank</title>', contentType: 'text/html' });
      if (url.pathname === '/status') return route.fulfill({ json: { code: 0, regions: ['us'] } });
      if (url.pathname.startsWith('/amp/') || url.pathname.startsWith('/lyrics/')) return route.fulfill({ status: 404, json: {} });
      return serveWeb(route, url);
    });
    const old = await legacy.newPage();
    const oldErrors = [];
    old.on('pageerror', (e) => oldErrors.push(e.message));
    await old.goto(BASE + '/blank');
    await old.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('am-hook-library', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('items', { keyPath: 'key' });
        req.result.createObjectStore('playlists', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const tx = req.result.transaction(['playlists'], 'readwrite');
        tx.objectStore('playlists').put({ id: 'p.legacy1', name: 'Legacy', description: '', createdAt: 1, updatedAt: 2, tracks: [] });
        tx.oncomplete = () => { req.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    }));
    await old.goto(BASE + '/library/all-playlists');
    await old.locator('#view .lib-grid .shelf-title', { hasText: 'Legacy' }).waitFor();
    assert.equal(await old.locator('#nav-playlists a').textContent(), 'Legacy', 'v1 playlist survives the upgrade');
    const stores = await old.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open('am-hook-library');
      req.onsuccess = () => { resolve({ version: req.result.version, stores: [...req.result.objectStoreNames] }); req.result.close(); };
    }));
    assert.deepEqual(stores, { version: 2, stores: ['folders', 'items', 'playlists'] });
    assert.deepEqual(oldErrors, []);
    await legacy.close();
    console.log('Passed library: add album, sections, playlists, add-to-playlist, reorder, persistence, export / clear / import, validation, favorites, folders, v1 upgrade, mobile layout.');
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

// 资料库页（与 music.apple.com 的 /library/... 相同），由 app.mjs 挂载：
//   /library/recently-added  最近添加（专辑、歌单、MV，按添加时间）    /library/artists[/<名称>]  艺人（左侧列表，右侧该艺人的专辑与歌曲）
//   /library/albums          专辑（含只添加了部分歌曲的专辑）          /library/songs             歌曲
//   /library/music-videos    音乐视频                                 /library/all-playlists     所有歌单（本地歌单与添加的 Apple Music 歌单）
//   /library/playlist-folder/f.<id>  歌单文件夹（子文件夹与其中的歌单）
// 歌曲、专辑、艺人、音乐视频与歌单可以只看喜爱的条目（「喜爱」筛选）。
// 数据全部来自浏览器中的资料库（/assets/library.mjs），不请求服务端；本地歌单与「喜爱的歌曲」页见 library-playlist.mjs。
import * as library from '/assets/library.mjs';
import { createActions, openMenu } from './actions.mjs';
import {
  LIB_ICON, playlistCover, playlistName, newPlaylist, editPlaylist, deletePlaylist, exportPlaylist,
  exportLibrary, importLibrary, clearLibrary, trackRow, syncTrackRows,
  favoriteCover, folderCover, folderName, newFolder, renameFolder, deleteFolder, exportFolder, moveMenuItems,
} from './library-ui.mjs';

const { AmI18n } = window;
const { t } = AmI18n;

export const bodyClass = 'library-page';
export const styles = ['/assets/views/library.css'];

export const SECTIONS = ['recently-added', 'artists', 'albums', 'songs', 'music-videos', 'all-playlists', 'playlist-folder'];
/** 有「喜爱」筛选的分类 */
const FAVORITE_FILTER = ['artists', 'albums', 'songs', 'music-videos', 'all-playlists'];
/** 各分类可选的排序（第一项为默认） */
const SORTS = {
  albums: ['recent', 'title', 'artist'],
  songs: ['title', 'artist', 'album', 'recent', 'duration'],
  'music-videos': ['recent', 'title', 'artist'],
  'all-playlists': ['recent', 'title'],
};
const SORT_KEY = 'am-hook:library-sort';
/** 歌曲较多时分批渲染，滚动到底部再接着渲染 */
const CHUNK = 200;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

const collator = () => new Intl.Collator(AmI18n.lang === 'zh' ? 'zh-CN' : 'en', { numeric: true, sensitivity: 'base' });

/* ---------- 由资料库条目归纳出专辑与艺人（与 Apple Music 相同，添加单曲后其专辑、艺人也出现在资料库中） ---------- */
/** 专辑：专辑条目与歌曲 / MV 所属的专辑合并；{ id, name, artist, artistHref, href, artwork, country, addedAt, tracks } */
export function libraryAlbums() {
  const albums = new Map();
  for (const item of library.libraryItems('album')) {
    albums.set(item.id, { ...item, tracks: [] });
  }
  for (const track of library.libraryItems()) {
    if ((track.kind !== 'song' && track.kind !== 'music-video') || !track.albumId || !track.albumHref) continue;
    let album = albums.get(track.albumId);
    if (!album) {
      album = {
        kind: 'album', id: track.albumId, name: track.album, artist: track.artist, artistHref: '', href: track.albumHref,
        artwork: track.artwork, country: track.country, addedAt: track.addedAt, tracks: [],
      };
      albums.set(track.albumId, album);
    }
    album.addedAt = Math.max(album.addedAt, track.addedAt);
    album.tracks.push(track);
  }
  return [...albums.values()];
}

/** 艺人：专辑按专辑艺人、其余歌曲按歌曲艺人归类；{ name, href, artwork, albums, songs } */
function libraryArtists(albums) {
  const artists = new Map();
  const get = (name) => {
    if (!artists.has(name)) artists.set(name, { name, href: '', artwork: '', albums: [], songs: [], favorite: 0, id: '', country: '' });
    return artists.get(name);
  };
  // 喜爱的艺人（与 Apple Music 相同，喜爱即出现在资料库的艺人中）
  for (const item of library.libraryItems('artist')) {
    const artist = get(item.name);
    Object.assign(artist, { href: item.href, artwork: item.artwork, favorite: item.favorite, id: item.id, country: item.country });
  }
  const inAlbum = new Set();
  for (const album of albums) {
    if (!album.artist) continue;
    const artist = get(album.artist);
    artist.albums.push(album);
    if (!artist.artwork) artist.artwork = album.artwork;
    if (!artist.href) artist.href = album.artistHref;
    for (const track of album.tracks) {
      if (track.kind === 'song') artist.songs.push(track);
      inAlbum.add(track.key);
    }
  }
  for (const track of library.libraryItems('song')) {
    if (inAlbum.has(track.key) || !track.artist) continue;
    const artist = get(track.artist);
    artist.songs.push(track);
    if (!artist.artwork) artist.artwork = track.artwork;
  }
  for (const artist of artists.values()) {
    if (!artist.id) artist.id = (artist.href.match(/\/(\d+)$/) || [])[1] || '';
    if (artist.href) continue;
    // 艺人页链接：曲目里同名艺人的链接
    for (const track of artist.songs) {
      const hit = (track.artists || []).find((a) => a.name === artist.name && a.href);
      if (hit) { artist.href = hit.href; break; }
    }
    artist.id = (artist.href.match(/\/(\d+)$/) || [])[1] || '';
    if (!artist.country) artist.country = ((artist.songs[0] || artist.albums[0] || {}).country) || 'us';
  }
  return [...artists.values()];
}

export function mount({ root, url, signal, player, navigate, toast, onLangChange }) {
  const actions = createActions({ signal, player, navigate, toast });
  const $ = (id) => root.querySelector(`#${id}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const section = SECTIONS.includes(parts[1]) ? parts[1] : 'recently-added';
  /** 艺人分类中选中的艺人（地址 /library/artists/<名称>） */
  let artistName = section === 'artists' && parts[2] ? safeDecode(parts[2]) : '';
  /** 文件夹页的文件夹 id */
  const folderId = section === 'playlist-folder' ? parts[2] || '' : '';
  let filter = '';
  /** 只看喜爱的条目 */
  let favoritesOnly = false;
  let sort = savedSort();
  /** 歌曲分类当前显示（筛选、排序后）的歌曲，播放队列按这个顺序 */
  let visibleSongs = [];
  let rows = [];
  let loaded = false;

  function safeDecode(value) {
    try { return decodeURIComponent(value); } catch { return value; }
  }

  function savedSort() {
    const options = SORTS[section];
    if (!options) return '';
    try {
      const saved = JSON.parse(localStorage.getItem(SORT_KEY) || '{}')[section];
      if (options.includes(saved)) return saved;
    } catch {}
    return options[0];
  }

  function saveSort() {
    try {
      const all = JSON.parse(localStorage.getItem(SORT_KEY) || '{}');
      all[section] = sort;
      localStorage.setItem(SORT_KEY, JSON.stringify(all));
    } catch {}
  }

  /* ---------- 头部 ---------- */
  function renderHead() {
    const dir = folderId ? library.folder(folderId) : null;
    const title = section === 'playlist-folder' ? (dir ? folderName(dir) : t('library.folderNotFound')) : t(`library.${section}`);
    document.title = `${title} · am-hook`;
    $('title').textContent = title;
    // 文件夹页：「所有歌单 › 上级文件夹 ›」
    $('crumbs').hidden = !dir;
    if (dir) {
      const path = library.folderPath(folderId).slice(0, -1);
      const links = [el('a', { href: '/library/all-playlists', textContent: t('library.all-playlists') }),
        ...path.map((p) => el('a', { href: `/library/playlist-folder/${p.id}`, textContent: folderName(p) }))];
      $('crumbs').replaceChildren(...links.flatMap((link, i) => (i ? [el('span', { textContent: ' › ', ariaHidden: 'true' }), link] : [link])));
    }
    $('fav-only').hidden = !FAVORITE_FILTER.includes(section);
    $('fav-only').setAttribute('aria-pressed', String(favoritesOnly));
    $('fav-only').title = t('library.favoritesOnly');
    const options = SORTS[section];
    $('sort-wrap').hidden = !options;
    if (options) {
      $('sort').replaceChildren(...options.map((key) => el('option', { value: key, textContent: t(`library.sort.${key}`), selected: key === sort })));
      $('sort').setAttribute('aria-label', t('library.sortBy'));
    }
    $('new-playlist').hidden = section !== 'all-playlists' && !(section === 'playlist-folder' && dir);
    if (!library.persistent() && loaded) {
      $('alert').hidden = false;
      $('alert').textContent = t('library.memoryOnly');
    } else {
      $('alert').hidden = true;
    }
  }

  $('filter').addEventListener('input', () => {
    filter = $('filter').value.trim();
    render();
  });
  $('sort').addEventListener('change', () => {
    sort = $('sort').value;
    saveSort();
    render();
  });
  $('fav-only').addEventListener('click', () => {
    favoritesOnly = !favoritesOnly;
    render();
  });
  $('new-playlist').addEventListener('click', () => newPlaylist({ folderId, open: true, navigate, toast }));
  $('lib-more').addEventListener('click', (e) => {
    e.stopPropagation();
    const dir = folderId ? library.folder(folderId) : null;
    // 文件夹页：文件夹自己的操作在前
    const folderItems = dir ? [
      { icon: LIB_ICON.edit, label: t('library.renameFolderEllipsis'), onSelect: () => renameFolder(folderId) },
      { icon: LIB_ICON.move, label: t('library.moveToFolder'), submenu: () => moveMenuItems({ type: 'folder', id: folderId }, dir.parentId, { toast }) },
      { icon: LIB_ICON.export, label: t('library.exportFolder'), onSelect: () => exportFolder(folderId) },
      { icon: LIB_ICON.remove, label: t('library.deleteFolderEllipsis'), danger: true, onSelect: () => deleteFolder(folderId, { toast, onDeleted: () => navigate(dir.parentId ? `/library/playlist-folder/${dir.parentId}` : '/library/all-playlists', { replace: true }) }) },
      '-',
    ] : [];
    openMenu($('lib-more'), [
      ...folderItems,
      { icon: LIB_ICON.add, label: t('library.newPlaylistEllipsis'), onSelect: () => newPlaylist({ folderId: dir ? folderId : '', open: true, navigate, toast }) },
      { icon: LIB_ICON.newFolder, label: t('library.newFolderEllipsis'), onSelect: () => newFolder({ parentId: dir ? folderId : '', open: true, navigate, toast }) },
      '-',
      { icon: LIB_ICON.export, label: t('library.exportLibrary'), hint: t('library.exportHint'), onSelect: () => exportLibrary({ toast }) },
      { icon: LIB_ICON.import, label: t('library.importMenu'), hint: t('library.importMenuHint'), onSelect: () => importLibrary({ toast, navigate }) },
      '-',
      { icon: LIB_ICON.remove, label: t('library.clearMenu'), danger: true, onSelect: () => clearLibrary({ toast }) },
    ]);
  });
  $('play-all').addEventListener('click', () => playSongs(0, false));
  $('shuffle').addEventListener('click', () => playSongs(Math.floor(Math.random() * visibleSongs.length), true));

  /* ---------- 通用部件 ---------- */
  const matches = (...fields) => {
    if (!filter) return true;
    const q = filter.toLocaleLowerCase();
    return fields.some((field) => field && field.toLocaleLowerCase().includes(q));
  };

  function sortBy(list, key) {
    const c = collator();
    const by = {
      recent: (a, b) => (b.addedAt || b.updatedAt || 0) - (a.addedAt || a.updatedAt || 0),
      title: (a, b) => c.compare(a.name || '', b.name || ''),
      artist: (a, b) => c.compare(a.artist || '', b.artist || '') || c.compare(a.album || a.name || '', b.album || b.name || ''),
      album: (a, b) => c.compare(a.album || '', b.album || '') || c.compare(a.name || '', b.name || ''),
      duration: (a, b) => (a.duration || 0) - (b.duration || 0),
    }[key];
    return by ? list.slice().sort(by) : list;
  }

  /** 空状态：标题与提示；筛选没有结果时提示筛选词 */
  function empty(key) {
    if (filter) return el('div', { className: 'lib-empty' }, el('p', { className: 'lib-empty-title', textContent: t('library.noMatch', { q: filter }) }));
    if (favoritesOnly) {
      return el('div', { className: 'lib-empty' },
        el('span', { className: 'lib-empty-icon', innerHTML: LIB_ICON.starFilled }),
        el('p', { className: 'lib-empty-title', textContent: t('library.noFavorites') }),
        el('p', { className: 'lib-empty-hint', textContent: t('library.noFavoritesHint') }));
    }
    const hint = { 'all-playlists': 'library.emptyPlaylistsHint', 'playlist-folder': 'library.emptyFolderHint' }[key] || 'library.emptyHint';
    return el('div', { className: 'lib-empty' },
      el('span', { className: 'lib-empty-icon', innerHTML: key === 'playlist-folder' ? LIB_ICON.folder : LIB_ICON.playlist }),
      el('p', { className: 'lib-empty-title', textContent: t(`library.empty.${key}`) }),
      el('p', { className: 'lib-empty-hint', textContent: t(hint) }));
  }

  /** 「喜爱」筛选：开启时只保留喜爱的条目 */
  const favorite = (item) => !favoritesOnly || !!(item && item.favorite);

  /** 封面卡片（与各页面的货架卡片相同），外包 .card-wrap 加上播放与更多按钮 */
  function card({ href, art, title, sub, round = false, mv = false, target }) {
    const cover = el('span', { className: `shelf-art${round ? ' artist' : ''}${mv ? ' mv' : ''}` }, art);
    const node = el('a', { className: `shelf-item${mv ? ' mv' : ''}`, href },
      cover, el('span', { className: 'shelf-title', textContent: title }), el('span', { className: 'shelf-sub', textContent: sub || '' }));
    return target ? actions.wrapCard(node, target) : node;
  }

  function img(template, size, mv = false) {
    const src = library.artUrl(template, size, mv ? Math.round(size * 9 / 16) : size);
    return src ? el('img', { src, alt: '', loading: 'lazy', decoding: 'async' }) : el('span', { className: 'ph' });
  }

  const grid = (nodes, kind = '') => el('div', { className: `lib-grid${kind ? ` ${kind}` : ''}` }, ...nodes);

  function albumCard(album) {
    return card({
      href: album.href, art: img(album.artwork, 360), title: album.name, sub: album.artist,
      target: { kind: 'album', href: album.href, apple: library.appleUrl(album.href), name: album.name, country: album.country },
    });
  }

  function mvCard(track) {
    return card({
      href: track.href, art: img(track.artwork, 480, true), title: track.name, sub: track.artist, mv: true,
      target: { kind: 'music-video', href: track.href, apple: library.appleUrl(track.href), name: track.name, country: track.country, track },
    });
  }

  /** 播放本地歌单 */
  function playPlaylist(list, shuffle) {
    const songs = list.tracks.filter((track) => track.kind === 'song');
    if (!songs.length) { toast(t('action.noSongs', { name: playlistName(list) })); return; }
    player.playQueue(songs.map(library.entryOf), shuffle ? Math.floor(Math.random() * songs.length) : 0, { shuffle });
  }

  /** 本地歌单的菜单项（编辑、导出、删除），歌单页与卡片共用 */
  function playlistItems(list) {
    return [
      { icon: LIB_ICON.edit, label: t('library.editEllipsis'), onSelect: () => editPlaylist(list.id) },
      { icon: LIB_ICON.export, label: t('library.exportPlaylist'), onSelect: () => exportPlaylist(list.id) },
      { icon: LIB_ICON.remove, label: t('library.deletePlaylistEllipsis'), danger: true, onSelect: () => deletePlaylist(list.id, { toast }) },
    ];
  }

  function localPlaylistCard(list) {
    const target = {
      kind: 'library-playlist', name: playlistName(list), playlistId: list.id,
      onPlay: () => playPlaylist(list, false), onShuffle: () => playPlaylist(list, true),
      getTracks: () => list.tracks, extraItems: playlistItems(list), moveEntry: { type: 'playlist', id: list.id },
    };
    return card({
      href: `/library/playlist/${list.id}`, art: playlistCover(list, 360, 'lib-cover'), title: playlistName(list),
      sub: t('library.songCount', { n: list.tracks.length }), target,
    });
  }

  function catalogPlaylistCard(item) {
    return card({
      href: item.href, art: img(item.artwork, 360), title: item.name, sub: item.curator || 'Apple Music',
      target: { kind: 'playlist', href: item.href, apple: library.appleUrl(item.href), name: item.name, country: item.country },
    });
  }

  /** 「喜爱的歌曲」歌单的卡片（与 Apple Music 相同，排在所有歌单的最前面） */
  function favoriteSongsCard() {
    const songs = library.favoriteSongs();
    const play = (shuffle) => {
      if (!songs.length) { toast(t('action.noSongs', { name: t('library.favoriteSongs') })); return; }
      player.playQueue(songs.map(library.entryOf), shuffle ? Math.floor(Math.random() * songs.length) : 0, { shuffle });
    };
    return card({
      href: '/library/favorite-songs', art: favoriteCover('lib-cover'), title: t('library.favoriteSongs'), sub: t('library.songCount', { n: songs.length }),
      target: { kind: 'library-playlist', name: t('library.favoriteSongs'), onPlay: () => play(false), onShuffle: () => play(true), getTracks: () => songs },
    });
  }

  function folderCard(dir) {
    const counts = library.folderCounts(dir.id);
    return card({
      href: `/library/playlist-folder/${dir.id}`, art: folderCover('lib-cover'), title: folderName(dir),
      sub: t('library.folderCount', { n: counts.playlists }),
      target: {
        kind: 'library-folder', name: folderName(dir), moveEntry: { type: 'folder', id: dir.id },
        extraItems: [
          { icon: LIB_ICON.edit, label: t('library.renameFolderEllipsis'), onSelect: () => renameFolder(dir.id) },
          { icon: LIB_ICON.export, label: t('library.exportFolder'), onSelect: () => exportFolder(dir.id) },
          { icon: LIB_ICON.remove, label: t('library.deleteFolderEllipsis'), danger: true, onSelect: () => deleteFolder(dir.id, { toast }) },
        ],
      },
    });
  }

  /** 文件夹页：子文件夹在前，然后是其中的歌单（按名称） */
  function renderFolder() {
    if (!library.folder(folderId)) {
      return el('div', { className: 'lib-empty' },
        el('span', { className: 'lib-empty-icon', innerHTML: LIB_ICON.folder }),
        el('p', { className: 'lib-empty-title', textContent: t('library.folderNotFound') }),
        el('p', { className: 'lib-empty-hint', textContent: t('library.folderNotFoundHint') }));
    }
    const children = library.folderChildren(folderId);
    const nodes = [
      ...children.folders.filter((dir) => matches(dir.name)).map(folderCard),
      ...children.playlists.filter((list) => matches(list.name, list.description)).map(localPlaylistCard),
      ...children.catalog.filter((item) => matches(item.name, item.curator)).map(catalogPlaylistCard),
    ];
    return nodes.length ? grid(nodes) : empty('playlist-folder');
  }

  /* ---------- 各分类 ---------- */
  function renderRecent() {
    const entries = [
      ...libraryAlbums().map((album) => ({ at: album.addedAt, text: [album.name, album.artist], node: () => albumCard(album) })),
      ...library.libraryItems('music-video').filter((track) => !track.albumId)
        .map((track) => ({ at: track.addedAt, text: [track.name, track.artist], node: () => mvCard(track) })),
      ...library.libraryItems('playlist').map((item) => ({ at: item.addedAt, text: [item.name, item.curator], node: () => catalogPlaylistCard(item) })),
      ...library.playlists().map((list) => ({ at: list.createdAt, text: [list.name], node: () => localPlaylistCard(list) })),
    ].filter((entry) => matches(...entry.text)).sort((a, b) => b.at - a.at);
    return entries.length ? grid(entries.map((entry) => entry.node())) : empty('recently-added');
  }

  function renderAlbums() {
    const albums = sortBy(libraryAlbums().filter((album) => favorite(album) && matches(album.name, album.artist)), sort);
    return albums.length ? grid(albums.map(albumCard)) : empty('albums');
  }

  function renderMvs() {
    const mvs = sortBy(library.libraryItems('music-video').filter((track) => favorite(track) && matches(track.name, track.artist)), sort);
    return mvs.length ? grid(mvs.map(mvCard), 'mv') : empty('music-videos');
  }

  function renderPlaylists() {
    const all = [
      ...library.playlists().map((list) => ({ name: playlistName(list), addedAt: list.createdAt, favorite: list.favorite, node: () => localPlaylistCard(list), text: [list.name, list.description] })),
      ...library.libraryItems('playlist').map((item) => ({ name: item.name, addedAt: item.addedAt, favorite: item.favorite, node: () => catalogPlaylistCard(item), text: [item.name, item.curator] })),
    ].filter((entry) => favorite(entry) && matches(...entry.text));
    // 「喜爱的歌曲」固定在最前（与 Apple Music 相同），筛选时按名称匹配
    const pinned = !favoritesOnly && matches(t('library.favoriteSongs')) ? [favoriteSongsCard()] : [];
    return all.length || pinned.length ? grid([...pinned, ...sortBy(all, sort).map((entry) => entry.node())]) : empty('all-playlists');
  }

  /** 歌曲列表：分批渲染，滚动到底部时接着渲染下一批 */
  function songList(songs) {
    const list = el('section', { className: 'tracklist lib-tracklist' });
    let next = 0;
    const sentinel = el('div', { className: 'lib-sentinel' });
    const more = () => {
      const batch = songs.slice(next, next + CHUNK).map((track, i) => {
        const index = next + i;
        const built = trackRow(track, { actions, onPlay: () => playSong(songs, index) });
        rows.push(built);
        return built.row;
      });
      next += batch.length;
      sentinel.before(...batch);
      syncTrackRows(rows, player);
      if (next >= songs.length) { observer.disconnect(); sentinel.remove(); }
    };
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); }, { rootMargin: '800px' });
    signal.addEventListener('abort', () => observer.disconnect(), { once: true });
    list.append(sentinel);
    more();
    if (next < songs.length) observer.observe(sentinel);
    return list;
  }

  function renderSongs() {
    visibleSongs = sortBy(library.libraryItems('song').filter((track) => favorite(track) && matches(track.name, track.artist, track.album)), sort);
    $('play-row').hidden = !visibleSongs.length;
    if (!visibleSongs.length) return empty('songs');
    const minutes = Math.round(visibleSongs.reduce((sum, track) => sum + (track.duration || 0), 0) / 60000);
    const length = minutes >= 60 ? t('album.hours', { h: Math.floor(minutes / 60), m: minutes % 60 }) : t('album.minutes', { n: minutes });
    return el('div', {}, songList(visibleSongs),
      el('div', { className: 'album-footer' }, el('p', { textContent: [t('album.songs', { n: visibleSongs.length }), length].join(AmI18n.lang === 'zh' ? '，' : ', ') })));
  }

  /** 艺人：宽屏左侧为列表、右侧为选中艺人；手机上先列表，点进后为该艺人（地址带名称，可以返回） */
  function renderArtists() {
    const c = collator();
    const artists = libraryArtists(libraryAlbums()).sort((a, b) => c.compare(a.name, b.name));
    const shown = artists.filter((artist) => favorite(artist) && matches(artist.name));
    if (!shown.length) return empty('artists');
    const selected = artists.find((artist) => artist.name === artistName) || (matchMedia('(max-width: 760px)').matches ? null : shown[0]);
    const list = el('nav', { className: 'lib-artist-list' }, ...shown.map((artist) => {
      const link = el('a', { className: 'lib-artist-link', href: `/library/artists/${encodeURIComponent(artist.name)}` },
        el('span', { className: 'lib-artist-avatar' }, img(artist.artwork, 80)), el('span', { className: 'lib-artist-name', textContent: artist.name }));
      if (selected && artist.name === selected.name) link.setAttribute('aria-current', 'true');
      link.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        // 宽屏只换右侧内容（地址同步更新，不新增历史记录）；手机上进入该艺人
        if (matchMedia('(max-width: 760px)').matches) { navigate(link.getAttribute('href')); return; }
        artistName = artist.name;
        history.replaceState(history.state, '', link.getAttribute('href'));
        render();
      });
      return link;
    }));
    const wrap = el('div', { className: `lib-artists${artistName && selected ? ' has-selection' : ''}` }, list);
    if (selected) {
      const albums = sortBy(selected.albums, 'title');
      const songs = sortBy(selected.songs, 'album');
      const name = selected.href ? el('a', { href: selected.href, textContent: selected.name, title: t('library.goArtist') }) : selected.name;
      visibleSongs = songs;
      // 喜爱艺人（与艺人页的 ☆ 相同）：需要艺人页链接里的 id
      // 资料库变化时整页重绘，按钮状态在这里取一次即可
      let star = null;
      if (selected.id) {
        const on = library.isFavorite('artist', selected.id);
        star = el('button', { className: 'detail-circle-btn lib-fav-toggle', type: 'button', innerHTML: on ? LIB_ICON.starFilled : LIB_ICON.star, title: t(on ? 'library.unfavorite' : 'library.favorite') });
        star.setAttribute('aria-pressed', String(on));
        star.setAttribute('aria-label', star.title);
        star.addEventListener('click', () => actions.toggleFavorite({
          kind: 'artist', href: selected.href, apple: library.appleUrl(selected.href), name: selected.name, country: selected.country, artwork: selected.artwork,
        }, star));
      }
      wrap.append(el('section', { className: 'lib-artist-detail' },
        el('div', { className: 'lib-artist-head' }, el('h2', { className: 'lib-artist-title' }, name), star),
        albums.length ? el('h3', { className: 'lib-subhead', textContent: t('library.albums') }) : null,
        albums.length ? grid(albums.map(albumCard), 'compact') : null,
        songs.length ? el('h3', { className: 'lib-subhead', textContent: t('library.songs') }) : null,
        songs.length ? songList(songs) : null));
    }
    return wrap;
  }

  /* ---------- 播放 ---------- */
  function playSong(songs, index) {
    const track = songs[index];
    if (player.current && player.current.track === track.id) { player.toggle(); return; }
    player.playQueue(songs.map(library.entryOf), index);
  }

  function playSongs(pos, shuffle) {
    if (visibleSongs.length) player.playQueue(visibleSongs.map(library.entryOf), pos, { shuffle });
  }

  player.onChange(() => syncTrackRows(rows, player));

  /* ---------- 渲染 ---------- */
  function render() {
    renderHead();
    if (!loaded) return;
    rows = [];
    if (section !== 'songs') $('play-row').hidden = true;
    const content = {
      'recently-added': renderRecent, artists: renderArtists, albums: renderAlbums,
      songs: renderSongs, 'music-videos': renderMvs, 'all-playlists': renderPlaylists, 'playlist-folder': renderFolder,
    }[section]();
    $('content').replaceChildren(content);
  }

  signal.addEventListener('abort', library.onChange(render), { once: true });
  onLangChange(render);
  renderHead();
  library.ready.then(() => {
    if (signal.aborted) return;
    loaded = true;
    render();
  });
}

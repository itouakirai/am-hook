// 各页面共用的条目操作（与 music.apple.com 相同）：封面悬停时的「播放」「更多」按钮、曲目行的「更多」菜单，
// 菜单项有播放、打开、复制本站链接与 Apple Music 链接。整张专辑 / 歌单的播放在这里取曲目后交给播放器队列。
//
// 菜单里还有资料库操作（与 music.apple.com 相同）：添加到资料库 / 从资料库中删除、添加到歌单（子菜单），见 library.mjs。
//
// 条目 target：{ kind, href, apple, name, country, resource?, albumHref?, onPlay?, track?, collection?, getTracks?, extraItems? }
//   kind：song / music-video / album / playlist / artist / library-playlist（本地歌单）；href：本站页面路径（/https://music.apple.com/...）；
//   apple：Apple Music 原始地址；resource：amp-api 资源（歌曲单独播放时用来生成队列条目）；
//   albumHref：曲目所属专辑的本站路径（菜单里的「前往专辑」）；onPlay：页面自己的播放方式（如按专辑顺序播放）；
//   track：资料库中的曲目快照（没有 resource 时用它加入资料库、歌单）；collection：页面已取到的专辑 / 歌单 { resource, tracks }，
//   加入资料库或歌单时不再重新请求；getTracks()：要加入歌单的曲目快照（本地歌单用）；playlistId：「添加到歌单」里不列出的歌单；
//   extraItems：页面自己的菜单项（如「从歌单中删除」）；noPlay：菜单里不列出「播放」（正在播放的歌曲）
import * as library from '/assets/library.mjs';
import { LIB_ICON, playlistMenuItems, moveMenuItems } from './library-ui.mjs';
import { downloads } from '../download/downloads.mjs';

const { AmI18n } = window;
const { t } = AmI18n;

export const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h3c2.2 0 3.4 1 4.5 2.8l3 4.4C14.6 16 15.8 17 18 17h2.5"/><path d="M3 17h3c1.6 0 2.7-.6 3.6-1.6M14.4 8.6C15.3 7.6 16.4 7 18 7h2.5"/><path d="m18 4 3 3-3 3M18 14l3 3-3 3"/></svg>',
  quality: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z" fill="currentColor"/></svg>',
  album: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/></svg>',
  apple: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>',
  // 检测 ALAC（alac-check-dialog.mjs）：波形
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l3-7 4.5 14L17 9l1.5 3H22"/></svg>',
};

/**
 * 打开「检测 ALAC」对话框（只在需要时加载）。options 见 openAlacCheckDialog；
 * 页面已有专辑 / 歌单资源时由页面传入，「更多」菜单只检测一首（见 checkSong）
 */
export async function openAlacCheck(options) {
  const { openAlacCheckDialog } = await import('./alac-check-dialog.mjs');
  return openAlacCheckDialog(options);
}

/** 「更多」菜单里的检测 ALAC：歌曲条目的 amp-api 资源，资料库里的曲目只有快照时拼出所需的字段 */
function checkSong(target, toast) {
  const r = target.resource;
  const s = target.track || {};
  const track = r && r.attributes ? r : {
    id: s.id, type: 'songs',
    // url 只用来取所属专辑的 ID（album/<slug>/<id>）
    attributes: { name: s.name || target.name, artistName: s.artist || '', artwork: s.artwork ? { url: s.artwork } : null, url: s.albumHref || '', playParams: {} },
  };
  return openAlacCheck({ kind: 'song', id: track.id, country: target.country, resource: track, tracks: [track], toast }).catch((err) => toast(err.message));
}

/** 详情页头部「更多」菜单（createActions 的 headerMenu）的条目顺序，组间加分隔线；各页面只列出自己有的条目 */
const HEADER_MENU = [
  ['download', 'favorite', 'library', 'addToPlaylist', 'about', 'edit', 'moveToFolder', 'duplicate', 'saveAsPlaylist', 'export'],
  ['copySite', 'copyApple'],
];

/** 「更多」菜单里的下载（downloads.mjs，使用设置中心的下载设置）：歌曲、MV、专辑与 Apple Music 歌单；不能下载时为 null */
function downloadSpec(target) {
  const r = target.resource;
  if (target.kind === 'song') {
    const id = (r && r.id) || (target.track && target.track.id);
    if (!id || (r && !playable(r))) return null;
    return { kind: 'song', id, country: target.country, tracks: r && r.attributes ? [r] : null };
  }
  if (target.kind === 'music-video' && r && r.id && playable(r)) return { kind: 'music-video', id: r.id, country: target.country };
  if ((target.kind === 'album' || target.kind === 'playlist') && r && r.id) {
    const c = target.collection;
    return { kind: target.kind, id: r.id, country: target.country, resource: c ? c.resource : null, tracks: c ? c.tracks : null };
  }
  return null;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

/* ---------- amp-api 与资源 ---------- */
async function amp(path, params) {
  const url = new URL('/amp' + path, location.origin);
  for (const [key, value] of Object.entries(params || {})) if (value !== undefined) url.searchParams.set(key, value);
  let res = await fetch(url);
  if (res.status === 400 && url.searchParams.has('l')) {
    url.searchParams.delete('l');
    res = await fetch(url);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error((data && ((data.errors && data.errors[0] && data.errors[0].detail) || data.msg)) || `HTTP ${res.status}`);
  return data;
}

function artUrl(artwork, w) {
  return artwork && artwork.url ? artwork.url.replace('{w}', w).replace('{h}', w).replace('{c}', 'bb').replace('{f}', 'jpg') : '';
}

const KINDS = { songs: 'song', 'music-videos': 'music-video', albums: 'album', playlists: 'playlist', artists: 'artist' };

/** 目录资源 → 本站页面路径；歌曲的 url 是 album/...?i=<id>，统一转成歌曲页 */
export function pagePath(resource, country) {
  const url = (resource.attributes && resource.attributes.url) || '';
  if (resource.type === 'playlists') {
    const m = url.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/playlist\/([^/?#]+)\/(pl\.[\w-]+)/i);
    return m ? `/https://music.apple.com/${m[1].toLowerCase()}/playlist/${m[2]}/${m[3]}` : `/https://music.apple.com/${country}/playlist/_/${resource.id}`;
  }
  const kind = KINDS[resource.type];
  const m = url.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/(song|music-video|album|artist)\/([^/?#]+)\/(\d+)/i);
  if (m && m[2] === kind) return `/https://music.apple.com/${m[1].toLowerCase()}/${kind}/${m[3]}/${m[4]}`;
  const slug = url.match(/\/album\/([^/?#]+)\//);
  return `/https://music.apple.com/${country}/${kind}/${slug ? slug[1] : '_'}/${resource.id}`;
}

/** 本站能打开的 Apple Music 页面（与 app.mjs 的路由相同），艺人与策展人链接用 */
const LOCAL_LINK = /^https:\/\/music\.apple\.com\/[a-z]{2}\/(?:(?:song|music-video)\/[^/?#]+\/\d+|post\/(?:[^/?#]+\/)?\d+|(?:album|artist|curator)\/(?:[^/?#]+\/)?\d+|playlist\/(?:[^/?#]+\/)?pl\.[\w-]+|(?:room|multi-room|grouping)\/\d+|station\/(?:[^/?#]+\/)?ra\.[\w.-]+)$/i;

/** Apple Music 地址 → 本站页面路径；本站打不开时为 '' */
export function localPath(url) {
  const m = String(url || '').match(/^https:\/\/music\.apple\.com\/([a-z]{2})(\/[^?#]*)/i);
  if (!m) return '';
  const clean = `https://music.apple.com/${m[1].toLowerCase()}${m[2].replace(/\/$/, '')}`;
  return LOCAL_LINK.test(clean) ? '/' + clean : '';
}

/**
 * 艺人行：在 artistName 中依次找到各关联艺人的名字并链接到艺人页，分隔符（&、逗号、feat. 等）保留为文字；
 * 没有关联艺人时整行链接到 artistUrl（专辑等）
 */
export function artistLinks(resource, country) {
  const a = resource.attributes || {};
  const name = a.artistName || '';
  const artists = ((resource.relationships && resource.relationships.artists && resource.relationships.artists.data) || [])
    .filter((artist) => artist.attributes && artist.attributes.name);
  const parts = [];
  let pos = 0;
  for (const artist of artists) {
    const i = name.indexOf(artist.attributes.name, pos);
    if (i < 0) continue;
    if (i > pos) parts.push(name.slice(pos, i));
    parts.push(el('a', { href: pagePath(artist, country), textContent: artist.attributes.name }));
    pos = i + artist.attributes.name.length;
  }
  if (!parts.length && name && localPath(a.artistUrl)) return [el('a', { href: localPath(a.artistUrl), textContent: name })];
  if (pos < name.length) parts.push(name.slice(pos));
  return parts;
}

/** 能否播放：尚未发行的曲目（如歌单里的预告曲目）只有名称、封面等少数字段，没有 playParams，目录中也查不到 */
export function playable(resource) {
  return !!(resource.attributes && resource.attributes.playParams);
}

/** 曲目所属专辑的本站路径：关联专辑，没有时取曲目 url 里的 album/<slug>/<id> */
export function albumPathOf(track) {
  const album = track.relationships && track.relationships.albums && track.relationships.albums.data && track.relationships.albums.data[0];
  if (album && album.attributes) return pagePath(album, 'us');
  const m = ((track.attributes && track.attributes.url) || '').match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/album\/([^/?#]+)\/(\d+)/i);
  return m ? `/https://music.apple.com/${m[1].toLowerCase()}/album/${m[2]}/${m[3]}` : '';
}

/** 资源 → 条目；extra 覆盖默认值（如 albumHref、onPlay） */
export function targetOf(resource, country, extra = {}) {
  const href = pagePath(resource, country);
  const a = resource.attributes || {};
  return { kind: KINDS[resource.type], href, apple: a.url || href.slice(1), name: a.name || '', country, resource, ...extra };
}

/** 歌曲资源 → 播放队列条目（见 AmPlayer.playQueue）；context 为专辑 / 歌单时补上专辑名与封面 */
export function songEntry(track, country, context = {}) {
  const a = track.attributes;
  return {
    track: track.id,
    country,
    name: a.name,
    artist: a.artistName,
    artists: ((track.relationships && track.relationships.artists && track.relationships.artists.data) || [])
      .filter((artist) => artist.attributes && artist.attributes.name)
      .map((artist) => ({ name: artist.attributes.name, href: pagePath(artist, country) })),
    album: a.albumName || context.album || '',
    href: pagePath(track, country),
    albumHref: context.albumHref || (a.albumName ? albumPathOf(track) : ''),
    artwork: artUrl(a.artwork || context.artwork, 600),
    duration: a.durationInMillis || 0,
  };
}

/**
 * 正在播放的歌曲（AmPlayer 的 current）→ 条目，歌词界面标题旁的喜爱与「更多」用；没有歌曲时为 null。
 * 先用播放队列里的信息拼出曲目快照（封面地址还原为 {w}x{h} 模板），之后可用 songTarget() 换成完整资源
 */
export function nowPlayingTarget(current) {
  if (!current || !current.track) return null;
  const href = current.href || '';
  const albumHref = current.albumHref || '';
  return {
    kind: 'song', href, apple: href.slice(1), name: current.title || '', country: current.country, albumHref, noPlay: true,
    track: {
      kind: 'song', id: current.track, country: current.country, name: current.title || '', artist: current.artist || '',
      artists: current.artists || [], album: current.album || '', albumId: (albumHref.match(/\/(\d+)$/) || [])[1] || '', albumHref, href,
      artwork: (current.artwork || '').replace(/\/\d+x\d+(\w*)\.(jpg|png|webp)$/, '/{w}x{h}$1.$2'), bgColor: '', duration: 0, explicit: false,
    },
  };
}

/** 歌曲 id → 条目（含 amp-api 资源，曲目快照因此有时长、分级等完整信息）；名称按曲库语言返回 */
export async function songTarget(id, country) {
  const l = await Promise.resolve(AmI18n.catalogLang(country)).catch(() => undefined);
  const data = await amp(`/v1/catalog/${country}/songs/${id}`, { include: 'albums,artists', l });
  const song = data.data && data.data[0];
  if (!song || !song.attributes) throw new Error('not found');
  return targetOf(song, country, { albumHref: albumPathOf(song), noPlay: true });
}

/** 歌曲 / MV 资源 → 资料库曲目快照（见 library.mjs）；album 为所属专辑资源（专辑页的曲目没有专辑字段时补上） */
export function snapshotOf(track, country, album) {
  const a = track.attributes || {};
  const albumHref = album ? pagePath(album, country) : albumPathOf(track);
  const artwork = a.artwork || (album && album.attributes && album.attributes.artwork) || {};
  return {
    kind: KINDS[track.type],
    id: track.id,
    country,
    name: a.name || '',
    artist: a.artistName || '',
    artists: ((track.relationships && track.relationships.artists && track.relationships.artists.data) || [])
      .filter((artist) => artist.attributes && artist.attributes.name)
      .map((artist) => ({ name: artist.attributes.name, href: pagePath(artist, country) })),
    album: a.albumName || (album && album.attributes && album.attributes.name) || '',
    albumId: (albumHref.match(/\/(\d+)$/) || [])[1] || '',
    albumHref,
    href: pagePath(track, country),
    artwork: artwork.url || '',
    bgColor: artwork.bgColor || '',
    duration: a.durationInMillis || 0,
    explicit: a.contentRating === 'explicit',
  };
}

/** 专辑 / 歌单资源 → 资料库条目 */
function collectionRecord(res, country) {
  const a = res.attributes || {};
  const href = pagePath(res, country);
  if (res.type === 'playlists') {
    const artwork = (a.editorialArtwork && a.editorialArtwork.staticDetailSquare) || a.artwork || {};
    return { kind: 'playlist', id: res.id, country, name: a.name, curator: a.curatorName || '', href, artwork: artwork.url || '', bgColor: artwork.bgColor || '' };
  }
  const artist = ((res.relationships && res.relationships.artists && res.relationships.artists.data) || [])[0];
  return {
    kind: 'album', id: res.id, country, name: a.name, artist: a.artistName || '',
    artistHref: artist && artist.attributes ? pagePath(artist, country) : '', href,
    artwork: (a.artwork && a.artwork.url) || '', bgColor: (a.artwork && a.artwork.bgColor) || '',
    releaseDate: a.releaseDate || '', trackCount: a.trackCount || 0,
  };
}

/** 专辑 / 歌单的资源与全部曲目（分页取完）：{ country, resource, tracks }；页面已取到时（target.collection）直接使用 */
async function fetchCollection(target) {
  const m = target.href.match(/^\/https:\/\/music\.apple\.com\/([a-z]{2})\/(album|playlist)\/(?:[^/?#]+\/)?([^/?#]+)/i);
  if (!m) return null;
  const country = m[1].toLowerCase();
  if (target.collection && target.collection.resource) return { country, ...target.collection };
  const playlist = m[2] === 'playlist';
  const l = await AmI18n.catalogLang(country);
  const trackParams = { l, 'include[songs]': 'artists', 'include[music-videos]': 'artists', 'fields[artists]': 'name,url' };
  const data = await amp(`/v1/catalog/${country}/${playlist ? 'playlists' : 'albums'}/${m[3]}`, {
    platform: 'web', include: playlist ? 'tracks' : 'tracks,artists', ...(playlist ? { 'limit[tracks]': '300' } : {}), ...trackParams,
  });
  const res = data.data && data.data[0];
  if (!res) return null;
  const rel = res.relationships && res.relationships.tracks;
  let list = (rel && rel.data) || [];
  for (let more = rel && rel.next, pages = 0; more && pages < 20; pages++) {
    const page = await amp(more, trackParams);
    list = list.concat(page.data || []);
    more = page.next;
  }
  return { country, resource: res, tracks: list };
}

/** 专辑 / 歌单的全部歌曲，MV 与无法播放的曲目跳过 */
async function collectionEntries(target) {
  const c = await fetchCollection(target);
  if (!c) return [];
  const res = c.resource;
  const a = res.attributes || {};
  const context = res.type === 'playlists'
    ? { album: a.name, artwork: (a.editorialArtwork && a.editorialArtwork.staticDetailSquare) || a.artwork }
    : { album: a.name, albumHref: pagePath(res, c.country), artwork: a.artwork };
  return c.tracks.filter((track) => track.type === 'songs' && playable(track)).map((track) => songEntry(track, c.country, context));
}

/** 专辑 / 歌单中可以加入资料库、歌单的曲目快照（歌曲与 MV，尚未发行的跳过） */
function collectionSnapshots(c) {
  const album = c.resource.type === 'albums' ? c.resource : null;
  return c.tracks.filter((track) => (track.type === 'songs' || track.type === 'music-videos') && playable(track))
    .map((track) => snapshotOf(track, c.country, album));
}

/** 条目在资料库中的 kind 与 id；不能加入资料库的条目为 null */
function libraryKey(target) {
  if (!['song', 'music-video', 'album', 'playlist'].includes(target.kind)) return null;
  if (target.track) return { kind: target.track.kind, id: target.track.id };
  if (target.resource) return { kind: target.kind, id: target.resource.id };
  const m = (target.href || '').match(target.kind === 'playlist' ? /\/(pl\.[\w-]+)$/ : /\/(\d+)$/);
  return m ? { kind: target.kind, id: m[1] } : null;
}

/**
 * 喜爱用的键：本地歌单为 { local: true, id }，艺人为 { kind: 'artist', id }，其余与 libraryKey 相同；不能喜爱时为 null
 */
function favoriteKey(target) {
  if (target.kind === 'library-playlist') return target.playlistId ? { local: true, id: target.playlistId } : null;
  if (target.kind === 'artist') {
    const id = target.resource ? target.resource.id : ((target.href || '').match(/\/(\d+)$/) || [])[1];
    return id ? { kind: 'artist', id } : null;
  }
  return libraryKey(target);
}

/** 加入资料库的条目：歌曲 / MV 为自身；专辑连同全部曲目（与 Apple Music 相同）；Apple Music 歌单只有歌单本身；艺人为艺人条目 */
async function libraryRecords(target) {
  if (target.kind === 'song' || target.kind === 'music-video') {
    const track = target.track || (target.resource && snapshotOf(target.resource, target.country));
    if (!track) throw new Error('no metadata');
    return [track];
  }
  if (target.kind === 'artist') {
    const key = favoriteKey(target);
    const a = (target.resource && target.resource.attributes) || {};
    return [{ kind: 'artist', id: key.id, country: target.country, name: a.name || target.name, href: target.href, artwork: (a.artwork && a.artwork.url) || target.artwork || '' }];
  }
  const c = await fetchCollection(target);
  if (!c) throw new Error('not found');
  const records = [collectionRecord(c.resource, c.country)];
  if (target.kind === 'album') records.push(...collectionSnapshots(c));
  return records;
}

/** 加入资料库，返回新增数量 */
async function addTargetToLibrary(target) {
  return library.addToLibrary(await libraryRecords(target));
}

/** 要加入歌单的曲目快照 */
async function targetTracks(target) {
  if (target.getTracks) return target.getTracks();
  if (target.kind === 'song' || target.kind === 'music-video') {
    const track = target.track || (target.resource && snapshotOf(target.resource, target.country));
    return track ? [track] : [];
  }
  const c = await fetchCollection(target);
  return c ? collectionSnapshots(c) : [];
}

/* ---------- 复制 ---------- */
export function copyText(text, done) {
  const fallback = () => {
    const area = el('textarea', { value: text });
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    done();
  };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}

/* ---------- 弹出菜单：整站一个，fixed 定位，避免被列表 overflow 裁剪 ---------- */
const menu = { el: null, scrim: null, trigger: null, player: null };
/** 与官网 amp-contextual-menu 相同，xsmall（< 484px）时菜单 270px 宽、居中贴底，背后有遮罩 */
const SHEET = matchMedia('(max-width: 483px)');

function menuEl() {
  if (menu.el) return menu.el;
  menu.el = el('div', { className: 'menu', role: 'menu', hidden: true });
  // 手机上菜单背后的遮罩（与官网 contextual-menu-scrim 相同）；点按遮罩关闭菜单，这次点按不会落到下面的页面上
  menu.scrim = el('div', { className: 'menu-scrim', hidden: true });
  menu.scrim.addEventListener('click', () => closeMenu(false));
  document.body.append(menu.scrim, menu.el);
  menu.el.addEventListener('keydown', (e) => {
    const items = [...menu.el.querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(false);
  });
  document.addEventListener('pointerdown', (e) => {
    if (menu.trigger && e.target !== menu.scrim && !menu.el.contains(e.target) && !menu.trigger.contains(e.target)) closeMenu(false);
  });
  addEventListener('resize', () => closeMenu(false));
  addEventListener('scroll', (e) => {
    if (!menu.trigger || menu.el.contains(e.target)) return;
    if (SHEET.matches) positionMenu();
    else closeMenu(false);
  }, { capture: true });
  return menu.el;
}

function closeMenu(focusTrigger) {
  if (!menu.trigger) return;
  menu.el.hidden = true;
  menu.scrim.hidden = true;
  menu.trigger.setAttribute('aria-expanded', 'false');
  menu.trigger.closest('.card-wrap, .row-wrap')?.classList.remove('menu-open');
  if (focusTrigger) menu.trigger.focus();
  menu.trigger = null;
}

/**
 * items：'-' 分隔线，或 { icon, label, hint?, title?, onSelect }；hint 为第二行小字，title 为悬停提示（如完整链接）；
 * 带 submenu()（返回子菜单项）的项点击后在原位置换成子菜单，第一项「‹ 名称」返回上一级（如「添加到歌单」）
 */
export function openMenu(trigger, items) {
  const box = menuEl();
  const reopen = menu.trigger === trigger;
  closeMenu(false);
  if (reopen) return;
  box.hidden = false;
  menu.scrim.hidden = false;
  menu.trigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  // 菜单打开期间封面上的按钮保持显示
  trigger.closest('.card-wrap, .row-wrap')?.classList.add('menu-open');
  fillMenu(items);
}

function fillMenu(items) {
  const box = menu.el;
  box.replaceChildren(...items.map((it) => {
    if (it === '-') return el('div', { className: 'menu-sep', role: 'separator' });
    const node = el('button', { className: `menu-item${it.back ? ' menu-back' : ''}${it.danger ? ' danger' : ''}`, type: 'button', innerHTML: it.icon, tabIndex: -1 });
    node.setAttribute('role', 'menuitem');
    if (it.submenu) node.setAttribute('aria-haspopup', 'menu');
    node.append(el('span', { className: 'menu-text' }, el('span', { className: 'menu-label', textContent: it.label }),
      it.hint ? el('span', { className: 'menu-hint', textContent: it.hint }) : null));
    if (it.title) node.title = it.title;
    node.addEventListener('click', () => {
      if (it.submenu) {
        fillMenu([{ icon: LIB_ICON.back, label: it.label, back: true, onSelect: () => fillMenu(items) }, '-', ...it.submenu()]);
        return;
      }
      if (it.back) { it.onSelect(); return; }
      closeMenu(false);
      it.onSelect();
    });
    return node;
  }));
  // 换成子菜单后高度变了，重新定位
  box.style.maxHeight = '';
  positionMenu();
  box.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
}

/** 手机上居中贴底（距底 25px，最高为视口高度减去上下各 25px）；否则右对齐触发按钮，朝空间大的一侧展开 */
function positionMenu() {
  const box = menu.el;
  if (SHEET.matches) {
    const viewport = window.visualViewport;
    const top = viewport ? viewport.offsetTop : 0;
    const height = viewport ? viewport.height : innerHeight;
    const width = viewport ? viewport.width : innerWidth;
    box.style.maxHeight = `${Math.max(80, height - 50)}px`;
    box.style.left = `${(viewport ? viewport.offsetLeft : 0) + (width - box.getBoundingClientRect().width) / 2}px`;
    box.style.top = `${top + height - box.getBoundingClientRect().height - 25}px`;
    return;
  }
  const r = menu.trigger.getBoundingClientRect();
  box.style.maxHeight = '';
  const m = box.getBoundingClientRect();
  const bottom = Math.min(innerHeight, menu.player ? menu.player.barTop() : innerHeight) - 8;
  const below = bottom - r.bottom - 6;
  const above = r.top - 6 - 8;
  const down = below >= m.height || below >= above;
  const height = Math.min(m.height, down ? below : above);
  if (height < m.height) box.style.maxHeight = `${height}px`;
  box.style.top = `${Math.max(8, down ? r.bottom + 6 : r.top - 6 - height)}px`;
  box.style.left = `${Math.min(Math.max(8, r.right - m.width), innerWidth - m.width - 8)}px`;
}

/**
 * 页面挂载时调用：ctx 为 mount 的 { signal, player, navigate, toast }。
 * 返回 moreButton（曲目行末尾的「更多」）、coverActions / wrapCard（封面悬停按钮）、wrapRow（搜索结果行加播放与更多）。
 */
export function createActions({ signal, player, navigate, toast }) {
  menu.player = player;
  signal.addEventListener('abort', () => closeMenu(false), { once: true });

  const playable = (target) => ['song', 'album', 'playlist', 'music-video', 'library-playlist'].includes(target.kind)
    && (target.kind !== 'song' || target.onPlay || target.resource || target.track)
    && (target.kind !== 'library-playlist' || !!target.onPlay);

  async function play(target, button, shuffle = false) {
    if (target.kind === 'music-video') { navigate(target.href); return; }
    if (target.onPlay) { target.onPlay(); return; }
    if (target.kind === 'song') { player.playQueue([target.resource ? songEntry(target.resource, target.country) : library.entryOf(target.track)], 0); return; }
    if (button) button.classList.add('busy');
    try {
      // 离开页面后取回的曲目照样播放：播放条常驻
      const entries = await collectionEntries(target);
      if (!entries.length) { toast(t('action.noSongs', { name: target.name })); return; }
      player.playQueue(entries, shuffle ? Math.floor(Math.random() * entries.length) : 0, { shuffle });
    } catch (err) {
      toast(t('action.failed', { msg: err.message }));
    } finally {
      if (button) button.classList.remove('busy');
    }
  }

  function copy(url) {
    copyText(url, () => toast(t('action.copied')));
  }

  /** 加入 / 移出资料库；busy 为请求曲目期间显示忙碌的按钮 */
  async function toggleLibrary(target, busy) {
    const key = libraryKey(target);
    if (!key) return;
    if (library.inLibrary(key.kind, key.id)) {
      library.removeFromLibrary(key.kind, key.id);
      toast(t('library.removedFrom', { name: target.name }));
      return;
    }
    if (busy) busy.classList.add('busy');
    try {
      await addTargetToLibrary(target);
      toast(t('library.addedToLibrary', { name: target.name }));
    } catch (err) {
      toast(t('library.failed', { msg: err.message }));
    } finally {
      if (busy) busy.classList.remove('busy');
    }
  }

  const favoriteOf = (key) => !!key && (key.local ? !!(library.playlist(key.id) || {}).favorite : library.isFavorite(key.kind, key.id));

  /** 喜爱 / 取消喜爱（与 Apple Music 相同，喜爱时同时加入资料库）；busy 为请求曲目期间显示忙碌的按钮 */
  async function toggleFavorite(target, busy) {
    const key = favoriteKey(target);
    if (!key) return;
    const on = !favoriteOf(key);
    if (key.local) {
      library.setPlaylistFavorite(key.id, on);
    } else {
      if (busy) busy.classList.add('busy');
      try {
        // 已在资料库中时不必再取曲目
        const records = on && !library.libraryItem(key.kind, key.id) ? await libraryRecords(target) : [];
        library.setFavorite(key.kind, key.id, on, records);
      } catch (err) {
        toast(t('library.failed', { msg: err.message }));
        return;
      } finally {
        if (busy) busy.classList.remove('busy');
      }
    }
    toast(t(on ? 'library.favoritedName' : 'library.unfavoritedName', { name: target.name }));
  }

  /** 资料库菜单项（按键名）：favorite 喜爱 / 取消喜爱、library 添加到资料库 / 从资料库中删除、addToPlaylist 添加到歌单（子菜单）、moveToFolder 移到文件夹（子菜单） */
  function libraryEntries(target, button) {
    const entries = {};
    const fav = favoriteKey(target);
    if (fav) {
      const on = favoriteOf(fav);
      entries.favorite = { icon: on ? LIB_ICON.star : LIB_ICON.starFilled, label: t(on ? 'library.unfavorite' : 'library.favorite'), onSelect: () => toggleFavorite(target, button) };
    }
    const key = libraryKey(target);
    if (key) {
      const has = library.inLibrary(key.kind, key.id);
      entries.library = { icon: has ? LIB_ICON.remove : LIB_ICON.add, label: t(has ? 'library.remove' : 'library.add'), onSelect: () => toggleLibrary(target, button) };
    }
    if (key || target.getTracks) {
      entries.addToPlaylist = {
        icon: LIB_ICON.addToPlaylist, label: t('library.addToPlaylist'),
        submenu: () => playlistMenuItems(() => targetTracks(target), { toast, navigate, except: target.playlistId }),
      };
    }
    // 移到文件夹：本地歌单、文件夹（页面给出 moveEntry），以及已添加到资料库的 Apple Music 歌单
    const catalog = key && key.kind === 'playlist' && library.libraryItem('playlist', key.id);
    const entry = target.moveEntry || (catalog ? { type: 'catalog', id: key.id } : null);
    if (entry) {
      const current = entry.type === 'folder' ? (library.folder(entry.id) || {}).parentId
        : entry.type === 'playlist' ? (library.playlist(entry.id) || {}).folderId : catalog.folderId;
      entries.moveToFolder = { icon: LIB_ICON.move, label: t('library.moveToFolder'), submenu: () => moveMenuItems(entry, current || '', { toast }) };
    }
    return entries;
  }

  /** 复制本站链接与 Apple Music 链接（按键名）；本地歌单没有 Apple Music 链接 */
  function linkEntries(target) {
    if (!target.href || !target.apple) return {};
    const site = location.origin + target.href;
    return {
      copySite: { icon: ICON.link, label: t('action.copySite'), title: site, onSelect: () => copy(site) },
      copyApple: { icon: ICON.apple, label: t('action.copyApple'), title: target.apple, onSelect: () => copy(target.apple) },
    };
  }

  function menuItems(target, button) {
    const items = [];
    if (target.kind === 'music-video') items.push({ icon: ICON.video, label: t('action.playMv'), onSelect: () => navigate(target.href) });
    else if (playable(target) && !target.noPlay) items.push({ icon: ICON.play, label: t('action.play'), onSelect: () => play(target, button) });
    if (target.kind === 'album' || target.kind === 'playlist' || target.onShuffle) {
      items.push({ icon: ICON.shuffle, label: t('action.shuffle'), onSelect: () => (target.onShuffle ? target.onShuffle() : play(target, button, true)) });
    }
    if (target.kind === 'song') items.push({ icon: ICON.quality, label: t('album.quality'), onSelect: () => navigate(target.href) });
    const dl = downloadSpec(target);
    if (dl) {
      items.push({
        icon: ICON.download, label: t(`dlc.menu.${target.kind}`),
        onSelect: () => downloads.add(dl).then((job) => { if (job) toast(t('dlc.added', { name: target.name })); }, (err) => toast(err.message)),
      });
    }
    if (dl && target.kind === 'song') items.push({ icon: ICON.check, label: t('ac.button'), onSelect: () => checkSong(target, toast) });
    if (target.albumHref) items.push({ icon: ICON.album, label: t('action.goAlbum'), onSelect: () => navigate(target.albumHref) });
    const lib = Object.values(libraryEntries(target, button));
    if (lib.length) items.push(...(items.length ? ['-'] : []), ...lib);
    if (target.extraItems && target.extraItems.length) items.push(...(items.length ? ['-'] : []), ...target.extraItems);
    const links = Object.values(linkEntries(target));
    if (links.length) items.push(...(items.length ? ['-'] : []), ...links);
    return items;
  }

  /**
   * 详情页头部的「更多」按钮（专辑 / 歌单 / 艺人 / 本地歌单页的头部只留随机播放、播放与它）。
   * getMenu(button) 返回 { target?, entries?, tail? } 或 null：target 的资料库操作与复制链接自动加入；
   * entries 为页面自己的条目（键名见 HEADER_MENU，如 download / about），全部条目按 HEADER_MENU 的顺序分组排列；
   * tail 固定在最后（如删除歌单）。button 为页面里已有的按钮，没有时新建一个
   */
  function headerMenu(getMenu, button = null, className = 'detail-circle-btn') {
    if (!button) {
      button = el('button', { className, type: 'button', innerHTML: ICON.more });
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-expanded', 'false');
    }
    const label = () => { button.title = t('action.more'); button.setAttribute('aria-label', button.title); };
    label();
    signal.addEventListener('abort', AmI18n.onChange(label), { once: true });
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const m = getMenu(button);
      if (!m) return;
      const entries = { ...(m.target ? { ...libraryEntries(m.target, button), ...linkEntries(m.target) } : {}), ...m.entries };
      const items = [];
      for (const group of [...HEADER_MENU.map((keys) => keys.filter((key) => entries[key]).map((key) => entries[key])), m.tail || []]) {
        if (group.length) items.push(...(items.length ? ['-'] : []), ...group);
      }
      openMenu(button, items);
    });
    return button;
  }

  /** 「更多」按钮；target 也可以是返回当前条目的函数（如歌词界面里正在播放的歌曲），返回 null 时不弹出菜单 */
  function moreButton(target, className = 'track-more') {
    const button = el('button', { className, type: 'button', innerHTML: ICON.more, title: t('action.more') });
    button.setAttribute('aria-label', typeof target === 'function' ? t('action.more') : t('action.moreFor', { name: target.name }));
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const current = typeof target === 'function' ? target() : target;
      if (current) openMenu(button, menuItems(current, button));
    });
    return button;
  }

  function playButton(target, className) {
    const button = el('button', { className, type: 'button', innerHTML: ICON.play });
    button.setAttribute('aria-label', t('album.playTrack', { name: target.name }));
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      play(target, button);
    });
    return button;
  }

  /** 叠在封面上的按钮：左下「播放」、右下「更多」；艺人只有「更多」。放在 .card-wrap 里，悬停时显示 */
  function coverActions(target) {
    const actions = el('div', { className: 'cover-actions' });
    if (playable(target)) actions.append(playButton(target, 'cover-btn cover-play'));
    actions.append(moreButton(target, 'cover-btn cover-more'));
    return actions;
  }

  /**
   * 详情页头部的资料库按钮（与 music.apple.com 专辑 / 歌单页的「+」相同）：不在资料库中显示 +，在时显示 ✓，点击切换。
   * getTarget() 返回当前条目（页面数据载入前为 null，按钮不可用）。返回 { button, refresh }，数据载入后调用 refresh()
   */
  function libraryButton(getTarget, className = 'detail-circle-btn lib-toggle') {
    const button = el('button', { className, type: 'button', disabled: true });
    const refresh = () => {
      const target = getTarget();
      const key = target && libraryKey(target);
      const has = !!key && library.inLibrary(key.kind, key.id);
      button.disabled = !key;
      button.innerHTML = has ? LIB_ICON.added : LIB_ICON.add;
      button.setAttribute('aria-pressed', String(has));
      button.title = t(has ? 'library.inLibrary' : 'library.add');
      button.setAttribute('aria-label', button.title);
    };
    button.addEventListener('click', () => {
      const target = getTarget();
      if (target) toggleLibrary(target, button);
    });
    signal.addEventListener('abort', library.onChange(refresh), { once: true });
    refresh();
    return { button, refresh };
  }

  /**
   * 喜爱按钮（☆ / ★），用法与 libraryButton 相同；className 默认为详情页头部的圆形按钮；icons（{ star, starFilled }）可换成别的图标。返回 { button, refresh }
   */
  function favoriteButton(getTarget, className = 'detail-circle-btn lib-fav-toggle', icons = LIB_ICON) {
    const button = el('button', { className, type: 'button', disabled: true });
    const refresh = () => {
      const target = getTarget();
      const key = target && favoriteKey(target);
      const on = favoriteOf(key);
      button.disabled = !key;
      button.innerHTML = on ? icons.starFilled : icons.star;
      button.setAttribute('aria-pressed', String(on));
      button.title = t(on ? 'library.unfavorite' : 'library.favorite');
      button.setAttribute('aria-label', button.title);
    };
    button.addEventListener('click', () => {
      const target = getTarget();
      if (target) toggleFavorite(target, button);
    });
    signal.addEventListener('abort', library.onChange(refresh), { once: true });
    refresh();
    return { button, refresh };
  }

  /** 「添加到歌单」按钮：直接打开歌单子菜单 */
  function playlistButton(getTarget, className) {
    const button = el('button', { className, type: 'button', innerHTML: LIB_ICON.addToPlaylist, title: t('library.addToPlaylist') });
    button.setAttribute('aria-label', t('library.addToPlaylist'));
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = getTarget();
      if (target) openMenu(button, playlistMenuItems(() => targetTracks(target), { toast, navigate }));
    });
    return button;
  }

  /** 封面卡片（链接）外包一层 .card-wrap，加上 coverActions（按钮不能放进链接里） */
  function wrapCard(card, target) {
    return el('div', { className: `card-wrap${target.kind === 'music-video' ? ' mv' : ''}${target.kind === 'artist' ? ' artist' : ''}` }, card, coverActions(target));
  }

  /** 搜索结果行：封面上叠加播放按钮（方形封面），行末「更多」 */
  function wrapRow(row, target) {
    const wrap = el('div', { className: 'row-wrap' }, row);
    if (playable(target) && target.kind !== 'music-video') wrap.append(playButton(target, 'row-play'));
    wrap.append(moreButton(target, 'track-more row-more'));
    return wrap;
  }

  return { moreButton, coverActions, wrapCard, wrapRow, libraryButton, favoriteButton, playlistButton, toggleFavorite, headerMenu };
}

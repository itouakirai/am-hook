// 编辑页（与 music.apple.com 相同的 amp-api 调用与区块排版），由 app.mjs 挂载：
//   /new 与 /https://music.apple.com/{cc}/new                新发现（groupings?name=music；/new 跟随主地区）
//   /radio 与 /https://music.apple.com/{cc}/radio            广播（groupings?name=radio；/radio 跟随主地区）。填过 media-user-token 时
//                                                            另有「你的电台」：个人电台与最近播放的电台（官网 recently-played-radio-shelf）
//   /https://music.apple.com/{cc}/grouping/{id}              分组页（groupings/{id}，如「音乐视频」、各风格页）
//   /https://music.apple.com/{cc}/multi-room/{id}            multi-room（multirooms/{id}：头图 + 区块）
//   /https://music.apple.com/{cc}/curator/{slug}/{id}        策展人（有分组时与新发现相同的区块，否则为歌单网格）
//   /https://music.apple.com/{cc}/room/{id}                  room（区块的「查看全部」：rooms/{id} 的全部内容，分页加载）
//
// 区块按 editorialElementKind 排版（官网 vV）：316 hero 大卡、326 / 327 / 345 / 387 货架（歌曲为四行曲目列，
// 专辑 / 歌单为方形封面，电台为横向卡片，视频为 16:9）、385 砖块、391 / 405 链接、404 段落；其余跳过。
// 货架的列数与官网 shelf-grid 的 grid-type 相同（见 app.css .ed-shelf）。
import { createActions, targetOf, pagePath, songEntry, playable, artistLinks } from './actions.mjs';
import { userToken, personalStation, recentStations } from '/assets/station.mjs';

const { formatTime } = window.AmHook;
const { AmDecrypt, AmI18n } = window;
const { t } = AmI18n;

export const bodyClass = 'browse-page';
export const styles = ['/assets/views/browse.css'];

/** 官网 MH：区块内容不少于 6 个时标题可点击进入 room（查看全部） */
const SEE_ALL_MIN = 6;

/** 与官网 kV / GroupingPageIntent 相同的参数（art[url]=c,f：artwork.url 保留 {c} / {f} 占位，由前端选裁切与格式） */
const GROUPING_PARAMS = {
  platform: 'web',
  'omit[resource:artists]': 'autos',
  'relate[songs]': 'albums',
  'include[albums]': 'artists',
  'include[songs]': 'artists',
  'include[music-videos]': 'artists',
  'include[stations]': 'events,radio-show',
  'extend[station-events]': 'editorialVideo',
  'fields[artists]': 'name,url,artwork,editorialArtwork,genreNames,plainEditorialNotes',
  'fields[albums]': 'artistName,artistUrl,artwork,contentRating,editorialArtwork,plainEditorialNotes,name,playParams,releaseDate,url,trackCount',
  // 未登录访客看到的内容（官网 tabs: subscriber / nonsubscriber）
  tabs: 'nonsubscriber',
  'art[url]': 'c,f',
  extend: 'editorialArtwork,artistUrl,plainEditorialNotes',
};
/** 官网 RoomPageIntent */
const ROOM_PARAMS = {
  platform: 'web',
  'omit[resource:artists]': 'autos',
  'relate[songs]': 'albums',
  'include[albums]': 'artists',
  'include[songs]': 'artists',
  'fields[albums]': 'artistName,artistUrl,artwork,contentRating,editorialArtwork,editorialNotes,name,playParams,releaseDate,url,trackCount',
  'extend[albums]': 'artistUrl',
  'art[url]': 'c,f',
  extend: 'editorialArtwork,plainEditorialNotes',
};
/** 官网 MultiRoomPageIntent：uber 为头图，lockupStyle 为区块的卡片样式 */
const MULTIROOM_PARAMS = {
  platform: 'web',
  'omit[resource:artists]': 'autos',
  'include[songs]': 'artists',
  'relate[songs]': 'albums',
  'art[url]': 'c,f',
  extend: 'editorialArtwork,uber,lockupStyle,plainEditorialNotes',
};
/** 官网 AnyCuratorPageDetailIntent：/v1/catalog/{cc}?ids[curators]=&ids[apple-curators]= */
const CURATOR_PARAMS = {
  platform: 'web',
  'art[url]': 'c,f',
  include: 'grouping,playlists',
  'extend[apple-curators]': 'playlistCount',
  'extend[curators]': 'playlistCount',
  extend: 'editorialArtwork,plainEditorialNotes',
  'omit[resource:artists]': 'autos',
  'include[songs]': 'artists',
  'relate[songs]': 'albums',
  'fields[albums]': 'artistName,artistUrl,artwork,contentRating,editorialArtwork,name,playParams,releaseDate,url,trackCount',
};

/** 官网 TopChartPageIntent（排行榜首页）：四类榜单各 50 个，另带城市榜与每周热门 100 首 */
const CHARTS_PARAMS = {
  platform: 'web',
  types: 'albums,songs,music-videos,playlists',
  with: 'cityCharts,dailyGlobalTopCharts',
  limit: '50',
  genre: '34',
  include: 'tracks',
  'include[songs]': 'artists',
  'relate[songs]': 'albums',
  'include[albums]': 'artists',
  'include[music-videos]': 'artists',
  'fields[artists]': 'name,url',
  'fields[albums]': 'artistName,artistUrl,artwork,contentRating,editorialArtwork,name,playParams,releaseDate,url,trackCount',
  'fields[playlists]': 'artistName,artistUrl,artwork,contentRating,editorialArtwork,name,playParams,releaseDate,url,curatorName',
  'omit[resource]': 'autos',
  'art[url]': 'c,f',
  extend: 'artistUrl',
};
/** 官网 TopChartSeeAllPageIntent（SV）：同一个 charts 请求，genre 为所选类型 */
const CHART_SEE_ALL_PARAMS = {
  platform: 'web',
  types: 'albums,songs,music-videos,playlists',
  with: 'cityCharts,dailyGlobalTopCharts',
  limit: '50',
  include: 'tracks',
  'include[songs]': 'artists',
  'relate[songs]': 'albums',
  'fields[albums]': 'artistName,artistUrl,artwork,contentRating,editorialArtwork,name,playParams,releaseDate,url',
  'fields[playlists]': 'artistName,artistUrl,artwork,contentRating,editorialArtwork,name,playParams,releaseDate,url,curatorName',
  'art[url]': 'c,f',
  extend: 'artistUrl',
};

/** 排行榜的类型列表（官网 EV：/v1/catalog/{cc}/genres），按地区与语言缓存 */
const genreCache = new Map();
function chartGenres(cc, l) {
  const key = `${cc}:${l || ''}`;
  if (!genreCache.has(key)) {
    const target = new URL(`/amp/v1/catalog/${cc}/genres`, location.origin);
    if (l) target.searchParams.set('l', l);
    const pending = fetch(target).then((res) => (res.ok ? res.json() : null)).then((data) => ((data && data.data) || []).filter((g) => g.attributes && g.attributes.name));
    // 取不到时不缓存，页面照常显示（只是没有类型选择）
    pending.then((list) => { if (!list.length) genreCache.delete(key); }, () => genreCache.delete(key));
    genreCache.set(key, pending.catch(() => []));
  }
  return genreCache.get(key);
}

/** 站内能打开的目录资源 */
const LOCAL_KINDS = new Set(['songs', 'music-videos', 'albums', 'playlists', 'artists']);
const VIDEO_TYPES = new Set(['music-videos', 'uploaded-videos', 'music-movies']);
/** 与 app.mjs 的路由相同：本站能打开的 Apple Music 页面 */
const LOCAL_PAGE = /^https:\/\/music\.apple\.com\/[a-z]{2}\/(?:(?:song|music-video)\/[^/?#]+\/\d+|post\/(?:[^/?#]+\/)?\d+|(?:album|artist)\/(?:[^/?#]+\/)?\d+|playlist\/(?:[^/?#]+\/)?pl\.[\w-]+|(?:room|multi-room|grouping)\/\d+|curator\/(?:[^/?#]+\/)?\d+|station\/(?:[^/?#]+\/)?ra\.[\w.-]+|new\/?|radio\/?)$/;

/** 排行榜：地址中的榜单名（官网 kH）→ charts 接口 results 的键，按官网排行榜首页的顺序 */
const CHART_KEYS = {
  songs: 'songs', 'city-charts': 'cityCharts', 'daily-global-top-charts': 'dailyGlobalTopCharts',
  playlists: 'playlists', albums: 'albums', 'music-videos': 'music-videos',
};
const CHART_SLUGS = Object.fromEntries(Object.entries(CHART_KEYS).map(([slug, key]) => [key, slug]));
/** 可按类型筛选的榜单（官网 Yf）；「所有类型」为 genre 34（官网 Ps） */
const GENRE_CHARTS = new Set(['songs', 'albums', 'music-videos']);
const ALL_GENRES = '34';
/** 带名次的榜单（官网 vae：歌曲、歌单、专辑、视频），城市榜与每周热门 100 首没有 */
const RANKED_CHARTS = new Set(['songs', 'playlists', 'albums', 'music-videos']);
const CHARTS_PATH = /^\/new\/top-charts(?:\/([a-z-]+))?\/?$/;
const CHARTS_LINK = /^https:\/\/music\.apple\.com\/([a-z]{2})\/new\/top-charts(?:\/([a-z-]+))?\/?$/i;

/** 地址 → 页面：{ kind, cc, id, follow, chart, genre }；follow 为 true 时地区跟随主地区（/new、/new/top-charts） */
function parsePage(url) {
  if (url.pathname === '/new') return { kind: 'new', cc: AmI18n.storefront, id: '', follow: true };
  if (/^\/radio\/?$/.test(url.pathname)) return { kind: 'radio', cc: AmI18n.storefront, id: '', follow: true };
  const path = decodeURIComponent(url.pathname.slice(1));
  const local = url.pathname.match(CHARTS_PATH);
  const link = !local && path.match(CHARTS_LINK);
  if (local || link) {
    const slug = (local ? local[1] : link[2]) || '';
    const chart = slug ? CHART_KEYS[slug.toLowerCase()] : '';
    if (slug && !chart) return null;
    const genreId = url.searchParams.get('genreId') || '';
    const genre = GENRE_CHARTS.has(chart) && /^\d+$/.test(genreId) ? genreId : ALL_GENRES;
    return { kind: 'charts', cc: local ? AmI18n.storefront : link[1].toLowerCase(), id: '', follow: !!local, chart, genre };
  }
  const m = path.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/(new|radio|room|multi-room|grouping|curator)(?:\/(?:[^/?#]+\/)?(\d+))?/i);
  if (!m) return null;
  return { kind: m[2].toLowerCase(), cc: m[1].toLowerCase(), id: m[3] || '', follow: false };
}

export function mount({ root, url, signal, player, navigate, onLangChange, toast }) {
  const $ = (id) => root.querySelector(`#${id}`);
  const actions = createActions({ signal, player, navigate, toast });
  const page = parsePage(url);
  let country = page ? page.cc : 'us';
  let loadToken = 0;
  /** 已加载的页面：{ title, notes, banner, elements, grid: { items, next, layout } } */
  let model = null;
  /** 曲目行：歌曲 ID → [{ row, playBtn }]（同一首歌可能出现在多个区块） */
  let rows = new Map();
  let moreObserver = null;
  signal.addEventListener('abort', () => moreObserver?.disconnect(), { once: true });

  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
    chevron: '<svg class="ed-chevron" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true"><path d="M19.817 61.863c1.48 0 2.672-.515 3.702-1.546l24.243-23.63c1.352-1.385 1.996-2.737 2.028-4.443 0-1.674-.644-3.09-2.028-4.443L23.519 4.138c-1.03-.998-2.253-1.513-3.702-1.513-2.994 0-5.409 2.382-5.409 5.344 0 1.481.612 2.833 1.739 3.96l20.99 20.347-20.99 20.283c-1.127 1.126-1.739 2.478-1.739 3.96 0 2.93 2.415 5.344 5.409 5.344Z"/></svg>',
    arrowLeft: '<svg viewBox="0 0 9 31" fill="currentColor" aria-hidden="true"><path d="M5.275 29.46a1.61 1.61 0 0 0 1.456 1.077c1.018 0 1.772-.737 1.772-1.737 0-.526-.277-1.186-.449-1.62l-4.68-11.912L8.05 3.363c.172-.442.45-1.116.45-1.625A1.7 1.7 0 0 0 6.728.002a1.6 1.6 0 0 0-1.456 1.09L.675 12.774c-.301.775-.677 1.744-.677 2.495 0 .754.376 1.705.677 2.498L5.272 29.46Z"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>',
  };

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false && c !== ''));
    return node;
  }

  let alertState = null;
  function showAlert(kind, message) {
    alertState = message ? { kind, message } : null;
    renderAlert();
  }
  function renderAlert() {
    const a = $('alert');
    a.hidden = !alertState;
    if (!alertState) return;
    a.className = `alert ${alertState.kind}`;
    a.textContent = typeof alertState.message === 'function' ? alertState.message() : alertState.message;
  }

  /* ---------- amp-api（经服务端 /amp 代理） ---------- */
  async function amp(path, params) {
    const target = new URL('/amp' + path, location.origin);
    // 值为 undefined 的参数不传（如地区不支持当前语言时的 l）
    for (const [key, value] of Object.entries(params || {})) if (value !== undefined) target.searchParams.set(key, value);
    let res = await fetch(target);
    // amp-api 偶尔返回 5xx（如 charts 的「Service failure」），稍等后重试一次
    if (res.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      res = await fetch(target);
    }
    // 地区不支持所选语言时去掉 l，改用地区默认语言
    if (res.status === 400 && target.searchParams.has('l')) {
      target.searchParams.delete('l');
      res = await fetch(target);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error((data && ((data.errors && data.errors[0] && data.errors[0].detail) || data.msg)) || `HTTP ${res.status}`);
    return data;
  }

  /** artwork.url 模板 {w}x{h}{c}.{f}；部分歌单封面的裁切码已写在地址里（如 SC.DN01），这时没有 {c} */
  function artUrl(artwork, w, h = w, crop = 'bb', format = 'jpg') {
    return artwork && artwork.url ? artwork.url.replace('{w}', w).replace('{h}', h).replace('{c}', crop).replace('{f}', format) : '';
  }

  function img(src, alt = '') {
    return src ? el('img', { src, alt, loading: 'lazy', decoding: 'async' }) : el('span', { className: 'ph' });
  }

  /** editorialNotes 可能带 <i> 等内联标签，只取纯文本 */
  function plainText(html) {
    return html ? new DOMParser().parseFromString(html, 'text/html').body.textContent.trim() : '';
  }

  /** 资源的简短说明（官网 zn：plainEditorialNotes / editorialNotes 的 short） */
  function shortNotes(a) {
    const notes = (a && (a.plainEditorialNotes || a.editorialNotes)) || {};
    return plainText(notes.short || notes.tagline || '');
  }

  const explicitBadge = () => el('span', { className: 'explicit', textContent: 'E', title: t('search.explicit') });
  const rel = (res, key) => (res && res.relationships && res.relationships[key] && res.relationships[key].data) || [];
  const withAttrs = (list) => list.filter((res) => res && res.attributes);

  /* ---------- 链接：Apple Music 地址 → 本站页面（与官网各 PageIntent 的路由相同），其余为外部链接 ---------- */
  /**
   * 编辑数据里的链接有多种写法：music.apple.com/{cc}/room/{id}、/cn/room/{id}（相对路径）、
   * itunes.apple.com/.../collection/...?fcId={room}、MZStore.woa/wa/viewGrouping?id=&cc=、viewFeature?id=（multi-room）、viewRoom?fcId=。
   * 返回 { href, local }。
   */
  function resolveLink(raw) {
    if (!raw) return null;
    let link;
    try { link = new URL(raw, 'https://music.apple.com'); } catch { return null; }
    if (!/(^|\.)(music|itunes)\.apple\.com$/i.test(link.hostname)) return { href: link.href, local: false };
    const cc = (link.searchParams.get('cc') || (link.pathname.match(/^\/([a-z]{2})\//i) || [])[1] || country).toLowerCase();
    const id = (key) => (/^\d+$/.test(link.searchParams.get(key) || '') ? link.searchParams.get(key) : '');
    const at = (kind, value) => ({ href: `/https://music.apple.com/${cc}/${kind}/${value}`, local: true });
    if (/\/viewGrouping$/i.test(link.pathname) && id('id')) return at('grouping', id('id'));
    if (/\/viewFeature$/i.test(link.pathname) && id('id')) return at('multi-room', id('id'));
    if (/\/view(?:Multi)?Room$/i.test(link.pathname) && id('fcId')) return at(/Multi/i.test(link.pathname) ? 'multi-room' : 'room', id('fcId'));
    if (/^\/(?:[a-z]{2}\/)?collection\//i.test(link.pathname) && id('fcId')) return at('room', id('fcId'));
    const clean = `https://music.apple.com${link.pathname.replace(/\/$/, '')}`;
    // 排行榜（含 MZStore.woa/wa/viewTop）：新发现里的链接写死了 /us/，这里改为跟随主地区的 /new/top-charts
    const charts = clean.match(CHARTS_LINK);
    if (charts && (!charts[2] || CHART_KEYS[charts[2].toLowerCase()])) {
      return { href: `/new/top-charts${charts[2] ? `/${charts[2].toLowerCase()}` : ''}${id('genreId') ? `?genreId=${id('genreId')}` : ''}`, local: true };
    }
    if (/\/viewTop$/i.test(link.pathname)) return { href: '/new/top-charts', local: true };
    // 专辑链接带 ?i= 时打开歌曲页
    const song = clean.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/album\/([^/]+)\/\d+$/i) && id('i');
    if (song) return { href: `/https://music.apple.com/${cc}/song/${clean.split('/')[5]}/${song}`, local: true };
    if (LOCAL_PAGE.test(clean)) return { href: '/' + clean, local: true };
    return { href: link.href, local: false };
  }

  /** 资源 → { href, local }：歌曲 / MV / 专辑 / 歌单 / 艺人为本站页面，策展人、room 等编辑资源为本站编辑页，电台等为外部链接 */
  function linkFor(res) {
    const a = res.attributes || {};
    if (LOCAL_KINDS.has(res.type)) return { href: pagePath(res, country), local: true };
    switch (res.type) {
      case 'apple-curators':
      case 'curators': {
        const hit = resolveLink(a.url);
        return hit && hit.local ? hit : { href: `/https://music.apple.com/${country}/curator/_/${res.id}`, local: true };
      }
      case 'rooms': return { href: `/https://music.apple.com/${country}/room/${res.id}`, local: true };
      case 'multirooms': return { href: `/https://music.apple.com/${country}/multi-room/${res.id}`, local: true };
      case 'groupings': return { href: `/https://music.apple.com/${country}/grouping/${res.id}`, local: true };
      // 艺人上传的视频（官网 post 页）：资源没有 url，地址在 postUrl
      case 'uploaded-videos': {
        const hit = a.postUrl && resolveLink(a.postUrl);
        return hit && hit.local ? hit : { href: `/https://music.apple.com/${country}/post/${res.id}`, local: true };
      }
      default: return a.url ? resolveLink(a.url) : null;
    }
  }

  /** 链接元素：外部链接在新标签页打开 */
  function linkProps(link) {
    if (!link) return {};
    return link.local ? { href: link.href } : { href: link.href, target: '_blank', rel: 'noreferrer', title: t('browse.external') };
  }

  /** 卡片：本站能播放 / 打开的资源加上封面悬停按钮（见 actions.mjs），其余只是链接 */
  function card(node, res, extraClass = '', after = null) {
    if (!LOCAL_KINDS.has(res.type)) return el('div', { className: `card-wrap ${extraClass}`.trim() }, node, after);
    const wrap = actions.wrapCard(node, targetOf(res, country));
    if (extraClass) wrap.classList.add(...extraClass.split(/\s+/));
    if (after) wrap.append(after);
    return wrap;
  }

  /**
   * 卡片副标题：专辑 / 歌曲 / 视频的艺人链接到本站艺人页。链接不能放进卡片的 <a>，
   * 故返回 { inner, after }：没有链接时副标题在卡片里（inner），有链接时放在卡片之后（after）
   */
  function subtitleParts(res) {
    const sub = subtitleOf(res);
    if (!sub) return {};
    const links = ['albums', 'songs', 'music-videos'].includes(res.type) && sub === (res.attributes || {}).artistName
      ? artistLinks(res, country) : [];
    if (links.some((part) => typeof part !== 'string')) return { after: el('div', { className: 'shelf-sub' }, ...links) };
    return { inner: el('span', { className: 'shelf-sub', textContent: sub }) };
  }

  /** 副标题（官网 Ooe）：歌单为作者，专辑 / 歌曲为艺人，其余取说明 */
  function subtitleOf(res) {
    const a = res.attributes || {};
    switch (res.type) {
      case 'artists': return (a.genreNames || [])[0] || '';
      case 'stations': return shortNotes(a);
      case 'apple-curators':
      case 'curators': return '';
      default: return a.curatorName || a.artistName || shortNotes(a);
    }
  }

  /* ---------- 卡片（官网各 lockup） ---------- */
  /** 排行榜名次（官网 product-lockup__ordinal / vertical-video__headline--rank）：标题上方的粗体数字 */
  const ordinal = (rank) => (rank ? el('span', { className: 'ed-ordinal', textContent: rank.toLocaleString() }) : null);

  /** 方形卡片（squareLockup）；艺人为圆形。rank 为排行榜名次（可省略） */
  function squareLockup(res, rank = 0) {
    const a = res.attributes;
    const person = res.type === 'artists';
    const link = linkFor(res);
    const title = el('span', { className: 'shelf-title', textContent: a.name || '' });
    if (a.contentRating === 'explicit') title.append(explicitBadge());
    const sub = subtitleParts(res);
    const node = el(link ? 'a' : 'div', { className: `shelf-item${person ? ' artist' : ''}`, ...linkProps(link) },
      el('span', { className: `shelf-art${person ? ' artist' : ''}` }, img(artUrl(a.artwork, 400, 400, person ? 'cc' : 'sr'))),
      ordinal(rank), title, sub.inner);
    return card(node, res, person ? 'artist' : '', sub.after);
  }

  /** 16:9 视频卡片（verticalVideoLockup）；rank 为排行榜名次（可省略） */
  function videoLockup(res, rank = 0) {
    const a = res.attributes;
    const link = linkFor(res);
    const title = el('span', { className: 'shelf-title', textContent: a.name || '' });
    if (a.contentRating === 'explicit') title.append(explicitBadge());
    const sub = subtitleParts(res);
    const art = res.type === 'music-videos' ? artUrl(a.artwork, 680, 383, 'mv') : artUrl(a.artwork, 680, 383, 'sr');
    const node = el(link ? 'a' : 'div', { className: 'shelf-item mv', ...linkProps(link) },
      el('span', { className: 'shelf-art mv' }, img(art)), ordinal(rank), title, sub.inner);
    return card(node, res, 'mv', sub.after);
  }

  /** 横向卡片（horizontalLockup）：97px 方形封面，右侧标题与说明，电台等 */
  function horizontalLockup(res) {
    const a = res.attributes;
    const link = linkFor(res);
    const sub = subtitleOf(res);
    return el(link ? 'a' : 'div', { className: 'ed-horizontal', ...linkProps(link) },
      el('span', { className: 'ed-horizontal-art' }, img(artUrl(a.artwork, 194, 194, 'sr'))),
      el('span', { className: 'ed-horizontal-text' },
        el('span', { className: 'ed-horizontal-title', textContent: a.name || '' }),
        sub ? el('span', { className: 'ed-horizontal-sub', textContent: sub }) : null));
  }

  /**
   * 曲目行（trackLockup）：40px 封面，悬停时封面上显示播放；queue 为同一区块的歌曲，按顺序排队播放；
   * rank 为排行榜名次（官网 lockup-ranking，在封面与标题之间）
   */
  function trackLockup(track, queue, rank = 0) {
    const a = track.attributes;
    const canPlay = playable(track);
    const href = pagePath(track, country);
    const playBtn = canPlay ? el('button', { className: 'track-play', type: 'button', innerHTML: ICON.play }) : null;
    if (playBtn) {
      playBtn.setAttribute('aria-label', t('album.playTrack', { name: a.name }));
      playBtn.addEventListener('click', () => playTrack(track, queue));
    }
    const cover = el('span', { className: 'track-art' }, img(artUrl(a.artwork, 80)),
      el('span', { className: 'eq', ariaHidden: 'true' }, el('i'), el('i'), el('i'), el('i')), playBtn);
    const album = rel(track, 'albums')[0];
    const albumHref = album && album.attributes ? pagePath(album, country) : '';
    const main = el('div', { className: 'track-main' },
      el('div', { className: 'track-line' }, el('a', { className: 'track-title', href, textContent: a.name }), a.contentRating === 'explicit' ? explicitBadge() : null),
      el('div', { className: 'track-artist' }, ...artistLinks(track, country)));
    const more = actions.moreButton(targetOf(track, country, { albumHref, ...(canPlay ? { onPlay: () => playTrack(track, queue) } : {}) }));
    const row = el('div', { className: `track ts-item ed-track${rank ? ' ranked' : ''}${canPlay ? '' : ' unavailable'}` },
      cover, rank ? el('span', { className: 'ed-rank', textContent: rank.toLocaleString() }) : null, main, more);
    if (canPlay) row.addEventListener('dblclick', (e) => { if (!e.target.closest('a, button')) playTrack(track, queue); });
    if (!rows.has(track.id)) rows.set(track.id, []);
    rows.get(track.id).push({ row, playBtn });
    return row;
  }

  /** hero 大卡（官网 editorial-card）：眉题、标题、副标题，下方宽幅封面压着说明文字 */
  function heroCard({ badge, title, subtitle, description, artwork, link, res }) {
    const art = el('div', { className: 'ed-hero-art', style: artwork && artwork.bgColor ? `--art-bg:#${artwork.bgColor}` : '' },
      img(artUrl(artwork, 1060, 608, 'sr'), title || ''));
    if (description) art.append(el('div', { className: 'ed-hero-desc' }, el('span', { textContent: description })));
    const cardNode = el('div', { className: 'card-wrap ed-hero' },
      link ? el('a', { className: 'ed-hero-link', ...linkProps(link), textContent: title || badge || '' }) : null,
      el('div', { className: 'ed-hero-head' },
        badge ? el('p', { className: 'ed-hero-badge', textContent: badge }) : null,
        title ? el('h2', { className: `ed-hero-title${subtitle ? ' clamp-1' : ''}`, textContent: title }) : null,
        subtitle ? el('p', { className: 'ed-hero-sub', textContent: subtitle }) : null),
      art);
    // 能播放的内容：封面右下角的播放 / 更多按钮
    if (res && LOCAL_KINDS.has(res.type)) art.append(actions.coverActions(targetOf(res, country)));
    return cardNode;
  }

  /* ---------- 区块 ---------- */
  /** 区块标题（官网 header）：内容足够多且有 room 时可点击进入「查看全部」 */
  function sectionHead(element, count) {
    const a = element.attributes || {};
    const room = rel(element, 'room')[0];
    return headWith(a.name || a.title || '', room && count >= SEE_ALL_MIN ? `/https://music.apple.com/${country}/room/${room.id}` : '');
  }

  /** 区块标题：有 href 时标题可点击（带灰色箭头），进入「查看全部」 */
  function headWith(name, href) {
    if (!name) return null;
    const heading = el('h2', { className: 'ed-heading' });
    if (href) {
      const link = el('a', { className: 'ed-heading-link', href }, el('span', { textContent: name }));
      link.insertAdjacentHTML('beforeend', ICON.chevron);
      link.setAttribute('aria-label', t('browse.seeAll', { name }));
      heading.append(link);
    } else {
      heading.textContent = name;
    }
    return el('div', { className: 'ed-head' }, heading);
  }

  /**
   * 横向货架（官网 shelf-grid）：type 为官网 grid-type（A / B / C / G / H / T），rows 为行数；
   * 鼠标设备悬停时两侧显示翻页箭头，每次滚动一屏
   */
  function shelf(type, rows, items) {
    const list = el('div', { className: `ed-shelf grid-${type}`, style: `--rows:${rows}` }, ...items);
    const prev = el('button', { className: 'ed-arrow prev', type: 'button', innerHTML: ICON.arrowLeft, disabled: true });
    const next = el('button', { className: 'ed-arrow next', type: 'button', innerHTML: ICON.arrowLeft });
    prev.setAttribute('aria-label', t('browse.prev'));
    next.setAttribute('aria-label', t('browse.next'));
    const page = (dir) => {
      const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
      list.scrollBy({ left: dir * (list.clientWidth + gap), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    };
    prev.addEventListener('click', () => page(-1));
    next.addEventListener('click', () => page(1));
    const sync = () => {
      const max = list.scrollWidth - list.clientWidth;
      prev.disabled = list.scrollLeft <= 1;
      next.disabled = list.scrollLeft >= max - 1;
      wrap.classList.toggle('scrollable', max > 1);
    };
    list.addEventListener('scroll', sync, { passive: true });
    const wrap = el('div', { className: 'ed-shelf-wrap' }, prev, list, next);
    const observer = new ResizeObserver(sync);
    observer.observe(list);
    signal.addEventListener('abort', () => observer.disconnect(), { once: true });
    return wrap;
  }

  function section(className, ...children) {
    return el('section', { className: `ed-section ${className}`.trim() }, ...children);
  }

  /** 316 hero 列表：317 / 383 为内容卡（contents[0] 的 editorialArtwork.subscriptionHero），320 为自定义卡（自带 artwork 与链接） */
  function heroShelf(element) {
    const cards = withAttrs(rel(element, 'children')).map((child) => {
      const a = child.attributes;
      const content = withAttrs(rel(child, 'contents'))[0];
      if (a.editorialElementKind === '320') {
        if (!a.artwork) return null;
        return heroCard({ badge: a.designBadge, title: a.designTag || a.name, artwork: a.artwork,
          link: content ? linkFor(content) : resolveLink(a.link && a.link.url), res: content });
      }
      if (!content) {
        // 没有内容资源的卡片（官网 pV）：自带 artwork 与 link
        if (!a.artwork) return null;
        return heroCard({ badge: a.designBadge, title: a.designTag || a.name, artwork: a.artwork, link: resolveLink(a.link && a.link.url) });
      }
      const c = content.attributes;
      const artwork = (c.editorialArtwork && (c.editorialArtwork.subscriptionHero || c.editorialArtwork.subscriptionCover)) || null;
      if (!artwork) return null;
      const subtitle = subtitleOf(content);
      const description = shortNotes(c);
      return heroCard({ badge: a.designBadge, title: c.name, subtitle, description: description !== subtitle ? description : '', artwork, link: linkFor(content), res: content });
    }).filter(Boolean);
    return cards.length ? section('ed-hero-section', shelf('A', 1, cards)) : null;
  }

  /** 326 / 327 / 345 / 387 货架：按内容类型与 displayStyle 选卡片（官网 sse / ose / Pk） */
  function swoosh(element) {
    const a = element.attributes || {};
    const items = withAttrs(rel(element, 'contents'));
    if (!items.length) return null;
    const head = sectionHead(element, items.length);
    const songs = items.filter((res) => res.type === 'songs');
    if (a.editorialElementKind === '327' || songs.length === items.length) {
      return section('ed-tracks-section', head, shelf('T', 4, songs.map((track) => trackLockup(track, songs))));
    }
    const expanded = a.displayStyle === 'expanded';
    const first = items[0].type;
    if (['stations', 'apple-curators'].includes(first) && expanded) {
      return section('', head, shelf('B', 2, items.map((res) => horizontalLockup(res))));
    }
    if (VIDEO_TYPES.has(first)) {
      return section('', head, shelf('C', expanded ? 2 : 1, items.map((res) => (VIDEO_TYPES.has(res.type) ? videoLockup(res) : squareLockup(res)))));
    }
    if (first === 'artists' || first === 'curators') {
      return section('', head, shelf('H', 1, items.map((res) => squareLockup(res))));
    }
    return section('', head, shelf('G', expanded ? 2 : 1, items.map((res) => (VIDEO_TYPES.has(res.type) ? videoLockup(res) : squareLockup(res)))));
  }

  /** 直播电台当前的节目（station-events 中正在播出的一个） */
  function currentEvent(res) {
    const now = Date.now();
    return withAttrs(rel(res, 'events')).find((e) => Date.parse(e.attributes.startTime) <= now && Date.parse(e.attributes.endTime) > now) || null;
  }

  /** 时间段（同一天只写一次日期） */
  function timeRange(start, end) {
    const fmt = new Intl.DateTimeFormat(AmI18n.lang === 'zh' ? 'zh-CN' : 'en-US', { timeStyle: 'short' });
    const s = new Date(start), e = new Date(end);
    return Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) ? '' : `${fmt.format(s)}–${fmt.format(e)}`;
  }

  /**
   * 488 直播电台货架（官网 live-radio-shelf）：489 的 contents[0] 为电台，卡片为品牌方形图标、
   * 「直播」标记、电台名与正在播出的节目
   */
  function liveRadioShelf(element) {
    const stations = withAttrs(rel(element, 'children')).map((child) => withAttrs(rel(child, 'contents'))[0]).filter(Boolean);
    if (!stations.length) return null;
    const cards = stations.map((res) => {
      const a = res.attributes;
      const link = linkFor(res);
      const art = (a.editorialArtwork && a.editorialArtwork.brandLogo) || a.artwork;
      const event = currentEvent(res);
      return el('div', { className: 'card-wrap' }, el(link ? 'a' : 'div', { className: 'shelf-item ed-live', ...linkProps(link) },
        el('span', { className: 'shelf-art ed-live-art', style: art && art.bgColor ? `--art-bg:#${art.bgColor}` : '' }, img(artUrl(art, 400, 400, 'bb')),
          el('span', { className: 'ed-live-badge', textContent: t('station.liveBadge') })),
        el('span', { className: 'shelf-title', textContent: a.name || '' }),
        event ? el('span', { className: 'shelf-sub', textContent: event.attributes.title || '' }) : null,
        event ? el('span', { className: 'shelf-sub', textContent: timeRange(event.attributes.startTime, event.attributes.endTime) }) : null));
    });
    return section('', sectionHead(element, 0), shelf('G', 1, cards));
  }

  /** 「你的电台」：个人电台与最近播放的电台（需要 media-user-token） */
  function myStations(stations) {
    return section('', headWith(t('radio.mine'), ''), shelf('G', 1, stations.map((res) => squareLockup(res))));
  }

  /** 385 砖块：386（contents[0]）与 394（自带 artwork 与链接），排成 B 型货架的宽幅卡片 */
  function brickShelf(element) {
    const cards = withAttrs(rel(element, 'children')).map((child) => {
      const a = child.attributes;
      const content = withAttrs(rel(child, 'contents'))[0];
      const c = content ? content.attributes : {};
      const artwork = a.artwork || (c.editorialArtwork && (c.editorialArtwork.subscriptionHero || c.editorialArtwork.subscriptionCover || c.editorialArtwork.brandLogo)) || c.artwork;
      if (!artwork) return null;
      return heroCard({ badge: a.designBadge, title: a.designTag || c.name || a.name, artwork,
        link: content ? linkFor(content) : resolveLink(a.link && a.link.url), res: content });
    }).filter(Boolean);
    return cards.length ? section('ed-bricks-section', sectionHead(element, 0), shelf('B', 1, cards)) : null;
  }

  /** 391 链接列表 / 405 单个链接（官网 link-box）：编辑数据里的旧式链接按官网路由转成本站页面 */
  function linkList(element) {
    const a = element.attributes || {};
    const links = (a.links || (a.link ? [a.link] : [])).filter((link) => link && link.label && link.url);
    if (!links.length) return null;
    const items = links.map((link) => {
      const target = resolveLink(link.url);
      const box = el('a', { className: 'ed-link', ...linkProps(target) }, el('span', { textContent: link.label }));
      box.insertAdjacentHTML('beforeend', target && target.local ? ICON.chevron : ICON.external);
      return el('li', {}, box);
    });
    return section('ed-links-section', sectionHead(element, 0), el('ul', { className: 'ed-links' }, ...items));
  }

  /** 404 段落 */
  function paragraph(element) {
    const text = plainText((element.attributes || {}).description || '');
    return text ? section('', sectionHead(element, 0), el('p', { className: 'ed-paragraph', textContent: text })) : null;
  }

  /** editorial-elements → 区块元素；不认识的类型跳过（与官网 wH 一样，322 等不是区块） */
  function renderElement(element) {
    switch ((element.attributes || {}).editorialElementKind) {
      case '316': return heroShelf(element);
      case '326': case '327': case '345': case '387': return swoosh(element);
      case '488': return liveRadioShelf(element);
      case '385': return brickShelf(element);
      case '391': case '405': return linkList(element);
      case '404': return paragraph(element);
      default: return null;
    }
  }

  /* ---------- 网格：room 与策展人歌单（分页加载） ---------- */
  /** 网格的卡片类型：与货架相同的卡片，换成按行排列 */
  function gridLayout(items) {
    const types = new Set(items.map((res) => res.type));
    if (types.size === 1 && types.has('songs')) return 'T';
    if ([...types].every((type) => VIDEO_TYPES.has(type))) return 'C';
    if ([...types].every((type) => type === 'stations')) return 'B';
    if ([...types].every((type) => type === 'artists' || type === 'curators')) return 'H';
    return 'G';
  }

  /** rank 为排行榜名次（0 为不显示）；L 为排行榜歌曲的列表（与歌单页的榜单相同的行） */
  function gridItem(res, layout, songs, rank = 0) {
    if (layout === 'L') return chartRow(res, songs, rank);
    if (layout === 'T') return trackLockup(res, songs, rank);
    if (layout === 'B') return horizontalLockup(res);
    return VIDEO_TYPES.has(res.type) ? videoLockup(res, rank) : squareLockup(res, rank);
  }

  /** 排行榜歌曲（官网 playlistTrackList）：封面、名次、标题与艺人、专辑、时长、「更多」，沿用歌单页 .pl-track 的排版 */
  function chartRow(track, queue, rank) {
    const a = track.attributes;
    const canPlay = playable(track);
    const href = pagePath(track, country);
    const playBtn = canPlay ? el('button', { className: 'track-play', type: 'button', innerHTML: ICON.play }) : null;
    if (playBtn) {
      playBtn.setAttribute('aria-label', t('album.playTrack', { name: a.name }));
      playBtn.addEventListener('click', () => playTrack(track, queue));
    }
    const cover = el('span', { className: 'track-art' }, img(artUrl(a.artwork, 80)),
      el('span', { className: 'eq', ariaHidden: 'true' }, el('i'), el('i'), el('i'), el('i')), playBtn);
    const album = rel(track, 'albums')[0];
    const albumHref = album && album.attributes ? pagePath(album, country) : '';
    const main = el('div', { className: 'track-main' },
      el('div', { className: 'track-line' }, el(canPlay ? 'a' : 'span', { className: 'track-title', textContent: a.name, ...(canPlay ? { href } : {}) }),
        a.contentRating === 'explicit' ? explicitBadge() : null),
      el('div', { className: 'track-artist' }, ...artistLinks(track, country)));
    const albumCol = albumHref && a.albumName ? el('a', { className: 'track-album', href: albumHref, textContent: a.albumName })
      : el('span', { className: 'track-album', textContent: a.albumName || '' });
    const more = actions.moreButton(targetOf(track, country, { albumHref, ...(canPlay ? { onPlay: () => playTrack(track, queue) } : {}) }));
    const row = el('div', { className: `track pl-track${canPlay ? '' : ' unavailable'}` }, cover,
      el('span', { className: 'track-rank', textContent: rank.toLocaleString() }), main, albumCol,
      el('span', { className: 'track-time', textContent: a.durationInMillis ? formatTime(a.durationInMillis / 1000) : '' }), more);
    if (canPlay) row.addEventListener('dblclick', (e) => { if (!e.target.closest('a, button')) playTrack(track, queue); });
    if (!rows.has(track.id)) rows.set(track.id, []);
    rows.get(track.id).push({ row, playBtn });
    return row;
  }

  /** 网格元素与其中的歌曲（曲目按网格顺序排队播放，翻页后追加） */
  let gridNode = null;
  let gridSongs = [];

  const gridRank = (index) => (model.grid.ranked ? index + 1 : 0);

  function renderGrid() {
    const { items, layout } = model.grid;
    gridSongs = items.filter((res) => res.type === 'songs');
    gridNode = el('div', { className: layout === 'L' ? 'tracklist chart ed-chart-list' : `ed-grid grid-${layout}` },
      ...items.map((res, i) => gridItem(res, layout, gridSongs, gridRank(i))));
    return section('ed-grid-section', gridNode);
  }

  function appendGrid(items) {
    const start = model.grid.items.length - items.length;
    gridSongs.push(...items.filter((res) => res.type === 'songs'));
    gridNode.append(...items.map((res, i) => gridItem(res, model.grid.layout, gridSongs, gridRank(start + i))));
    syncRows(player.current, !player.transport().paused);
  }

  /** 翻页请求的参数：与首页相同的封面占位与语言（next 地址只带 offset） */
  const pageParams = (l) => ({ l, 'art[url]': 'c,f', extend: 'editorialArtwork,plainEditorialNotes', 'omit[resource:artists]': 'autos' });

  /** 网格滚到底部附近时取下一页（amp-api 的 next 地址，加上 /amp 前缀） */
  function watchMore() {
    moreObserver?.disconnect();
    const sentinel = $('more');
    sentinel.hidden = !(model && model.grid && model.grid.next);
    if (sentinel.hidden) return;
    sentinel.textContent = t('browse.loadMore');
    let busy = false;
    moreObserver = new IntersectionObserver(async (entries) => {
      if (busy || !entries.some((entry) => entry.isIntersecting) || !model.grid.next) return;
      busy = true;
      const token = loadToken;
      try {
        const l = await AmI18n.catalogLang(country);
        const data = await amp(model.grid.next, { ...pageParams(l), ...(model.grid.pageParams || {}) });
        if (token !== loadToken || signal.aborted) return;
        // 排行榜的下一页仍是 charts 响应：results.<榜单>[0] 里的 data 与 next
        const page = model.grid.chart ? ((data.results && data.results[model.grid.chart]) || [])[0] || {} : data;
        const items = withAttrs(page.data || []);
        model.grid.items.push(...items);
        model.grid.next = page.next || '';
        appendGrid(items);
        sentinel.hidden = !model.grid.next;
      } catch (err) {
        if (token === loadToken) toast(t('browse.failed', { msg: err.message }));
        model.grid.next = '';
        sentinel.hidden = true;
      } finally {
        busy = false;
      }
    }, { rootMargin: '600px 0px' });
    moreObserver.observe(sentinel);
  }

  /* ---------- 页面 ---------- */
  function renderHeader() {
    const title = model ? model.title : '';
    $('title').classList.toggle('skeleton', !model);
    $('title').textContent = title || ' ';
    document.title = title ? `${title} · am-hook` : 'am-hook';
    $('notes').hidden = !(model && model.notes);
    $('notes').textContent = (model && model.notes) || '';
    const banner = $('banner');
    banner.hidden = !(model && model.banner);
    if (model && model.banner) {
      const art = model.banner;
      const ratio = art.width && art.height ? art.height / art.width : 9 / 16;
      banner.style.setProperty('--banner-ratio', String(art.width && art.height ? art.width / art.height : 16 / 9));
      if (art.bgColor) banner.style.setProperty('--art-bg', `#${art.bgColor}`);
      banner.replaceChildren(img(artUrl(art, 2400, Math.round(2400 * ratio), 'sr'), title));
    }
    renderGenres();
  }

  /** 排行榜「查看全部」的类型选择（官网 header 的 accessory select）：歌曲、专辑、视频榜可按类型筛选 */
  function renderGenres() {
    const tools = $('tools');
    const genres = (model && model.genres) || [];
    tools.hidden = !genres.length;
    if (!genres.length) { tools.replaceChildren(); return; }
    const select = el('select', { className: 'ed-select' }, ...genres.map((genre) => el('option', {
      value: genre.id, textContent: genre.id === ALL_GENRES ? t('charts.allGenres') : genre.attributes.name, selected: genre.id === page.genre,
    })));
    select.setAttribute('aria-label', t('charts.genre'));
    // 换类型只替换当前记录（与官网的 pushState 不同：同一路径的记录由页面自己处理，替换可避免「返回」停在同一页）
    select.addEventListener('change', () => navigate(chartHref(CHART_SLUGS[page.chart], select.value), { replace: true }));
    tools.replaceChildren(el('label', { className: 'ed-select-wrap' }, select));
  }

  /** 排行榜页面地址：/new/top-charts 跟随主地区，其余为固定地区；genre 为类型（所有类型时省略） */
  function chartHref(slug = '', genre = ALL_GENRES) {
    const path = `/new/top-charts${slug ? `/${slug}` : ''}`;
    const query = genre && genre !== ALL_GENRES ? `?genreId=${genre}` : '';
    return (page.follow ? path : `/https://music.apple.com/${country}${path}`) + query;
  }

  /** 排行榜首页（官网 bae）：歌曲（三行、带名次）、城市榜、每周热门 100 首、歌单、专辑、视频；带名次的榜单标题进入「查看全部」 */
  function renderCharts(results) {
    return Object.values(CHART_KEYS).map((key) => {
      const chart = ((results && results[key]) || [])[0];
      const items = withAttrs((chart && chart.data) || []);
      if (!items.length) return null;
      const ranked = RANKED_CHARTS.has(key);
      const head = headWith(chart.name || '', ranked ? chartHref(CHART_SLUGS[key]) : '');
      const rank = (i) => (ranked ? i + 1 : 0);
      if (key === 'songs') return section('ed-tracks-section', head, shelf('T', 3, items.map((track, i) => trackLockup(track, items, rank(i)))));
      if (key === 'music-videos') return section('', head, shelf('C', 1, items.map((res, i) => videoLockup(res, rank(i)))));
      return section('', head, shelf('G', 1, items.map((res, i) => squareLockup(res, rank(i)))));
    }).filter(Boolean);
  }

  function renderBody() {
    rows = new Map();
    const sections = model.grid ? [renderGrid()] : model.charts ? renderCharts(model.charts)
      : [model.mine && model.mine.length ? myStations(model.mine) : null, ...model.elements.map(renderElement)].filter(Boolean);
    $('sections').replaceChildren(...sections);
    if (!sections.length) showAlert('info', () => t('browse.empty'));
    syncRows(player.current, !player.transport().paused);
    watchMore();
  }

  function appleUrl() {
    if (!page) return 'https://music.apple.com/';
    if (page.kind === 'new') return `https://music.apple.com/${country}/new`;
    if (page.kind === 'radio') return `https://music.apple.com/${country}/radio`;
    if (page.kind === 'charts') {
      const slug = page.chart ? `/${CHART_SLUGS[page.chart]}` : '';
      return `https://music.apple.com/${country}/new/top-charts${slug}${page.genre !== ALL_GENRES ? `?genreId=${page.genre}` : ''}`;
    }
    return `https://music.apple.com/${country}/${page.kind}/${page.id}`;
  }

  /** tabs 根元素（382）下的区块；grouping 只有一个 tab */
  function groupingElements(grouping) {
    const tab = rel(grouping, 'tabs')[0];
    return tab ? withAttrs(rel(tab, 'children')) : [];
  }

  async function fetchModel(l) {
    const cc = country;
    switch (page.kind) {
      case 'charts': {
        if (!page.chart) {
          const data = await amp(`/v1/catalog/${cc}/charts`, { ...CHARTS_PARAMS, l });
          if (!data.results) throw new Error('empty response');
          return { title: t('charts.title'), charts: data.results };
        }
        // 「查看全部」（官网 TopChartSeeAllPageIntent）：一个榜单的全部内容，歌曲为列表，其余为网格，按名次分页加载
        const key = page.chart;
        const [data, genres] = await Promise.all([
          amp(`/v1/catalog/${cc}/charts`, { ...CHART_SEE_ALL_PARAMS, genre: page.genre, l }),
          GENRE_CHARTS.has(key) ? chartGenres(cc, l) : [],
        ]);
        const chart = ((data.results && data.results[key]) || [])[0];
        if (!chart) throw new Error('empty response');
        const items = withAttrs(chart.data || []);
        const genre = page.genre !== ALL_GENRES && genres.find((g) => g.id === page.genre);
        const title = genre ? t(`charts.genreTitle.${key}`, { genre: genre.attributes.name }) : chart.name || '';
        const layout = key === 'songs' ? 'L' : key === 'music-videos' ? 'C' : 'G';
        return { title, genres, grid: { items, next: chart.next || '', layout, chart: key, ranked: RANKED_CHARTS.has(key), pageParams: { 'include[songs]': 'artists', 'relate[songs]': 'albums' } } };
      }
      case 'new': {
        const data = await amp(`/v1/editorial/${cc}/groupings`, { ...GROUPING_PARAMS, name: 'music', l });
        const grouping = (data.data || [])[0];
        if (!grouping) throw new Error('empty response');
        return { title: t('nav.new'), elements: groupingElements(grouping) };
      }
      case 'radio': {
        // 填过 media-user-token 时同时取个人电台与最近播放（取不到时照常显示编辑内容，不弹出填写 token 的对话框）
        const mine = userToken() ? Promise.all([
          personalStation(cc, { l }).catch(() => null),
          recentStations({ l }).catch(() => []),
        ]) : Promise.resolve([null, []]);
        const [data, [personal, recent]] = await Promise.all([amp(`/v1/editorial/${cc}/groupings`, { ...GROUPING_PARAMS, name: 'radio', l }), mine]);
        const grouping = (data.data || [])[0];
        if (!grouping) throw new Error('empty response');
        const stations = [personal, ...recent.filter((r) => !personal || r.id !== personal.id)].filter(Boolean);
        return { title: t('nav.radio'), elements: groupingElements(grouping), mine: stations };
      }
      case 'grouping': {
        const data = await amp(`/v1/editorial/${cc}/groupings/${page.id}`, { ...GROUPING_PARAMS, 'include[groupings]': 'curator', l });
        const grouping = (data.data || [])[0];
        if (!grouping) throw new Error('empty response');
        return { title: (grouping.attributes && grouping.attributes.name) || '', elements: groupingElements(grouping) };
      }
      case 'multi-room': {
        const data = await amp(`/v1/editorial/${cc}/multirooms/${page.id}`, { ...MULTIROOM_PARAMS, l });
        const multi = (data.data || [])[0];
        if (!multi) throw new Error('empty response');
        const a = multi.attributes || {};
        return { title: a.title || a.name || '', banner: (a.uber && a.uber.masterArt) || null, elements: withAttrs(rel(multi, 'children')) };
      }
      case 'room': {
        const data = await amp(`/v1/editorial/${cc}/rooms/${page.id}`, { ...ROOM_PARAMS, l });
        const room = (data.data || [])[0];
        if (!room) throw new Error('empty response');
        const contents = room.relationships && room.relationships.contents;
        const items = withAttrs((contents && contents.data) || []);
        return { title: (room.attributes && (room.attributes.title || room.attributes.name)) || '', grid: { items, next: (contents && contents.next) || '', layout: gridLayout(items) } };
      }
      case 'curator': {
        const data = await amp(`/v1/catalog/${cc}`, { ...CURATOR_PARAMS, 'ids[curators]': page.id, 'ids[apple-curators]': page.id, l });
        const curator = (data.data || [])[0];
        if (!curator) throw new Error('empty response');
        const a = curator.attributes || {};
        const grouping = rel(curator, 'grouping')[0];
        const elements = grouping ? groupingElements(grouping) : [];
        if (elements.length) return { title: a.name || '', elements };
        // 没有分组的策展人（官网 AnyCuratorDetailSeeAll）：全部歌单的网格
        const playlists = curator.relationships && curator.relationships.playlists;
        const items = withAttrs((playlists && playlists.data) || []);
        return { title: a.name || '', notes: shortNotes(a), grid: { items, next: (playlists && playlists.next) || '', layout: 'G' } };
      }
      default:
        throw new Error('unknown page');
    }
  }

  async function load() {
    const token = ++loadToken;
    if (!model) showAlert('info', () => t('browse.loading'));
    $('apple-link').href = appleUrl();
    try {
      const l = await AmI18n.catalogLang(country);
      const next = await fetchModel(l);
      if (token !== loadToken || signal.aborted) return;
      model = { elements: [], ...next };
      showAlert('', '');
      renderHeader();
      renderBody();
    } catch (err) {
      if (token !== loadToken || signal.aborted) return;
      showAlert('error', () => t('browse.failed', { msg: err.message }));
      if (!model) { $('title').classList.remove('skeleton'); $('title').textContent = ' '; }
    }
  }

  /* ---------- 播放：曲目货架按区块顺序排队（见 AmPlayer.playQueue），离开页面后继续 ---------- */
  function playTrack(track, queue) {
    if (player.current && player.current.track === track.id) { player.toggle(); return; }
    const list = queue.filter(playable);
    player.playQueue(list.map((song) => songEntry(song, country)), Math.max(0, list.indexOf(track)));
  }

  function syncRows(current, playing) {
    for (const [id, list] of rows) {
      const active = !!current && current.track === id;
      for (const { row, playBtn } of list) {
        row.classList.toggle('playing', active);
        row.classList.toggle('paused', active && !playing);
        row.classList.toggle('loading', player.pendingTrack === id);
        if (playBtn) playBtn.innerHTML = active && playing ? ICON.pause : ICON.play;
      }
    }
  }
  player.onChange(syncRows);

  /** 新发现与排行榜没有 ID，其余编辑页需要 */
  const validPage = !!page && (page.kind === 'new' || page.kind === 'radio' || page.kind === 'charts' || !!page.id);

  // 切换界面语言或曲库语言：标题、区块名由 amp-api 按语言返回，重新获取
  onLangChange(() => {
    renderAlert();
    if (!validPage) return;
    if (model && !model.grid) {
      if (page.kind === 'new') model.title = t('nav.new');
      if (page.kind === 'radio') model.title = t('nav.radio');
      if (page.kind === 'charts') model.title = t('charts.title');
      renderHeader();
    }
    load();
  });
  // 「新发现」与排行榜（/new、/new/top-charts）跟随主地区
  if (page && page.follow) {
    signal.addEventListener('abort', AmI18n.onSettingsChange(({ kind }) => {
      if (kind !== 'storefront' || AmI18n.storefront === country) return;
      country = AmI18n.storefront;
      model = null;
      $('sections').replaceChildren();
      renderHeader();
      load();
    }), { once: true });
  }

  if (!validPage) {
    $('title').classList.remove('skeleton');
    showAlert('error', () => t('browse.badId'));
  } else {
    load();
    AmDecrypt.collectGarbage();
  }
}

// Apple Music 链接 → 本站页面。首页输入框（parseAppleLink）与编辑页 / 首页类别浏览里的编辑链接（resolveLink）共用。
// 本站页面地址就是 / 加上规整后的 Apple Music 链接（见 app.mjs 的路由与 src/links.rs）。
import { regionlessResource } from '../amp.mjs';

/** 与 app.mjs 的路由相同：本站能打开的 Apple Music 页面（规整后的地址） */
export const LOCAL_PAGE = /^https:\/\/music\.apple\.com\/[a-z]{2}\/(?:(?:song|music-video)\/[^/?#]+\/\d+|post\/(?:[^/?#]+\/)?\d+|(?:album|artist)\/(?:[^/?#]+\/)?\d+|playlist\/(?:[^/?#]+\/)?pl\.[\w-]+|(?:room|multi-room|grouping)\/\d+|curator\/(?:[^/?#]+\/)?\d+|station\/(?:[^/?#]+\/)?ra\.[\w.-]+|new\/?|radio\/?)$/;

/** 排行榜：地址中的榜单名（官网 kH）→ charts 接口 results 的键，按官网排行榜首页的顺序 */
export const CHART_KEYS = {
  songs: 'songs', 'city-charts': 'cityCharts', 'daily-global-top-charts': 'dailyGlobalTopCharts',
  playlists: 'playlists', albums: 'albums', 'music-videos': 'music-videos',
};
export const CHARTS_LINK = /^https:\/\/music\.apple\.com\/([a-z]{2})\/new\/top-charts(?:\/([a-z-]+))?\/?$/i;

/**
 * 把用户粘贴的链接规整为本站页面对应的 Apple Music 地址（不带开头的 /），无法识别时返回 null：
 * https://music.apple.com/{cc}/(song|music-video|post|album|playlist|artist|room|multi-room|grouping|curator|new|new/top-charts)/…
 */
export function parseAppleLink(raw) {
  const value = String(raw || '').trim();
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!/(^|\.)music\.apple\.com$/i.test(url.hostname)) return null;
  const regionless = `https://music.apple.com${url.pathname}`;
  if (regionlessResource('/' + regionless)) return regionless + url.search + url.hash;
  const parts = url.pathname.split('/').filter(Boolean);
  const cc = /^[a-z]{2}$/i.test(parts[0] || '') ? parts[0].toLowerCase() : 'us';
  const mv = url.pathname.match(/^\/[a-z]{2}\/music-video\/(?:([^/]+)\/)?(\d+)\/?$/i);
  if (mv) return `https://music.apple.com/${cc}/music-video/${mv[1] || '_'}/${mv[2]}`;
  // 艺人上传的视频（post，slug 可省略）
  const post = url.pathname.match(/^\/[a-z]{2}\/post\/(?:[^/]+\/)?(\d+)\/?$/i);
  if (post) return `https://music.apple.com/${cc}/post/${post[1]}`;
  const song = url.pathname.match(/\/song\/([^/]+)\/(\d+)/i);
  if (song) return `https://music.apple.com/${cc}/song/${song[1]}/${song[2]}`;
  // 专辑链接打开专辑页（slug 可省略）；带 ?i= 时保留，专辑页选中该曲目
  const albumPage = url.pathname.match(/^\/[a-z]{2}\/album\/(?:([^/]+)\/)?(\d+)\/?$/i);
  const trackId = url.searchParams.get('i');
  if (albumPage) return `https://music.apple.com/${cc}/album/${albumPage[1] || '_'}/${albumPage[2]}${trackId && /^\d+$/.test(trackId) ? `?i=${trackId}` : ''}`;
  // 歌单链接打开歌单页（ID 形如 pl.xxx / pl.u-xxx，slug 可省略）
  const playlistPage = url.pathname.match(/^\/[a-z]{2}\/playlist\/(?:([^/]+)\/)?(pl\.[\w-]+)\/?$/i);
  if (playlistPage) return `https://music.apple.com/${cc}/playlist/${playlistPage[1] || '_'}/${playlistPage[2]}`;
  // 艺人链接打开艺人页（slug 可省略）
  const artistPage = url.pathname.match(/^\/[a-z]{2}\/artist\/(?:([^/]+)\/)?(\d+)\/?$/i);
  if (artistPage) return `https://music.apple.com/${cc}/artist/${artistPage[1] || '_'}/${artistPage[2]}`;
  // 编辑页：新发现、room、multi-room、grouping 与 curator（见 browse.mjs）
  if (/^\/[a-z]{2}\/new\/?$/i.test(url.pathname)) return `https://music.apple.com/${cc}/new`;
  // 排行榜与各榜单的「查看全部」（?genreId= 为类型）
  const charts = url.pathname.match(/^\/[a-z]{2}\/new\/top-charts(?:\/(songs|playlists|albums|music-videos|city-charts|daily-global-top-charts))?\/?$/i);
  const genreId = url.searchParams.get('genreId');
  if (charts) return `https://music.apple.com/${cc}/new/top-charts${charts[1] ? `/${charts[1].toLowerCase()}` : ''}${charts[1] && /^\d+$/.test(genreId || '') ? `?genreId=${genreId}` : ''}`;
  const editorial = url.pathname.match(/^\/[a-z]{2}\/(room|multi-room|grouping)\/(\d+)\/?$/i);
  if (editorial) return `https://music.apple.com/${cc}/${editorial[1].toLowerCase()}/${editorial[2]}`;
  const curator = url.pathname.match(/^\/[a-z]{2}\/curator\/(?:([^/]+)\/)?(\d+)\/?$/i);
  if (curator) return `https://music.apple.com/${cc}/curator/${curator[1] || '_'}/${curator[2]}`;
  return null;
}

/**
 * 编辑数据里的链接 → { href, local }：本站能打开的为站内地址，其余为外部链接（新标签页打开）。
 * 链接有多种写法：music.apple.com/{cc}/room/{id}、/cn/room/{id}（相对路径）、
 * itunes.apple.com/.../collection/...?fcId={room}、MZStore.woa/wa/viewGrouping?id=&cc=、viewFeature?id=（multi-room）、
 * viewRoom?fcId=、viewTop?genreId=（排行榜）。country 为链接没写地区时使用的地区。
 */
export function resolveLink(raw, country) {
  if (!raw) return null;
  let link;
  try { link = new URL(raw, 'https://music.apple.com'); } catch { return null; }
  // 只接受 http(s)：javascript: / data: 之类的地址不会成为页面上的链接
  if (!/^https?:$/.test(link.protocol)) return null;
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

// 歌单页（/https://music.apple.com/{cc}/playlist/{slug}/pl.{id}），由 app.mjs 挂载
import { createActions, ICON as ACTION_ICON, openAlacCheck, playable, targetOf, localPath } from './actions.mjs';
import { createDetailHeader } from './detail-header.mjs';
import { openDownloadDialog } from './download-dialog.mjs';

const { formatTime, qualityIcon } = window.AmHook;
const { AmDecrypt, AmI18n } = window;
const { t } = AmI18n;

export const bodyClass = 'album-page playlist-page';

export function mount({ root, url, signal, player, navigate, onLangChange, toast }) {
  document.title = t('playlist.pageTitle');
  const actions = createActions({ signal, player, navigate, toast });
  const $ = (id) => root.querySelector(`#${id}`);
  const pageUrl = decodeURIComponent(url.pathname.slice(1));
  const linkMatch = pageUrl.match(/music\.apple\.com\/([a-z]{2})\/playlist\/(?:[^/?#]+\/)?(pl\.[\w-]+)/i) || [];
  const country = (linkMatch[1] || 'us').toLowerCase();
  const playlistId = linkMatch[2];

  /** 当前歌单（amp-api playlists 资源）与其中的曲目 */
  let playlist = null;
  let tracks = [];
  // 头部只留随机播放、播放与「更多」：下载、喜爱、资料库（Apple Music 歌单本身）、添加到歌单、复制链接等收进菜单，顺序见设置中心
  const moreBtn = actions.headerMenu(() => (playlist ? {
    target: targetOf(playlist, country, { collection: { resource: playlist, tracks } }),
    // 下载（批量浏览器内解密，带标签、封面与歌词）：选择音质与曲目后交给下载中心
    entries: songs().length ? {
      download: { icon: ACTION_ICON.download, label: t('dlc.downloadPlaylist'), onSelect: () => openDownloadDialog({ kind: 'playlist', resource: playlist, tracks, country, navigate, toast }) },
    } : {},
  } : null));
  moreBtn.disabled = true;
  // 检测 ALAC（见 alac-check-dialog.mjs），与专辑页相同
  const checkBtn = Object.assign(document.createElement('button'), { className: 'detail-circle-btn', type: 'button', hidden: true, innerHTML: ACTION_ICON.check });
  checkBtn.addEventListener('click', () => {
    if (playlist) openAlacCheck({ kind: 'playlist', id: playlistId, country, resource: playlist, tracks, toast }).catch((err) => toast(err.message));
  });
  root.querySelector('.detail-actions').append(Object.assign(document.createElement('span'), { className: 'detail-extra' }));
  root.querySelector('.detail-extra').append(checkBtn, moreBtn);
  let rows = new Map();
  let notesExpanded = false;
  let loadToken = 0;

  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z" fill="currentColor"/></svg>',
  };

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
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

  /* ---------- amp-api：与 music.apple.com 歌单页相同的 playlists 请求，经服务端 /amp 代理 ---------- */
  // l 按地区支持的语言选择，见 AmI18n.catalogLang
  /** 曲目字段：首次请求与 tracks 分页请求共用 */
  const TRACK_PARAMS = {
    'include[songs]': 'artists',
    'include[music-videos]': 'artists',
    'fields[artists]': 'name,artwork,url',
    'fields[songs]': 'name,artistName,curatorName,composerName,artwork,playParams,contentRating,albumName,url,durationInMillis,audioTraits,extendedAssetUrls',
    'fields[albums]': 'name,artwork,playParams,url',
  };
  const PLAYLIST_PARAMS = {
    platform: 'web',
    extend: 'offers,editorialArtwork,editorialVideo,trackCount',
    'art[url]': 'f',
    include: 'tracks,curator',
    'omit[resource]': 'autos',
    'limit[tracks]': '300',
    'fields[curators]': 'name,url',
    'fields[apple-curators]': 'name,url',
    'limit[view.more-by-curator]': '15',
    'limit[view.featured-artists]': '15',
    views: 'more-by-curator,featured-artists',
    ...TRACK_PARAMS,
  };

  async function amp(path, params) {
    const url = new URL('/amp' + path, location.origin);
    // 值为 undefined 的参数不传（如地区不支持当前语言时的 l）
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

  /** artwork.url 模板：{w}x{h}{c}.{f} */
  function artUrl(artwork, w, h = w) {
    return artwork && artwork.url ? artwork.url.replace('{w}', w).replace('{h}', h).replace('{c}', 'bb').replace('{f}', 'jpg') : '';
  }

  /** 目录资源的 url → 本站页面路径；识别不了时按类型与 ID 拼出 */
  function pagePath(resource) {
    const url = (resource.attributes && resource.attributes.url) || '';
    if (resource.type === 'playlists') {
      const m = url.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/playlist\/([^/?#]+)\/(pl\.[\w-]+)/i);
      return m ? `/https://music.apple.com/${m[1].toLowerCase()}/playlist/${m[2]}/${m[3]}` : `/https://music.apple.com/${country}/playlist/_/${resource.id}`;
    }
    const kind = { songs: 'song', 'music-videos': 'music-video', albums: 'album', artists: 'artist' }[resource.type];
    const m = url.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/(song|music-video|album|artist)\/([^/?#]+)\/(\d+)/i);
    if (m && m[2] === kind) return `/https://music.apple.com/${m[1].toLowerCase()}/${kind}/${m[3]}/${m[4]}`;
    // 歌单内曲目的 url 是 album/...?i=<id>，统一转成歌曲页
    const slug = url.match(/\/album\/([^/?#]+)\//);
    return `/https://music.apple.com/${country}/${kind}/${slug ? slug[1] : '_'}/${resource.id}`;
  }

  /** 曲目所属专辑的本站页面路径：取自曲目 url（album/<slug>/<id>?i=...） */
  function albumPath(track) {
    const m = ((track.attributes && track.attributes.url) || '').match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/album\/([^/?#]+)\/(\d+)/i);
    return m ? `/https://music.apple.com/${m[1].toLowerCase()}/album/${m[2]}/${m[3]}` : '';
  }

  /** description / editorialNotes 是 HTML，只取纯文本 */
  function plainText(html) {
    return new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();
  }

  function formatDate(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? ''
      : new Intl.DateTimeFormat(AmI18n.lang === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'long' }).format(date);
  }

  const explicitBadge = () => el('span', { className: 'explicit', textContent: 'E', title: t('search.explicit') });

  /** 编辑歌单的封面在 editorialArtwork.staticDetailSquare，用户歌单只有 artwork */
  function coverArtwork() {
    const a = playlist.attributes;
    return (a.editorialArtwork && a.editorialArtwork.staticDetailSquare) || a.artwork;
  }

  /* ---------- 渲染 ---------- */
  function renderHero() {
    const a = playlist.attributes;
    document.title = `${a.name} · am-hook`;
    $('title').classList.remove('skeleton');
    $('title').textContent = a.name;

    // 歌单作者：编辑歌单是 Apple Music 或某个策展人（curator / apple-curator / 艺人），链接到本站的策展人页或艺人页；
    // 本站打不开的地址才链接到 Apple Music
    const curator = ((playlist.relationships && playlist.relationships.curator && playlist.relationships.curator.data) || [])[0];
    const curatorName = (curator && curator.attributes && curator.attributes.name) || a.curatorName || '';
    const curatorUrl = curator && curator.attributes && curator.attributes.url;
    const curatorPath = localPath(curatorUrl)
      || (curator && ['curators', 'apple-curators'].includes(curator.type) && /^\d+$/.test(curator.id) ? `/https://music.apple.com/${country}/curator/_/${curator.id}` : '');
    $('artist').classList.remove('skeleton');
    $('artist').replaceChildren(curatorPath ? el('a', { href: curatorPath, textContent: curatorName })
      : curatorUrl ? el('a', { href: curatorUrl, target: '_blank', rel: 'noreferrer', textContent: curatorName })
      : curatorName);

    const updated = a.lastModifiedDate ? formatDate(a.lastModifiedDate) : '';
    $('sub').textContent = updated ? t('playlist.updated', { date: updated }) : '';

    const traits = a.audioTraits || [];
    const badges = [];
    if (traits.includes('hi-res-lossless')) badges.push('hires');
    else if (traits.includes('lossless')) badges.push('lossless');
    if (traits.includes('atmos')) badges.push('atmos');
    $('badges').replaceChildren(...badges.map((key) => qualityIcon(key)));

    const desc = a.description || a.editorialNotes || {};
    const notes = plainText(desc.standard || desc.short || '');
    $('notes').hidden = !notes;
    $('hero').classList.toggle('no-notes', !notes);
    $('notes-text').textContent = notes;
    $('notes').classList.toggle('expanded', notesExpanded);
    requestAnimationFrame(() => {
      const text = $('notes-text');
      $('notes-more').hidden = !notesExpanded && text.scrollHeight <= text.clientHeight + 1;
      $('notes-more').textContent = t(notesExpanded ? 'album.less' : 'album.more');
    });

    renderHeader({ cover: coverArtwork(), attrs: a, alt: t('album.coverAlt', { title: a.name }) });
  }
  const renderHeader = createDetailHeader({ $, signal, artUrl, rerender: () => { if (playlist) renderHero(); } });

  /** 可播放的歌曲：播放队列只含这些 */
  const songs = () => tracks.filter((track) => track.type === 'songs' && playable(track));

  /** 曲目艺人：在 artistName 中依次找到各关联艺人的名字并链接到艺人页，分隔符（&、逗号、feat. 等）保留为文字 */
  function trackArtists(track) {
    const name = track.attributes.artistName || '';
    const artists = ((track.relationships && track.relationships.artists && track.relationships.artists.data) || [])
      .filter((artist) => artist.attributes && artist.attributes.name);
    const parts = [];
    let pos = 0;
    for (const artist of artists) {
      const i = name.indexOf(artist.attributes.name, pos);
      if (i < 0) continue;
      if (i > pos) parts.push(name.slice(pos, i));
      parts.push(el('a', { href: pagePath(artist), textContent: artist.attributes.name }));
      pos = i + artist.attributes.name.length;
    }
    if (pos < name.length) parts.push(name.slice(pos));
    return parts;
  }

  /** 曲目行（官网 songs-list-row--playlist）：封面、歌名与艺人两行、专辑列、时长 */
  function renderTracks() {
    const chart = !!playlist.attributes.isChart;
    rows = new Map();
    const nodes = tracks.map((track, i) => {
      const a = track.attributes;
      const video = track.type === 'music-videos';
      // 尚未发行的曲目：与官网一样置灰，不能播放；歌曲页与专辑页在目录中查不到，不做链接
      const unavailable = !playable(track);
      const href = pagePath(track);

      const src = artUrl(a.artwork, 80);
      const cover = el('span', { className: `track-art${video ? ' mv' : ''}` },
        src ? el('img', { src, alt: '', loading: 'lazy', decoding: 'async' }) : el('span', { className: 'ph' }),
        el('span', { className: 'eq', ariaHidden: 'true' }, el('i'), el('i'), el('i'), el('i')));
      let playBtn = null;
      if (!video && !unavailable) {
        playBtn = el('button', { className: 'track-play', type: 'button', innerHTML: ICON.play });
        playBtn.setAttribute('aria-label', t('album.playTrack', { name: a.name }));
        playBtn.addEventListener('click', () => playTrack(track));
        cover.append(playBtn);
      }

      const title = el(unavailable ? 'span' : 'a', { className: 'track-title', textContent: a.name, ...(unavailable ? {} : { href }) });
      const main = el('div', { className: 'track-main' },
        el('div', { className: 'track-line' }, title, a.contentRating === 'explicit' ? explicitBadge() : '',
          video ? el('span', { className: 'track-kind', innerHTML: ICON.video, title: t('album.video') }) : null),
        el('div', { className: 'track-artist' }, ...trackArtists(track)));
      const albumHref = unavailable ? '' : albumPath(track);
      const albumCol = albumHref && a.albumName ? el('a', { className: 'track-album', href: albumHref, textContent: a.albumName })
        : el('span', { className: 'track-album', textContent: a.albumName || '' });
      // 「更多」菜单：播放按歌单顺序排队
      const more = actions.moreButton(targetOf(track, country, { albumHref, ...(video || unavailable ? {} : { onPlay: () => playTrack(track) }) }));

      const row = el('div', { className: `track pl-track${video ? ' video' : ''}${unavailable ? ' unavailable' : ''}` }, cover,
        chart ? el('span', { className: 'track-rank', textContent: String(i + 1) }) : null, main, albumCol,
        el('span', { className: 'track-time', textContent: a.durationInMillis ? formatTime(a.durationInMillis / 1000) : '' }), more);
      if (!video && !unavailable) row.addEventListener('dblclick', (e) => { if (!e.target.closest('a, button')) playTrack(track); });
      rows.set(track.id, { row, playBtn });
      return row;
    });
    $('tracks').classList.toggle('chart', chart);
    $('tracks').replaceChildren(...nodes);
    $('tracks').hidden = false;
    $('play-all').disabled = $('shuffle').disabled = songs().length === 0;
    syncRows(player.current, !player.transport().paused);
  }

  function renderFooter() {
    const songCount = tracks.filter((track) => track.type === 'songs').length;
    const videoCount = tracks.length - songCount;
    const minutes = Math.round(tracks.reduce((sum, track) => sum + (track.attributes.durationInMillis || 0), 0) / 60000);
    const length = minutes >= 60 ? t('album.hours', { h: Math.floor(minutes / 60), m: minutes % 60 }) : t('album.minutes', { n: minutes });
    const line = [songCount && t('album.songs', { n: songCount }), videoCount && t('album.videos', { n: videoCount }), minutes && length]
      .filter(Boolean).join(AmI18n.lang === 'zh' ? '，' : ', ');
    $('footer').replaceChildren(...(line ? [el('p', { textContent: line })] : []));
    $('footer').hidden = !line;
  }

  /** 下方货架：与官网相同的 views（策展人的更多歌单、精选艺人），艺人链接到本站艺人页 */
  const VIEWS = ['more-by-curator', 'featured-artists'];
  function renderShelves() {
    const sections = [];
    for (const key of VIEWS) {
      const view = playlist.views && playlist.views[key];
      const items = ((view && view.data) || []).filter((res) => res.attributes && ['playlists', 'albums', 'artists'].includes(res.type));
      if (!items.length) continue;
      const shelf = el('div', { className: 'shelf' }, ...items.map((res) => {
        const a = res.attributes;
        const artist = res.type === 'artists';
        const src = artUrl(a.artwork, 360);
        const cover = el('span', { className: artist ? 'shelf-art artist' : 'shelf-art' },
          src ? el('img', { src, alt: '', loading: 'lazy', decoding: 'async' }) : el('span', { className: 'ph' }));
        const sub = res.type === 'playlists' ? a.curatorName : a.artistName;
        const item = el('a', { className: artist ? 'shelf-item artist' : 'shelf-item', href: pagePath(res) },
          cover, el('span', { className: 'shelf-title', textContent: a.name }), artist ? null : el('span', { className: 'shelf-sub', textContent: sub || '' }));
        return actions.wrapCard(item, targetOf(res, country));
      }));
      sections.push(el('section', { className: 'shelf-section' },
        el('h2', { className: 'shelf-heading', textContent: (view.attributes && view.attributes.title) || key }), shelf));
    }
    $('shelves').replaceChildren(...sections);
  }

  function render() {
    renderHero();
    renderTracks();
    renderFooter();
    renderShelves();
    moreBtn.disabled = false;
    checkBtn.hidden = !songs().length;
    checkBtn.title = t('ac.button');
    checkBtn.setAttribute('aria-label', checkBtn.title);
  }

  async function loadPlaylist() {
    const token = ++loadToken;
    if (!playlist) showAlert('info', () => t('playlist.loading'));
    try {
      const l = await AmI18n.catalogLang(country);
      const data = await amp(`/v1/catalog/${country}/playlists/${playlistId}`, { l, ...PLAYLIST_PARAMS });
      const next = data.data && data.data[0];
      if (!next) throw new Error('empty response');
      const rel = next.relationships && next.relationships.tracks;
      let list = (rel && rel.data) || [];
      // 首次请求最多 300 首，其余分页获取
      for (let more = rel && rel.next; more;) {
        const page = await amp(more, { l, ...TRACK_PARAMS });
        list = list.concat(page.data || []);
        more = page.next;
      }
      if (token !== loadToken || signal.aborted) return;
      playlist = next;
      tracks = list.filter((track) => track.attributes);
      render();
      showAlert('', '');
    } catch (err) {
      if (token !== loadToken || signal.aborted) return;
      showAlert('error', () => t('playlist.failed', { msg: err.message }));
    }
  }

  /* ---------- 播放：队列交给播放器（见 player.js），逐首选浏览器能播放的最高音质，播完自动下一首；离开页面后继续 ---------- */
  function entryFor(track) {
    const a = track.attributes;
    return {
      track: track.id,
      country,
      name: a.name,
      artist: a.artistName,
      // 各位艺人的名字与本站艺人页路径，歌词界面用来把艺人行中的名字做成链接
      artists: ((track.relationships && track.relationships.artists && track.relationships.artists.data) || [])
        .filter((artist) => artist.attributes && artist.attributes.name)
        .map((artist) => ({ name: artist.attributes.name, href: pagePath(artist) })),
      album: a.albumName || playlist.attributes.name,
      href: pagePath(track),
      albumHref: a.albumName ? albumPath(track) : '',
      artwork: artUrl(a.artwork || coverArtwork(), 600),
      duration: a.durationInMillis || 0,
    };
  }

  /** order：songs() 中的下标，按原顺序；options.shuffle 同时开关随机播放（见 AmPlayer.playQueue） */
  function playOrder(order, pos = 0, options) {
    const list = songs();
    player.playQueue(order.map((i) => entryFor(list[i])), pos, options);
  }

  function playTrack(track) {
    if (player.current && player.current.track === track.id) { player.toggle(); return; }
    const list = songs();
    playOrder(list.map((_, i) => i), list.indexOf(track));
  }

  $('play-all').addEventListener('click', () => playOrder(songs().map((_, i) => i), 0, { shuffle: false }));
  $('shuffle').addEventListener('click', () => {
    const count = songs().length;
    playOrder([...Array(count).keys()], Math.floor(Math.random() * count), { shuffle: true });
  });

  function syncRows(current, playing) {
    for (const [id, { row, playBtn }] of rows) {
      const active = !!current && current.track === id;
      row.classList.toggle('playing', active);
      row.classList.toggle('paused', active && !playing);
      row.classList.toggle('loading', player.pendingTrack === id);
      if (playBtn) playBtn.innerHTML = active && playing ? ICON.pause : ICON.play;
    }
  }
  player.onChange(syncRows);

  $('notes-more').addEventListener('click', () => {
    notesExpanded = !notesExpanded;
    renderHero();
  });

  // 切换语言：名称、简介和货架标题由 amp-api 按语言返回，重新获取
  onLangChange(() => {
    renderAlert();
    if (playlist) render();
    if (playlistId) loadPlaylist();
  });

  if (!playlistId) {
    showAlert('error', () => t('playlist.badId'));
  } else {
    loadPlaylist();
    AmDecrypt.collectGarbage();
  }
}

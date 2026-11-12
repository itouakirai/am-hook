// 专辑页（/https://music.apple.com/{cc}/album/{slug}/{id}），由 app.mjs 挂载
import { createActions, ICON as ACTION_ICON, openAlacCheck, playable, targetOf } from './actions.mjs';
import { createDetailHeader } from './detail-header.mjs';
import { openDownloadDialog } from './download-dialog.mjs';

const { formatTime, qualityIcon } = window.AmHook;
const { AmDecrypt, AmI18n } = window;
const { t } = AmI18n;

export const bodyClass = 'album-page';

export function mount({ root, url, signal, player, navigate, onLangChange, toast, restoring }) {
  document.title = t('album.pageTitle');
  const actions = createActions({ signal, player, navigate, toast });
  const $ = (id) => root.querySelector(`#${id}`);
  const pageUrl = decodeURIComponent(url.pathname.slice(1));
  const linkMatch = pageUrl.match(/music\.apple\.com\/([a-z]{2})\/album\/(?:([^/?#]+)\/)?(\d+)/i) || [];
  const country = (linkMatch[1] || 'us').toLowerCase();
  const albumId = linkMatch[3];

  // 带 ?i= 的专辑分享链接指向其中一首歌：与官网一样打开专辑页，选中该曲目并滚动到它
  const trackParam = url.searchParams.get('i');
  /** 选中（高亮）的曲目 ID：来自 ?i=，之后单击曲目行切换，单击曲目行以外的地方取消 */
  let selectedId = /^\d+$/.test(trackParam || '') ? trackParam : null;
  // 前进 / 后退恢复了原滚动位置时不再滚动到选中的曲目
  let revealPending = !!selectedId && !restoring;

  /** 当前专辑（amp-api albums 资源）与其中的曲目 */
  let album = null;
  let tracks = [];
  // 头部只留随机播放、播放与「更多」：下载、喜爱、资料库（专辑连同全部曲目，曲目已取到，不再重新请求）、添加到歌单、复制链接等收进菜单，顺序见设置中心
  const moreBtn = actions.headerMenu(() => (album ? {
    target: targetOf(album, country, { collection: { resource: album, tracks } }),
    // 下载（批量浏览器内解密，带标签、封面与歌词）：选择音质与曲目后交给下载中心
    entries: songs().length ? {
      download: { icon: ACTION_ICON.download, label: t('dlc.downloadAlbum'), onSelect: () => openDownloadDialog({ kind: 'album', resource: album, tracks, country, navigate, toast }) },
    } : {},
  } : null));
  moreBtn.disabled = true;
  // 检测 ALAC（见 alac-check-dialog.mjs）：有歌曲的专辑才显示，网页版的 master m3u8 取自曲目的 extendedAssetUrls.enhancedHls；
  // 曲目「更多」菜单里也有，只检测那一首
  const checkBtn = Object.assign(document.createElement('button'), { className: 'detail-circle-btn', type: 'button', hidden: true, innerHTML: ACTION_ICON.check });
  checkBtn.addEventListener('click', () => {
    if (album) openAlacCheck({ kind: 'album', id: albumId, country, resource: album, tracks, toast }).catch((err) => toast(err.message));
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

  /* ---------- amp-api：与 music.apple.com 专辑页相同的 albums 请求，经服务端 /amp 代理 ---------- */
  // l 按地区支持的语言选择，见 AmI18n.catalogLang
  const ALBUM_PARAMS = {
    platform: 'web',
    extend: 'offers,editorialArtwork,editorialVideo,extendedAssetUrls',
    'art[url]': 'f',
    include: 'record-labels,artists',
    'meta[albums:tracks]': 'popularity',
    'include[songs]': 'artists,composers,albums',
    'include[music-videos]': 'artists',
    'include[playlists]': 'curator',
    'fields[artists]': 'name,url',
    'fields[record-labels]': 'name,url',
    'fields[curators]': 'name',
    views: 'appears-on,more-by-artist,related-videos,other-versions,you-might-also-like,audio-extras,video-extras',
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
    const kind = { songs: 'song', 'music-videos': 'music-video', albums: 'album', artists: 'artist' }[resource.type];
    const m = url.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/(song|music-video|album|artist)\/([^/?#]+)\/(\d+)/i);
    if (m && m[2] === kind) return `/https://music.apple.com/${m[1].toLowerCase()}/${kind}/${m[3]}/${m[4]}`;
    // 专辑内曲目的 url 是 album/...?i=<id>，统一转成歌曲页
    const slug = url.match(/\/album\/([^/?#]+)\//);
    return `/https://music.apple.com/${country}/${kind}/${slug ? slug[1] : '_'}/${resource.id}`;
  }

  /** editorialNotes 是 HTML，只取纯文本 */
  function plainText(html) {
    return new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();
  }

  const explicitBadge = () => el('span', { className: 'explicit', textContent: 'E', title: t('search.explicit') });

  /* ---------- 渲染 ---------- */
  function renderHero() {
    const a = album.attributes;
    document.title = `${a.name} · am-hook`;
    $('title').classList.remove('skeleton');
    $('title').replaceChildren(a.name, a.contentRating === 'explicit' ? explicitBadge() : '');

    const artists = ((album.relationships && album.relationships.artists && album.relationships.artists.data) || [])
      .filter((artist) => artist.attributes && artist.attributes.name);
    const artistEl = $('artist');
    artistEl.classList.remove('skeleton');
    // 艺人名链接到本站艺人页
    artistEl.replaceChildren(...(artists.length && artists.map((artist) => artist.attributes.name).join(' & ') === a.artistName
      ? artists.flatMap((artist, i) => [i ? ' & ' : '', el('a', { href: pagePath(artist), textContent: artist.attributes.name })])
      : [a.artistName || '']));

    const year = (a.releaseDate || '').slice(0, 4);
    $('sub').textContent = [(a.genreNames || [])[0], year].filter(Boolean).join(' · ');

    const traits = a.audioTraits || [];
    // 音质标志与播放条同一套图标
    const badges = [];
    if (traits.includes('hi-res-lossless')) badges.push('hires');
    else if (traits.includes('lossless')) badges.push('lossless');
    if (traits.includes('atmos')) badges.push('atmos');
    if (a.isMasteredForItunes) badges.push('adm');
    $('badges').replaceChildren(...badges.map((key) => qualityIcon(key)));

    const notes = plainText((a.editorialNotes && (a.editorialNotes.standard || a.editorialNotes.short)) || '');
    $('notes').hidden = !notes;
    $('hero').classList.toggle('no-notes', !notes);
    $('notes-text').textContent = notes;
    $('notes').classList.toggle('expanded', notesExpanded);
    requestAnimationFrame(() => {
      const text = $('notes-text');
      $('notes-more').hidden = !notesExpanded && text.scrollHeight <= text.clientHeight + 1;
      $('notes-more').textContent = t(notesExpanded ? 'album.less' : 'album.more');
    });

    renderHeader({ cover: a.artwork, attrs: a, alt: t('album.coverAlt', { title: a.name }) });
  }
  const renderHeader = createDetailHeader({ $, signal, artUrl, rerender: () => { if (album) renderHero(); } });

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

  function renderTracks() {
    const albumArtist = album.attributes.artistName;
    const discs = new Set(tracks.map((track) => track.attributes.discNumber || 1));
    rows = new Map();
    const nodes = [];
    let lastDisc = null;
    for (const track of tracks) {
      const a = track.attributes;
      const disc = a.discNumber || 1;
      if (discs.size > 1 && disc !== lastDisc) {
        lastDisc = disc;
        nodes.push(el('h2', { className: 'disc-title', textContent: t('album.disc', { n: disc }) }));
      }
      const video = track.type === 'music-videos';
      // 尚未发行的曲目：与官网一样置灰，不能播放，歌曲页在目录中查不到，不做链接
      const unavailable = !playable(track);
      const href = pagePath(track);
      const popular = !video && track.meta && track.meta.popularity >= 0.7;

      const index = video ? el('span', { className: 'track-index', innerHTML: ICON.video })
        : el('span', { className: 'track-index', textContent: String(a.trackNumber || '') });
      const num = el('span', { className: 'track-num' }, index,
        el('span', { className: 'eq', ariaHidden: 'true' }, el('i'), el('i'), el('i'), el('i')));
      let playBtn = null;
      if (!video && !unavailable) {
        playBtn = el('button', { className: 'track-play', type: 'button', innerHTML: ICON.play });
        playBtn.setAttribute('aria-label', t('album.playTrack', { name: a.name }));
        playBtn.addEventListener('click', () => playTrack(track));
        num.append(playBtn);
      }
      if (popular) num.append(el('span', { className: 'track-pop', title: t('album.popular') }));

      const title = el(unavailable ? 'span' : 'a', { className: 'track-title', textContent: a.name, ...(unavailable ? {} : { href }) });
      const main = el('div', { className: 'track-main' },
        el('div', { className: 'track-line' }, title, a.contentRating === 'explicit' ? explicitBadge() : ''),
        a.artistName && a.artistName !== albumArtist ? el('div', { className: 'track-artist' }, ...trackArtists(track)) : null);
      // 「更多」菜单：播放按专辑顺序排队
      const more = actions.moreButton(targetOf(track, country, video || unavailable ? {} : { onPlay: () => playTrack(track) }));

      const row = el('div', { className: `track${video ? ' video' : ''}${unavailable ? ' unavailable' : ''}` }, num, main,
        el('span', { className: 'track-time', textContent: a.durationInMillis ? formatTime(a.durationInMillis / 1000) : '' }), more);
      if (!video && !unavailable) row.addEventListener('dblclick', (e) => { if (!e.target.closest('a, button')) playTrack(track); });
      row.addEventListener('click', (e) => { if (!e.target.closest('a, button')) select(track.id); });
      rows.set(track.id, { row, playBtn });
      nodes.push(row);
    }
    $('tracks').replaceChildren(...nodes);
    $('tracks').hidden = false;
    $('play-all').disabled = $('shuffle').disabled = songs().length === 0;
    syncRows(player.current, !player.transport().paused);
    select(selectedId);
    const target = revealPending && rows.get(selectedId);
    if (target) {
      revealPending = false;
      target.row.scrollIntoView({ block: 'center' });
    }
  }

  function select(id) {
    selectedId = id;
    for (const [trackId, { row }] of rows) row.classList.toggle('selected', trackId === id);
  }
  document.addEventListener('pointerdown', (e) => {
    if (selectedId && !(e.target instanceof Element && e.target.closest('.track'))) select(null);
  }, { signal });

  function renderFooter() {
    const a = album.attributes;
    const lines = [];
    if (a.releaseDate) {
      const date = new Date(`${a.releaseDate}T00:00:00`);
      lines.push(Number.isNaN(date.getTime()) ? a.releaseDate
        : new Intl.DateTimeFormat(AmI18n.lang === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'long' }).format(date));
    }
    const songCount = tracks.filter((track) => track.type === 'songs').length;
    const videoCount = tracks.length - songCount;
    const minutes = Math.round(tracks.reduce((sum, track) => sum + (track.attributes.durationInMillis || 0), 0) / 60000);
    const length = minutes >= 60 ? t('album.hours', { h: Math.floor(minutes / 60), m: minutes % 60 }) : t('album.minutes', { n: minutes });
    lines.push([songCount && t('album.songs', { n: songCount }), videoCount && t('album.videos', { n: videoCount }), minutes && length].filter(Boolean).join(AmI18n.lang === 'zh' ? '，' : ', '));
    if (a.copyright) lines.push(a.copyright);
    if (a.recordLabel && !(a.copyright || '').includes(a.recordLabel)) lines.push(a.recordLabel);
    $('footer').replaceChildren(...lines.map((line) => el('p', { textContent: line })));
    $('footer').hidden = !lines.length;
  }

  /** 下方货架：与官网相同的 views，只保留本站能打开的专辑与 MV */
  const VIEWS = ['other-versions', 'related-videos', 'video-extras', 'more-by-artist', 'appears-on', 'you-might-also-like', 'audio-extras'];
  function renderShelves() {
    const sections = [];
    for (const key of VIEWS) {
      const view = album.views && album.views[key];
      const items = ((view && view.data) || []).filter((res) => res.attributes && (res.type === 'albums' || res.type === 'music-videos'));
      if (!items.length) continue;
      const shelf = el('div', { className: 'shelf' }, ...items.map((res) => {
        const mv = res.type === 'music-videos';
        const a = res.attributes;
        const src = mv ? artUrl(a.artwork, 480, 270) : artUrl(a.artwork, 360);
        const cover = el('span', { className: mv ? 'shelf-art mv' : 'shelf-art' },
          src ? el('img', { src, alt: '', loading: 'lazy', decoding: 'async' }) : el('span', { className: 'ph' }));
        const title = el('span', { className: 'shelf-title', textContent: a.name });
        if (a.contentRating === 'explicit') title.append(explicitBadge());
        const sub = key === 'other-versions' || key === 'more-by-artist' ? (a.releaseDate || '').slice(0, 4) : a.artistName;
        return actions.wrapCard(el('a', { className: mv ? 'shelf-item mv' : 'shelf-item', href: pagePath(res) },
          cover, title, el('span', { className: 'shelf-sub', textContent: sub || '' })), targetOf(res, country));
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

  async function loadAlbum() {
    const token = ++loadToken;
    if (!album) showAlert('info', () => t('album.loading'));
    try {
      const l = await AmI18n.catalogLang(country);
      const data = await amp(`/v1/catalog/${country}/albums/${albumId}`, { l, ...ALBUM_PARAMS });
      const next = data.data && data.data[0];
      if (!next) throw new Error('empty response');
      const rel = next.relationships && next.relationships.tracks;
      let list = (rel && rel.data) || [];
      // 超长专辑的曲目分页
      for (let more = rel && rel.next; more;) {
        const page = await amp(more, { l, extend: 'extendedAssetUrls', 'include[songs]': 'artists', 'include[music-videos]': 'artists', 'fields[artists]': 'name,url' });
        list = list.concat(page.data || []);
        more = page.next;
      }
      if (token !== loadToken || signal.aborted) return;
      album = next;
      tracks = list.filter((track) => track.attributes);
      render();
      showAlert('', '');
    } catch (err) {
      if (token !== loadToken || signal.aborted) return;
      showAlert('error', () => t('album.failed', { msg: err.message }));
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
      album: album.attributes.name,
      href: pagePath(track),
      albumHref: pagePath(album),
      artwork: artUrl(a.artwork || album.attributes.artwork, 600),
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
    if (album) render();
    if (albumId) loadAlbum();
  });

  if (!albumId) {
    showAlert('error', () => t('album.badId'));
  } else {
    loadAlbum();
    AmDecrypt.collectGarbage();
  }
}

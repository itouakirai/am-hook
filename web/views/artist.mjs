// 艺人页（/https://music.apple.com/{cc}/artist/{slug}/{id}），由 app.mjs 挂载
import { createActions, targetOf } from './actions.mjs';

const { formatTime } = window.AmHook;
const { AmDecrypt, AmI18n } = window;
const { t } = AmI18n;

export const bodyClass = 'artist-page';

export function mount({ root, url, signal, player, navigate, onLangChange, toast }) {
  document.title = t('artist.pageTitle');
  const actions = createActions({ signal, player, navigate, toast });
  const $ = (id) => root.querySelector(`#${id}`);
  const pageUrl = decodeURIComponent(url.pathname.slice(1));
  const linkMatch = pageUrl.match(/music\.apple\.com\/([a-z]{2})\/artist\/(?:[^/?#]+\/)?(\d+)/i) || [];
  const country = (linkMatch[1] || 'us').toLowerCase();
  const artistId = linkMatch[2];

  /** 当前艺人（amp-api artists 资源）与歌曲排行 */
  let artist = null;
  let topSongs = [];
  let rows = new Map();
  let bioExpanded = false;
  let loadToken = 0;
  // 操作行：随机播放 / 播放 / 「更多」（与专辑页相同只留三个按钮）。菜单里有简介（官网的 ⓘ）、喜爱（喜爱的艺人出现在资料库的艺人中）与复制链接，顺序见设置中心
  const moreBtn = actions.headerMenu(() => (artist ? {
    target: targetOf(artist, country),
    entries: $('about').hidden ? {} : { about: { icon: ICON.info, label: t('artist.about', { name: artist.attributes.name }), onSelect: showAbout } },
  } : null), null, 'artist-round-btn');
  moreBtn.disabled = true;
  root.querySelector('.artist-actions').append(moreBtn);

  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.75" r=".6" fill="currentColor"/></svg>',
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

  /* ---------- amp-api：与 music.apple.com 艺人页相同的 artists 请求，经服务端 /amp 代理 ---------- */
  // l 按地区支持的语言选择，见 AmI18n.catalogLang。
  // views 去掉了本站无法展示的演唱会、广播节目与电台（more-to-hear）
  const ARTIST_PARAMS = {
    platform: 'web',
    extend: 'artistBio,isGroup,origin,bornOrFormed,editorialArtwork,editorialVideo,extendedAssetUrls,hero,plainEditorialNotes',
    'art[url]': 'c,f',
    include: 'record-labels,artists',
    'include[songs]': 'artists,albums',
    'extend[playlists]': 'trackCount',
    'include[music-videos]': 'artists',
    'meta[albums:tracks]': 'popularity',
    'limit[artists:top-songs]': '24',
    'omit[resource]': 'autos',
    views: 'appears-on-albums,compilation-albums,featured-albums,featured-on-albums,featured-release,full-albums,latest-release,live-albums,more-to-see,playlists,similar-artists,singles,music-videos,top-songs',
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

  /** artwork.url 模板：{w}x{h}{c}.{f}；crop 为官网使用的裁切码（通栏图 ea / vf 等） */
  function artUrl(artwork, w, h = w, crop = 'bb', format = 'jpg') {
    return artwork && artwork.url ? artwork.url.replace('{w}', w).replace('{h}', h).replace('{c}', crop).replace('{f}', format) : '';
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
    // 歌曲的 url 是 album/...?i=<id>，统一转成歌曲页
    const slug = url.match(/\/album\/([^/?#]+)\//);
    return `/https://music.apple.com/${country}/${kind}/${slug ? slug[1] : '_'}/${resource.id}`;
  }

  /** 曲目所属专辑的本站页面路径：取关联专辑，没有时取曲目 url 里的 album/<slug>/<id> */
  function albumHref(track) {
    const album = track.relationships && track.relationships.albums && track.relationships.albums.data && track.relationships.albums.data[0];
    const m = ((track.attributes && track.attributes.url) || '').match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/album\/([^/?#]+)\/(\d+)/i);
    return album ? pagePath(album) : m ? `/https://music.apple.com/${m[1].toLowerCase()}/album/${m[2]}/${m[3]}` : '';
  }

  /** 热门歌曲的第二行「专辑 · 年份」：专辑名链接到专辑页 */
  function trackAlbum(track) {
    const a = track.attributes;
    const year = (a.releaseDate || '').slice(0, 4);
    if (!a.albumName) return [year];
    const href = albumHref(track);
    return [href ? el('a', { href, textContent: a.albumName }) : a.albumName, year ? ` · ${year}` : ''];
  }

  /** artistBio 含 <i> 等内联标签，只取纯文本（保留段落换行） */
  function plainText(html) {
    return new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();
  }

  function formatDate(iso) {
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? `${iso}T00:00:00` : iso);
    return Number.isNaN(date.getTime()) ? ''
      : new Intl.DateTimeFormat(AmI18n.lang === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'long' }).format(date);
  }

  const explicitBadge = () => el('span', { className: 'explicit', textContent: 'E', title: t('search.explicit') });
  const view = (key) => (artist.views && artist.views[key]) || null;

  /**
   * 页面主题色（官网 --joe-color，见 Yet）：头部所用图片的 bgColor，CIELAB 亮度 L > 0.5 时各通道减去 L × 0.65 × 255 压暗；
   * 整页铺这个颜色并用深色主题（白字）
   */
  function joeColor(hex) {
    if (!/^[0-9a-f]{6}$/i.test(hex || '')) return '';
    const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [r, g, b] = rgb.map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const l = (y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y) / 100;
    const down = l <= 0.5 ? 0 : Math.round(l * 0.65 * 255);
    return `#${rgb.map((c) => Math.max(0, c - down).toString(16).padStart(2, '0')).join('')}`;
  }

  /* ---------- 头部：与官网 artistDetailHeader / ArtistExpressionHeader 相同的取图规则 ---------- */
  // 官网在 xsmall 断点（< 484px）优先播放方形动态视频 motionArtistSquare1x1
  const xsmall = matchMedia('(max-width: 483px)');
  /**
   * video：有 editorialVideo.motionArtistWide16x9（或 motionArtistSingular16x9）时；片源按断点依次取
   *   motionArtistFullscreen16x9 / motionArtistWide16x9（手机先取 motionArtistSquare1x1）；
   * wide：editorialArtwork.centeredFullscreenBackground（裁切 ea），或 hero 图片推荐裁切含 vf 时用 vf；
   * circular：圆形头像（hero 图片，否则艺人 artwork）；都没有时为 no-artwork。
   */
  function heroStyle(a) {
    const heroArt = a.hero && a.hero[0] && a.hero[0].content && a.hero[0].content[0] && a.hero[0].content[0].artwork;
    const video = a.editorialVideo || {};
    if ([video.motionArtistWide16x9, video.motionArtistSingular16x9].some((v) => v && v.video)) {
      const order = xsmall.matches ? ['motionArtistSquare1x1', 'motionArtistFullscreen16x9', 'motionArtistWide16x9']
        : ['motionArtistFullscreen16x9', 'motionArtistWide16x9'];
      const motion = [...order, 'motionArtistSingular16x9'].map((key) => video[key]).find((v) => v && v.video);
      return { kind: 'video', src: motion.video, art: motion.previewFrame, crop: 'bb' };
    }
    const fullscreen = a.editorialArtwork && a.editorialArtwork.centeredFullscreenBackground;
    if (fullscreen) return { kind: 'wide', art: fullscreen, crop: 'ea' };
    if (heroArt && (heroArt.recommendedCropCodes || []).includes('vf')) return { kind: 'wide', art: heroArt, crop: 'vf' };
    const art = heroArt || a.artwork;
    return { kind: art && art.url ? 'circular' : 'no-artwork', art, crop: 'bb' };
  }

  let motion = null;
  let motionKey = '';
  // 离开页面时停止动态封面（尚在加载的不再挂载）
  signal.addEventListener('abort', () => { motionKey = ''; if (motion) motion.destroy(); motion = null; });
  xsmall.addEventListener('change', () => { if (artist) renderHero(); }, { signal });

  /** container 里按 className 保留一张图片，src 不变时不重新加载 */
  function setImg(container, className, src, alt = '') {
    let img = container.querySelector(`img.${className}`);
    if (!src) { img?.remove(); return; }
    if (!img) container.prepend(img = el('img', { className, alt: '', decoding: 'async' }));
    if (img.getAttribute('src') !== src) img.src = src;
    img.alt = alt;
  }

  function renderHero() {
    const a = artist.attributes;
    document.title = `${a.name} · am-hook`;
    $('name').classList.remove('skeleton');
    $('name').textContent = a.name;
    // 字标：官网 artwork profile artist-expression-header-logo（400 宽、3:1、bb），透明背景所以取 webp 而不是 jpg
    const logoArt = a.editorialArtwork && a.editorialArtwork.musicContentColorLogoTrimmed;
    const logoSrc = artUrl(logoArt, 400, 133, 'bb', 'webp');
    $('name').classList.toggle('sr-only', !!logoSrc);
    $('logo').hidden = !logoSrc;
    setImg($('logo'), 'logo-img', logoSrc, a.name);
    if (logoSrc) $('logo').querySelector('img').srcset = `${logoSrc} 1x, ${artUrl(logoArt, 800, 266, 'bb', 'webp')} 2x`;
    $('apple-link').href = a.url || `https://music.apple.com/${country}/artist/${artistId}`;
    $('apple-link-text').textContent = t('artist.openInApple', { name: a.name });
    $('play-all').setAttribute('aria-label', t('album.play'));
    $('shuffle').setAttribute('aria-label', t('album.shuffle'));

    const style = heroStyle(a);
    const hero = $('hero');
    for (const kind of ['circular', 'wide', 'video', 'no-artwork']) hero.classList.toggle(kind, style.kind === kind);
    hero.classList.toggle('fixed', style.kind === 'wide' || style.kind === 'video');

    // 主题色：动态视频首帧 / 通栏图 / 头像的 bgColor，没有时取艺人 artwork
    const joe = joeColor((style.art && style.art.bgColor) || (a.artwork && a.artwork.bgColor));
    document.body.classList.toggle('artist-themed', !!joe);
    if (joe) document.body.style.setProperty('--joe', joe);
    else document.body.style.removeProperty('--joe');

    const media = $('hero-art');
    if (style.kind === 'wide' || style.kind === 'video') {
      // 通栏：wide 与官网 uberArtwork 的 artwork profile 相同，按 16:9 取图（[[1200], HD_ASPECT_RATIO, cropStyle]），
      // vf 等裁切码由图片服务器按这个比例做智能裁切——hero 原图多为 3000×3000 方图，按原图比例取会拿到整张方图，
      // cover + 顶部对齐后只剩上半截；video 的首帧本身是 16:9，按原图比例取。cover 铺满、顶部对齐（官网 object-position: center top）
      const ratio = style.kind === 'wide' ? 9 / 16
        : style.art && style.art.width && style.art.height ? style.art.height / style.art.width : 9 / 16;
      setImg(media, 'hero-img', artUrl(style.art, 2400, Math.round(2400 * ratio), style.crop));
      $('portrait').replaceChildren();
      $('portrait-glow').replaceChildren();
    } else {
      media.replaceChildren();
      // 圆形头像（官网 facehole-uber），背后是同一张图放大、模糊的光晕
      setImg($('portrait'), 'portrait-img', artUrl(style.art, 380), t('artist.portraitAlt', { name: a.name }));
      setImg($('portrait-glow'), 'glow-img', artUrl(style.art, 240));
    }
    const key = style.kind === 'video' ? style.src : '';
    if (key !== motionKey) {
      motionKey = key;
      if (motion) { motion.destroy(); motion = null; }
      if (key) {
        import('/assets/motion-art.mjs')
          .then(({ mountMotionArt }) => { if (motionKey === key) motion = mountMotionArt(media, { src: key }); })
          .catch((err) => console.warn('[am-hook] 动态头像加载失败', err));
      }
    }
  }

  /* ---------- 最新发行与歌曲排行 ---------- */
  function renderFeatured() {
    const latestView = view('latest-release');
    const latest = latestView && (latestView.data || []).find((res) => res.attributes);
    $('latest-wrap').hidden = !latest;
    if (latest) {
      const a = latest.attributes;
      $('latest-title').textContent = (latestView.attributes && latestView.attributes.title) || '';
      const cover = artUrl(a.artwork, 320);
      const title = el('span', { className: 'latest-title', textContent: a.name });
      if (a.contentRating === 'explicit') title.append(explicitBadge());
      // 官网 artist-featured-release：左封面，右侧日期 / 标题 / 曲目数（手机上为毛玻璃卡片，标题在前）
      $('latest').href = pagePath(latest);
      $('latest').replaceChildren(
        el('span', { className: 'latest-art' }, cover ? el('img', { src: cover, alt: '', loading: 'lazy', decoding: 'async' }) : el('span', { className: 'ph' })),
        el('span', { className: 'latest-lines' },
          el('span', { className: 'latest-date', textContent: formatDate(a.releaseDate) }),
          title,
          el('span', { className: 'latest-sub', textContent: a.trackCount ? t('album.songs', { n: a.trackCount }) : '' })));
      $('latest-card').querySelector('.cover-actions')?.remove();
      $('latest-card').append(actions.coverActions(targetOf(latest, country)));
    }

    const topView = view('top-songs');
    $('top-songs-title').textContent = (topView && topView.attributes && topView.attributes.title) || '';
    rows = new Map();
    $('top-songs').replaceChildren(...topSongs.map((track) => {
      const a = track.attributes;
      const href = pagePath(track);
      const src = artUrl(a.artwork, 80);
      const playBtn = el('button', { className: 'track-play', type: 'button', innerHTML: ICON.play });
      playBtn.setAttribute('aria-label', t('album.playTrack', { name: a.name }));
      playBtn.addEventListener('click', () => playTrack(track));
      const cover = el('span', { className: 'track-art' },
        src ? el('img', { src, alt: '', loading: 'lazy', decoding: 'async' }) : el('span', { className: 'ph' }),
        el('span', { className: 'eq', ariaHidden: 'true' }, el('i'), el('i'), el('i'), el('i')), playBtn);
      const main = el('div', { className: 'track-main' },
        el('div', { className: 'track-line' }, el('a', { className: 'track-title', href, textContent: a.name }), a.contentRating === 'explicit' ? explicitBadge() : ''),
        el('div', { className: 'track-artist' }, ...trackAlbum(track)));
      // 「更多」菜单：播放按歌曲排行排队
      const more = actions.moreButton(targetOf(track, country, { albumHref: a.albumName ? albumHref(track) : '', onPlay: () => playTrack(track) }));
      const row = el('div', { className: 'track ts-item' }, cover, main, more);
      row.addEventListener('dblclick', (e) => { if (!e.target.closest('a, button')) playTrack(track); });
      rows.set(track.id, { row, playBtn });
      return row;
    }));
    $('top-songs-wrap').hidden = !topSongs.length;
    $('featured').hidden = !latest && !topSongs.length;
    $('featured').classList.toggle('has-latest', !!latest);
    $('play-all').disabled = $('shuffle').disabled = topSongs.length === 0;
    syncRows(player.current, !player.transport().paused);
  }

  /* ---------- 货架：官网艺人页的顺序，只保留本站能打开的专辑、MV、歌单与艺人 ---------- */
  const SHELVES = ['featured-release', 'featured-albums', 'full-albums', 'music-videos', 'playlists', 'singles', 'live-albums',
    'compilation-albums', 'appears-on-albums', 'featured-on-albums', 'more-to-see', 'similar-artists'];
  /** 艺人自己的作品显示年份，其余显示所属艺人 */
  const OWN_WORK = new Set(['featured-albums', 'full-albums', 'music-videos', 'singles', 'live-albums', 'compilation-albums']);
  const SHELF_TYPES = new Set(['albums', 'music-videos', 'playlists', 'artists']);

  function shelfItem(key, res) {
    const a = res.attributes;
    const mv = res.type === 'music-videos';
    const person = res.type === 'artists';
    const src = mv ? artUrl(a.artwork, 480, 270) : artUrl(a.artwork, 360);
    const cover = el('span', { className: `shelf-art${mv ? ' mv' : ''}${person ? ' artist' : ''}` },
      src ? el('img', { src, alt: '', loading: 'lazy', decoding: 'async' }) : el('span', { className: 'ph' }));
    const title = el('span', { className: 'shelf-title', textContent: a.name });
    if (a.contentRating === 'explicit') title.append(explicitBadge());
    const sub = person ? null : res.type === 'playlists' ? a.curatorName
      : OWN_WORK.has(key) ? (a.releaseDate || '').slice(0, 4) : a.artistName;
    return actions.wrapCard(el('a', { className: `shelf-item${mv ? ' mv' : ''}${person ? ' artist' : ''}`, href: pagePath(res) },
      cover, title, person ? null : el('span', { className: 'shelf-sub', textContent: sub || '' })), targetOf(res, country));
  }

  function renderShelves() {
    const sections = [];
    for (const key of SHELVES) {
      const v = view(key);
      const items = ((v && v.data) || []).filter((res) => res.attributes && SHELF_TYPES.has(res.type));
      if (!items.length) continue;
      const shelf = el('div', { className: 'shelf' }, ...items.map((res) => shelfItem(key, res)));
      const head = el('div', { className: 'shelf-head' }, el('h2', { className: 'shelf-heading', textContent: (v.attributes && v.attributes.title) || key }));
      // 有 next 时可展开全部（官网的「查看全部」页），分页经 /amp 取回后改为网格排列
      if (v.next) {
        const all = el('button', { className: 'shelf-all', type: 'button', textContent: t('artist.seeAll') });
        all.addEventListener('click', () => expandShelf(key, v.next, shelf, all));
        head.append(all);
      }
      sections.push(el('section', { className: 'shelf-section' }, head, shelf));
    }
    $('shelves').replaceChildren(...sections);
  }

  async function expandShelf(key, next, shelf, button) {
    button.disabled = true;
    const token = loadToken;
    try {
      for (let more = next, pages = 0; more && pages < 30; pages++) {
        const page = await amp(more);
        if (token !== loadToken || signal.aborted) return;
        shelf.append(...(page.data || []).filter((res) => res.attributes && SHELF_TYPES.has(res.type)).map((res) => shelfItem(key, res)));
        more = page.next;
      }
      shelf.classList.add('expanded');
      button.hidden = true;
    } catch (err) {
      toast(t('artist.failed', { msg: err.message }));
    } finally {
      button.disabled = false;
    }
  }

  /* ---------- 关于：artistBio 与家乡 / 出生 / 流派（官网 artist-bio） ---------- */
  function renderAbout() {
    const a = artist.attributes;
    const bio = plainText(a.artistBio);
    const facts = [];
    if (a.origin) facts.push([t(a.isGroup ? 'artist.origin' : 'artist.hometown'), a.origin]);
    if (a.bornOrFormed) facts.push([t(a.isGroup ? 'artist.formed' : 'artist.born'), a.bornOrFormed]);
    if ((a.genreNames || []).length) facts.push([t('artist.genre'), a.genreNames.join(AmI18n.lang === 'zh' ? '、' : ', ')]);
    $('about').hidden = !bio && !facts.length;
    $('about-title').textContent = t('artist.about', { name: a.name });
    $('bio').hidden = !bio;
    $('bio-text').textContent = bio;
    $('bio').classList.toggle('expanded', bioExpanded);
    requestAnimationFrame(() => {
      const text = $('bio-text');
      $('bio-more').hidden = !bioExpanded && text.scrollHeight <= text.clientHeight + 1;
      $('bio-more').textContent = t(bioExpanded ? 'album.less' : 'album.more');
    });
    $('facts').replaceChildren(...facts.flatMap(([label, value]) => [el('dt', { textContent: label }), el('dd', { textContent: value })]));
  }

  // 官网的 ⓘ 按钮打开简介页；这里（「更多」菜单的「关于」）展开简介并滚动到「关于」
  function showAbout() {
    if (!bioExpanded && !$('bio').hidden) { bioExpanded = true; renderAbout(); }
    $('about').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  $('bio-more').addEventListener('click', () => {
    bioExpanded = !bioExpanded;
    renderAbout();
  });

  function render() {
    renderHero();
    renderAbout();
    renderFeatured();
    renderShelves();
    moreBtn.disabled = false;
  }

  async function loadArtist() {
    const token = ++loadToken;
    if (!artist) showAlert('info', () => t('artist.loading'));
    try {
      const l = await AmI18n.catalogLang(country);
      const data = await amp(`/v1/catalog/${country}/artists/${artistId}`, { l, ...ARTIST_PARAMS });
      const next = data.data && data.data[0];
      if (!next || !next.attributes) throw new Error('empty response');
      if (token !== loadToken || signal.aborted) return;
      artist = next;
      const topView = view('top-songs');
      topSongs = ((topView && topView.data) || []).filter((res) => res.type === 'songs' && res.attributes);
      render();
      showAlert('', '');
    } catch (err) {
      if (token !== loadToken || signal.aborted) return;
      showAlert('error', () => t('artist.failed', { msg: err.message }));
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
      album: a.albumName || '',
      href: pagePath(track),
      albumHref: a.albumName ? albumHref(track) : '',
      artwork: artUrl(a.artwork, 600),
      duration: a.durationInMillis || 0,
    };
  }

  /** order：topSongs 中的下标，按原顺序；options.shuffle 同时开关随机播放（见 AmPlayer.playQueue） */
  function playOrder(order, pos = 0, options) {
    player.playQueue(order.map((i) => entryFor(topSongs[i])), pos, options);
  }

  function playTrack(track) {
    if (player.current && player.current.track === track.id) { player.toggle(); return; }
    playOrder(topSongs.map((_, i) => i), topSongs.indexOf(track));
  }

  $('play-all').addEventListener('click', () => playOrder(topSongs.map((_, i) => i), 0, { shuffle: false }));
  $('shuffle').addEventListener('click', () => {
    const count = topSongs.length;
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

  // 切换语言：简介、货架标题等由 amp-api 按语言返回，重新获取
  onLangChange(() => {
    renderAlert();
    if (artist) render();
    if (artistId) loadArtist();
  });

  if (!artistId) {
    showAlert('error', () => t('artist.badId'));
  } else {
    loadArtist();
    AmDecrypt.collectGarbage();
  }
}

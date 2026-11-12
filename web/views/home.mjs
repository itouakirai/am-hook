// 首页（/，搜索结果为 /?q=），由 app.mjs 挂载
import { albumPathOf, createActions } from './actions.mjs';

const { AmI18n } = window;
const { t } = AmI18n;

export const bodyClass = 'home-page';

export function mount({ root, signal, player, navigate, onLangChange, toast, loadStatus }) {
  const $ = (id) => root.querySelector(`#${id}`);
  const actions = createActions({ signal, player, navigate, toast });
  const input = $('input');
  const errorEl = $('error');
  const detectEl = $('detect');

  /** 把各种输入规整为页面路径：/https://music.apple.com/{cc}/(song|music-video|album|playlist|artist)/{slug}/{id} */
  function toSongLink(raw) {
    const value = raw.trim();
    let url;
    try { url = new URL(value); } catch { return null; }
    if (!/(^|\.)music\.apple\.com$/i.test(url.hostname)) return null;
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

  const submitLabel = $('submit-label');
  const suggestEl = $('suggest');
  const resultsEl = $('results');
  const resultsBody = $('results-body');
  let errorKey = null;

  const isUrlLike = (value) => /^https?:\/\//i.test(value);

  $('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    const link = toSongLink(value);
    if (link) { navigate('/' + link); return; }
    // 其余输入按关键词搜索；无法识别的链接与空输入给出提示
    errorKey = !value ? 'home.empty' : isUrlLike(value) ? 'home.invalid' : null;
    input.setAttribute('aria-invalid', String(!!errorKey));
    errorEl.hidden = !errorKey;
    if (errorKey) {
      errorEl.textContent = t(errorKey);
      input.focus();
      return;
    }
    closeSuggest();
    runSearch(value, 'push');
  });
  input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); errorEl.hidden = true; renderDetect(); scheduleSuggest(); });

  /** 输入时即时提示识别结果：歌曲 / MV 等类型与地区；按钮在“解析”与“搜索”之间切换 */
  function renderDetect() {
    const value = input.value.trim();
    const link = value && toSongLink(value);
    submitLabel.dataset.i18n = link ? 'home.submit' : 'home.search';
    submitLabel.textContent = t(submitLabel.dataset.i18n);
    detectEl.hidden = !link;
    if (!link) return;
    const [, cc, kind] = link.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/(song|music-video|post|album|playlist|artist|room|multi-room|grouping|curator|new\/top-charts|new)\b/);
    const label = {
      song: 'home.detectSong', 'music-video': 'home.detectMv', post: 'home.detectPost', album: 'home.detectAlbum', playlist: 'home.detectPlaylist', artist: 'home.detectArtist',
      room: 'home.detectRoom', 'multi-room': 'home.detectRoom', grouping: 'home.detectGrouping', curator: 'home.detectCurator', new: 'home.detectNew',
      'new/top-charts': 'charts.title',
    }[kind];
    detectEl.textContent = `${t(label)} · ${cc.toUpperCase()}`;
  }

  // 示例链接：填入输入框，按“解析”即可打开
  root.querySelectorAll('[data-example]').forEach((btn) => btn.addEventListener('click', () => {
    input.value = btn.dataset.example;
    input.dispatchEvent(new Event('input'));
    input.focus();
  }));

  // 按 / 聚焦输入框
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return;
    event.preventDefault();
    input.focus();
  }, { signal });

  /* ---------- 搜索（与 music.apple.com/search 相同的 amp-api 调用，经服务端 /amp 代理） ---------- */

  /** 搜索地区为主地区（AmI18n.storefront，导航里设置；结果标题旁的按钮打开同一个选择面板），切换后重新搜索 */
  const storefront = () => AmI18n.storefront;
  // l 为主地区选定的曲库语言或默认语言，见 AmI18n.catalogLang
  const catalogLang = () => AmI18n.catalogLang(storefront());

  signal.addEventListener('abort', AmI18n.onSettingsChange(({ kind }) => {
    if (kind !== 'storefront') return;
    closeSuggest();
    if (search.term) runSearch(search.term);
  }), { once: true });

  /** amp-api 需要 developer token 且只允许 music.apple.com 跨域，统一走服务端 /amp 代理 */
  async function amp(path, params, signal) {
    const url = new URL('/amp' + path, location.origin);
    // 值为 undefined 的参数不传（如地区不支持当前语言时的 l）
    for (const [key, value] of Object.entries(params || {})) if (value !== undefined) url.searchParams.set(key, value);
    let res = await fetch(url, { signal });
    // 地区不支持所选语言时去掉 l，改用地区默认语言
    if (res.status === 400 && url.searchParams.has('l')) {
      url.searchParams.delete('l');
      res = await fetch(url, { signal });
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error((data && ((data.errors && data.errors[0] && data.errors[0].detail) || data.msg)) || `HTTP ${res.status}`);
    return data;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** amp-api 的 artwork.url 是 {w}x{h}{c}.{f} 模板 */
  function artUrl(artwork, w, h) {
    return artwork && artwork.url ? artwork.url.replace('{w}', w).replace('{h}', h).replace('{c}', 'bb').replace('{f}', 'jpg') : '';
  }

  function artNode(className, src) {
    const box = el('span', className);
    box.append(src ? Object.assign(document.createElement('img'), { src, alt: '', loading: 'lazy', decoding: 'async' }) : el('span', 'ph'));
    return box;
  }

  function fmtDuration(ms) {
    if (!ms) return '';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function explicitBadge() {
    const badge = el('span', 'explicit', 'E');
    badge.title = t('search.explicit');
    badge.setAttribute('aria-label', t('search.explicit'));
    return badge;
  }

  /** 目录资源 → 可打开的歌曲 / MV / 专辑 / 歌单条目；其余类型（艺人等）本站无法打开，忽略 */
  const KINDS = { songs: 'song', 'music-videos': 'music-video', albums: 'album', playlists: 'playlist', artists: 'artist' };
  const KIND_LABELS = { song: 'home.detectSong', 'music-video': 'home.detectMv', album: 'home.detectAlbum', playlist: 'home.detectPlaylist', artist: 'home.detectArtist' };
  function toItem(resource) {
    const attrs = resource && resource.attributes;
    const kind = resource && KINDS[resource.type];
    if (!attrs || !kind) return null;
    const mv = kind === 'music-video';
    let link = toSongLink(attrs.url || '');
    // 歌曲的 url 是 album/<slug>/<id>?i=<id>，搜索结果里的歌曲仍打开歌曲页
    const albumSong = kind === 'song' && link && link.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/album\/([^/?#]+)\/\d+\?i=(\d+)$/);
    if (albumSong) link = `https://music.apple.com/${albumSong[1]}/song/${albumSong[2]}/${albumSong[3]}`;
    if (!link || !link.includes(`/${kind}/`)) link = `https://music.apple.com/${storefront()}/${kind}/_/${resource.id}`;
    return {
      // 歌单没有 artistName，副标题用歌单作者（curatorName）
      kind, mv, href: '/' + link, title: attrs.name || resource.id, artist: attrs.artistName || attrs.curatorName || '', album: attrs.albumName || '',
      year: (attrs.releaseDate || '').slice(0, 4), genre: (attrs.genreNames || [])[0] || '',
      artwork: attrs.artwork, duration: attrs.durationInMillis, explicit: attrs.contentRating === 'explicit',
      traits: attrs.audioTraits || [], has4K: !!attrs.has4K, subtitle: attrs.subtitle || '',
      // 封面按钮与「更多」菜单（见 actions.mjs）
      resource, apple: attrs.url || link,
    };
  }

  /** 音质标志：歌曲用 app.css 的 .q-icon 图标（与播放条同一套），MV 用 4K 文字标签 */
  const QUALITY_LABELS = { hires: 'Hi-Res Lossless', lossless: 'Lossless', atmos: 'Dolby Atmos' };
  function qualityBadges(item, mvClass = '') {
    if (item.mv) return item.has4K ? [el('span', `q-badge ${mvClass}`.trim(), '4K')] : [];
    const keys = [];
    if (item.traits.includes('hi-res-lossless')) keys.push('hires');
    else if (item.traits.includes('lossless')) keys.push('lossless');
    if (item.traits.includes('atmos')) keys.push('atmos');
    return keys.map((key) => {
      const icon = el('span', `q-icon q-icon--${key}`);
      icon.title = QUALITY_LABELS[key];
      icon.setAttribute('role', 'img');
      icon.setAttribute('aria-label', QUALITY_LABELS[key]);
      return icon;
    });
  }

  // 建议下拉框：search/suggestions 的 terms（补全词）与 topResults（直达歌曲 / MV）
  let suggestTimer = 0;
  let suggestController = null;
  let suggestItems = [];
  let activeIndex = -1;

  function scheduleSuggest() {
    clearTimeout(suggestTimer);
    if (suggestController) suggestController.abort();
    const term = input.value.trim();
    if (!term || toSongLink(term) || isUrlLike(term)) { closeSuggest(); return; }
    suggestTimer = setTimeout(() => loadSuggest(term), 180);
  }

  async function loadSuggest(term) {
    const controller = suggestController = new AbortController();
    try {
      await statusReady;
      // 参数与官网一致（types 相同，才能拿到与官网相同的直达结果与顺序）；本站打不开的类型在 renderSuggest 里跳过
      const data = await amp(`/v1/catalog/${storefront()}/search/suggestions`, {
        term, l: await catalogLang(), platform: 'web', kinds: 'terms,topResults',
        types: 'activities,artists,albums,editorial-items,music-movies,music-videos,playlists,record-labels,songs,stations,tv-episodes',
        'fields[albums]': 'artistName,artwork,contentRating,name,playParams,url', 'fields[artists]': 'url,name,artwork',
        'limit[results:terms]': '5', 'limit[results:topResults]': '10', 'omit[resource]': 'autos', 'art[url]': 'c,f', with: 'naturalLanguage',
      }, controller.signal);
      if (controller !== suggestController || document.activeElement !== input) return;
      renderSuggest(term, (data.results && data.results.suggestions) || []);
    } catch {
      if (controller === suggestController) closeSuggest();
    }
  }

  function renderSuggest(term, suggestions) {
    suggestItems = [];
    for (const suggestion of suggestions) {
      let option;
      if (suggestion.kind === 'terms' && suggestion.displayTerm) {
        const display = suggestion.displayTerm;
        const searchTerm = suggestion.searchTerm || display;
        option = el('button', 'suggest-item suggest-term');
        option.type = 'button';
        // 与官网一致：拆出与输入匹配的部分，补全部分加粗
        const at = display.toLowerCase().indexOf(term.toLowerCase());
        const text = el('span', 'suggest-text');
        if (at >= 0) text.append(el('b', null, display.slice(0, at)), el('span', null, display.slice(at, at + term.length)), el('b', null, display.slice(at + term.length)));
        else text.append(el('b', null, display));
        option.append(el('span', 'suggest-icon'), text);
        option.addEventListener('click', () => {
          input.value = searchTerm;
          renderDetect();
          closeSuggest();
          runSearch(searchTerm, 'push');
        });
      } else if (suggestion.kind === 'topResults') {
        const item = toItem(suggestion.content);
        if (!item) continue;
        option = el('a', 'suggest-item suggest-result');
        option.href = item.href;
        const title = el('span', 'suggest-title', item.title);
        if (item.explicit) title.append(explicitBadge());
        const text = el('span', 'suggest-text');
        // 与官网一致：接口给了 subtitle 就用它，否则为“类型 · 艺人 / 歌单作者”
        text.append(title, el('span', 'suggest-sub', item.subtitle || [t(KIND_LABELS[item.kind]), item.artist].filter(Boolean).join(' · ')));
        option.append(artNode(item.mv ? 'suggest-art mv' : item.kind === 'artist' ? 'suggest-art round' : 'suggest-art', artUrl(item.artwork, 80, 80)), text);
      } else continue;
      option.id = `suggest-${suggestItems.length}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.tabIndex = -1;
      // 保持输入框焦点，避免 blur 先于 click 关闭下拉框
      option.addEventListener('mousedown', (event) => event.preventDefault());
      suggestItems.push(option);
    }
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant');
    suggestEl.replaceChildren(...suggestItems);
    suggestEl.hidden = suggestItems.length === 0;
    input.setAttribute('aria-expanded', String(!suggestEl.hidden));
  }

  function setActive(index) {
    activeIndex = index;
    suggestItems.forEach((option, i) => {
      option.classList.toggle('active', i === index);
      option.setAttribute('aria-selected', String(i === index));
    });
    if (index >= 0) {
      input.setAttribute('aria-activedescendant', suggestItems[index].id);
      suggestItems[index].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  function closeSuggest() {
    clearTimeout(suggestTimer);
    if (suggestController) suggestController.abort();
    suggestController = null;
    suggestEl.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    setActive(-1);
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeSuggest(); return; }
    if (suggestEl.hidden || !suggestItems.length) return;
    const n = suggestItems.length;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(activeIndex + 1 >= n ? -1 : activeIndex + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(activeIndex - 1 < -1 ? n - 1 : activeIndex - 1); }
    else if (event.key === 'Enter' && activeIndex >= 0 && !event.isComposing) { event.preventDefault(); suggestItems[activeIndex].click(); }
  });
  input.addEventListener('blur', closeSuggest);
  input.addEventListener('focus', () => { if (input.value.trim()) scheduleSuggest(); });

  // 搜索结果：/v1/catalog/{storefront}/search，取最佳结果与歌曲、艺人、专辑、歌单、MV 五组，next 分页地址同样经 /amp 代理
  // 分组顺序按接口返回的 meta.results.order（与官网一致），缺失时用这里的顺序
  const GROUPS = [['top', 'search.top'], ['artist', 'search.artists'], ['album', 'search.albums'], ['song', 'search.songs'], ['playlist', 'search.playlists'], ['music_video', 'search.mvs']];
  const GROUP_LABELS = Object.fromEntries(GROUPS);
  // “全部”视图里每组只露一行（歌曲为 3 列 × 3 行），多出的在对应分类标签页里看；桌面宽度下的行宽由 app.css 控制
  const PREVIEW = { song: 9, music_video: 4 };
  const PREVIEW_CARDS = 6;
  const TOP_LIMIT = 6;
  const LAYOUTS = { music_video: ['mv-grid', mvCard], album: ['album-grid', albumCard], playlist: ['album-grid', playlistCard], artist: ['album-grid', artistCard] };
  /** groups: [{ key, items, next }]；view: 'all' 或某个分组 key */
  const search = { term: '', controller: null, groups: [], view: 'all' };
  // next 分页地址只带 groups / offset / term / types / l，其余参数需补上，否则返回空结果
  const PAGE_PARAMS = { limit: '21', platform: 'web', with: 'serverBubbles', 'omit[resource]': 'autos' };

  function statusNode(text, className) {
    return el('p', `results-state${className ? ' ' + className : ''}`, text);
  }

  /** history: 'push' / 'replace' 同步地址栏 ?q=，省略时不改动（切换地区、语言后重新搜索） */
  async function runSearch(term, history) {
    // 同一关键词重新搜索（切换地区、语言）时保留当前分类标签
    const keepView = term === search.term ? search.view : 'all';
    search.term = term;
    addRecent(term);
    if (search.controller) search.controller.abort();
    const controller = search.controller = new AbortController();
    if (history) {
      const url = new URL(location.href);
      url.searchParams.set('q', term);
      if (url.href !== location.href) {
        if (history === 'push') window.history.pushState(null, '', url);
        else window.history.replaceState(window.history.state, '', url);
      }
    }
    resultsEl.hidden = false;
    $('results-title').textContent = t('search.results', { term });
    $('results-tabs').hidden = true;
    resultsBody.replaceChildren(statusNode(t('search.loading'), 'loading'));
    try {
      await statusReady;
      const data = await amp(`/v1/catalog/${storefront()}/search`, {
        term, l: await catalogLang(), types: 'songs,albums,music-videos,playlists,artists', ...PAGE_PARAMS,
      }, controller.signal);
      if (controller !== search.controller) return;
      const results = data.results || {};
      const order = (data.meta && data.meta.results && data.meta.results.order) || GROUPS.map(([key]) => key);
      search.groups = order
        .filter((key) => GROUP_LABELS[key] && results[key] && results[key].data)
        .map((key) => {
          const items = results[key].data.map(toItem).filter(Boolean);
          return key === 'top' ? { key, items: items.slice(0, TOP_LIMIT), next: null } : { key, items, next: results[key].next || null };
        })
        .filter((group) => group.items.length);
      search.view = search.groups.some((group) => group.key === keepView) ? keepView : 'all';
      renderResults();
    } catch (error) {
      if (controller !== search.controller || error.name === 'AbortError') return;
      resultsBody.replaceChildren(statusNode(t('search.failed', { msg: error.message }), 'error'));
    }
  }

  /** 分类标签（全部 / 歌曲 / 专辑 …）与当前视图 */
  function renderResults() {
    const { groups, view } = search;
    const tabs = $('results-tabs');
    const tabKeys = ['all', ...groups.map((group) => group.key).filter((key) => key !== 'top')];
    tabs.hidden = tabKeys.length < 3; // 只有一个分类时标签没有意义
    tabs.replaceChildren(...tabKeys.map((key) => {
      const tab = el('button', 'results-tab', t(key === 'all' ? 'search.all' : GROUP_LABELS[key]));
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(key === view));
      tab.addEventListener('click', () => setView(key));
      return tab;
    }));
    if (!groups.length) { resultsBody.replaceChildren(statusNode(t('search.none'))); return; }
    resultsBody.replaceChildren(...(view === 'all'
      ? groups.map(previewNode)
      : [fullNode(groups.find((group) => group.key === view))]));
  }

  function setView(key) {
    if (key === search.view) return;
    search.view = key;
    renderResults();
    // 标签栏吸顶；切换后回到结果开头
    if (resultsEl.getBoundingClientRect().top < 0) resultsEl.scrollIntoView({ block: 'start' });
  }

  function groupHead(label, action) {
    const head = el('div', 'group-head');
    head.append(el('h3', 'group-title', t(label)));
    if (action) head.append(action);
    return head;
  }

  /** “全部”视图中的一组：只显示一行，更多的通过“查看全部”进入分类标签 */
  function previewNode(group) {
    const { key, items, next } = group;
    const section = el('div', `result-group${key === 'top' ? ' top-group' : ''}`);
    const [listClass, render] = key === 'top' ? ['song-grid', topRow] : LAYOUTS[key] || ['song-grid', songRow];
    const limit = key === 'top' ? TOP_LIMIT : PREVIEW[key] || PREVIEW_CARDS;
    const list = el('div', `${listClass} preview`);
    list.append(...items.slice(0, limit).map(render));
    let action = null;
    if (key !== 'top' && (items.length > limit || next)) {
      action = el('button', 'see-all', t('search.seeAll'));
      action.type = 'button';
      action.addEventListener('click', () => setView(key));
    }
    section.append(groupHead(GROUP_LABELS[key], action), list);
    return section;
  }

  /** 分类标签页：该组全部结果，底部“加载更多”按 next 翻页 */
  function fullNode(group) {
    const { key } = group;
    const [listClass, render] = LAYOUTS[key] || ['song-grid', songRow];
    const section = el('div', 'result-group');
    const list = el('div', listClass);
    list.append(...group.items.map(render));
    const more = el('button', 'btn load-more', t('search.more'));
    more.type = 'button';
    more.hidden = !group.next;
    const controller = search.controller;
    more.addEventListener('click', async () => {
      more.disabled = true;
      try {
        const data = await amp(group.next, PAGE_PARAMS, controller.signal);
        const page = (data.results && (data.results[key] || Object.values(data.results)[0])) || {};
        const added = (page.data || []).map(toItem).filter(Boolean);
        group.items.push(...added);
        group.next = page.next || null;
        list.append(...added.map(render));
        more.hidden = !group.next;
      } catch (error) {
        if (error.name === 'AbortError') return;
      }
      more.disabled = false;
    });
    section.append(list, more);
    return section;
  }

  /** 搜索结果条目 → actions.mjs 的条目；歌曲单独播放，菜单里可前往专辑 */
  function targetOf(item) {
    return {
      kind: item.kind, href: item.href, apple: item.apple, name: item.title, country: storefront(), resource: item.resource,
      albumHref: item.kind === 'song' ? albumPathOf(item.resource) : '',
    };
  }

  /** 最佳结果的一行：与歌曲行同样的布局，副标题带类型；艺人圆形头像，MV 用 16:9 缩略图 */
  function topRow(item) {
    const row = el('a', 'song-row');
    row.href = item.href;
    const title = el('span', 'row-title', item.title);
    if (item.explicit) title.append(explicitBadge());
    const main = el('span', 'row-main');
    main.append(title, el('span', 'row-sub', [t(KIND_LABELS[item.kind]), item.artist].filter(Boolean).join(' · ')));
    const cover = item.mv ? artNode('row-cover wide', artUrl(item.artwork, 160, 90))
      : artNode(item.kind === 'artist' ? 'row-cover round' : 'row-cover', artUrl(item.artwork, 96, 96));
    row.append(cover, main);
    if (item.kind === 'song' || item.mv) {
      const meta = el('span', 'row-meta');
      meta.append(...qualityBadges(item), el('span', 'row-time', fmtDuration(item.duration)));
      row.append(meta);
    }
    return actions.wrapRow(row, targetOf(item));
  }

  function songRow(item) {
    const row = el('a', 'song-row');
    row.href = item.href;
    const title = el('span', 'row-title', item.title);
    if (item.explicit) title.append(explicitBadge());
    const main = el('span', 'row-main');
    main.append(title, el('span', 'row-sub', [item.artist, item.album].filter(Boolean).join(' · ')));
    const meta = el('span', 'row-meta');
    meta.append(...qualityBadges(item), el('span', 'row-time', fmtDuration(item.duration)));
    row.append(artNode('row-cover', artUrl(item.artwork, 96, 96)), main, meta);
    return actions.wrapRow(row, targetOf(item));
  }

  function albumCard(item) {
    const card = el('a', 'album-card');
    card.href = item.href;
    const title = el('span', 'recent-title', item.title);
    if (item.explicit) title.append(explicitBadge());
    card.append(artNode('album-thumb', artUrl(item.artwork, 360, 360)), title, el('span', 'recent-sub', [item.artist, item.year].filter(Boolean).join(' · ')));
    return actions.wrapCard(card, targetOf(item));
  }

  /** 艺人：圆形头像，副标题为主要流派（与官网搜索结果一致） */
  function artistCard(item) {
    const card = el('a', 'album-card artist-card');
    card.href = item.href;
    card.append(artNode('album-thumb round', artUrl(item.artwork, 360, 360)), el('span', 'recent-title', item.title), el('span', 'recent-sub', item.genre));
    return actions.wrapCard(card, targetOf(item));
  }

  function playlistCard(item) {
    const card = el('a', 'album-card');
    card.href = item.href;
    card.append(artNode('album-thumb', artUrl(item.artwork, 360, 360)), el('span', 'recent-title', item.title), el('span', 'recent-sub', item.artist));
    return actions.wrapCard(card, targetOf(item));
  }

  function mvCard(item) {
    const card = el('a', 'mv-card');
    card.href = item.href;
    const thumb = artNode('mv-thumb', artUrl(item.artwork, 480, 270));
    if (item.duration) thumb.append(el('span', 'mv-time', fmtDuration(item.duration)));
    thumb.append(...qualityBadges(item, 'mv-q'));
    const title = el('span', 'recent-title', item.title);
    if (item.explicit) title.append(explicitBadge());
    card.append(thumb, title, el('span', 'recent-sub', item.artist));
    return actions.wrapCard(card, targetOf(item));
  }

  function closeResults() {
    search.term = '';
    search.groups = [];
    search.view = 'all';
    if (search.controller) search.controller.abort();
    resultsEl.hidden = true;
    resultsBody.replaceChildren();
    const url = new URL(location.href);
    if (url.searchParams.has('q')) {
      url.searchParams.delete('q');
      history.replaceState(history.state, '', url);
    }
  }
  $('close-results').addEventListener('click', closeResults);

  /** 地址栏 ?q= 决定是否显示搜索结果（刷新、前进后退） */
  function syncFromUrl() {
    if (location.pathname !== '/') return; // 正在离开首页
    const q = (new URL(location.href).searchParams.get('q') || '').trim();
    if (!q) {
      if (search.term) closeResults();
      return;
    }
    input.value = q;
    renderDetect();
    if (q !== search.term) runSearch(q);
  }
  addEventListener('popstate', syncFromUrl, { signal });

  onLangChange(() => {
    renderDetect();
    closeSuggest();
    if (!errorEl.hidden && errorKey) errorEl.textContent = t(errorKey);
    if (search.term) runSearch(search.term);
    renderRecent();
  });

  // 最近搜索：关键词列表，新的在前，同词（不分大小写）去重
  const RECENT_KEY = 'am-hook:searches';
  const RECENT_LIMIT = 12;
  // 清理旧版“最近解析”留下的记录
  try { localStorage.removeItem('am-hook:recent'); } catch {}

  function readRecent() {
    try {
      const items = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(items) ? items.filter((term) => typeof term === 'string' && term.trim()).slice(0, RECENT_LIMIT) : [];
    } catch { return []; }
  }

  function writeRecent(items) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, RECENT_LIMIT))); } catch {}
    renderRecent();
  }

  function addRecent(term) {
    const key = term.toLowerCase();
    writeRecent([term, ...readRecent().filter((item) => item.toLowerCase() !== key)]);
  }

  function renderRecent() {
    const items = readRecent();
    $('recent').hidden = items.length === 0;
    $('recent-list').replaceChildren(...items.map((term) => {
      const open = el('button', 'recent-term');
      open.type = 'button';
      open.append(el('span', 'suggest-icon'), el('span', 'recent-text', term));
      open.addEventListener('click', () => {
        input.value = term;
        input.removeAttribute('aria-invalid');
        errorEl.hidden = true;
        renderDetect();
        closeSuggest();
        runSearch(term, 'push');
        resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      const remove = el('button', 'recent-remove');
      remove.type = 'button';
      remove.title = t('home.removeRecent', { term });
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => writeRecent(readRecent().filter((item) => item !== term)));
      const li = el('li', 'recent-item');
      li.append(open, remove);
      return li;
    }));
  }

  $('clear-recent').addEventListener('click', () => {
    try { localStorage.removeItem(RECENT_KEY); } catch {}
    renderRecent();
  });

  // wrapper-lite 状态由 app.mjs 维护（导航里的状态胶囊），进入首页时重新检查；没有选择过主地区时以账号所在地区为准，搜索等它返回
  const statusReady = loadStatus();
  renderDetect();
  renderRecent();
  syncFromUrl();
}

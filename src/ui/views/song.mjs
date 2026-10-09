// 歌曲页（/https://music.apple.com/{cc}/song/{slug}/{id}），由 app.mjs 挂载
import { createActions, targetOf } from './actions.mjs';

const { detectMode, artistNodes, qualityBadge, qualityIcon, formatTime } = window.AmHook;
const { AmDecrypt, AmI18n, AmWrapper } = window;
const { t } = AmI18n;

/**
 * 进行中的浏览器端下载：adamId -> Map(group_id -> { ctl, done, total })。
 * 放在页面之外：离开歌曲页后下载继续，完成后照常保存；回到该歌曲页时接着显示进度。
 */
const downloadsBySong = new Map();
/** adamId -> 当前显示该歌曲的页面刷新下载进度的函数 */
const progressViews = new Map();
// 下载在当前标签页内进行，关闭或刷新会中断
addEventListener('beforeunload', (e) => {
  for (const downloads of downloadsBySong.values()) if (downloads.size) { e.preventDefault(); return; }
});

/**
 * 已交给浏览器保存的下载结果 { url, dispose }，同 MV 页的 result：浏览器要从 OPFS 临时文件
 * 复制到下载目录，不能保存后立即删除；开始新下载、离开歌曲页或关闭标签页时再删除。
 */
const saved = new Set();

function saveResult(result, fileName) {
  const url = URL.createObjectURL(result.file);
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  saved.add({ url, dispose: result.dispose });
}

function disposeSaved() {
  const items = [...saved];
  saved.clear();
  return Promise.all(items.map(({ url, dispose }) => { URL.revokeObjectURL(url); return dispose(); }));
}
addEventListener('pagehide', disposeSaved);

export function mount({ root, url, signal, player, navigate, onLangChange, toast }) {
  document.title = t('song.pageTitle');
  const songUrl = decodeURIComponent(url.pathname.slice(1));
  const linkMatch = songUrl.match(/music\.apple\.com\/([a-z]{2})\/song\/[^/?#]+\/(\d+)/i) || [];
  const country = (linkMatch[1] || 'us').toLowerCase();
  const adamId = linkMatch[2];
  const $ = (id) => root.querySelector(`#${id}`);
  let meta = {};
  let variants = [];
  let rows = new Map();
  /** group_id -> { ctl, done, total }，本歌曲进行中的浏览器端下载（见 downloadsBySong） */
  if (adamId && !downloadsBySong.has(adamId)) downloadsBySong.set(adamId, new Map());
  const downloads = downloadsBySong.get(adamId) || new Map();
  /** 刷新下载进度：交给当前显示本歌曲的页面（离开后再回来时是新的页面） */
  const showDownload = (id) => progressViews.get(adamId)?.(id);

  $('source').textContent = songUrl;
  $('apple-link').href = songUrl;

  // 资料库：添加到资料库 / 从资料库中删除、添加到歌单（歌曲信息取到后可用）
  const actions = createActions({ signal, player, navigate, toast });
  const songTarget = () => (meta.resource ? targetOf(meta.resource, meta.country) : null);
  const libraryToggle = actions.libraryButton(songTarget, 'btn lib-toggle');
  const favoriteToggle = actions.favoriteButton(songTarget, 'btn lib-fav-toggle');
  const playlistBtn = actions.playlistButton(songTarget, 'btn');
  playlistBtn.disabled = true;
  $('play-best').after(libraryToggle.button, favoriteToggle.button, playlistBtn);

  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  }

  /** message 可以是函数，切换语言时会重新求值 */
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

  function formatRate(bps) {
    if (!bps) return '';
    return bps >= 1e6 ? `${(bps / 1e6).toFixed(2)} Mbps` : `${Math.round(bps / 1000)} kbps`;
  }

  /** 由 GROUP-ID / CODECS 推导展示信息 */
  function describe(v) {
    const g = v.group_id.toLowerCase();
    const tags = [];
    if (g.includes('binaural')) tags.push(t('q.binaural'));
    if (g.includes('downmix')) tags.push(t('q.downmix'));
    const variantRank = tags.length ? 1 : 0;
    if (g.includes('alac')) {
      const spec = [v.bit_depth && `${v.bit_depth}-bit`, v.sample_rate && `${(v.sample_rate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`].filter(Boolean).join(' / ');
      return { group: t('q.lossless'), rank: 0, kbps: 0, name: `ALAC${spec ? ' · ' + spec : ''}`, tags, sub: variantRank };
    }
    if (g.includes('atmos')) {
      // GROUP-ID 形如 atmos-2768：首位是版本号，后三位才是码率（768 kbps）
      const raw = Number((g.match(/atmos-(\d+)/) || [])[1]) || 0;
      const kbps = raw >= 1000 ? raw % 1000 : raw;
      return { group: t('q.atmos'), rank: 1, kbps, name: `Dolby Atmos${kbps ? ' · ' + kbps + ' kbps' : ''}`, tags, sub: variantRank };
    }
    if (g.includes('he-')) {
      const kbps = Number((g.match(/stereo-(\d+)/) || [])[1]) || 0;
      return { group: 'HE-AAC', rank: 3, kbps, name: `HE-AAC${kbps ? ' · ' + kbps + ' kbps' : ''}`, tags, sub: variantRank };
    }
    const kbps = Number((g.match(/stereo-(\d+)/) || [])[1]) || 0;
    return { group: 'AAC', rank: 2, kbps, name: kbps ? `AAC · ${kbps} kbps` : v.group_id, tags, sub: variantRank };
  }

  function safeName(s) {
    return s.replace(/[\\/:*?"<>|]+/g, '_').trim();
  }

  function formatSize(bytes) {
    return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }

  /* ---------- 浏览器端下载：直连 CDN + wasm 解密 + OPFS 暂存 ---------- */
  async function startDownload(v, fileName) {
    const id = v.group_id;
    if (downloads.has(id)) { toast(t('dl.busy')); return; }
    const job = { ctl: new AbortController(), done: 0, total: 0 };
    downloads.set(id, job);
    showDownload(id);
    try {
      await disposeSaved();
      const track = await AmDecrypt.openTrack(v.m3u8Url, job.ctl.signal);
      job.total = track.size;
      showDownload(id);
      const result = await AmDecrypt.download(track, {
        signal: job.ctl.signal,
        onProgress: (done) => { job.done = done; showDownload(id); },
        onDefrag: () => { job.defrag = true; showDownload(id); },
      });
      saveResult(result, fileName);
      toast(t('dl.done', { size: formatSize(result.size) }));
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (err && err.name === 'AbortError') toast(t('dl.cancelled'));
      // 已离开本页时改用底部提示
      else if (signal.aborted) toast(t('dl.failed', { msg }));
      else showAlert('error', () => t('dl.failed', { msg }));
    } finally {
      downloads.delete(id);
      showDownload(id);
    }
  }

  function renderDownload(id) {
    const r = rows.get(id);
    if (!r) return;
    const job = downloads.get(id);
    r.progress.hidden = !job;
    if (!job) return;
    const ratio = job.total ? job.done / job.total : 0;
    r.progressFill.style.width = `${ratio * 100}%`;
    r.progressText.textContent = job.defrag
      ? t('dl.defrag')
      : job.total
      ? t('dl.progress', { pct: Math.floor(ratio * 100), done: formatSize(job.done), total: formatSize(job.total) })
      : t('dl.preparing');
  }

  /* ---------- 下拉菜单（单例，fixed 定位，避免被列表 overflow 裁剪） ---------- */
  const menu = { el: $('menu'), trigger: null };

  function closeMenu(focusTrigger) {
    if (!menu.trigger) return;
    menu.el.hidden = true;
    menu.trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) menu.trigger.focus();
    menu.trigger = null;
  }

  /** 可聚焦的菜单项（跳过折叠中的） */
  function menuItems() {
    return [...menu.el.querySelectorAll('[role="menuitem"]')].filter((n) => !n.closest('[hidden]'));
  }

  /** items：'-' 分隔线、现成的 DOM 节点，或 { icon, label, hint, href?, download?, onSelect? } */
  function openMenu(trigger, items) {
    const reopen = menu.trigger === trigger;
    closeMenu(false);
    if (reopen) return;
    menu.el.replaceChildren(...items.map((it) => {
      if (it === '-') return el('div', { className: 'menu-sep', role: 'separator' });
      if (it instanceof Node) return it;
      const node = el(it.href ? 'a' : 'button', { className: 'menu-item', innerHTML: it.icon, tabIndex: -1 });
      if (it.href) { node.href = it.href; if (it.download) node.download = it.download; } else node.type = 'button';
      node.setAttribute('role', 'menuitem');
      node.append(el('span', { className: 'menu-text' },
        el('span', { className: 'menu-label', textContent: it.label }),
        it.hint && el('span', { className: 'menu-hint', textContent: it.hint })));
      node.addEventListener('click', () => { closeMenu(false); if (it.onSelect) it.onSelect(); });
      return node;
    }));
    menu.el.hidden = false;
    menu.trigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    positionMenu();
    menuItems()[0]?.focus({ preventScroll: true });
  }

  /**
   * 右对齐触发按钮；下方（播放条以上）放得下就向下，否则朝空间大的一侧展开。
   * 两侧都放不下时（窄屏 / 页面放大）限制高度，菜单内部滚动。
   */
  function positionMenu() {
    if (matchMedia('(max-width: 760px)').matches) {
      const viewport = window.visualViewport;
      const top = viewport ? viewport.offsetTop : 0;
      const height = viewport ? viewport.height : innerHeight;
      menu.el.style.maxHeight = `${Math.max(80, height - 32)}px`;
      menu.el.style.left = '12px';
      menu.el.style.top = `${top + height - menu.el.getBoundingClientRect().height - 16}px`;
      return;
    }
    const r = menu.trigger.getBoundingClientRect();
    menu.el.style.maxHeight = '';
    const m = menu.el.getBoundingClientRect();
    const bottom = Math.min(innerHeight, player.barTop()) - 8;
    const below = bottom - r.bottom - 6;
    const above = r.top - 6 - 8;
    const down = below >= m.height || below >= above;
    const height = Math.min(m.height, down ? below : above);
    if (height < m.height) menu.el.style.maxHeight = `${height}px`;
    menu.el.style.top = `${Math.max(8, down ? r.bottom + 6 : r.top - 6 - height)}px`;
    menu.el.style.left = `${Math.min(Math.max(8, r.right - m.width), innerWidth - m.width - 8)}px`;
  }

  menu.el.addEventListener('keydown', (e) => {
    const items = menuItems();
    const i = items.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') go(i + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(false);
  });
  document.addEventListener('pointerdown', (e) => {
    if (menu.trigger && !menu.el.contains(e.target) && !menu.trigger.contains(e.target)) closeMenu(false);
  }, { signal });
  addEventListener('resize', () => closeMenu(false), { signal });
  // 菜单自身的滚动（放大后内容超出、键盘聚焦自动滚动）不应关闭菜单
  addEventListener('scroll', (e) => {
    if (!menu.trigger || menu.el.contains(e.target)) return;
    if (matchMedia('(max-width: 760px)').matches) positionMenu();
    else closeMenu(false);
  }, { capture: true, signal });

  function variantMenu(v, fileName) {
    return [
      { icon: ICON.download, label: t('menu.download'), hint: t('menu.downloadHint', { file: fileName }), onSelect: () => startDownload(v, fileName) },
    ];
  }

  function playItem(v) {
    return {
      id: `${adamId}:${v.group_id}`,
      track: adamId,
      country: meta.country || country,
      codecs: v.codecs,
      m3u8Url: v.m3u8Url,
      label: v.info.name,
      badge: qualityBadge(v),
      title: meta.title,
      artist: meta.artist,
      artists: meta.artists,
      album: meta.album,
      href: url.pathname,
      albumHref: albumHref(),
      artwork: meta.artwork,
    };
  }

  function renderVariants() {
    const list = $('variant-list');
    rows = new Map();
    const nodes = [];
    let lastGroup = null;
    for (const v of variants) {
      if (v.info.group !== lastGroup) {
        lastGroup = v.info.group;
        nodes.push(el('div', { className: 'variant-group', textContent: lastGroup }));
      }
      const playable = !!v.mode;
      const playBtn = el('button', { className: 'play-btn', type: 'button', innerHTML: ICON.play, disabled: !playable });
      playBtn.setAttribute('aria-label', playable ? t('row.play', { name: v.info.name }) : t('row.unsupported'));
      playBtn.title = playable ? t('row.playTitle')
        : t('row.unsupportedTitle', { codecs: v.codecs, hint: t('player.hintDownload') });
      playBtn.addEventListener('click', () => player.play(playItem(v)));

      const name = el('div', { className: 'variant-name' }, v.info.name,
        qualityIcon(qualityBadge(v)),
        ...v.info.tags.map((tag) => el('span', { className: 'badge', textContent: tag })),
        el('span', { className: `badge ${playable ? 'ok' : 'warn'}`, textContent: t(playable ? 'row.playable' : 'row.downloadOnly') }));
      const detail = el('div', { className: 'variant-detail' },
        [v.codecs, formatRate(v.bandwidth), v.channels && t('row.channels', { n: v.channels })].filter(Boolean).join(' · ') + ' · ',
        el('code', { textContent: v.group_id }));

      const progressFill = el('div', { className: 'dl-fill' });
      const progressText = el('span', { className: 'dl-text' });
      const cancel = el('button', { className: 'icon-btn dl-cancel', type: 'button', title: t('row.cancel'), innerHTML: ICON.close });
      cancel.setAttribute('aria-label', t('row.cancelAria', { name: v.info.name }));
      cancel.addEventListener('click', () => { const job = downloads.get(v.group_id); if (job) job.ctl.abort(); });
      const progress = el('div', { className: 'dl', hidden: true },
        el('div', { className: 'dl-bar' }, progressFill), progressText, cancel);

      const fileName = safeName(`${meta.artist ? meta.artist + ' - ' : ''}${meta.title || adamId} [${v.info.name.replace(/ · /g, ' ')}].m4a`);
      const more = el('button', { className: 'icon-btn more-btn', type: 'button', title: t('row.more'), innerHTML: ICON.more });
      more.setAttribute('aria-label', t('row.moreAria', { name: v.info.name }));
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', () => openMenu(more, variantMenu(v, fileName)));
      const actions = el('div', { className: 'variant-actions' }, more);

      const row = el('div', { className: 'variant' }, playBtn, el('div', {}, name, detail, progress), actions);
      rows.set(v.group_id, { row, playBtn, progress, progressFill, progressText });
      nodes.push(row);
    }
    list.replaceChildren(...nodes);
    for (const id of downloads.keys()) renderDownload(id);
    $('count').textContent = t('song.count', { total: variants.length, playable: variants.filter((v) => v.mode).length });
    $('variants').hidden = false;
    $('play-best').disabled = !variants.some((v) => v.mode);
    syncRows(player.current, !player.transport().paused);
  }

  function syncRows(current, playing) {
    for (const [id, { row, playBtn }] of rows) {
      const active = current && current.id === `${adamId}:${id}`;
      row.classList.toggle('playing', !!active);
      playBtn.innerHTML = active && playing ? ICON.pause : ICON.play;
    }
  }
  player.onChange(syncRows);
  // 检测说能播但实际失败的编码：更新标记，避免再次误导
  player.onUnsupported((codecs) => {
    variants.forEach((v) => { if (v.codecs === codecs) v.mode = null; });
    renderVariants();
  });

  $('play-best').addEventListener('click', () => {
    // 优先播放浏览器能播的最高音质
    const best = variants.find((v) => v.mode);
    if (best) player.play(playItem(best));
  });

  async function loadVariants() {
    $('reparse').disabled = true;
    showAlert('info', () => t('song.loading'));
    try {
      const data = await AmWrapper.songMaster(adamId, signal);
      variants = data.variants.map((v) => ({
        ...v,
        info: describe(v),
        mode: detectMode(v.codecs),
        // 浏览器直连 CDN 的原始地址（浏览器端解密）
        m3u8Url: v.url,
      })).sort((a, b) => a.info.rank - b.info.rank || b.info.kbps - a.info.kbps || a.info.sub - b.info.sub || (b.bandwidth || 0) - (a.bandwidth || 0));
      renderVariants();
      showAlert('', '');
    } catch (err) {
      showAlert('error', err.message || t('song.parseFailed'));
    } finally {
      $('reparse').disabled = false;
    }
  }

  // 经服务端 /amp 代理请求 amp-api 的 songs 资源（与 music.apple.com 相同），名称按曲库语言返回
  // （l 为该地区选定的曲库语言或默认语言，见 AmI18n.catalogLang）。先查歌曲链接所在地区，查不到时依次回退 us / cn。
  async function lookupMeta() {
    for (const cc of new Set([country, 'us', 'cn'])) {
      try {
        const url = new URL(`/amp/v1/catalog/${cc}/songs/${adamId}`, location.origin);
        url.searchParams.set('include', 'albums,artists');
        const l = await AmI18n.catalogLang(cc);
        if (l) url.searchParams.set('l', l);
        let res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        // 语言参数被拒绝时去掉 l，改用地区默认语言
        if (res.status === 400 && url.searchParams.has('l')) {
          url.searchParams.delete('l');
          res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        }
        if (!res.ok) continue;
        const song = (await res.json()).data?.[0];
        const a = song?.attributes;
        if (!a) continue;
        return {
          country: cc,
          title: a.name || '',
          artist: a.artistName || '',
          album: a.albumName || '',
          albumId: song.relationships?.albums?.data?.[0]?.id || '',
          // 各位艺人的名字与本站艺人页路径，用于把艺人行中的名字做成链接
          artists: (song.relationships?.artists?.data || []).filter((r) => r.attributes?.name).map((r) => ({
            name: r.attributes.name,
            href: artistPath(r, cc),
          })),
          // artwork.url 是 {w}x{h}{c}.{f} 模板
          artwork: a.artwork?.url ? a.artwork.url.replace('{w}', 600).replace('{h}', 600).replace('{c}', 'bb').replace('{f}', 'jpg') : '',
          genre: a.genreNames?.[0] || '',
          releaseDate: a.releaseDate || '',
          durationMs: a.durationInMillis,
          explicit: a.contentRating === 'explicit',
          url: a.url || '',
          // 加入资料库、歌单时用来生成曲目快照
          resource: song,
        };
      } catch {}
    }
    return {};
  }

  /** 艺人资源 → 本站艺人页路径 */
  function artistPath(resource, cc) {
    const m = (resource.attributes?.url || '').match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/artist\/([^/?#]+)\/(\d+)/i);
    return m ? `/https://music.apple.com/${m[1].toLowerCase()}/artist/${m[2]}/${m[3]}` : `/https://music.apple.com/${cc}/artist/_/${resource.id}`;
  }

  /** 本站专辑页路径 */
  function albumHref() {
    return meta.album && meta.albumId ? `/https://music.apple.com/${meta.country || country}/album/_/${meta.albumId}` : '';
  }

  let metaLoaded = false;

  function renderMeta() {
    if (!metaLoaded) return;
    const title = meta.title || t('song.fallbackTitle', { id: adamId });
    document.title = `${title} · am-hook`;
    $('title').textContent = title;
    $('title').classList.remove('skeleton');
    // 专辑名链接到本站专辑页
    const albumNode = albumHref() ? el('a', { href: albumHref(), textContent: meta.album }) : meta.album;
    // 艺人名链接到本站艺人页
    const parts = [meta.artist && artistNodes(meta.artist, meta.artists), albumNode].filter(Boolean);
    $('subtitle').replaceChildren(...(parts.length ? parts.flatMap((part, i) => (i ? [' — ', ...[].concat(part)] : [].concat(part))) : [t('song.noMeta')]));
    $('subtitle').classList.remove('skeleton');
    const tags = [];
    if (meta.releaseDate) tags.push(meta.releaseDate.slice(0, 4));
    if (meta.genre) tags.push(meta.genre);
    if (meta.durationMs) tags.push(formatTime(meta.durationMs / 1000));
    if (meta.explicit) tags.push('E');
    tags.push(`ID ${adamId}`);
    $('meta').replaceChildren(...tags.map((tag) => el('span', { className: 'badge', textContent: tag })));
    if (meta.artwork) $('cover').replaceChildren(el('img', { src: meta.artwork, alt: t('song.coverAlt', { title }) }));
    if (meta.url) $('apple-link').href = meta.url;
  }

  let metaSeq = 0;

  async function loadMeta() {
    // 快速切换语言时只采用最后一次请求的结果；离开页面后不再改标题
    const seq = ++metaSeq;
    const result = await lookupMeta();
    if (seq !== metaSeq || signal.aborted) return;
    // 切换语言后重新获取失败时保留已有信息
    if (metaLoaded && !result.title) return;
    meta = result;
    metaLoaded = true;
    renderMeta();
    libraryToggle.refresh();
    favoriteToggle.refresh();
    playlistBtn.disabled = !meta.resource;
    if (rows.size) renderVariants(); // 下载文件名需要歌名
  }

  $('reparse').addEventListener('click', loadVariants);

  if (adamId) {
    progressViews.set(adamId, renderDownload);
    signal.addEventListener('abort', () => { if (progressViews.get(adamId) === renderDownload) progressViews.delete(adamId); });
  }

  // 切换语言：重绘所有动态生成的文字（播放、下载不受影响）；歌名等由 amp-api 按语言返回，重新获取
  onLangChange(() => {
    closeMenu(false);
    if (!metaLoaded) document.title = t('song.pageTitle');
    renderMeta();
    if (adamId) loadMeta();
    if (variants.length) {
      variants.forEach((v) => { v.info = describe(v); });
      renderVariants();
    }
    renderAlert();
  });

  if (!adamId) {
    showAlert('error', () => t('song.badId'));
  } else {
    loadMeta();
    loadVariants();
    AmDecrypt.collectGarbage();
  }
  // 离开页面：删除已保存下载的临时文件（进行中的下载继续，完成后照常保存）
  signal.addEventListener('abort', disposeSaved, { once: true });
}

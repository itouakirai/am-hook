// 歌曲页（/https://music.apple.com/{cc}/song/{slug}/{id}），由 app.mjs 挂载。
// 布局照官网歌曲页（song-header-page 与 credits_detail）：头部、制作人员，最后是音乐视频与艺人的更多作品；
// 头部之下是本站的音质列表：wrapper-lite 给出的 master m3u8 中的全部音频变体，按格式分组，可在线播放、下载解密文件；
// 同时取网页版（amp-api extendedAssetUrls.enhancedHls）的 master 比较：两者可能是不同的打包，音质也可能不同
import { createActions, openMenu, copyText, targetOf, pagePath, artistLinks, albumPathOf, openAlacCheck, ICON as ACTION_ICON } from './actions.mjs';
import { compareAlac, pickAlac } from '../alac-check.mjs';
import { createDetailHeader } from './detail-header.mjs';
import { downloads } from '../download/downloads.mjs';

const { detectMode, qualityBadge, qualityIcon, formatTime } = window.AmHook;
const { AmDecrypt, AmI18n, AmWrapper } = window;
const { t } = AmI18n;

/**
 * 下载交给下载管理器（downloads.mjs）：离开歌曲页后继续，完成后照常保存，进度也显示在页面底部的下载中心；
 * 回到该歌曲页时各音质行接着显示进度。
 */
const ACTIVE_JOB = new Set(['preparing', 'queued', 'running', 'packing']);

/** amp-api 歌曲请求（与官网 SongDetailPageIntent 相同的 include）；另取主艺人的专辑，用于「更多作品」 */
const SONG_PARAMS = {
  include: 'albums,artists,credits,music-videos',
  'include[artists]': 'albums',
  'fields[artists]': 'name,url,artwork',
  // 网页版的 master m3u8（enhancedHls），与 wrapper-lite 的比较
  extend: 'extendedAssetUrls',
};

export const bodyClass = 'song-page';
export const styles = ['/assets/views/song.css'];

export function mount({ root, url, signal, player, navigate, onLangChange, toast }) {
  document.title = t('song.pageTitle');
  const songUrl = decodeURIComponent(url.pathname.slice(1));
  const linkMatch = songUrl.match(/music\.apple\.com\/([a-z]{2})\/song\/[^/?#]+\/(\d+)/i) || [];
  const linkCountry = (linkMatch[1] || 'us').toLowerCase();
  const adamId = linkMatch[2];
  const $ = (id) => root.querySelector(`#${id}`);
  /** amp-api 的 songs 资源与其所在地区（链接地区查不到时回退 us / cn） */
  let song = null;
  let country = linkCountry;
  let metaLoaded = false;
  let variants = [];
  let variantsLoading = false;
  /** wrapper-lite 的 master（AmWrapper.songMaster 的结果），检测 ALAC 时不再请求 */
  let wrapperMaster = null;
  /** 网页版的 master：{ url, variants } 或 { url, error }；没有 enhancedHls 时为 null */
  let webMaster = null;
  let rows = new Map();

  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
    // 下载按钮：圆环显示进度（下载中点击取消，中间换成停止方块）
    download: '<svg class="dl-ring" viewBox="0 0 36 36" aria-hidden="true"><circle class="dl-ring-track" cx="18" cy="18" r="16"/><circle class="dl-ring-fill" cx="18" cy="18" r="16" pathLength="100"/></svg>'
      + '<svg class="dl-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>'
      + '<svg class="dl-stop" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="8" y="8" width="8" height="8" rx="1.5"/></svg>',
  };

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  }

  const explicitBadge = () => el('span', { className: 'explicit', textContent: 'E', title: t('search.explicit') });
  const related = (resource, key) => ((resource && resource.relationships && resource.relationships[key] && resource.relationships[key].data) || [])
    .filter((r) => r.attributes);

  /** artwork.url 模板：{w}x{h}{c}.{f} */
  function artUrl(artwork, w, h = w) {
    return artwork && artwork.url ? artwork.url.replace('{w}', w).replace('{h}', h).replace('{c}', 'bb').replace('{f}', 'jpg') : '';
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

  /* ---------- 头部按钮：播放（浏览器能播放的最高音质）、喜爱与「更多」（资料库、歌单、下载、复制链接） ---------- */
  const actions = createActions({ signal, player, navigate, toast });
  const songTarget = () => (song ? targetOf(song, country, { albumHref: albumPathOf(song), onPlay: playBest }) : null);
  const favoriteToggle = actions.favoriteButton(songTarget);
  const moreBtn = actions.headerMenu(() => ({
    target: songTarget(),
    // 按设置中心的音质偏好下载，与专辑页、曲目「更多」菜单相同
    entries: adamId ? {
      download: {
        icon: ACTION_ICON.download, label: t('dlc.menu.song'),
        onSelect: () => downloads.add({ kind: 'song', id: adamId, country, tracks: song ? [song] : null })
          .then((job) => { if (job) toast(t('dlc.added', { name: song ? song.attributes.name : adamId })); }, (err) => toast(err.message)),
      },
    } : {},
    tail: [{ icon: ACTION_ICON.apple, label: t('song.openApple'), onSelect: () => window.open(appleUrl(), '_blank', 'noopener') }],
  }));
  // 检测 ALAC（见 alac-check-dialog.mjs）：只检测这一首，wrapper-lite 的 master 用这里已取到的
  const checkBtn = el('button', { className: 'detail-circle-btn', type: 'button', innerHTML: ACTION_ICON.check });
  const labelCheck = () => { checkBtn.title = t('ac.button'); checkBtn.setAttribute('aria-label', checkBtn.title); };
  labelCheck();
  checkBtn.addEventListener('click', () => {
    const track = song || { id: adamId, type: 'songs', attributes: { name: t('song.fallbackTitle', { id: adamId }), playParams: {} } };
    openAlacCheck({
      kind: 'song', id: adamId, country, resource: track, tracks: [track], toast,
      wrapperMasters: wrapperMaster ? new Map([[adamId, wrapperMaster]]) : null,
    }).catch((err) => toast(err.message));
  });
  $('buttons').append(favoriteToggle.button, checkBtn, moreBtn);

  const appleUrl = () => (song && song.attributes.url) || songUrl;

  /* ---------- 音质 ---------- */
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
    if (v.widevine) tags.push(t('q.webOnly'));
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

  function formatSize(bytes) {
    return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }

  /* ---------- 浏览器端下载：直连 CDN + wasm 解密 + OPFS 暂存，写入标签、封面与歌词（downloads.mjs） ---------- */
  /** 本歌曲该音质进行中的下载任务 */
  function jobFor(groupId) {
    return downloads.jobs.find((j) => j.kind === 'song' && j.cid === adamId && j.variant === groupId && ACTIVE_JOB.has(downloads.jobState(j)));
  }

  async function startDownload(v) {
    if (jobFor(v.group_id)) { toast(t('dl.busy')); return; }
    const job = await downloads.add({
      kind: 'song', id: adamId, country, variant: v.group_id,
      tracks: song ? [song] : null,
    }).catch((err) => { showAlert('error', () => t('dl.failed', { msg: err.message })); return null; });
    if (job) renderDownloads();
  }

  function renderDownload(id) {
    const r = rows.get(id);
    if (!r) return;
    const job = jobFor(id);
    r.row.classList.toggle('downloading', !!job);
    r.progress.hidden = !job;
    r.dl.title = t(job ? 'row.cancel' : 'menu.download');
    r.dl.setAttribute('aria-label', job ? t('row.cancelAria', { name: r.v.info.name }) : `${t('menu.download')} · ${r.v.info.name}`);
    if (!job) return;
    const task = job.tasks[0];
    const ratio = task && task.total ? task.done / task.total : 0;
    const waiting = !task || task.state === 'queued' || task.state === 'resolving';
    // 准备阶段圆环转圈，下载中按进度填充，之后（整理为 MP4）保持填满
    r.row.classList.toggle('dl-waiting', waiting);
    r.row.style.setProperty('--dl', task && task.state !== 'downloading' && !waiting ? 1 : ratio);
    r.progress.textContent = waiting ? t('dl.preparing')
      : task.state === 'downloading' ? t('dl.progress', { pct: Math.floor(ratio * 100), done: formatSize(task.done), total: formatSize(task.total) })
      : t('dl.defrag');
  }

  function renderDownloads() {
    for (const id of rows.keys()) renderDownload(id);
  }
  signal.addEventListener('abort', downloads.onChange(renderDownloads), { once: true });

  function variantMenu(v) {
    return [
      { icon: ACTION_ICON.download, label: t('menu.download'), hint: t('menu.downloadHint'), onSelect: () => startDownload(v) },
      { icon: ACTION_ICON.link, label: t('song.copyM3u8'), title: v.m3u8Url, onSelect: () => copyText(v.m3u8Url, () => toast(t('action.copied'))) },
    ];
  }

  function playItem(v) {
    const a = song ? song.attributes : {};
    return {
      id: `${adamId}:${v.group_id}`,
      track: adamId,
      country,
      codecs: v.codecs,
      m3u8Url: v.m3u8Url,
      label: v.info.name,
      badge: qualityBadge(v),
      // 全屏播放界面的音质详情显示所播音质的规格，并可换成这首歌的其他音质
      variant: v,
      variants,
      title: a.name,
      artist: a.artistName,
      // 各位艺人的名字与本站艺人页路径，播放条与歌词界面用来把艺人行中的名字做成链接
      artists: related(song, 'artists').map((artist) => ({ name: artist.attributes.name, href: pagePath(artist, country) })),
      album: a.albumName,
      href: url.pathname,
      albumHref: song && a.albumName ? albumPathOf(song) : '',
      artwork: artUrl(a.artwork, 600),
    };
  }

  const isCurrent = (v) => !!player.current && player.current.id === `${adamId}:${v.group_id}`;

  function playVariant(v) {
    if (!v.mode) return;
    if (isCurrent(v)) player.toggle();
    else player.play(playItem(v));
  }

  /** 头部「播放」：正在播放这首歌时暂停 / 继续，否则播放浏览器能播放的最高音质 */
  function playBest() {
    if (player.current && player.current.track === adamId) { player.toggle(); return; }
    const best = variants.find((v) => v.mode);
    if (best) player.play(playItem(best));
  }

  /** 载入中：骨架行占位 */
  function renderVariantSkeleton() {
    $('count').textContent = t('song.loading');
    $('variant-list').replaceChildren(el('div', { className: 'quality-group' },
      ...[0, 1, 2].map(() => el('div', { className: 'variant-skeleton', ariaHidden: 'true' },
        el('span', { className: 'variant-num' }),
        el('div', { className: 'variant-main' }, el('div', { className: 'skeleton sk-name' }), el('div', { className: 'skeleton sk-spec' }))))));
  }

  function renderVariants() {
    if (variantsLoading && !variants.length) { renderVariantSkeleton(); return; }
    rows = new Map();
    const groups = [];
    let group = null;
    for (const v of variants) {
      if (!group || v.info.group !== group.name) {
        group = { name: v.info.group, node: el('div', { className: 'quality-group' }, el('h3', { className: 'quality-group-title', textContent: v.info.group })) };
        groups.push(group);
      }
      const playable = !!v.mode;
      const unsupported = t('row.unsupportedTitle', { codecs: v.codecs, hint: t('player.hintDownload') });
      const playBtn = el('button', { className: 'variant-play', type: 'button', innerHTML: ICON.play, disabled: !playable });
      playBtn.setAttribute('aria-label', playable ? t('row.play', { name: v.info.name }) : t('row.unsupported'));
      playBtn.title = playable ? t('row.playTitle') : unsupported;
      playBtn.addEventListener('click', () => playVariant(v));
      const num = el('span', { className: 'variant-num' }, playBtn,
        el('span', { className: 'eq', ariaHidden: 'true' }, el('i'), el('i'), el('i'), el('i')));

      const name = el('div', { className: 'variant-name' },
        el('span', { className: 'variant-label', textContent: v.info.name }),
        qualityIcon(qualityBadge(v)),
        ...v.info.tags.map((tag) => el('span', { className: 'variant-tag', textContent: tag })),
        wrapperOnly(v) ? el('span', { className: 'variant-tag info', textContent: t('song.wrapperOnly'), title: t('song.wrapperOnlyTitle') }) : null,
        playable ? null : el('span', { className: 'variant-tag warn', textContent: t('row.downloadOnly'), title: unsupported }));
      const spec = el('div', { className: 'variant-spec' },
        // CHANNELS 形如 16/JOC、2/-/BINAURAL：只显示声道数
        [v.codecs, formatRate(v.bandwidth), v.channels && t('row.channels', { n: String(v.channels).split('/')[0] })].filter(Boolean).join(' · ') + ' · ',
        el('code', { textContent: v.group_id }));
      const progress = el('div', { className: 'variant-progress', hidden: true, ariaLive: 'polite' });
      const main = el('div', { className: 'variant-main' }, name, spec, progress);

      const dl =el('button', { className: 'variant-dl', type: 'button', innerHTML: ICON.download });
      dl.addEventListener('click', () => {
        const job = jobFor(v.group_id);
        if (job) downloads.cancel(job);
        else startDownload(v);
      });
      const more = el('button', { className: 'variant-more more-btn', type: 'button', title: t('row.more'), innerHTML: ACTION_ICON.more });
      more.setAttribute('aria-label', t('row.moreAria', { name: v.info.name }));
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', (e) => { e.stopPropagation(); openMenu(more, variantMenu(v)); });

      const row = el('div', { className: `variant${playable ? '' : ' unsupported'}` }, num, main, dl, more);
      row.addEventListener('dblclick', (e) => { if (!e.target.closest('a, button')) playVariant(v); });
      rows.set(v.group_id, { v, row, playBtn, progress, dl });
      group.node.append(row);
    }
    $('variant-list').replaceChildren(...(groups.length ? groups.map((g) => g.node)
      : variantsLoading ? [] : [el('p', { className: 'quality-empty', textContent: t('song.empty') })]));
    renderDownloads();
    $('count').textContent = variants.length ? t('song.count', { total: variants.length, playable: variants.filter((v) => v.mode).length }) : '';
    $('play-best').disabled = !variants.some((v) => v.mode);
    syncPlaying(player.current, !player.transport().paused);
    renderCompare();
  }

  /* ---------- 网页版的 master m3u8 ---------- */
  /** 网页版的 master 是另一份且其中没有这个音质（按 GROUP-ID）：只有 wrapper-lite 给出 */
  function wrapperOnly(v) {
    return !!(webMaster && webMaster.variants && wrapperMaster && wrapperMaster.masterUrl !== webMaster.url
      && !webMaster.variants.some((w) => w.group_id === v.group_id));
  }

  const alacText = (v) => (v ? `ALAC ${[v.bit_depth && `${v.bit_depth}-bit`, v.sample_rate && `${(v.sample_rate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`].filter(Boolean).join(' / ')}` : t('song.noAlac'));

  /** 音质列表标题下的一行：网页版的 master 与 wrapper-lite 的是否相同，最高音质 ALAC 各是什么 */
  function renderCompare() {
    const line = $('compare');
    line.classList.remove('is-better');
    if (!webMaster || !wrapperMaster || variantsLoading) { line.replaceChildren(); return; }
    if (webMaster.error) { line.replaceChildren(t('song.webFailed', { msg: webMaster.error })); return; }
    let text;
    if (webMaster.url === wrapperMaster.masterUrl) {
      text = t('song.webSame');
    } else {
      const web = pickAlac(webMaster.variants);
      const wrapper = pickAlac(wrapperMaster.variants);
      const order = web && wrapper ? compareAlac(wrapper, web) : wrapper ? 1 : web ? -1 : 0;
      const extra = webMaster.variants.filter((w) => !wrapperMaster.variants.some((v) => v.group_id === w.group_id)).length;
      text = [t('song.webDiffer', { web: alacText(web), wrapper: alacText(wrapper) }),
        order > 0 ? t('song.wrapperBetter') : order < 0 ? t('song.webBetter') : '',
        extra ? t('song.webExtra', { n: extra }) : ''].filter(Boolean).join(' · ');
      line.classList.toggle('is-better', order !== 0);
    }
    const copyBtn = el('button', { type: 'button', className: 'song-compare-copy', textContent: t('song.copyWebMaster'), title: webMaster.url });
    copyBtn.addEventListener('click', () => copyText(webMaster.url, () => toast(t('action.copied'))));
    line.replaceChildren(el('span', { textContent: text }), copyBtn);
  }

  async function loadWebMaster() {
    const url = song && song.attributes.extendedAssetUrls && song.attributes.extendedAssetUrls.enhancedHls;
    if (!url) { webMaster = null; renderVariants(); return; }
    if (webMaster && webMaster.url === url && !webMaster.error) return;
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      webMaster = { url, variants: AmWrapper.parseSongMaster(await res.text(), res.url || url) };
    } catch (err) {
      if (signal.aborted) return;
      webMaster = { url, error: err.message || String(err) };
    }
    if (!signal.aborted) renderVariants();
  }

  function syncPlaying(current, playing) {
    for (const { v, row, playBtn } of rows.values()) {
      const active = isCurrent(v);
      row.classList.toggle('playing', active);
      row.classList.toggle('paused', active && !playing);
      if (v.mode) playBtn.innerHTML = active && playing ? ICON.pause : ICON.play;
    }
    const mine = !!current && current.track === adamId && playing;
    const btn = $('play-best');
    btn.innerHTML = mine ? ICON.pause : ICON.play;
    btn.append(el('span', { textContent: t(mine ? 'song.pause' : 'song.play') }));
  }
  player.onChange(syncPlaying);
  // 检测说能播但实际失败的编码：更新标记，避免再次误导
  player.onUnsupported((codecs) => {
    variants.forEach((v) => { if (v.codecs === codecs) v.mode = null; });
    renderVariants();
  });

  $('play-best').addEventListener('click', playBest);

  async function loadVariants() {
    variantsLoading = true;
    $('reparse').disabled = true;
    $('reparse').classList.add('busy');
    showAlert('', '');
    renderVariants();
    try {
      const data = await AmWrapper.songMaster(adamId, signal);
      wrapperMaster = data;
      variants = data.variants.map((v) => ({
        ...v,
        info: describe(v),
        mode: detectMode(v.codecs),
        // 浏览器直连 CDN 的原始地址（浏览器端解密）
        m3u8Url: v.url,
      })).sort((a, b) => a.info.rank - b.info.rank || b.info.kbps - a.info.kbps || a.info.sub - b.info.sub || (b.bandwidth || 0) - (a.bandwidth || 0));
      if (variants.some((v) => v.widevine)) showAlert('info', () => t('q.webOnlyTitle'));
    } catch (err) {
      if (signal.aborted) return;
      showAlert('error', err.message || t('song.parseFailed'));
    } finally {
      variantsLoading = false;
      $('reparse').disabled = false;
      $('reparse').classList.remove('busy');
    }
    if (!signal.aborted) renderVariants();
  }

  $('reparse').addEventListener('click', loadVariants);

  /* ---------- 歌曲信息：经服务端 /amp 代理请求 amp-api，名称按曲库语言返回（l 见 AmI18n.catalogLang） ---------- */
  async function fetchSong(cc) {
    const req = new URL(`/amp/v1/catalog/${cc}/songs/${adamId}`, location.origin);
    for (const [key, value] of Object.entries(SONG_PARAMS)) req.searchParams.set(key, value);
    const l = await AmI18n.catalogLang(cc);
    if (l) req.searchParams.set('l', l);
    let res = await fetch(req, { signal: AbortSignal.timeout(8000) });
    // 语言参数被拒绝时去掉 l，改用地区默认语言
    if (res.status === 400 && req.searchParams.has('l')) {
      req.searchParams.delete('l');
      res = await fetch(req, { signal: AbortSignal.timeout(8000) });
    }
    if (!res.ok) return null;
    const resource = (await res.json()).data?.[0];
    return resource && resource.attributes ? resource : null;
  }

  /** 先查歌曲链接所在地区，查不到时依次回退 us / cn */
  async function lookupSong() {
    for (const cc of new Set([linkCountry, 'us', 'cn'])) {
      try {
        const resource = await fetchSong(cc);
        if (resource) return { resource, cc };
      } catch {}
    }
    return null;
  }

  const renderHeader = createDetailHeader({ $, signal, artUrl, rerender: () => renderHero() });

  function renderHero() {
    if (!metaLoaded) return;
    const a = song ? song.attributes : {};
    const title = a.name || t('song.fallbackTitle', { id: adamId });
    document.title = `${title} · am-hook`;
    $('title').classList.remove('skeleton');
    $('title').replaceChildren(title, a.contentRating === 'explicit' ? explicitBadge() : '');
    // 艺人名链接到本站艺人页
    $('subtitle').classList.remove('skeleton');
    $('subtitle').replaceChildren(...(song ? artistLinks(song, country) : [t('song.noMeta')]));
    // 专辑（链接到本站专辑页）· 年份 · 流派
    const albumHref = song && a.albumName ? albumPathOf(song) : '';
    const parts = [
      a.albumName && (albumHref ? el('a', { href: albumHref, textContent: a.albumName }) : a.albumName),
      (a.releaseDate || '').slice(0, 4),
      (a.genreNames || [])[0],
    ].filter(Boolean);
    $('meta').replaceChildren(...parts.flatMap((part, i) => (i ? [' · ', part] : [part])));
    // 音质标志与播放条同一套图标
    const traits = a.audioTraits || [];
    const badges = [];
    if (traits.includes('hi-res-lossless')) badges.push('hires');
    else if (traits.includes('lossless')) badges.push('lossless');
    if (traits.includes('atmos')) badges.push('atmos');
    if (a.isAppleDigitalMaster || a.isMasteredForItunes) badges.push('adm');
    $('badges').replaceChildren(...badges.map((key) => qualityIcon(key)));
    renderHeader({ cover: a.artwork, attrs: {}, alt: t('song.coverAlt', { title }) });
  }

  /** 官网把 PERFORMING ARTISTS 等分类名转成每个词首字母大写 */
  const titleCase = (text) => text.toLowerCase().replace(/(?:^|\s)([\p{L}\d])/giu, (m, c) => m.slice(0, -1) + c.toUpperCase()).trim();

  /** 制作人员：按分类（演唱艺人、词曲创作、制作与工程）列出，头像 + 名字 + 职责（官网 songDetailItemLockup，三列网格） */
  function renderCredits() {
    const sections = related(song, 'credits').map((category) => {
      const people = related(category, 'credit-artists').map((person) => {
        const p = person.attributes;
        const src = artUrl(p.artwork, 88);
        const avatar = el('span', { className: 'credit-avatar' }, src
          ? el('img', { src, alt: '', loading: 'lazy', decoding: 'async' })
          : el('span', { className: 'credit-initial', textContent: (p.name || '?').trim().charAt(0).toUpperCase() }));
        const artist = ((person.relationships && person.relationships.artists && person.relationships.artists.data) || [])[0];
        return el(artist ? 'a' : 'div', { className: 'credit', ...(artist ? { href: pagePath(artist, country) } : {}) }, avatar,
          el('span', { className: 'credit-text' },
            el('span', { className: 'credit-name', textContent: p.name || '' }),
            el('span', { className: 'credit-roles', textContent: (p.roleNames || []).join(', ') })));
      });
      if (!people.length) return null;
      return el('section', { className: 'song-section' },
        el('h2', { className: 'song-section-title', textContent: titleCase(category.attributes.title || '') }),
        el('div', { className: 'credit-grid' }, ...people));
    }).filter(Boolean);
    $('credits').replaceChildren(...sections);
  }

  function renderInfo() {
    const a = song ? song.attributes : {};
    const facts = [];
    if (a.releaseDate) {
      const date = new Date(`${a.releaseDate}T00:00:00`);
      facts.push([t('song.released'), Number.isNaN(date.getTime()) ? a.releaseDate
        : new Intl.DateTimeFormat(AmI18n.lang === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'long' }).format(date)]);
    }
    if (a.durationInMillis) facts.push([t('song.duration'), formatTime(a.durationInMillis / 1000)]);
    if (a.trackNumber) facts.push([t('song.track'), t('song.trackNo', { disc: a.discNumber || 1, n: a.trackNumber })]);
    if (a.genreNames && a.genreNames.length) facts.push([t('song.genre'), a.genreNames[0]]);
    if (a.composerName) facts.push([t('song.composer'), a.composerName]);
    if (a.isrc) facts.push(['ISRC', a.isrc, true]);
    if (adamId) facts.push(['Apple Music ID', adamId, true]);
    $('facts').replaceChildren(...facts.map(([label, value, mono]) => el('div', { className: 'song-fact' },
      el('dt', { textContent: label }), el('dd', { className: mono ? 'mono' : '', textContent: value }))));
    $('info').hidden = !facts.length;
  }

  /** 下方货架：音乐视频与主艺人的更多作品（官网 RelatedVideos / MoreByArtist），与专辑页的货架相同 */
  function renderShelves() {
    const artist = related(song, 'artists')[0];
    const shelves = [
      { title: t('song.musicVideos'), items: related(song, 'music-videos') },
      { title: artist ? t('song.moreBy', { name: artist.attributes.name }) : '', items: related(artist, 'albums'), year: true },
    ];
    $('shelves').replaceChildren(...shelves.filter((s) => s.items.length && s.title).map(({ title, items, year }) => {
      const shelf = el('div', { className: 'shelf' }, ...items.map((res) => {
        const mv = res.type === 'music-videos';
        const a = res.attributes;
        const src = mv ? artUrl(a.artwork, 480, 270) : artUrl(a.artwork, 360);
        const cover = el('span', { className: mv ? 'shelf-art mv' : 'shelf-art' },
          src ? el('img', { src, alt: '', loading: 'lazy', decoding: 'async' }) : el('span', { className: 'ph' }));
        const name = el('span', { className: 'shelf-title', textContent: a.name });
        if (a.contentRating === 'explicit') name.append(explicitBadge());
        const sub = year ? (a.releaseDate || '').slice(0, 4) : a.artistName;
        return actions.wrapCard(el('a', { className: mv ? 'shelf-item mv' : 'shelf-item', href: pagePath(res, country) },
          cover, name, el('span', { className: 'shelf-sub', textContent: sub || '' })), targetOf(res, country));
      }));
      return el('section', { className: 'shelf-section' }, el('h2', { className: 'shelf-heading', textContent: title }), shelf);
    }));
  }

  function renderMeta() {
    renderHero();
    if (!metaLoaded) return;
    renderCredits();
    renderInfo();
    renderShelves();
  }

  let metaSeq = 0;

  async function loadMeta() {
    // 快速切换语言时只采用最后一次请求的结果；离开页面后不再改标题
    const seq = ++metaSeq;
    const result = await lookupSong();
    if (seq !== metaSeq || signal.aborted) return;
    // 切换语言后重新获取失败时保留已有信息
    if (metaLoaded && !result) return;
    song = result ? result.resource : null;
    country = result ? result.cc : linkCountry;
    metaLoaded = true;
    renderMeta();
    favoriteToggle.refresh();
    loadWebMaster();
  }

  // 切换语言：重绘所有动态生成的文字（播放、下载不受影响）；歌名等由 amp-api 按语言返回，重新获取
  onLangChange(() => {
    if (!metaLoaded) document.title = t('song.pageTitle');
    renderMeta();
    if (adamId) loadMeta();
    variants.forEach((v) => { v.info = describe(v); });
    renderVariants();
    renderAlert();
    labelCheck();
  });

  syncPlaying(player.current, !player.transport().paused);
  if (!adamId) {
    $('variants').hidden = true;
    showAlert('error', () => t('song.badId'));
  } else {
    loadMeta();
    loadVariants();
    AmDecrypt.collectGarbage();
  }
}

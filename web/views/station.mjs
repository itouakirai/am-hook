// 电台页（/https://music.apple.com/{cc}/station/{slug}/ra.{id}），由 app.mjs 挂载。官网点电台是直接播放，这里给每个电台一个页面：
//   个人 / 编辑电台（playParams.format = tracks）：与歌单页相同的头部与曲目列表，内容是电台「接下来的几首」，
//     可以换一批、加载更多，播放到队尾时自动续上（AmPlayer.playQueue 的 more）；
//   直播电台与广播单集（format = stream）：与 MV 页相同的布局，用 mv/radio.mjs 播放；广播单集可以下载（音频为 M4A，视频为 MP4），
//     直播电台显示当前歌曲（emsg）与节目表。
// 这些接口需要用户的 media-user-token（见 station.mjs）：第一次打开电台页时请用户填写。
import { createActions, ICON as ACTION_ICON, playable, targetOf, songEntry, pagePath, artistLinks, albumPathOf, localPath } from './actions.mjs';
import { createDetailHeader } from './detail-header.mjs';
import { openDownloadDialog } from './download-dialog.mjs';
import { stationKind, withToken, askToken, onTokenChange, nextTracks, playAssets } from '/assets/station.mjs';
import { buildIlst, imageType } from '/assets/download/mp4-tags.mjs';

const { formatTime } = window.AmHook;
const { AmDecrypt, AmI18n } = window;
const { t } = AmI18n;

export const bodyClass = 'station-page';
export const styles = ['/assets/mv/style.css', '/assets/views/station.css'];

/** 电台资源：节目表（events）、所属节目（radio-show，广播单集的主持人 / 节目） */
const STATION_PARAMS = {
  extend: 'editorialArtwork,plainEditorialNotes,editorialVideo',
  include: 'events,radio-show',
  'include[stations]': 'events,radio-show',
};
/** 每次取几首（与 MusicKit 的 maxQueueSizeInRequest 相同） */
const BATCH = 10;
const STATION_PATH = /^https:\/\/music\.apple\.com\/([a-z]{2})\/station\/(?:[^/?#]+\/)?(ra\.[0-9A-Za-z._-]+?)\/?$/i;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false && c !== ''));
  return node;
}

/** artwork.url 模板 {w}x{h}{c}.{f} */
function artUrl(artwork, w, h = w, crop = 'bb') {
  return artwork && artwork.url ? artwork.url.replace('{w}', w).replace('{h}', h).replace('{c}', crop).replace('{f}', 'jpg') : '';
}

const rel = (res, key) => (res && res.relationships && res.relationships[key] && res.relationships[key].data) || [];

function plainText(html) {
  return html ? new DOMParser().parseFromString(html, 'text/html').body.textContent.trim() : '';
}

async function amp(path, params) {
  const target = new URL('/amp' + path, location.origin);
  for (const [key, value] of Object.entries(params || {})) if (value !== undefined) target.searchParams.set(key, value);
  let res = await fetch(target);
  if (res.status === 400 && target.searchParams.has('l')) {
    target.searchParams.delete('l');
    res = await fetch(target);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error((data && ((data.errors && data.errors[0] && data.errors[0].detail) || data.msg)) || `HTTP ${res.status}`);
  return data;
}

/** 电台的种类文字（眉题与徽标） */
function kindLabel(station, kind) {
  if (kind.kind === 'tracks') return t((station.attributes || {}).kind === 'user' ? 'station.kind.personal' : 'station.kind.tracks');
  if (kind.kind === 'live') return t(kind.video ? 'station.kind.liveVideo' : 'station.kind.live');
  return t(kind.video ? 'station.kind.videoEpisode' : 'station.kind.episode');
}

/** 说明：plainEditorialNotes 的 standard / short / tagline */
function notesOf(a) {
  const notes = a.plainEditorialNotes || a.editorialNotes || {};
  return { tagline: plainText(notes.tagline || notes.short || ''), standard: plainText(notes.standard || notes.short || '') };
}

function formatRange(start, end) {
  const s = new Date(start), e = new Date(end);
  if (Number.isNaN(s.getTime())) return '';
  const locale = AmI18n.lang === 'zh' ? 'zh-CN' : 'en-US';
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(s);
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' });
  return Number.isNaN(e.getTime()) ? `${day} ${time.format(s)}` : `${day} ${time.format(s)}–${time.format(e)}`;
}

export function mount(ctx) {
  const { root, url, signal, onLangChange } = ctx;
  const match = decodeURIComponent(url.pathname.slice(1)).match(STATION_PATH);
  const country = match ? match[1].toLowerCase() : 'us';
  const id = match ? match[2] : '';
  const $ = (name) => root.querySelector(`#${name}`);
  document.title = `${t('station.pageTitle')} · am-hook`;

  /** 当前的子页面（tracks / stream），{ group, update(station) } */
  let view = null;
  let loadToken = 0;

  function bootAlert(kind, message) {
    const a = $('boot-alert');
    if (!a) return;
    a.className = `alert ${kind}`;
    a.textContent = message;
  }

  async function load() {
    const token = ++loadToken;
    try {
      const l = await AmI18n.catalogLang(country);
      const data = await amp(`/v1/catalog/${country}/stations/${id}`, { ...STATION_PARAMS, l });
      const station = (data.data || [])[0];
      if (!station || !station.attributes) throw new Error('empty response');
      if (token !== loadToken || signal.aborted) return;
      const kind = stationKind(station);
      const group = kind.kind === 'tracks' ? 'tracks' : 'stream';
      if (!view || view.group !== group) {
        const template = root.querySelector(`#tpl-${group}`);
        if (!template) return;
        const node = template.content.cloneNode(true);
        AmI18n.apply(node);
        for (const name of ['boot', 'tpl-tracks', 'tpl-stream']) root.querySelector(`#${name}`)?.remove();
        root.append(node);
        view = group === 'tracks' ? mountTracks(ctx, $) : mountStream(ctx, $);
        view.group = group;
      }
      view.update(station, kind, country, id);
    } catch (err) {
      if (token !== loadToken || signal.aborted) return;
      if (view) view.error(err); else bootAlert('error', t('station.failed', { msg: err.message }));
    }
  }

  // 切换语言：名称与说明由 amp-api 按语言返回，重新获取
  onLangChange(() => {
    if (!view) bootAlert('info', t('station.loading'));
    view?.relabel();
    if (id) load();
  });

  if (!id) bootAlert('error', t('station.badId'));
  else { load(); AmDecrypt.collectGarbage(); }
}

/* ---------- 个人 / 编辑电台：接下来的几首 ---------- */

function mountTracks({ signal, player, navigate, toast }, $) {
  document.body.classList.add('album-page', 'playlist-page', 'station-tracks');
  const actions = createActions({ signal, player, navigate, toast });
  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  };
  let station = null, kind = null, country = 'us', id = '';
  /** 已取到的歌曲（按取到的顺序）与曲目行 */
  let tracks = [];
  let rows = new Map();
  let busy = false;
  let alertState = null;

  function showAlert(type, message) {
    alertState = message ? { type, message } : null;
    const a = $('alert');
    a.hidden = !alertState;
    if (!alertState) return;
    a.className = `alert ${type}`;
    a.textContent = typeof message === 'function' ? message() : message;
  }

  const target = () => (station ? {
    kind: 'station', href: location.pathname, apple: station.attributes.url || `https://music.apple.com/${country}/station/${id}`,
    name: station.attributes.name || '', country,
  } : null);
  const moreBtn = actions.headerMenu(() => (station ? {
    target: target(),
    entries: tracks.some(playable) ? {
      // 下载当前列出的歌曲（与歌单的下载相同，电台作为「歌单」命名）
      download: {
        icon: ACTION_ICON.download, label: t('station.downloadTracks'),
        onSelect: () => openDownloadDialog({ kind: 'playlist', resource: collection(), tracks: tracks.slice(), country, navigate, toast }),
      },
    } : {},
  } : null));
  moreBtn.disabled = true;
  $('extra').append(moreBtn);

  /** 下载对话框与下载管理器用的「歌单」：电台的名称与封面 */
  function collection() {
    const a = station.attributes;
    return { id, type: 'stations', attributes: { name: a.name, curatorName: 'Apple Music', artwork: a.artwork, editorialArtwork: a.editorialArtwork } };
  }

  const coverArtwork = () => {
    const a = station.attributes;
    return (a.editorialArtwork && a.editorialArtwork.staticDetailSquare) || a.artwork;
  };
  const renderHeader = createDetailHeader({ $, signal, artUrl, rerender: () => { if (station) renderHero(); } });

  function renderHero() {
    const a = station.attributes;
    document.title = `${a.name} · am-hook`;
    $('eyebrow').textContent = kindLabel(station, kind);
    $('title').textContent = a.name || id;
    const notes = notesOf(a);
    $('artist').textContent = a.kind === 'user' ? t('station.personalHint') : notes.tagline && notes.tagline !== notes.standard ? notes.tagline : 'Apple Music';
    $('sub').textContent = tracks.length ? t('station.count', { n: tracks.length }) : '';
    $('notes').hidden = !notes.standard || notes.standard === $('artist').textContent;
    $('hero').classList.toggle('no-notes', $('notes').hidden);
    $('notes-text').textContent = notes.standard;
    renderHeader({ cover: coverArtwork(), attrs: a, alt: a.name || '' });
  }

  const songs = () => tracks.filter((track) => track.type === 'songs' && playable(track));
  const entryOf = (track) => songEntry(track, country);

  function trackRow(track, index) {
    const a = track.attributes;
    const canPlay = playable(track);
    const href = pagePath(track, country);
    const cover = el('span', { className: 'track-art' },
      a.artwork ? el('img', { src: artUrl(a.artwork, 80), alt: '', loading: 'lazy', decoding: 'async' }) : el('span', { className: 'ph' }),
      el('span', { className: 'eq', ariaHidden: 'true' }, el('i'), el('i'), el('i'), el('i')));
    let playBtn = null;
    if (canPlay) {
      playBtn = el('button', { className: 'track-play', type: 'button', innerHTML: ICON.play });
      playBtn.setAttribute('aria-label', t('album.playTrack', { name: a.name }));
      playBtn.addEventListener('click', () => playTrack(track));
      cover.append(playBtn);
    }
    const title = el(canPlay ? 'a' : 'span', { className: 'track-title', textContent: a.name, ...(canPlay ? { href } : {}) });
    const main = el('div', { className: 'track-main' },
      el('div', { className: 'track-line' }, title, a.contentRating === 'explicit' ? el('span', { className: 'explicit', textContent: 'E', title: t('search.explicit') }) : null),
      el('div', { className: 'track-artist' }, ...artistLinks(track, country)));
    const albumHref = albumPathOf(track);
    const albumCol = albumHref && a.albumName ? el('a', { className: 'track-album', href: albumHref, textContent: a.albumName })
      : el('span', { className: 'track-album', textContent: a.albumName || '' });
    const more = actions.moreButton(targetOf(track, country, { albumHref, ...(canPlay ? { onPlay: () => playTrack(track) } : {}) }));
    const row = el('div', { className: `track pl-track${canPlay ? '' : ' unavailable'}` }, cover,
      el('span', { className: 'track-rank', textContent: String(index + 1) }), main, albumCol,
      el('span', { className: 'track-time', textContent: a.durationInMillis ? formatTime(a.durationInMillis / 1000) : '' }), more);
    if (canPlay) row.addEventListener('dblclick', (e) => { if (!e.target.closest('a, button')) playTrack(track); });
    rows.set(track.id, { row, playBtn });
    return row;
  }

  function renderTracks() {
    rows = new Map();
    // 与排行榜歌单相同，带序号列
    $('tracks').classList.add('chart');
    $('tracks').replaceChildren(...tracks.map(trackRow));
    $('tracks').hidden = !tracks.length;
    $('hint').hidden = !tracks.length;
    $('more').hidden = !tracks.length;
    $('play-all').disabled = !songs().length;
    $('refresh').disabled = busy;
    $('more').disabled = busy;
    moreBtn.disabled = false;
    $('sub').textContent = tracks.length ? t('station.count', { n: tracks.length }) : '';
    syncRows(player.current, !player.transport().paused);
  }

  /** 页面上已有的歌曲之后追加（同一首不重复列出） */
  function appendTracks(list) {
    const seen = new Set(tracks.map((track) => track.id));
    const fresh = list.filter((track) => !seen.has(track.id));
    if (!fresh.length) return fresh;
    const start = tracks.length;
    tracks.push(...fresh);
    $('tracks').append(...fresh.map((track, i) => trackRow(track, start + i)));
    $('tracks').hidden = false;
    $('hint').hidden = false;
    $('more').hidden = false;
    $('play-all').disabled = !songs().length;
    $('sub').textContent = t('station.count', { n: tracks.length });
    syncRows(player.current, !player.transport().paused);
    return fresh;
  }

  /** 取下一批；replace 时换掉页面上的列表（换一批） */
  async function fetchBatch(replace) {
    if (busy) return;
    busy = true;
    $('refresh').disabled = $('more').disabled = true;
    if (!tracks.length) showAlert('info', () => t('station.tracksLoading'));
    try {
      const list = await withToken((token) => nextTracks(id, { token, limit: BATCH }));
      if (signal.aborted) return;
      if (!list.length && !tracks.length) showAlert('info', () => t('station.empty'));
      else showAlert('', '');
      if (replace) { tracks = list; renderTracks(); } else appendTracks(list);
    } catch (err) {
      if (signal.aborted) return;
      showAlert(err.name === 'TokenError' ? 'info' : 'error', () => (err.name === 'TokenError' ? t('station.tokenNeeded') : t('station.tracksFailed', { msg: err.message })));
      if (err.name === 'TokenError') showTokenButton();
    } finally {
      busy = false;
      if (!signal.aborted) { $('refresh').disabled = false; $('more').disabled = false; }
    }
  }

  /** 没有 token（用户取消了对话框）时提示条里的「填写 token」 */
  function showTokenButton() {
    const button = el('button', { className: 'btn station-token-btn', type: 'button', textContent: t('station.tokenSet') });
    button.addEventListener('click', async () => { if (await askToken()) fetchBatch(true); });
    $('alert').append(' ', button);
  }

  /** 播放队列续上的下一批（离开页面后也继续）：页面还在时同时列到页面上 */
  async function more() {
    const list = await nextTracks(id, { limit: BATCH });
    const fresh = signal.aborted ? list : appendTracks(list);
    return fresh.filter((track) => track.type === 'songs' && playable(track)).map(entryOf);
  }

  function playTrack(track) {
    if (player.current && player.current.track === track.id) { player.toggle(); return; }
    const list = songs();
    player.playQueue(list.map(entryOf), Math.max(0, list.indexOf(track)), { more });
  }

  $('play-all').addEventListener('click', () => player.playQueue(songs().map(entryOf), 0, { shuffle: false, more }));
  $('refresh').addEventListener('click', () => fetchBatch(true));
  $('more').addEventListener('click', () => fetchBatch(false));

  function syncRows(current, playing) {
    for (const [trackId, { row, playBtn }] of rows) {
      const active = !!current && current.track === trackId;
      row.classList.toggle('playing', active);
      row.classList.toggle('paused', active && !playing);
      row.classList.toggle('loading', player.pendingTrack === trackId);
      if (playBtn) playBtn.innerHTML = active && playing ? ICON.pause : ICON.play;
    }
  }
  player.onChange(syncRows);

  return {
    update(next, nextKind, cc, stationId) {
      const first = !station;
      station = next; kind = nextKind; country = cc; id = stationId;
      renderHero();
      if (first) fetchBatch(true);
    },
    relabel() {
      if (station) renderHero();
      if (tracks.length) renderTracks();
      if (alertState) showAlert(alertState.type, alertState.message);
    },
    error(err) { showAlert('error', () => t('station.failed', { msg: err.message })); },
  };
}

/* ---------- 直播电台与广播单集：MV 页的布局 ---------- */

function mountStream({ signal, player: music }, $) {
  document.body.classList.add('mv-body', 'station-stream');
  let station = null, kind = null, country = 'us', id = '';
  /** playAssets 的结果与 openRadio 列出的轨道 */
  let asset = null, radio = null, selectedVideo = null, selectedAudio = null;
  let playback = null, downloadController = null, result = null, resultUrl = null, busy = false;
  let statusKey = 'station.loadingStream', statusVars;
  let engine = null;
  const loadEngine = () => (engine ||= import('/assets/mv/radio.mjs'));
  const STATES = { 'station.loadingStream': 'loading', 'mv.license': 'busy', 'mv.buffering': 'busy', 'mv.downloading': 'busy', 'mv.defrag': 'busy',
    'mv.ready': 'idle', 'station.ready': 'idle', 'mv.playing': 'ok', 'station.onAir': 'ok', 'mv.pressPlay': 'ok', 'mv.complete': 'ok',
    'station.completeM4a': 'ok', 'mv.failed': 'error',
    'station.tokenNeeded': 'error' };

  function status(key, vars) {
    statusKey = key; statusVars = vars; $('status').textContent = t(key, vars);
    $('feedback').dataset.state = STATES[key] || 'idle';
  }
  function error(e) { $('error').textContent = e.message; $('error').hidden = false; $('feedback').dataset.state = 'error'; }
  const live = () => !!kind && kind.kind === 'live';
  /** 只有点播（广播单集）能下载 */
  const downloadable = () => !!radio && !live();
  function controls() {
    const ready = !!radio && !busy;
    $('play').disabled = !ready;
    $('download').disabled = !ready || !downloadable();
    $('download').hidden = live();
    $('screen-play').disabled = !ready; $('screen-play').hidden = !!playback;
    $('video-tracks').disabled = busy || !radio || radio.videos.length < 2; $('audio-tracks').disabled = busy || !radio || radio.audios.length < 2;
    if (busy) setOpen(null, false);
    $('cancel').hidden = !busy;
  }
  function stopPlayback() { playback?.stop(); playback = null; $('screen-play').hidden = false; $('live-badge').hidden = true; }
  function badge(text, cls = '') { return el('span', { className: `badge ${cls}`.trim(), textContent: text }); }

  /* ---------- 轨道选择（与 MV 页相同的下拉） ---------- */
  function videoTag(track) {
    const height = Number(String(track.RESOLUTION || '').split('x')[1]) || 0;
    return height >= 2160 ? '4K' : height >= 1440 ? '2K' : height ? `${height}p` : 'Video';
  }
  function audioCodec(codec) {
    const c = String(codec || '').split(',').find((x) => /^(mp4a|ec-3|ac-3|ac-4)/.test(x)) || codec || '';
    return /^mp4a\.40\.(5|29)/.test(c) ? 'HE-AAC' : /^mp4a/.test(c) ? 'AAC' : /^ec-3/.test(c) ? 'E-AC-3' : /^ac-3/.test(c) ? 'AC-3' : c || '—';
  }
  const kbps = (track) => { const b = Number(track['AVERAGE-BANDWIDTH'] || track.BANDWIDTH || 0); return b ? `${Math.round(b / 1000)} kbps` : ''; };
  function describe(track, video) {
    const tag = el('span', { className: 'mv-tag' });
    const heading = el('strong'), detail = el('small');
    if (video) {
      tag.textContent = videoTag(track);
      heading.textContent = [track.RESOLUTION ? track.RESOLUTION.replace('x', '×') : t('station.stream'), kbps(track)].filter(Boolean).join(' · ');
      detail.textContent = [track.codecs || '—', track.kind === 'muxed' ? t('station.withAudio') : ''].filter(Boolean).join(' · ');
    } else {
      tag.textContent = audioCodec(track.codecs);
      heading.textContent = [track.NAME || audioCodec(track.codecs), kbps(track)].filter(Boolean).join(' · ');
      detail.textContent = [track.codecs || '—', track.CHANNELS ? `${track.CHANNELS} ${t('mv.channels')}` : ''].filter(Boolean).join(' · ');
    }
    return [tag, el('span', { className: 'mv-option-body' }, heading, detail)];
  }
  function option(track, video) {
    const name = video ? 'video' : 'audio';
    const label = el('label', { className: 'mv-option' });
    const input = el('input', { type: 'radio', name, checked: track === (video ? selectedVideo : selectedAudio) });
    label.addEventListener('click', (e) => { if (e.detail > 0) setOpen(name, false); });
    input.addEventListener('change', async () => {
      stopPlayback();
      if (video) {
        selectedVideo = track;
        const { radioAudioFor } = await loadEngine();
        if (track.kind === 'video') selectedAudio = radioAudioFor(track, radio.audios) || selectedAudio;
      } else selectedAudio = track;
      renderTracks();
      status(live() ? 'station.ready' : 'mv.ready');
    });
    label.append(...describe(track, video), input);
    return label;
  }
  function setOpen(name, open) {
    for (const k of ['video', 'audio']) {
      const on = k === name && open;
      $(`${k}-trigger`).setAttribute('aria-expanded', String(on)); $(`${k}s`).hidden = !on;
    }
    if (open) $(`${name}s`).querySelector('input:checked')?.focus({ preventScroll: true });
  }
  for (const name of ['video', 'audio']) {
    $(`${name}-trigger`).addEventListener('click', () => setOpen(name, $(`${name}s`).hidden));
    $(`${name}s`).addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      e.preventDefault(); setOpen(name, false); $(`${name}-trigger`).focus();
    });
  }
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('.mv-select')) setOpen(null, false); }, { signal });

  function renderTracks() {
    if (!radio) return;
    // 视频电台：视频轨（合在一起的或分离的音轨）；音频电台：只有音轨
    const videos = radio.videos, audios = selectedVideo && selectedVideo.kind === 'muxed' ? [] : radio.audios;
    $('video-tracks').hidden = !videos.length;
    $('audio-tracks').hidden = !audios.length;
    $('videos').replaceChildren(...videos.map((v) => option(v, true)));
    $('audios').replaceChildren(...audios.map((a) => option(a, false)));
    $('video-count').textContent = videos.length; $('audio-count').textContent = audios.length;
    if (selectedVideo) $('video-value').replaceChildren(...describe(selectedVideo, true));
    if (selectedAudio && audios.length) $('audio-value').replaceChildren(...describe(selectedAudio, false));
    $('selection').textContent = [selectedVideo && (selectedVideo.RESOLUTION || t('station.stream')), selectedAudio && audios.length && `${audioCodec(selectedAudio.codecs)} ${kbps(selectedAudio)}`.trim()]
      .filter(Boolean).join(' · ') || t('station.stream');
    controls();
  }

  /* ---------- 电台信息 ---------- */
  function renderInfo() {
    const a = station.attributes;
    document.title = `${a.name || id} · am-hook`;
    $('eyebrow').textContent = kindLabel(station, kind).toUpperCase();
    $('kind-badge').textContent = kindLabel(station, kind);
    $('title').textContent = a.name || id;
    // 副标题：广播单集为所属节目（radio-show，链接到本站策展人页），直播电台为提供方
    const show = rel(station, 'radio-show').find((r) => r.attributes);
    const showPath = show && (localPath(show.attributes.url) || (/^\d+$/.test(show.id) ? `/https://music.apple.com/${country}/curator/_/${show.id}` : ''));
    const notes = notesOf(a);
    $('artist').replaceChildren(show ? (showPath ? el('a', { href: showPath, textContent: show.attributes.name }) : show.attributes.name)
      : a.stationProviderName || notes.tagline || 'Apple Music');
    const seconds = Math.floor((a.durationInMillis || 0) / 1000);
    $('meta').replaceChildren(...[
      a.airTime && formatRange(a.airTime.start, a.airTime.end),
      seconds > 0 ? formatTime(seconds) : '',
      a.contentRating === 'explicit' ? 'E' : '',
      `ID ${id}`,
    ].filter(Boolean).map((value) => badge(value)));
    $('notes').hidden = !notes.standard;
    $('notes').textContent = notes.standard;
    $('apple-link').href = a.url || `https://music.apple.com/${country}/station/${id}`;
    $('apple-link').hidden = false;
    $('hint').textContent = t(live() ? 'station.liveHint' : kind.video ? 'station.videoHint' : 'station.episodeHint');
    $('download-label').textContent = t(kind.video ? 'mv.download' : 'station.downloadM4a');
    $('save').textContent = t(kind.video ? 'mv.save' : 'station.saveM4a');
    const cover = (a.editorialArtwork && (a.editorialArtwork.subscriptionCover || a.editorialArtwork.staticDetailSquare)) || a.artwork;
    const art = artUrl(cover, 600);
    if (art) {
      $('artwork').src = art; $('artwork').hidden = false;
      // 视频的海报为宽幅封面，音频电台为方形封面（播放时一直显示）
      const wide = a.editorialArtwork && (a.editorialArtwork.superHeroWide || a.editorialArtwork.subscriptionHero);
      $('video').poster = wide ? artUrl(wide, 1600, 900, 'sr') : art;
      $('artwork').onload = () => { $('ambient').style.setProperty('--art', `url("${art}")`); $('ambient').classList.add('on'); };
      $('artwork').onerror = () => { $('artwork').hidden = true; };
    }
    renderSchedule();
    controls();
  }

  /** 节目表：正在直播与之后的节目 */
  function renderSchedule() {
    const now = Date.now();
    const events = rel(station, 'events').filter((e) => e.attributes && Date.parse(e.attributes.endTime) > now)
      .sort((x, y) => Date.parse(x.attributes.startTime) - Date.parse(y.attributes.startTime));
    $('schedule').hidden = !live() || !events.length;
    $('schedule-list').replaceChildren(...events.slice(0, 12).map((e) => {
      const a = e.attributes;
      const onAir = Date.parse(a.startTime) <= now;
      const art = artUrl(a.heroArtwork || a.artwork, 160, 90, 'sr');
      const description = a.description && (a.description.standard || a.description.short);
      return el('li', { className: `station-event${onAir ? ' on-air' : ''}` },
        art ? el('img', { src: art, alt: '', loading: 'lazy', decoding: 'async', onerror: (e) => e.target.replaceWith(el('span', { className: 'ph' })) })
          : el('span', { className: 'ph' }),
        el('span', { className: 'station-event-text' },
          el('span', { className: 'station-event-time', textContent: onAir ? t('station.onAirNow') : formatRange(a.startTime, a.endTime) }),
          el('strong', { textContent: a.title || '' }),
          description ? el('small', { textContent: plainText(description) }) : null));
    }));
  }

  /** emsg 里的当前歌曲：有歌曲 ID 时链接到本站歌曲页 */
  function showNow(meta) {
    const adamId = meta.adamIds && (Object.values(meta.adamIds)[0] || '');
    const text = [meta.title, meta.performer].filter(Boolean).join(' — ');
    $('now-text').replaceChildren(adamId ? el('a', { href: `/https://music.apple.com/${country}/song/_/${adamId}`, textContent: text }) : text);
    $('now').hidden = !text;
  }

  /* ---------- media-user-token：没有或被拒绝时面板里提示填写 ---------- */
  function needToken() {
    status('station.tokenNeeded');
    $('token-text').textContent = t('station.tokenNeeded');
    $('token-box').hidden = false;
  }
  $('token-edit').addEventListener('click', async () => {
    const token = await askToken();
    if (token) { asset = null; radio = null; prepare(); }
  });
  signal.addEventListener('abort', onTokenChange((token) => { if (token) $('token-box').hidden = true; }), { once: true });

  /* ---------- 资源与轨道 ---------- */
  async function prepare() {
    $('error').hidden = true;
    status('station.loadingStream');
    try {
      asset = await withToken((token) => playAssets(station.attributes.playParams, { token, signal }));
      const { openRadio } = await loadEngine();
      radio = await openRadio(asset, { video: kind.video, signal });
      if (signal.aborted) return;
      selectedVideo = radio.videos[0] || null;
      const { radioAudioFor } = await loadEngine();
      selectedAudio = selectedVideo && selectedVideo.kind === 'video' ? radioAudioFor(selectedVideo, radio.audios) : radio.audios[0] || null;
      $('token-box').hidden = true;
      renderTracks();
      status(live() ? 'station.ready' : 'mv.ready');
    } catch (e) {
      if (signal.aborted) return;
      if (e.name === 'TokenError') needToken();
      else { error(e); status('mv.failed'); }
      for (const name of ['video', 'audio']) {
        $(`${name}-value`).replaceChildren(el('span', { className: 'mv-trigger-empty', textContent: t('mv.unavailable') }));
      }
      controls();
    }
  }

  $('play').addEventListener('click', async () => {
    stopPlayback(); $('error').hidden = true; busy = true; controls(); status('mv.license');
    const { RadioPlayback } = await loadEngine();
    const session = new RadioPlayback($('video'), {
      onStatus: (key) => {
        if (downloadController) return;
        if (key === 'live') { status('station.onAir'); $('live-badge').hidden = false; return; }
        status(`mv.${key}`);
      },
      onError: (e) => { if (playback === session) { playback = null; $('live-badge').hidden = true; } error(e); controls(); },
      onMetadata: showNow,
    });
    playback = session;
    try {
      await session.start({ asset, stationId: id, videoTrack: selectedVideo, audioTrack: selectedAudio });
    } catch (e) {
      session.stop(); if (playback === session) playback = null;
      if (e.name === 'TokenError') needToken();
      else if (e.name !== 'AbortError') error(e);
    } finally { busy = false; controls(); }
  });

  /** 广播单集的标签：标题为单集名，艺人与专辑为所属节目，日期为播出日期，封面为单集封面 */
  async function episodeTags(downloadSignal) {
    const a = station.attributes;
    const show = rel(station, 'radio-show').find((r) => r.attributes);
    const owner = (show && show.attributes.name) || a.stationProviderName || 'Apple Music';
    const art = artUrl((a.editorialArtwork && a.editorialArtwork.subscriptionCover) || a.artwork, 1200);
    let cover = null;
    if (art) {
      try {
        const res = await fetch(art, { signal: downloadSignal });
        if (res.ok) { const bytes = new Uint8Array(await res.arrayBuffer()); cover = { bytes, type: imageType(bytes) }; }
      } catch (e) { if (e.name === 'AbortError') throw e; }
    }
    return buildIlst({
      title: a.name, artist: owner, album: owner, albumArtist: owner, genre: t('station.kind.episode'),
      date: a.airTime && a.airTime.start ? a.airTime.start.slice(0, 10) : '', rating: a.contentRating === 'explicit' ? 1 : 0,
      cover, mediaType: kind.video ? 6 : 1,
    });
  }

  $('download').addEventListener('click', async () => {
    stopPlayback(); $('error').hidden = true; busy = true; controls(); status('mv.license');
    downloadController = new AbortController();
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    await result?.dispose(); result = null; $('save').hidden = true;
    $('progress').value = 0; $('progress').hidden = false;
    try {
      const { downloadRadio } = await loadEngine();
      result = await downloadRadio({
        asset, stationId: id, videoTrack: selectedVideo, audioTrack: selectedAudio, signal: downloadController.signal,
        onProgress: (value, bytes) => { $('progress').value = value; status('mv.downloading', { percent: Math.round(value * 100), size: (bytes / 1048576).toFixed(1) }); },
        onDefrag: () => { $('progress').removeAttribute('value'); status('mv.defrag'); },
        tags: () => episodeTags(downloadController.signal).catch((e) => { if (e.name === 'AbortError') throw e; console.warn('episode tags unavailable', e); return null; }),
      });
      const name = station.attributes.name || id;
      const ext = kind.video ? 'mp4' : 'm4a';
      resultUrl = URL.createObjectURL(new File([result.file], `station.${ext}`, { type: kind.video ? 'video/mp4' : 'audio/mp4' }));
      $('save').href = resultUrl;
      $('save').download = `${name} (${id}).${ext}`.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      $('save').hidden = false; $('save').click(); status(kind.video ? 'mv.complete' : 'station.completeM4a');
    } catch (e) {
      if (e.name === 'AbortError') status('mv.cancelled');
      else if (e.name === 'TokenError') needToken();
      else error(e);
    } finally { downloadController = null; busy = false; $('progress').hidden = true; controls(); }
  });

  // 电台与常驻播放条上的音乐同时只播放一个
  $('video').addEventListener('play', () => music.pause());
  music.onChange((current, playing) => { if (playing) $('video').pause(); });
  $('screen-play').addEventListener('click', () => $('play').click());
  $('cancel').addEventListener('click', () => { downloadController?.abort(); stopPlayback(); status('mv.cancelled'); });
  function cleanup() { downloadController?.abort(); stopPlayback(); if (resultUrl) URL.revokeObjectURL(resultUrl); result?.dispose(); result = null; resultUrl = null; }
  signal.addEventListener('abort', cleanup, { once: true });
  addEventListener('pagehide', cleanup, { signal });
  // 节目表每分钟刷新「正在直播」
  const timer = setInterval(() => { if (station && live()) renderSchedule(); }, 60000);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  status(statusKey);
  controls();

  return {
    update(next, nextKind, cc, stationId) {
      const first = !station;
      station = next; kind = nextKind; country = cc; id = stationId;
      renderInfo();
      if (first) prepare();
    },
    relabel() {
      status(statusKey, statusVars);
      if (station) renderInfo();
      renderTracks();
    },
    error(e) { error(e); status('mv.failed'); },
  };
}

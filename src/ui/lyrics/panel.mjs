/*
 * 在线播放的歌词界面：把 am-ttml 的歌词视图接到 AmPlayer 上。
 *
 *   歌词     GET /lyrics/<adamId>（服务端向 wrapper-lite /lyrics 获取的 TTML 原文）
 *   时间     每帧读取 player.transport().currentTime，点击歌词行跳转并继续播放
 *   背景     歌曲页已有的专辑封面，交给 ArtworkBackdrop 生成流动背景
 *
 * 歌词界面只在打开时运行动画循环；关闭后停止，背景保留最后一帧。
 */
import { parseTTML } from './ttml.mjs';
import { LyricView } from './lyric-view.mjs';
import { ArtworkBackdrop } from './backdrop.mjs';

/**
 * root：歌曲页中的 #lyrics-overlay；toggle：播放条上的歌词按钮。
 * getMeta() 返回当前的 { title, artist, artwork }；t 为界面文案函数。
 */
export function mountLyrics({ root, toggle, player, adamId, getMeta, t, onLangChange }) {
  const $ = (selector) => root.querySelector(selector);
  const lines = $('.lyrics-lines');
  const follow = $('.lyrics-follow');
  const options = { translation: $('[data-option="translation"]'), pronunciation: $('[data-option="pronunciation"]') };
  const backdrop = new ArtworkBackdrop($('.lyrics-backdrop'));
  const view = new LyricView(lines, {
    onSeek: (ms) => {
      if (!player.current) return;
      const transport = player.transport();
      transport.currentTime = ms / 1000;
      if (transport.paused) player.toggle();
    },
    labels: () => ({ credits: t('lyrics.credits'), separator: t('lyrics.creditsSeparator'), aiTranslation: t('lyrics.aiTranslation') }),
  });
  let song = null;
  let loaded = false;
  let open = false;
  let frame = 0;
  let playing = null;
  let artworkSource = '';
  let artworkController = null;

  function currentTime() {
    return player.current ? player.transport().currentTime * 1000 : 0;
  }

  function tick() {
    const transport = player.current ? player.transport() : null;
    const now = !!transport && !transport.paused;
    if (now !== playing) { playing = now; view.setPlaying(now); }
    view.setTime(currentTime());
    frame = requestAnimationFrame(tick);
  }

  function renderHeader() {
    const meta = getMeta();
    const art = $('.lyrics-art');
    if (meta.artwork) { if (art.getAttribute('src') !== meta.artwork) art.src = meta.artwork; } else art.removeAttribute('src');
    art.hidden = !meta.artwork;
    $('.lyrics-title').textContent = meta.title || t('player.unknownTitle');
    $('.lyrics-artist').textContent = meta.artist || '';
  }

  /** 背景使用页面已有的封面；取不到封面时保留纯色背景 */
  function loadArtwork() {
    const source = getMeta().artwork || '';
    if (source === artworkSource) { backdrop.resume(); return; }
    artworkSource = source;
    if (artworkController) artworkController.abort();
    artworkController = null;
    if (!source) { backdrop.clear(); root.classList.remove('has-backdrop'); return; }
    const controller = new AbortController();
    artworkController = controller;
    fetch(source, { signal: controller.signal, cache: 'force-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`Artwork HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => (controller.signal.aborted ? false : backdrop.setFile(blob)))
      .then((shown) => {
        if (!shown || controller.signal.aborted) return;
        root.classList.add('has-backdrop');
        if (!open) backdrop.pause();
      })
      .catch((error) => { if (!controller.signal.aborted) console.warn('[am-hook] 歌词背景加载失败', error); });
  }

  function show() {
    if (!song || open) return;
    open = true;
    root.hidden = false;
    document.body.classList.add('lyrics-open');
    toggle.setAttribute('aria-pressed', 'true');
    renderHeader();
    loadArtwork();
    if (!loaded) {
      // 视图需要可见时的尺寸来计算留白与滚动位置
      loaded = true;
      view.load(song);
    } else {
      view.resize();
    }
    view.setTime(currentTime(), { instant: true });
    view.scrollToCurrent(true);
    playing = null;
    frame = requestAnimationFrame(tick);
    $('.lyrics-close').focus({ preventScroll: true });
  }

  function hide() {
    if (!open) return;
    open = false;
    root.hidden = true;
    document.body.classList.remove('lyrics-open');
    toggle.setAttribute('aria-pressed', 'false');
    cancelAnimationFrame(frame);
    frame = 0;
    backdrop.pause();
    toggle.focus({ preventScroll: true });
  }

  function syncOptions() {
    for (const [name, button] of Object.entries(options)) {
      button.setAttribute('aria-pressed', String(view[name]));
    }
  }

  toggle.addEventListener('click', () => (open ? hide() : show()));
  $('.lyrics-close').addEventListener('click', hide);
  for (const [name, button] of Object.entries(options)) {
    button.addEventListener('click', () => {
      view.setOptions({ [name]: !view[name] });
      syncOptions();
    });
  }
  follow.addEventListener('click', () => { view.setFollow(true); view.scrollToCurrent(); });
  lines.addEventListener('followchange', (event) => { follow.hidden = event.detail; });
  document.addEventListener('keydown', (event) => {
    if (open && event.key === 'Escape') { event.preventDefault(); hide(); }
  });
  addEventListener('resize', () => {
    if (!open) return;
    view.resize();
    view.scrollToCurrent(true);
  });
  onLangChange(() => {
    view.relabel();
    if (open) renderHeader();
  });

  fetch(`/lyrics/${adamId}`)
    .then(async (response) => {
      if (response.status === 404) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      song = parseTTML(await response.text());
      if (!song.lines.length) { song = null; return; }
      options.translation.disabled = !song.lines.some((line) => line.translation);
      options.pronunciation.disabled = !song.lines.some((line) => line.pronunciation || line.pronunciationTokens.length);
      syncOptions();
      toggle.hidden = false;
    })
    .catch((error) => console.warn('[am-hook] 歌词加载失败', error));

  return { show, hide, view, get song() { return song; } };
}

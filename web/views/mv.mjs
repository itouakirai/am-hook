// MV 页（/https://music.apple.com/{cc}/music-video/{slug}/{id}），由 app.mjs 挂载。
// 艺人上传的视频（官网 post 页 /https://music.apple.com/{cc}/post/{id}，amp-api 的 uploaded-videos）共用本页：
// 与官网相同，assetTokens 中的各个未加密 MP4 由 <video> 直接播放，下载时原样保存，没有音频轨道可选
import { parseMaster, recommendedAudio } from '/assets/mv/hls.mjs';
import { fetchMaster, Playback, DirectPlayback, downloadMV, downloadDirect, mime, collectGarbage } from '/assets/mv/engine.mjs';
import { mvTags } from '/assets/download/downloads.mjs';
const { t } = AmI18n;

export const bodyClass = 'mv-body';
export const styles = ['/assets/mv/style.css'];

export function mount({ root, url, signal, player: music, onLangChange }) {
  document.title = 'am-hook · MV';
  const $ = id => root.querySelector(`#${id}`);
  // 与 song 页一致：/https://music.apple.com/{cc}/music-video/{slug}/{id}
  // post 页：/https://music.apple.com/{cc}/post/{id}（slug 可省略）
  const postMatch = url.pathname.match(/^\/https:\/\/music\.apple\.com\/([a-z]{2})\/post\/(?:[^/]+\/)?(\d+)\/?$/);
  const post = !!postMatch;
  const [, country = 'us', id] = postMatch || url.pathname.match(/^\/https:\/\/music\.apple\.com\/([a-z]{2})\/music-video\/[^/]+\/(\d+)\/?$/) || [];
  let master, selectedVideo, selectedAudio, playback, downloadController, result, resultUrl, resource;
  let statusKey = 'mv.loading', statusVars, title = `MV ${id || ''}`, artist = '', busy = false;
  // 状态点颜色：进行中闪烁，完成为绿色，失败为红色
  const STATES = { 'mv.loading': 'loading', 'mv.license': 'busy', 'mv.buffering': 'busy', 'mv.downloading': 'busy', 'mv.defrag': 'busy',
    'mv.ready': 'idle', 'mv.playing': 'ok', 'mv.pressPlay': 'ok', 'mv.complete': 'ok', 'mv.failed': 'error' };
  function status(key, vars) {
    statusKey = key; statusVars = vars; $('status').textContent = t(key, vars);
    $('feedback').dataset.state = STATES[key] || 'idle';
  }
  function error(e) { $('error').textContent = e.message; $('error').hidden = false; $('feedback').dataset.state = 'error'; }
  function controls() {
    $('play').disabled = !master || busy;
    $('download').disabled = !master || busy;
    $('screen-play').disabled = !master || busy; $('screen-play').hidden = !!playback;
    $('video-tracks').disabled = busy; $('audio-tracks').disabled = busy;
    if (busy) setOpen(null, false);
    $('cancel').hidden = !busy;
  }
  function stopPlayback() { playback?.stop(); playback = null; $('screen-play').hidden = false; }
  function badge(text, kind = '') {
    const node = document.createElement('span'); node.className = `badge ${kind}`; node.textContent = text; return node;
  }
  function videoTag(track) {
    const height = Number(track.RESOLUTION.split('x')[1]) || 0;
    return height >= 2160 ? '4K' : height >= 1440 ? '2K' : height ? `${height}p` : '—';
  }
  function videoRange(track) {
    if (/^dv(h1|he)/.test(track.CODECS)) return 'Dolby Vision';
    return { PQ: 'HDR10', HLG: 'HLG' }[track['VIDEO-RANGE']] || '';
  }
  function audioTag(track) {
    const [channels, joc] = String(track.CHANNELS || '').split('/');
    return joc === 'JOC' ? 'Atmos' : { 1: '1.0', 2: '2.0', 6: '5.1', 8: '7.1' }[channels] || channels || '—';
  }
  function audioCodec(codec) {
    return /^mp4a/.test(codec) ? 'AAC' : /^ec-3/.test(codec) ? 'E-AC-3' : /^ac-3/.test(codec) ? 'AC-3' : /^ac-4/.test(codec) ? 'AC-4' : codec || '—';
  }
  // 同名音轨（Apple 常见多条 "English"）用 GROUP-ID 末尾的码率区分
  function audioName(track) {
    const name = track.NAME || track.LANGUAGE || 'Audio', kbps = track['GROUP-ID']?.match(/-(\d+)$/)?.[1];
    return kbps && master.audios.filter(a => (a.NAME || a.LANGUAGE || 'Audio') === name).length > 1 ? `${name} · ${kbps} kbps` : name;
  }
  // 一条轨道的展示内容：左侧规格标签 + 标题/参数/徽标；下拉触发按钮与选项共用
  function describe(track, video) {
    const tag = document.createElement('span'); tag.className = 'mv-tag';
    const text = document.createElement('span'), heading = document.createElement('strong'), detail = document.createElement('small');
    text.className = 'mv-option-body';
    if (track.direct) {
      // post 的 MP4：分辨率取自资源键名（1080pHdVideo）与文件名（.1920w. / .640x480.），码率与大小在 HEAD 请求后补上
      tag.textContent = track.height ? `${track.height}p` : 'SD';
      const size = track.width && track.height ? `${track.width}×${track.height}` : track.key;
      heading.textContent = track.bytes && track.seconds ? `${size} · ${(track.bytes * 8 / track.seconds / 1e6).toFixed(2)} Mbps` : size;
      detail.textContent = [track.codec, 'AAC', track.bytes ? `${Math.round(track.bytes / 1048576)} MB` : '', track.key].filter(Boolean).join(' · ');
    } else if (video) {
      tag.textContent = videoTag(track);
      heading.textContent = `${track.RESOLUTION.replace('x', '×')} · ${(Number(track.BANDWIDTH) / 1e6).toFixed(2)} Mbps`;
      const supported = globalThis.MediaSource?.isTypeSupported(mime(track, true));
      detail.textContent = `${track.CODECS.split(',')[0]} · ${track['FRAME-RATE'] ? `${Math.round(Number(track['FRAME-RATE']) * 100) / 100} fps` : '— fps'}`;
      const range = videoRange(track);
      if (range) text.append(badge(range, 'ok'));
      if (!supported) text.append(badge(t('mv.downloadOnly'), 'warn'));
    } else {
      tag.textContent = audioTag(track);
      heading.textContent = audioName(track);
      detail.textContent = `${audioCodec(track.codec)} · ${track.CHANNELS || '—'} ${t('mv.channels')} · ${track['GROUP-ID']}`;
      if (track === recommendedAudio(selectedVideo, master.audios)) text.append(badge(t('mv.recommended'), 'accent'));
    }
    text.prepend(heading, detail); return [tag, text];
  }
  function option(track, video) {
    const kind = video ? 'video' : 'audio';
    const label = document.createElement('label'); label.className = 'mv-option';
    const input = document.createElement('input'); input.type = 'radio'; input.name = kind;
    input.checked = track === (video ? selectedVideo : selectedAudio);
    // 鼠标/触摸点选后收起；方向键切换（detail 为 0）保持展开，便于连续浏览
    label.addEventListener('click', e => { if (e.detail > 0) setOpen(kind, false); });
    input.addEventListener('change', () => {
      stopPlayback();
      if (post) selectedVideo = track;
      else if (video) { selectedVideo = track; selectedAudio = recommendedAudio(track, master.audios); }
      else selectedAudio = track;
      renderTracks();
      if ($(`${kind}s`).hidden) $(`${kind}-trigger`).focus();
      else $(`${kind}s`).querySelector('input:checked')?.focus();
      status('mv.ready');
    });
    label.append(...describe(track, video), input); return label;
  }
  // 两个轨道下拉：同一时间只展开一个
  function setOpen(kind, open) {
    for (const k of ['video', 'audio']) {
      const on = k === kind && open;
      $(`${k}-trigger`).setAttribute('aria-expanded', String(on)); $(`${k}s`).hidden = !on;
    }
    if (open) {
      const list = $(`${kind}s`), checked = list.querySelector('input:checked');
      checked?.focus({ preventScroll: true });
      list.scrollIntoView({ block: 'nearest' }); checked?.closest('.mv-option')?.scrollIntoView({ block: 'nearest' });
    }
  }
  for (const kind of ['video', 'audio']) {
    $(`${kind}-trigger`).addEventListener('click', () => setOpen(kind, $(`${kind}s`).hidden));
    $(`${kind}s`).addEventListener('keydown', e => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      e.preventDefault(); setOpen(kind, false); $(`${kind}-trigger`).focus();
    });
  }
  document.addEventListener('pointerdown', e => { if (!e.target.closest?.('.mv-select')) setOpen(null, false); }, { signal });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(null, false); }, { signal });
  function renderTracks() {
    if (!master) return;
    $('videos').replaceChildren(...master.videos.map(v => option(v, true)));
    $('video-value').replaceChildren(...describe(selectedVideo, true));
    $('video-count').textContent = master.videos.length;
    if (post) {
      const v = selectedVideo;
      $('selection').textContent = [v.width && v.height ? `${v.width}×${v.height}` : v.key, v.codec, 'AAC'].filter(Boolean).join(' · ');
      return;
    }
    $('audios').replaceChildren(...master.audios.map(a => option(a, false)));
    $('audio-value').replaceChildren(...describe(selectedAudio, false));
    $('audio-count').textContent = master.audios.length;
    $('selection').textContent = [selectedVideo.RESOLUTION, videoRange(selectedVideo) || 'SDR', audioName(selectedAudio) || selectedAudio.codec].filter(Boolean).join(' · ');
  }
  /** 艺人资源 → 本站艺人页链接 */
  function artistLink(resource, label = resource.attributes.name) {
    const m = (resource.attributes.url || '').match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/artist\/([^/?#]+)\/(\d+)/i);
    const a = document.createElement('a');
    a.href = m ? `/https://music.apple.com/${m[1].toLowerCase()}/artist/${m[2]}/${m[3]}` : `/https://music.apple.com/${country}/artist/_/${resource.id}`;
    a.textContent = label;
    return a;
  }
  /**
   * 艺人行（如「A, B & C」）中每位艺人的名字链接到其艺人页，分隔符保持原样（与 song 页相同）；
   * 名字对不上而只有一位艺人时，整行链接到该艺人。
   */
  function artistNodes(text, artists) {
    const named = artists.slice().sort((a, b) => b.attributes.name.length - a.attributes.name.length);
    const word = /[\p{L}\p{N}]/u;
    const nodes = [];
    let plain = '', linked = false;
    for (let i = 0; i < text.length;) {
      // 名字前后不能紧挨字母或数字，避免把长名字里的一段当成另一位艺人
      const hit = (i === 0 || !word.test(text[i - 1])) && named.find(a => text.startsWith(a.attributes.name, i)
        && !word.test(text[i + a.attributes.name.length] || ''));
      if (hit) {
        if (plain) nodes.push(plain);
        plain = ''; nodes.push(artistLink(hit)); i += hit.attributes.name.length; linked = true;
      } else plain += text[i++];
    }
    if (plain) nodes.push(plain);
    if (!linked && named.length === 1) return [artistLink(named[0], text)];
    return nodes;
  }
  let metadataSeq = 0;
  /** 显示标题、艺人、封面等；post 页返回资源属性（其中 assetTokens 即可播放的 MP4），取不到时为 undefined */
  async function metadata() {
    // 快速切换语言时只采用最后一次请求的结果
    const seq = ++metadataSeq;
    try {
      // 经服务端 /amp 代理请求 amp-api 的 music-videos / uploaded-videos 资源，名称按曲库语言返回（l 见 AmI18n.catalogLang）
      const url = new URL(`/amp/v1/catalog/${country}/${post ? 'uploaded-videos' : 'music-videos'}/${id}`, location.origin);
      if (!post) url.searchParams.set('include', 'albums,artists');
      const l = await AmI18n.catalogLang(country);
      if (l) url.searchParams.set('l', l);
      let res = await fetch(url, { signal });
      // 语言参数被拒绝时去掉 l，改用地区默认语言
      if (res.status === 400 && url.searchParams.has('l')) { url.searchParams.delete('l'); res = await fetch(url, { signal }); }
      if (!res.ok) return;
      const data = (await res.json()).data?.[0];
      const item = data?.attributes;
      if (!item || seq !== metadataSeq) return;
      resource = data;
      // post 没有艺人，副标题为上传方（官网 subtitleLinks，如 Apple Music Presents）
      title = item.name || title; artist = (post ? item.uploadingBrandName : item.artistName) || '';
      if (signal.aborted) return;
      $('title').textContent = title; document.title = `${title} · am-hook ${post ? 'Video' : 'MV'}`;
      if (post) $('artist').textContent = artist;
      else $('artist').replaceChildren(...artistNodes(artist, (resource.relationships?.artists?.data || []).filter(r => r.attributes?.name)));
      const seconds = Math.floor(Number(item.durationInMillis ?? item.durationInMilliseconds) / 1000);
      $('meta').replaceChildren(...[post ? item.uploadDate : item.releaseDate?.slice(0, 4), item.genreNames?.[0],
        seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '', `ID ${id}`].filter(Boolean).map(value => badge(value)));
      // artwork.url 是 {w}x{h}{c}.{f} 模板
      const artUrl = size => item.artwork?.url?.replace('{w}', size).replace('{h}', size).replace('{c}', 'bb').replace('{f}', 'jpg') || '';
      const art = artUrl(600);
      if (art) {
        $('artwork').src = art; $('artwork').hidden = false; $('video').poster = art;
        $('artwork').onload = () => { $('ambient').style.setProperty('--art', `url("${art}")`); $('ambient').classList.add('on'); };
        $('artwork').onerror = () => { $('artwork').hidden = true; };
      }
      return item;
    } catch (e) { if (e.name !== 'AbortError') console.info('MV metadata unavailable'); }
  }
  /** post 的 assetTokens（{ 1080pHdVideo: url, sdVideo: url, … }）→ 视频选项，分辨率高的在前 */
  function directTracks(item) {
    const seconds = Number(item.durationInMilliseconds) / 1000 || 0;
    return Object.entries(item.assetTokens || {}).filter(([, href]) => /^https:\/\//.test(href)).map(([key, href]) => {
      const file = new URL(href).pathname.split('/').pop();
      // 文件名形如 mzvf_….1920w.h264lc.U.f.m4v 或 ….640x480.h264lc.U.f.m4v
      const [, width, height] = file.match(/\.(\d+)(?:w|x(\d+))\./) || [];
      return { direct: true, key, url: href, seconds, width: Number(width) || 0, height: Number(key.match(/(\d+)p/)?.[1] || height) || 0,
        codec: /\.h264/.test(file) ? 'H.264' : /\.(hevc|hvc1)/.test(file) ? 'HEVC' : '' };
    }).sort((a, b) => b.height - a.height || b.width - a.width);
  }
  /** 各 MP4 的大小（HEAD 的 Content-Length），用于显示码率与文件大小 */
  function probeSizes(tracks) {
    for (const track of tracks) {
      fetch(track.url, { method: 'HEAD', signal }).then(res => {
        const bytes = res.ok && Number(res.headers.get('Content-Length'));
        if (bytes > 0) { track.bytes = bytes; if (master?.videos.includes(track)) renderTracks(); }
      }).catch(() => {});
    }
  }
  $('play').onclick = async () => {
    if (post) {
      stopPlayback(); $('error').hidden = true;
      const session = new DirectPlayback($('video'), key => { if (!downloadController) status(`mv.${key}`); },
        e => { if (playback === session) playback = null; error(e); controls(); });
      playback = session; controls(); session.start(selectedVideo.url);
      return;
    }
    stopPlayback(); $('error').hidden = true; busy = true; controls(); status('mv.license');
    const session = new Playback($('video'), key => { if (!downloadController) status(`mv.${key}`); }, error);
    playback = session;
    try { await session.start(id, selectedVideo, selectedAudio, master.captions); }
    catch (e) { session.stop(); if (playback === session) playback = null; if (e.name !== 'AbortError') error(e); }
    finally { busy = false; controls(); }
  };
  $('download').onclick = async () => {
    stopPlayback(); $('error').hidden = true; busy = true; controls(); status('mv.license');
    downloadController = new AbortController();
    if (resultUrl) URL.revokeObjectURL(resultUrl); await result?.dispose(); result = null; $('save').hidden = true;
    $('progress').value = 0; $('progress').hidden = false;
    try {
      const onProgress = (value, bytes) => {
        $('progress').value = value; status('mv.downloading', { percent: Math.round(value * 100), size: (bytes / 1048576).toFixed(1) });
      };
      // post 的 MP4 未加密且已是标准 MP4（moov 在前），原样保存
      result = post ? await downloadDirect(selectedVideo.url, { signal: downloadController.signal, onProgress })
        : await downloadMV(id, selectedVideo, selectedAudio, { signal: downloadController.signal, onProgress,
          // 标签与批量下载的 MV 相同（设置中心的嵌入字段与封面设置）；取不到元数据时不写
          tags: resource ? () => mvTags(resource, downloadController.signal).catch(e => { console.warn('MV tags unavailable', e); return null; }) : null,
          onDefrag: () => { $('progress').removeAttribute('value'); status('mv.defrag'); } });
      resultUrl = URL.createObjectURL(result.file); $('save').href = resultUrl;
      $('save').download = `${title} (${id}).mp4`.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      $('save').hidden = false; $('save').click(); status('mv.complete');
    } catch (e) { if (e.name === 'AbortError') status('mv.cancelled'); else error(e); }
    finally { downloadController = null; busy = false; $('progress').hidden = true; controls(); }
  };
  // MV 与常驻播放条上的音乐同时只播放一个
  $('video').addEventListener('play', () => music.pause());
  music.onChange((current, playing) => { if (playing) $('video').pause(); });
  $('screen-play').onclick = () => $('play').click();
  $('cancel').onclick =() => { downloadController?.abort(); stopPlayback(); status('mv.cancelled'); };
  // 离开页面或关闭标签页：停止播放、取消下载并清理临时文件
  function cleanup() { downloadController?.abort(); stopPlayback(); if (resultUrl) URL.revokeObjectURL(resultUrl); result?.dispose(); result = null; resultUrl = null; }
  signal.addEventListener('abort', cleanup, { once: true });
  addEventListener('pagehide', cleanup, { signal });
  // 切换语言：标题等由 amp-api 按语言返回，重新获取
  onLangChange(() => { renderTracks(); status(statusKey, statusVars); if (id) void metadata(); });
  status(statusKey);
  if (post) {
    // post 页：只有一组带音频的 MP4，隐藏音频轨道与「自由组合」，文字换成 post 的说明
    title = `Video ${id || ''}`;
    $('audio-tracks').hidden = true;
    root.querySelector('.mv-panel-head .badge').hidden = true;
    for (const [selector, key] of [['.mv-info .eyebrow', 'mv.postKind'], ['#quality-title', 'mv.postQuality'], ['.mv-dock .hint', 'mv.postHint']]) {
      root.querySelector(selector).dataset.i18n = key;
    }
    AmI18n.apply(root);
  }
  async function load() {
    void collectGarbage();
    if (!id) throw new Error(post ? 'Invalid post ID' : 'Invalid music video ID');
    $('title').textContent = title;
    $('meta').replaceChildren(badge(`ID ${id}`));
    $('apple-link').href = post ? `https://music.apple.com/${country}/post/${id}` : `https://music.apple.com/${country}/music-video/_/${id}`;
    $('apple-link').hidden = false;
    if (post) {
      const item = await metadata();
      const videos = item ? directTracks(item) : [];
      if (!videos.length) throw new Error(t('mv.postUnavailable'));
      master = { videos, audios: [] }; selectedVideo = videos[0];
      renderTracks(); controls(); status('mv.ready'); probeSizes(videos);
      return;
    }
    void metadata();
    const { masterUrl, masterBody } = await fetchMaster(id, signal);
    master = parseMaster(masterBody, masterUrl); selectedVideo = master.videos[0]; selectedAudio = recommendedAudio(selectedVideo, master.audios);
    renderTracks(); controls(); status('mv.ready');
  }
  load().catch(e => {
    error(e); status('mv.failed');
    for (const name of ['videos', 'audios']) {
      const message = document.createElement('p'); message.className = 'mv-empty';
      message.dataset.i18n = 'mv.unavailable'; message.textContent = t('mv.unavailable');
      $(name).replaceChildren(message);
      const empty = document.createElement('span'); empty.className = 'mv-trigger-empty';
      empty.dataset.i18n = 'mv.unavailable'; empty.textContent = t('mv.unavailable');
      $(`${name.slice(0, -1)}-value`).replaceChildren(empty);
    }
  });
}

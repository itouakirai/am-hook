import { parseMaster, recommendedAudio } from './hls.mjs';
import { fetchMaster, Playback, downloadMV, mime } from './engine.mjs';
const $ = id => document.getElementById(id), { t } = AmI18n;
// 与 song 页一致：/https://music.apple.com/{cc}/music-video/{slug}/{id}
const [, country = 'us', id] = location.pathname.match(/^\/https:\/\/music\.apple\.com\/([a-z]{2})\/music-video\/[^/]+\/(\d+)\/?$/) || [];
let master, selectedVideo, selectedAudio, playback, downloadController, result, resultUrl;
let statusKey = 'mv.loading', statusVars, title = `MV ${id || ''}`, artist = '', busy = false;
const pageController = new AbortController();
// 状态点颜色：进行中闪烁，完成为绿色，失败为红色
const STATES = { 'mv.loading': 'loading', 'mv.license': 'busy', 'mv.buffering': 'busy', 'mv.downloading': 'busy',
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
  if (video) {
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
    if (video) { selectedVideo = track; selectedAudio = recommendedAudio(track, master.audios); }
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
document.addEventListener('pointerdown', e => { if (!e.target.closest?.('.mv-select')) setOpen(null, false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(null, false); });
function renderTracks() {
  if (!master) return;
  $('videos').replaceChildren(...master.videos.map(v => option(v, true)));
  $('audios').replaceChildren(...master.audios.map(a => option(a, false)));
  $('video-value').replaceChildren(...describe(selectedVideo, true));
  $('audio-value').replaceChildren(...describe(selectedAudio, false));
  $('video-count').textContent = master.videos.length;
  $('audio-count').textContent = master.audios.length;
  $('selection').textContent = [selectedVideo.RESOLUTION, videoRange(selectedVideo) || 'SDR', audioName(selectedAudio) || selectedAudio.codec].filter(Boolean).join(' · ');
}
async function metadata() {
  try {
    const res = await fetch(`https://itunes.apple.com/lookup?id=${id}&country=${country}`, { signal: pageController.signal });
    if (!res.ok) return;
    const item = (await res.json()).results?.find(v => String(v.trackId) === id);
    if (!item) return;
    title = item.trackName || title; artist = item.artistName || '';
    $('title').textContent = title; $('artist').textContent = artist; document.title = `${title} · am-hook MV`;
    const seconds = Math.floor(Number(item.trackTimeMillis) / 1000);
    $('meta').replaceChildren(...[item.releaseDate?.slice(0, 4), item.primaryGenreName,
      seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '', `ID ${id}`].filter(Boolean).map(value => badge(value)));
    if (item.artworkUrl100) {
      const art = item.artworkUrl100.replace('100x100bb', '600x600bb');
      $('artwork').src = art; $('artwork').hidden = false; $('video').poster = art;
      $('artwork').onload = () => { $('ambient').style.setProperty('--art', `url("${art}")`); $('ambient').classList.add('on'); };
      $('artwork').onerror = () => { $('artwork').hidden = true; };
    }
    try {
      const old = JSON.parse(localStorage.getItem('am-hook:recent') || '[]');
      const recent = { id, title, artist, artwork: item.artworkUrl100, link: `https://music.apple.com/${country}/music-video/_/${id}` };
      localStorage.setItem('am-hook:recent', JSON.stringify([recent, ...(Array.isArray(old) ? old.filter(r => r.id !== id) : [])].slice(0, 12)));
    } catch {}
  } catch (e) { if (e.name !== 'AbortError') console.info('MV metadata unavailable'); }
}
$('play').onclick = async () => {
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
    result = await downloadMV(id, selectedVideo, selectedAudio, { signal: downloadController.signal, onProgress: (value, bytes) => {
      $('progress').value = value; status('mv.downloading', { percent: Math.round(value * 100), size: (bytes / 1048576).toFixed(1) });
    } });
    resultUrl = URL.createObjectURL(result.file); $('save').href = resultUrl;
    $('save').download = `${title} (${id}).mp4`.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    $('save').hidden = false; $('save').click(); status('mv.complete');
  } catch (e) { if (e.name === 'AbortError') status('mv.cancelled'); else error(e); }
  finally { downloadController = null; busy = false; $('progress').hidden = true; controls(); }
};
$('screen-play').onclick = () => $('play').click();
$('cancel').onclick =() => { downloadController?.abort(); stopPlayback(); status('mv.cancelled'); };
window.addEventListener('pagehide', () => { pageController.abort(); downloadController?.abort(); stopPlayback(); if (resultUrl) URL.revokeObjectURL(resultUrl); result?.dispose(); });
AmI18n.onChange(() => { renderTracks(); status(statusKey, statusVars); });
AmI18n.apply(); status(statusKey);
async function load() {
  if (!id) throw new Error('Invalid music video ID');
  $('title').textContent = title; void metadata();
  $('meta').replaceChildren(badge(`ID ${id}`));
  $('apple-link').href = `https://music.apple.com/${country}/music-video/_/${id}`;
  $('apple-link').hidden = false;
  const { masterUrl, masterBody } = await fetchMaster(id, pageController.signal);
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

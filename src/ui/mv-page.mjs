import { parseMaster, recommendedAudio } from './hls.mjs';
import { webplayback, Playback, downloadMV, mime } from './engine.mjs';
const $ = id => document.getElementById(id), { t } = AmI18n;
const id = location.pathname.match(/^\/mv\/(\d+)$/)?.[1];
const country = /^[a-z]{2}$/.test(new URLSearchParams(location.search).get('country') || '') ? new URLSearchParams(location.search).get('country') : 'us';
let master, selectedVideo, selectedAudio, playback, downloadController, result, resultUrl;
let statusKey = 'mv.loading', statusVars, title = `MV ${id || ''}`, artist = '', busy = false;
const pageController = new AbortController();
function status(key, vars) { statusKey = key; statusVars = vars; $('status').textContent = t(key, vars); }
function error(e) { $('error').textContent = e.message; $('error').hidden = false; }
function controls() {
  $('play').disabled = !master || busy;
  $('download').disabled = !master || busy;
  $('video-tracks').disabled = busy; $('audio-tracks').disabled = busy;
  $('cancel').hidden = !busy;
}
function stopPlayback() { playback?.stop(); playback = null; }
function option(track, video) {
  const label = document.createElement('label'); label.className = 'mv-option';
  const input = document.createElement('input'); input.type = 'radio'; input.name = video ? 'video' : 'audio';
  input.checked = track === (video ? selectedVideo : selectedAudio);
  const text = document.createElement('span'), heading = document.createElement('strong'), detail = document.createElement('small');
  if (video) {
    heading.textContent = `${track.RESOLUTION} · ${(Number(track.BANDWIDTH) / 1e6).toFixed(2)} Mbps`;
    const supported = globalThis.MediaSource?.isTypeSupported(mime(track, true));
    detail.textContent = `${track.CODECS.split(',')[0]} · ${track['FRAME-RATE'] || '—'} fps · ${track['VIDEO-RANGE'] || 'SDR'}${supported ? '' : ' · ' + t('mv.downloadOnly')}`;
  } else {
    heading.textContent = `${track.NAME || track.LANGUAGE || 'Audio'} · ${track['GROUP-ID']}`;
    detail.textContent = `${track.codec || '—'} · ${track.CHANNELS || '—'} ${t('mv.channels')}${track === recommendedAudio(selectedVideo, master.audios) ? ' · ' + t('mv.recommended') : ''}`;
  }
  input.addEventListener('change', () => {
    stopPlayback();
    if (video) { selectedVideo = track; selectedAudio = recommendedAudio(track, master.audios); }
    else selectedAudio = track;
    renderTracks(); status('mv.ready');
  });
  text.append(heading, detail); label.append(input, text); return label;
}
function renderTracks() {
  if (!master) return;
  $('videos').replaceChildren(...master.videos.map(v => option(v, true)));
  $('audios').replaceChildren(...master.audios.map(a => option(a, false)));
}
async function metadata() {
  try {
    const res = await fetch(`https://itunes.apple.com/lookup?id=${id}&country=${country}`, { signal: pageController.signal });
    if (!res.ok) return;
    const item = (await res.json()).results?.find(v => String(v.trackId) === id);
    if (!item) return;
    title = item.trackName || title; artist = item.artistName || '';
    $('title').textContent = title; $('artist').textContent = artist; document.title = `${title} · am-hook MV`;
    if (item.artworkUrl100) {
      const art = item.artworkUrl100.replace('100x100bb', '600x600bb');
      $('artwork').src = art; $('artwork').hidden = false; $('video').poster = art;
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
  catch (e) { session.stop(); if (e.name !== 'AbortError') error(e); }
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
$('cancel').onclick = () => { downloadController?.abort(); stopPlayback(); status('mv.cancelled'); };
window.addEventListener('pagehide', () => { pageController.abort(); downloadController?.abort(); stopPlayback(); if (resultUrl) URL.revokeObjectURL(resultUrl); result?.dispose(); });
AmI18n.onChange(() => { renderTracks(); status(statusKey, statusVars); });
AmI18n.apply(); status(statusKey);
async function load() {
  if (!id) throw new Error('Invalid music video ID');
  $('title').textContent = title; void metadata();
  const url = await webplayback(id, pageController.signal);
  const res = await fetch(url, { signal: pageController.signal });
  if (!res.ok) throw new Error(`Master playlist HTTP ${res.status}`);
  master = parseMaster(await res.text(), url); selectedVideo = master.videos[0]; selectedAudio = recommendedAudio(selectedVideo, master.audios);
  renderTracks(); controls(); status('mv.ready');
}
load().catch(error);

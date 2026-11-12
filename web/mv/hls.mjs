// HLS parsing stays in the browser. Only PlayReady key declarations are used; some older MVs are unencrypted.
export function attributes(value) {
  const result = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/g;
  for (const m of value.matchAll(re)) result[m[1]] = m[2] ?? m[3];
  return result;
}
export function mvLink(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.hostname !== 'music.apple.com') return null;
    const m = u.pathname.match(/^\/([a-z]{2})\/music-video\/(?:[^/]+\/)?(\d+)\/?$/i);
    return m ? { id: m[2], country: m[1].toLowerCase() } : null;
  } catch { return null; }
}
function absolute(uri, base) {
  const u = new URL(uri, base);
  if (u.protocol !== 'https:') throw new Error('Expected an HTTPS media URL');
  return u.href;
}
export function parseMaster(text, url) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid HLS master playlist');
  const videos = [], audios = [], captions = []; let pending;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attributes(line.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI) audios.push({ ...a, url: absolute(a.URI, url) });
      if (a.TYPE === 'CLOSED-CAPTIONS') captions.push(a);
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) pending = attributes(line.slice(18));
    else if (line && !line.startsWith('#') && pending) {
      if (pending.RESOLUTION) videos.push({ ...pending, url: absolute(line, url) });
      pending = null;
    }
  }
  videos.sort((a, b) => Number(b.BANDWIDTH) - Number(a.BANDWIDTH));
  for (const a of audios) {
    a.codec = videos.filter(v => v.AUDIO === a['GROUP-ID']).flatMap(v => (v.CODECS || '').split(','))
      .find(c => /^(mp4a|ac-3|ec-3|ac-4)/.test(c)) || '';
  }
  if (!videos.length || !audios.length) throw new Error('No separate video/audio tracks found');
  return { videos, audios, captions };
}
export function recommendedAudio(video, audios) {
  return audios.find(a => a['GROUP-ID'] === video.AUDIO && a.DEFAULT === 'YES')
    || audios.find(a => a['GROUP-ID'] === video.AUDIO) || audios[0];
}
// Track selection of the reference downloader (extractVideoVariant / extractMvAudio), used by batch
// downloads and as the MV page's default: settings mvMax (height) and mvAudio (atmos / ac3 / aac).
const height = v => Number(String(v.RESOLUTION || '').split('x')[1]) || 0;
const bandwidth = v => Number(v['AVERAGE-BANDWIDTH'] || v.BANDWIDTH || 0);
// Highest average bandwidth within max height; the lowest video when every one is taller.
export function pickMvVideo(videos, max) {
  const list = [...videos].sort((a, b) => bandwidth(b) - bandwidth(a));
  return list.find(v => height(v) <= max) || list.sort((a, b) => height(a) - height(b))[0] || null;
}
// Higher is better; -1 means the group is not allowed for the audio type.
function audioScore(group, type) {
  const kbps = prefix => Number(group.slice(prefix.length)) || 0;
  if (group === 'audio-atmos') return type === 'atmos' ? 10000 : -1;
  if (group === 'audio-ac3') return type === 'aac' ? -1 : type === 'ac3' ? 10000 : 9000;
  if (group.startsWith('audio-stereo-')) return 8000 + kbps('audio-stereo-');
  if (group.startsWith('audio-HE-stereo-')) return 7000 + kbps('audio-HE-stereo-');
  if (group.startsWith('audio-HE2-stereo-')) return 6000 + kbps('audio-HE2-stereo-');
  return -1;
}
// Ties go to the larger _gr{n}_ in the URI.
export function pickMvAudio(audios, type) {
  const rank = a => Number((a.URI || a.url || '').match(/_gr(\d+)_/)?.[1]) || 0;
  const list = audios.map(a => ({ a, score: audioScore(a['GROUP-ID'] || '', type) })).filter(x => x.score >= 0);
  list.sort((x, y) => y.score - x.score || rank(y.a) - rank(x.a));
  return list[0]?.a || null;
}
// File name variables codec / quality, e.g. "2160p HEVC Dolby Vision · Dolby Atmos".
export function mvQualityVars(video, audio) {
  const vc = (video.CODECS || '').split(',').find(c => /^(avc|hvc|hev|dvh|av01)/.test(c)) || '';
  const codec = /^(hvc|hev|dvh)/.test(vc) ? 'HEVC' : /^av01/.test(vc) ? 'AV1' : 'H.264';
  const range = /^dvh/.test(vc) ? 'Dolby Vision' : { PQ: 'HDR10', HLG: 'HLG' }[video['VIDEO-RANGE']] || '';
  const group = audio['GROUP-ID'] || '', kbps = group.match(/-(\d+)$/)?.[1];
  const sound = group === 'audio-atmos' ? 'Dolby Atmos' : /^ec-3/.test(audio.codec || '') ? 'E-AC-3'
    : /^ac-3/.test(audio.codec || '') || group === 'audio-ac3' ? 'AC-3' : `${/HE2?-/.test(group) ? 'HE-AAC' : 'AAC'}${kbps ? ` ${kbps}kbps` : ''}`;
  return { codec, quality: `${height(video)}p ${codec}${range ? ` ${range}` : ''} · ${sound}`, bit_depth: '', sample_rate: '', sample_rate_kHz: '' };
}
export function parseMedia(text, url) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid HLS media playlist');
  const segments = []; let init, key, encrypted = false, duration, range, time = 0, previous;
  function resource(uri, spec) {
    const r = { url: absolute(uri, url) };
    if (spec) {
      const m = /^(\d+)(?:@(\d+))?$/.exec(spec);
      if (!m) throw new Error('Invalid HLS byte range');
      const offset = m[2] === undefined ? (previous?.url === r.url ? previous.end : NaN) : Number(m[2]);
      const length = Number(m[1]);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length <= 0) throw new Error('Invalid HLS byte range offset');
      r.range = { offset, length }; previous = { url: r.url, end: offset + length };
    } else previous = null;
    return r;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-KEY:')) {
      const a = attributes(line.slice(11));
      encrypted = a.METHOD !== 'NONE';
      if (!encrypted) key = null;
      else if (a.KEYFORMAT === 'com.microsoft.playready') {
        if (!a.URI?.startsWith('data:') || !a.URI.includes(';base64,')) throw new Error('Unsupported PlayReady key URI');
        key = a.URI;
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attributes(line.slice(11)); init = resource(a.URI, a.BYTERANGE);
    } else if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
    else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.slice(17);
    else if (line === '#EXT-X-DISCONTINUITY') throw new Error('Discontinuous MV playlists are not supported');
    else if (line && !line.startsWith('#')) {
      if (!init || !Number.isFinite(duration) || duration <= 0) throw new Error('Missing init or segment duration');
      if (encrypted && !key) throw new Error('No PlayReady key for encrypted MV media');
      segments.push({ ...resource(line, range), init, key, start: time, duration });
      time += duration; duration = undefined; range = undefined;
    }
  }
  if (!segments.length) throw new Error('No MV media segments found');
  if (!text.includes('#EXT-X-ENDLIST')) throw new Error('Only completed MV playlists are supported');
  return { segments, duration: time, init: segments[0].init };
}
export async function fetchResource(resource, signal) {
  const headers = {};
  if (resource.range) headers.Range = `bytes=${resource.range.offset}-${resource.range.offset + resource.range.length - 1}`;
  const res = await fetch(resource.url, { headers, signal });
  if (!res.ok) throw new Error(`Media HTTP ${res.status}`);
  // Never buffer a whole MV when a CDN ignores Range.
  if (resource.range && res.status !== 206) { await res.body?.cancel(); throw new Error('CDN did not honor the byte range'); }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (resource.range && bytes.length !== resource.range.length) throw new Error('Truncated media range');
  return bytes;
}

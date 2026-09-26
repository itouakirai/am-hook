// HLS parsing stays in the browser. Only PlayReady key declarations are used.
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
export function parseMedia(text, url) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid HLS media playlist');
  const segments = []; let init, key, duration, range, time = 0, previous;
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
      if (a.METHOD === 'NONE') key = null;
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
      segments.push({ ...resource(line, range), init, key, start: time, duration });
      time += duration; duration = undefined; range = undefined;
    }
  }
  if (!segments.length || !segments.some(s => s.key)) throw new Error('No PlayReady media found');
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

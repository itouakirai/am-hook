// 电台（官网 /{cc}/station/{slug}/ra.{id}）用到的、需要用户 media-user-token 的接口。wrapper-lite 没有这些接口，
// 由服务端（src/amp.rs 的 station_*_handler，serverless/core.mjs 的同名路由）带上 developer token 转发给 Apple，
// media-user-token 保存在本站的 HttpOnly cookie 里（POST /station/token 设置），页面脚本读不到，电台请求由浏览器自动带上；
// 服务端只转发，不保存。页面只在 localStorage 里记下「已填写」与末尾几位（设置中心显示用）。
//
// 电台按 playParams 分三类（与 MusicKit 的判断相同）：
//   tracks   format=tracks：个人电台与编辑电台（风格电台、艺人电台等），播放时取「接下来的几首」（/v1/me/stations/next-tracks）
//   live     format=stream 且 isLive：直播电台（Apple Music 1、各地广播），以及直播过的视频节目
//   episode  format=stream 且 streamingRadioSubType=Episode：广播单集（点播，音频或视频）
// 后两类由 /v1/play/assets 取得 HLS 地址与 license 服务器（MusicKit 的 resolveRadioStationAsset），license 请求体的格式随服务器地址而定
import { openDialog } from './views/library-ui.mjs';

const { AmI18n } = window;
const { t } = AmI18n;

/** 已填写 token 的标记：token 末尾 6 位（不是 token 本身） */
const MARK_KEY = 'am-hook:station-token';
const listeners = new Set();
// 旧版本把 token 本身存在 localStorage 里：删掉
try { localStorage.removeItem('am-hook:media-user-token'); } catch {}

/** 已填写的 token 的末尾几位，没有填写时为 ''（token 本身在 HttpOnly cookie 里，脚本读不到） */
export function tokenTail() {
  try { return localStorage.getItem(MARK_KEY) || ''; } catch { return ''; }
}

function mark(tail) {
  try {
    if (tail) localStorage.setItem(MARK_KEY, tail); else localStorage.removeItem(MARK_KEY);
  } catch {}
  for (const fn of listeners) fn(tail);
}

/** 交给服务端存进 cookie，并通知 onTokenChange（参数为末尾几位） */
async function saveToken(token) {
  const res = await fetch('/station/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && data.msg) || `HTTP ${res.status}`);
  }
  mark(token.slice(-6));
}

/** 清除 cookie 与标记 */
export async function clearToken() {
  await fetch('/station/token', { method: 'DELETE' }).catch(() => {});
  mark('');
}

/** token 变化后回调；返回取消函数 */
export function onTokenChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 粘贴的可能是整段 Cookie（media-user-token=…; 其他=…）或带引号的值：只取 token 本身 */
export function cleanToken(raw) {
  let value = String(raw || '').trim();
  const cookie = value.match(/(?:^|;\s*)media-user-token=([^;]+)/i);
  if (cookie) value = cookie[1];
  return value.replace(/^["']|["']$/g, '').trim();
}

/** 服务端或 Apple 拒绝了 token（缺失、失效、无订阅等） */
export class TokenError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TokenError';
    this.status = status;
  }
}

/** 请求本站的 /station/...（token 在 cookie 里，由浏览器带上）；401 / 403 抛出 TokenError，其余错误抛出 Error（含 amp-api 的说明） */
async function call(path, { method = 'GET', body, signal } = {}) {
  if (!tokenTail()) throw new TokenError(t('station.tokenMissing'), 401);
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await res.json().catch(() => null);
  const detail = data && ((data.errors && data.errors[0] && (data.errors[0].detail || data.errors[0].title)) || data.msg || data.message);
  if (res.status === 401 || res.status === 403) throw new TokenError(detail || t('station.tokenRejected', { status: res.status }), res.status);
  if (!res.ok || !data) throw new Error(detail || `HTTP ${res.status}`);
  return data;
}

/** 检验已保存的 token：返回账号所在地区 { id, name } */
export async function tokenStorefront(signal) {
  const data = await call('/station/storefront', { signal });
  const sf = (data.data || [])[0];
  if (!sf) throw new Error('empty response');
  return { id: sf.id, name: (sf.attributes && sf.attributes.name) || sf.id };
}

let asking = null;

/**
 * 请用户填写 media-user-token（第一次打开电台页，或 token 被拒绝时）。填入后先检验，失败时在对话框里说明并让用户重填。
 * 返回新的 token；取消时为 ''。同时只开一个对话框，其他调用者等同一个结果
 */
export function askToken({ reason = '' } = {}) {
  asking ||= (async () => {
    let error = reason;
    let value = '';
    for (;;) {
      const message = [t('station.tokenHelp'), error].filter(Boolean).join('\n\n');
      const result = await openDialog({
        title: t('station.tokenTitle'), message,
        fields: [{ name: 'token', label: 'media-user-token', value, placeholder: t('station.tokenPlaceholder'), multiline: true, maxLength: 8192 }],
        buttons: [{ value: 'save', label: t('station.tokenSave') }, ...(tokenTail() ? [{ value: 'clear', label: t('station.tokenClear'), danger: true }] : [])],
      });
      if (!result) return '';
      if (result.action === 'clear') { await clearToken(); return ''; }
      value = cleanToken(result.values.token);
      if (!value) { error = t('station.tokenEmpty'); continue; }
      // 先存进 cookie 再检验；检验失败时清除，不留下无效的 token
      try {
        await saveToken(value);
        const sf = await tokenStorefront();
        return { token: tokenTail(), storefront: sf };
      } catch (err) {
        await clearToken();
        error = err instanceof TokenError ? t('station.tokenInvalid', { msg: err.message }) : t('station.tokenCheckFailed', { msg: err.message });
      }
    }
  })().finally(() => { asking = null; });
  return asking.then((result) => (result ? result.token : ''));
}

/** 已有 token 时直接返回（末尾几位），否则请用户填写（取消时为 ''） */
export async function ensureToken() {
  return tokenTail() || askToken();
}

/**
 * 执行 fn()；token 缺失或被拒绝时请用户重新填写后再试一次。用户取消时抛出 TokenError
 */
export async function withToken(fn) {
  if (!(await ensureToken())) throw new TokenError(t('station.tokenMissing'), 401);
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof TokenError)) throw err;
    if (!(await askToken({ reason: t('station.tokenInvalid', { msg: err.message }) }))) throw err;
    return fn();
  }
}

/* ---------- 电台的种类 ---------- */

/** 电台资源 → { kind: 'tracks' | 'live' | 'episode' | 'stream', video }；不是电台时为 null */
export function stationKind(res) {
  const a = (res && res.attributes) || {};
  const p = a.playParams || {};
  if (!res || res.type !== 'stations') return null;
  const video = a.mediaKind === 'video' || p.mediaType === 1;
  if (p.format === 'tracks') return { kind: 'tracks', video: false };
  if (a.isLive) return { kind: 'live', video };
  if (String(a.streamingRadioSubType || '').toLowerCase() === 'episode') return { kind: 'episode', video };
  return { kind: p.format === 'stream' ? 'stream' : 'tracks', video };
}

/* ---------- 接口 ---------- */

/** 个人 / 编辑电台接下来要播放的几首（songs 资源，带完整属性） */
export async function nextTracks(id, { limit, signal } = {}) {
  const query = limit ? `?limit=${limit}` : '';
  const data = await call(`/station/next-tracks/${encodeURIComponent(id)}${query}`, { method: 'POST', signal });
  return (data.data || []).filter((r) => r && r.attributes);
}

/** 个人电台（官网 /station/me：stations?filter[identity]=personal）；没有时为 null */
export async function personalStation(cc, { l, signal } = {}) {
  const query = new URLSearchParams({ 'filter[identity]': 'personal', extend: 'editorialArtwork', 'art[url]': 'c,f' });
  if (l) query.set('l', l);
  const data = await call(`/station/catalog/${encodeURIComponent(cc)}/stations?${query}`, { signal });
  return (data.data || []).find((r) => r && r.attributes) || null;
}

/** 最近播放的电台（官网 recently-played-radio-shelf 的请求） */
export async function recentStations({ l, limit = 30, signal } = {}) {
  const query = new URLSearchParams({ limit: String(limit), 'include[stations]': 'radio-show', 'omit[resource]': 'autos', 'art[url]': 'c,f' });
  if (l) query.set('l', l);
  const data = await call(`/station/recent?${query}`, { signal });
  return (data.data || []).filter((r) => r && r.type === 'stations' && r.attributes);
}

/** 直播电台与广播单集的播放资源：{ url, keyServerUrl, widevineKeyCertificateUrl, … }（/v1/play/assets，参数为 playParams 加 keyFormat=web） */
export async function playAssets(playParams, { signal } = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(playParams || {})) if (value !== undefined && value !== null) query.set(key, String(value));
  query.set('keyFormat', 'web');
  const data = await call(`/station/assets?${query}`, { signal });
  const assets = (data.results && data.results.assets) || [];
  if (!assets.length || !assets[0].url) throw new Error(t('station.noAssets'));
  return assets[0];
}

/** key-system 字段（MusicKit 的 Y 表） */
const KEY_SYSTEMS = { widevine: 'com.widevine.alpha', playready: 'com.microsoft.playready' };

/**
 * license 请求体与响应的取法，随 license 服务器地址而定（MusicKit 的三个 license manager）：
 *   radio：acquireWebPlaybackLicense / web/radio/versions/1/license / v1/radio/streaming-key-delivery，请求体平铺，响应 { status, license }
 *   streaming：fpsRequest / v1/hls/streaming-key-delivery，streaming-request 包装，响应 streaming-response.streaming-keys[0]
 *   podcast：podcast/hls/license/streaming/start，license-requests 包装，响应 license-responses[0]
 */
export function licenseFormat(url) {
  const path = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
  if (path.endsWith('/podcast/hls/license/streaming/start')) return 'podcast';
  if (/\/(?:fpsRequest|v1\/hls\/(?:anonymous\/)?streaming-key-delivery)$/.test(path)) return 'streaming';
  return 'radio';
}

export function licenseBody(format, { adamId, challenge, uri, drm, queryParameters = {} }) {
  const keySystem = KEY_SYSTEMS[drm];
  if (format === 'streaming') {
    return { 'streaming-request': { version: 1, 'streaming-keys': [{ 'lease-action': 'start', id: 1, challenge, uri, 'key-system': keySystem, ...queryParameters }] } };
  }
  if (format === 'podcast') return { version: 1, 'license-requests': [{ id: 1, 'adam-id': adamId, challenge, uri, 'key-system': keySystem }] };
  return { adamId, isLibrary: false, 'user-initiated': true, challenge, uri, 'key-system': keySystem };
}

/** 响应 → base64 license；status 不为 0 时抛出错误 */
export function licenseOf(format, data) {
  const entry = format === 'streaming' ? data && data['streaming-response'] && (data['streaming-response']['streaming-keys'] || [])[0]
    : format === 'podcast' ? data && (data['license-responses'] || [])[0] : data;
  if (!entry) throw new Error(t('station.noLicense'));
  if (entry.status !== undefined && Number(entry.status) !== 0) throw new Error(t('station.licenseStatus', { status: entry.status }));
  if (!entry.license) throw new Error(t('station.noLicense'));
  return entry.license;
}

/**
 * 向电台的 license 服务器请求 license，返回 base64 license。
 * asset：playAssets 的结果；adamId：电台 ID；challenge / uri：媒体 Worker 生成的请求（见 mv/radio.mjs）；drm：'widevine' | 'playready'
 */
export async function requestLicense(asset, { adamId, challenge, uri, drm, signal }) {
  const url = asset.keyServerUrl;
  if (!url) throw new Error(t('station.noKeyServer'));
  const format = licenseFormat(url);
  const body = licenseBody(format, { adamId, challenge, uri, drm, queryParameters: asset.keyServerQueryParameters || {} });
  const data = await call('/station/license', { method: 'POST', body: { url, body, renewal: drm === 'widevine' }, signal });
  return licenseOf(format, data);
}

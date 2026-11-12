// 电台（官网 /{cc}/station/{slug}/ra.{id}）用到的、需要用户 media-user-token 的接口。wrapper-lite 没有这些接口，
// 由服务端（src/amp.rs 的 station_*_handler，serverless/core.mjs 的同名路由）带上 developer token 转发给 Apple，
// media-user-token 只保存在本浏览器（localStorage），每次请求经 X-Media-User-Token 带给服务端，服务端不保存。
//
// 电台按 playParams 分三类（与 MusicKit 的判断相同）：
//   tracks   format=tracks：个人电台与编辑电台（风格电台、艺人电台等），播放时取「接下来的几首」（/v1/me/stations/next-tracks）
//   live     format=stream 且 isLive：直播电台（Apple Music 1、各地广播），以及直播过的视频节目
//   episode  format=stream 且 streamingRadioSubType=Episode：广播单集（点播，音频或视频）
// 后两类由 /v1/play/assets 取得 HLS 地址与 license 服务器（MusicKit 的 resolveRadioStationAsset），license 请求体的格式随服务器地址而定
import { openDialog } from './views/library-ui.mjs';

const { AmI18n } = window;
const { t } = AmI18n;

const STORAGE_KEY = 'am-hook:media-user-token';
const listeners = new Set();

/** 保存的 media-user-token，没有时为 '' */
export function userToken() {
  try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
}

/** 保存（空值为清除）并通知 onTokenChange */
export function setUserToken(value) {
  const token = String(value || '').trim();
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token); else localStorage.removeItem(STORAGE_KEY);
  } catch {}
  for (const fn of listeners) fn(token);
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

/** 带 token 请求本站的 /station/...；401 / 403 抛出 TokenError，其余错误抛出 Error（含 amp-api 的说明） */
async function call(path, { method = 'GET', body, token = userToken(), signal } = {}) {
  if (!token) throw new TokenError(t('station.tokenMissing'), 401);
  const headers = { 'X-Media-User-Token': token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await res.json().catch(() => null);
  const detail = data && ((data.errors && data.errors[0] && (data.errors[0].detail || data.errors[0].title)) || data.msg || data.message);
  if (res.status === 401 || res.status === 403) throw new TokenError(detail || t('station.tokenRejected', { status: res.status }), res.status);
  if (!res.ok || !data) throw new Error(detail || `HTTP ${res.status}`);
  return data;
}

/** 检验 token：返回账号所在地区 { id, name } */
export async function tokenStorefront(token, signal) {
  const data = await call('/station/storefront', { token, signal });
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
    let value = userToken();
    for (;;) {
      const message = [t('station.tokenHelp'), error].filter(Boolean).join('\n\n');
      const result = await openDialog({
        title: t('station.tokenTitle'), message,
        fields: [{ name: 'token', label: 'media-user-token', value, placeholder: t('station.tokenPlaceholder'), multiline: true, maxLength: 8192 }],
        buttons: [{ value: 'save', label: t('station.tokenSave') }, ...(userToken() ? [{ value: 'clear', label: t('station.tokenClear'), danger: true }] : [])],
      });
      if (!result) return '';
      if (result.action === 'clear') { setUserToken(''); return ''; }
      value = cleanToken(result.values.token);
      if (!value) { error = t('station.tokenEmpty'); continue; }
      try {
        const sf = await tokenStorefront(value);
        setUserToken(value);
        return { token: value, storefront: sf };
      } catch (err) {
        error = err instanceof TokenError ? t('station.tokenInvalid', { msg: err.message }) : t('station.tokenCheckFailed', { msg: err.message });
      }
    }
  })().finally(() => { asking = null; });
  return asking.then((result) => (result ? result.token : ''));
}

/** 已有 token 时直接返回，否则请用户填写（取消时为 ''） */
export async function ensureToken() {
  return userToken() || askToken();
}

/**
 * 执行 fn(token)；token 缺失或被拒绝时请用户重新填写后再试一次。用户取消时抛出 TokenError
 */
export async function withToken(fn) {
  let token = await ensureToken();
  if (!token) throw new TokenError(t('station.tokenMissing'), 401);
  try {
    return await fn(token);
  } catch (err) {
    if (!(err instanceof TokenError)) throw err;
    token = await askToken({ reason: t('station.tokenInvalid', { msg: err.message }) });
    if (!token) throw err;
    return fn(token);
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
export async function nextTracks(id, { limit, token, signal } = {}) {
  const query = limit ? `?limit=${limit}` : '';
  const data = await call(`/station/next-tracks/${encodeURIComponent(id)}${query}`, { method: 'POST', token, signal });
  return (data.data || []).filter((r) => r && r.attributes);
}

/** 个人电台（官网 /station/me：stations?filter[identity]=personal）；没有时为 null */
export async function personalStation(cc, { l, token, signal } = {}) {
  const query = new URLSearchParams({ 'filter[identity]': 'personal', extend: 'editorialArtwork', 'art[url]': 'c,f' });
  if (l) query.set('l', l);
  const data = await call(`/station/catalog/${encodeURIComponent(cc)}/stations?${query}`, { token, signal });
  return (data.data || []).find((r) => r && r.attributes) || null;
}

/** 最近播放的电台（官网 recently-played-radio-shelf 的请求） */
export async function recentStations({ l, limit = 30, token, signal } = {}) {
  const query = new URLSearchParams({ limit: String(limit), 'include[stations]': 'radio-show', 'omit[resource]': 'autos', 'art[url]': 'c,f' });
  if (l) query.set('l', l);
  const data = await call(`/station/recent?${query}`, { token, signal });
  return (data.data || []).filter((r) => r && r.type === 'stations' && r.attributes);
}

/** 直播电台与广播单集的播放资源：{ url, keyServerUrl, widevineKeyCertificateUrl, … }（/v1/play/assets，参数为 playParams 加 keyFormat=web） */
export async function playAssets(playParams, { token, signal } = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(playParams || {})) if (value !== undefined && value !== null) query.set(key, String(value));
  query.set('keyFormat', 'web');
  const data = await call(`/station/assets?${query}`, { token, signal });
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

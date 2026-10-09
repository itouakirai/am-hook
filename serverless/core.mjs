// am-hook 的 serverless 后端（Vercel Edge Function 与 Cloudflare Worker 共用），对应二进制里的 src/amp.rs 与 src/ui.rs。
// 只用 Web 标准接口（fetch / Request / Response），平台差异由入口处理：api/handler.mjs（Vercel）、serverless/cloudflare.mjs。
//
// 与二进制的区别：
// - 没有常驻进程：amp-api 的响应缓存交给平台 CDN（响应带 `s-maxage`），不做连接保活与后台预热；
//   developer token 缓存在实例内存里，平台提供 `tokenStore` 时跨实例共享。
// - wrapper-lite 转发是可选的：设置了环境变量 AM_HOOK_WRAPPER_URL 才启用（可另设 AM_HOOK_WRAPPER_AUTH），
//   否则页面默认由浏览器直连用户自己的 wrapper-lite（见 src/ui/wrapper.js）。实例之间不共享状态，不限速、不限并发。

const WEB_ORIGIN = 'https://music.apple.com';
const API_ORIGIN = 'https://amp-api-edge.music.apple.com';
/** 网页版每次发布都会换 token，至少按此周期重新抓取；JWT 带 `exp` 时在过期前提前刷新（秒） */
const TOKEN_TTL = 12 * 3600;
const TOKEN_EXPIRY_MARGIN = 3600;
const MAX_QUERY_LEN = 4096;
const UPSTREAM_TIMEOUT = 15000;
const WRAPPER_TIMEOUT = 30000;
/** 目录与搜索结果的缓存时间（秒）；地区表几乎不变 */
const CATALOG_TTL = 300;
const STOREFRONTS_TTL = 24 * 3600;
/** 固定 key 的模板已内嵌在 wasm 中，不经过 /key（同 am_mp4::FIXED_KEY_URI） */
const FIXED_KEY_URI = 'skd://itunes.apple.com/P000000000/s1/e1';

const SCRIPT_RE = /src="(\/assets\/index[~-][0-9A-Za-z_-]+\.js)"/;
const JWT_RE = /eyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/;
const SONG_LINK_RE = /^https:\/\/music\.apple\.com\/[a-z]{2}\/song\/[^/?#]+\/([0-9]+)(?:[/?#]|$)/;

/* ---------- 页面路径（同 src/links.rs） ---------- */

const CHART_KINDS = 'songs|playlists|albums|music-videos|city-charts|daily-global-top-charts';
// 官网地址拼在 `/` 之后（`/https://music.apple.com/...`）；有的平台会把连续的 `/` 合并成一个，两种都接受
const SITE_PAGE_RE = new RegExp(
  '^https:/{1,2}music\\.apple\\.com/[a-z]{2}/(?:'
    + 'song/[^/]+/[0-9]+|music-video/[^/]+/[0-9]+|(?:post|album|artist|curator)/(?:[^/]+/)?[0-9]+'
    + '|playlist/(?:[^/]+/)?pl\\.[0-9A-Za-z_-]+|(?:room|multi-room|grouping)/[0-9]+)(?:/|$)'
    + `|^https:/{1,2}music\\.apple\\.com/[a-z]{2}/new(?:/top-charts(?:/(?:${CHART_KINDS}))?)?/?$`,
);
const LOCAL_PAGE_RE = new RegExp(
  `^(?:new(?:/top-charts(?:/(?:${CHART_KINDS}))?)?`
    + '|library(?:/(?:recently-added|albums|songs|music-videos|all-playlists|favorite-songs|artists(?:/[^/]+)?'
    + '|playlist/p\\.[0-9A-Za-z_-]+|playlist-folder/f\\.[0-9A-Za-z_-]+))?)/?$',
);

/** 是否为单页应用的页面地址（首页、新发现、排行榜、资料库与拼接了官网地址的各类页面），这些地址都返回同一个外壳 */
export function isPagePath(pathname) {
  const path = pathname.replace(/^\//, '');
  return path === '' || LOCAL_PAGE_RE.test(path) || SITE_PAGE_RE.test(path);
}

/* ---------- 响应 ---------- */

function json(status, value, headers) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

const NO_STORE = { 'cache-control': 'no-store' };
const fail = (status, msg) => json(status, { code: 1, msg }, NO_STORE);

/** 路径片段解码，无效的百分号编码视为不匹配 */
function decode(segment) {
  try { return decodeURIComponent(segment); } catch { return null; }
}

/* ---------- developer token（同 src/amp.rs） ---------- */

// 实例内存中的 token：{ value, refreshAt（毫秒时间戳） }
let cachedToken = null;

/** JWT payload 中的 `exp`（Unix 秒） */
function tokenExpiry(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const exp = JSON.parse(atob(payload)).exp;
    return Number.isSafeInteger(exp) && exp >= 0 ? exp : null;
  } catch {
    return null;
  }
}

/** 距下次刷新的秒数：不超过 TOKEN_TTL，JWT 带 `exp` 时提前 TOKEN_EXPIRY_MARGIN，至少 1 分钟 */
export function refreshDelay(token, nowUnix) {
  const exp = tokenExpiry(token);
  const untilExpiry = exp === null ? TOKEN_TTL : Math.max(0, Math.max(0, exp - nowUnix) - TOKEN_EXPIRY_MARGIN);
  return Math.max(60, Math.min(TOKEN_TTL, untilExpiry));
}

export function extractScriptPath(html) {
  return SCRIPT_RE.exec(html)?.[1] ?? null;
}

/** 脚本里第一个 JWT 即网页版 MusicKit 使用的 developer token */
export function extractToken(js) {
  return JWT_RE.exec(js)?.[0] ?? null;
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`request to ${url} failed: HTTP ${res.status}`);
  return res.text();
}

/** 从 music.apple.com 页面找到主脚本 `index~<hash>.js`，取出其中内嵌的 JWT */
async function scrapeDeveloperToken() {
  const script = extractScriptPath(await fetchText(`${WEB_ORIGIN}/us/browse`));
  if (!script) throw new Error('main script not found on music.apple.com');
  const token = extractToken(await fetchText(`${WEB_ORIGIN}${script}`));
  if (!token) throw new Error('developer token not found in music.apple.com script');
  return token;
}

function remember(value) {
  const delay = refreshDelay(value, Math.floor(Date.now() / 1000));
  cachedToken = { value, refreshAt: Date.now() + delay * 1000 };
  return delay;
}

/** `rejected` 为刚被 amp-api 拒绝的 token：不再使用它（包括共享存储里的同一个值），重新抓取 */
async function developerToken(platform, rejected) {
  if (cachedToken && cachedToken.value !== rejected && Date.now() < cachedToken.refreshAt) return cachedToken.value;
  const store = platform?.tokenStore;
  if (store) {
    const shared = await store.get().catch(() => null);
    if (shared && shared !== rejected && JWT_RE.test(shared)) {
      remember(shared);
      return shared;
    }
  }
  let value;
  try {
    value = await scrapeDeveloperToken();
  } catch (error) {
    // 到了刷新时间但抓取失败：旧 token 可能仍然有效，继续使用
    if (cachedToken && cachedToken.value !== rejected) return cachedToken.value;
    throw error;
  }
  const delay = remember(value);
  if (store) await store.put(value, delay).catch(() => {});
  return value;
}

/** 测试用：清空实例内存中的 token */
export function resetTokenCache() {
  cachedToken = null;
}

/* ---------- amp-api 代理 ---------- */

/** 目录路径只允许 amp-api 资源路径中出现的字符，拒绝 `..` */
export function validCatalogPath(path) {
  return path.length > 0 && path.length <= 512 && !path.includes('..') && /^[0-9A-Za-z\-_.,:/]+$/.test(path);
}

/** 带 developer token 请求 amp-api；token 失效（401/403）时重新获取一次。原样返回状态码与 JSON */
async function amp(url, ttl, platform) {
  let rejected;
  let upstream;
  let elapsed;
  try {
    for (;;) {
      const token = await developerToken(platform, rejected).catch((error) => {
        throw new Error(`developer token unavailable: ${error.message}`);
      });
      const started = Date.now();
      upstream = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          origin: WEB_ORIGIN,
          referer: `${WEB_ORIGIN}/`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      });
      elapsed = Date.now() - started;
      if ((upstream.status === 401 || upstream.status === 403) && rejected === undefined) {
        await upstream.arrayBuffer().catch(() => {});
        rejected = token;
        continue;
      }
      break;
    }
    const body = await upstream.arrayBuffer();
    const ok = upstream.status >= 200 && upstream.status < 300;
    const bodyless = [204, 205, 304].includes(upstream.status);
    return new Response(bodyless ? null : body, {
      status: upstream.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // 目录数据与访问者无关（只带 developer token），可由 CDN 缓存
        'cache-control': ok ? `public, max-age=${ttl}, s-maxage=${ttl}` : 'no-store',
        'server-timing': `upstream;dur=${elapsed}`,
      },
    });
  } catch (error) {
    return fail(502, error.message.startsWith('developer token') ? error.message : `amp-api request failed: ${error.message}`);
  }
}

function ampRoute(path, search, platform) {
  const query = search.replace(/^\?/, '');
  if (query.length > MAX_QUERY_LEN) return fail(400, 'Query too long');
  const suffix = query ? `?${query}` : '';
  if (path === '/amp/v1/storefronts') return amp(`${API_ORIGIN}/v1/storefronts${suffix}`, STOREFRONTS_TTL, platform);
  const match = /^\/amp\/v1\/(catalog|editorial)\/(.+)$/.exec(path);
  if (!match) return null;
  const rest = decode(match[2]);
  if (rest === null || !validCatalogPath(rest)) return fail(400, `Invalid ${match[1]} path`);
  return amp(`${API_ORIGIN}/v1/${match[1]}/${rest}${suffix}`, CATALOG_TTL, platform);
}

/* ---------- MV master ---------- */

/** HTTPS、无端口、无用户名，且主机为 apple.com 或其子域名 */
export function isAppleHttps(url) {
  return url.protocol === 'https:' && url.port === '' && url.username === ''
    && (url.hostname === 'apple.com' || url.hostname.endsWith('.apple.com'));
}

/**
 * 以 `User-Agent: AM` 获取 MV master（浏览器无法改 User-Agent，否则可能返回没有 4K 的 master）。
 * `appleOnly`：地址来自页面时，重定向只允许留在 apple.com 的 HTTPS 地址，最多 10 跳
 */
async function fetchMvMaster(masterUrl, appleOnly) {
  const failed = () => fail(502, 'Failed to fetch MV master playlist');
  let url = masterUrl;
  let res;
  try {
    for (let hops = 0; ; hops++) {
      res = await fetch(url, {
        headers: { 'user-agent': 'AM' },
        redirect: appleOnly ? 'manual' : 'follow',
        signal: AbortSignal.timeout(30000),
      });
      if (!appleOnly || res.status < 300 || res.status >= 400) break;
      const location = res.headers.get('location');
      await res.arrayBuffer().catch(() => {});
      if (!location || hops >= 10) return failed();
      const next = new URL(location, url);
      if (!isAppleHttps(next)) return failed();
      url = next.href;
    }
    if (!res.ok) return failed();
    // 轨道的相对地址按重定向后的最终 CDN 地址解析
    const finalUrl = appleOnly ? url : res.url || url;
    return json(200, { code: 0, data: { masterUrl: finalUrl, masterBody: await res.text() } }, NO_STORE);
  } catch {
    return failed();
  }
}

function mvMasterByUrl(raw) {
  let url = null;
  try { url = new URL(raw ?? ''); } catch {}
  if (!url || !isAppleHttps(url) || !url.pathname.endsWith('.m3u8')) return fail(400, 'Invalid MV master URL');
  return fetchMvMaster(url.href, true);
}

/* ---------- wrapper-lite 转发（可选） ---------- */

/** 同 src/wrapper.rs 的 normalize_authorization：空值不发送；只有 token 时补上 `Bearer `，已带认证方案时原样使用 */
function normalizeAuthorization(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  return /\s/.test(value) ? value : `Bearer ${value}`;
}

/** 环境变量里的 wrapper-lite：没有设置地址时为 null。地址中的用户信息改为 Basic 认证（fetch 不接受带用户信息的地址） */
export function wrapperConfig(env) {
  const raw = String(env?.AM_HOOK_WRAPPER_URL ?? '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  let base = raw;
  let basic = '';
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      basic = `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(credentials)))}`;
      url.username = '';
      url.password = '';
      base = url.href.replace(/\/+$/, '');
    }
  } catch {}
  // 单独设置的 Authorization 优先于地址中的用户信息
  return { base, auth: normalizeAuthorization(env.AM_HOOK_WRAPPER_AUTH) || basic };
}

const query = (params) => new URLSearchParams(params).toString();

async function wrapperSend(wrapper, path, { method = 'GET', body, timeout = WRAPPER_TIMEOUT } = {}) {
  const headers = {};
  if (wrapper.auth) headers.authorization = wrapper.auth;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(wrapper.base + path, { method, headers, body, signal: AbortSignal.timeout(timeout) });
  return { status: res.status, ok: res.ok, text: await res.text() };
}

function parse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** wrapper-lite 的 `{ code, msg, data }`：请求失败、HTTP 错误或 code 不为 0 时抛出错误 */
async function wrapperData(wrapper, path) {
  let reply;
  try {
    reply = await wrapperSend(wrapper, path, { timeout: 15000 });
  } catch (error) {
    throw new Error(`Request to wrapper-lite failed: ${error.message}`);
  }
  if (!reply.ok) throw new Error(`wrapper-lite returned HTTP ${reply.status}: ${reply.text}`);
  const payload = parse(reply.text);
  if (!payload || typeof payload !== 'object') throw new Error('Failed to parse wrapper-lite JSON');
  return { reply, payload };
}

async function status(wrapper) {
  try {
    const value = parse((await wrapperSend(wrapper, '/status')).text);
    if (value?.code === 0) {
      return json(200, {
        code: 0,
        msg: typeof value.msg === 'string' ? value.msg : 'SUCCESS',
        regions: value.data?.regions ?? [],
      });
    }
  } catch {}
  return json(502, { code: 1, msg: 'wrapper-lite unavailable', regions: [] });
}

/** 歌曲 master m3u8 的地址（wrapper-lite `/m3u8`）。master 由浏览器从 Apple CDN 获取并解析 */
async function songMaster(wrapper, adamId) {
  if (!/^[0-9]+$/.test(adamId) && !SONG_LINK_RE.test(adamId.trim())) return fail(400, 'Invalid song URL or adamId');
  let payload;
  try {
    payload = parse((await wrapperSend(wrapper, `/m3u8?${query({ adamId })}`)).text);
  } catch {
    return fail(500, 'failed to fetch master m3u8 from wrapper-lite');
  }
  if (!payload) return fail(500, 'invalid response from wrapper-lite');
  if (payload.code !== 0) return fail(500, typeof payload.msg === 'string' ? payload.msg : 'wrapper-lite returned an error');
  const masterUrl = payload.data?.m3u8;
  if (typeof masterUrl !== 'string' || !masterUrl) return fail(500, 'wrapper-lite returned no master m3u8 URL');
  return json(200, { code: 0, data: { masterUrl } });
}

const validMvId = (id) => /^[0-9]{1,20}$/.test(id);

/** 原样返回 wrapper-lite 的状态码与 JSON */
async function forward(wrapper, path, options) {
  try {
    const reply = await wrapperSend(wrapper, path, options);
    return new Response(reply.text, { status: reply.status, headers: { 'content-type': 'application/json', ...NO_STORE } });
  } catch {
    return fail(502, 'wrapper-lite request failed');
  }
}

async function mvMasterById(wrapper, id) {
  if (!validMvId(id)) return fail(400, 'Invalid adamId');
  const response = await forward(wrapper, `/webplayback?${query({ adamId: id })}`);
  if (!response.ok) return response;
  const payload = parse(await response.text());
  if (!payload) return fail(502, 'Invalid wrapper-lite response');
  if (payload.code !== 0) return json(502, payload, NO_STORE);
  const masterUrl = payload.data?.m3u8;
  if (typeof masterUrl !== 'string' || !masterUrl) return fail(502, 'Missing MV master URL');
  return fetchMvMaster(masterUrl, false);
}

async function mvLicense(wrapper, request) {
  const body = parse(await request.text().catch(() => ''));
  const text = (value) => (typeof value === 'string' ? value : '');
  const adamId = text(body?.adamId);
  const challenge = text(body?.challenge);
  const uri = text(body?.uri);
  if (!validMvId(adamId) || body?.['drm-type'] !== 'pr' || !challenge || challenge.length > 256 * 1024
    || !uri.startsWith('data:') || uri.length > 64 * 1024) {
    return fail(400, 'Invalid PlayReady license request');
  }
  return forward(wrapper, '/license', {
    method: 'POST',
    body: JSON.stringify({ adamId, challenge, uri, 'drm-type': 'pr' }),
  });
}

/** 歌曲的 TTML 歌词：向 wrapper-lite `/lyrics` 获取后原样返回 XML。没有歌词时返回 404 */
async function lyrics(wrapper, adamId, language) {
  if (!/^[0-9]+$/.test(adamId)) return fail(400, 'Invalid adamId');
  if (language && (language.length > 35 || !/^[0-9A-Za-z-]+$/.test(language))) return fail(400, 'Invalid language');
  const notFound = () => json(404, { code: 1, msg: 'lyrics not found' });
  let reply;
  try {
    reply = await wrapperSend(wrapper, `/lyrics?${query(language ? { adamId, language } : { adamId })}`, { timeout: 15000 });
  } catch (error) {
    return fail(502, `Request to wrapper-lite failed: ${error.message}`);
  }
  if (reply.status === 404) return notFound();
  if (!reply.ok) return fail(502, `wrapper-lite returned HTTP ${reply.status}: ${reply.text}`);
  const payload = parse(reply.text);
  if (!payload) return fail(502, 'Failed to parse wrapper-lite JSON');
  // wrapper-lite 以 HTTP 200 + code 404 表示该歌曲没有歌词
  if (payload.code === 404) return notFound();
  if (payload.code !== 0) return fail(502, `wrapper-lite returned error code ${payload.code}: ${payload.msg ?? 'unknown error'}`);
  const ttml = payload.data?.lyrics;
  if (typeof ttml !== 'string' || !ttml.trim()) return notFound();
  return new Response(ttml, {
    headers: { 'content-type': 'application/ttml+xml; charset=utf-8', 'cache-control': 'private, max-age=3600' },
  });
}

/** 浏览器端解密所需的轨道模板：转发 wrapper-lite `/key` 返回的 `data` */
async function key(wrapper, adamId, uri) {
  if (!/^[0-9]+$/.test(adamId)) return fail(400, 'Invalid adamId');
  if (!uri.startsWith('skd://') || uri === FIXED_KEY_URI) return fail(400, 'Invalid key uri');
  try {
    const { payload } = await wrapperData(wrapper, `/key?${query({ adamId, uri })}`);
    if (payload.code !== 0) throw new Error(`wrapper-lite returned error code ${payload.code}: ${payload.msg ?? 'unknown error'}`);
    if (payload.data === undefined || payload.data === null) throw new Error("wrapper-lite response missing 'data' field");
    return json(200, payload.data, { 'cache-control': 'private, max-age=3600' });
  } catch (error) {
    return fail(502, error.message);
  }
}

/** 需要服务端 wrapper-lite 的接口；`wrapper` 为 null（未配置）时统一返回 501 */
function wrapperRoute(method, path, url, request, wrapper) {
  const get = method === 'GET';
  let match;
  let handler = null;
  if (get && path === '/status') handler = () => status(wrapper);
  else if (get && path === '/key') handler = () => key(wrapper, url.searchParams.get('adamId') ?? '', url.searchParams.get('uri') ?? '');
  else if (method === 'POST' && path === '/mv/license') handler = () => mvLicense(wrapper, request);
  else if (get && (match = /^\/(parse\/song|parse\/mv|mv\/webplayback|lyrics)\/([^/]+)$/.exec(path))) {
    const id = decode(match[2]);
    if (id === null) return fail(400, 'Invalid adamId');
    if (match[1] === 'parse/song') handler = () => songMaster(wrapper, id);
    else if (match[1] === 'parse/mv') handler = () => mvMasterById(wrapper, id);
    else if (match[1] === 'lyrics') handler = () => lyrics(wrapper, id, url.searchParams.get('language') ?? '');
    else handler = () => (validMvId(id) ? forward(wrapper, `/webplayback?${query({ adamId: id })}`) : fail(400, 'Invalid adamId'));
  }
  if (!handler) return null;
  if (!wrapper) {
    const msg = 'Server-side wrapper-lite is not configured; use a local wrapper-lite (Settings > wrapper-lite)';
    return path === '/status' ? json(501, { code: 1, msg, regions: [] }, NO_STORE) : fail(501, msg);
  }
  return handler();
}

/* ---------- 入口 ---------- */

/**
 * 处理后端接口请求；不是后端接口时返回 null，由平台入口决定（页面外壳或 404）。
 *
 * `env`：环境变量（AM_HOOK_WRAPPER_URL、AM_HOOK_WRAPPER_AUTH）。
 * `platform.tokenStore`（可选）：跨实例共享 developer token，`{ get(): Promise<string|null>, put(token, ttlSeconds) }`。
 */
export async function handle(request, env = {}, platform = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  const wrapper = wrapperConfig(env);

  if (method === 'GET') {
    // 部署环境，页面在 wrapper.js 之前加载（二进制里是静态文件 src/ui/host.js）
    if (path === '/assets/host.js') {
      return new Response(`window.AM_HOOK_HOST = ${JSON.stringify({ serverWrapper: wrapper !== null })};\n`, {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' },
      });
    }
    if (path.startsWith('/amp/')) {
      const response = ampRoute(path, url.search, platform);
      if (response) return response;
    }
    if (path === '/parse/mv-master') return mvMasterByUrl(url.searchParams.get('url'));
  }
  return wrapperRoute(method, path, url, request, wrapper);
}

export function notFound() {
  return new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

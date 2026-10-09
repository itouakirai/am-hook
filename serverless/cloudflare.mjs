// Cloudflare Worker 入口（见 wrangler.toml）。静态资源（dist/，由 scripts/build-static.mjs 生成）由平台直接提供，
// 其余请求到这里：后端接口交给 core.mjs，页面地址返回单页应用外壳，其他一律 404。
import { handle, isPagePath, notFound } from './core.mjs';

/** developer token 存在 Cache API 里，同一数据中心的实例共用，新实例不必重新抓取 */
function tokenStore(request) {
  const key = new URL('/__am-hook/developer-token', request.url).href;
  return {
    async get() {
      const hit = await caches.default.match(key);
      return hit ? hit.text() : null;
    },
    put(token, ttl) {
      return caches.default.put(key, new Response(token, { headers: { 'cache-control': `max-age=${ttl}` } }));
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // amp-api 的成功响应按地址缓存（Worker 的响应不会自动进 CDN 缓存），缓存时间取自响应的 Cache-Control
    const cacheable = request.method === 'GET' && url.pathname.startsWith('/amp/');
    if (cacheable) {
      const hit = await caches.default.match(request.url);
      if (hit) return hit;
    }

    const response = await handle(request, env, { tokenStore: tokenStore(request) });
    if (response) {
      if (cacheable && response.ok) ctx.waitUntil(caches.default.put(request.url, response.clone()));
      return response;
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && isPagePath(url.pathname)) {
      // 外壳是 dist/index.html，按 `/` 请求（请求 /index.html 会被重定向到 `/`）
      return env.ASSETS.fetch(new Request(new URL('/', request.url), { method: request.method, headers: request.headers }));
    }
    return notFound();
  },
};

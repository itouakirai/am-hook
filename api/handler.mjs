// Vercel Edge Function 入口：vercel.json 把后端接口的地址都改写到这里，逻辑在 serverless/core.mjs。
// 静态资源与页面外壳（dist/，由 scripts/build-static.mjs 生成）由 Vercel 直接提供；amp-api 的响应带 `s-maxage`，由 Vercel CDN 缓存。
import { handle, notFound } from '../serverless/core.mjs';

export const config = { runtime: 'edge' };

/**
 * 改写后函数看到的应是原始地址；万一平台给的是改写后的 `/api/handler`，
 * 则用 vercel.json 附在查询参数里的 `__path` 还原
 */
function original(request) {
  const url = new URL(request.url);
  const path = url.searchParams.get('__path');
  const search = url.search.replace(/^\?/, '').split('&').filter((part) => part && !part.startsWith('__path=')).join('&');
  url.search = search ? `?${search}` : '';
  if (url.pathname !== '/api/handler' || !path) {
    return url.href === request.url ? request : new Request(url, request);
  }
  url.pathname = path;
  return new Request(url, request);
}

export default async function handler(request) {
  return (await handle(original(request), process.env)) ?? notFound();
}

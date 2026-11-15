// amp-api（经服务端 /amp 代理，见 src/amp.rs 与 serverless/core.mjs）的公共请求与封面地址工具，各页面视图与下载共用

/**
 * GET /amp<path>?<params>，返回 JSON。
 * - 值为 undefined 或空字符串的参数不传（如地区不支持当前语言时的 l）；
 * - amp-api 偶尔返回 5xx（如 charts 的「Service failure」），稍等后重试一次；
 * - 地区不支持所选语言时返回 400，去掉 l 改用地区默认语言再请求一次。
 * path 可以是接口返回的 next 分页地址（自带查询参数），params 会补在其后。
 */
export async function amp(path, params, { signal } = {}) {
  const url = new URL('/amp' + path, location.origin);
  for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== '') url.searchParams.set(key, value);
  let res = await fetch(url, { signal });
  if (res.status >= 500) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    signal?.throwIfAborted();
    res = await fetch(url, { signal });
  }
  if (res.status === 400 && url.searchParams.has('l')) {
    url.searchParams.delete('l');
    res = await fetch(url, { signal });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error((data && ((data.errors && data.errors[0] && data.errors[0].detail) || data.msg)) || `HTTP ${res.status}`);
  return data;
}

/**
 * amp-api 的 artwork.url 是 {w}x{h}{c}.{f} 模板（请求带 art[url]=c,f 时保留 {c} / {f}）。
 * crop 为官网使用的裁切码（bb 原比例、sr 指定矩形、cc 居中方形、ea / vf 通栏图等）；
 * 部分歌单封面的裁切码已写在地址里（如 SC.DN01），这时没有 {c}。
 */
export function artUrl(artwork, w, h = w, crop = 'bb', format = 'jpg') {
  return artwork && artwork.url ? artwork.url.replace('{w}', w).replace('{h}', h).replace('{c}', crop).replace('{f}', format) : '';
}

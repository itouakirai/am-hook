// amp-api（经服务端 /amp 代理，见 src/amp.rs 与 serverless/core.mjs）的公共请求与封面地址工具，各页面视图与下载共用

const STOREFRONTS = ['cn', 'us', 'kr', 'jp', 'tw'];

export function chooseStorefront(valid, regions = []) {
  const online = regions.map((cc) => String(cc).toLowerCase());
  return STOREFRONTS.find((cc) => valid.includes(cc) && online.includes(cc))
    || STOREFRONTS.find((cc) => valid.includes(cc)) || null;
}

export function regionlessResource(path) {
  const m = path.match(/^\/https:\/{1,2}music\.apple\.com\/(song|album|playlist|artist|music-video|post|station)\/(?:[^/?#]+\/)?([^/?#]+)\/?$/);
  if (!m) return null;
  const types = { song: 'songs', album: 'albums', playlist: 'playlists', artist: 'artists', 'music-video': 'music-videos', post: 'uploaded-videos', station: 'stations' };
  const valid = m[1] === 'playlist' ? /^pl\.[\w-]+$/ : m[1] === 'station' ? /^ra\.[\w.-]+$/ : /^\d+$/;
  return valid.test(m[2]) ? { type: types[m[1]], id: m[2] } : null;
}

export async function guessStorefront(resource) {
  const [valid, regions] = await Promise.all([
    Promise.all(STOREFRONTS.map(async (cc) => {
      try {
        const data = await amp(`/v1/catalog/${cc}/${resource.type}/${resource.id}`);
        return data.data?.some((item) => item.id === resource.id) ? cc : null;
      } catch { return null; }
    })),
    Promise.resolve().then(() => window.AmWrapper.status()).then((data) => data.regions || []).catch(() => []),
  ]);
  return chooseStorefront(valid, regions);
}

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

const ART =/^(https:\/\/[a-z0-9-]+\.mzstatic\.com\/image\/thumb\/.+\/)(\d+)x(\d+)([^/]*?)\.(jpe?g|png|webp|avif|heic)([?#].*)?$/i;

/**
 * 反过来：页面上的 mzstatic 图片地址 → artwork.url 模板（{w}x{h}bb.{f}），不是 Apple 封面时返回 ''（封面菜单 views/artwork-menu.mjs 用）。
 * 两个字母的裁切码（bb、cc、sr、ea 等，可带 -NN 质量后缀）一律换成 bb，取完整的原图；
 * 地址里的特殊裁切（如歌单封面的 SC.DN01）与查询参数（封面文字的语言）保留
 */
export function artworkTemplate(src) {
  const m = ART.exec(src || '');
  if (!m) return '';
  const crop = /^([a-z]{2})?(-\d+)?$/i.test(m[4]) ? 'bb' : m[4];
  return `${m[1]}{w}x{h}${crop}.{f}${m[6] || ''}`;
}

/**
 * amp-api 的 artwork.url 是 {w}x{h}{c}.{f} 模板（请求带 art[url]=c,f 时保留 {c} / {f}）。
 * crop 为官网使用的裁切码（bb 原比例、sr 指定矩形、cc 居中方形、ea / vf 通栏图等）；
 * 部分歌单封面的裁切码已写在地址里（如 SC.DN01），这时没有 {c}。
 */
export function artUrl(artwork, w, h = w, crop = 'bb', format = 'jpg') {
  return artwork && artwork.url ? artwork.url.replace('{w}', w).replace('{h}', h).replace('{c}', crop).replace('{f}', format) : '';
}

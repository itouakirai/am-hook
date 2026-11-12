// 专辑页与歌单页共用的头部（官网 container-detail-header）：主题色、封面光晕、手机竖屏的 3:4 封面与动态封面

/* ---------- 主题色（官网 Xet）：整页铺 --joe-color，按配色方案与亮度选浅色 / 深色布局 ---------- */
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => {
  const v = Math.max(0, Math.min(1, c));
  return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
};
const hexToRgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbToHex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;

/** 官网 mN：相对亮度（D50 系数，阈值 0.03928），保留 3 位小数 */
function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return +(0.2224951982 * r + 0.7168950438 * g + 0.0606097579 * b).toFixed(3);
}

function toOklch(rgb) {
  const [r, g, b] = rgb.map((c) => toLinear(c / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), h: Math.atan2(B, A) };
}

function fromOklch({ L, C, h }) {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toGamma);
}

/**
 * hex：头部所用图片（动态封面首帧 / 封面）的 bgColor；light：系统是否为浅色方案。
 * 浅色方案：亮度 > 0.43 用浅色布局（黑字）；OKLCH 彩度 > 0.13 时压低亮度与彩度，亮度不低于 0.18，
 *   深色布局下结果亮度 > 0.15 时再各通道减去亮度 × 0.25 × 255（官网 Wet）；
 * 深色方案：一律深色布局，OKLCH 亮度不高于 0.3、彩度不高于 0.125（官网 Ket）。
 * 返回 { joe, light }，颜色无效时返回 null。
 */
export function detailTheme(hex, light) {
  if (!/^[0-9a-f]{6}$/i.test(hex || '')) return null;
  const rgb = hexToRgb(hex);
  const lightLayout = light && luminance(rgb) > 0.43;
  const c = toOklch(rgb);
  if (!light) return { joe: rgbToHex(fromOklch({ ...c, L: Math.min(c.L, 0.3), C: Math.min(c.C, 0.125) })), light: false };
  if (c.C > 0.13) { c.L /= 1 + 0.11 * c.L; c.C /= 1 + 0.9 * c.C; }
  c.L = Math.max(c.L, 0.18);
  let out = fromOklch(c);
  const y = luminance(out);
  if (!lightLayout && y > 0.15) out = out.map((v) => Math.max(0, Math.round(v - y * 0.25 * 255)));
  return { joe: rgbToHex(out), light: lightLayout };
}

/* ---------- 头部渲染 ---------- */
/**
 * $：按 id 取页面元素；artUrl(artwork, w, h)：图片地址；rerender()：断点或配色方案变化时重新渲染头部。
 * 返回 render({ cover, attrs, alt })：cover 为方形封面 artwork，attrs 为专辑 / 歌单 attributes（editorialArtwork / editorialVideo）
 */
export function createDetailHeader({ $, signal, artUrl, rerender }) {
  // 与官网一致，xsmall（< 484px）且有竖版封面时用全宽 3:4 封面（motionDetailTall），否则方形封面（motionDetailSquare）
  const xsmall = matchMedia('(max-width: 483px)');
  const lightScheme = matchMedia('(prefers-color-scheme: light)');
  xsmall.addEventListener('change', rerender, { signal });
  lightScheme.addEventListener('change', rerender, { signal });

  let motion = null;
  let motionKey = '';
  // 离开页面时停止动态封面（尚在加载的不再挂载）
  signal.addEventListener('abort', () => { motionKey = ''; if (motion) motion.destroy(); motion = null; });

  function setImg(container, src, alt = '') {
    if (!src) return;
    const img = container.querySelector('img') || container.appendChild(Object.assign(document.createElement('img'), { alt: '', decoding: 'async' }));
    if (img.getAttribute('src') !== src) img.src = src;
    img.alt = alt;
  }

  return function render({ cover, attrs, alt }) {
    const video = attrs.editorialVideo || {};
    const art = attrs.editorialArtwork || {};
    const tallStatic = art.staticDetailTall || (video.motionDetailTall && video.motionDetailTall.previewFrame);
    const tall = xsmall.matches && !!tallStatic;
    document.body.classList.toggle('tall-art', tall);

    const src = artUrl(cover, 632);
    setImg($('art'), src, alt);
    setImg($('radiosity'), artUrl(cover, 160));
    if (tall) setImg($('tall-art'), artUrl(tallStatic, 1080, 1440));

    const source = tall ? video.motionDetailTall : video.motionDetailSquare;
    // 主题色：动态封面首帧的 bgColor，没有时取所用封面的 bgColor
    const theme = detailTheme((source && source.previewFrame && source.previewFrame.bgColor) || ((tall ? tallStatic : cover) || {}).bgColor,
      lightScheme.matches);
    document.body.classList.toggle('detail-themed', !!theme);
    document.body.classList.toggle('joe-light', !!theme && theme.light);
    if (theme) document.body.style.setProperty('--joe', theme.joe);
    else document.body.style.removeProperty('--joe');

    const key = source && source.video ? `${tall ? 'tall' : 'square'}:${source.video}` : '';
    if (key === motionKey) return;
    motionKey = key;
    if (motion) { motion.destroy(); motion = null; }
    if (!key) return;
    import('/assets/motion-art.mjs')
      .then(({ mountMotionArt }) => { if (motionKey === key) motion = mountMotionArt(tall ? $('tall-art') : $('art'), { src: source.video }); })
      .catch((err) => console.warn('[am-hook] 动态封面加载失败', err));
  };
}

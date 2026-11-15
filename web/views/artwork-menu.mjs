// 封面的右键 / 长按菜单：在任何页面的封面（mzstatic 图片）或动态封面上按右键，或在触屏上长按，弹出「保存封面」
// （选尺寸与格式）与「保存动态封面」（列出各编码与分辨率，附码率与估算大小）。下载交给下载管理器（downloads.addFile），
// 进度显示在下载中心，保存方式与设置相同（文件夹模式写入所选文件夹的根目录）。
//
// 封面地址由图片地址反推：…/{w}x{h}{裁切}.{格式} → 模板（见 artworkTemplate）。动态封面来自 <video data-motion-src>
// （motion-art.mjs）以及容器上的 data-motion（JSON：[{ kind, src }]，专辑 / 歌单页头部同时列出方形与竖版，艺人页为各尺寸）；
// 文件名取最近的 data-artwork-name，没有时取图片的 alt 或所在链接的文字。
// 按住 Shift 右键保留浏览器自己的菜单。触屏长按：Android Chrome 会发出 contextmenu；iOS Safari 不会，这里自己计时，
// 并用 CSS（-webkit-touch-callout: none）关掉系统的图片菜单。

import { openMenu, copyText, ICON } from './actions.mjs';
import { downloads, coverUrl } from '../download/downloads.mjs';
import { imageType } from '../download/mp4-tags.mjs';
import { loadMotion, motionChoices, motionQuality, motionEstimate, downloadMotion, codecFamily, MOTION_FILES } from '../download/motion.mjs';
import { formatSize } from '../download/center.mjs';
import { artworkTemplate } from '../amp.mjs';

const { AmI18n } = window;
const { t } = AmI18n;

const IMAGE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/></svg>';
const MOTION_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 9 5 3-5 3z" fill="currentColor"/></svg>';

/* ---------- 命中测试：指针下的封面图片或动态封面 ---------- */
const STOP = 'button, input, select, textarea, [contenteditable=""], [contenteditable="true"], .menu, dialog';

function isArtImage(node) {
  return node instanceof HTMLImageElement && !!artworkTemplate(node.currentSrc || node.src);
}

/** 返回 { node, statics: [template], motions: [{ kind, src }], name } 或 null */
export function artworkAt(x, y, target) {
  let hit = null;
  const stack = Number.isFinite(x) && (x || y) ? document.elementsFromPoint(x, y) : [target];
  for (const node of stack.slice(0, 12)) {
    if (!(node instanceof Element)) continue;
    if (node.closest(STOP)) return null;
    if (node.matches('video[data-motion-src]') || isArtImage(node)) { hit = node; break; }
    // 盖在封面上的文字（如艺人页头图上的名字）：保留浏览器的菜单（复制文字等）
    if ([...node.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.data.trim())) return null;
  }
  // 键盘的菜单键：焦点在封面链接上
  if (!hit && target instanceof Element && !target.closest(STOP)) {
    const inner = target.querySelector && target.querySelector('img, video[data-motion-src]');
    if (inner && (inner.matches('video[data-motion-src]') || isArtImage(inner))) hit = inner;
  }
  if (!hit) return null;
  const box = hit.closest('[data-motion]') || hit.parentElement || hit;
  const statics = [];
  const img = isArtImage(hit) ? hit : [...box.querySelectorAll('img')].find(isArtImage);
  if (img) statics.push(artworkTemplate(img.currentSrc || img.src));
  let motions = [];
  try { motions = JSON.parse(box.dataset.motion || '[]'); } catch {}
  for (const video of box.querySelectorAll('video[data-motion-src]')) {
    if (!motions.some((m) => m.src === video.dataset.motionSrc)) motions.unshift({ kind: '', src: video.dataset.motionSrc });
  }
  if (!statics.length && !motions.length) return null;
  const named = hit.closest('[data-artwork-name]');
  const link = hit.closest('a');
  const name = (named && named.dataset.artworkName) || (img && img.alt) || (link && (link.getAttribute('aria-label') || link.textContent.trim().split('\n')[0])) || '';
  return { node: hit, statics, motions, name: name.trim().slice(0, 120) };
}

/* ---------- 菜单 ---------- */
/** 文件名里不能用的字符 */
const safe = (s) => (s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'artwork';

/** 静态封面的尺寸选项：原图（原始格式 / JPG / PNG）与常用尺寸 */
const SIZES = [3000, 1500, 600];

function staticItems(template, hit) {
  const save = (format, size) => () => saveStatic(template, format, size, hit);
  return [
    { label: t('art.original'), hint: t('art.originalHint'), onSelect: save('source', 'original') },
    { label: `${t('art.original')} · JPG`, onSelect: save('jpg', 'original') },
    { label: `${t('art.original')} · PNG`, hint: t('art.pngHint'), onSelect: save('png', 'original') },
    '-',
    ...SIZES.map((size) => ({ label: `${size} px · JPG`, onSelect: save('jpg', size) })),
  ];
}

function motionItems(src, kind, hit) {
  return loadMotion(src).then(({ variants, duration }) => {
    const items = [];
    let family = '';
    for (const v of motionChoices(variants)) {
      const f = codecFamily(v.codec);
      if (family && f !== family) items.push('-');
      family = f;
      const size = motionEstimate(v, duration);
      items.push({
        label: motionQuality(v),
        hint: [`${(v.average / 1e6).toFixed(1)} Mbps`, size ? `≈ ${formatSize(size)}` : '', f === 'avc' ? t('art.avcHint') : ''].filter(Boolean).join(' · '),
        onSelect: () => saveMotion(v, kind, hit),
      });
    }
    return items;
  });
}

const where = () => location.pathname + location.search;

function added(job, toast) {
  if (job && toast) toast(t('dlc.added', { name: job.title }));
}

let toastFn = null;

function saveStatic(template, format, size, hit) {
  const url = coverUrl(template, format, size);
  const quality = size === 'original' ? t('art.original') : `${size} px`;
  downloads.addFile({
    title: hit.name || t('art.cover'),
    subtitle: t('art.cover'),
    artwork: template,
    label: `${t('art.cover')} · ${quality}`,
    quality: format === 'source' ? quality : `${quality} · ${format.toUpperCase()}`,
    href: where(),
    run: async (signal, onProgress) => {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('Content-Length')) || 0;
      const reader = res.body.getReader();
      const parts = [];
      let done = 0;
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        parts.push(value);
        done += value.length;
        onProgress(done, total);
      }
      const head = parts[0] || new Uint8Array(0);
      const ext = imageType(head) === 'png' ? 'png' : 'jpg';
      const file = new Blob(parts, { type: ext === 'png' ? 'image/png' : 'image/jpeg' });
      return { file, name: `${safe(hit.name)} - cover${size === 'original' ? '' : ` ${size}`}.${ext}` };
    },
  }).then((job) => added(job, toastFn), (err) => toastFn && toastFn(err.message || String(err)));
}

function saveMotion(v, kind, hit) {
  const quality = motionQuality(v);
  const base = (MOTION_FILES[kind] || MOTION_FILES.square).replace(/\.mp4$/, '');
  downloads.addFile({
    title: hit.name || t('art.motion'),
    subtitle: t(kind ? `dlc.motion.${kind}` : 'art.motion'),
    artwork: hit.statics[0] || '',
    label: t(kind ? `dlc.motion.${kind}` : 'art.motion'),
    quality,
    href: where(),
    run: async (signal, onProgress) => ({
      ...(await downloadMotion(v, { signal, onProgress })),
      name: `${safe(hit.name)} - ${base} ${quality.replace('×', 'x')}.mp4`,
    }),
  }).then((job) => added(job, toastFn), (err) => toastFn && toastFn(err.message || String(err)));
}

function menuItems(hit) {
  const items = [];
  const template = hit.statics[0];
  if (template) {
    items.push({ icon: IMAGE_ICON, label: t('art.saveCover'), hint: t('art.saveCoverHint'), submenu: () => staticItems(template, hit) });
  }
  // 同一片源只列一次；形状未知（只有 <video>）时按顺序标为「动态封面」
  const seen = new Set();
  for (const m of hit.motions) {
    if (!m.src || seen.has(m.src)) continue;
    seen.add(m.src);
    // 预先取 master，打开子菜单时多半已经载入
    loadMotion(m.src).catch(() => {});
    const label = m.kind ? t(`art.saveMotion.${m.kind}`) : t('art.saveMotion');
    items.push({ icon: MOTION_ICON, label, hint: t('art.saveMotionHint'), submenu: () => motionItems(m.src, m.kind, hit) });
  }
  if (template) {
    const original = coverUrl(template, 'source', 'original');
    items.push('-',
      { icon: ICON.apple, label: t('art.openOriginal'), onSelect: () => open(original, '_blank', 'noopener') },
      { icon: ICON.link, label: t('art.copyUrl'), title: original, onSelect: () => copyText(original, () => toastFn && toastFn(t('action.copied'))) });
  }
  return items;
}

/* ---------- 事件：右键、菜单键、触屏长按 ---------- */
const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 10;

/** 吞掉长按松开后的 click（否则会打开封面所在的链接）；下一次按下时撤销 */
function swallowClick() {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); done(); };
  const done = () => {
    removeEventListener('click', stop, true);
    removeEventListener('pointerdown', done, true);
  };
  addEventListener('click', stop, true);
  addEventListener('pointerdown', done, true);
}

/** app.mjs 启动时调用一次；toast(message)：底部提示 */
export function installArtworkMenu({ toast }) {
  toastFn = toast;
  let press = null;
  // 长按打开菜单的时刻；performance.now() 从页面载入算起，初值不能是 0
  let pressedAt = -Infinity;

  const show = (hit, x, y) => {
    const items = menuItems(hit);
    if (!items.length) return false;
    if (!x && !y) {
      const r = hit.node.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    }
    openMenu(hit.node, items, { x, y });
    return true;
  };
  const cancel = () => { if (press) clearTimeout(press.timer); press = null; };

  document.addEventListener('contextmenu', (e) => {
    if (e.shiftKey || e.defaultPrevented) return;
    // 长按已经打开了菜单（iOS 计时先到）：不再弹出系统菜单
    if (performance.now() - pressedAt < 1500) { e.preventDefault(); return; }
    const hit = artworkAt(e.clientX, e.clientY, e.target);
    if (!hit) return;
    cancel();
    if (show(hit, e.clientX, e.clientY)) {
      e.preventDefault();
      // 触屏长按触发的 contextmenu：松开后不要再点开链接（鼠标右键之后没有 click，下一次按下时撤销）
      swallowClick();
    }
  });

  document.addEventListener('pointerdown', (e) => {
    cancel();
    if (e.pointerType !== 'touch' || !e.isPrimary) return;
    const hit = artworkAt(e.clientX, e.clientY, e.target);
    if (!hit) return;
    const { clientX: x, clientY: y } = e;
    press = {
      x, y,
      timer: setTimeout(() => {
        press = null;
        if (show(hit, x, y)) {
          pressedAt = performance.now();
          swallowClick();
          if (navigator.vibrate) navigator.vibrate(10);
        }
      }, LONG_PRESS_MS),
    };
  }, { passive: true });
  document.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancel();
  }, { passive: true });
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, cancel, { passive: true });
  addEventListener('scroll', cancel, { capture: true, passive: true });
}

// 首页「类别浏览」：与 music.apple.com/{cc}/search 相同的 amp-api 调用（官网 SearchLandingPageIntent）与砖块排版。
// 数据为 /v1/recommendations/{cc}?name=search-landing（经服务端 /amp 代理）：若干 MusicNamedBrickShelf 推荐，
// 内容是 apple-curators（风格、心情、活动）、editorial-items（排行榜、音乐视频、专题 multi-room 等）与 activities，
// 官网把它们合成一个网格，标题取第一个推荐的 title。砖块封面为 editorialArtwork.subscriptionHero，
// 按官网 category-brick 的 16:9、裁切码 sr 取图；标题文字（策展人 shortName 等）由页面叠在封面上。
import { amp, artUrl } from '../amp.mjs';
import { resolveLink } from './links.mjs';

const { AmI18n } = window;
const { t } = AmI18n;

/** 与官网 SearchLandingPageIntent 相同的参数 */
const PARAMS = {
  name: 'search-landing',
  platform: 'web',
  'omit[resource]': 'autos',
  extend: 'editorialArtwork',
  'art[url]': 'c,f',
  types: 'activities,apple-curators,editorial-items',
};

/** 同一页面会话里来回切换首页时不重复请求（服务端另有 5 分钟缓存）：地区:语言 → { at, promise } */
const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

/** 推荐里的一项 → 砖块 { id, title, artwork, link }；没有封面或标题的跳过（与官网 s0e 相同） */
function toBrick(res, cc) {
  const a = res && res.attributes;
  const artwork = a && a.editorialArtwork && a.editorialArtwork.subscriptionHero;
  if (!artwork || !artwork.url) return null;
  let title = '';
  let link = null;
  switch (res.type) {
    case 'apple-curators':
      title = a.shortName || a.name || '';
      link = resolveLink(a.url, cc);
      if (!link || !link.local) link = { href: `/https://music.apple.com/${cc}/curator/_/${res.id}`, local: true };
      break;
    case 'editorial-items':
      title = (a.editorialNotes && a.editorialNotes.name) || '';
      link = resolveLink((a.link && a.link.url) || a.url, cc);
      break;
    case 'activities':
      title = a.name || '';
      link = resolveLink(a.url, cc);
      break;
    default:
      return null;
  }
  return title && link ? { id: `${res.type}:${res.id}`, title, artwork, link } : null;
}

/** 取地区 cc 的类别：{ title, bricks }；同一项出现在多个推荐里时只保留第一次 */
export function loadCategories(cc, l) {
  const key = `${cc}:${l || ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = amp(`/v1/recommendations/${cc}`, { ...PARAMS, l }).then((data) => {
    let title = '';
    const seen = new Set();
    const bricks = [];
    for (const rec of data.data || []) {
      const a = rec.attributes || {};
      if (a.display && a.display.kind && a.display.kind !== 'MusicNamedBrickShelf') continue;
      if (!title) title = (a.title && a.title.stringForDisplay) || '';
      const contents = (rec.relationships && rec.relationships.contents && rec.relationships.contents.data) || [];
      for (const res of contents) {
        const brick = toBrick(res, cc);
        if (brick && !seen.has(brick.id)) {
          seen.add(brick.id);
          bricks.push(brick);
        }
      }
    }
    return { title, bricks };
  });
  cache.set(key, { at: Date.now(), promise });
  // 失败或为空时不缓存，下次进入首页重新请求
  promise.then((result) => { if (!result.bricks.length) cache.delete(key); }, () => cache.delete(key));
  return promise;
}

const EXTERNAL_ICON = '<svg class="brick-external" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>';
/** 官网 category-brick 的取图宽度（520 / 340 / 290，16:9），这里再加上 2 倍屏用的 1040 */
const WIDTHS = [340, 520, 1040];

/** 一个砖块：链接 + 封面 + 叠在左下角的标题；封面加载前以 bgColor 打底 */
export function brickNode({ title, artwork, link }) {
  const node = document.createElement('a');
  node.className = 'brick';
  node.href = link.href;
  if (!link.local) {
    node.target = '_blank';
    node.rel = 'noreferrer';
    node.title = t('browse.external');
  }
  if (artwork.bgColor) node.style.setProperty('--brick-bg', `#${artwork.bgColor}`);
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  // 网格列宽见 app.css .brick-grid：手机两列，桌面 3～5 列（sizes 要先于 srcset 设置）
  img.sizes = '(max-width: 483px) 46vw, (max-width: 1000px) 30vw, 22vw';
  img.srcset = WIDTHS.map((w) => `${artUrl(artwork, w, Math.round(w * 9 / 16), 'sr', 'webp')} ${w}w`).join(', ');
  img.src = artUrl(artwork, 520, 293, 'sr', 'webp');
  img.addEventListener('load', () => node.classList.add('loaded'), { once: true });
  const label = document.createElement('span');
  label.className = 'brick-title';
  label.textContent = title;
  node.append(img, label);
  if (!link.local) node.insertAdjacentHTML('beforeend', EXTERNAL_ICON);
  return node;
}

/** 加载中的占位砖块 */
export function brickSkeletons(count = 12) {
  return Array.from({ length: count }, () => {
    const node = document.createElement('span');
    node.className = 'brick skeleton';
    node.setAttribute('aria-hidden', 'true');
    return node;
  });
}

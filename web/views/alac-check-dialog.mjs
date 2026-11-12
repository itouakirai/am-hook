// 「检测 ALAC」对话框：专辑页、歌单页、歌曲页头部的按钮与歌曲「更多」菜单打开，逐首检测最高音质的 ALAC（方法见 ../alac-check.mjs）。
// 打开后不自动开始：勾选要检测的曲目（默认全部）后开始。可同时检测 wrapper-lite 给出的 master m3u8：它与网页版（amp-api
// extendedAssetUrls.enhancedHls）可能是不同的打包，音质也可能更高；两边最高音质 ALAC 的 media m3u8 相同时只检测一次。
// 结果逐行显示，单击一行展开详情（各来源的原样帧列表、打包信息、第一个分段的实际位深与频谱），可复制文字报告。关闭对话框即停止检测。
import { checkSources, compareAlac, createAnalyzer, createLimiter, interpretAnalysis, DEFECTS } from '../alac-check.mjs';

const { AmI18n } = window;
const { t } = AmI18n;

/** 是否同时分析第一个分段（需要多下载约 1.5–10 MB / 首）、是否同时检测 wrapper-lite 的 master，记住上次的选择 */
const ANALYZE_KEY = 'am-hook:alac-check-analyze';
const WRAPPER_KEY = 'am-hook:alac-check-wrapper';
const TRACKS_AT_ONCE = 3;
/** 同时检测 wrapper-lite 时逐首进行：每首都要向 wrapper-lite 请求 master，同时请求太多它吃不消 */
const TRACKS_AT_ONCE_WRAPPER = 1;
const REQUESTS_AT_ONCE = 8;
const ANALYSES_AT_ONCE = 2;
const SOURCES = ['web', 'wrapper'];

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

const art = (artwork, size) => (artwork && artwork.url ? artwork.url.replace('{w}', size).replace('{h}', size).replace('{c}', 'bb').replace('{f}', 'jpg') : '');
const khz = (hz) => `${(hz / 1000).toFixed(1).replace(/\.0$/, '')} kHz`;
const format = (bits, rate) => (bits && rate ? `${bits}-bit / ${khz(rate)}` : '');
const variantFormat = (v) => format(v.bit_depth, v.sample_rate) || v.group_id;
/** 行内的简写：24/96、16/44.1 */
const shortFormat = (v) => (v.bit_depth && v.sample_rate ? `${v.bit_depth}/${String(v.sample_rate / 1000).replace(/\.0+$/, '')}` : v.group_id);

function clock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function dateTime(date, seconds = false) {
  if (!date) return '';
  return new Intl.DateTimeFormat(AmI18n.lang === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: seconds ? 'medium' : 'short' }).format(date);
}

function size(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const fileName = (url) => { try { return new URL(url).pathname.split('/').pop(); } catch { return url; } };
/** 曲目所属专辑的 ID：取自曲目 url（album/<slug>/<id>?i=...） */
const albumIdOf = (track) => ((((track.attributes && track.attributes.url) || '').match(/\/album\/(?:[^/?#]+\/)?(\d+)/) || [])[1] || '');
const enhancedHls = (track) => {
  const assets = track.attributes.extendedAssetUrls;
  return assets ? assets.enhancedHls || null : undefined;
};

/** 分析报告的文字结论：位深、频宽两项，warn 表示值得注意 */
function analysisLines(report) {
  const verdict = interpretAnalysis(report);
  const bits = verdict.bits.effective == null ? { text: t('ac.bitsSilent') }
    : verdict.bits.padded ? { text: t('ac.bitsPadded', { n: verdict.bits.effective, bits: report.bits, zero: report.bits - verdict.bits.effective }), warn: true }
      : { text: t('ac.bitsFull', { n: verdict.bits.effective }) };
  const limit = khz(report.bandLimit);
  const band = {
    full: { text: t('ac.bandFull', { limit }) },
    upsampled: { text: t('ac.bandUpsampled', { limit, source: khz(verdict.source), wall: Math.round(report.wallDb) }), warn: true },
    hires: { text: t('ac.bandHires', { limit }) },
    cutoff: { text: t('ac.bandCutoff', { limit, wall: Math.round(report.wallDb) }), warn: true },
    low: { text: t('ac.bandLow', { limit }) },
    quiet: { text: t('ac.bandQuiet') },
  }[verdict.band];
  return { bits, band, verdict };
}

/**
 * 频谱（0 Hz 到奈奎斯特频率，线性频率轴）：一条线，量化噪声底为水平虚线，频宽上限为竖直虚线；
 * 悬停显示频率与电平。绘图区按容器拉伸，文字用 HTML 定位，不随拉伸变形。
 */
function spectrumChart(report, warn) {
  const values = report.spectrum;
  const nyquist = report.rate / 2;
  const top = Math.ceil((Math.max(-20, ...values) + 5) / 10) * 10;
  const bottom = Math.floor((report.floorDb - 10) / 10) * 10;
  const x = (i) => (i / (values.length - 1)) * 1000;
  const y = (db) => ((top - Math.min(top, Math.max(bottom, db))) / (top - bottom)) * 100;
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(2)}`).join('');
  const svg = svgEl('svg', { viewBox: '0 0 1000 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  svg.append(
    svgEl('path', { class: 'ac-spec-area', d: `${line}L1000,100L0,100Z` }),
    svgEl('line', { class: 'ac-spec-floor', x1: 0, x2: 1000, y1: y(report.floorDb), y2: y(report.floorDb), 'vector-effect': 'non-scaling-stroke' }),
    svgEl('path', { class: 'ac-spec-line', d: line, 'vector-effect': 'non-scaling-stroke' }));
  const limitX = (report.bandLimit / nyquist) * 100;
  const showLimit = report.bandLimit > 0 && report.bandLimit < nyquist * 0.95;
  if (showLimit) {
    svg.append(svgEl('line', { class: `ac-spec-limit${warn ? ' is-warn' : ''}`, x1: limitX * 10, x2: limitX * 10, y1: 0, y2: 100, 'vector-effect': 'non-scaling-stroke' }));
  }
  const cursor = svgEl('line', { class: 'ac-spec-cursor', x1: 0, x2: 0, y1: 0, y2: 100, 'vector-effect': 'non-scaling-stroke', visibility: 'hidden' });
  svg.append(cursor);
  const tip = el('span', { className: 'ac-spec-tip', hidden: true });
  const plot = el('div', { className: 'ac-spec-plot' }, svg,
    el('span', { className: 'ac-spec-floor-label', textContent: t('ac.floor', { bits: report.bits }), style: `top:${y(report.floorDb)}%` }),
    showLimit ? el('span', { className: 'ac-spec-limit-label', textContent: khz(report.bandLimit), style: `left:${limitX}%` }) : null,
    tip);
  plot.addEventListener('pointermove', (e) => {
    const box = plot.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const i = Math.round(f * (values.length - 1));
    cursor.setAttribute('x1', x(i));
    cursor.setAttribute('x2', x(i));
    cursor.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.textContent = `${khz(Math.round((i / (values.length - 1)) * nyquist / 100) * 100)} · ${values[i] <= bottom ? `< ${bottom}` : values[i].toFixed(0)} dB`;
    tip.style.left = `${(i / (values.length - 1)) * 100}%`;
    tip.classList.toggle('is-right', f > 0.6);
  });
  plot.addEventListener('pointerleave', () => { cursor.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  const chart = el('div', { className: 'ac-spectrum' }, plot,
    el('div', { className: 'ac-spec-axis' }, el('span', { textContent: '0' }), el('span', { textContent: khz(nyquist / 2) }), el('span', { textContent: khz(nyquist) })));
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', t('ac.spectrumLabel', { limit: khz(report.bandLimit), nyquist: khz(nyquist) }));
  return chart;
}

const defects = (stream) => (stream.result ? stream.result.escapes.filter((e) => DEFECTS.has(e.verdict)) : []);
const sourceNames = (stream) => stream.sources.map((s) => t(`ac.src.${s}`)).join(' · ');

/** 一条流（一个来源或两个来源共用的 media m3u8）的结论 */
function streamStatus(stream) {
  if (stream.error) return { text: t('ac.failed'), kind: 'bad', title: stream.error };
  const bad = defects(stream).length;
  if (bad) return { text: t('ac.defects', { n: bad }), kind: 'bad' };
  const n = stream.result.escapes.length;
  return { text: n ? t('ac.escapesOk', { n }) : t('ac.clean'), kind: 'ok' };
}

/** 音质最高的一条流（相同时取在前的，即网页版） */
function bestStream(result) {
  return result.streams.reduce((best, s) => (!best || compareAlac(s.variant, best.variant) > 0 ? s : best), null);
}

/**
 * 两个来源都检测时的比较：wrapper 表示 wrapper-lite 的最高音质 ALAC 更高，web 相反；same 为同一个文件；
 * differ 为音质相同但文件不同；null 表示无从比较（只有一个来源或某个来源出错）
 */
function sourceCompare(result) {
  const { web, wrapper } = result.masters;
  if (!web || !wrapper || web.error || wrapper.error || (!web.variant && !wrapper.variant)) return null;
  if (!web.variant) return { kind: 'wrapper', variant: wrapper.variant };
  if (!wrapper.variant) return { kind: 'web', variant: web.variant };
  if (web.variant.url === wrapper.variant.url) return { kind: 'same' };
  const order = compareAlac(wrapper.variant, web.variant);
  return order > 0 ? { kind: 'wrapper', variant: wrapper.variant } : order < 0 ? { kind: 'web', variant: web.variant } : { kind: 'differ' };
}

/**
 * kind：'album' | 'playlist' | 'song'（歌曲页与「更多」菜单）；id：专辑 / 歌单 / 歌曲 ID；country：地区；
 * resource：标题、艺人与封面所用的 amp-api 资源（专辑、歌单或这首歌）；tracks：要检测的曲目（amp-api songs 资源，
 * 没有 extendedAssetUrls 时这里补取）；wrapperMasters：已取到的 wrapper-lite master（曲目 ID → AmWrapper.songMaster 的结果，
 * 勾选 wrapper-lite 时不再请求）；toast(message)：底部提示
 */
export function openAlacCheckDialog({ kind = 'album', id, country, resource, tracks, wrapperMasters = null, toast }) {
  const a = resource.attributes || {};
  const items = tracks.filter((r) => r.type === 'songs' && r.attributes).map((track, index) => ({
    track,
    index,
    available: !!track.attributes.playParams,
    master: enhancedHls(track),
    selected: true,
    state: 'idle',
    progress: [],
    result: null,
    error: null,
    checkedAt: null,
    open: false,
  }));
  /** 当前这次检测的 AbortController；停止后旧检测里仍在进行的请求不再改动任何一行 */
  let controller = null;
  /** 最近一次检测：{ started, finished } */
  let run = null;
  /** 只有一首时不显示勾选框与全选 / 全不选 */
  const single = items.length === 1;

  const dialog = el('dialog', { className: `dl-dialog ac-dialog${single ? ' is-single' : ''}` });
  dialog.setAttribute('aria-labelledby', 'ac-dialog-title');

  function remembered(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; }
  }
  function option(key, fallback) {
    const box = el('input', { type: 'checkbox', checked: remembered(key, fallback) });
    box.addEventListener('change', () => {
      try { localStorage.setItem(key, box.checked ? '1' : '0'); } catch {}
      items.forEach(update);
    });
    return box;
  }
  const analyzeBox = option(ANALYZE_KEY, true);
  const wrapperBox = option(WRAPPER_KEY, false);

  const metaLine = el('p', { className: 'ac-head-meta' });
  const summary = el('span', { className: 'dl-dialog-count', role: 'status' });
  const all = el('button', { type: 'button', textContent: t('set.all') });
  const none = el('button', { type: 'button', textContent: t('set.none') });
  const list = el('ul', { className: 'dl-dialog-list ac-list' });
  const copy = el('button', { type: 'button', className: 'dl-dialog-cancel', textContent: t('ac.copy') });
  const runBtn = el('button', { type: 'button', className: 'dl-dialog-start' });
  const close = el('button', { type: 'button', className: 'dl-dialog-cancel', textContent: t('ac.close') });

  const checkable = (item) => item.available && (!!item.master || (wrapperBox.checked && item.master !== undefined));
  const finished = (item) => item.state === 'done' || item.state === 'error';

  function status(item) {
    if (!item.available) return { text: t('ac.unavailable'), kind: 'muted' };
    if (item.master === undefined) return { text: t('ac.loading'), kind: 'muted' };
    if (item.state === 'waiting') return { text: t('ac.waiting'), kind: 'muted' };
    if (item.state === 'running') {
      const scans = item.progress.filter((p) => p && p.phase === 'scan' && p.total);
      const done = scans.reduce((n, p) => n + p.done, 0);
      const total = scans.reduce((n, p) => n + p.total, 0);
      return { text: total ? t('ac.scanning', { done, total }) : t('ac.running'), kind: 'muted' };
    }
    if (item.state === 'error') return { text: t('ac.failed'), kind: 'bad', title: item.error };
    if (item.state === 'done') {
      const { streams, masters } = item.result;
      if (!streams.length) {
        const errors = SOURCES.filter((s) => masters[s] && masters[s].error).map((s) => `${t(`ac.src.${s}`)}: ${masters[s].error}`);
        return errors.length && SOURCES.every((s) => !masters[s] || masters[s].error)
          ? { text: t('ac.failed'), kind: 'bad', title: errors.join('\n') }
          : { text: t('ac.noAlac'), kind: 'muted', title: errors.join('\n') };
      }
      // 多条流时显示最差的结论，悬停列出每一条
      const each = streams.map(streamStatus);
      const worst = each.reduce((w, s, i) => {
        const score = streams[i].error ? 1 : defects(streams[i]).length ? 2 + defects(streams[i]).length : 0;
        return !w || score > w.score ? { ...s, score } : w;
      }, null);
      return { ...worst, title: streams.length > 1 ? streams.map((s, i) => `${sourceNames(s)} (${variantFormat(s.variant)}): ${each[i].text}`).join('\n') : worst.title || '' };
    }
    if (!checkable(item)) return { text: t('ac.noWebMaster'), kind: 'muted', title: t('ac.noWebMasterHint') };
    return { text: '', kind: 'muted' };
  }

  /** 行内标记：wrapper-lite 与网页版音质不同、实际位深 / 频宽值得注意 */
  function flags(item) {
    if (item.state !== 'done' || !item.result.streams.length) return [];
    const out = [];
    const cmp = sourceCompare(item.result);
    if (cmp && (cmp.kind === 'wrapper' || cmp.kind === 'web')) {
      out.push({ text: t(`ac.flagBetter.${cmp.kind}`), title: t(`ac.compare.${cmp.kind}`, { format: variantFormat(cmp.variant) }), kind: 'info' });
    }
    const best = bestStream(item.result);
    const report = best.result && best.result.analysis;
    if (report) {
      const { bits, band, verdict } = analysisLines(report);
      if (bits.warn) out.push({ text: t('ac.flagBits', { n: verdict.bits.effective }) });
      if (verdict.band === 'upsampled') out.push({ text: t('ac.flagUpsampled') });
      else if (band.warn) out.push({ text: t('ac.flagCutoff', { limit: khz(report.bandLimit) }) });
    }
    return out;
  }

  /**
   * 一条流一张卡片：来源、音质与结论一行，打包日期与帧数一行（打包软件与 media m3u8 文件名在悬停提示与报告中），
   * 之后是原样帧列表与解码分析
   */
  function streamDetail(stream) {
    const r = stream.result;
    const s = streamStatus(stream);
    const parts = [el('div', { className: 'ac-stream-head', title: stream.variant.url },
      ...stream.sources.map((name) => el('span', { className: 'ac-stream-src', textContent: t(`ac.src.${name}`) })),
      el('span', { className: 'ac-stream-format', textContent: variantFormat(stream.variant) }),
      el('span', { className: `ac-status is-${s.kind}`, textContent: s.text }))];
    if (stream.error) {
      parts.push(el('p', { className: 'ac-error', textContent: stream.error }));
      return el('div', { className: 'ac-stream' }, ...parts);
    }
    const info = r.info;
    parts.push(el('p', { className: 'ac-meta', title: [info.software, fileName(stream.variant.url)].filter(Boolean).join('\n') },
      [t('ac.packaged', { date: dateTime(info.created) || '—' }), t('ac.stats', { frames: r.frames, escapes: r.escapes.length, size: size(r.bytes) })].join(' · ')));
    if (r.escapes.length) {
      parts.push(el('table', { className: 'ac-frames' },
        el('thead', {}, el('tr', {}, ...['ac.colFrame', 'ac.colTime', 'ac.colVerdict', 'ac.colTail'].map((key) => el('th', { textContent: t(key) })))),
        el('tbody', {}, ...r.escapes.map((e) => el('tr', { className: DEFECTS.has(e.verdict) ? 'is-bad' : '' },
          el('td', { textContent: `#${e.frame}` }),
          el('td', { textContent: clock(e.time) }),
          el('td', { textContent: t(`ac.verdict.${e.verdict}`), title: t(`ac.verdictHint.${e.verdict}`) }),
          el('td', { className: 'ac-hex', textContent: e.tail }))))));
    }
    if (r.analysis) {
      const { bits, band, verdict } = analysisLines(r.analysis);
      parts.push(el('div', { className: 'ac-analysis' },
        el('p', { className: 'ac-analysis-title', textContent: t('ac.analysisTitle', { seconds: Math.round(r.analysis.frames / r.analysis.rate) }) }),
        el('p', { className: bits.warn ? 'is-warn' : '', textContent: bits.text }),
        el('p', { className: band.warn ? 'is-warn' : '', textContent: band.text }),
        r.analysis.failedPackets ? el('p', { className: 'is-warn', textContent: t('ac.undecodable', { n: r.analysis.failedPackets }) }) : null,
        r.analysis.spectrum.length && verdict.band !== 'quiet' ? spectrumChart(r.analysis, band.warn) : null));
    } else if (r.analysisError) {
      parts.push(el('p', { className: 'ac-error', textContent: t('ac.analysisFailed', { msg: r.analysisError }) }));
    }
    return el('div', { className: 'ac-stream' }, ...parts);
  }

  /** 各来源的问题（出错、没有 ALAC），每项为 { text, error } */
  function sourceProblems(result) {
    return SOURCES.filter((name) => result.masters[name] && !result.masters[name].variant).map((name) => {
      const m = result.masters[name];
      return { text: `${t(`ac.src.${name}`)}: ${m.error || t('ac.noAlac')}`, error: !!m.error };
    });
  }

  /** 详情：ID 一行、来源的问题，之后每条流一张卡片（两边的比较已由卡片上的来源与音质表明） */
  function detail(item) {
    const albumId = kind === 'album' ? '' : albumIdOf(item.track);
    const ids = el('p', { className: 'ac-meta ac-ids' }, [t('ac.songId', { id: item.track.id }), albumId && t('ac.albumId', { id: albumId })].filter(Boolean).join(' · '));
    if (item.state === 'error') return el('div', { className: 'ac-detail' }, ids, el('p', { className: 'ac-error', textContent: item.error }));
    return el('div', { className: 'ac-detail' }, ids,
      ...sourceProblems(item.result).map((p) => el('p', { className: p.error ? 'ac-error' : 'ac-meta', textContent: p.text })),
      ...item.result.streams.map(streamDetail));
  }

  const rows = new Map();
  function renderRow(item) {
    const ra = item.track.attributes;
    const s = status(item);
    const best = item.state === 'done' && item.result.streams.length ? bestStream(item.result) : null;
    const expandable = finished(item);
    const box = single ? null : el('input', { type: 'checkbox', checked: item.selected && checkable(item), disabled: !checkable(item) || !!controller });
    if (box) {
      box.setAttribute('aria-label', ra.name || item.track.id);
      box.addEventListener('change', () => { item.selected = box.checked; sync(); });
    }
    const num = kind === 'playlist' ? item.index + 1 : ra.trackNumber || '';
    const head = el('button', { type: 'button', className: 'ac-item', disabled: !expandable },
      el('span', { className: 'dl-dialog-num', textContent: String(num) }),
      el('span', { className: 'dl-dialog-name' }, ra.name || item.track.id,
        kind === 'playlist' && ra.artistName ? el('span', { className: 'dl-dialog-artist', textContent: ` — ${ra.artistName}` }) : null),
      // 窄屏时标记与结论一起换到第二行（见 downloads.css）
      el('span', { className: 'ac-tail' },
        ...flags(item).map((f) => el('span', { className: `ac-flag${f.kind ? ` is-${f.kind}` : ''}`, textContent: f.text, title: f.title || f.text })),
        el('span', { className: 'ac-format', textContent: best ? shortFormat(best.variant) : '', title: best ? variantFormat(best.variant) : '' }),
        el('span', { className: `ac-status is-${s.kind}`, textContent: s.text, title: s.title || '' })));
    head.setAttribute('aria-expanded', String(item.open && expandable));
    head.addEventListener('click', () => { item.open = !item.open; update(item); });
    return el('li', { className: 'ac-row' }, el('div', { className: 'ac-line' }, box, head), item.open && expandable ? detail(item) : null);
  }

  function update(item) {
    const next = renderRow(item);
    const old = rows.get(item);
    if (old) old.replaceWith(next); else list.append(next);
    rows.set(item, next);
    sync();
  }

  const targets = () => items.filter((i) => i.selected && checkable(i));

  function sync() {
    const selectable = items.filter(checkable);
    const chosen = targets();
    const checked = items.filter((i) => i.checkedAt || i.state === 'waiting' || i.state === 'running');
    const done = checked.filter(finished);
    const bad = done.filter((i) => i.state === 'done' && i.result.streams.some((s) => defects(s).length));
    const frames = bad.reduce((n, i) => n + Math.max(...i.result.streams.map((s) => defects(s).length)), 0);
    const better = done.filter((i) => i.state === 'done' && (sourceCompare(i.result) || {}).kind === 'wrapper').length;
    // 检测前显示已选几首；检测中显示进度，之后显示结论
    let text;
    if (!items.some((i) => i.available)) text = t('ac.nothing');
    else if (controller) text = t('ac.progress', { done: done.length, total: checked.length });
    else if (done.length) {
      text = [bad.length ? t('ac.summaryBad', { n: bad.length, frames }) : t('ac.summaryOk', { n: done.length }), better && t('ac.summaryBetter', { n: better })].filter(Boolean).join(' · ');
    } else text = single ? '' : t('ac.selected', { n: chosen.length, total: selectable.length });
    summary.textContent = text;
    summary.classList.toggle('is-bad', !controller && bad.length > 0);
    const n = chosen.length;
    runBtn.textContent = controller ? t('ac.stop')
      : chosen.some((i) => i.checkedAt) ? (single ? t('ac.rerun') : t('ac.rerunN', { n })) : single ? t('ac.start') : t('ac.startN', { n });
    runBtn.disabled = !controller && !n;
    all.disabled = none.disabled = !!controller;
    analyzeBox.disabled = wrapperBox.disabled = !!controller;
    copy.disabled = !done.length;
    metaLine.textContent = headMeta();
  }

  /** 标题下的一行：地区 · 专辑 / 歌单 / 歌曲 ID · 检测时间（完整的日期与时刻）与用时 */
  function headMeta() {
    const meta = [(country || '').toUpperCase(), id && t(`ac.id.${kind}`, { id })];
    if (run && run.finished) meta.push(t('ac.ranAt', { time: dateTime(run.started, true), s: Math.max(1, Math.round((run.finished - run.started) / 1000)) }));
    return meta.filter(Boolean).join(' · ');
  }

  all.addEventListener('click', () => { items.forEach((i) => { i.selected = true; }); items.forEach(update); });
  none.addEventListener('click', () => { items.forEach((i) => { i.selected = false; }); items.forEach(update); });

  /** 曲目没有 extendedAssetUrls（例如搜索结果）时补取 */
  async function loadMasters() {
    const missing = items.filter((i) => i.available && i.master === undefined);
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100);
      try {
        const url = new URL(`/amp/v1/catalog/${country}/songs`, location.origin);
        url.searchParams.set('ids', batch.map((x) => x.track.id).join(','));
        url.searchParams.set('extend', 'extendedAssetUrls');
        url.searchParams.set('fields[songs]', 'extendedAssetUrls');
        const res = await fetch(url);
        const data = res.ok ? await res.json() : {};
        const found = new Map((data.data || []).map((r) => [r.id, r.attributes ? (r.attributes.extendedAssetUrls || {}).enhancedHls || null : null]));
        for (const x of batch) x.master = found.get(x.track.id) ?? null;
      } catch {
        for (const x of batch) x.master = null;
      }
      if (!dialog.isConnected) return;
      batch.forEach(update);
    }
  }

  async function start() {
    const chosen = targets();
    if (!chosen.length) return;
    controller = new AbortController();
    const { signal } = controller;
    const useWrapper = wrapperBox.checked;
    run = { started: new Date(), finished: null };
    // 每次检测有自己的分析 Worker，停止时立即终止
    const analyzer = analyzeBox.checked ? createAnalyzer() : null;
    if (analyzer) signal.addEventListener('abort', () => analyzer.close(), { once: true });
    const limit = createLimiter(REQUESTS_AT_ONCE);
    const analysisLimit = createLimiter(ANALYSES_AT_ONCE);
    const trackLimit = createLimiter(useWrapper ? TRACKS_AT_ONCE_WRAPPER : TRACKS_AT_ONCE);
    for (const item of chosen) Object.assign(item, { state: 'waiting', progress: [], result: null, error: null, checkedAt: null });
    items.forEach(update);
    await Promise.all(chosen.map((item) => trackLimit(async () => {
      if (signal.aborted) return;
      item.state = 'running';
      update(item);
      try {
        const known = wrapperMasters && wrapperMasters.get(item.track.id);
        const result = await checkSources(item.track.id, { web: item.master, wrapper: useWrapper && (known || true) }, {
          signal, limit, analyzer, analysisLimit,
          onProgress: (p) => { if (!signal.aborted) { item.progress[p.stream] = p; update(item); } },
        });
        if (signal.aborted) return;
        Object.assign(item, { result, state: 'done' });
      } catch (error) {
        if (signal.aborted) return;
        Object.assign(item, { state: 'error', error: error.message || String(error) });
      }
      item.checkedAt = new Date();
      // 只检测一首时直接展开详情
      if (single) item.open = true;
      update(item);
    })));
    if (signal.aborted) return;
    if (analyzer) analyzer.close();
    controller = null;
    run.finished = new Date();
    items.forEach(update);
  }

  function stop() {
    if (!controller) return;
    controller.abort(new DOMException('ALAC check stopped', 'AbortError'));
    controller = null;
    if (run) run.finished = new Date();
    for (const item of items) if (item.state === 'running' || item.state === 'waiting') Object.assign(item, { state: 'idle', progress: [] });
    items.forEach(update);
  }

  /** 纯文字报告，便于贴到 issue 或聊天中 */
  function report() {
    const meta = [(country || '').toUpperCase(), id && t(`ac.id.${kind}`, { id }), run && t('ac.checkedAt', { date: dateTime(run.started, true) })];
    const lines = [`${t('ac.title', { name: a.name || '' })}${a.artistName ? ` — ${a.artistName}` : ''}`, meta.filter(Boolean).join(' · ')];
    for (const item of items) {
      if (!item.checkedAt) continue;
      const ra = item.track.attributes;
      const num = kind === 'playlist' ? String(item.index + 1).padStart(2, '0') : String(ra.trackNumber || '').padStart(2, '0');
      const albumId = kind === 'album' ? '' : albumIdOf(item.track);
      const head = `${kind === 'album' && discs.size > 1 ? `${ra.discNumber || 1}-` : ''}${num} ${ra.name} [${t('ac.songId', { id: item.track.id })}${albumId ? `, ${t('ac.albumId', { id: albumId })}` : ''}]`;
      if (item.state !== 'done') { lines.push(`${head}: ${status(item).text}${item.error ? ` (${item.error})` : ''}`); continue; }
      const best = bestStream(item.result);
      lines.push(`${head}: ${best ? `${variantFormat(best.variant)} · ` : ''}${status(item).text}`);
      const cmp = sourceCompare(item.result);
      if (cmp) lines.push(`    ${t(`ac.compare.${cmp.kind}`, cmp.variant ? { format: variantFormat(cmp.variant) } : {})}`);
      for (const p of sourceProblems(item.result)) lines.push(`    ${p.text}`);
      for (const stream of item.result.streams) {
        const r = stream.result;
        const s = streamStatus(stream);
        lines.push(`    [${sourceNames(stream)}] ${variantFormat(stream.variant)} · ${fileName(stream.variant.url)}${r ? ` · ${t('ac.packaged', { date: dateTime(r.info.created) || '—' })}${r.info.software ? ` (${r.info.software})` : ''}` : ''} · ${s.text}${stream.error ? ` (${stream.error})` : ''}`);
        if (!r) continue;
        for (const e of r.escapes) lines.push(`        #${e.frame} ${clock(e.time)} ${t(`ac.verdict.${e.verdict}`)} [${e.tail}]`);
        if (r.analysis) {
          const { bits, band } = analysisLines(r.analysis);
          lines.push(`        ${bits.text} · ${band.text}`);
        }
      }
    }
    return lines.join('\n');
  }

  runBtn.addEventListener('click', () => (controller ? stop() : start()));
  close.addEventListener('click', () => dialog.close());
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(report());
      toast(t('ac.copied'));
    } catch (error) {
      toast(error.message || String(error));
    }
  });

  // 多碟专辑与下载对话框一样按碟分组（各碟曲目编号从 1 开始）
  const discs = new Set(items.map((i) => i.track.attributes.discNumber || 1));
  let lastDisc = null;
  for (const item of items) {
    const disc = item.track.attributes.discNumber || 1;
    if (kind === 'album' && discs.size > 1 && disc !== lastDisc) list.append(el('li', { className: 'dl-dialog-disc', textContent: t('album.disc', { n: disc }) }));
    lastDisc = disc;
    update(item);
  }

  const help = el('div', { className: 'ac-help', hidden: true },
    el('p', { textContent: t('ac.intro') }), el('p', { textContent: t('ac.wrapperOption') }), el('p', { textContent: t('ac.analyzeOption') }));
  const helpBtn = el('button', { type: 'button', className: 'ac-help-btn', textContent: t('ac.help') });
  helpBtn.setAttribute('aria-expanded', 'false');
  helpBtn.addEventListener('click', () => {
    help.hidden = !help.hidden;
    helpBtn.setAttribute('aria-expanded', String(!help.hidden));
  });

  const cover = (a.editorialArtwork && a.editorialArtwork.staticDetailSquare) || a.artwork;
  const src = art(cover, 112);
  dialog.append(...[
    el('div', { className: 'dl-dialog-head' },
      src ? el('img', { className: 'dl-dialog-art', src, alt: '' }) : null,
      el('div', { className: 'dl-dialog-titles' },
        el('h2', { className: 'dl-dialog-title', id: 'ac-dialog-title', textContent: t('ac.title', { name: a.name || '' }) }),
        el('p', { className: 'dl-dialog-sub', textContent: a.artistName || a.curatorName || '' }),
        metaLine)),
    // 两个选项一行短标签；原理与选项的说明收进「说明」
    el('div', { className: 'ac-options' },
      el('label', { className: 'ac-option', title: t('ac.wrapperOption') }, wrapperBox, el('span', { textContent: t('ac.wrapperShort') })),
      el('label', { className: 'ac-option', title: t('ac.analyzeOption') }, analyzeBox, el('span', { textContent: t('ac.analyzeShort') })),
      helpBtn),
    help,
    // 只有一首时结论就在那一行上，不需要这一栏
    single ? null : el('div', { className: 'dl-dialog-tools' }, summary, all, none),
    list,
    el('div', { className: 'dl-dialog-foot' }, copy, close, runBtn)].filter(Boolean));
  dialog.addEventListener('close', () => { stop(); dialog.remove(); });
  document.body.append(dialog);
  sync();
  dialog.showModal();
  runBtn.focus();
  loadMasters();
  return dialog;
}

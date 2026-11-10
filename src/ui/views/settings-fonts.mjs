// 设置中心「播放 › 歌词字体」（views/settings.mjs 调用 fontSection）：字体库（选择、预览、占用、离线保存、删除）
// 与四种添加方式：上传文件、网址（字体文件或 @font-face CSS）、电脑已安装的字体（Local Font Access API）、中文网字计划。
// 字体存储见 lyrics/fonts.mjs；字体数据只保存在这个浏览器里。
import { lyricFonts, CATALOG_CDN, FONT_EXTENSIONS, formatBytes, lyricsWeight, previewCss, isInstalled } from '../lyrics/fonts.mjs';

const { t } = window.AmI18n;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

const SAMPLE_KEY = 'am-hook:lyrics-font-sample';
const LOCAL_LIMIT = 150;
/** 离线保存的进度，重绘列表后保留：id → { done, total, controller } */
const downloading = new Map();

const ICONS = {
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15"/></svg>',
  url: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/></svg>',
  local: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20h7M12 16.5V20"/></svg>',
  catalog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 19 9.5 5h1l5 14M6.6 13.5h6.8"/><path d="M15.5 9.5h4.5M17.75 7.5v2c0 3-1.3 5.5-3.75 7M16 12.5c.8 1.7 2.2 3.2 4 4"/></svg>',
};

/** 一个字体的字重摘要：300 · 400 · 700，可变字体为 100–900 */
function weightsOf(entry) {
  if (entry.origin === 'local') return entry.styles?.length ? t('set.font.styles', { n: entry.styles.length }) : '';
  const weights = [...new Set(entry.faces.map((face) => String(face.weight).replace(' ', '–')))];
  weights.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const italic = entry.faces.some((face) => face.style === 'italic');
  return weights.join(' · ') + (italic ? ` · ${t('set.font.italic')}` : '');
}

/** 错误代码 → 提示 */
function errorText(error) {
  const code = error?.code || 'failed';
  return t(`set.font.err.${code}`, { status: error?.status ?? '' }) || String(error?.message || error);
}

/**
 * section(id, titleKey, ...rows)：settings.mjs 的分组卡片；toast(text) 显示提示；
 * signal 中止时（重绘或离开设置页）移除监听
 */
export function fontSection({ section, toast, signal }) {
  let sample = '';
  try { sample = localStorage.getItem(SAMPLE_KEY) || ''; } catch { /* 用默认文字 */ }
  const sampleText = () => sample || t('set.font.sampleDefault');
  const samples = new Set();
  const sampleNode = (family, className = 'set-font-sample') => {
    const node = el('div', { className, textContent: sampleText() });
    node.style.fontFamily = family;
    node.style.fontWeight = String(lyricsWeight());
    samples.add(node);
    return node;
  };
  const refreshSamples = () => {
    for (const node of samples) {
      if (!node.isConnected && node !== stageSample) { samples.delete(node); continue; }
      node.textContent = sampleText();
      node.style.fontWeight = String(lyricsWeight());
    }
  };

  /* ---------- 当前字体：仿歌词界面的大字预览，可改预览文字 ---------- */
  const stageName = el('span', { className: 'set-font-stage-name' });
  const stageSample = el('div', { className: 'set-font-stage-sample' });
  samples.add(stageSample);
  const sampleInput = el('input', { type: 'text', className: 'set-input set-font-text', value: sample, placeholder: t('set.font.sampleDefault'), maxLength: 80 });
  sampleInput.setAttribute('aria-label', t('set.font.sampleLabel'));
  sampleInput.addEventListener('input', () => {
    sample = sampleInput.value;
    try { if (sample) localStorage.setItem(SAMPLE_KEY, sample); else localStorage.removeItem(SAMPLE_KEY); } catch { /* 不保存 */ }
    refreshSamples();
  });
  const stage = el('div', { className: 'set-font-stage' },
    el('div', { className: 'set-font-stage-head' }, el('span', { className: 'set-font-stage-label', textContent: t('set.font.current') }), stageName),
    stageSample,
    el('label', { className: 'set-font-text-row' }, el('span', { textContent: t('set.font.sampleLabel') }), sampleInput));
  function renderStage() {
    const entry = lyricFonts.selected();
    stageName.textContent = entry ? entry.name : t('set.font.system');
    stageSample.style.fontFamily = entry ? `${lyricFonts.cssFamily(entry)}, var(--lyrics-system-font)` : 'var(--lyrics-system-font)';
    stageSample.style.fontWeight = String(lyricsWeight());
    stageSample.textContent = sampleText();
  }

  /* ---------- 字体库 ---------- */
  const list = el('div', { className: 'set-font-list', role: 'radiogroup' });
  list.setAttribute('aria-label', t('set.font.library'));
  const usageUpdaters = new Map();

  function item(entry) {
    const selected = (lyricFonts.selected()?.id || '') === (entry?.id || '');
    const main = el('button', { type: 'button', className: 'set-font-main' });
    main.setAttribute('role', 'radio');
    main.setAttribute('aria-checked', String(selected));
    main.addEventListener('click', () => lyricFonts.select(entry?.id || ''));
    const node = el('div', { className: `set-font${selected ? ' is-selected' : ''}` }, main);
    if (!entry) {
      main.append(
        el('span', { className: 'set-font-name' }, el('span', { textContent: t('set.font.system') })),
        sampleNode('var(--lyrics-system-font)'),
        el('span', { className: 'set-font-meta', textContent: t('set.font.systemDesc') }));
      return node;
    }
    lyricFonts.register(entry).catch(() => {});
    const meta = el('span', { className: 'set-font-meta' });
    main.append(
      el('span', { className: 'set-font-name' },
        el('span', { textContent: entry.name }),
        el('span', { className: 'set-font-tag', textContent: t(`set.font.origin.${entry.origin}`) })),
      sampleNode(`${lyricFonts.cssFamily(entry)}, var(--lyrics-system-font)`),
      meta);
    const actions = el('div', { className: 'set-font-actions' });
    node.append(actions);

    // 网络字体：保存了几个分片；全部离线保存
    const offline = el('button', { type: 'button', className: 'set-mini', textContent: t('set.font.offline') });
    offline.title = t('set.font.offlineDesc');
    offline.hidden = true;
    offline.addEventListener('click', () => {
      const running = downloading.get(entry.id);
      if (running) { running.controller.abort(); return; }
      const controller = new AbortController();
      const state = { done: 0, total: entry.faces.length, controller };
      downloading.set(entry.id, state);
      updateUsage();
      lyricFonts.downloadAll(entry.id, {
        signal: controller.signal,
        onProgress: (n, total) => { state.done = n; state.total = total; updateUsage(); },
      }).then(() => toast(t('set.font.offlineDone', { name: entry.name })))
        .catch((error) => { if (!controller.signal.aborted) toast(errorText(error)); })
        .finally(() => { downloading.delete(entry.id); updateUsage(); });
    });
    if (entry.page) {
      actions.append(el('a', { className: 'set-mini set-font-link', href: entry.page, target: '_blank', rel: 'noopener noreferrer', textContent: t('set.font.license') }));
    }
    const remove = el('button', { type: 'button', className: 'set-mini set-font-remove', textContent: t('set.font.remove') });
    let armed = 0;
    remove.addEventListener('click', () => {
      if (!armed) {
        remove.textContent = t('set.font.removeConfirm');
        remove.classList.add('is-armed');
        armed = setTimeout(() => { armed = 0; remove.textContent = t('set.font.remove'); remove.classList.remove('is-armed'); }, 4000);
        return;
      }
      clearTimeout(armed);
      downloading.get(entry.id)?.controller.abort();
      lyricFonts.remove(entry.id).then(() => toast(t('set.font.removed', { name: entry.name })), (error) => toast(errorText(error)));
    });
    actions.prepend(offline);
    actions.append(remove);

    async function updateUsage() {
      const parts = [];
      const weights = weightsOf(entry);
      if (weights) parts.push(weights);
      if (entry.origin === 'local') {
        if (!isInstalled(entry.family)) parts.push(t('set.font.notFound'));
        else parts.push(t('set.font.localNote'));
        meta.textContent = parts.join(' · ');
        return;
      }
      const use = await lyricFonts.usage(entry);
      const running = downloading.get(entry.id);
      const remote = entry.faces.some((face) => face.url) && entry.faces.length > 1;
      if (remote) {
        parts.push(running
          ? t('set.font.downloading', { done: running.done, total: running.total })
          : t('set.font.cached', { done: use.files, total: use.faces, size: formatBytes(use.bytes) }));
      } else {
        parts.push(use.files ? formatBytes(use.bytes) : t('set.font.missing'));
      }
      meta.textContent = parts.join(' · ');
      offline.hidden = !remote || (!running && use.files >= use.faces);
      offline.textContent = running ? t('set.font.offlineStop') : t('set.font.offline');
    }
    usageUpdaters.set(entry.id, updateUsage);
    updateUsage();
    return node;
  }

  function renderList() {
    usageUpdaters.clear();
    list.replaceChildren(item(null), ...lyricFonts.entries.map(item));
    empty.hidden = lyricFonts.entries.length > 0;
  }
  const empty = el('div', { className: 'set-font-empty', textContent: t('set.font.empty') });

  /* ---------- 添加：四种方式，各一个面板 ---------- */
  const panels = {};
  const addButtons = el('div', { className: 'set-font-add', role: 'tablist' });
  addButtons.setAttribute('aria-label', t('set.font.add'));
  const panelHost = el('div', { className: 'set-font-panels' });
  let openPanel = null;
  for (const kind of ['upload', 'url', 'local', 'catalog']) {
    const button = el('button', { type: 'button', className: 'set-font-add-btn', innerHTML: ICONS[kind] });
    button.append(el('span', { textContent: t(`set.font.add.${kind}`) }));
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', 'false');
    button.dataset.kind = kind;
    button.addEventListener('click', () => showPanel(openPanel === kind ? null : kind));
    addButtons.append(button);
  }
  function showPanel(kind) {
    openPanel = kind;
    for (const button of addButtons.children) button.setAttribute('aria-selected', String(button.dataset.kind === kind));
    if (kind && !panels[kind]) panels[kind] = { upload: uploadPanel, url: urlPanel, local: localPanel, catalog: catalogPanel }[kind]();
    panelHost.replaceChildren(...(kind ? [panels[kind]] : []));
    panelHost.hidden = !kind;
  }

  /** 添加成功后用于歌词（一次添加一个时） */
  function added(entry) {
    lyricFonts.select(entry.id);
    toast(t('set.font.added', { name: entry.name }));
  }

  /* 上传 */
  async function addFiles(files) {
    const fonts = [...files].filter((file) => FONT_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext)));
    if (!fonts.length) { toast(t('set.font.err.notFont')); return; }
    toast(t('set.font.reading'));
    const { added: list, failed } = await lyricFonts.addFiles(fonts);
    if (list.length === 1) added(list[0]);
    else if (list.length) toast(t('set.font.addedMany', { n: list.length }));
    for (const { name, code } of failed) toast(`${name}: ${errorText({ code })}`);
  }
  function uploadPanel() {
    const input = el('input', { type: 'file', multiple: true, accept: FONT_EXTENSIONS.join(','), className: 'set-font-file' });
    input.addEventListener('change', () => { if (input.files.length) addFiles(input.files).finally(() => { input.value = ''; }); });
    const zone = el('label', { className: 'set-font-drop' }, input,
      el('span', { className: 'set-font-drop-icon', innerHTML: ICONS.upload }),
      el('span', { className: 'set-font-drop-title', textContent: t('set.font.dropTitle') }),
      el('span', { className: 'set-desc', textContent: t('set.font.dropDesc') }));
    return el('div', { className: 'set-font-panel' }, zone);
  }

  /* 网址 */
  function urlPanel() {
    const input = el('input', { type: 'url', className: 'set-input set-font-url', placeholder: 'https://…/font.woff2  ·  https://…/result.css' });
    input.setAttribute('aria-label', t('set.font.add.url'));
    const go = el('button', { type: 'submit', className: 'set-btn', textContent: t('set.font.addBtn') });
    const form = el('form', { className: 'set-font-line' }, input, go);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!input.value.trim()) return;
      go.disabled = true;
      go.textContent = t('set.font.adding');
      try {
        added(await lyricFonts.addUrl(input.value));
        input.value = '';
      } catch (error) {
        toast(errorText(error));
      } finally {
        go.disabled = false;
        go.textContent = t('set.font.addBtn');
      }
    });
    return el('div', { className: 'set-font-panel' }, form, el('p', { className: 'set-desc', textContent: t('set.font.urlDesc') }));
  }

  /* 已安装的字体 */
  function localPanel() {
    const supported = typeof window.queryLocalFonts === 'function';
    const panel = el('div', { className: 'set-font-panel' });
    const results = el('div', { className: 'set-font-local' });
    const status = el('p', { className: 'set-desc' });
    let families = null;
    const search = el('input', { type: 'search', className: 'set-input set-font-search', placeholder: t('set.font.localSearch') });
    search.setAttribute('aria-label', t('set.font.localSearch'));
    search.hidden = true;
    search.addEventListener('input', () => renderLocal());
    function renderLocal() {
      if (!families) return;
      const q = search.value.trim().toLowerCase();
      const matched = q ? families.filter((f) => f.family.toLowerCase().includes(q) || f.styles.some((s) => s.fullName.toLowerCase().includes(q))) : families;
      const have = new Set(lyricFonts.entries.filter((e) => e.origin === 'local').map((e) => e.family.toLowerCase()));
      results.replaceChildren(...matched.slice(0, LOCAL_LIMIT).map((font) => {
        const exists = have.has(font.family.toLowerCase());
        const add = el('button', { type: 'button', className: 'set-mini', textContent: exists ? t('set.font.addedShort') : t('set.font.addBtn'), disabled: exists });
        add.addEventListener('click', async () => {
          try { added(await lyricFonts.addLocal(font.family, font.styles.map((s) => s.style))); renderLocal(); } catch (error) { toast(errorText(error)); }
        });
        const name = el('span', { className: 'set-font-local-name', textContent: font.family });
        name.style.fontFamily = `"${font.family.replace(/["\\]/g, '\\$&')}", var(--lyrics-system-font)`;
        return el('div', { className: 'set-font-local-row' },
          el('div', { className: 'set-font-local-text' }, name, el('span', { className: 'set-desc', textContent: t('set.font.styles', { n: font.styles.length }) })),
          add);
      }));
      // 没有授权时 Chrome 返回空列表而不是报错
      status.textContent = !families.length ? t('set.font.localNone')
        : matched.length > LOCAL_LIMIT ? t('set.font.localMore', { shown: LOCAL_LIMIT, total: matched.length })
          : t('set.font.localCount', { n: matched.length });
      search.hidden = !families.length;
      readButton.hidden = families.length > 0;
    }
    const readButton = el('button', { type: 'button', className: 'set-btn', textContent: t('set.font.localRead') });
    if (supported) {
      readButton.addEventListener('click', async () => {
        readButton.disabled = true;
        try {
          families = await lyricFonts.queryLocalFonts();
          renderLocal();
          if (families.length) search.focus();
        } catch (error) {
          status.textContent = errorText(error);
        } finally {
          readButton.disabled = false;
        }
      });
      status.textContent = t('set.font.localDesc');
      panel.append(el('div', { className: 'set-font-line' }, readButton, search), status, results);
    } else {
      status.textContent = t('set.font.localUnsupported');
      panel.append(status);
    }
    // 手动输入名称：不支持 Local Font Access 的浏览器（Firefox、Safari），或想用某个家族名时
    const manual = el('input', { type: 'text', className: 'set-input set-font-url', placeholder: t('set.font.manualPlaceholder') });
    manual.setAttribute('aria-label', t('set.font.manual'));
    const check = el('span', { className: 'set-desc set-font-check' });
    manual.addEventListener('input', () => {
      const name = manual.value.trim();
      check.textContent = name ? t(isInstalled(name) ? 'set.font.found' : 'set.font.notFound') : '';
      check.classList.toggle('is-bad', !!name && !isInstalled(name));
    });
    const addManual = el('button', { type: 'submit', className: 'set-btn', textContent: t('set.font.addBtn') });
    const form = el('form', { className: 'set-font-line' }, manual, addManual);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try { added(await lyricFonts.addLocal(manual.value)); manual.value = ''; check.textContent = ''; } catch (error) { toast(errorText(error)); }
    });
    panel.append(el('div', { className: 'set-font-sub', textContent: t('set.font.manual') }), form, check);
    return panel;
  }

  /* 中文网字计划 */
  function catalogPanel() {
    const panel = el('div', { className: 'set-font-panel' });
    const grid = el('div', { className: 'set-font-grid' });
    const detail = el('div', { className: 'set-font-detail', hidden: true });
    const search = el('input', { type: 'search', className: 'set-input set-font-search', placeholder: t('set.font.catalogSearch') });
    search.setAttribute('aria-label', t('set.font.catalogSearch'));
    panel.append(
      el('p', { className: 'set-desc' }, t('set.font.catalogDesc'), ' ',
        el('a', { href: 'https://chinese-font.netlify.app/zh-cn/', target: '_blank', rel: 'noopener noreferrer', textContent: t('set.font.catalogSite') })),
      search, detail, grid);
    let catalog = [];
    let current = null;
    let previewAbort = null;
    const preview = (pkg, dir) => `${CATALOG_CDN}/${encodeURIComponent(pkg)}/dist/${encodeURIComponent(dir)}/preview.svg`;

    function renderGrid() {
      const q = search.value.trim().toLowerCase();
      const matched = catalog.filter(([name, pkg, dirs]) => !q || name.toLowerCase().includes(q) || pkg.toLowerCase().includes(q) || dirs.some((d) => d.toLowerCase().includes(q)));
      grid.replaceChildren(...matched.map(([name, pkg, dirs]) => {
        const card = el('button', { type: 'button', className: 'set-font-card' },
          el('img', { src: preview(pkg, dirs[0]), alt: '', loading: 'lazy', decoding: 'async', referrerPolicy: 'strict-origin-when-cross-origin' }),
          el('span', { className: 'set-font-card-name', textContent: name }),
          dirs.length > 1 ? el('span', { className: 'set-font-card-count', textContent: t('set.font.variants', { n: dirs.length }) }) : null);
        card.dataset.pkg = pkg;
        card.setAttribute('aria-pressed', String(current?.pkg === pkg));
        card.addEventListener('click', () => showDetail(name, pkg, dirs, dirs[0]));
        return card;
      }));
      if (!matched.length) grid.append(el('div', { className: 'set-font-empty', textContent: t('set.font.noMatch') }));
    }
    search.addEventListener('input', renderGrid);

    async function showDetail(name, pkg, dirs, dir) {
      current = { name, pkg, dirs, dir };
      for (const card of grid.querySelectorAll('.set-font-card')) card.setAttribute('aria-pressed', String(card.dataset.pkg === pkg));
      const label = dirs.length > 1 ? dir : '';
      const url = lyricFonts.catalogCss({ pkg, dir });
      const existing = lyricFonts.entries.find((e) => e.url === url);
      const sampleBox = el('div', { className: 'set-font-detail-sample is-loading', textContent: sampleText() });
      sampleBox.style.fontWeight = String(lyricsWeight());
      const status = el('span', { className: 'set-desc', textContent: t('set.font.previewLoading') });
      const addBtn = el('button', { type: 'button', className: 'set-btn set-btn-accent', textContent: existing ? t('set.font.useBtn') : t('set.font.addUse') });
      addBtn.addEventListener('click', async () => {
        if (existing) { lyricFonts.select(existing.id); toast(t('set.font.selected', { name: existing.name })); return; }
        addBtn.disabled = true;
        addBtn.textContent = t('set.font.adding');
        try {
          added(await lyricFonts.addCatalog({ name, pkg, dir, label }));
          showDetail(name, pkg, dirs, dir);
        } catch (error) {
          toast(errorText(error));
          addBtn.disabled = false;
          addBtn.textContent = t('set.font.addUse');
        }
      });
      const variants = dirs.length > 1 ? el('div', { className: 'set-chips' }, ...dirs.map((d) => {
        const chip = el('button', { type: 'button', className: 'set-chip', textContent: d });
        chip.setAttribute('aria-pressed', String(d === dir));
        chip.addEventListener('click', () => showDetail(name, pkg, dirs, d));
        return chip;
      })) : null;
      detail.replaceChildren(
        el('div', { className: 'set-font-detail-head' },
          el('span', { className: 'set-font-detail-name', textContent: name }),
          el('a', { className: 'set-mini set-font-link', href: `https://chinese-font.netlify.app/zh-cn/fonts/${encodeURIComponent(pkg)}/${encodeURIComponent(dir)}`, target: '_blank', rel: 'noopener noreferrer', textContent: t('set.font.license') })),
        variants, sampleBox,
        el('div', { className: 'set-font-line' }, addBtn, status));
      detail.hidden = false;
      previewAbort?.abort();
      const controller = new AbortController();
      previewAbort = controller;
      try {
        const family = await previewCss(url, controller.signal);
        if (controller.signal.aborted) return;
        sampleBox.style.fontFamily = `"${family}", var(--lyrics-system-font)`;
        await document.fonts.load(`${lyricsWeight()} 32px "${family}"`, sampleText());
        if (controller.signal.aborted) return;
        sampleBox.classList.remove('is-loading');
        status.textContent = existing ? t('set.font.inLibrary') : t('set.font.previewNote');
      } catch (error) {
        if (controller.signal.aborted) return;
        sampleBox.classList.remove('is-loading');
        status.textContent = errorText(error.code ? error : { code: 'cors' });
      }
    }

    grid.append(el('div', { className: 'set-font-empty', textContent: t('set.font.previewLoading') }));
    import('../lyrics/font-catalog.mjs').then(({ CATALOG }) => { catalog = CATALOG; renderGrid(); });
    return panel;
  }

  /* ---------- 存储占用 ---------- */
  const storage = el('div', { className: 'set-desc set-font-storage' });
  async function renderStorage() {
    let total = 0;
    for (const entry of lyricFonts.entries) total += (await lyricFonts.usage(entry)).bytes;
    const { usage, quota, persisted } = await lyricFonts.storageEstimate();
    const parts = [t('set.font.total', { size: formatBytes(total) })];
    if (usage !== null && quota) parts.push(t('set.font.quota', { usage: formatBytes(usage), quota: formatBytes(quota) }));
    storage.replaceChildren(parts.join(' · '), ' ');
    if (persisted) {
      storage.append(el('span', { className: 'set-font-persist', textContent: t('set.font.persisted') }));
    } else if (navigator.storage?.persist && lyricFonts.entries.length) {
      const ask = el('button', { type: 'button', className: 'set-btn-link', textContent: t('set.font.persist') });
      ask.title = t('set.font.persistDesc');
      ask.addEventListener('click', async () => {
        toast(t(await lyricFonts.persist() ? 'set.font.persistOk' : 'set.font.persistNo'));
        renderStorage();
      });
      storage.append(ask);
    }
  }

  /* ---------- 拖放到整个分组 ---------- */
  const card = section('lyrics-font', 'set.font.title',
    el('div', { className: 'set-row set-row-wide set-font-top' }, stage),
    el('div', { className: 'set-row set-row-wide' },
      el('span', { className: 'set-label' }, el('span', { textContent: t('set.font.library') }), el('span', { className: 'set-desc', textContent: t('set.font.libraryDesc') })),
      list, empty),
    el('div', { className: 'set-row set-row-wide' },
      el('span', { className: 'set-label' }, el('span', { textContent: t('set.font.add') }), el('span', { className: 'set-desc', textContent: t('set.font.addDesc') })),
      addButtons, panelHost),
    el('div', { className: 'set-row set-row-note' }, storage));
  panelHost.hidden = true;
  card.addEventListener('dragover', (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    event.preventDefault();
    card.classList.add('is-dragging');
  });
  card.addEventListener('dragleave', (event) => { if (!card.contains(event.relatedTarget)) card.classList.remove('is-dragging'); });
  card.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    card.classList.remove('is-dragging');
    addFiles(event.dataTransfer.files);
  });

  function refresh(kind) {
    if (kind === 'usage') {
      for (const update of usageUpdaters.values()) update();
    } else {
      renderList();
      renderStage();
      if (openPanel === 'local' && panels.local) panels.local.querySelector('.set-font-search:not([hidden])')?.dispatchEvent(new Event('input'));
    }
    renderStorage();
  }
  const off = lyricFonts.onChange(refresh);
  signal.addEventListener('abort', () => { off(); }, { once: true });
  // 歌词界面里改了字重：预览跟着变
  addEventListener('storage', (event) => { if (event.key === 'am-hook:lyrics-prefs') refreshSamples(); }, { signal });
  renderStage();
  renderList();
  lyricFonts.ready.then(() => { if (!signal.aborted) refresh('library'); });
  return card;
}

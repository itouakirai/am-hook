// 主地区与曲库语言的选择面板（设置本身由 i18n.js 的 AmI18n 保存，见其文件头）。
//
// 页面上带 data-picker="storefront" / "ampLang" 的按钮点击后打开面板：宽屏时贴着按钮弹出（上下哪边空间大就放哪边），
// 手机宽度（< 484px）为底部面板。导航里的按钮另有 [data-setting-value] 显示当前值。
//   主地区：先列出 wrapper-lite 账号所在地区（最佳体验），再列出收藏的地区（默认 us / cn / jp）；
//          其余地区收在「更多地区」里，展开后可筛选，每个地区右侧的星标按钮收藏 / 取消收藏。
//   曲库语言：只列出主地区在 /amp/v1/storefronts 里的 supportedLanguageTags，默认为地区的 defaultLanguageTag。
//   wrapper-lite：服务端（经 am-hook 转发）或本地（浏览器直连，可设地址、限速、限并发与 Authorization），
//          设置由 wrapper.js 的 AmWrapper 保存；保存后由 app.mjs 重新检查状态，结果显示在面板里。

const { AmI18n, AmWrapper } = window;
const { t } = AmI18n;

const mobile = matchMedia('(max-width: 483px)');
const coarse = matchMedia('(pointer: coarse)');
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const STAR = '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>';
const CHEVRON ='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

const displayNames = new Map();
/** 按界面语言显示的地区 / 语言名（Intl.DisplayNames），取不到时用 fallback */
function displayName(type, code, fallback) {
  const locale = AmI18n.lang === 'zh' ? 'zh-CN' : 'en';
  const key = `${locale}:${type}`;
  try {
    if (!displayNames.has(key)) displayNames.set(key, new Intl.DisplayNames([locale], { type, fallback: 'none' }));
    return displayNames.get(key).of(code) || fallback;
  } catch {
    return fallback;
  }
}
const regionName = (cc, map) => displayName('region', cc.toUpperCase(), (map && map[cc] && map[cc].name) || cc.toUpperCase());
const langName = (tag) => displayName('language', tag, tag);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** checkStatus：app.mjs 的状态检查，返回 { ok, regions, error } */
export function mountSettings({ picker, scrim, checkStatus }) {
  const title = picker.querySelector('.picker-title');
  const hint = picker.querySelector('.picker-hint');
  const body = picker.querySelector('.picker-body');
  /** 打开中的面板：{ kind, anchor, expanded, filter } */
  let open = null;
  let map = null;
  let renderSeq = 0;

  AmI18n.storefronts().then((loaded) => { map = loaded; renderValues(); });

  /* ---------- 按钮上的当前值 ---------- */
  async function renderValues() {
    const cc = AmI18n.storefront;
    const outside = AmI18n.regions.length > 0 && !AmI18n.regions.includes(cc);
    for (const node of document.querySelectorAll('[data-setting-value="storefront"]')) {
      node.textContent = `${regionName(cc, map)} · ${cc.toUpperCase()}`;
      node.closest('[data-picker]')?.classList.toggle('is-outside', outside);
    }
    const wrapper = AmWrapper.settings;
    for (const node of document.querySelectorAll('[data-setting-value="wrapper"]')) {
      let host = wrapper.url;
      try { host = new URL(wrapper.url).host; } catch {}
      node.textContent = wrapper.local ? `${t('wrapper.local')} · ${host}` : t('wrapper.server');
    }
    const tag = await AmI18n.catalogLang(cc);
    if (cc !== AmI18n.storefront) return;
    for (const node of document.querySelectorAll('[data-setting-value="ampLang"]')) {
      node.textContent = tag ? langName(tag) : t('settings.default');
    }
  }

  /* ---------- 面板内容 ---------- */
  function option({ label, sub, checked, badge, onPick }) {
    const button = el('button', 'picker-option');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(checked));
    const text = el('span', 'picker-option-text');
    text.append(el('span', 'picker-option-label', label));
    if (sub) text.append(el('span', 'picker-option-sub', sub));
    const check = el('span', 'picker-check');
    check.innerHTML = checked ? CHECK : '';
    button.append(check, text);
    if (badge) button.append(el('span', 'picker-badge', badge));
    button.addEventListener('click', onPick);
    return button;
  }

  function group(label, options, extraClass) {
    const section = el('div', `picker-group${extraClass ? ` ${extraClass}` : ''}`);
    if (label) section.append(el('p', 'picker-group-label', label));
    const list = el('div', 'picker-list');
    list.setAttribute('role', 'radiogroup');
    if (label) list.setAttribute('aria-label', label);
    list.append(...options);
    section.append(list);
    return section;
  }

  function state(text, retry) {
    const node = el('p', 'picker-state', text);
    if (retry) {
      const button = el('button', 'link-btn', t('settings.retry'));
      button.type = 'button';
      button.addEventListener('click', () => { void reload(); });
      node.append(' ', button);
    }
    return node;
  }

  async function reload() {
    map = await AmI18n.storefronts();
    renderValues();
    render();
  }

  const pickStorefront = (cc) => () => { AmI18n.setStorefront(cc); close(true); };
  /** 地区一行：选择按钮；star 为真时右侧加收藏按钮（wrapper-lite 地区总在最前，不需要收藏） */
  function storefrontOption(cc, { badge, star } = {}) {
    const name = regionName(cc, map);
    const button = option({ label: name, sub: cc.toUpperCase(), checked: cc === AmI18n.storefront, badge, onPick: pickStorefront(cc) });
    if (!star) return button;
    const row = el('div', 'picker-row');
    const fav = AmI18n.favorites.includes(cc);
    const toggle = el('button', 'picker-star');
    toggle.type = 'button';
    toggle.dataset.fav = cc;
    toggle.innerHTML = STAR;
    toggle.setAttribute('aria-pressed', String(fav));
    toggle.title = t(fav ? 'settings.unfavorite' : 'settings.favorite', { name });
    toggle.setAttribute('aria-label', toggle.title);
    toggle.addEventListener('click', () => toggleFavorite(cc, toggle));
    row.append(button, toggle);
    return row;
  }

  /** 收藏 / 取消后重绘面板：点的那颗星留在原来的屏幕位置并保持焦点（收藏组多出或少了一行时补偿滚动） */
  function toggleFavorite(cc, star) {
    const inMore = !!star.closest('.picker-more-list');
    const top = star.getBoundingClientRect().top;
    const filterFocused = document.activeElement?.classList.contains('picker-filter');
    AmI18n.toggleFavorite(cc); // 触发 onSettingsChange → render()
    const scope = inMore ? body.querySelector('.picker-more-list') : body;
    const after = scope?.querySelector(`[data-fav="${cc}"]`) || body.querySelector(`[data-fav="${cc}"]`);
    if (after) body.scrollTop += after.getBoundingClientRect().top - top;
    (filterFocused ? body.querySelector('.picker-filter') : after || body.querySelector('.picker-more'))?.focus({ preventScroll: true });
  }

  /** 「更多地区」里的列表：全部地区去掉 wrapper-lite 地区（收藏的也在内），按名称排序，按名称 / 代码 / 英文名筛选 */
  function moreList() {
    const regions = new Set(AmI18n.regions);
    const filter = open.filter.trim().toLowerCase();
    const items = Object.keys(map)
      .filter((cc) => !regions.has(cc))
      .map((cc) => ({ cc, name: regionName(cc, map) }))
      .filter(({ cc, name }) => !filter || cc.includes(filter) || name.toLowerCase().includes(filter) || String(map[cc].name).toLowerCase().includes(filter))
      .sort((a, b) => a.name.localeCompare(b.name, AmI18n.lang === 'zh' ? 'zh-CN' : 'en'));
    return items.length ? group(null, items.map(({ cc }) => storefrontOption(cc, { star: true }))) : state(t('settings.noMatch'));
  }

  function renderStorefront() {
    title.textContent = t('settings.storefront');
    hint.textContent = t('settings.storefrontHint');
    const cc = AmI18n.storefront;
    const regions = AmI18n.regions;
    const favorites = AmI18n.favorites.filter((code) => !regions.includes(code));
    const outsideNote = () => el('p', 'picker-note', t('settings.outside'));
    const parts = [];
    if (regions.length) parts.push(group(t('settings.best'), regions.map((code) => storefrontOption(code, { badge: 'wrapper-lite' }))));
    if (favorites.length) {
      const favGroup = group(t('settings.favorites'), favorites.map((code) => storefrontOption(code, { star: true })));
      if (regions.length && favorites.includes(cc)) favGroup.append(outsideNote());
      parts.push(favGroup);
    }
    if (!regions.includes(cc) && !favorites.includes(cc)) {
      const selected = group(t('settings.selected'), [storefrontOption(cc, { star: true })]);
      if (regions.length) selected.append(outsideNote());
      parts.push(selected);
    }

    const more = el('button', 'picker-more');
    more.type = 'button';
    more.setAttribute('aria-expanded', String(open.expanded));
    more.append(el('span', null, open.expanded ? t('settings.less') : t('settings.more')));
    if (map) more.append(el('span', 'picker-more-count', String(Object.keys(map).filter((code) => !regions.includes(code)).length)));
    const chevron = el('span', 'picker-more-icon');
    chevron.innerHTML = CHEVRON;
    more.append(chevron);
    more.addEventListener('click', () => {
      open.expanded = !open.expanded;
      open.filter = '';
      render();
      // 触屏上不自动聚焦筛选框，免得一展开就弹出输入法挡住列表
      const filter = !coarse.matches && body.querySelector('.picker-filter');
      (filter || body.querySelector('.picker-more'))?.focus({ preventScroll: true });
    });
    parts.push(more);

    if (open.expanded) {
      if (!map) {
        parts.push(state(t('settings.loading')));
        const seq = renderSeq;
        AmI18n.storefronts().then((loaded) => {
          if (seq !== renderSeq || !open) return;
          if (loaded) { map = loaded; renderValues(); render(); } else body.querySelector('.picker-state')?.replaceWith(state(t('settings.failed'), true));
        });
      } else {
        const filter = el('input', 'picker-filter');
        filter.type = 'search';
        filter.placeholder = t('settings.filter');
        filter.setAttribute('aria-label', t('settings.filter'));
        filter.autocomplete = 'off';
        filter.spellcheck = false;
        filter.value = open.filter;
        const holder = el('div', 'picker-more-list');
        holder.append(moreList());
        filter.addEventListener('input', () => {
          open.filter = filter.value;
          holder.replaceChildren(moreList());
        });
        parts.push(filter, holder);
      }
    }
    body.replaceChildren(...parts);
  }

  async function renderAmpLang(seq) {
    const cc = AmI18n.storefront;
    title.textContent = t('settings.ampLang');
    hint.textContent = t('settings.ampLangHint', { storefront: `${regionName(cc, map)} · ${cc.toUpperCase()} ` });
    if (!map) {
      body.replaceChildren(state(t('settings.loading')));
      map = await AmI18n.storefronts();
      if (seq !== renderSeq) return;
      renderValues();
    }
    const sf = map && map[cc];
    if (!sf) {
      body.replaceChildren(state(t('settings.failed'), true));
      return;
    }
    const chosen = AmI18n.ampLang(cc);
    const current = chosen && sf.tags.includes(chosen) ? chosen : sf.default;
    const tags = [sf.default, ...sf.tags.filter((tag) => tag !== sf.default)];
    body.replaceChildren(group(null, tags.map((tag) => option({
      label: langName(tag),
      sub: tag,
      checked: tag === current,
      badge: tag === sf.default ? t('settings.default') : null,
      onPick: () => { void AmI18n.setAmpLang(cc, tag); close(true); },
    }))));
  }

  /** 本地 wrapper-lite 的一项设置 */
  function field(label, input, sub) {
    const row = el('label', 'picker-field');
    row.append(el('span', 'picker-field-label', label), input);
    if (sub) row.append(el('span', 'picker-field-sub', sub));
    return row;
  }

  function renderWrapper() {
    title.textContent = t('settings.wrapper');
    hint.textContent = t('wrapper.hint');
    // 填写中的值（未保存），面板重绘时保留
    const draft = (open.draft ||= AmWrapper.settings);
    const modes = group(null, [
      option({
        label: t('wrapper.server'), sub: t('wrapper.serverSub'), checked: !draft.local,
        onPick: () => { if (AmWrapper.settings.local) AmWrapper.save({ local: false }); close(true); },
      }),
      option({
        label: t('wrapper.local'), sub: t('wrapper.localSub'), checked: draft.local,
        onPick: () => {
          draft.local = true;
          open.result = null;
          render();
          body.querySelector('.picker-input')?.focus({ preventScroll: true });
        },
      }),
    ]);
    if (!draft.local) { body.replaceChildren(modes); return; }

    const input = (type, key, attrs) => {
      const node = el('input', 'picker-filter picker-input');
      node.type = type;
      node.value = draft[key];
      node.spellcheck = false;
      node.autocomplete = 'off';
      Object.assign(node, attrs);
      node.addEventListener('input', () => { draft[key] = node.value; });
      return node;
    };
    const form = el('form', 'picker-form');
    form.noValidate = true;
    form.append(
      field(t('wrapper.url'), input('url', 'url', { placeholder: AmWrapper.DEFAULTS.url })),
      field(t('wrapper.rate'), input('number', 'rate', { min: 0, step: 1, inputMode: 'numeric' }), t('wrapper.zero')),
      field(t('wrapper.concurrency'), input('number', 'concurrency', { min: 0, step: 1, inputMode: 'numeric' }), t('wrapper.zero')),
      field('Authorization', input('password', 'auth', { placeholder: t('wrapper.authPlaceholder') }), t('wrapper.authSub')),
      el('p', 'picker-note', t('wrapper.cors')),
    );
    const save = el('button', 'picker-save', t('wrapper.save'));
    save.type = 'submit';
    form.append(save);
    if (open.result) form.append(el('p', `picker-result ${open.result.className}`, open.result.text));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const current = open;
      const report = (text, className = '') => { current.result = { text, className }; if (open === current) render(); };
      try {
        AmWrapper.save({ ...draft, local: true });
      } catch (error) {
        report(error.message, 'is-error');
        return;
      }
      report(t('wrapper.checking'));
      const status = await checkStatus();
      if (status.ok) report(t('wrapper.ok', { count: status.regions.length }), 'is-ok');
      else report(t('wrapper.failed', { msg: status.error || t('status.down') }), 'is-error');
    });
    body.replaceChildren(modes, form);
  }

  function render() {
    if (!open) return;
    const seq = ++renderSeq;
    if (open.kind === 'storefront') renderStorefront();
    else if (open.kind === 'wrapper') renderWrapper();
    else void renderAmpLang(seq);
  }

  /* ---------- 打开 / 关闭与位置 ---------- */
  function place() {
    if (!open) return;
    picker.classList.toggle('is-sheet', mobile.matches);
    for (const prop of ['left', 'top', 'bottom', 'width', 'max-height']) picker.style.removeProperty(prop);
    if (mobile.matches) return;
    const rect = open.anchor.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 300), innerWidth - 16);
    const above = rect.top - 16;
    const below = innerHeight - rect.bottom - 16;
    // 按钮随页面滚出了屏幕
    if (Math.max(above, below) < 120) { close(false); return; }
    picker.style.width = `${width}px`;
    picker.style.left = `${Math.min(Math.max(rect.left, 8), innerWidth - width - 8)}px`;
    if (below >= above) {
      picker.style.top = `${rect.bottom + 8}px`;
      picker.style.maxHeight = `${below}px`;
    } else {
      picker.style.bottom = `${innerHeight - rect.top + 8}px`;
      picker.style.maxHeight = `${above}px`;
    }
  }

  function show(kind, anchor) {
    if (open) close(false);
    open = { kind, anchor, expanded: false, filter: '' };
    anchor.setAttribute('aria-expanded', 'true');
    picker.hidden = false;
    scrim.hidden = false;
    render();
    place();
    body.scrollTop = 0;
    (body.querySelector('.picker-option[aria-checked="true"]') || picker.querySelector('.picker-close')).focus({ preventScroll: true });
    body.querySelector('.picker-option[aria-checked="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function close(focusAnchor) {
    if (!open) return;
    const { anchor } = open;
    open = null;
    renderSeq++;
    picker.hidden = true;
    scrim.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    if (focusAnchor && anchor.isConnected) anchor.focus({ preventScroll: true });
  }

  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element && event.target.closest('[data-picker]');
    if (!button) return;
    if (open && open.anchor === button) close(true);
    else show(button.dataset.picker, button);
  });
  scrim.addEventListener('click', () => close(false));
  picker.querySelector('.picker-close').addEventListener('click', () => close(true));
  // Esc 只关闭面板，不再传给导航菜单
  picker.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close(true);
  });
  // 只在宽度变化（旋转屏幕 / 拖动窗口）时关闭：手机弹出 / 收起输入法只改变高度，不能因此关掉面板
  let lastWidth = innerWidth;
  addEventListener('resize', () => {
    if (innerWidth !== lastWidth) { lastWidth = innerWidth; close(false); } else place();
  });
  // 页面滚动时跟着按钮移动（导航里的按钮不动）
  addEventListener('scroll', place, { passive: true });
  // 切换页面时按钮可能已被移除
  addEventListener('popstate', () => close(false));

  AmI18n.onChange(() => { renderValues(); render(); });
  AmI18n.onSettingsChange(() => { renderValues(); render(); });
  renderValues();

  return {
    /** wrapper-lite 地区变化后刷新（app.mjs 在 /status 返回后调用） */
    refresh() { renderValues(); render(); },
    /** 页面里新出现的按钮显示当前值 */
    renderValues,
    close,
  };
}

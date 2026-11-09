// 设置中心（/settings），由 app.mjs 挂载，分通用、播放、下载三个标签页（地址的 hash 记住当前页，也可直接指向某个分组）。
// 通用（主地区、曲库语言、界面语言、wrapper-lite、media-user-token）沿用导航底部的选择面板；
// 播放（按 Wi-Fi / 移动数据分别选的音质、全景声优先、JOC 对象渲染、音量）与下载（音质、MV、保存方式、文件名、标签、封面、歌词）
// 保存在 prefs.mjs，修改立即生效（播放音质从下一首起，JOC 的方式正在播放的曲目随之切换，见 player.js；进行中的下载沿用开始时的设置）。
import { prefs, OPTIONS, CODEC_GROUPS, TAG_FIELDS, TAG_NAME, DEFAULTS, DEFAULT_FALLBACK, playbackFor, onNetworkChange } from '../prefs.mjs';
import { formatPath, fitFolder, fitFile, templateIssues, TEMPLATE_VAR_GROUPS, TEMPLATE_SCOPES } from '../naming.mjs';
import { downloads, coverUrl } from '../downloads.mjs';
import { userToken, askToken, onTokenChange } from '../station.mjs';

const { AmI18n, AmDecrypt } = window;
const { t } = AmI18n;

export const bodyClass = 'settings-page';
export const styles = ['/assets/views/settings.css'];

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

const ICON_WIFI = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 16a4.8 4.8 0 0 1 6.4 0"/><circle cx="12" cy="19.3" r="1" fill="currentColor"/></svg>';
const ICON_CELLULAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 20v-3M9.3 20v-6M14.6 20v-9.5M20 20V4"/></svg>';
/** 能否单独调节 <audio> 的音量（iOS Safari 不能，歌曲之间的过渡因此不可用，见 player.js 的 canControlVolume） */
function volumeControllable() {
  try {
    const probe = new Audio();
    probe.volume = 0.5;
    return Math.abs(probe.volume - 0.5) < 0.01;
  } catch {
    return false;
  }
}

/** 封面：常用尺寸挡位，与预览用的一个原图为 jpg 的 artwork 模板 */
const COVER_SIZES = [1400, 3000];
const SAMPLE_ARTWORK = 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/33/fd/32/33fd32b1-0e43-9b4a-8ed6-19643f23544e/21UMGIM26092.rgb.jpg/{w}x{h}bb.{f}';
const ICON_COVER_EMBED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>';
const ICON_COVER_SAVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="3"/><circle cx="9" cy="9" r="1.6"/><path d="m20.5 15-4.5-4.5L5 20.5"/></svg>';

/** 三个标签页，及各页的分组 id（地址的 hash 指向分组时打开其所在的页） */
const TABS = ['general', 'playback', 'download'];

/** 文件名模板的预览：一首虚构的歌 */
const SAMPLE = {
  title: 'Blank Space', artist: 'Taylor Swift', album: "1989 (Taylor's Version)", album_artist: 'Taylor Swift',
  composer: 'Taylor Swift, Max Martin & Shellback', genre: 'Pop', tracknum: 2, tracktotal: 21, disk: 1, disktotal: 1,
  year: '2023', release_date: '2023-10-27', codec: 'ALAC', quality: 'ALAC 24bit 48kHz', bit_depth: 24, sample_rate: 48000,
  sample_rate_kHz: '48', explicit: '', song_id: '1713845737', album_id: '1713845538', artist_id: '159260351',
  isrc: 'USUG12306673', upc: '00602458807400', record_label: 'Taylor Swift', copyright: '℗ 2023 Taylor Swift',
  playlist: "Today's Hits", playlist_id: 'pl.f4d106fed2bd41149aaacabb233eb5eb', curator: 'Apple Music', index: 7,
};

export function mount({ root, signal, onLangChange, toast }) {
  document.title = `${t('set.title')} · am-hook`;
  const host = root.querySelector('#download-body');
  /** 控件：每项设置变化后刷新显示（正在输入的文本框除外） */
  const controls = [];
  let openVars = null;
  let resetArmed = false;

  // 电台的 media-user-token：显示是否已填写（只露出末尾几位），点击修改或清除
  const tokenValue = root.querySelector('#user-token-value');
  const renderToken = () => {
    const token = userToken();
    tokenValue.textContent = token ? t('set.tokenSet', { tail: token.slice(-6) }) : t('set.tokenUnset');
  };
  root.querySelector('#user-token').addEventListener('click', () => askToken());
  signal.addEventListener('abort', onTokenChange(renderToken), { once: true });
  signal.addEventListener('abort', AmI18n.onChange(renderToken), { once: true });
  renderToken();

  const get = () => prefs.get('download');
  const set = (patch) => prefs.set('download', patch);

  /* ---------- 控件 ---------- */
  function row(label, desc, control, { id, wide } = {}) {
    const node = el('div', { className: `set-row${wide ? ' set-row-wide' : ''}` },
      el('span', { className: 'set-label' }, el('span', { textContent: label, id: id ? `${id}-label` : '' }), desc ? el('span', { className: 'set-desc', textContent: desc }) : null),
      el('div', { className: 'set-control' }, control));
    return node;
  }

  /** options：[value, label]，或 [组名, [[value, label]…]] 表示一个 optgroup */
  function select(key, options) {
    const option = ([value, label]) => Array.isArray(label)
      ? el('optgroup', { label: value }, ...label.map(option))
      : el('option', { value: String(value), textContent: label });
    const node = el('select', { className: 'set-select' }, ...options.map(option));
    node.addEventListener('change', () => set({ [key]: typeof DEFAULTS.download[key] === 'number' ? Number(node.value) : node.value }));
    controls.push((v) => { node.value = String(v[key]); });
    return node;
  }

  function toggle(key, label) {
    const input = el('input', { type: 'checkbox', className: 'set-switch-input' });
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => set({ [key]: input.checked }));
    controls.push((v) => { input.checked = !!v[key]; });
    return el('label', { className: 'set-switch' }, input, el('span', { className: 'set-switch-track', ariaHidden: 'true' }));
  }

  function number(key, min, max, label) {
    const input = el('input', { type: 'number', className: 'set-input set-number', min, max, step: 1 });
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      const n = Math.round(Number(input.value));
      if (Number.isFinite(n)) set({ [key]: Math.min(max, Math.max(min, n)) });
      input.value = String(get()[key]);
    });
    controls.push((v) => { if (document.activeElement !== input) input.value = String(v[key]); });
    return input;
  }

  function text(key, placeholder, label, pattern) {
    const input = el('input', { type: 'text', className: 'set-input', placeholder, spellcheck: false, autocomplete: 'off' });
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      const value = input.value.trim();
      if (pattern && value && !pattern.test(value)) { toast(t('set.invalid')); input.value = get()[key]; return; }
      set({ [key]: value });
    });
    controls.push((v) => { if (document.activeElement !== input) input.value = v[key]; });
    return input;
  }

  function segmented(key, options, label) {
    const group = el('div', { className: 'set-segmented', role: 'radiogroup' });
    group.setAttribute('aria-label', label);
    const buttons = options.map(([value, text, disabled]) => {
      const b = el('button', { type: 'button', className: 'set-segment', textContent: text, disabled: !!disabled });
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => set({ [key]: value }));
      group.append(b);
      return [value, b];
    });
    controls.push((v) => { for (const [value, b] of buttons) b.setAttribute('aria-checked', String(v[key] === value)); });
    return group;
  }

  /** 模板可用的变量：按组列出该模板适用的，点击插入到光标处；ID 一组默认收起 */
  function templateVars(key, input) {
    const scope = TEMPLATE_SCOPES[key];
    const chip = (name) => {
      const b = el('button', { type: 'button', className: 'set-var', textContent: `{${name}}`, title: t(`set.var.${name}`) });
      b.addEventListener('mousedown', (e) => e.preventDefault()); // 保留文本框的焦点与光标
      b.addEventListener('click', () => {
        const token = name === 'tracknum' || name === 'index' ? `{${name}:02d}` : `{${name}}`;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        input.setRangeText(token, start, end, 'end');
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new Event('change'));
        input.focus();
      });
      return b;
    };
    const groups = TEMPLATE_VAR_GROUPS.map(([id, names]) => [id, names.filter((name) => scope.includes(name))]).filter(([, names]) => names.length)
      .map(([id, names]) => {
        const chips = el('div', { className: 'set-vars' }, ...names.map(chip));
        if (id === 'id') return el('details', { className: 'set-var-group' }, el('summary', { className: 'set-var-label', textContent: t(`set.varGroup.${id}`) }), chips);
        return el('div', { className: 'set-var-group' }, el('span', { className: 'set-var-label', textContent: t(`set.varGroup.${id}`) }), chips);
      });
    return el('div', { className: 'set-var-panel', hidden: true }, ...groups, el('span', { className: 'set-desc', textContent: t('set.varsDesc') }));
  }

  // 预览与实际下载一致：按路径长度限制截断后的结果（文件名按其所在的专辑 / 歌单文件夹计算）
  function template(key, label, kind, folderKey) {
    const input = el('input', { type: 'text', className: 'set-input set-template', spellcheck: false, autocomplete: 'off' });
    input.setAttribute('aria-label', label);
    const preview = el('div', { className: 'set-preview' });
    const warn = el('div', { className: 'set-template-warn', hidden: true });
    const vars = templateVars(key, input);
    let saved = {};
    const update = () => {
      const value = input.value.trim() || DEFAULTS.download[key];
      const folder = () => fitFolder(formatPath(saved[folderKey] || DEFAULTS.download[folderKey], SAMPLE));
      const path = kind === 'file' ? fitFile(folder(), formatPath(value, SAMPLE)) : fitFolder(formatPath(value, SAMPLE));
      preview.textContent = kind === 'file' ? `${path.join('/')}.m4a` : kind === 'zip' ? `${path.join(' - ')}.zip  ·  ${path.join('/')}/` : path.join('/');
      const { unknown, outside } = templateIssues(key, value);
      const names = (list) => list.map((name) => `{${name}}`).join(' ');
      warn.replaceChildren(...[
        unknown.length && t('set.varUnknown', { names: names(unknown) }),
        outside.length && t('set.varOutside', { names: names(outside) }),
      ].filter(Boolean).map((text) => el('div', { textContent: text })));
      warn.hidden = !warn.childElementCount;
    };
    // 同一时间只展开一个模板的变量：最近获得焦点的那个
    input.addEventListener('focus', () => {
      if (openVars && openVars !== vars) openVars.hidden = true;
      vars.hidden = false;
      openVars = vars;
    });
    input.addEventListener('input', update);
    input.addEventListener('change', () => { set({ [key]: input.value.trim() || DEFAULTS.download[key] }); });
    controls.push((v) => { saved = v; if (document.activeElement !== input) input.value = v[key]; update(); });
    const reset = el('button', { type: 'button', className: 'set-mini', textContent: t('set.default'), title: DEFAULTS.download[key] });
    reset.addEventListener('click', () => { input.value = DEFAULTS.download[key]; set({ [key]: DEFAULTS.download[key] }); });
    return el('div', { className: 'set-template-box' }, el('div', { className: 'set-template-line' }, input, reset), vars, preview, warn);
  }

  /** 降级顺序：当前首选音质之后依次尝试的音质，可上移、下移、移除、添加；按首选音质分别保存 */
  function fallbackOrder() {
    const list = el('ol', { className: 'set-chain' });
    const add = el('select', { className: 'set-select set-chain-add' });
    add.setAttribute('aria-label', t('set.fallbackAdd'));
    const reset = el('button', { type: 'button', className: 'set-mini', textContent: t('set.default') });
    const chain = (v) => (Array.isArray(v.fallbackOrder[v.codec]) ? v.fallbackOrder[v.codec] : DEFAULT_FALLBACK[v.codec] || []);
    const save = (next) => {
      const v = get();
      set({ fallbackOrder: { ...v.fallbackOrder, [v.codec]: next } });
    };
    const mini = (text, label, disabled, fn) => {
      const b = el('button', { type: 'button', className: 'set-mini set-chain-btn', textContent: text, title: label, disabled });
      b.setAttribute('aria-label', label);
      b.addEventListener('click', fn);
      return b;
    };
    add.addEventListener('change', () => { if (add.value) save([...chain(get()), add.value]); });
    reset.addEventListener('click', () => {
      const v = get();
      const { [v.codec]: _, ...rest } = v.fallbackOrder;
      set({ fallbackOrder: rest });
    });
    controls.push((v) => {
      const items = chain(v);
      const move = (i, d) => {
        const next = [...items];
        [next[i], next[i + d]] = [next[i + d], next[i]];
        save(next);
      };
      list.replaceChildren(
        el('li', { className: 'set-chain-item is-first' },
          el('span', { className: 'set-chain-tag', textContent: t('set.fallbackFirst') }),
          el('span', { className: 'set-chain-name', textContent: t(`set.codec.${v.codec}`) })),
        ...items.map((c, i) => el('li', { className: 'set-chain-item' },
          el('span', { className: 'set-chain-tag', textContent: String(i + 1) }),
          el('span', { className: 'set-chain-name', textContent: t(`set.codec.${c}`) }),
          mini('↑', t('set.fallbackUp'), i === 0, () => move(i, -1)),
          mini('↓', t('set.fallbackDown'), i === items.length - 1, () => move(i, 1)),
          mini('✕', t('set.fallbackRemove'), false, () => save(items.filter((x) => x !== c))))),
        ...(items.length ? [] : [el('li', { className: 'set-chain-empty', textContent: t('set.fallbackEmpty') })]));
      // 添加：其余音质按首选音质下拉框的分组列出
      const rest = (c) => c !== v.codec && !items.includes(c);
      add.replaceChildren(el('option', { value: '', textContent: t('set.fallbackAdd') }),
        ...CODEC_GROUPS.filter(([, codecs]) => codecs.some(rest)).map(([group, codecs]) => el('optgroup', { label: t(`set.codecGroup.${group}`) },
          ...codecs.filter(rest).map((c) => el('option', { value: c, textContent: t(`set.codec.${c}`) })))));
      add.value = '';
      add.disabled = !OPTIONS.download.codec.some(rest);
      reset.disabled = !Array.isArray(v.fallbackOrder[v.codec]);
    });
    return el('div', { className: 'set-chain-box' }, list, el('div', { className: 'set-mini-row' }, add, reset));
  }

  /** 封面卡片：标题行带开关，关闭时收起；格式与尺寸为分段按钮（尺寸含常用挡位、原图与自定义），底部预览请求的地址结尾 */
  function coverPanel({ kind, icon, on, setOn, format, size, original, warn }) {
    const title = t(`set.cover.${kind}`);
    const input = el('input', { type: 'checkbox', className: 'set-switch-input' });
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', title);
    input.addEventListener('change', () => setOn(input.checked));
    const head = el('label', { className: 'set-cover-head' },
      el('span', { className: 'set-cover-icon', innerHTML: icon, ariaHidden: 'true' }),
      el('span', { className: 'set-label' }, el('span', { textContent: title }), el('span', { className: 'set-desc', textContent: t(`set.cover.${kind}Desc`) })),
      el('span', { className: 'set-switch' }, input, el('span', { className: 'set-switch-track', ariaHidden: 'true' })));

    const formats = segmented(format, OPTIONS.download.coverFormat.map((f) => [f, t(`set.coverFormat.${f}`)]), t('set.cover.format'));

    // 尺寸：挡位 / 原图 / 自定义（选自定义或尺寸不是挡位时露出数字框）
    let custom = false;
    const pick = (value) => {
      custom = value === 'custom';
      if (value === 'original') set({ [original]: true });
      else if (custom) { set({ [original]: false }); requestAnimationFrame(() => { px.focus(); px.select(); }); }
      else set({ [original]: false, [size]: value });
    };
    const [sizes, syncSizes] = radios(t('set.cover.size'),
      [...COVER_SIZES.map((n) => [n, String(n)]), ['original', t('set.cover.original')], ['custom', t('set.cover.custom')]], pick);
    const px = number(size, 100, 10000, t('set.cover.size'));
    const pxBox = el('span', { className: 'set-unit-box set-cover-px' }, px, el('span', { className: 'set-unit', textContent: 'px' }));

    const url = el('code', { className: 'set-cover-url' });
    const spec = el('span', { className: 'set-cover-spec' });
    const note = warn ? el('span', { className: 'set-cover-warn', textContent: t('set.cover.embedWarn') }) : null;
    const field = (key, ...control) => el('div', { className: 'set-cover-field' },
      el('span', { className: 'set-cover-key', textContent: t(key) }), el('div', { className: 'set-cover-value' }, ...control));
    const body = el('div', { className: 'set-cover-body' },
      field('set.cover.format', formats),
      field('set.cover.size', sizes, pxBox),
      el('div', { className: 'set-cover-preview' }, url, spec),
      note);
    const panel = el('div', { className: `set-cover is-${kind}` }, head, body);

    controls.push((v) => {
      const enabled = on(v);
      input.checked = enabled;
      panel.classList.toggle('is-off', !enabled);
      body.hidden = !enabled;
      if (!COVER_SIZES.includes(v[size])) custom = true;
      const current = v[original] ? 'original' : custom ? 'custom' : v[size];
      syncSizes(current);
      pxBox.hidden = current !== 'custom';
      url.textContent = coverUrl(SAMPLE_ARTWORK, v[format], v[original] ? 'original' : v[size]).split('/').pop();
      spec.textContent = `${v[original] ? t('set.cover.originalSize') : `${v[size]} × ${v[size]}`} · ${t(`set.cover.spec.${v[format]}`)}`;
      if (note) note.hidden = !warn(v);
    });
    return panel;
  }

  function section(id, titleKey, ...rows) {
    return el('section', { className: 'set-group', id }, el('h2', { className: 'set-group-title', textContent: t(titleKey) }), el('div', { className: 'set-card' }, ...rows));
  }

  /* ---------- 播放：prefs 的 playback（音质、全景声优先）与 joc（对象渲染、音量）分组，修改立即生效（app.mjs） ---------- */
  const playback = root.querySelector('#playback');
  const playControls = [];
  const setPlay = (patch) => prefs.set('playback', patch);
  const setJoc = (patch) => prefs.set('joc', patch);
  let playResetArmed = false;

  /** 单选按钮组（分段样式）：options 为 [value, label]，onPick(value)；返回 [节点, 同步函数] */
  function radios(label, options, onPick) {
    const group = el('div', { className: 'set-segmented', role: 'radiogroup' });
    group.setAttribute('aria-label', label);
    const buttons = options.map(([value, text]) => {
      const b = el('button', { type: 'button', className: 'set-segment', textContent: text });
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => onPick(value));
      group.append(b);
      return [value, b];
    });
    return [group, (current) => { for (const [value, b] of buttons) b.setAttribute('aria-checked', String(current === value)); }];
  }

  /** 音质卡片：四个挡位，每个写明格式与每分钟大约的流量 */
  function qualityPicker(key, label) {
    const group = el('div', { className: 'set-tiers', role: 'radiogroup' });
    group.setAttribute('aria-label', label);
    const cards = OPTIONS.playback.quality.map((tier) => {
      const b = el('button', { type: 'button', className: `set-tier is-${tier}` },
        el('span', { className: 'set-tier-name', textContent: t(`set.tier.${tier}`) }),
        el('span', { className: 'set-tier-spec', textContent: t(`set.tier.${tier}Spec`) }),
        el('span', { className: 'set-tier-data', textContent: t(`set.tier.${tier}Data`) }));
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => setPlay({ [key]: tier }));
      group.append(b);
      return [tier, b];
    });
    playControls.push(({ play }) => { for (const [tier, b] of cards) b.setAttribute('aria-checked', String(play[key] === tier)); });
    return group;
  }

  function dbInput(label, min, field) {
    const input = el('input', { type: 'number', className: 'set-input set-number', min, max: 0, step: 1 });
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      const n = Math.round(Number(input.value));
      if (Number.isFinite(n)) setJoc({ [field]: Math.min(0, Math.max(min, n)) });
      input.value = String(prefs.get('joc')[field]);
    });
    playControls.push(({ joc }) => { if (document.activeElement !== input) input.value = String(joc[field]); });
    return el('div', { className: 'set-unit-box' }, input, el('span', { className: 'set-unit', textContent: 'dB' }));
  }

  function renderPlayback() {
    playControls.length = 0;

    // 音质：Wi-Fi 与移动数据分别设置，标出当前网络用的是哪一个
    const networkNote = el('div', { className: 'set-network' });
    const networkRow = (kind, icon) => {
      const badge = el('span', { className: 'set-badge', textContent: t('set.networkNow') });
      const node = row(t(`set.net.${kind}`), t(`set.net.${kind}Desc`), qualityPicker(kind, t(`set.net.${kind}`)), { wide: true });
      node.querySelector('.set-label > span').prepend(el('span', { className: 'set-net-icon', innerHTML: icon, ariaHidden: 'true' }));
      node.querySelector('.set-label > span').append(badge);
      playControls.push(({ live }) => { badge.hidden = (live.network === 'cellular' ? 'cellular' : 'wifi') !== kind; });
      return node;
    };
    playControls.push(({ live }) => {
      networkNote.textContent = t(live.network ? 'set.networkDetected' : 'set.networkUnknown', { name: t(`set.net.${live.network || 'wifi'}`) });
    });
    const quality = section('play-quality', 'set.playQuality',
      networkRow('wifi', ICON_WIFI),
      networkRow('cellular', ICON_CELLULAR),
      el('div', { className: 'set-row set-row-note' }, networkNote, el('span', { className: 'set-desc', textContent: t('set.playQualityNote') })));

    // 歌曲之间的过渡（player.js 的 Mixer）：关闭 / AutoMix / 交叉淡化，交叉淡化可选时长；浏览器不能调节 <audio> 音量时不可用
    const [transition, syncTransition] = radios(t('set.transitionMode'),
      OPTIONS.playback.transition.map((v) => [v, t(`set.transition.${v}`)]), (v) => setPlay({ transition: v }));
    const transitionRow = row(t('set.transitionMode'), '', transition, { wide: true });
    const transitionDesc = transitionRow.querySelector('.set-label').appendChild(el('span', { className: 'set-desc' }));
    const seconds = el('input', { type: 'number', className: 'set-input set-number', min: 1, max: 12, step: 1 });
    seconds.setAttribute('aria-label', t('set.crossfade'));
    seconds.addEventListener('change', () => {
      const n = Math.round(Number(seconds.value));
      if (Number.isFinite(n)) setPlay({ crossfade: Math.min(12, Math.max(1, n)) });
      seconds.value = String(prefs.get('playback').crossfade);
    });
    const secondsRow = row(t('set.crossfade'), t('set.crossfadeDesc'),
      el('div', { className: 'set-unit-box' }, seconds, el('span', { className: 'set-unit', textContent: 's' })));
    const transitionNote = el('div', { className: 'set-row set-row-note' },
      el('span', { className: 'set-desc', textContent: volumeControllable() ? t('set.transitionAlbum') : t('set.transitionUnsupported') }));
    playControls.push(({ play }) => {
      syncTransition(play.transition);
      transitionDesc.textContent = t(`set.transitionDesc.${play.transition}`);
      secondsRow.hidden = play.transition !== 'crossfade';
      if (document.activeElement !== seconds) seconds.value = String(play.crossfade);
    });
    const transitions = section('transition', 'set.transition', transitionRow, secondsRow, transitionNote);

    // 空间音频：全景声是否优先，以及 E-AC-3 的渲染方式（JOC）
    const [spatial, syncSpatial] = radios(t('set.spatial'), OPTIONS.playback.spatial.map((v) => [v, t(`set.spatial.${v}`)]), (v) => setPlay({ spatial: v }));
    const spatialRow = row(t('set.spatial'), '', spatial);
    const spatialDesc = spatialRow.querySelector('.set-label').appendChild(el('span', { className: 'set-desc' }));
    playControls.push(({ play, live, joc }) => {
      syncSpatial(play.spatial);
      const key = play.spatial === 'auto' ? (joc.mode !== 'off' ? 'autoOn' : 'autoOff') : play.spatial;
      spatialDesc.textContent = t(`set.spatialDesc.${key}`) + (live.quality === 'efficient' && play.spatial !== 'off' ? ` ${t('set.spatialEfficient')}` : '');
    });

    const [mode, syncMode] = radios(t('set.jocMode'), OPTIONS.joc.mode.map((v) => [v, t(`set.joc.${v}`)]), (v) => setJoc({ mode: v }));
    playControls.push(({ joc }) => syncMode(joc.mode));

    // HRTF：SADIE II 数据库的 20 位受试者，网站上有每位的头型与耳型照片
    const dataset = el('select', { className: 'set-select' }, ...OPTIONS.joc.dataset.map((name) => el('option', { value: name, textContent: name })));
    dataset.setAttribute('aria-label', t('set.jocDataset'));
    dataset.addEventListener('change', () => setJoc({ dataset: dataset.value }));
    const datasetRow = row(t('set.jocDataset'), t('set.jocDatasetDesc'), dataset);
    datasetRow.querySelector('.set-desc').append(' ', el('a', {
      href: 'https://www.york.ac.uk/sadie-project/database.html', target: '_blank', rel: 'noopener noreferrer', textContent: t('set.jocDatasetLink'),
    }));
    const gainRow = row(t('set.jocGain'), t('set.jocGainDesc'), dbInput(t('set.jocGain'), -60, 'gain'));
    playControls.push(({ joc }) => {
      dataset.value = joc.dataset;
      datasetRow.hidden = joc.mode !== 'binaural';
      gainRow.hidden = joc.mode === 'off';
    });
    const spatialSection = section('spatial', 'set.spatialSection',
      spatialRow, row(t('set.joc'), t('set.jocModeDesc'), mode, { wide: true }), datasetRow, gainRow);

    // ALAC / AAC 的音量补偿：与 JOC 开关无关（浏览器自己解码的全景声同样比立体声母带小声）
    const volume = section('volume', 'set.volume',
      row(t('set.stereoGain'), t('set.stereoGainDesc'), dbInput(t('set.stereoGain'), -20, 'stereoGain')));

    const reset = el('button', { type: 'button', className: 'set-btn set-btn-danger', textContent: t('set.playReset') });
    reset.addEventListener('click', () => {
      if (!playResetArmed) {
        playResetArmed = true;
        reset.textContent = t('set.resetConfirm');
        setTimeout(() => { playResetArmed = false; if (reset.isConnected) reset.textContent = t('set.playReset'); }, 4000);
        return;
      }
      playResetArmed = false;
      prefs.reset('playback');
      prefs.reset('joc');
      toast(t('set.resetDone'));
    });

    playback.replaceChildren(quality, transitions, spatialSection, volume, el('div', { className: 'set-footer' }, reset));
    syncPlayback();
  }

  function syncPlayback() {
    const play = prefs.get('playback');
    const state = { play, joc: prefs.get('joc'), live: playbackFor(play) };
    for (const fn of playControls) fn(state);
  }
  signal.addEventListener('abort', onNetworkChange(syncPlayback), { once: true });

  /* ---------- 各分组 ---------- */
  function render() {
    controls.length = 0;
    const o = OPTIONS.download;
    const opfs = AmDecrypt.opfsSupported();

    // 检测结果的标签名：清空时恢复默认
    const tagNameRow = row(t('set.alacCheckTagName'), t('set.alacCheckTagNameDesc'), text('alacCheckTagName', DEFAULTS.download.alacCheckTagName, t('set.alacCheckTagName'), TAG_NAME));
    const orderRow = row(t('set.fallbackOrder'), t('set.fallbackOrderDesc'), fallbackOrder(), { wide: true });
    controls.push((v) => { orderRow.hidden = !v.fallback; });
    const quality = section('quality', 'set.quality',
      row(t('set.codec'), t('set.codecDesc'), select('codec', CODEC_GROUPS.map(([group, list]) => [t(`set.codecGroup.${group}`), list.map((c) => [c, t(`set.codec.${c}`)])]))),
      row(t('set.alacMax'), t('set.alacMaxDesc'), select('alacMax', o.alacMax.map((n) => [n, `${n / 1000} kHz`]))),
      row(t('set.atmosMax'), t('set.atmosMaxDesc'), select('atmosMax', o.atmosMax.map((n) => [n, `${n} (${n % 1000} kbps)`]))),
      row(t('set.fallback'), t('set.fallbackDesc'), toggle('fallback', t('set.fallback'))),
      orderRow,
      row(t('set.alacRepair'), t('set.alacRepairDesc'), toggle('alacRepair', t('set.alacRepair'))),
      row(t('set.alacCheckTag'), t('set.alacCheckTagDesc'), toggle('alacCheckTag', t('set.alacCheckTag'))),
      tagNameRow);
    controls.push((v) => { tagNameRow.hidden = !v.alacCheckTag; });

    // MV（专辑、歌单中的，以及「更多」菜单里单独下载的）：同参考实现的 mv-max 与 mv-audio-type
    const mv = section('mv', 'set.mvSection',
      row(t('set.mv'), opfs ? t('set.mvDesc') : t('set.mvNoOpfs'), toggle('mv', t('set.mv'))),
      row(t('set.mvMax'), t('set.mvMaxDesc'), select('mvMax', o.mvMax.map((n) => [n, { 2160: '2160p (4K)', 1440: '1440p (2K)' }[n] || `${n}p`]))),
      row(t('set.mvAudio'), t('set.mvAudioDesc'), select('mvAudio', o.mvAudio.map((a) => [a, t(`set.mvAudio.${a}`)]))));

    const performance = section('performance', 'set.performance',
      row(t('set.concurrency'), t('set.concurrencyDesc'), number('concurrency', 1, 6, t('set.concurrency'))),
      row(t('set.retries'), t('set.retriesDesc'), number('retries', 0, 5, t('set.retries'))),
      row(t('set.opfs'), opfs ? t('set.opfsDesc') : t('set.opfsUnsupported'), toggle('opfs', t('set.opfs'))));

    // 保存方式：文件夹需要 File System Access API（Chrome / Edge 桌面版）
    const folderName = el('span', { className: 'set-folder-name' });
    const pick = el('button', { type: 'button', className: 'set-btn' });
    pick.addEventListener('click', async () => {
      try { await downloads.folder.pick(); syncFolder(); } catch (err) { if (err && err.name !== 'AbortError') toast(err.message); }
    });
    const forget = el('button', { type: 'button', className: 'set-btn set-btn-plain', textContent: t('set.folderForget') });
    forget.addEventListener('click', async () => { await downloads.folder.forget(); syncFolder(); });
    function syncFolder() {
      const name = downloads.folder.name();
      folderName.textContent = name || t('set.folderNone');
      folderName.classList.toggle('is-empty', !name);
      pick.textContent = t(name ? 'set.folderChange' : 'set.folderPick');
      forget.hidden = !name;
    }
    downloads.folder.ready.then(syncFolder);
    syncFolder();
    const folderRow = row(t('set.folder'), t('set.folderDesc'), el('div', { className: 'set-folder' }, folderName, pick, forget));
    const skipRow = row(t('set.skipExisting'), t('set.skipExistingDesc'), toggle('skipExisting', t('set.skipExisting')));
    const save = section('save', 'set.save',
      row(t('set.saveMode'), downloads.folder.supported ? t('set.saveModeDesc') : t('set.saveModeNoFolder'), segmented('saveMode', [
        ['zip', t('set.mode.zip')], ['folder', t('set.mode.folder'), !downloads.folder.supported], ['files', t('set.mode.files')],
      ], t('set.saveMode')), { wide: true }),
      folderRow, skipRow,
      row(t('set.m3u'), t('set.m3uDesc'), toggle('m3u', t('set.m3u'))));
    controls.push((v) => {
      const folder = v.saveMode === 'folder' && downloads.folder.supported;
      folderRow.hidden = !folder;
      skipRow.hidden = !folder;
    });

    // 文件名：模板 + 可用变量 + 预览
    const naming = section('naming', 'set.naming',
      row(t('set.albumFolder'), t('set.albumFolderDesc'), template('albumFolder', t('set.albumFolder'), 'zip'), { wide: true }),
      row(t('set.songFile'), t('set.songFileDesc'), template('songFile', t('set.songFile'), 'file', 'albumFolder'), { wide: true }),
      row(t('set.playlistFolder'), '', template('playlistFolder', t('set.playlistFolder'), 'zip'), { wide: true }),
      row(t('set.playlistFile'), '', template('playlistFile', t('set.playlistFile'), 'file', 'playlistFolder'), { wide: true }),
      row(t('set.singleFile'), t('set.singleFileDesc'), template('singleFile', t('set.singleFile'), 'file', 'albumFolder'), { wide: true }));

    // 标签：嵌入字段
    const checks = TAG_FIELDS.map((field) => {
      const input = el('input', { type: 'checkbox' });
      input.addEventListener('change', () => {
        const embed = new Set(get().embed);
        if (input.checked) embed.add(field); else embed.delete(field);
        set({ embed: [...embed] });
      });
      controls.push((v) => { input.checked = v.embed.includes(field); });
      return el('label', { className: 'set-check' }, input, el('span', { textContent: t(`set.field.${field}`) }));
    });
    const all = el('button', { type: 'button', className: 'set-mini', textContent: t('set.all') });
    all.addEventListener('click', () => set({ embed: [...TAG_FIELDS] }));
    const none = el('button', { type: 'button', className: 'set-mini', textContent: t('set.none') });
    none.addEventListener('click', () => set({ embed: [] }));
    const tags = section('tags', 'set.tags',
      el('div', { className: 'set-row set-row-wide' },
        el('span', { className: 'set-label' }, el('span', { textContent: t('set.embed') }), el('span', { className: 'set-desc', textContent: t('set.embedDesc') })),
        el('div', { className: 'set-control set-checks-box' }, el('div', { className: 'set-checks' }, ...checks), el('div', { className: 'set-mini-row' }, all, none))),
      row(t('set.sortTags'), t('set.sortTagsDesc'), toggle('sortTags', t('set.sortTags'))),
      row(t('set.playlistAlbumInfo'), t('set.playlistAlbumInfoDesc'), toggle('playlistAlbumInfo', t('set.playlistAlbumInfo'))),
      row(t('set.metaLang'), t('set.metaLangDesc'), text('metaLang', t('set.followCatalog'), t('set.metaLang'), /^[A-Za-z0-9-]{1,35}$/)));

    // 封面：「嵌入到歌曲」与「另存为文件」两张卡片，各自一个开关（嵌入的开关即「标签」里的封面勾选）、格式、尺寸，
    // 底部预览实际请求的地址结尾（如 3000x3000bb-100.jpg）
    const embedCover = coverPanel({
      kind: 'embed', icon: ICON_COVER_EMBED,
      on: (v) => v.embed.includes('cover'),
      setOn: (on) => set({ embed: TAG_FIELDS.filter((f) => (f === 'cover' ? on : get().embed.includes(f))) }),
      format: 'coverFormat', size: 'coverSize', original: 'coverOriginal',
      // 每首歌都带一份：PNG 或原图尺寸时提醒体积
      warn: (v) => v.coverOriginal || v.coverFormat !== 'jpg',
    });
    const saveCover = coverPanel({
      kind: 'save', icon: ICON_COVER_SAVE,
      on: (v) => v.saveCover, setOn: (on) => set({ saveCover: on }),
      format: 'saveCoverFormat', size: 'saveCoverSize', original: 'saveCoverOriginal',
    });
    const cover = section('cover', 'set.cover', el('div', { className: 'set-covers' }, embedCover, saveCover));

    const lyrics = section('lyrics', 'set.lyrics',
      row(t('set.saveLyrics'), t('set.saveLyricsDesc'), toggle('saveLyrics', t('set.saveLyrics'))),
      row(t('set.lyricsFormat'), t('set.lyricsFormatDesc'), select('lyricsFormat', o.lyricsFormat.map((f) => [f, `.${f}`]))),
      row(t('set.syllable'), t('set.syllableDesc'), toggle('syllable', t('set.syllable'))),
      row(t('set.lyricsTranslation'), t('set.lyricsTranslationDesc'), toggle('lyricsTranslation', t('set.lyricsTranslation'))),
      row(t('set.lyricsPronunciation'), t('set.lyricsPronunciationDesc'), toggle('lyricsPronunciation', t('set.lyricsPronunciation'))),
      row(t('set.lyricsLang'), t('set.lyricsLangDesc'), text('lyricsLang', t('set.followMeta'), t('set.lyricsLang'), /^[A-Za-z0-9-]{1,35}$/)));

    const reset = el('button', { type: 'button', className: 'set-btn set-btn-danger', textContent: t('set.reset') });
    reset.addEventListener('click', () => {
      if (!resetArmed) {
        resetArmed = true;
        reset.textContent = t('set.resetConfirm');
        setTimeout(() => { resetArmed = false; if (reset.isConnected) reset.textContent = t('set.reset'); }, 4000);
        return;
      }
      resetArmed = false;
      prefs.reset('download');
      toast(t('set.resetDone'));
      render();
    });
    const center = el('button', { type: 'button', className: 'set-btn', textContent: t('set.openCenter') });
    center.addEventListener('click', () => window.AmApp.downloads.open());
    center.hidden = !downloads.jobs.length;
    const footer = el('div', { className: 'set-footer' }, center, reset);

    host.replaceChildren(quality, mv, performance, save, naming, tags, cover, lyrics, footer);

    // 下载页的分组目录
    const groups = [['quality', 'set.quality'], ['mv', 'set.mvSection'], ['performance', 'set.performance'], ['save', 'set.save'], ['naming', 'set.naming'], ['tags', 'set.tags'], ['cover', 'set.cover'], ['lyrics', 'set.lyrics']];
    root.querySelector('#toc').replaceChildren(...groups.map(([id, key]) => {
      const a = el('a', { href: `#${id}`, className: 'set-toc-link', textContent: t(key) });
      a.addEventListener('click', (e) => { e.preventDefault(); showTab('download', id); });
      return a;
    }));
    sync();
  }

  function sync() {
    const v = get();
    for (const fn of controls) fn(v);
  }

  /* ---------- 标签页：hash 为标签页或分组的 id；切换时只改 hash（replaceState，不进历史记录） ---------- */
  const tabs = [...root.querySelectorAll('[data-tab]')];
  function showTab(name, focusId = null, { scroll = true } = {}) {
    for (const tab of tabs) {
      const on = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      root.querySelector(`#${tab.dataset.tab}`).hidden = !on;
    }
    const hash = `#${focusId || name}`;
    if (location.hash !== hash) history.replaceState(history.state, '', location.pathname + location.search + hash);
    if (!scroll) return;
    const target = focusId && root.querySelector(`#${CSS.escape(focusId)}`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else window.scrollTo({ top: 0 });
  }
  /** hash 对应的 [标签页, 分组 id]；不认识的 hash 打开通用页 */
  function fromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (TABS.includes(id)) return [id, null];
    const target = id && /^[\w-]+$/.test(id) && root.querySelector(`#${id}`);
    const panel = target && target.closest('.set-panel');
    return panel ? [panel.id, id] : ['general', null];
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
    // 方向键在标签之间移动（WAI-ARIA 标签页的键盘操作）
    tab.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(tab);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      const target = tabs[(next + tabs.length) % tabs.length];
      target.focus();
      showTab(target.dataset.tab);
    });
  }
  addEventListener('hashchange', () => { const [tab, id] = fromHash(); showTab(tab, id); }, { signal });

  const off = prefs.onChange((section) => {
    if (section === 'download') sync();
    if (section === 'joc' || section === 'playback') syncPlayback();
  });
  signal.addEventListener('abort', off, { once: true });
  const offDl = downloads.onChange(() => {
    const center = host.querySelector('.set-footer .set-btn:not(.set-btn-danger)');
    if (center) center.hidden = !downloads.jobs.length;
  });
  signal.addEventListener('abort', offDl, { once: true });
  onLangChange(() => { document.title = `${t('set.title')} · am-hook`; renderPlayback(); render(); });
  renderPlayback();
  render();
  {
    const [tab, id] = fromHash();
    showTab(tab, id, { scroll: !!id });
  }
}

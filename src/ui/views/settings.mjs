// 设置中心（/settings），由 app.mjs 挂载。通用设置（主地区、曲库语言、界面语言、wrapper-lite）沿用导航底部的选择面板；
// JOC 对象渲染（Dolby Atmos 的播放方式）与下载设置（音质、MV、保存方式、文件名、标签、封面、歌词）保存在 prefs.mjs，
// 修改立即生效（正在播放的曲目随之切换，见 player.js 的 jocChanged；进行中的下载沿用开始时的设置）。
import { prefs, OPTIONS, CODEC_GROUPS, TAG_FIELDS, TAG_NAME, DEFAULTS, DEFAULT_FALLBACK } from '../prefs.mjs';
import { formatPath, fitFolder, fitFile, templateIssues, TEMPLATE_VAR_GROUPS, TEMPLATE_SCOPES } from '../naming.mjs';
import { downloads } from '../downloads.mjs';
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
  const host = root.querySelector('#download');
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

  function section(id, titleKey, ...rows) {
    return el('section', { className: 'set-group', id }, el('h2', { className: 'set-group-title', textContent: t(titleKey) }), el('div', { className: 'set-card' }, ...rows));
  }

  /* ---------- JOC 对象渲染：prefs 的 joc 分组，正在播放的 E-AC-3 曲目随之切换（app.mjs） ---------- */
  const playback = root.querySelector('#playback');
  const jocControls = [];
  const setJoc = (patch) => prefs.set('joc', patch);

  function renderJoc() {
    jocControls.length = 0;
    const mode = el('div', { className: 'set-segmented', role: 'radiogroup' });
    mode.setAttribute('aria-label', t('set.jocMode'));
    const modes = OPTIONS.joc.mode.map((value) => {
      const b = el('button', { type: 'button', className: 'set-segment', textContent: t(`set.joc.${value}`) });
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => setJoc({ mode: value }));
      mode.append(b);
      return [value, b];
    });
    jocControls.push((v) => { for (const [value, b] of modes) b.setAttribute('aria-checked', String(v.mode === value)); });

    // HRTF：SADIE II 数据库的 20 位受试者，网站上有每位的头型与耳型照片
    const dataset = el('select', { className: 'set-select' }, ...OPTIONS.joc.dataset.map((name) => el('option', { value: name, textContent: name })));
    dataset.setAttribute('aria-label', t('set.jocDataset'));
    dataset.addEventListener('change', () => setJoc({ dataset: dataset.value }));
    const datasetRow = row(t('set.jocDataset'), t('set.jocDatasetDesc'), dataset);
    datasetRow.querySelector('.set-desc').append(' ', el('a', {
      href: 'https://www.york.ac.uk/sadie-project/database.html', target: '_blank', rel: 'noopener noreferrer', textContent: t('set.jocDatasetLink'),
    }));
    jocControls.push((v) => { dataset.value = v.dataset; datasetRow.hidden = v.mode !== 'binaural'; });

    const gain = el('input', { type: 'number', className: 'set-input set-number', min: -60, max: 0, step: 1 });
    gain.setAttribute('aria-label', t('set.jocGain'));
    gain.addEventListener('change', () => {
      const n = Math.round(Number(gain.value));
      if (Number.isFinite(n)) setJoc({ gain: Math.min(0, Math.max(-60, n)) });
      gain.value = String(prefs.get('joc').gain);
    });
    const gainRow = row(t('set.jocGain'), t('set.jocGainDesc'), el('div', { className: 'set-unit-box' }, gain, el('span', { className: 'set-unit', textContent: 'dB' })));
    jocControls.push((v) => {
      if (document.activeElement !== gain) gain.value = String(v.gain);
      gainRow.hidden = v.mode === 'off';
    });

    // ALAC / AAC 的音量补偿：与 JOC 开关无关（浏览器自己解码的全景声同样比立体声母带小声）
    const stereoGain = el('input', { type: 'number', className: 'set-input set-number', min: -20, max: 0, step: 1 });
    stereoGain.setAttribute('aria-label', t('set.stereoGain'));
    stereoGain.addEventListener('change', () => {
      const n = Math.round(Number(stereoGain.value));
      if (Number.isFinite(n)) setJoc({ stereoGain: Math.min(0, Math.max(-20, n)) });
      stereoGain.value = String(prefs.get('joc').stereoGain);
    });
    const stereoGainRow = row(t('set.stereoGain'), t('set.stereoGainDesc'), el('div', { className: 'set-unit-box' }, stereoGain, el('span', { className: 'set-unit', textContent: 'dB' })));
    jocControls.push((v) => { if (document.activeElement !== stereoGain) stereoGain.value = String(v.stereoGain); });

    playback.replaceChildren(section('joc', 'set.joc',
      row(t('set.jocMode'), t('set.jocModeDesc'), mode, { wide: true }), datasetRow, gainRow, stereoGainRow));
    syncJoc();
  }

  function syncJoc() {
    const v = prefs.get('joc');
    for (const fn of jocControls) fn(v);
  }

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

    const formats = o.coverFormat.map((f) => [f, t(`set.coverFormat.${f}`)]);
    const saveFormatRow = row(t('set.saveCoverFormat'), t('set.saveCoverFormatDesc'), select('saveCoverFormat', formats));
    const saveSizeRow = row(t('set.saveCoverSize'), t('set.coverSizeDesc'), number('saveCoverSize', 100, 10000, t('set.saveCoverSize')));
    const cover = section('cover', 'set.cover',
      row(t('set.coverFormat'), t('set.coverFormatDesc'), select('coverFormat', formats)),
      row(t('set.coverSize'), t('set.coverSizeDesc'), number('coverSize', 100, 10000, t('set.coverSize'))),
      row(t('set.saveCover'), t('set.saveCoverDesc'), toggle('saveCover', t('set.saveCover'))),
      saveFormatRow, saveSizeRow);
    controls.push((v) => { saveFormatRow.hidden = !v.saveCover; saveSizeRow.hidden = !v.saveCover; });

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

    host.replaceChildren(
      el('h2', { className: 'set-part-title', textContent: t('set.download') }),
      el('p', { className: 'set-part-desc', textContent: t('set.downloadDesc') }),
      quality, mv, performance, save, naming, tags, cover, lyrics, footer);

    // 目录
    const groups = [['general', 'set.general'], ['joc', 'set.joc'], ['quality', 'set.quality'], ['mv', 'set.mvSection'], ['save', 'set.save'], ['naming', 'set.naming'], ['tags', 'set.tags'], ['cover', 'set.cover'], ['lyrics', 'set.lyrics']];
    root.querySelector('#toc').replaceChildren(...groups.map(([id, key]) => {
      const a = el('a', { href: `#${id}`, className: 'set-toc-link', textContent: t(key) });
      a.addEventListener('click', (e) => { e.preventDefault(); root.querySelector(`#${id}`).scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      return a;
    }));
    sync();
  }

  function sync() {
    const v = get();
    for (const fn of controls) fn(v);
  }

  const off = prefs.onChange((section) => {
    if (section === 'download') sync();
    if (section === 'joc') syncJoc();
  });
  signal.addEventListener('abort', off, { once: true });
  const offDl = downloads.onChange(() => {
    const center = host.querySelector('.set-footer .set-btn:not(.set-btn-danger)');
    if (center) center.hidden = !downloads.jobs.length;
  });
  signal.addEventListener('abort', offDl, { once: true });
  onLangChange(() => { document.title = `${t('set.title')} · am-hook`; renderJoc(); render(); });
  renderJoc();
  render();
}

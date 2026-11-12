// 专辑页、歌单页「下载」按钮打开的对话框：选择音质与要下载的曲目（默认全部），开始后交给下载管理器（downloads.mjs），
// 进度显示在页面底部的下载中心。MV 也可以下载（是否默认勾选见设置中心），尚未发行的曲目不能下载。
import { downloads } from '../download/downloads.mjs';
import { prefs, CODEC_GROUPS } from '../prefs.mjs';

const { AmI18n } = window;
const { t } = AmI18n;
const { formatTime } = window.AmHook;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

const art = (artwork, size) => (artwork && artwork.url ? artwork.url.replace('{w}', size).replace('{h}', size).replace('{c}', 'bb').replace('{f}', 'jpg') : '');

/**
 * kind：'album' | 'playlist'；resource / tracks：页面已取到的 amp-api 资源；country：地区；
 * navigate(href)：站内跳转；toast(message)：底部提示
 */
export function openDownloadDialog({ kind, resource, tracks, country, navigate, toast }) {
  const a = resource.attributes || {};
  const options = prefs.get('download');
  const cover = (a.editorialArtwork && a.editorialArtwork.staticDetailSquare) || a.artwork;
  const isMv = (r) => r.type === 'music-videos';
  const songs = tracks.filter((r) => (r.type === 'songs' || isMv(r)) && r.attributes && r.attributes.playParams);
  const mvs = songs.filter(isMv);
  const selected = new Set(songs.filter((r) => options.mv || !isMv(r)).map((r) => r.id));
  const downloadable = new Set(songs.map((r) => r.id));

  const dialog = el('dialog', { className: 'dl-dialog' });
  dialog.setAttribute('aria-labelledby', 'dl-dialog-title');

  const codec = el('select', {}, ...CODEC_GROUPS.map(([group, list]) => el('optgroup', { label: t(`set.codecGroup.${group}`) },
    ...list.map((c) => el('option', { value: c, textContent: t(`set.codec.${c}`), selected: c === options.codec })))));
  const mode = options.saveMode === 'folder' && !downloads.folder.supported ? 'zip' : options.saveMode;
  const modeText = mode === 'folder' ? `${t('set.mode.folder')}${downloads.folder.name() ? ` · ${downloads.folder.name()}` : ''}` : t(`set.mode.${mode}`);
  const settingsLink = el('a', { href: '/settings', textContent: t('dlc.changeSettings') });
  settingsLink.addEventListener('click', (e) => { e.preventDefault(); dialog.close(); navigate('/settings'); });

  const count = el('span', { className: 'dl-dialog-count' });
  const start = el('button', { type: 'button', className: 'dl-dialog-start' });
  const boxes = [];
  function sync() {
    count.textContent = t('dlc.selected', { n: selected.size, total: songs.length });
    start.textContent = t('dlc.start', { n: selected.size });
    start.disabled = selected.size === 0;
    for (const [id, box] of boxes) box.checked = selected.has(id);
    if (mvToggle) mvToggle.textContent = mvs.every((r) => selected.has(r.id)) ? t('dlc.noMv') : t('dlc.withMv', { n: mvs.length });
  }

  const items = [];
  const discs = new Set(tracks.map((r) => (r.attributes && r.attributes.discNumber) || 1));
  let lastDisc = null;
  tracks.forEach((r, i) => {
    const ra = r.attributes || {};
    if (kind === 'album' && discs.size > 1 && ra.discNumber !== lastDisc) {
      lastDisc = ra.discNumber;
      items.push(el('li', { className: 'dl-dialog-disc', textContent: t('album.disc', { n: ra.discNumber || 1 }) }));
    }
    const ok = downloadable.has(r.id);
    const box = el('input', { type: 'checkbox', checked: selected.has(r.id), disabled: !ok });
    if (ok) {
      boxes.push([r.id, box]);
      box.addEventListener('change', () => { if (box.checked) selected.add(r.id); else selected.delete(r.id); sync(); });
    }
    const num = kind === 'album' ? ra.trackNumber || '' : i + 1;
    const reason = !ok ? t('dlc.unavailable') : '';
    items.push(el('li', {}, el('label', { className: `dl-dialog-item${ok ? '' : ' is-disabled'}`, title: reason },
      box,
      el('span', { className: 'dl-dialog-num', textContent: String(num) }),
      el('span', { className: 'dl-dialog-name' }, ra.name || r.id,
        kind === 'playlist' && ra.artistName ? el('span', { className: 'dl-dialog-artist', textContent: ` — ${ra.artistName}` }) : null,
        reason ? el('span', { className: 'dl-dialog-artist', textContent: ` · ${reason}` }) : null),
      // 标题过长时也保持可见
      isMv(r) ? el('span', { className: 'dl-dialog-mv', textContent: 'MV' }) : null,
      el('span', { className: 'dl-dialog-time', textContent: ra.durationInMillis ? formatTime(ra.durationInMillis / 1000) : '' }))));
  });

  const all = el('button', { type: 'button', textContent: t('set.all') });
  all.addEventListener('click', () => { songs.forEach((r) => selected.add(r.id)); sync(); });
  const none = el('button', { type: 'button', textContent: t('set.none') });
  none.addEventListener('click', () => { selected.clear(); sync(); });
  // 有 MV 时：一键勾选 / 取消全部 MV
  const mvToggle = mvs.length ? el('button', { type: 'button' }) : null;
  if (mvToggle) {
    mvToggle.addEventListener('click', () => {
      const on = !mvs.every((r) => selected.has(r.id));
      for (const r of mvs) if (on) selected.add(r.id); else selected.delete(r.id);
      sync();
    });
  }
  const cancel = el('button', { type: 'button', className: 'dl-dialog-cancel', textContent: t('dlc.dialogCancel') });
  cancel.addEventListener('click', () => dialog.close());

  start.addEventListener('click', async () => {
    start.disabled = true;
    // 在点击中调用：保存到文件夹时需要在用户操作中取得写入权限
    const job = await downloads.add({
      kind, id: resource.id, country, resource, tracks,
      // 总是给出选择：没有选择时 MV 按设置决定，而这里已由用户勾选
      select: [...selected],
      codec: codec.value,
    }).catch((err) => { toast(err.message || String(err)); return null; });
    dialog.close();
    if (job) toast(t('dlc.added', { name: a.name || '' }));
  });

  const src = art(cover, 112);
  dialog.append(
    el('div', { className: 'dl-dialog-head' },
      src ? el('img', { className: 'dl-dialog-art', src, alt: '' }) : null,
      el('div', { className: 'dl-dialog-titles' },
        el('h2', { className: 'dl-dialog-title', id: 'dl-dialog-title', textContent: t(kind === 'album' ? 'dlc.dialogAlbum' : 'dlc.dialogPlaylist', { name: a.name || '' }) }),
        el('p', { className: 'dl-dialog-sub', textContent: a.artistName || a.curatorName || '' }))),
    el('div', { className: 'dl-dialog-opts' },
      el('span', { textContent: t('set.codec') }), codec,
      el('span', { textContent: t('set.saveMode') }), el('span', {}, modeText, ' · ', settingsLink)),
    el('div', { className: 'dl-dialog-tools' }, count, all, none, mvToggle),
    el('ul', { className: 'dl-dialog-list' }, ...items),
    el('div', { className: 'dl-dialog-foot' }, cancel, start));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  sync();
  dialog.showModal();
  start.focus();
  return dialog;
}

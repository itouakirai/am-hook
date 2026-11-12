// 资料库的界面部件（导航与各页面共用）：对话框、歌单封面拼图、「添加到歌单」菜单、新建 / 编辑 / 删除歌单、导入与导出。
// 数据的读写见 /assets/library.mjs。
import * as library from '/assets/library.mjs';

const { AmI18n } = window;
const { t } = AmI18n;

export const LIB_ICON = {
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  added: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  remove: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/></svg>',
  playlist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h11M4 11h11M4 16h7"/><path d="M18 8v8.5"/><circle cx="16" cy="17" r="2"/></svg>',
  addToPlaylist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h11M4 11h11M4 16h7"/><path d="M18 13v7M14.5 16.5h7"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  duplicate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  export: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
  import: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>',
  grip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 8h14M5 12h14M5 16h14"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
  starFilled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
  newFolder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/></svg>',
  move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M9 13.5h6m-2.5-2.5 2.5 2.5-2.5 2.5"/></svg>',
  top: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V7m-5 5 5-5 5 5"/><path d="M5 4h14"/></svg>',
};

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

/** 歌单显示的名称：没有名称时为「未命名歌单」 */
export const playlistName = (list) => (list && list.name) || t('library.untitled');

/* ---------- 对话框（原生 <dialog>，页面上不能用 prompt / confirm） ---------- */
/**
 * fields：[{ name, label, value, placeholder, multiline, maxLength }]；
 * buttons：[{ value, label, danger }]，第一个为默认按钮（回车触发），显示在最右侧；「取消」总在最左侧。
 * 返回 Promise：取消时为 null，否则为 { action, values }
 */
export function openDialog({ title, message = '', fields = [], buttons }) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { className: 'lib-dialog' });
    const form = el('form', { className: 'lib-dialog-form', method: 'dialog' });
    const titleId = `lib-dialog-${Date.now().toString(36)}`;
    form.append(el('h2', { className: 'lib-dialog-title', id: titleId, textContent: title }));
    dialog.setAttribute('aria-labelledby', titleId);
    if (message) form.append(el('p', { className: 'lib-dialog-message', textContent: message }));
    const inputs = fields.map((field) => {
      const input = el(field.multiline ? 'textarea' : 'input', {
        className: 'lib-dialog-input', name: field.name, value: field.value || '', placeholder: field.placeholder || '',
        maxLength: field.maxLength || (field.multiline ? 4000 : 200), autocomplete: 'off',
      });
      if (field.multiline) input.rows = 4;
      form.append(el('label', { className: 'lib-dialog-field' }, el('span', { className: 'lib-dialog-label', textContent: field.label }), input));
      return input;
    });
    // 按钮的 DOM 顺序：默认按钮在前（回车提交的是第一个提交按钮），样式上反向排列
    const actions = el('div', { className: 'lib-dialog-actions' });
    for (const button of buttons) {
      actions.append(el('button', {
        type: 'submit', value: button.value, textContent: button.label,
        className: `lib-dialog-btn${button.danger ? ' danger' : ''}${button === buttons[0] ? ' primary' : ''}`,
      }));
    }
    const cancel = el('button', { type: 'button', className: 'lib-dialog-btn', textContent: t('library.cancel') });
    actions.append(cancel);
    form.append(actions);
    dialog.append(form);

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(result);
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = Object.fromEntries(inputs.map((input) => [input.name, input.value]));
      finish({ action: (event.submitter && event.submitter.value) || buttons[0].value, values });
    });
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
    dialog.addEventListener('close', () => finish(null));
    // 点击遮罩（对话框外）取消
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) finish(null);
    });
    document.body.append(dialog);
    dialog.showModal();
    const first = inputs[0] || actions.querySelector('.primary');
    if (first) {
      first.focus();
      if (first.select) first.select();
    }
  });
}

/* ---------- 歌单封面：与 Apple Music 相同，有 4 张以上不同的专辑封面时拼成 2×2，否则用第一张 ---------- */
export function playlistCover(list, size = 300, className = 'lib-cover') {
  const seen = new Set();
  const arts = [];
  for (const track of (list && list.tracks) || []) {
    const key = track.albumId || track.artwork;
    if (!track.artwork || seen.has(key)) continue;
    seen.add(key);
    arts.push(track.artwork);
    if (arts.length === 4) break;
  }
  const box = el('span', { className: `${className}${arts.length >= 4 ? ' mosaic' : ''}` });
  if (arts.length >= 4) {
    box.append(...arts.map((art) => el('img', { src: library.artUrl(art, Math.ceil(size / 2)), alt: '', loading: 'lazy', decoding: 'async' })));
  } else if (arts.length) {
    box.append(el('img', { src: library.artUrl(arts[0], size), alt: '', loading: 'lazy', decoding: 'async' }));
  } else {
    box.append(el('span', { className: 'lib-cover-ph', innerHTML: LIB_ICON.playlist }));
  }
  return box;
}

/* ---------- 曲目行（与歌单页的 pl-track 相同：封面与播放按钮、歌名 / 艺人两行、专辑列、时长、更多） ---------- */
const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const VIDEO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z" fill="currentColor"/></svg>';

/** 艺人行：在 artist 中依次找到各位艺人的名字并链接到艺人页，其余保留为文字 */
export function artistParts(track) {
  const name = track.artist || '';
  const parts = [];
  let pos = 0;
  for (const artist of track.artists || []) {
    const i = artist.href ? name.indexOf(artist.name, pos) : -1;
    if (i < 0) continue;
    if (i > pos) parts.push(name.slice(pos, i));
    parts.push(el('a', { href: artist.href, textContent: artist.name }));
    pos = i + artist.name.length;
  }
  if (pos < name.length) parts.push(name.slice(pos));
  return parts;
}

/**
 * 一行曲目。options：actions（createActions 的结果）、onPlay()（歌曲：从这一首开始播放）、extraItems（菜单项）、
 * playlistId（「添加到歌单」不列出的歌单）、lead（行首额外的元素，如拖动把手）。返回 { row, playBtn, track }
 */
export function trackRow(track, { actions, onPlay, extraItems, playlistId, lead } = {}) {
  const { formatTime } = window.AmHook;
  const video = track.kind === 'music-video';
  const src = library.artUrl(track.artwork, 80);
  const cover = el('span', { className: `track-art${video ? ' mv' : ''}` },
    src ? el('img', { src, alt: '', loading: 'lazy', decoding: 'async' }) : el('span', { className: 'ph' }),
    el('span', { className: 'eq', ariaHidden: 'true' }, el('i'), el('i'), el('i'), el('i')));
  let playBtn = null;
  if (!video && onPlay) {
    playBtn = el('button', { className: 'track-play', type: 'button', innerHTML: PLAY_ICON });
    playBtn.setAttribute('aria-label', t('album.playTrack', { name: track.name }));
    playBtn.addEventListener('click', onPlay);
    cover.append(playBtn);
  }
  const title = track.href ? el('a', { className: 'track-title', href: track.href, textContent: track.name })
    : el('span', { className: 'track-title', textContent: track.name });
  const main = el('div', { className: 'track-main' },
    el('div', { className: 'track-line' }, title,
      track.explicit ? el('span', { className: 'explicit', textContent: 'E', title: t('search.explicit') }) : null,
      library.isFavorite(track.kind, track.id) ? el('span', { className: 'lib-fav', innerHTML: LIB_ICON.starFilled, title: t('library.favorited') }) : null,
      video ? el('span', { className: 'track-kind', innerHTML: VIDEO_ICON, title: t('album.video') }) : null),
    el('div', { className: 'track-artist' }, ...artistParts(track)));
  const albumCol = track.albumHref && track.album ? el('a', { className: 'track-album', href: track.albumHref, textContent: track.album })
    : el('span', { className: 'track-album', textContent: track.album || '' });
  const more = actions.moreButton({
    kind: track.kind, href: track.href, apple: library.appleUrl(track.href), name: track.name, country: track.country, track,
    albumHref: track.albumHref, playlistId, extraItems, ...(onPlay && !video ? { onPlay } : {}),
  });
  const row = el('div', { className: `track pl-track lib-track${video ? ' video' : ''}${lead ? ' has-lead' : ''}` },
    lead || null, cover, main, albumCol,
    el('span', { className: 'track-time', textContent: track.duration ? formatTime(track.duration / 1000) : '' }), more);
  if (!video && onPlay) row.addEventListener('dblclick', (e) => { if (!e.target.closest('a, button')) onPlay(); });
  return { row, playBtn, track };
}

/** 正在播放的曲目高亮、显示均衡器（rows 为 trackRow 的结果） */
export function syncTrackRows(rows, player) {
  const current = player.current;
  const playing = !!current && !player.transport().paused;
  for (const { row, playBtn, track } of rows) {
    const active = !!current && track.kind === 'song' && current.track === track.id;
    row.classList.toggle('playing', active);
    row.classList.toggle('paused', active && !playing);
    row.classList.toggle('loading', track.kind === 'song' && player.pendingTrack === track.id);
    if (playBtn) playBtn.innerHTML = active && playing ? PAUSE_ICON : PLAY_ICON;
  }
}

/** 「喜爱的歌曲」的封面：与 Apple Music 相同，强调色渐变上的星形 */
export function favoriteCover(className = 'lib-cover') {
  return el('span', { className: `${className} lib-cover-favorite` }, el('span', { className: 'lib-cover-ph', innerHTML: LIB_ICON.starFilled }));
}

/** 文件夹的封面：文件夹图标 */
export function folderCover(className = 'lib-cover') {
  return el('span', { className: `${className} lib-cover-folder` }, el('span', { className: 'lib-cover-ph', innerHTML: LIB_ICON.folder }));
}

export const folderName = (dir) => (dir && dir.name) || t('library.untitledFolder');

/* ---------- 歌单操作 ---------- */
/** 新建歌单（可带初始曲目）；open 为 true 时创建后打开歌单页。返回新歌单，取消时为 null */
export async function newPlaylist({ tracks = [], name = '', folderId = '', open = false, navigate, toast } = {}) {
  const result = await openDialog({
    title: t('library.newPlaylist'),
    fields: [
      { name: 'name', label: t('library.playlistName'), value: name, placeholder: t('library.untitled') },
      { name: 'description', label: t('library.description'), multiline: true, placeholder: t('library.descriptionHint') },
    ],
    buttons: [{ value: 'create', label: t('library.create') }],
  });
  if (!result) return null;
  const list = library.createPlaylist({ name: result.values.name.trim() || t('library.untitled'), description: result.values.description, tracks, folderId });
  if (toast) toast(tracks.length ? t('library.addedTo', { n: tracks.length, name: playlistName(list) }) : t('library.created', { name: playlistName(list) }));
  if (open && navigate) navigate(`/library/playlist/${list.id}`);
  return list;
}

export async function editPlaylist(id) {
  const list = library.playlist(id);
  if (!list) return;
  const result = await openDialog({
    title: t('library.editPlaylist'),
    fields: [
      { name: 'name', label: t('library.playlistName'), value: list.name, placeholder: t('library.untitled') },
      { name: 'description', label: t('library.description'), value: list.description, multiline: true, placeholder: t('library.descriptionHint') },
    ],
    buttons: [{ value: 'save', label: t('library.save') }],
  });
  if (result) library.updatePlaylist(id, { name: result.values.name.trim() || t('library.untitled'), description: result.values.description });
}

/** 删除前确认；删除后 onDeleted() */
export async function deletePlaylist(id, { toast, onDeleted } = {}) {
  const list = library.playlist(id);
  if (!list) return;
  const result = await openDialog({
    title: t('library.deleteTitle', { name: playlistName(list) }),
    message: t('library.deleteMessage'),
    buttons: [{ value: 'delete', label: t('library.delete'), danger: true }],
  });
  if (!result) return;
  library.deletePlaylist(id);
  if (toast) toast(t('library.deleted', { name: playlistName(list) }));
  if (onDeleted) onDeleted();
}

export function duplicatePlaylist(id, { toast, navigate } = {}) {
  const copy = library.duplicatePlaylist(id, t('library.copySuffix'));
  if (!copy) return;
  if (toast) toast(t('library.created', { name: playlistName(copy) }));
  if (navigate) navigate(`/library/playlist/${copy.id}`);
}

/* ---------- 歌单文件夹 ---------- */
/** 新建文件夹（parentId 为上级文件夹）；open 为 true 时创建后打开文件夹页。返回文件夹，取消时为 null */
export async function newFolder({ parentId = '', open = false, navigate, toast } = {}) {
  const result = await openDialog({
    title: t('library.newFolder'),
    fields: [{ name: 'name', label: t('library.folderName'), placeholder: t('library.untitledFolder') }],
    buttons: [{ value: 'create', label: t('library.create') }],
  });
  if (!result) return null;
  let dir;
  try {
    dir = library.createFolder({ name: result.values.name.trim() || t('library.untitledFolder'), parentId });
  } catch (err) {
    if (toast) toast(t('library.failed', { msg: err.message }));
    return null;
  }
  if (toast) toast(t('library.created', { name: folderName(dir) }));
  if (open && navigate) navigate(`/library/playlist-folder/${dir.id}`);
  return dir;
}

export async function renameFolder(id) {
  const dir = library.folder(id);
  if (!dir) return;
  const result = await openDialog({
    title: t('library.renameFolder'),
    fields: [{ name: 'name', label: t('library.folderName'), value: dir.name, placeholder: t('library.untitledFolder') }],
    buttons: [{ value: 'save', label: t('library.save') }],
  });
  if (result) library.renameFolder(id, result.values.name.trim() || t('library.untitledFolder'));
}

/** 删除文件夹前确认（与 Apple Music 相同，其中的歌单一并删除）；删除后 onDeleted() */
export async function deleteFolder(id, { toast, onDeleted } = {}) {
  const dir = library.folder(id);
  if (!dir) return;
  const counts = library.folderCounts(id);
  const result = await openDialog({
    title: t('library.deleteFolderTitle', { name: folderName(dir) }),
    message: counts.playlists || counts.folders
      ? t('library.deleteFolderMessage', { playlists: counts.playlists, folders: counts.folders })
      : t('library.deleteEmptyFolderMessage'),
    buttons: [{ value: 'delete', label: t('library.delete'), danger: true }],
  });
  if (!result) return;
  library.deleteFolder(id);
  if (toast) toast(t('library.deleted', { name: folderName(dir) }));
  if (onDeleted) onDeleted();
}

/**
 * 「移到文件夹」的子菜单项：最上层，然后是全部文件夹（按层级缩进）；当前所在位置标为「当前位置」，
 * 文件夹不能移到自身或自己的子文件夹里。entry：{ type: 'playlist' | 'catalog' | 'folder', id }，current 为当前所在文件夹 id
 */
export function moveMenuItems(entry, current = '', { toast } = {}) {
  const move = (folderId, name) => {
    if (library.moveToFolder(entry, folderId) && toast) toast(t('library.movedTo', { name }));
  };
  const items = [{
    icon: LIB_ICON.top, label: t('library.topLevel'), hint: current ? '' : t('library.currentLocation'),
    onSelect: () => move('', t('library.topLevel')),
  }];
  const walk = (parentId, depth) => {
    for (const dir of library.folders().filter((d) => d.parentId === parentId)) {
      if (entry.type === 'folder' && !library.canMoveFolder(entry.id, dir.id)) continue;
      items.push({
        icon: LIB_ICON.folder, label: `${'\u2003'.repeat(depth)}${folderName(dir)}`, hint: dir.id === current ? t('library.currentLocation') : '',
        onSelect: () => move(dir.id, folderName(dir)),
      });
      walk(dir.id, depth + 1);
    }
  };
  walk('', 0);
  return items;
}

/**
 * 「添加到歌单」的子菜单项（见 actions.mjs openMenu）：新建歌单，然后是本地歌单（最近修改的在前）。
 * getTracks() 返回要添加的曲目快照（专辑 / 歌单需要先取曲目，可以是异步的）；except 为不列出的歌单 id（当前歌单）。
 */
export function playlistMenuItems(getTracks, { toast, navigate, except } = {}) {
  const run = async (fn) => {
    let tracks;
    try {
      tracks = await getTracks();
    } catch (err) {
      if (toast) toast(t('library.failed', { msg: err.message }));
      return;
    }
    if (!tracks.length) { if (toast) toast(t('library.nothingToAdd')); return; }
    fn(tracks);
  };
  const items = [{
    icon: LIB_ICON.add, label: t('library.newPlaylistEllipsis'),
    onSelect: () => run((tracks) => newPlaylist({ tracks, toast, navigate })),
  }];
  const lists = library.playlists().filter((list) => list.id !== except);
  if (lists.length) items.push('-');
  for (const list of lists) {
    items.push({
      icon: LIB_ICON.playlist, label: playlistName(list), hint: t('library.songCount', { n: list.tracks.length }),
      onSelect: () => run((tracks) => {
        const { added, skipped } = library.addToPlaylist(list.id, tracks);
        if (!toast) return;
        if (added) toast(t('library.addedTo', { n: added, name: playlistName(list) }));
        else if (skipped) toast(t('library.alreadyIn', { name: playlistName(list) }));
      }),
    });
  }
  return items;
}

/* ---------- 导入与导出 ---------- */
function download(fileName, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: fileName });
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** 文件名里不能用的字符换成 _ */
const safeName = (name) => name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 80) || 'playlist';
const today = () => new Date().toISOString().slice(0, 10);

export function exportLibrary({ toast } = {}) {
  const data = library.exportData();
  download(`am-hook-library-${today()}.json`, data);
  if (toast) toast(t('library.exported', { items: data.items.length, playlists: data.playlists.length, folders: data.folders.length }));
}

export function exportPlaylist(id) {
  const list = library.playlist(id);
  if (list) download(`${safeName(playlistName(list))}.am-hook-playlist.json`, library.exportData({ playlists: [id] }));
}

/** 导出文件夹（连同其中的子文件夹与歌单） */
export function exportFolder(id) {
  const dir = library.folder(id);
  if (dir) download(`${safeName(folderName(dir))}.am-hook-folder.json`, library.exportData({ folder: id }));
}

/** 选择文件 → 解析 → 确认（整库文件可选合并或替换，单个歌单直接导入）→ 写入。返回导入结果，取消或失败时为 null */
export function importLibrary({ toast, navigate } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('cancel', () => resolve(null));
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) { resolve(null); return; }
      let parsed;
      try {
        parsed = library.parseImport(await file.text());
      } catch (err) {
        if (toast) toast(t(err.message === 'version' ? 'library.importVersion' : 'library.importFormat'));
        resolve(null);
        return;
      }
      const tracks = parsed.playlists.reduce((sum, list) => sum + list.tracks.length, 0);
      if (!parsed.items.length && !parsed.playlists.length && !parsed.folders.length) {
        if (toast) toast(t('library.importEmpty'));
        resolve(null);
        return;
      }
      const summary = t('library.importSummary', { items: parsed.items.length, playlists: parsed.playlists.length, folders: parsed.folders.length, tracks })
        + (parsed.dropped ? ` ${t('library.importDropped', { n: parsed.dropped })}` : '');
      // 整个资料库的文件可以合并或替换；歌单、文件夹文件（只含歌单）直接加入
      const whole = parsed.items.some((item) => item.kind !== 'playlist');
      const result = await openDialog({
        title: t('library.importTitle', { name: file.name }),
        message: whole ? `${summary}\n${t('library.importHint')}` : summary,
        buttons: whole
          ? [{ value: 'merge', label: t('library.importMerge') }, { value: 'replace', label: t('library.importReplace'), danger: true }]
          : [{ value: 'merge', label: t('library.import') }],
      });
      if (!result) { resolve(null); return; }
      const done = await library.importData(parsed, { replace: result.action === 'replace' });
      if (toast) toast(t('library.imported', { items: done.items, playlists: done.playlists, folders: done.folders }));
      // 导入的是一个文件夹或一个歌单时直接打开它
      const topFolders = parsed.folders.filter((dir) => !dir.parentId);
      if (!whole && navigate && topFolders.length === 1) navigate(`/library/playlist-folder/${topFolders[0].id}`);
      else if (!whole && navigate && !parsed.folders.length && parsed.playlists.length === 1) navigate(`/library/playlist/${parsed.playlists[0].id}`);
      resolve(done);
    });
    input.click();
  });
}

/** 清空资料库前确认 */
export async function clearLibrary({ toast } = {}) {
  const result = await openDialog({
    title: t('library.clearTitle'),
    message: t('library.clearMessage'),
    buttons: [{ value: 'clear', label: t('library.clear'), danger: true }],
  });
  if (!result) return false;
  await library.clearAll();
  if (toast) toast(t('library.cleared'));
  return true;
}

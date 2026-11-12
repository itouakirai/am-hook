// 下载中心：与播放条一样常驻在页面底部（播放条上方），显示全部下载的总进度；展开后列出各专辑 / 歌单 / 单曲及其中每首歌的进度，
// 可以取消、重试、再次保存与移除。数据来自 downloads.mjs，界面在任何页面都可用，站内跳转时不中断。

import { downloads } from './downloads.mjs';

const { AmI18n } = window;
const { t } = AmI18n;

const ICON = {
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>',
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><path d="M12 16.5h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 13h9l1-13"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
};

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function iconButton(className, icon, label, onClick) {
  const b = el('button', { className: `dl-icon-btn ${className}`, type: 'button', innerHTML: icon, title: label });
  b.setAttribute('aria-label', label);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

export function formatSize(bytes) {
  if (!bytes) return '0 MB';
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

const art = (template, size) => (template ? template.replace('{w}', size).replace('{h}', size).replace('{c}', 'bb').replace('{f}', 'jpg') : '');

function pageHref(job) {
  const kind = { album: 'album', playlist: 'playlist', song: 'song', 'music-video': 'music-video' }[job.kind];
  return `/https://music.apple.com/${job.country}/${kind}/_/${job.cid}`;
}

/** root：#downloads；navigate(href)：站内跳转 */
export function mountDownloadCenter({ root, navigate }) {
  const bar = root.querySelector('.dlc-bar');
  const main = root.querySelector('.dlc-bar-main');
  const ring = root.querySelector('.dl-ring-fill');
  const icon = root.querySelector('.dl-ring-icon');
  const title = root.querySelector('.dlc-bar-title');
  const sub = root.querySelector('.dlc-bar-sub');
  const fill = root.querySelector('.dlc-bar-fill');
  const hide = root.querySelector('.dlc-bar-hide');
  const panel = root.querySelector('.dl-panel');
  const list = root.querySelector('.dl-jobs');
  const empty = root.querySelector('.dl-empty');
  const clear = root.querySelector('.dl-clear');
  const settingsLink = root.querySelector('.dl-settings');
  /** 用户收起（×）后不再显示，直到有新的下载 */
  let dismissed = false;
  let knownJobs = 0;
  const expanded = new Set();
  const nodes = new Map();

  function setOpen(open) {
    panel.hidden = !open;
    main.setAttribute('aria-expanded', String(open));
    root.classList.toggle('is-open', open);
    if (open) render();
  }
  main.addEventListener('click', () => setOpen(panel.hidden));
  hide.addEventListener('click', () => { dismissed = true; setOpen(false); render(); });
  clear.addEventListener('click', () => downloads.clearFinished());
  settingsLink.addEventListener('click', (e) => { e.preventDefault(); setOpen(false); navigate('/settings'); });
  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !root.contains(e.target)) setOpen(false);
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { setOpen(false); main.focus(); }
  });

  /* ---------- 底栏 ---------- */
  function renderBar() {
    const jobs = downloads.jobs;
    if (jobs.length > knownJobs) dismissed = false;
    knownJobs = jobs.length;
    const visible = jobs.length > 0 && !dismissed;
    root.hidden = !visible;
    document.body.classList.toggle('has-downloads', visible);
    if (visible) document.body.style.setProperty('--downloads-height', `${bar.getBoundingClientRect().height}px`);
    if (!visible) { if (!panel.hidden) setOpen(false); return; }
    const s = downloads.stats();
    const busy = downloads.busy();
    const pct = Math.floor(s.ratio * 100);
    root.classList.toggle('is-busy', busy);
    root.classList.toggle('has-failed', !busy && s.failed > 0);
    ring.style.strokeDashoffset = String(100 - (busy ? s.ratio * 100 : 100));
    icon.innerHTML = busy ? ICON.download : s.failed ? ICON.warn : ICON.done;
    fill.style.width = `${busy ? pct : 100}%`;
    const current = jobs.slice().reverse().find((j) => ['running', 'packing', 'preparing'].includes(downloads.jobState(j)));
    if (busy) {
      title.textContent = current ? t('dlc.barActive', { name: current.title || t('dlc.untitled') }) : t('dlc.barQueued');
      const parts = [t('dlc.count', { done: s.done, total: s.total }), `${pct}%`];
      if (s.speed > 0) parts.push(`${formatSize(s.speed)}/s`);
      const others = jobs.filter((j) => j !== current && ['running', 'queued', 'preparing'].includes(downloads.jobState(j))).length;
      if (others) parts.push(t('dlc.moreJobs', { n: others }));
      sub.textContent = parts.join(' · ');
    } else if (!s.total) {
      // 只有取消了的任务
      title.textContent = t('dlc.cancelled');
      sub.textContent = t('dlc.open');
    } else {
      title.textContent = s.failed ? t('dlc.barFailed', { n: s.failed }) : t('dlc.barDone');
      sub.textContent = t('dlc.count', { done: s.done, total: s.total });
    }
    hide.hidden = busy;
    main.title = t('dlc.open');
  }

  /* ---------- 面板 ---------- */
  function statusText(job) {
    const state = downloads.jobState(job);
    const tasks = job.tasks;
    const n = (st) => tasks.filter((x) => x.state === st).length;
    const done = n('done') + n('skipped');
    switch (state) {
      case 'preparing': return t('dlc.preparing');
      case 'packing': return t('dlc.packing');
      case 'queued': return t('dlc.queued');
      case 'running': {
        const bytes = tasks.reduce((sum, x) => sum + (x.state === 'downloading' ? x.done : 0), 0);
        return [t('dlc.count', { done, total: tasks.length }), `${Math.floor(downloads.jobProgress(job) * 100)}%`, bytes ? formatSize(bytes) : ''].filter(Boolean).join(' · ');
      }
      case 'cancelled': return t('dlc.cancelled');
      case 'error': return job.prepError ? t('dlc.prepFailed', { msg: job.prepError }) : t('dlc.allFailed');
      case 'partial': return t('dlc.partial', { done, failed: n('error'), cancelled: n('cancelled') });
      default: {
        if (job.packError) return t('dlc.packFailed', { msg: job.packError });
        const skipped = n('skipped');
        const where = job.mode === 'folder' ? t('dlc.savedFolder', { name: [downloads.folder.name(), ...job.folder].filter(Boolean).join('/') })
          : job.zip ? t('dlc.savedZip', { name: job.zipName, size: formatSize(job.zip.size) })
          : t('dlc.savedFiles');
        return [where, skipped ? t('dlc.skipped', { n: skipped }) : ''].filter(Boolean).join(' · ');
      }
    }
  }

  function taskStatus(task) {
    switch (task.state) {
      case 'queued': return task.error ? t('dlc.retrying', { msg: task.error }) : t('dlc.taskQueued');
      case 'resolving': return t('dlc.resolving');
      case 'downloading': return task.total ? `${Math.floor((task.done / task.total) * 100)}% · ${formatSize(task.done)} / ${formatSize(task.total)}` : t('dlc.resolving');
      case 'tagging': return t('dlc.tagging');
      case 'saving': return t('dlc.saving');
      case 'done': return task.result ? formatSize(task.result.size) : t('dlc.taskDone');
      case 'skipped': return t('dlc.taskSkipped');
      case 'cancelled': return t('dlc.cancelled');
      case 'error': return task.error || t('dlc.failed');
      default: return '';
    }
  }

  /** 下载时检测 ALAC 的结论：单曲的标记文字，以及专辑 / 歌单卡片上的总结 */
  function checkText(check) {
    return check.failed ? t('dlc.checkFailed') : check.bad ? t('dlc.checkBad', { n: check.bad }) : t('dlc.checkOk');
  }

  function checkSummary(job) {
    const checks = job.tasks.map((x) => x.check).filter(Boolean);
    if (!checks.length) return null;
    const bad = checks.filter((c) => c.bad);
    const failed = checks.filter((c) => c.failed).length;
    const ok = checks.length - bad.length - failed;
    const parts = [
      bad.length && t('dlc.checkSumBad', { n: bad.length, frames: bad.reduce((sum, c) => sum + c.bad, 0) }),
      failed && t('dlc.checkSumFailed', { n: failed }),
      ok && t('dlc.checkSumOk', { n: ok }),
    ].filter(Boolean);
    return { text: t('dlc.checkSummary', { parts: parts.join(' · ') }), level: bad.length ? 'bad' : failed ? 'failed' : 'ok' };
  }

  function jobNode(job) {
    let n = nodes.get(job.id);
    if (n) return n;
    const img = el('img', { className: 'dl-job-art', alt: '', loading: 'lazy', decoding: 'async' });
    const name = el('a', { className: 'dl-job-title' });
    name.addEventListener('click', (e) => { e.preventDefault(); setOpen(false); navigate(name.getAttribute('href')); });
    const subline = el('span', { className: 'dl-job-sub' });
    const status = el('span', { className: 'dl-job-status' });
    const check = el('span', { className: 'dl-job-check', hidden: true });
    const actions = el('span', { className: 'dl-job-actions' });
    const toggle = el('button', { className: 'dl-icon-btn dl-job-toggle', type: 'button', innerHTML: ICON.expand });
    toggle.addEventListener('click', () => {
      if (expanded.has(job.id)) expanded.delete(job.id); else expanded.add(job.id);
      render();
    });
    const progress = el('div', { className: 'dl-job-progress' }, el('i'));
    const tasks = el('ol', { className: 'dl-tasks' });
    const item = el('li', { className: 'dl-job' },
      el('div', { className: 'dl-job-head' }, toggle, img, el('div', { className: 'dl-job-text' }, name, subline, status, check), actions),
      progress, tasks);
    n = { item, img, name, subline, status, check, actions, toggle, progress: progress.firstChild, tasks, taskNodes: new Map(), sig: '' };
    nodes.set(job.id, n);
    return n;
  }

  function renderActions(job, n) {
    const state = downloads.jobState(job);
    const sig = `${state}|${!!job.zip}|${job.mode}|${AmI18n.lang}`;
    if (n.sig === sig) return;
    n.sig = sig;
    const buttons = [];
    if (['running', 'queued', 'preparing'].includes(state)) buttons.push(iconButton('dlc-cancel', ICON.close, t('dlc.cancel'), () => downloads.cancel(job)));
    if (state === 'partial' || state === 'error' || state === 'cancelled') buttons.push(iconButton('dl-retry', ICON.retry, t('dlc.retryFailed'), () => downloads.retry(job)));
    if (state === 'partial' && job.mode !== 'folder') buttons.push(iconButton('dl-save', ICON.save, t('dlc.saveAnyway'), () => downloads.save(job)));
    if (state === 'done' && job.mode !== 'folder' && (job.zip || job.tasks.some((x) => x.result))) buttons.push(iconButton('dl-save', ICON.save, t('dlc.saveAgain'), () => downloads.save(job)));
    if (!['running', 'queued', 'preparing', 'packing'].includes(state)) buttons.push(iconButton('dl-remove', ICON.trash, t('dlc.remove'), () => downloads.remove(job)));
    n.actions.replaceChildren(...buttons);
  }

  function renderTasks(job, n) {
    const open = expanded.has(job.id);
    n.tasks.hidden = !open;
    n.toggle.setAttribute('aria-expanded', String(open));
    const label = t(open ? 'dlc.collapse' : 'dlc.expand');
    n.toggle.title = label;
    n.toggle.setAttribute('aria-label', label);
    n.item.classList.toggle('is-expanded', open);
    if (!open) return;
    const rows = job.tasks.map((task) => {
      let r = n.taskNodes.get(task.id);
      if (!r) {
        const idx = el('span', { className: 'dl-task-index' });
        const nm = el('span', { className: 'dl-task-name' });
        const q = el('span', { className: 'dl-task-quality' });
        const ck = el('span', { className: 'dl-task-check', hidden: true });
        const st = el('span', { className: 'dl-task-status' });
        const bar = el('div', { className: 'dl-task-progress' }, el('i'));
        const act = el('span', { className: 'dl-task-actions' });
        const li = el('li', { className: 'dl-task' }, idx, el('div', { className: 'dl-task-main' }, el('div', { className: 'dl-task-line' }, nm, q, ck), st, bar), act);
        r = { li, idx, nm, q, ck, st, bar: bar.firstChild, act, sig: '' };
        n.taskNodes.set(task.id, r);
      }
      r.li.className = `dl-task is-${task.state}`;
      r.idx.textContent = String(task.index).padStart(2, '0');
      r.nm.textContent = task.name;
      r.nm.title = task.artist ? `${task.name} — ${task.artist}` : task.name;
      r.q.textContent = task.quality || '';
      r.q.title = r.q.textContent;
      r.ck.hidden = !task.check;
      if (task.check) {
        r.ck.textContent = checkText(task.check);
        r.ck.className = `dl-task-check is-${task.check.failed ? 'failed' : task.check.bad ? 'bad' : 'ok'}`;
      }
      r.st.textContent = taskStatus(task);
      r.st.title = task.state === 'error' ? task.error : '';
      const ratio = task.state === 'downloading' && task.total ? task.done / task.total : ['done', 'skipped', 'tagging', 'saving'].includes(task.state) ? 1 : 0;
      r.bar.style.width = `${ratio * 100}%`;
      const sig = `${task.state}|${AmI18n.lang}`;
      if (r.sig !== sig) {
        r.sig = sig;
        const b = [];
        if (['queued', 'resolving', 'downloading', 'tagging'].includes(task.state)) b.push(iconButton('dlc-cancel', ICON.close, t('dlc.cancelTrack'), () => downloads.cancel(job, task)));
        if (task.state === 'error' || task.state === 'cancelled') b.push(iconButton('dl-retry', ICON.retry, t('dlc.retryTrack'), () => downloads.retry(job, task)));
        r.act.replaceChildren(...b);
      }
      return r.li;
    });
    if (rows.length !== n.tasks.children.length || rows.some((row, i) => n.tasks.children[i] !== row)) n.tasks.replaceChildren(...rows);
  }

  function renderPanel() {
    const jobs = downloads.jobs;
    empty.hidden = jobs.length > 0;
    for (const id of [...nodes.keys()]) if (!jobs.some((j) => j.id === id)) { nodes.delete(id); expanded.delete(id); }
    const items = jobs.map((job) => {
      const n = jobNode(job);
      const state = downloads.jobState(job);
      n.item.className = `dl-job is-${state}${expanded.has(job.id) ? ' is-expanded' : ''}`;
      const src = art(job.artwork, 96);
      if (src && n.img.getAttribute('src') !== src) n.img.src = src;
      n.img.hidden = !src;
      n.name.textContent = job.title || t('dlc.untitled');
      n.name.href = pageHref(job);
      const kind = t(`dlc.kind.${job.kind}`);
      const mode = t(`dlc.mode.${(job.kind === 'song' || job.kind === 'music-video') && job.mode === 'zip' ? 'files' : job.mode}`);
      n.subline.textContent = [kind, job.subtitle, mode].filter(Boolean).join(' · ');
      n.status.textContent = statusText(job);
      n.status.title = n.status.textContent;
      const summary = checkSummary(job);
      n.check.hidden = !summary;
      if (summary) {
        n.check.textContent = summary.text;
        n.check.className = `dl-job-check is-${summary.level}`;
      }
      const ratio = state === 'done' ? 1 : downloads.jobProgress(job);
      n.progress.style.width = `${ratio * 100}%`;
      renderActions(job, n);
      renderTasks(job, n);
      return n.item;
    });
    if (items.length !== list.children.length || items.some((item, i) => list.children[i] !== item)) list.replaceChildren(...items);
    clear.disabled = !jobs.some((j) => !['running', 'queued', 'preparing', 'packing'].includes(downloads.jobState(j)));
  }

  function render() {
    renderBar();
    if (!panel.hidden) renderPanel();
  }

  downloads.onChange(render);
  AmI18n.onChange(() => {
    for (const n of nodes.values()) { n.sig = ''; for (const r of n.taskNodes.values()) r.sig = ''; }
    render();
  });
  new ResizeObserver(() => {
    if (!root.hidden) document.body.style.setProperty('--downloads-height', `${bar.getBoundingClientRect().height}px`);
  }).observe(bar);
  render();
  return { open: () => { dismissed = false; render(); setOpen(true); } };
}

/*
 * wrapper-lite 客户端（window.AmWrapper）：页面里所有用到 wrapper-lite 的请求都经这里发出。
 *
 * 两种模式，选择保存在 localStorage：
 *   服务端（默认）：经 am-hook 转发，限速、限并发与 Authorization 由命令行参数决定；
 *   本地：浏览器直接请求用户自己的 wrapper-lite（例如 http://127.0.0.1:12340），
 *         限速、限并发与 Authorization 在页面里设置（见 settings.mjs），只作用于当前页面。
 *         wrapper-lite 须允许跨源请求（带 Authorization 时还要允许该请求头），或安装解除跨域限制的浏览器插件。
 *
 *   settings                 当前设置 { local, url, rate, concurrency, auth }
 *   save(next)               保存设置（auth 规范化，非法时抛出错误）并通知 onChange
 *   onChange(fn)             设置变化后回调
 *   status()                 { regions }，不可用时抛出错误
 *   songMaster(id, signal)   { masterUrl, variants }：master m3u8 从 Apple CDN 直接获取并在这里解析
 *   key(id, uri)             轨道解密模板（/key 的 data，JSON 文本）
 *   lyrics(id, lang, signal) TTML 原文，没有歌词时为 null
 *   mvMaster(id, signal)     { masterUrl, masterBody }：MV master 总是由 am-hook 以 User-Agent: AM 获取（否则可能没有 4K）
 *   license(body, signal)    MV PlayReady license（/license 的 data）
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'am-hook-wrapper';
  const DEFAULTS = { local: false, url: 'http://127.0.0.1:12340', rate: 24, concurrency: 24, auth: '' };
  const RATE_WINDOW = 1000;

  const t = (key, vars) => (global.AmI18n ? global.AmI18n.t(key, vars) : key);

  /** 与服务端 normalize_authorization 相同：空值不发送；只有 token 时补上 `Bearer `，已带认证方案（含空白）时原样使用 */
  function normalizeAuth(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    const header = /\s/.test(value) ? value : `Bearer ${value}`;
    try { new Headers({ Authorization: header }); } catch { throw new Error(t('wrapper.badAuth')); }
    return header;
  }

  function clean(raw) {
    const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    const count = (n, fallback) => (/^\d+$/.test(String(n).trim()) ? Number(n) : fallback);
    return {
      local: s.local === true,
      url: String(s.url || '').trim().replace(/\/+$/, ''),
      rate: count(s.rate, DEFAULTS.rate),
      concurrency: count(s.concurrency, DEFAULTS.concurrency),
      auth: String(s.auth || ''),
    };
  }

  let settings = clean(null);
  try { settings = clean(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); } catch {}
  const listeners = new Set();

  /* ---------- 本地模式的限并发与限速（与服务端 src/wrapper.rs 相同：先取并发名额，再按滑动窗口占速率配额） ---------- */

  let active = 0;
  const waiting = [];
  const sent = [];
  let rateChain = Promise.resolve();

  function acquireSlot() {
    if (!settings.concurrency || active < settings.concurrency) { active++; return Promise.resolve(); }
    return new Promise((resolve) => waiting.push(resolve));
  }
  function releaseSlot() {
    const next = waiting.shift();
    if (next) next(); else active--;
  }
  /** 任意 1 秒内最多发出 rate 个请求，按到达顺序排队 */
  function acquireRate() {
    const run = rateChain.then(async () => {
      if (!settings.rate) return;
      while (sent.length && performance.now() - sent[0] >= RATE_WINDOW) sent.shift();
      if (sent.length >= settings.rate) {
        const oldest = sent.shift();
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, oldest + RATE_WINDOW - performance.now())));
      }
      sent.push(performance.now());
    });
    rateChain = run.catch(() => {});
    return run;
  }

  /**
   * 本地 wrapper-lite 的请求地址与地址中的认证：fetch 不接受带用户信息的地址（https://token@host），
   * 去掉后改为 Basic 认证（与服务端 reqwest 处理 --wrapper-url 的方式相同）。地址无效时 base 为原值
   */
  function localTarget() {
    let url;
    try { url = new URL(settings.url); } catch { return { base: settings.url, basic: '' }; }
    if (!url.username && !url.password) return { base: settings.url, basic: '' };
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    const basic = `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(credentials)))}`;
    url.username = '';
    url.password = '';
    return { base: url.href.replace(/\/+$/, ''), basic };
  }

  /** 直接请求本地 wrapper-lite，读完响应体后才释放并发名额。返回 { res, text } */
  async function localRequest(path, { method = 'GET', body, signal } = {}) {
    if (!settings.url) throw new Error(t('wrapper.noUrl'));
    await acquireSlot();
    try {
      signal?.throwIfAborted();
      await acquireRate();
      signal?.throwIfAborted();
      const { base, basic } = localTarget();
      const headers = {};
      // 单独填写的 Authorization 优先于地址中的用户信息
      const auth = normalizeAuth(settings.auth) || basic;
      if (auth) headers.Authorization = auth;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await fetch(base + path, {
          method, headers, signal, cache: 'no-store', credentials: 'omit',
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        // 跨源被拒绝与连不上在页面里无法区分，一并提示
        throw new Error(t('wrapper.unreachable', { url: base }));
      }
      return { res, text: await res.text() };
    } finally {
      releaseSlot();
    }
  }

  /** wrapper-lite 的 { code, msg, data }：code 不为 0 时抛出错误 */
  async function localJson(path, options) {
    const { res, text } = await localRequest(path, options);
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error(res.ok ? t('wrapper.invalid') : `wrapper-lite HTTP ${res.status}`); }
    if (payload.code !== 0) throw new Error(payload.msg || `wrapper-lite HTTP ${res.status}`);
    return payload.data;
  }

  /** am-hook 的 JSON 接口：失败时抛出带 msg 的错误 */
  async function serverJson(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.code !== undefined && data.code !== 0)) throw new Error(data.msg || `HTTP ${res.status}`);
    return data;
  }

  const query = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();

  /* ---------- master m3u8（歌曲） ---------- */

  function attributes(value) {
    const result = {};
    for (const m of value.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,\r\n]+)/g)) result[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    return result;
  }
  const int = (s) => (s != null && /^\d+$/.test(s) ? Number(s) : null);

  /** 歌曲 master m3u8 的各音质变体（音频组的声道 / 采样率 / 位深并入变体），url 为 media m3u8 的绝对地址 */
  function parseSongMaster(text, masterUrl) {
    const groups = new Map();
    const variants = [];
    let stream = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = attributes(line.slice(13));
        if (a.TYPE === 'AUDIO' && a['GROUP-ID']) groups.set(a['GROUP-ID'], a);
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        stream = attributes(line.slice(18));
      } else if (line && !line.startsWith('#') && line.endsWith('.m3u8')) {
        const a = stream || {};
        stream = null;
        const groupId = a.AUDIO || '';
        const group = groups.get(groupId);
        variants.push({
          uri: line,
          url: new URL(line, masterUrl).href,
          group_id: groupId,
          audio: (group && group.NAME) || '',
          codecs: a.CODECS || null,
          bandwidth: int(a['AVERAGE-BANDWIDTH']) ?? int(a.BANDWIDTH),
          channels: (group && group.CHANNELS) || null,
          sample_rate: group ? int(group['SAMPLE-RATE']) : null,
          bit_depth: group ? int(group['BIT-DEPTH']) : null,
        });
      }
    }
    if (!variants.length) throw new Error('No variants found in master m3u8');
    return variants;
  }

  /* ---------- 对外接口 ---------- */

  const AmWrapper = {
    get settings() { return { ...settings }; },
    DEFAULTS,
    normalizeAuth,
    parseSongMaster,

    save(next) {
      for (const key of ['rate', 'concurrency']) {
        if (next[key] !== undefined && !/^\d+$/.test(String(next[key]).trim())) throw new Error(t('wrapper.badNumber'));
      }
      const value = clean({ ...settings, ...next });
      normalizeAuth(value.auth);
      if (value.local) {
        let url;
        try { url = new URL(value.url); } catch { throw new Error(t('wrapper.badUrl')); }
        if (!/^https?:$/.test(url.protocol)) throw new Error(t('wrapper.badUrl'));
      }
      settings = value;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {}
      listeners.forEach((fn) => fn(AmWrapper.settings));
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    async status() {
      if (!settings.local) {
        const data = await serverJson('/status');
        return { regions: (data.regions || []).map(String) };
      }
      const data = await localJson('/status');
      return { regions: ((data && data.regions) || []).map(String) };
    },

    async songMaster(adamId, signal) {
      const m3u8 = settings.local
        ? (await localJson(`/m3u8?${query({ adamId })}`, { signal }))?.m3u8
        : (await serverJson(`/parse/song/${encodeURIComponent(adamId)}`, { signal })).data?.masterUrl;
      if (!m3u8) throw new Error(t('wrapper.noMaster'));
      // Apple CDN（aod.itunes.apple.com）允许跨源请求，master 与 media m3u8 都直接获取
      const res = await fetch(m3u8, { signal });
      if (!res.ok) throw new Error(`master m3u8 HTTP ${res.status}`);
      const masterUrl = res.url || m3u8;
      return { masterUrl, variants: parseSongMaster(await res.text(), masterUrl) };
    },

    async key(adamId, uri) {
      if (settings.local) return JSON.stringify(await localJson(`/key?${query({ adamId, uri })}`));
      const res = await fetch(`/key?${query({ adamId, uri })}`);
      const text = await res.text();
      if (!res.ok) {
        let msg = '';
        try { msg = JSON.parse(text).msg; } catch {}
        throw new Error(msg || `HTTP ${res.status}`);
      }
      return text;
    },

    async lyrics(adamId, language, signal) {
      if (!settings.local) {
        const res = await fetch(`/lyrics/${adamId}${language ? `?language=${encodeURIComponent(language)}` : ''}`, { signal });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      }
      const { res, text } = await localRequest(`/lyrics?${query({ adamId, language })}`, { signal });
      if (res.status === 404) return null;
      let payload;
      try { payload = JSON.parse(text); } catch { throw new Error(`wrapper-lite HTTP ${res.status}`); }
      // wrapper-lite 以 HTTP 200 + code 404 表示该歌曲没有歌词
      if (payload.code === 404) return null;
      if (payload.code !== 0) throw new Error(payload.msg || `wrapper-lite HTTP ${res.status}`);
      const ttml = payload.data && payload.data.lyrics;
      return ttml && ttml.trim() ? ttml : null;
    },

    async mvMaster(id, signal) {
      if (!settings.local) return (await serverJson(`/parse/mv/${id}`, { signal })).data;
      const url = (await localJson(`/webplayback?${query({ adamId: id })}`, { signal }))?.m3u8;
      if (!url) throw new Error(t('wrapper.noMaster'));
      return (await serverJson(`/parse/mv-master?${query({ url })}`, { signal })).data;
    },

    async license(body, signal) {
      if (settings.local) return localJson('/license', { method: 'POST', body, signal });
      return (await serverJson('/mv/license', {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })).data;
    },
  };

  global.AmWrapper = AmWrapper;
})(window);

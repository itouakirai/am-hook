/*
 * wrapper-lite 客户端（window.AmWrapper）：页面里所有用到 wrapper-lite 的请求都经这里发出。
 *
 * 两种模式，选择保存在 localStorage：
 *   服务端（默认）：经 am-hook 转发，限速、限并发与 Authorization 由命令行参数决定；
 *         serverless 部署没有配置服务端 wrapper-lite 时不可用（host.js 的 serverWrapper 为 false），页面只用本地模式；
 *   本地：浏览器直接请求用户自己的 wrapper-lite（例如 http://127.0.0.1:12340），
 *         限速、限并发与 Authorization 在页面里设置（见 settings.mjs），只作用于当前页面。
 *         wrapper-lite 须允许跨源请求（带 Authorization 时还要允许该请求头），或安装解除跨域限制的浏览器插件。
 *
 *   settings                 当前设置 { local, url, rate, concurrency, auth }
 *   hint                     部署方给出的提示（host.js），显示在本地设置上方
 *   save(next)               保存设置（auth 规范化，非法时抛出错误）并通知 onChange
 *   onChange(fn)             设置变化后回调
 *   status()                 { regions }，不可用时抛出错误
 *   songMaster(id, signal)   { masterUrl, variants }：master m3u8 从 Apple CDN 直接获取并在这里解析；
 *                            没有 master 的歌曲退回 /webplayback 的 AAC-LC（Widevine）
 *   webplayback(id, signal)  /webplayback 的 m3u8 地址，没有时为 null
 *   key(id, uri)             轨道解密模板（/key 的 data，JSON 文本）
 *   lyrics(id, lang, signal) TTML 原文，没有歌词时为 null
 *   mvMaster(id, signal)     { masterUrl, masterBody }：MV master 总是由 am-hook 以 User-Agent: AM 获取（否则可能没有 4K）
 *   license(body, signal)    /license 的 data：MV 的 PlayReady license、AAC-LC 歌曲的 Widevine（或 PlayReady）license
 *   sleep(ms, signal)        等待 ms 毫秒，signal 中止时以 signal.reason 拒绝
 *   throttle                 wrapper-lite 限流（429 / rate limited）后的共用冷却：remaining() / wait(signal) / limit(base) / ok()，
 *                            请求失败时抛出的 Error 带 throttled（限流）或 final（banned）；下载管理器据此暂停并降低并发
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'am-hook-wrapper';
  const HOST = global.AM_HOOK_HOST || {};
  /** 服务端能否转发 wrapper-lite（见 host.js） */
  const SERVER = HOST.serverWrapper !== false;
  /** 部署方给出的本地模式默认值（见 host.js），只作用于没有保存过设置的页面 */
  const HOST_DEFAULTS = HOST.wrapper && typeof HOST.wrapper === 'object' ? HOST.wrapper : {};
  const hostCount = (n, fallback) => (Number.isInteger(n) && n >= 0 ? n : fallback);
  const DEFAULTS = {
    local: !SERVER,
    url: typeof HOST_DEFAULTS.url === 'string' && HOST_DEFAULTS.url ? HOST_DEFAULTS.url : 'http://127.0.0.1:12340',
    rate: hostCount(HOST_DEFAULTS.rate, 24),
    concurrency: hostCount(HOST_DEFAULTS.concurrency, 24),
    auth: '',
  };
  /** 部署方的提示（见 host.js），没有时为空 */
  const HINT = typeof HOST.hint === 'string' ? HOST.hint.trim() : '';
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
      local: s.local === true || !SERVER,
      url: String(s.url || '').trim().replace(/\/+$/, ''),
      rate: count(s.rate, DEFAULTS.rate),
      concurrency: count(s.concurrency, DEFAULTS.concurrency),
      auth: String(s.auth || ''),
    };
  }

  let settings = clean(null);
  try { settings = clean(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); } catch {}
  const listeners = new Set();

  /* ---------- 限流（429 / rate limited）后的共用冷却 ----------
   * 批量下载同时有多首歌在请求 wrapper-lite，一处被限流后其余请求照常发出只会让限流持续、升级
   * （公共 wrapper-lite 超限后先回 `rate limited (concurrency)`，继续超限会被 `banned`）。
   * 所以任何 wrapper-lite 请求被限流时记一次 hit()：设置全局冷却期（优先用 Retry-After，没有则指数退避加抖动），
   * 下载管理器在冷却期内不启动新曲目，冷却后按 limit() 降低有效并发，之后每成功几首（ok()）恢复一级。
   * 同一轮冷却期内同时到达的限流只算一次，不会把级别连续叠高。 */

  const BASE_DELAY = 5000;
  const MAX_DELAY = 120000;
  /** 服务器给出的等待时间也不超过这么久，避免异常值让下载卡死 */
  const MAX_RETRY_AFTER = 600000;
  const MAX_LEVEL = 4;
  /** 冷却结束后连续成功这么多首，级别降低一级 */
  const RECOVER_AFTER = 3;
  const THROTTLED = /\b429\b|rate.?limit|too many requests/i;
  const BANNED = /\bbanned\b/i;
  let level = 0;
  let until = 0;
  let successes = 0;

  const throttle = {
    /** 冷却期还剩多少毫秒（0 表示可以发请求） */
    remaining: () => Math.max(0, until - Date.now()),
    /** 记录一次限流；retryAfterMs 为服务器给出的等待时间，未知时按级别退避（±20% 抖动） */
    hit(retryAfterMs) {
      const now = Date.now();
      if (now >= until) level = Math.min(level + 1, MAX_LEVEL);
      const delay = retryAfterMs > 0
        ? Math.min(retryAfterMs, MAX_RETRY_AFTER) + Math.random() * 1000
        : Math.min(MAX_DELAY, BASE_DELAY * 2 ** (level - 1)) * (0.8 + Math.random() * 0.4);
      until = Math.max(until, now + delay);
      successes = 0;
    },
    /** 等到冷却期结束（等待期间冷却期可能被延长，所以循环再看）；signal 中止时以 signal.reason 拒绝 */
    async wait(signal) {
      for (let ms; (ms = throttle.remaining()) > 0; ) await sleep(ms, signal);
    },
    /** 限流后的有效并发：base 每一级减半，至少 1；base 为 0（不限）时原样返回 */
    limit: (base) => (base > 0 ? Math.max(1, Math.floor(base / 2 ** level)) : base),
    /** 一首歌下载成功：冷却结束后连续成功几首，级别降低一级 */
    ok() {
      if (level && throttle.remaining() === 0 && ++successes >= RECOVER_AFTER) { level--; successes = 0; }
    },
    state: () => ({ level, remaining: throttle.remaining() }),
    /** 恢复初始状态（测试用） */
    reset() { level = 0; until = 0; successes = 0; },
  };

  /** 等待 ms 毫秒；signal（可省略）中止时立即以 signal.reason 拒绝 */
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(signal.reason);
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Retry-After（秒数或 HTTP 日期）→ 毫秒，没有时为 0 */
  function retryAfter(headers) {
    const value = headers && headers.get && headers.get('Retry-After');
    if (!value) return 0;
    if (/^\s*\d+(\.\d+)?\s*$/.test(value)) return Number(value) * 1000;
    const date = Date.parse(value);
    return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
  }

  /**
   * wrapper-lite 请求失败的 Error。HTTP 429、或 msg / 错误文字里有 429 / rate limited / too many requests 视为限流：
   * 带 throttled，并记入全局冷却；banned 带 final（重试没有意义，也不进入冷却）。
   * 服务端转发时 wrapper-lite 的限流可能变成 500 / 502，原因只在 msg 里，所以也看 msg。
   * res：失败的 Response（取 status 与 Retry-After）；msg：响应体里的 msg（没有时省略）
   */
  function failure(message, res, msg) {
    const { status, headers } = res;
    const err = new Error(message);
    const text = `${msg || ''} ${message}`;
    if (BANNED.test(text)) {
      err.final = true;
    } else if (status === 429 || THROTTLED.test(text)) {
      err.throttled = true;
      throttle.hit(retryAfter(headers));
    }
    return err;
  }

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
    try { payload = JSON.parse(text); } catch { throw failure(res.ok ? t('wrapper.invalid') : `wrapper-lite HTTP ${res.status}`, res); }
    if (payload.code !== 0) throw failure(payload.msg || `wrapper-lite HTTP ${res.status}`, res, payload.msg);
    return payload.data;
  }

  /** am-hook 的 JSON 接口：失败时抛出带 msg 的错误 */
  async function serverJson(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.code !== undefined && data.code !== 0)) throw failure(data.msg || `HTTP ${res.status}`, res, data.msg);
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

  /**
   * /webplayback 的 AAC-LC 256 media m3u8 当作变体，字段与 master 的变体相同（GROUP-ID 同 master 的 AAC 256）。
   * 地址带上 #adamId=，文件名里取不到 adamId 时 decrypt.js 用它请求 license
   */
  function webplaybackVariant(adamId, url) {
    const target = new URL(url);
    target.hash = `adamId=${adamId}`;
    return {
      uri: target.pathname.split('/').pop(),
      url: target.href,
      group_id: 'audio-stereo-256',
      audio: '',
      codecs: 'mp4a.40.2',
      bandwidth: 256000,
      channels: '2',
      sample_rate: null,
      bit_depth: null,
      widevine: true,
    };
  }

  /* ---------- 对外接口 ---------- */

  const AmWrapper = {
    get settings() { return { ...settings }; },
    DEFAULTS,
    serverAvailable: SERVER,
    hint: HINT,
    normalizeAuth,
    parseSongMaster,
    throttle,
    sleep,

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

    /**
     * 有些歌曲没有 master m3u8（/m3u8 给出的是整首 .m4p），只有 AAC-LC 256：与参考实现相同，
     * 改用 /webplayback 的 media m3u8（Widevine，见 decrypt.js），作为唯一的变体（widevine: true）返回，masterUrl 为 null。
     * 只有 /m3u8 成功给出非 .m3u8 地址时才这样降级；/m3u8 或 /webplayback 请求失败（HTTP 500、连不上、code 不为 0）
     * 直接抛出错误：这类错误多是临时的（批量下载时尤其常见），交给调用方重试，以免把有 ALAC / Atmos 的歌曲下成 AAC
     */
    async songMaster(adamId, signal) {
      const m3u8 = settings.local
        ? (await localJson(`/m3u8?${query({ adamId })}`, { signal }))?.m3u8
        : (await serverJson(`/parse/song/${encodeURIComponent(adamId)}`, { signal })).data?.masterUrl;
      if (!m3u8) throw new Error(t('wrapper.noMaster'));
      // .m4p 等不是 master（也不要去下载它）
      let master = null;
      try { master = /\.m3u8$/i.test(new URL(m3u8).pathname) ? m3u8 : null; } catch {}
      if (master) {
        // Apple CDN（aod.itunes.apple.com）允许跨源请求，master 与 media m3u8 都直接获取
        const res = await fetch(master, { signal });
        if (!res.ok) throw failure(`master m3u8 HTTP ${res.status}`, res);
        const masterUrl = res.url || master;
        return { masterUrl, variants: parseSongMaster(await res.text(), masterUrl) };
      }
      const url = await AmWrapper.webplayback(adamId, signal);
      if (!url) throw new Error(t('wrapper.noMaster'));
      return { masterUrl: null, variants: [webplaybackVariant(adamId, url)] };
    },

    /** /webplayback 的 m3u8 地址（歌曲为 AAC-LC 256 的 media m3u8，MV 为 master），没有时为 null */
    async webplayback(adamId, signal) {
      const data = settings.local
        ? await localJson(`/webplayback?${query({ adamId })}`, { signal })
        : (await serverJson(`/mv/webplayback/${encodeURIComponent(adamId)}`, { signal })).data;
      return (data && data.m3u8) || null;
    },

    async key(adamId, uri) {
      if (settings.local) return JSON.stringify(await localJson(`/key?${query({ adamId, uri })}`));
      const res = await fetch(`/key?${query({ adamId, uri })}`);
      const text = await res.text();
      if (!res.ok) {
        let msg = '';
        try { msg = JSON.parse(text).msg; } catch {}
        throw failure(msg || `HTTP ${res.status}`, res, msg);
      }
      return text;
    },

    /** script：发音用的文字（如 ko-Hang），空为 wrapper-lite 的默认 en-Latn */
    async lyrics(adamId, language, signal, script) {
      if (!settings.local) {
        const params = query({ language, script });
        const res = await fetch(`/lyrics/${adamId}${params ? `?${params}` : ''}`, { signal });
        if (res.status === 404) return null;
        if (!res.ok) {
          // 服务端把 wrapper-lite 的限流转成 502 / 500，原因只在 msg 里
          const msg = await res.json().then((body) => body && body.msg, () => '');
          throw failure(`HTTP ${res.status}`, res, msg);
        }
        return res.text();
      }
      const { res, text } = await localRequest(`/lyrics?${query({ adamId, language, script })}`, { signal });
      if (res.status === 404) return null;
      let payload;
      try { payload = JSON.parse(text); } catch { throw failure(`wrapper-lite HTTP ${res.status}`, res); }
      // wrapper-lite 以 HTTP 200 + code 404 表示该歌曲没有歌词
      if (payload.code === 404) return null;
      if (payload.code !== 0) throw failure(payload.msg || `wrapper-lite HTTP ${res.status}`, res, payload.msg);
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

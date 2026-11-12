/*
 * AutoMix：按 Apple Music 的音频分析规划两首歌之间的过渡（player.js 的 Mixer 照此执行）。
 *
 * 分析来自 amp-api 的 /v1/catalog/<地区>/songs/<id>/audio-analysis?extend=loudnessCurve,fades（经本站 /amp 代理）：
 *   loudnessCurve.value  响度曲线（dB），每 0.5 秒一个值，每个值是 1 秒的窗口：第 i 个覆盖 [0.5i, 0.5i + 1]，
 *                        个数为 floor(2 × 时长) − 1；
 *   loudness             开头 / 整体 / 结尾的响度（与曲线同一标度）、峰值与动态范围；
 *   beats                每一拍与每小节第一拍的时间（毫秒）；bpm 开头 / 整体 / 结尾的速度；
 *   vocalActivity        人声区间与强度（very-low … very-high）；
 *   fades                淡入 / 淡出区间（多数歌曲只是默认的 0–2 秒与结尾前一段，只作参考）；
 *   energy、danceability、valence、key 等。
 *
 * 规划（plan）只看响度曲线、拍点与人声，结果是一段重叠：
 *   - 上一首的「尾段」：最后一次不低于整体响度 −6 dB 处之后（尾奏、渐弱或最后一个音的余音），到低于 −30 dB（静音）为止；
 *     下一首开头就很响（热启动）时等上一首降到 −12 dB 再进来，免得两首都很响地叠在一起；
 *   - 下一首从第一个有声音的窗口开始（去掉开头的静音），前奏渐强（软启动）时允许更长的重叠，让前奏垫在尾奏下面；
 *   - 下一首的人声出现前上一首必须已经退出，上一首还在唱时先等它唱完；
 *   - 两首的速度接近（含倍速关系）且律动明显时对齐小节：下一首的第一个强拍落在上一首的强拍上，
 *     能变速的播放方式（<audio>）还在重叠期间把下一首微调到上一首的速度（保持音高），之后慢慢回到原速；
 *   - 结尾直接切断且下一首开头就很响（两首连在一起的编排）时不做过渡，按无缝衔接播放；
 *   - 增益：上一首按等功率曲线淡出（下一首软启动时先保持一段），下一首热启动时淡入，软启动时直接全音量。
 * 「交叉淡化」是固定时长的等功率淡化，有分析时同样去掉上一首结尾与下一首开头的静音。
 *
 * 浏览器与 Node（测试）共用：浏览器中为 window.AmAutomix。
 */
(function (global) {
  'use strict';

  /** 响度曲线的步长与窗口长度（秒） */
  const STEP = 0.5;
  const WINDOW = 1;
  const VOCAL_LEVELS = { 'very-low': 0, low: 1, medium: 2, high: 3, 'very-high': 4 };
  /** 算作「在唱」的人声强度（medium 及以上） */
  const STRONG_VOCAL = 2;

  /** 规划用到的阈值（相对整体响度，dB）与时长（秒） */
  const TUNING = {
    body: -6, // 主体：不低于整体响度 −6 dB
    deep: -12, // 下一首热启动时，上一首要先降到这里
    silence: -30, // 低于整体响度 30 dB 视为静音
    hotRise: 1.5, // 下一首从有声音到 −6 dB 不超过这么久：热启动
    softRise: 4, // 超过这么久：软启动（前奏渐强），允许更长的重叠
    hotTail: 1.5, // 上一首最后这么久仍不低于 −8 dB：结尾直接切断
    maxOverlap: 10,
    softMaxOverlap: 14,
    minOverlap: 1.5,
    cutOverlap: 2, // 结尾直接切断时的重叠
    maxEntry: 8, // 下一首开头的静音最多跳过这么久
    stretch: 0.04, // 速度相差 4% 以内才变速对齐
    lockWithoutStretch: 0.012, // 不能变速时，相差 1.2% 以内（重叠期间漂移很小）仍对齐小节
    groove: 0.4, // 律动（danceability）至少这么高才对齐小节
    minTrack: 30, // 太短的曲目不做过渡
    mismatch: 3, // 分析的时长与实际播放的相差超过 3 秒（如全景声混音的长度不同）时不用分析
  };

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const ms = (v) => Number(v) / 1000;

  /** amp-api 的响应（或其中的 data[0]）→ 规划用的分析；没有响度曲线时为 null */
  function normalize(json) {
    const node = json && Array.isArray(json.data) ? json.data[0] : json;
    const a = node && node.attributes;
    if (!a) return null;
    const raw = a.loudnessCurve && a.loudnessCurve.value;
    if (!Array.isArray(raw) || raw.length < 20) return null;
    const curve = Float32Array.from(raw, (v) => (Number.isFinite(Number(v)) ? Number(v) : -70));
    const seconds = (list) => (Array.isArray(list) ? list.map(ms).filter(Number.isFinite).sort((x, y) => x - y) : []);
    const span = (f) => (f && Number.isFinite(f.startInMilliseconds) && Number.isFinite(f.endInMilliseconds)
      ? { start: ms(f.startInMilliseconds), end: ms(f.endInMilliseconds) } : null);
    const triple = (v) => ({ beginning: num(v && v.beginning), main: num(v && v.main), ending: num(v && v.ending) });
    const level = (v) => num(v && v.value);
    const beats = a.beats || {};
    const fades = a.fades || {};
    const loudness = a.loudness || {};
    const bpm = a.bpm || {};
    return {
      curve,
      /** 曲线覆盖的时长（窗口个数 = floor(2 × 时长) − 1） */
      length: (curve.length + 1) * STEP,
      beats: seconds(beats.beatsInMilliseconds),
      bars: seconds(beats.barsInMilliseconds),
      bpm: { ...triple(bpm), deviation: num(bpm.percentDeviation) },
      loudness: { beginning: level(loudness.beginning), main: level(loudness.main), ending: level(loudness.ending) },
      fadeIn: span(fades.fadeIn),
      fadeOut: span(fades.fadeOut),
      vocals: (Array.isArray(a.vocalActivity) ? a.vocalActivity : [])
        .map((v) => ({ start: ms(v.startInMilliseconds), end: ms(v.endInMilliseconds), level: VOCAL_LEVELS[v.strength] ?? STRONG_VOCAL }))
        .filter((v) => Number.isFinite(v.start) && v.end > v.start)
        .sort((x, y) => x.start - y.start),
      energy: triple(a.energy),
      danceability: triple(a.danceability),
      key: a.key || null,
    };
  }

  /** 整体响度：没有时取曲线的中位数 */
  function reference(an) {
    if (an.loudness.main !== null) return an.loudness.main;
    const sorted = Array.from(an.curve).sort((x, y) => x - y);
    return sorted[sorted.length >> 1];
  }

  function lastAbove(curve, threshold) {
    for (let i = curve.length - 1; i >= 0; i--) if (curve[i] >= threshold) return i;
    return -1;
  }

  function firstAbove(curve, threshold) {
    for (let i = 0; i < curve.length; i++) if (curve[i] >= threshold) return i;
    return -1;
  }

  /**
   * 结尾的形状（秒，曲目时间）：body 主体结束、deep 降到 −12 dB、silence 静音开始；
   * hot：直接切断（最后 1.5 秒仍很响，没有余音）
   */
  function ending(an, duration) {
    const ref = reference(an);
    const { curve } = an;
    // 窗口 i 很响而 i + 1 不响：分界大约在 0.5i + 0.75
    const after = (i) => (i < 0 ? 0 : Math.min(duration, i * STEP + 0.75 * WINDOW));
    const silenceIndex = lastAbove(curve, ref + TUNING.silence);
    const silence = silenceIndex < 0 ? duration : Math.min(duration, silenceIndex * STEP + WINDOW);
    const body = Math.min(after(lastAbove(curve, ref + TUNING.body)), silence);
    const deep = Math.min(Math.max(body, after(lastAbove(curve, ref + TUNING.deep))), silence);
    const tailFrom = Math.max(0, Math.floor((duration - TUNING.hotTail - WINDOW) / STEP));
    let tailMin = Infinity;
    for (let i = tailFrom; i < curve.length && i * STEP + WINDOW <= duration + STEP; i++) tailMin = Math.min(tailMin, curve[i]);
    const hot = Number.isFinite(tailMin) && tailMin >= ref - 8 && silence >= duration - WINDOW;
    return { ref, body, deep, silence, hot };
  }

  /**
   * 开头的形状：start 第一个有声音的窗口（从这里开始播放），full 达到 −6 dB；rise = full − start；
   * hot：很快就很响；soft：前奏渐强
   */
  function opening(an) {
    const ref = reference(an);
    const { curve } = an;
    const startIndex = firstAbove(curve, ref + TUNING.silence);
    const start = startIndex < 0 ? 0 : Math.min(TUNING.maxEntry, startIndex * STEP);
    const fullIndex = firstAbove(curve, ref + TUNING.body);
    const full = fullIndex < 0 ? start + 30 : Math.max(start, fullIndex * STEP + WINDOW / 2);
    const rise = full - start;
    return { ref, start, full, rise, hot: rise <= TUNING.hotRise, soft: rise >= TUNING.softRise };
  }

  /** t 前后 span 秒内的拍间隔中位数（秒）；拍点太少时为 null */
  function beatInterval(beats, from, to) {
    const gaps = [];
    for (let i = 1; i < beats.length; i++) {
      if (beats[i - 1] >= from && beats[i] <= to) gaps.push(beats[i] - beats[i - 1]);
    }
    if (gaps.length < 4) return null;
    gaps.sort((x, y) => x - y);
    return gaps[gaps.length >> 1];
  }

  /** 第一个不早于 t 的点；超过 limit 时为 null */
  function firstAfter(list, t, limit) {
    for (const x of list) if (x >= t - 0.02) return x <= limit ? x : null;
    return null;
  }

  function nearest(list, t) {
    let best = null;
    for (const x of list) if (best === null || Math.abs(x - t) < Math.abs(best - t)) best = x;
    return best;
  }

  /** 人声：第一个不早于 from 的强人声开始时间，没有为 null */
  function firstVocal(an, from) {
    for (const v of an.vocals) if (v.level >= STRONG_VOCAL && v.end > from) return Math.max(v.start, from);
    return null;
  }

  /** 人声：[from, to] 内最后一段强人声的结束时间，没有为 null */
  function lastVocalEnd(an, from, to) {
    let end = null;
    for (const v of an.vocals) if (v.level >= STRONG_VOCAL && v.end > from && v.start < to) end = Math.max(end ?? 0, Math.min(v.end, to));
    return end;
  }

  /**
   * 速度关系：下一首要以 rate 倍速播放才与上一首同速（考虑倍速 / 半速）。
   * 返回 { rate, error }（error 为不变速时的相对误差），拍点不够时为 null
   */
  function tempoMatch(out, inc, x0, x1, entry) {
    const outIbi = beatInterval(out.beats, x0 - 12, x1 + 2);
    const inIbi = beatInterval(inc.beats, entry - 1, entry + (x1 - x0) + 12);
    if (!outIbi || !inIbi) return null;
    let best = null;
    for (const k of [1, 2, 0.5]) {
      const rate = (inIbi * k) / outIbi;
      if (rate < 0.5 || rate > 2) continue;
      if (!best || Math.abs(rate - 1) < Math.abs(best.rate - 1)) best = { rate, k };
    }
    return best && { rate: best.rate, error: Math.abs(best.rate - 1), outIbi, inIbi };
  }

  function grooveOf(an, end) {
    const d = an.danceability[end] ?? an.danceability.main;
    return d === null ? 0 : d;
  }

  /** 等功率曲线：envelope 为 { from, to }（混音开始后的秒数），淡出 / 淡入 */
  function fadeOutGain(env, t) {
    if (t <= env.from) return 1;
    if (t >= env.to) return 0;
    return Math.cos((Math.PI / 2) * ((t - env.from) / (env.to - env.from)));
  }

  function fadeInGain(env, t) {
    if (t >= env.to) return 1;
    if (t <= env.from) return 0;
    return Math.sin((Math.PI / 2) * ((t - env.from) / (env.to - env.from)));
  }

  /**
   * 规划一次过渡。
   *   out / inc：两首的分析（normalize 的结果，可为 null）；
   *   options：{ mode: 'automix' | 'crossfade', seconds（交叉淡化时长）, outDuration, inDuration（实际播放的时长，秒）,
   *              stretch（下一首能否变速）}
   * 返回 { kind: 'gapless', reason } 表示不做过渡，或
   *   { kind, x0（上一首的这个时间点开始播放下一首）, x1（上一首在这里静音并停止）, entry（下一首从这里开始播放）,
   *     rate（重叠期间下一首的播放速度）, out / in（增益包络，混音开始后的秒数）, beat（'stretch' / 'lock' / null）, reason }
   */
  function plan(out, inc, options) {
    const { outDuration, inDuration } = options;
    const mode = options.mode === 'crossfade' ? 'crossfade' : 'automix';
    if (!(outDuration > TUNING.minTrack) || !(inDuration > TUNING.minTrack)) return { kind: 'gapless', reason: 'short' };
    // 分析与实际播放的版本长度不同（如全景声混音）：时间点对不上，不用分析
    const usable = (an, d) => an && Math.abs(an.length - d) <= TUNING.mismatch;
    const a = usable(out, outDuration) ? out : null;
    const b = usable(inc, inDuration) ? inc : null;

    if (mode === 'crossfade') {
      const seconds = Math.min(12, Math.max(1, Number(options.seconds) || 6));
      const x1 = a ? ending(a, outDuration).silence : outDuration;
      const x0 = Math.max(outDuration / 2, x1 - seconds);
      const entry = b ? opening(b).start : 0;
      const d = x1 - x0;
      return { kind: 'crossfade', x0, x1, entry, rate: 1, beat: null, out: { from: 0, to: d }, in: { from: 0, to: d }, reason: 'crossfade' };
    }

    if (!a || !b) return { kind: 'gapless', reason: !out || !inc ? 'no-analysis' : 'mismatch' };
    const end = ending(a, outDuration);
    const start = opening(b);
    // 结尾直接切断而下一首一开始就很响：两首是连在一起的，按无缝衔接播放
    if (end.hot && start.hot) return { kind: 'gapless', reason: 'segue' };

    const entry = start.start;
    let x1 = end.silence;
    let x0 = start.hot ? end.deep : end.body;
    const maxOverlap = start.soft ? TUNING.softMaxOverlap : TUNING.maxOverlap;
    let reason = start.hot ? 'tail-hot' : start.soft ? 'tail-soft' : 'tail';
    if (end.hot) {
      x1 = outDuration;
      x0 = outDuration - TUNING.cutOverlap;
      reason = 'cut';
    }
    if (x1 - x0 > maxOverlap) x0 = x1 - maxOverlap;

    // 下一首的人声出现时上一首已经退出（最晚 0.5 秒后）：推迟下一首进来的时间，上一首的结尾保持原样
    const inVocal = firstVocal(b, entry);
    if (inVocal !== null) x0 = Math.max(x0, x1 - (inVocal - entry) - 0.5);
    // 上一首还在唱：等这句唱完
    const outVocal = lastVocalEnd(a, x0, x1);
    if (outVocal !== null && outVocal > x0) x0 = outVocal;
    // 至少留 minOverlap 的重叠
    if (x1 - x0 < TUNING.minOverlap) x0 = x1 - TUNING.minOverlap;

    // 速度接近且律动明显：对齐小节，必要时变速
    let rate = 1;
    let beat = null;
    const tempo = tempoMatch(a, b, x0, x1, entry);
    const groove = Math.min(grooveOf(a, 'ending'), grooveOf(b, 'beginning'));
    if (tempo && groove >= TUNING.groove) {
      if (options.stretch && tempo.error <= TUNING.stretch && tempo.error > 0.002) { rate = tempo.rate; beat = 'stretch'; }
      else if (tempo.error <= TUNING.lockWithoutStretch) beat = 'lock';
    }
    // 下一首的第一个强拍（没有小节信息时为第一拍）落在上一首的强拍 / 拍上
    const anchorIn = firstAfter(b.bars.length ? b.bars : b.beats, entry, entry + 4) ?? firstAfter(b.beats, entry, entry + 2);
    if (anchorIn !== null) {
      const grid = beat && a.bars.length ? a.bars : a.beats;
      const offset = (anchorIn - entry) / rate;
      const target = x0 + offset;
      const hit = nearest(grid, target);
      const ibi = (tempo && tempo.outIbi) || 0.5;
      const reach = beat ? ibi * 2.1 : ibi / 2;
      if (hit !== null && Math.abs(hit - target) <= reach) x0 += hit - target;
    }
    if (x0 > x1 - 1) x0 = Math.max(0, x1 - 1);

    const d = x1 - x0;
    const outEnv = { from: start.hot || end.hot ? 0 : d * 0.3, to: d };
    const inEnv = start.hot || end.hot ? { from: 0, to: Math.min(d, 2.5) } : { from: 0, to: Math.min(d, 0.3) };
    return { kind: 'automix', x0, x1, entry, rate, beat, out: outEnv, in: inEnv, reason };
  }

  /* ---------- 取分析：经本站的 amp-api 代理，按歌曲缓存（失败的记 10 分钟） ---------- */
  const cache = new Map();
  const CACHE_LIMIT = 64;
  const FAIL_TTL = 10 * 60 * 1000;

  /** 某首歌（地区 country 的 adam id）的分析：Promise<分析 | null>，取不到或没有响度曲线时为 null */
  function fetchAnalysis(track, country = 'us', fetchImpl = global.fetch) {
    const key = `${country}:${track}`;
    const hit = cache.get(key);
    if (hit && (!hit.failedAt || Date.now() - hit.failedAt < FAIL_TTL)) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.promise;
    }
    const entry = { failedAt: 0, promise: null };
    const origin = global.location ? global.location.origin : 'http://localhost';
    const url = new URL(`/amp/v1/catalog/${encodeURIComponent(country)}/songs/${encodeURIComponent(track)}/audio-analysis`, origin);
    url.searchParams.set('extend', 'loudnessCurve,fades');
    entry.promise = Promise.resolve()
      .then(() => fetchImpl(url.href))
      .then((response) => {
        if (response.status === 404) return null; // 这首歌没有分析：不再请求
        if (!response.ok) throw new Error(`audio-analysis HTTP ${response.status}`);
        return response.json().then(normalize);
      })
      .catch((err) => {
        entry.failedAt = Date.now();
        console.warn('[am-hook] 取不到音频分析', track, err);
        return null;
      });
    cache.set(key, entry);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return entry.promise;
  }

  /** 专辑 id（albumHref 末尾的数字），没有时为空字符串 */
  function albumOf(entry) {
    const m = entry && /\/(\d+)\/?$/.exec(entry.albumHref || '');
    return m ? m[1] : '';
  }

  const api = { normalize, plan, ending, opening, fadeOutGain, fadeInGain, fetchAnalysis, albumOf, TUNING, STEP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.AmAutomix = api;
})(typeof window !== 'undefined' ? window : globalThis);

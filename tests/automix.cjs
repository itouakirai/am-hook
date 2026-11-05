// AutoMix planner (src/ui/automix.js): node --test tests/automix.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const A = require('../src/ui/automix.js');

/**
 * A synthetic amp-api audio-analysis response for a song of `duration` seconds.
 * level(t) gives the loudness (dB) at time t; the curve has floor(2 × duration) − 1 one-second windows every 0.5 s.
 */
function analysis(duration, level, extra = {}) {
  const n = Math.floor(2 * duration) - 1;
  const curve = Array.from({ length: n }, (_, i) => +level(i * 0.5 + 0.5).toFixed(1));
  const bpm = extra.bpm || 120;
  const beats = [];
  const bars = [];
  const first = extra.firstBeat ?? 0.25;
  for (let t = first, i = 0; t < duration; t += 60 / bpm, i++) {
    beats.push(Math.round(t * 1000));
    if (i % 4 === 0) bars.push(Math.round(t * 1000));
  }
  return {
    data: [{
      id: '1', type: 'audio-analysis',
      attributes: {
        loudness: { main: { value: -10, peak: 0, range: 5 }, beginning: { value: -12 }, ending: { value: -12 } },
        loudnessCurve: { value: curve },
        beats: { beatsInMilliseconds: beats, barsInMilliseconds: bars },
        bpm: { beginning: bpm, ending: bpm, main: bpm, percentDeviation: 0 },
        danceability: { beginning: extra.dance ?? 0.7, ending: extra.dance ?? 0.7, main: extra.dance ?? 0.7 },
        energy: { beginning: 0.6, ending: 0.6, main: 0.6 },
        fades: { fadeIn: { startInMilliseconds: 0, endInMilliseconds: 2000 }, fadeOut: { startInMilliseconds: (duration - 10) * 1000, endInMilliseconds: duration * 1000 } },
        vocalActivity: extra.vocals || [],
      },
    }],
  };
}

const ramp = (t, t0, t1, a, b) => (t <= t0 ? a : t >= t1 ? b : a + ((b - a) * (t - t0)) / (t1 - t0));
/** −10 dB body, then a fade to silence over the last `fade` seconds (song ends at `duration`) */
const fading = (duration, fade) => (t) => ramp(t, duration - fade, duration - 0.5, -9, -60);
/** full level until the very end (cut) */
const cut = (duration) => (t) => (t < duration - 0.3 ? -9 : -70);
/** quiet intro rising to full over `rise` seconds after `silence` seconds of silence */
const intro = (silence, rise) => (t) => (t < silence ? -70 : ramp(t, silence, silence + rise, -32, -9));

test('normalize reads the curve, beats and vocals, and infers the length', () => {
  const an = A.normalize(analysis(200, () => -10, { vocals: [{ startInMilliseconds: 12000, endInMilliseconds: 15000, strength: 'high' }] }));
  assert.equal(an.curve.length, 399);
  assert.equal(an.length, 200);
  assert.equal(an.beats[0], 0.25);
  assert.equal(an.bars.length, Math.ceil(an.beats.length / 4));
  assert.deepEqual(an.vocals, [{ start: 12, end: 15, level: 3 }]);
  assert.equal(an.loudness.main, -10);
  assert.equal(A.normalize({ data: [{ attributes: {} }] }), null, 'no loudness curve');
  assert.equal(A.normalize(null), null);
});

test('the next song comes in over the outgoing fade and the outgoing is gone at silence', () => {
  const out = A.normalize(analysis(200, fading(200, 12), { dance: 0.2 }));
  const inc = A.normalize(analysis(180, intro(1, 6), { dance: 0.2 }));
  const p = A.plan(out, inc, { mode: 'automix', outDuration: 200, inDuration: 180, stretch: true });
  assert.equal(p.kind, 'automix');
  assert.equal(p.reason, 'tail-soft');
  // starts once the fade is under −6 dB (t ≈ 189.6), ends where it falls under −30 dB (t ≈ 195)
  assert(p.x0 > 189 && p.x0 < 191, `x0 ${p.x0}`);
  assert(p.x1 > 194.5 && p.x1 < 196.5, `x1 ${p.x1}`);
  // leading silence skipped (from the start of the first window with sound)
  assert(p.entry >= 0.5 && p.entry <= 1, `entry ${p.entry}`);
  // soft intro: no fade-in, the outgoing holds first
  assert(p.in.to <= 0.3);
  assert(p.out.from > 0);
  assert.equal(p.rate, 1);
  assert.equal(p.beat, null, 'no beat alignment without groove');
});

test('a loud start waits until the outgoing is 12 dB down and fades in', () => {
  const out = A.normalize(analysis(200, fading(200, 12), { dance: 0.2 }));
  const soft = A.plan(out, A.normalize(analysis(180, intro(0, 6), { dance: 0.2 })), { mode: 'automix', outDuration: 200, inDuration: 180 });
  const hot = A.plan(out, A.normalize(analysis(180, () => -9, { dance: 0.2 })), { mode: 'automix', outDuration: 200, inDuration: 180 });
  assert.equal(hot.reason, 'tail-hot');
  // −16 dB at t ≈ 189.6, −22 dB at t ≈ 190.9
  assert(hot.x0 >= soft.x0 + 0.9, `hot ${hot.x0} vs soft ${soft.x0}`);
  assert.equal(hot.out.from, 0);
  assert(hot.in.to > 1);
});

test('a hard cut into a loud start is a segue: no transition', () => {
  const p = A.plan(A.normalize(analysis(200, cut(200))), A.normalize(analysis(180, () => -9)), { mode: 'automix', outDuration: 200, inDuration: 180 });
  assert.deepEqual(p, { kind: 'gapless', reason: 'segue' });
});

test('a hard cut into a soft intro overlaps the last two seconds', () => {
  const p = A.plan(A.normalize(analysis(200, cut(200), { dance: 0.2 })), A.normalize(analysis(180, intro(0, 6), { dance: 0.2 })),
    { mode: 'automix', outDuration: 200, inDuration: 180 });
  assert.equal(p.reason, 'cut');
  assert.equal(p.x1, 200);
  assert(Math.abs(p.x1 - p.x0 - 2) < 0.01);
});

test('vocals never overlap: the next song comes in later when its singer starts right away', () => {
  const out = A.normalize(analysis(200, fading(200, 14), { dance: 0.2 }));
  const quiet = A.normalize(analysis(180, intro(0, 8), { dance: 0.2 }));
  const singing = A.normalize(analysis(180, intro(0, 8), { dance: 0.2, vocals: [{ startInMilliseconds: 1000, endInMilliseconds: 9000, strength: 'very-high' }] }));
  const a = A.plan(out, quiet, { mode: 'automix', outDuration: 200, inDuration: 180 });
  const b = A.plan(out, singing, { mode: 'automix', outDuration: 200, inDuration: 180 });
  // the outgoing ending is kept as is, the overlap is shortened from the front
  assert.equal(b.x1, a.x1);
  assert(b.x1 - b.x0 <= 1.5 + 1e-9, `overlap ${b.x1 - b.x0}`);
  // and the outgoing singer finishes the line first
  const outSinging = A.normalize(analysis(200, fading(200, 14), { dance: 0.2, vocals: [{ startInMilliseconds: 180000, endInMilliseconds: 193000, strength: 'medium' }] }));
  const c = A.plan(outSinging, quiet, { mode: 'automix', outDuration: 200, inDuration: 180 });
  assert(c.x0 >= 193 - 1e-9 || c.x1 - c.x0 <= 1.5 + 1e-9, `x0 ${c.x0}`);
});

test('close tempos with groove: bars are aligned and the next song is stretched to the outgoing tempo', () => {
  const out = A.normalize(analysis(200, fading(200, 12), { bpm: 120, firstBeat: 0.3 }));
  const inc = A.normalize(analysis(180, intro(0, 6), { bpm: 123, firstBeat: 0.1 }));
  const p = A.plan(out, inc, { mode: 'automix', outDuration: 200, inDuration: 180, stretch: true });
  assert.equal(p.beat, 'stretch');
  assert(Math.abs(p.rate - 120 / 123) < 0.002, `rate ${p.rate}`);
  // the incoming first downbeat (0.1 s) lands on an outgoing bar
  const landing = p.x0 + (inc.bars[0] - p.entry) / p.rate;
  const nearestBar = out.bars.reduce((best, b) => (Math.abs(b - landing) < Math.abs(best - landing) ? b : best));
  assert(Math.abs(nearestBar - landing) < 0.01, `lands at ${landing}, bar ${nearestBar}`);

  // without time-stretching (PCM playback) only near-identical tempos are locked
  const fixed = A.plan(out, inc, { mode: 'automix', outDuration: 200, inDuration: 180, stretch: false });
  assert.equal(fixed.rate, 1);
  assert.equal(fixed.beat, null);
  const same = A.plan(out, A.normalize(analysis(180, intro(0, 6), { bpm: 60, firstBeat: 0.1 })), { mode: 'automix', outDuration: 200, inDuration: 180 });
  assert.equal(same.beat, 'lock', 'half tempo counts as the same tempo');
  assert.equal(same.rate, 1);
});

test('crossfade: fixed length, trailing and leading silence trimmed when analysed', () => {
  const out = A.normalize(analysis(200, (t) => (t < 195 ? -9 : -70)));
  const inc = A.normalize(analysis(180, intro(2, 1)));
  const p = A.plan(out, inc, { mode: 'crossfade', seconds: 5, outDuration: 200, inDuration: 180 });
  assert.equal(p.kind, 'crossfade');
  assert(p.x1 > 194.5 && p.x1 < 196, `x1 ${p.x1}`);
  assert(Math.abs(p.x1 - p.x0 - 5) < 1e-9);
  // starts at the first window with sound (window start, so the attack is never clipped)
  assert(p.entry >= 1.5 && p.entry <= 2, `entry ${p.entry}`);
  const blind = A.plan(null, null, { mode: 'crossfade', seconds: 4, outDuration: 200, inDuration: 180 });
  assert.deepEqual([blind.x0, blind.x1, blind.entry], [196, 200, 0]);
});

test('automix falls back to gapless without a usable analysis', () => {
  const an = A.normalize(analysis(200, fading(200, 10)));
  const opts = { mode: 'automix', outDuration: 200, inDuration: 180 };
  assert.equal(A.plan(an, null, opts).reason, 'no-analysis');
  // the playing version is 10 s longer than the analysed one (e.g. a different Atmos mix)
  assert.equal(A.plan(an, A.normalize(analysis(170, () => -9)), opts).reason, 'mismatch');
  assert.equal(A.plan(an, A.normalize(analysis(180, () => -9)), { ...opts, inDuration: 20 }).reason, 'short');
});

test('equal-power gain curves', () => {
  const env = { from: 1, to: 3 };
  assert.equal(A.fadeOutGain(env, 0), 1);
  assert.equal(A.fadeOutGain(env, 3), 0);
  assert(Math.abs(A.fadeOutGain(env, 2) - Math.SQRT1_2) < 1e-12);
  assert.equal(A.fadeInGain({ from: 0, to: 2 }, 0), 0);
  assert.equal(A.fadeInGain({ from: 0, to: 2 }, 2), 1);
  const mid = A.fadeInGain({ from: 0, to: 2 }, 1) ** 2 + A.fadeOutGain({ from: 0, to: 2 }, 1) ** 2;
  assert(Math.abs(mid - 1) < 1e-12, 'constant power');
  assert.equal(A.fadeInGain({ from: 0, to: 0 }, 0), 1);
});

test('album id from albumHref', () => {
  assert.equal(A.albumOf({ albumHref: '/cn/album/1989/1713845538' }), '1713845538');
  assert.equal(A.albumOf({ albumHref: '' }), '');
  assert.equal(A.albumOf(null), '');
});

test('fetchAnalysis requests the catalog through the /amp proxy and caches by song', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/404/')) return { status: 404, ok: false };
    return { status: 200, ok: true, json: async () => analysis(100, () => -9) };
  };
  const a = await A.fetchAnalysis('777', 'cn', fetchImpl);
  const b = await A.fetchAnalysis('777', 'cn', fetchImpl);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/amp\/v1\/catalog\/cn\/songs\/777\/audio-analysis\?extend=loudnessCurve%2Cfades$/);
  assert.equal(await A.fetchAnalysis('404', 'cn', fetchImpl), null);
});

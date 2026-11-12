const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MseEngine } = require('../../web/player/player.js');

function engine() {
  const mse = new MseEngine({ currentTime: 16 });
  Object.assign(mse, {
    playlist: { segments: [
      { time: 0, duration: 14.95365 },
      { time: 14.95365, duration: 15.00009 },
      { time: 29.95374, duration: 15.00009 },
    ] },
    sb: { buffered: { length: 1, start: () => 2.5, end: () => 29.81442 } },
    ms: { readyState: 'open', endOfStream() {} },
    transcoder: {},
    appendedSegments: new Set([0]),
    pendingSegments: new Map(),
    segmentController: new AbortController(),
    pumpSerial: 0,
    seekSerial: 0,
  });
  return mse;
}

test('quota retry finishes the FLAC tail before appending the next segment', async () => {
  const mse = engine();
  const tail = new ArrayBuffer(1);
  const next = new ArrayBuffer(2);
  const appended = [];
  const fetched = [];
  let quotaFull = true;
  mse.pendingSegments.set(1, [tail]);
  mse.fetchRange = async (segment) => { fetched.push(segment); return [next]; };
  mse.append = async (buf) => {
    if (quotaFull) throw new DOMException('full', 'QuotaExceededError');
    appended.push(buf);
  };
  mse.evict = async () => {};
  mse.onError = (err) => { throw err; };

  // The original 0.25s tolerance considers this range complete even though
  // its last 139ms are still queued after a quota failure (song 1421242791).
  assert.equal(mse.isBuffered(mse.playlist.segments[1]), true);
  await mse.pump(0);
  assert.deepEqual(fetched, []);
  assert.deepEqual(mse.pendingSegments.get(1), [tail]);
  assert.equal(mse.appendedSegments.has(1), false);

  // Quota frees up as playback advances; retries wait for that instead of every timeupdate.
  await mse.pump(0);
  assert.deepEqual(appended, []);
  quotaFull = false;
  mse.audio.currentTime += 2;
  await mse.pump(0);
  await new Promise(setImmediate); // pump schedules the next segment itself
  assert.deepEqual(appended, [tail, next]);
  assert.deepEqual(fetched, [mse.playlist.segments[2]]);
  assert.equal(mse.pendingSegments.size, 0);
  assert.equal(mse.appendedSegments.has(1), true);
});

test('completed and already buffered segments still avoid duplicate loads', () => {
  const mse = engine();
  assert.equal(mse.ready(0), true); // previously appended, now partly evicted
  assert.equal(mse.ready(1), true); // already buffered (e.g. after a seek)
  assert.equal(mse.ready(2), false);
  mse.pendingSegments.set(1, [new ArrayBuffer(1)]);
  assert.equal(mse.ready(1), false);
});

test('seeking to the tail still signals EOF to flush the final samples', async () => {
  const mse = engine();
  mse.audio.currentTime = 30;
  mse.appendedSegments = new Set();
  let ended = false;
  mse.ms.endOfStream = () => { ended = true; };
  const tail = new ArrayBuffer(1);
  mse.pendingSegments.set(2, [tail]);
  mse.append = async () => { throw new DOMException('full', 'QuotaExceededError'); };
  mse.evict = async () => {};
  await mse.pump(0);
  assert.equal(ended, false);

  mse.append = async () => {};
  mse.audio.currentTime += 2;
  await mse.pump(0);
  assert.equal(mse.pendingSegments.size, 0);
  assert.equal(ended, true); // unvisited segments before the seek are irrelevant
});

test('high FLAC bitrate shrinks the read-ahead window to fit the quota', () => {
  const mse = engine();
  mse.appendedSegments.add(1);
  assert.equal(mse.target().index, 2); // 14s window reaches the segment at 29.95s
  mse.flacByteRate = 576000; // 96 kHz / 24-bit stereo, nearly verbatim
  assert.equal(mse.flacAhead(mse.playlist.segments[1]), 4);
  assert.equal(mse.target(), null);
  mse.flacByteRate = 100000;
  assert.equal(mse.flacAhead(mse.playlist.segments[1]), 14);
});

test('FLAC appends evict played audio before the browser deletes future audio', async () => {
  const mse = engine();
  mse.sb.updating = false;
  const calls = [];
  mse.sb.remove = (start, end) => { calls.push(['remove', start, end]); };
  mse.remove = async (start, end) => { mse.sb.remove(start, end); };
  mse.append = async () => { calls.push(['append']); };
  mse.fetchRange = async () => [new ArrayBuffer(1)];
  mse.audio.currentTime = 16.5;
  mse.appendedSegments.add(1);
  await mse.pump(0);
  assert.deepEqual(calls[0], ['remove', 0, 14.5]);
  assert.deepEqual(calls[1], ['append']);
  assert.ok(mse.flacByteRate > 0);
});

test('stall at a hole in appended audio re-buffers even with work ahead', () => {
  const mse = engine();
  mse.playlist.duration = 45;
  mse.appendedSegments.add(1); // recorded as appended, but quota GC removed 16s..
  mse.sb.buffered = { length: 1, start: () => 2.5, end: () => 16 };
  let interrupted = false;
  mse.interrupt = () => { interrupted = true; };
  mse.pump = () => assert.fail('pumping ahead cannot fill the hole');
  mse.watchStall(0);
  clearTimeout(mse.stallTimer);
  assert.equal(interrupted, true);
});

test('failed loads back off, ignore timeupdate pumps, and stop after five retries', async () => {
  const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = global;
  const timers = [];
  global.setTimeout = (fn, delay) => timers.push({ fn, delay });
  global.clearTimeout = () => {};
  try {
    const mse = engine();
    let fetches = 0;
    let fail = true;
    mse.fetchRange = async () => { fetches++; if (fail) throw new Error('no available instance'); return [new ArrayBuffer(1)]; };
    mse.append = async () => {};
    mse.evict = async () => {};
    const errors = [];
    mse.onError = (err) => errors.push(err.message);
    let recovered = 0;
    mse.onRecover = () => recovered++;

    await mse.pump(0);
    assert.equal(fetches, 1);
    assert.deepEqual(errors, ['no available instance']);
    // timeupdate while waiting must not bypass the backoff
    await mse.pump(0);
    assert.equal(fetches, 1);

    for (let i = 0; i < 5; i++) {
      const { fn, delay } = timers[i];
      const base = 3000 * 2 ** i;
      assert.ok(delay >= base * 0.8 && delay <= base * 1.2, `retry ${i + 1} waited ${delay}ms`);
      fn();
      await new Promise(setImmediate);
    }
    assert.equal(fetches, 6);
    assert.equal(timers.length, 5);
    assert.equal(mse.gaveUp, true);
    await mse.pump(0);
    assert.equal(fetches, 6);
    assert.equal(errors.length, 1);

    fail = false;
    mse.retryNow();
    await new Promise(setImmediate);
    assert.ok(fetches >= 7);
    assert.equal(mse.failed, false);
    assert.equal(mse.gaveUp, false);
    assert.equal(mse.failures, 0);
    assert.equal(recovered, 1);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MseEngine } = require('../src/ui/player.js');

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

  quotaFull = false;
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
  await mse.pump(0);
  assert.equal(mse.pendingSegments.size, 0);
  assert.equal(ended, true); // unvisited segments before the seek are irrelevant
});

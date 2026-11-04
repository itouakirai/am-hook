const assert = require('node:assert/strict');
const { test } = require('node:test');

const SEGMENT = 15;
const RATE = 48000;

/** 假的 AudioContext：时间由测试推进 */
function fakeContext() {
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } });
  return {
    currentTime: 0,
    destination: {},
    createGain: node,
    createBuffer: () => ({ copyToChannel() {} }),
    createBufferSource: () => ({ connect() {}, disconnect() {}, start() {}, stop() {} }),
    resume: async () => {},
    suspend: async () => {},
    close: async () => {},
  };
}

/**
 * PcmEngine 加上假的计时器、播放列表与解码器。loadFails / decodeFails 为 true 时对应步骤抛错。
 * ticks：引擎 200 ms 定时器的回调；timers：setTimeout 安排的重试
 */
async function setup(t) {
  const saved = { AudioContext: global.AudioContext, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout, setInterval: global.setInterval, clearInterval: global.clearInterval };
  const context = fakeContext();
  global.AudioContext = function AudioContext() { return context; };
  const timers = [];
  const ticks = [];
  global.setTimeout = (fn, delay) => { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer; };
  global.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
  global.setInterval = (fn) => { ticks.push(fn); return fn; };
  global.clearInterval = () => {};
  t.after(() => Object.assign(global, saved));

  const { PcmEngine } = require('../src/ui/player.js');
  const errors = [];
  let recovered = 0;
  const engine = new PcmEngine(() => {}, (err) => errors.push(err.message), () => {});
  await engine.started;
  const state = { loadFails: false, decodeFails: false, loads: 0 };
  engine.onRecover = () => recovered++;
  engine.controller = new AbortController();
  engine.duration = SEGMENT * 4;
  engine.playlist = {
    duration: SEGMENT * 4,
    segments: [0, 1, 2, 3].map((i) => ({ time: i * SEGMENT, duration: SEGMENT })),
    load: async () => {
      state.loads++;
      if (state.loadFails) throw new Error('key request failed');
      return new ArrayBuffer(1);
    },
  };
  engine.decoder = {
    decode: async () => {
      if (state.decodeFails) throw new Error('decoder broken');
      return { channels: 2, rate: RATE, samples: SEGMENT * RATE, chunks: [] };
    },
    flush: async () => {},
    destroy() {},
  };
  // 第一段已排好，正在播放
  engine.nextIndex = 1;
  engine.loadedUntil = SEGMENT;
  engine.channels = 2;
  engine.rate = RATE;
  engine.paused = false;
  engine.anchorTime = 0;
  engine.anchorContextTime = 0;
  const tick = () => ticks[0]();
  const settle = () => new Promise(setImmediate);
  return { engine, context, timers, tick, settle, state, errors, recovered: () => recovered };
}

test('a failed segment or key load keeps playing the buffer, stalls at its end and resumes after the retry', async (t) => {
  const { engine, context, timers, tick, settle, state, errors, recovered } = await setup(t);
  context.currentTime = 4; // 下一段进入预加载范围（当前位置之后 12 秒）
  state.loadFails = true;
  await engine.pump();
  assert.deepEqual(errors, ['key request failed']);
  assert.equal(engine.failed, true);
  assert.equal(engine.retryMode, 'pump');
  assert.equal(engine.paused, false, 'buffered audio keeps playing');
  const delay = timers.at(-1).delay;
  assert.ok(delay >= 2400 && delay <= 3600, `first retry after ${delay}ms`);

  // 定时器的 pump 不能绕过退避
  tick();
  await settle();
  assert.equal(state.loads, 1);

  // 缓冲播完：停下等待
  context.currentTime = SEGMENT;
  tick();
  assert.equal(engine.paused, true);
  assert.equal(engine.stalled, true);

  // 重试仍失败：不再重复报错，退避翻倍
  timers.at(-1).fn();
  await settle();
  assert.equal(state.loads, 2);
  assert.deepEqual(errors, ['key request failed']);
  assert.ok(timers.at(-1).delay >= 4800, `second retry after ${timers.at(-1).delay}ms`);

  // 恢复后自动继续播放
  state.loadFails = false;
  timers.at(-1).fn();
  await settle();
  await settle();
  assert.equal(engine.failed, false);
  assert.equal(engine.failures, 0);
  assert.equal(recovered(), 1);
  assert.equal(engine.stalled, false);
  assert.equal(engine.paused, false);
  assert.ok(engine.nextIndex > 1);
  engine.destroy();
});

test('decoder errors restart from the current position and stop after five retries until retried by hand', async (t) => {
  const { engine, context, timers, settle, state, errors, recovered } = await setup(t);
  context.currentTime = 5;
  state.decodeFails = true;
  await engine.pump();
  assert.deepEqual(errors, ['decoder broken']);
  assert.equal(engine.retryMode, 'seek');
  assert.equal(engine.paused, true);
  assert.equal(engine.anchorTime, 5);

  for (let i = 0; i < 5; i++) {
    timers.at(-1).fn();
    await settle();
    await settle();
  }
  assert.equal(engine.gaveUp, true);
  assert.equal(errors.length, 1);
  const pending = timers.filter((timer) => !timer.cleared && timer.delay >= 3000);
  assert.equal(pending.length, 0);

  // 用户点播放：立即从原位置重新开始并继续播放
  state.decodeFails = false;
  await engine.play();
  await settle();
  assert.equal(engine.failed, false);
  assert.equal(engine.gaveUp, false);
  assert.equal(recovered(), 1);
  assert.equal(engine.paused, false);
  assert.equal(engine.anchorTime, 5);
  engine.destroy();
});

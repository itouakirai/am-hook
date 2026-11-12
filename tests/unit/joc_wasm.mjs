// JOC 对象渲染的浏览器构建（web/joc/joc.wasm，crates/joc-wasm）：离线，只需 Node：
//   node --test tests/joc_wasm.mjs
// 用 crates/joc-core/tests/fixtures 的样本（真实 Atmos 码流的 EMDF 元数据 + 合成的 5.1 床）按 Worker 的方式逐帧送入，
// 输出须与原生参考实现逐位一致（与 crates/joc-core/tests/fixture.rs 相同的摘要），20 组 HRTF 都能加载；
// 另外报告两种模式的实时倍率（JOC_WASM 可指定其他 wasm，比较不同构建的速度）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const wasmPath = process.env.JOC_WASM || new URL('web/joc/joc.wasm', root);
const eac3 = readFileSync(new URL('crates/joc-core/tests/fixtures/joc_fixture.eac3', root));
const SPEAKER_SHA256 = '907b8cca070b5f4e4eb07d63d0a60803eb50e12b13a0012ee62403bef830c13a';
const BINAURAL_SHA256 = '27ff9104fb2691567b6a8fec86def7d2f451e1800ff30ee0369200d7f09d89f9';
const CHANNELS = 6;
const FRAME = 1536;

const frames = [];
for (let offset = 0; offset + 4 <= eac3.length;) {
  const size = ((((eac3[offset + 2] & 0x07) << 8) | eac3[offset + 3]) + 1) * 2;
  frames.push(eac3.subarray(offset, offset + size));
  offset += size;
}
const tones = [440, 554, 659, 880, 110, 55];
const bed = new Float32Array(frames.length * FRAME * CHANNELS);
for (let sample = 0; sample < frames.length * FRAME; sample++) {
  for (let channel = 0; channel < CHANNELS; channel++) {
    bed[sample * CHANNELS + channel] = 0.08 * Math.sin(2 * Math.PI * tones[channel] * (sample / 48000) + channel * 0.3);
  }
}

const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const ex = instance.exports;
const hrtf = (name) => readFileSync(new URL(`web/joc/hrtf/${name}.jochrtf`, root));

function error() {
  return new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ex.joc_error_ptr(), ex.joc_error_len()));
}

function copyIn(bytes) {
  const ptr = ex.joc_alloc(bytes.byteLength);
  new Uint8Array(ex.memory.buffer, ptr, bytes.byteLength).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return ptr;
}

/** 与 joc/decode-worker.js 相同的调用顺序：每帧 push_eac3、push_pcm、flush_pending，再 pull 干净 */
/** hooks: { opened(handle)：打开后（设置交互控制），frame(handle)：每帧 flush_pending 之后（取场景） } */
function render(mode, field, count = frames.length, repeat = 1, hooks = {}) {
  let fieldPtr = 0;
  if (field) fieldPtr = copyIn(field);
  const handle = ex.joc_open(mode, 0, 1, 1473, 5.0, fieldPtr, field ? field.length : 0);
  if (fieldPtr) ex.joc_free(fieldPtr, field.length);
  assert.ok(handle, `joc_open: ${error()}`);
  if (hooks.opened) hooks.opened(handle);
  const pcmPtr = ex.joc_alloc(FRAME * CHANNELS * 4);
  const outPtr = ex.joc_alloc(4096 * 2 * 4);
  const chunks = [];
  try {
    for (let pass = 0; pass < repeat; pass++) {
      if (pass) assert.equal(ex.joc_reset(handle), 0);
      for (let i = 0; i < count; i++) {
        const ptr = copyIn(frames[i]);
        assert.equal(ex.joc_push_eac3(handle, ptr, frames[i].length), 0, error());
        ex.joc_free(ptr, frames[i].length);
        new Float32Array(ex.memory.buffer, pcmPtr, FRAME * CHANNELS).set(bed.subarray(i * FRAME * CHANNELS, (i + 1) * FRAME * CHANNELS));
        assert.equal(ex.joc_push_pcm(handle, pcmPtr, FRAME, CHANNELS), 0, error());
        assert.equal(ex.joc_flush_pending(handle), 0, error());
        if (hooks.frame) hooks.frame(handle);
        for (;;) {
          const produced = ex.joc_pull(handle, outPtr, 4096);
          assert.ok(produced >= 0, error());
          if (!produced) break;
          if (pass === repeat - 1) chunks.push(new Float32Array(ex.memory.buffer, outPtr, produced * 2).slice());
        }
      }
    }
  } finally {
    ex.joc_close(handle);
    ex.joc_free(pcmPtr, FRAME * CHANNELS * 4);
    ex.joc_free(outPtr, 4096 * 2 * 4);
  }
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

const sha256 = (samples) => createHash('sha256').update(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)).digest('hex');

test('Speaker 2.0 与原生参考实现逐位一致', () => {
  const out = render(0, null);
  assert.equal(out.length, frames.length * FRAME * 2);
  assert.equal(sha256(out), SPEAKER_SHA256);
});

test('Binaural（D2）与原生参考实现逐位一致，reset 后从干净的状态重新开始', () => {
  const out = render(1, hrtf('D2'), frames.length, 2);
  assert.equal(out.length, (frames.length * FRAME - 961) * 2);
  assert.equal(sha256(out), BINAURAL_SHA256);
});

test('20 组 HRTF 都能加载并渲染出声音', () => {
  const names = readdirSync(new URL('web/joc/hrtf/', root)).filter((n) => /\.jochrtf$/.test(n));
  assert.equal(names.length, 20);
  for (const name of names) {
    const out = render(1, readFileSync(new URL(`web/joc/hrtf/${name}`, root)), 4);
    assert.ok(out.length > 0, name);
    assert.ok(out.some((v) => v !== 0) && out.every(Number.isFinite), name);
  }
});

test('交互控制（joc_set_controls）与场景（joc_scene）：默认值逐位不变，静音全部对象无声，转头改变输出', () => {
  const SCENE_FLOATS = 64;
  const gainsPtr = ex.joc_alloc(16 * 4);
  const scenePtr = ex.joc_alloc(SCENE_FLOATS * 4);
  const controls = (yaw, x, focus, height, gain) => (handle) => {
    new Float32Array(ex.memory.buffer, gainsPtr, 16).fill(gain);
    assert.equal(ex.joc_set_controls(handle, yaw, 0, 0, x, 0, 0, focus, height, gainsPtr), 0, error());
  };
  try {
    const scenes = [];
    const plain = render(1, hrtf('D2'), frames.length, 1, {
      opened: controls(0, 0, 0, 1, 1),
      frame: (handle) => {
        assert.equal(ex.joc_scene(handle, scenePtr), 1, error());
        scenes.push(new Float32Array(ex.memory.buffer, scenePtr, SCENE_FLOATS).slice());
      },
    });
    assert.equal(sha256(plain), BINAURAL_SHA256);
    const last = scenes.at(-1);
    assert.ok(last.subarray(0, 45).every((v) => Number.isFinite(v) && Math.abs(v) <= 1), 'positions');
    assert.ok(last.subarray(45, 61).some((v) => v > 1e-3), 'levels');
    assert.deepEqual([...last.subarray(61)], [0, 0, 0]);

    const muted = render(1, hrtf('D2'), frames.length, 1, { opened: controls(0, 0, 0, 1, 0) });
    assert.ok(muted.every((v) => Math.abs(v) < 1e-6), 'every source muted');

    const turned = render(1, hrtf('D2'), frames.length, 1, { opened: controls(Math.PI / 2, 1, 0.5, 2, 1) });
    assert.notEqual(sha256(turned), BINAURAL_SHA256);
    assert.ok(turned.every(Number.isFinite) && turned.some((v) => Math.abs(v) > 0.01));

    // Speaker 2.0 没有交互控制与场景
    render(0, null, 2, 1, {
      opened: controls(1, 0, 0, 1, 1),
      frame: (handle) => assert.equal(ex.joc_scene(handle, scenePtr), 0),
    });
  } finally {
    ex.joc_free(gainsPtr, 16 * 4);
    ex.joc_free(scenePtr, SCENE_FLOATS * 4);
  }
});

test('无效的 HRTF 报错而不是崩溃', () => {
  const junk = new Uint8Array(1024).fill(7);
  const ptr = copyIn(junk);
  const handle = ex.joc_open(1, 0, 1, 1473, 5.0, ptr, junk.length);
  ex.joc_free(ptr, junk.length);
  assert.equal(handle, 0);
  assert.match(error(), /hrtf/i);
});

test('实时倍率', () => {
  const field = hrtf('D2');
  const seconds = (frames.length * FRAME) / 48000;
  const rates = {};
  for (const [name, mode, data] of [['speaker', 0, null], ['binaural', 1, field]]) {
    render(mode, data); // 预热
    const started = performance.now();
    render(mode, data, frames.length, 4);
    rates[name] = ((seconds * 4) / ((performance.now() - started) / 1000)).toFixed(1);
  }
  console.log(`joc.wasm 实时倍率：Speaker 2.0 ${rates.speaker}x，Binaural ${rates.binaural}x`);
  assert.ok(Number(rates.binaural) > 1, 'binaural rendering is slower than real time');
});

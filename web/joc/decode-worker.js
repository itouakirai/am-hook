/*
 * E-AC-3 JOC（Dolby Atmos）解码与渲染 Worker（module Worker，由 player.js 的 JocDecoder 使用）。
 * 同一个线程里完成全部计算：am-hook 的 EC-3 解码器（ec3.wasm）输出 5.1/7.1 核心 PCM，
 * JOC 渲染器（joc.wasm，crates/joc-wasm）从同一批 syncframe 的 EMDF 中解析 JOC / OAMD 元数据，
 * 重建 15 个对象与 LFE，再渲染为 Speaker 2.0 或双耳立体声。
 *
 * 主线程每次发一个已解密的 fMP4 分段，收到交错的立体声 Float32Array 与本段的峰值。
 * Seek 是 reset + 预滚（前 skipFrames 帧不输出），与参考实现的流式 API 相同。
 * Worker 在曲目之间复用：open 关闭旧的流并重启 EC-3 解码器，两个 wasm 与 HRTF 不必重新加载。
 *
 * 低延迟模式（open 带 port，AudioWorklet 可用时）：分段只拆出 syncframe 排队，按 joc/output-worklet.js 报回的播放进度
 * 逐帧渲染，只比播放位置提前约 0.1 秒，头部朝向、站位、独奏等交互控制（controls）立刻听得到。渲染好的立体声经 port
 * 直接交给 AudioWorklet（不经主线程），主线程只收 primed / scene / peak / error 事件。
 */
import createEc3 from '/assets/ec3/runtime.mjs';

/** 已编译的 HRTF 场（SADIE II，Apache-2.0）；地址写成字面量，服务端与 build-static.mjs 才会换成内容哈希地址 */
const HRTF_URLS = {
  D1: '/assets/joc/hrtf/D1.jochrtf',
  D2: '/assets/joc/hrtf/D2.jochrtf',
  H3: '/assets/joc/hrtf/H3.jochrtf',
  H4: '/assets/joc/hrtf/H4.jochrtf',
  H5: '/assets/joc/hrtf/H5.jochrtf',
  H6: '/assets/joc/hrtf/H6.jochrtf',
  H7: '/assets/joc/hrtf/H7.jochrtf',
  H8: '/assets/joc/hrtf/H8.jochrtf',
  H9: '/assets/joc/hrtf/H9.jochrtf',
  H10: '/assets/joc/hrtf/H10.jochrtf',
  H11: '/assets/joc/hrtf/H11.jochrtf',
  H12: '/assets/joc/hrtf/H12.jochrtf',
  H13: '/assets/joc/hrtf/H13.jochrtf',
  H14: '/assets/joc/hrtf/H14.jochrtf',
  H15: '/assets/joc/hrtf/H15.jochrtf',
  H16: '/assets/joc/hrtf/H16.jochrtf',
  H17: '/assets/joc/hrtf/H17.jochrtf',
  H18: '/assets/joc/hrtf/H18.jochrtf',
  H19: '/assets/joc/hrtf/H19.jochrtf',
  H20: '/assets/joc/hrtf/H20.jochrtf',
};
/** JOC 的滤波器组、OAMD 时间轴与 HRTF 都按 48 kHz 设计（Apple Music 的 Atmos 均为 48 kHz） */
const RATE = 48000;
const PULL_FRAMES = 4096;
/** Seek 的预滚：与参考实现相同，从目标前 64 个 syncframe 开始解码；更早的样本不解码直接丢掉 */
const PREROLL_SAMPLES = 64 * 1536;
/** 一个分段（Apple Music 约 15 秒）分批渲染，每批约 0.75 秒先发回主线程排进 Web Audio，开始播放与 Seek 不必等整段 */
const BATCH_PACKETS = 24;
/** 低延迟模式比播放位置提前渲染的帧数：起始约 96 ms，播放端断粮时每次加一个 syncframe，最多约 0.4 秒 */
const LIVE_TARGET = 3 * 1536;
const LIVE_MAX_TARGET = 12 * 1536;
/** joc_scene 写出的 float 数（crates/joc-wasm 的 SCENE_FLOATS）：15 个对象的位置、16 路电平与听者站位 */
const SCENE_FLOATS = 64;

let ec3Promise = null;
let ec3 = null;
let ctx = 0;
let jocPromise = null;
let joc = null;
let handle = 0;
/** 输出前要丢掉的帧数（Seek 的预滚） */
let pendingSkip = 0;
/** 常驻缓冲：核心 PCM（交错）、渲染输出、送入的 syncframe */
let pcmPtr = 0;
let pcmCapacity = 0;
let outPtr = 0;
let scratchPtr = 0;
let scratchCapacity = 0;
/** 最近用过的一组 HRTF（换曲时同一组不重新下载） */
let hrtfCache = null;
/** reset / open / close / abort 时加一：进行中的分段在下一批之前发现已过时就停下，Seek 不必等它解完 */
let epoch = 0;
/**
 * 低延迟模式的状态：{ port, queue（待渲染的 syncframe）, sent / played（本轮发出 / 已播放的帧数）, target, out（本轮输出的帧数）,
 * inputEnded, ended, primed, running, scene（主线程要不要场景）, peakAt }；普通模式为 null
 */
let live = null;
/** 交互控制（双耳）：头部朝向（弧度）、站位（米）、聚焦、高度倍率与 16 路增益；新打开的流照此设置 */
const controls = { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0, focus: 0, height: 1, gains: new Float32Array(16).fill(1) };
let gainsPtr = 0;
let scenePtr = 0;

// 两批之间让出线程，排在后面的 abort / reset 消息才能先处理（MessageChannel 没有 setTimeout 的最小间隔）
const yielder = new MessageChannel();
const yieldQueue = [];
yielder.port1.onmessage = () => yieldQueue.shift()();
function yieldToMessages() {
  return new Promise((resolve) => { yieldQueue.push(resolve); yielder.port2.postMessage(0); });
}

/** E-AC-3 syncframe 头部的样本数（numblkscod：1/2/3/6 个 256 样本的块；fscod = 3 时固定 6 块） */
function frameSamples(packet) {
  if (packet.length < 5 || packet[0] !== 0x0b || packet[1] !== 0x77) return 1536;
  const fscod = packet[4] >> 6;
  const numblkscod = fscod === 3 ? 3 : (packet[4] >> 4) & 3;
  return [1, 2, 3, 6][numblkscod] * 256;
}

function boxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let p = start; p + 8 <= end;) {
    let size = view.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    let header = 8;
    if (size === 1) { size = Number(view.getBigUint64(p + 8)); header = 16; }
    else if (size === 0) size = end - p;
    if (size < header || p + size > end) throw new Error(`Invalid MP4 ${type} box`);
    out.push({ type, start: p, body: p + header, end: p + size });
    p += size;
  }
  return out;
}

function child(bytes, parent, type) {
  const result = boxes(bytes, parent.body, parent.end).find((box) => box.type === type);
  if (!result) throw new Error(`Missing MP4 ${type} box`);
  return result;
}

function top(bytes, type) { return child(bytes, { body: 0, end: bytes.length }, type); }

/** fMP4 分段中的 EC-3 样本（与 ec3/decode-worker.js 相同）；每个样本是同一时刻全部子流的 syncframe */
function samplesFromFragment(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moof = top(bytes, 'moof');
  const traf = child(bytes, moof, 'traf');
  const tfhd = child(bytes, traf, 'tfhd');
  const flags = view.getUint32(tfhd.body) & 0xffffff;
  let cursor = tfhd.body + 8;
  if (flags & 0x01) cursor += 8;
  if (flags & 0x02) cursor += 4;
  const defaultSize = flags & 0x10 ? view.getUint32(cursor + (flags & 0x08 ? 4 : 0)) : 0;
  const out = [];
  let nextData = top(bytes, 'mdat').body;
  for (const trun of boxes(bytes, traf.body, traf.end).filter((box) => box.type === 'trun')) {
    const runFlags = view.getUint32(trun.body) & 0xffffff;
    const count = view.getUint32(trun.body + 4);
    if (count > 100000) throw new Error('Too many EC-3 samples');
    let pos = trun.body + 8;
    let data = nextData;
    if (runFlags & 0x01) { data = moof.start + view.getInt32(pos); pos += 4; }
    if (runFlags & 0x04) pos += 4;
    for (let i = 0; i < count; i++) {
      if (runFlags & 0x100) pos += 4;
      const size = runFlags & 0x200 ? view.getUint32(pos) : defaultSize;
      if (runFlags & 0x200) pos += 4;
      if (runFlags & 0x400) pos += 4;
      if (runFlags & 0x800) pos += 4;
      if (!size || pos > trun.end || data < 0 || data + size > bytes.length) throw new Error('Invalid EC-3 sample range');
      out.push(bytes.subarray(data, data + size));
      data += size;
    }
    nextData = data;
  }
  if (!out.length) throw new Error('No EC-3 samples in fragment');
  return out;
}

async function loadEc3() {
  if (!ec3Promise) {
    ec3Promise = fetch('/assets/ec3/ec3.wasm').then(async (response) => {
      if (!response.ok) throw new Error(`EC-3 WASM HTTP ${response.status}`);
      const module = await createEc3({ wasmBinary: new Uint8Array(await response.arrayBuffer()) });
      const wrap = (name, args) => module.cwrap(name, 'number', args);
      return {
        module,
        open: wrap('init_decoder', ['number']),
        packet: wrap('configure_decode_packet', ['number', 'number']),
        decode: wrap('decode_packet', ['number', 'bigint']),
        format: wrap('get_decoded_format', ['number']),
        plane: wrap('get_decoded_plane_ptr', ['number', 'number']),
        channels: wrap('get_decoded_channels', ['number']),
        rate: wrap('get_decoded_sample_rate', ['number']),
        count: wrap('get_decoded_sample_count', ['number']),
        close: wrap('close_decoder', ['number']),
      };
    });
    ec3Promise.catch(() => { ec3Promise = null; });
  }
  ec3 = await ec3Promise;
}

async function loadJoc() {
  if (!jocPromise) {
    jocPromise = fetch('/assets/joc/joc.wasm').then(async (response) => {
      if (!response.ok) throw new Error(`JOC WASM HTTP ${response.status}`);
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      return instance.exports;
    });
    jocPromise.catch(() => { jocPromise = null; });
  }
  joc = await jocPromise;
  if (!outPtr) {
    pcmCapacity = 8 * 1536;
    pcmPtr = alloc(pcmCapacity * 4);
    outPtr = alloc(PULL_FRAMES * 2 * 4);
    gainsPtr = alloc(16 * 4);
    scenePtr = alloc(SCENE_FLOATS * 4);
  }
}

function alloc(length) {
  const ptr = joc.joc_alloc(length);
  if (!ptr) throw new Error('JOC WASM allocation failed');
  return ptr;
}

/** 送入 syncframe 用的常驻缓冲，不够时换一块更大的 */
function scratch(length) {
  if (length > scratchCapacity) {
    if (scratchPtr) joc.joc_free(scratchPtr, scratchCapacity);
    scratchPtr = 0;
    scratchCapacity = Math.max(length, 8192);
    scratchPtr = alloc(scratchCapacity);
  }
  return scratchPtr;
}

function jocError() {
  const text = new TextDecoder().decode(new Uint8Array(joc.memory.buffer, joc.joc_error_ptr(), joc.joc_error_len()));
  return text || 'JOC renderer error';
}

function check(status) {
  if (status < 0) throw new Error(jocError());
  return status;
}

/** 新的位置（换曲或 Seek）：EC-3 解码器的重叠状态属于旧位置，重新打开，预滚帧重建它 */
function restartEc3() {
  if (ctx) ec3.close(ctx);
  ctx = ec3.open(1); // 1 = E-AC-3
  if (!ctx) throw new Error('Cannot open the EC-3 decoder');
}

async function hrtfBytes(dataset) {
  if (hrtfCache && hrtfCache.dataset === dataset) return hrtfCache.bytes;
  const response = await fetch(HRTF_URLS[dataset]);
  if (!response.ok) throw new Error(`HRTF ${dataset} HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  hrtfCache = { dataset, bytes };
  return bytes;
}

/**
 * options: { mode: 'speaker' | 'binaural', gainDb, dataset, controls, port, live }。
 * port（MessagePort，接 joc/output-worklet.js）进入低延迟模式；之后重新打开（换模式或 HRTF）带 live: true 沿用它
 */
async function open(options) {
  close();
  if (options.port) attachLive(options.port);
  else if (!options.live) detachLive();
  if (options.controls) setControls(options.controls);
  const mine = epoch;
  await Promise.all([loadEc3(), loadJoc()]);
  const binaural = options.mode === 'binaural';
  const dataset = Object.hasOwn(HRTF_URLS, options.dataset) ? options.dataset : 'D2';
  let field = null;
  if (binaural) field = await hrtfBytes(dataset);
  // 加载期间又来了 open / close / abort（换曲或连续切换模式）：这次打开已经没用了。之后到返回都是同步的，不会再交错
  if (mine !== epoch) throw new DOMException('JOC stream was replaced while opening', 'AbortError');
  let fieldPtr = 0;
  if (field) {
    fieldPtr = alloc(field.length);
    new Uint8Array(joc.memory.buffer, fieldPtr, field.length).set(field);
  }
  // profile 1 = mid（参考实现的默认），对象延迟 1473 样本，结束时最多保留 5 秒房间尾音
  handle = joc.joc_open(binaural ? 1 : 0, Number(options.gainDb) || 0, 1, 1473, 5.0, fieldPtr, field ? field.length : 0);
  if (fieldPtr) joc.joc_free(fieldPtr, field.length);
  if (!handle) {
    const message = jocError();
    if (binaural) hrtfCache = null; // 不缓存无效的 HRTF
    throw new Error(binaural ? `Binaural HRTF ${dataset} unavailable: ${message}` : message);
  }
  restartEc3();
  pendingSkip = 0;
  applyControls();
  if (live) restartLive();
  return { mode: binaural ? 'binaural' : 'speaker', dataset, live: Boolean(live) };
}

/** 合并主线程发来的控制项（只带变了的字段也可以）并交给渲染器 */
function setControls(patch) {
  for (const key of ['yaw', 'pitch', 'roll', 'x', 'y', 'z', 'focus', 'height']) {
    if (Number.isFinite(patch[key])) controls[key] = patch[key];
  }
  if (patch.gains && patch.gains.length === 16) controls.gains.set(patch.gains);
  applyControls();
}

function applyControls() {
  if (!handle) return;
  new Float32Array(joc.memory.buffer, gainsPtr, 16).set(controls.gains);
  const c = controls;
  check(joc.joc_set_controls(handle, c.yaw, c.pitch, c.roll, c.x, c.y, c.z, c.focus, c.height, gainsPtr));
}

function attachLive(port) {
  detachLive();
  live = {
    port, queue: [], sent: 0, played: 0, target: LIVE_TARGET, out: 0,
    inputEnded: false, ended: false, primed: false, running: false, scene: false, peakAt: -Infinity,
  };
  const state = live;
  // 播放端每播约 1024 帧报一次进度；断粮（starved）时加大提前量
  port.onmessage = ({ data }) => {
    if (live !== state || data.epoch !== epoch) return;
    state.played = data.played;
    if (data.starved && state.target < LIVE_MAX_TARGET) state.target += 1536;
    pumpLive();
  };
}

function detachLive() {
  if (!live) return;
  live.port.onmessage = null;
  live.port.close();
  live = null;
}

/** 新的一轮（打开或 Seek）：清空队列与计数，播放端丢掉旧的音频并等主线程的 start */
function restartLive() {
  Object.assign(live, { queue: [], sent: 0, played: 0, out: 0, inputEnded: false, ended: false, primed: false, peakAt: -Infinity });
  live.port.postMessage({ epoch, flush: true });
}

/** 低延迟模式的 decode：只拆出 syncframe 排队 */
function queueFragment(buffer) {
  if (!handle) throw new Error('JOC stream is not open');
  const packets = samplesFromFragment(new Uint8Array(buffer));
  for (const packet of packets) live.queue.push(packet);
  pumpLive();
  return { queued: packets.length };
}

/**
 * 按需渲染：预滚阶段全速（每 8 帧让出一次），之后只渲染到比播放位置提前 target 帧，每帧之间让出线程，
 * 控制项与进度消息随时插进来。Seek（reset）在让出期间清空队列，循环接着处理新的一轮
 */
async function pumpLive() {
  const state = live;
  if (!state || state.running || !handle) return;
  state.running = true;
  try {
    let since = 0;
    while (live === state && handle) {
      if (state.queue.length) {
        const prerolling = pendingSkip > 0;
        if (!prerolling && state.sent - state.played >= state.target) break;
        const packet = state.queue.shift();
        const length = frameSamples(packet);
        if (pendingSkip - length >= PREROLL_SAMPLES) {
          pendingSkip -= length;
          continue;
        }
        const chunks = [];
        const stats = { peak: 0, over: 0 };
        decodePacket(packet, chunks, stats);
        sendLive(state, chunks, stats);
        if (++since >= (prerolling ? 8 : 1)) {
          since = 0;
          await yieldToMessages();
        }
      } else if (state.inputEnded && !state.ended) {
        // 输入结束：取出渲染器留着的帧（双耳内核的 961 个样本与房间尾音），播放端放完就停，不算断粮
        state.ended = true;
        check(joc.joc_flush(handle));
        pendingSkip = 0;
        const chunks = [];
        const stats = { peak: 0, over: 0 };
        drain(chunks, stats);
        sendLive(state, chunks, stats);
        state.port.postMessage({ epoch, end: true });
        if (!state.primed) {
          state.primed = true;
          self.postMessage({ event: 'primed', epoch });
        }
      } else {
        break;
      }
    }
  } catch (error) {
    if (live === state) self.postMessage({ event: 'error', epoch, error: error.message || String(error) });
  } finally {
    state.running = false;
  }
}

/** 渲染好的立体声交给播放端；第一批到了通知主线程（primed），需要时附上这一帧的对象场景，削波最多每秒报一次 */
function sendLive(state, chunks, stats) {
  if (!chunks.length) return;
  const frames = joinChunks(chunks);
  const samples = frames.length / 2;
  state.port.postMessage({ epoch, frames }, [frames.buffer]);
  state.sent += samples;
  state.out += samples;
  if (!state.primed) {
    state.primed = true;
    self.postMessage({ event: 'primed', epoch });
  }
  if (stats.peak > 1 && state.out - state.peakAt >= RATE) {
    state.peakAt = state.out;
    self.postMessage({ event: 'peak', peak: stats.peak });
  }
  if (state.scene && check(joc.joc_scene(handle, scenePtr))) {
    const data = new Float32Array(joc.memory.buffer, scenePtr, SCENE_FLOATS).slice();
    self.postMessage({ event: 'scene', epoch, at: state.out, lead: state.sent - state.played, data }, [data.buffer]);
  }
}

function close() {
  epoch++;
  if (handle) joc.joc_close(handle);
  handle = 0;
  pendingSkip = 0;
}

/** 取出渲染器里已经算好的立体声，按 pendingSkip 丢掉预滚部分，并统计峰值与超过满刻度的样本数 */
function drain(chunks, stats) {
  for (;;) {
    const produced = check(joc.joc_pull(handle, outPtr, PULL_FRAMES));
    if (!produced) return;
    const skip = Math.min(pendingSkip, produced);
    pendingSkip -= skip;
    if (skip === produced) continue;
    const frames = new Float32Array(joc.memory.buffer, outPtr + skip * 8, (produced - skip) * 2).slice();
    for (let i = 0; i < frames.length; i++) {
      const value = Math.abs(frames[i]);
      if (value > stats.peak) stats.peak = value;
      if (value > 1) stats.over++;
    }
    chunks.push(frames);
  }
}

function joinChunks(chunks) {
  const out = new Float32Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/**
 * 解一个分段：每 BATCH_PACKETS 个样本把已渲染的立体声作为 part 发回（onPart），之间让出线程；
 * 期间收到 abort / reset / open 就停下，返回 { aborted: true }
 */
async function decodeFragment(buffer, onPart) {
  if (!handle) throw new Error('JOC stream is not open');
  const mine = epoch;
  const packets = samplesFromFragment(new Uint8Array(buffer));
  let chunks = [];
  let stats = { peak: 0, over: 0 };
  let samples = 0;
  const flush = () => {
    if (!chunks.length) return;
    const frames = joinChunks(chunks);
    samples += frames.length / 2;
    onPart({ rate: RATE, samples: frames.length / 2, frames, peak: stats.peak, over: stats.over });
    chunks = [];
    stats = { peak: 0, over: 0 };
  };
  for (let index = 0; index < packets.length; index++) {
    const packet = packets[index];
    // Seek 的目标还远：只有最后 64 个 syncframe 用来重建状态，更早的不必解码
    const length = frameSamples(packet);
    if (pendingSkip - length >= PREROLL_SAMPLES) {
      pendingSkip -= length;
      continue;
    }
    decodePacket(packet, chunks, stats);
    if ((index + 1) % BATCH_PACKETS === 0 && index + 1 < packets.length) {
      flush();
      await yieldToMessages();
      if (mine !== epoch || !handle) return { aborted: true };
    }
  }
  flush();
  return { rate: RATE, samples };
}

function decodePacket(packet, chunks, stats) {
  const ptr = ec3.packet(ctx, packet.length);
  if (!ptr) throw new Error('EC-3 packet allocation failed');
  ec3.module.HEAPU8.set(packet, ptr);
  const result = ec3.decode(ctx, 0n);
  if (result < 0) throw new Error(`EC-3 decode failed (${result})`);
  if (ec3.format(ctx) !== 8) throw new Error('EC-3 decoder returned non-planar float PCM');
  const n = ec3.count(ctx);
  const ch = ec3.channels(ctx);
  if (ch !== 6 && ch !== 8) throw new Error(`Unsupported EC-3 channel count ${ch}`);
  if (ec3.rate(ctx) !== RATE) throw new Error(`JOC rendering needs 48 kHz E-AC-3, got ${ec3.rate(ctx)} Hz`);
  if (n < 1 || n * ch > pcmCapacity) throw new Error(`Unexpected EC-3 frame size ${n}`);

  // 平面 PCM -> 交错（JOC 的核心 PCM 接口），声道顺序与解码器相同，由比特流的声道映射决定各声道的用途
  const pcm = new Float32Array(joc.memory.buffer, pcmPtr, n * ch);
  for (let c = 0; c < ch; c++) {
    const plane = ec3.plane(ctx, c);
    if (!plane) throw new Error('Missing EC-3 PCM plane');
    const source = new Float32Array(ec3.module.HEAPU8.buffer, plane, n);
    for (let s = 0; s < n; s++) pcm[s * ch + c] = source[s];
  }
  const at = scratch(packet.length);
  new Uint8Array(joc.memory.buffer, at, packet.length).set(packet);
  check(joc.joc_push_eac3(handle, at, packet.length));
  check(joc.joc_push_pcm(handle, pcmPtr, n, ch));
  // 一个 MP4 样本包含该时刻全部子流的 syncframe：样本边界就是帧边界，可以直接渲染这一帧
  check(joc.joc_flush_pending(handle));
  drain(chunks, stats);
}

/** 输入结束：取出渲染器还留着的帧（双耳内核延迟的 961 个样本，以及房间尾音） */
function finish() {
  if (!handle) return { rate: RATE, samples: 0, frames: new Float32Array(0), peak: 0, over: 0 };
  check(joc.joc_flush(handle));
  const chunks = [];
  const stats = { peak: 0, over: 0 };
  pendingSkip = 0;
  drain(chunks, stats);
  const frames = joinChunks(chunks);
  return { rate: RATE, samples: frames.length / 2, frames, peak: stats.peak, over: stats.over };
}

self.onmessage = async ({ data }) => {
  try {
    let result;
    let transfer = [];
    switch (data.op) {
      case 'open':
        result = await open(data);
        break;
      case 'decode':
        if (live) {
          result = queueFragment(data.buf);
          break;
        }
        result = await decodeFragment(data.buf, (part) => {
          self.postMessage({ id: data.id, ok: true, part: true, result: part }, [part.frames.buffer]);
        });
        break;
      case 'abort':
        // Seek 开始：让进行中的分段在下一批之前停下（reset 随后才到）；低延迟模式不再渲染排着的旧位置
        epoch++;
        if (live) live.queue = [];
        break;
      case 'reset':
        if (!handle) throw new Error('JOC stream is not open');
        epoch++;
        check(joc.joc_reset(handle));
        restartEc3();
        pendingSkip = Math.max(0, Math.round(Number(data.skipFrames)) || 0);
        if (live) restartLive();
        break;
      case 'gain':
        if (handle) check(joc.joc_set_gain(handle, Number(data.gainDb) || 0));
        break;
      case 'controls':
        setControls(data.controls || {});
        break;
      case 'scene':
        // 声场界面打开时才每帧发场景
        if (live) live.scene = Boolean(data.on);
        break;
      case 'finish':
        if (live) {
          live.inputEnded = true;
          pumpLive();
          break;
        }
        result = finish();
        transfer = [result.frames.buffer];
        break;
      case 'close':
        close();
        detachLive();
        break;
      default:
        throw new Error(`Unknown JOC worker operation ${data.op}`);
    }
    if (data.id) self.postMessage({ id: data.id, ok: true, result }, transfer);
  } catch (error) {
    if (data.id) self.postMessage({ id: data.id, ok: false, error: error.message || String(error) });
  }
};

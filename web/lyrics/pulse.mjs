/*
 * 歌词背景的节拍律动：从正在播放的声音里取低频的起音（底鼓、贝斯），每帧给出 0..1 的律动强度，
 * 由两种背景各自表现（AMLL 流动背景的 setLowFreqVolume，封面动态背景照 YouLyPlus 放大、转动并加速环绕）。
 *
 * 只旁路取样，从不改变播放的路径（YouLyPlus 用 createMediaElementSource 把 <audio> 整个改走 AudioContext，
 * 上下文挂起时就没有声音，且一经改接不能复原）：
 *   PCM 播放（EC-3、JOC）  AmPlayer.pulseSource() 给出其上下文里音量调节前的混音节点，分析节点直接挂在它旁边，
 *                          与音量无关，也不增加输出；
 *   MSE 播放（AAC、ALAC 等） <audio>.captureStream() 截取一份，在单独的上下文里分析，元素自己的输出不受影响；
 *                          不支持 captureStream 的浏览器（Safari、Firefox）没有律动。
 * 分析的声音要过上下文的输出延迟才听得到（Android 上 'playback' 约 0.3 秒），律动按这个延迟推后，与听到的同步。
 */

// 低通取低频，电平取最近 2048 个样本（约 43 ms）的均方根；窗口再短，低音的波形本身就让电平起伏不定
const LOWPASS_HZ = 150;
const FFT_SIZE = 2048;
// 电平（dBFS）低于此值视为静音
const GATE_DB = -60;
// 起音：电平高出它近 0.2 秒平均值的 dB 数（持续的低音很快被平均值追上，不算起音）。
// 按近期最大的起音归一化（2.5 秒内衰减，至少 4 dB），只取超过其 40% 的部分，音量与混音的响度都不影响律动的幅度
const AVERAGE = 0.2;
const PEAK_DECAY = 2.5;
const PEAK_MIN = 4;
const THRESHOLD = 0.4;
// 输出包络：起音约 12 ms、回落约 0.14 秒
const ATTACK = 0.012;
const RELEASE = 0.14;
const MAX_DELAY = 0.5;
// 两次分析至少相隔 12 ms：背景最多每秒画 60 帧（AMLL）或 40 帧（封面动态背景），高刷新率屏幕上多算的帧画不出来；
// 包络按时间计算，间隔不同不改变律动的样子
const MIN_INTERVAL = 12;

const approach = (value, target, dt, tau) => value + (target - value) * (1 - Math.exp(-dt / tau));

export class BeatPulse {
  constructor() {
    this.source = null;
    this.tap = null;
    /** MSE 截取用的上下文（只建一个，不用时挂起）与各 <audio> 的截取流 */
    this.captureContext = null;
    this.streams = new WeakMap();
    this.reset();
  }

  reset() {
    this.average = null;
    this.peak = PEAK_MIN;
    this.value = 0;
    this.history = [];
    this.last = 0;
    this.output = 0;
  }

  /**
   * 每帧调用：source 为 AmPlayer.pulseSource()（AudioNode 或 <audio>），不播放时传 null；now 为毫秒时间戳。
   * 返回延迟补偿后的律动强度
   */
  update(source, now) {
    if (this.last && now - this.last < MIN_INTERVAL) return this.output;
    const dt = this.last ? Math.min(0.1, Math.max(0, (now - this.last) / 1000)) : 0;
    this.last = now;
    if (source !== this.source) this.attach(source);
    const level = this.level();
    let target = 0;
    if (level !== null && level > GATE_DB) {
      this.average = this.average === null ? level : approach(this.average, level, dt, AVERAGE);
      const onset = level - this.average;
      this.peak = Math.max(PEAK_MIN, onset, this.peak * Math.exp(-dt / PEAK_DECAY));
      target = Math.min(1, Math.max(0, (onset - THRESHOLD * this.peak) / ((1 - THRESHOLD) * this.peak)));
    }
    this.value = approach(this.value, target, dt, target > this.value ? ATTACK : RELEASE);
    this.output = this.delayed(now);
    return this.output;
  }

  /** 停止取样并释放分析节点（界面关闭或被盖住时）；律动归零 */
  stop() {
    this.attach(null);
    this.reset();
  }

  /** 按分析所在上下文的输出延迟推后：取 delay 秒之前那一帧的值 */
  delayed(now) {
    const context = this.tap && this.tap.analyser.context;
    const delay = context ? Math.min(MAX_DELAY, (context.baseLatency || 0) + (context.outputLatency || 0)) * 1000 : 0;
    const history = this.history;
    history.push(now, this.value);
    while (history.length > 2 && history[2] <= now - delay) history.splice(0, 2);
    return history[0] <= now - delay ? history[1] : 0;
  }

  /** 当前低频电平（dBFS）；还没有可分析的声音时为 null */
  level() {
    const tap = this.tap;
    if (!tap) return null;
    if (tap.stream && !this.follow(tap)) return null;
    tap.analyser.getFloatTimeDomainData(tap.data);
    let sum = 0;
    for (const sample of tap.data) sum += sample * sample;
    return 10 * Math.log10(sum / tap.data.length + 1e-12);
  }

  attach(source) {
    if (this.tap) {
      const { input, filter } = this.tap;
      try { input?.disconnect(filter); } catch { /* 上下文已关闭（换了播放方式） */ }
      this.tap = null;
    }
    this.source = source;
    this.average = null;
    if (!source) return;
    try {
      if (typeof AudioNode !== 'undefined' && source instanceof AudioNode) this.tap = this.makeTap(source.context, source);
      else if (typeof source.captureStream === 'function') this.tap = this.capture(source);
    } catch (error) {
      console.warn('[am-hook] 节拍律动取样失败', error);
    }
    // 截取用的上下文不用时挂起，不空转输出设备
    const context = this.captureContext;
    if (context && !this.tap?.stream && context.state === 'running') context.suspend().catch(() => {});
  }

  makeTap(context, input) {
    // 先混成单声道再滤波（立体声、5.1 不必逐声道滤波）；分析器本来就混成单声道，结果相同
    const filter = new BiquadFilterNode(context, {
      type: 'lowpass', frequency: LOWPASS_HZ, Q: Math.SQRT1_2, channelCount: 1, channelCountMode: 'explicit',
    });
    const analyser = new AnalyserNode(context, { fftSize: FFT_SIZE, smoothingTimeConstant: 0 });
    filter.connect(analyser);
    input?.connect(filter);
    return { input, filter, analyser, data: new Float32Array(FFT_SIZE) };
  }

  /** <audio> 的截取：换源后流里会新增音轨（addtrack），follow() 届时接上新的音轨 */
  capture(element) {
    if (!this.captureContext) {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      this.captureContext = new Context({ latencyHint: 'playback' });
    }
    let stream = this.streams.get(element);
    if (!stream) {
      stream = element.captureStream();
      stream.addEventListener('addtrack', () => { if (this.tap?.stream === stream) this.tap.stale = true; });
      this.streams.set(element, stream);
    }
    const tap = this.makeTap(this.captureContext, null);
    tap.stream = stream;
    tap.track = null;
    tap.stale = true;
    return tap;
  }

  follow(tap) {
    if (tap.stale || tap.track?.readyState === 'ended') {
      tap.stale = false;
      // Chrome 换源后旧音轨不会结束（之后一直无声），新的音轨加在后面：取最后一条，停掉旧的（只停截取，不影响播放）
      const tracks = tap.stream.getAudioTracks().filter((item) => item.readyState === 'live');
      const track = tracks.pop() || null;
      for (const old of tracks) { old.stop(); tap.stream.removeTrack(old); }
      if (track !== tap.track) {
        try { tap.input?.disconnect(); } catch { /* 已断开 */ }
        tap.track = track;
        tap.input = track ? new MediaStreamAudioSourceNode(this.captureContext, { mediaStream: new MediaStream([track]) }) : null;
        tap.input?.connect(tap.filter);
      }
    }
    const context = this.captureContext;
    if (context.state === 'suspended' && !this.resuming) {
      this.resuming = true;
      context.resume().catch(() => {}).finally(() => { this.resuming = false; });
    }
    return !!tap.input && context.state === 'running';
  }
}

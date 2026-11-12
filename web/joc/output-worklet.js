/*
 * JOC 低延迟播放的输出端（AudioWorklet，由 player.js 的 JocLiveEngine 加载）。
 * joc/decode-worker.js 经 MessagePort 直接送来渲染好的交错立体声（每个 syncframe 一块），这里按顺序播放，
 * 每播约 1024 帧把进度报回 Worker，Worker 据此只比播放位置提前约 0.1 秒渲染，交互控制很快就听得到。
 *
 * 一轮（打开或 Seek）以 Worker 的 flush（带 epoch）开始，旧轮的音频与消息按 epoch 丢掉；
 * 主线程排好时钟后发 start（上下文时间），之前保持静音。没数据可播（断粮）时输出静音，把缺的帧数报给主线程，
 * 主线程整体顺延时钟；Worker 送来 end（曲目结束）之后的静音不算断粮。
 */
const REPORT_FRAMES = 1024;
/** 断粮的帧数攒到这么多（或恢复出声）再报给主线程 */
const STALL_REPORT_FRAMES = 2048;

class JocOutput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.worker = null;
    this.epoch = -1;
    this.queue = [];
    this.offset = 0;
    this.played = 0;
    this.reported = 0;
    this.startAt = Infinity;
    /** 主线程的 start 可能比 Worker 的 flush 先到（两条通道），先记下 */
    this.pendingStart = null;
    this.ended = false;
    this.hungry = false;
    this.stall = 0;
    this.closed = false;
    this.port.onmessage = ({ data }) => {
      if (data.port) {
        this.worker = data.port;
        this.worker.onmessage = (event) => this.receive(event.data);
      } else if (data.start !== undefined) {
        if (data.epoch === this.epoch) this.startAt = data.start;
        else this.pendingStart = data;
      } else if (data.close) {
        this.closed = true;
      }
    };
  }

  receive(data) {
    if (data.flush) {
      this.epoch = data.epoch;
      this.queue = [];
      this.offset = 0;
      this.played = 0;
      this.reported = 0;
      this.ended = false;
      this.hungry = false;
      this.stall = 0;
      this.startAt = this.pendingStart && this.pendingStart.epoch === data.epoch ? this.pendingStart.start : Infinity;
      this.pendingStart = null;
      return;
    }
    if (data.epoch !== this.epoch) return;
    if (data.end) this.ended = true;
    else this.queue.push(data.frames);
  }

  process(inputs, outputs) {
    if (this.closed) return false;
    const [left, right] = outputs[0];
    const n = left.length;
    if (currentTime + n / sampleRate <= this.startAt) return true;
    // start 落在这一块中间：前面保持静音
    let i = currentTime < this.startAt ? Math.min(n, Math.round((this.startAt - currentTime) * sampleRate)) : 0;
    let wrote = false;
    while (i < n && this.queue.length) {
      const chunk = this.queue[0];
      const count = Math.min(n - i, chunk.length / 2 - this.offset);
      for (let k = 0, at = this.offset * 2; k < count; k++, at += 2) {
        left[i + k] = chunk[at];
        right[i + k] = chunk[at + 1];
      }
      i += count;
      this.offset += count;
      this.played += count;
      wrote = true;
      if (this.offset * 2 >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    const starved = i < n && !this.ended;
    if (starved) this.stall += n - i;
    if (wrote) this.hungry = false;
    if (this.worker && (this.played - this.reported >= REPORT_FRAMES || (starved && !this.hungry))) {
      this.reported = this.played;
      this.worker.postMessage({ epoch: this.epoch, played: this.played, starved });
      if (starved) this.hungry = true;
    }
    if (this.stall && (this.stall >= STALL_REPORT_FRAMES || !starved)) {
      this.port.postMessage({ stall: this.stall });
      this.stall = 0;
    }
    return true;
  }
}

registerProcessor('joc-output', JocOutput);

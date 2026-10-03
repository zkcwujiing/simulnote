/**
 * PCM 采集 AudioWorklet。
 *
 * 职责：把麦克风音频（通常是 48kHz 立体声）降采样为 16kHz 单声道 Float32，
 * 并按固定帧长（默认 1600 采样 = 100ms）通过 port 抛给主线程。
 *
 * 降采样用线性插值 + 相位累加器，跨 process() 调用保持相位连续，避免帧边界爆音。
 * 这里刻意不做低通滤波：语音识别对 8kHz 以上的折叠噪声不敏感，而 IIR 状态
 * 会引入延迟。若实测发现高频混叠影响识别率，再补一个简单的二阶巴特沃斯。
 *
 * 本文件放在 public/ 下由 URL 加载，不参与打包 —— AudioWorklet 必须在独立
 * 全局作用域里用 addModule() 加载，走 bundler 反而要额外处理产物路径。
 */

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};

    this.targetRate = opts.targetRate || 16000;
    this.frameSize = opts.frameSize || 1600;

    // sampleRate 是 AudioWorkletGlobalScope 的全局量，等于当前 AudioContext 的采样率。
    this.ratio = sampleRate / this.targetRate;

    /** 待输出的 16kHz 缓冲 */
    this.out = new Float32Array(this.frameSize);
    this.outLen = 0;

    /** 上一个 process() 块的最后两个采样，用于跨块插值 */
    this.prev = 0;
    this.hasPrev = false;

    /** 当前块内的读取位置（以「虚拟数组」为坐标系，见 process()） */
    this.pos = 0;

    /** 静音开关：用于「暂停采集但保持音频图存活」 */
    this.muted = false;

    this.overruns = 0;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'mute') {
        this.muted = !!data.value;
      } else if (data.type === 'reset') {
        this.outLen = 0;
        this.pos = 0;
        this.hasPrev = false;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // 只取第一个声道。单声道麦克风时 input.length 恒为 1。
    const channel = input[0];
    if (!channel || channel.length === 0) return true;
    const n = channel.length;

    // 虚拟数组下标约定：索引 0 表示 prev（上一块最后一个采样），索引 1..n 表示本块。
    // 这样插值的左右邻点永远落在同一条连续时间轴上。
    const last = channel[n - 1];
    const first = this.hasPrev ? this.prev : channel[0];

    const sampleAt = (index) => {
      if (index <= 0) return first;
      if (index >= n) return last;
      return channel[index - 1];
    };

    let cursor = this.pos;

    while (cursor < n) {
      const base = Math.floor(cursor);
      const frac = cursor - base;
      const s0 = sampleAt(base);
      const s1 = sampleAt(base + 1);

      this.out[this.outLen++] = s0 + (s1 - s0) * frac;

      if (this.outLen === this.frameSize) {
        if (!this.muted) {
          // 必须 transfer（第二个参数给 transfer list 的代价是缓冲被移交，
          // 所以要给它一份拷贝；这里用 slice 让主线程拿到独立的 ArrayBuffer）。
          this.port.postMessage(this.out.slice(0));
        }
        this.outLen = 0;
      }

      cursor += this.ratio;
    }

    // 下一块的坐标系零点：cursor 相对本块的偏移量（负值表示欠采样，即上采样场景）。
    this.pos = cursor - n;
    this.prev = last;
    this.hasPrev = true;

    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);

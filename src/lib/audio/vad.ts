/**
 * 能量法语音端点检测（VAD）+ 说话段切分。
 *
 * 为什么不用 Silero VAD：
 *  - 它要么走 onnxruntime-web（额外 ~2MB wasm + 模型下载），要么依赖某家云服务；
 *  - 本项目的场景是「单人单向长讲」，环境噪声相对稳定，能量法 + 自适应噪声底
 *    已经足够可靠，而且是零下载、零依赖、可在任何手机浏览器跑。
 *  如果 M2 实测在嘈杂环境下断句质量不可接受，再引入 Silero VAD 作为可选增强。
 *
 * 设计要点：
 *  - 自适应噪声底：只在对数能量低于「噪声底 + 阈值」时更新噪声底，避免把持续
 *    人声学成噪声。
 *  - 预滚（pre-roll）：把判定为起点之前的一小段音频也纳入，否则「第一字被吃掉」
 *    —— hayamimi 用 0.8s 预滚，我们用 0.3s，因为 Web Speech 路径不受影响，
 *    本路径主要服务本地 Whisper。
 *  - 强制切分：连续讲话超过 maxSpeechMs 时切一刀，避免单个 utterance 无限增长
 *    导致本地模型显存/内存爆掉；切分不丢音频（刀口后面的音频继续累积）。
 */

export interface Utterance {
  /** 16kHz 单声道采样 */
  samples: Float32Array;
  /** 会话开始到本段起点的毫秒数 */
  startMs: number;
  /** 会话开始到本段终点的毫秒数 */
  endMs: number;
  /** 该段是否因为超长而被强制切分（true 表示后面还有属于同一句话的音频） */
  forced: boolean;
}

export interface SegmenterOptions {
  /** 高于噪声底多少 dB 视为语音 */
  speechThresholdDb?: number;
  /** 判定「确实开始说话」所需的连续语音帧数（抑制咔哒声） */
  startFrames?: number;
  /** 判定「一句话结束」所需的连续静音时长 */
  endSilenceMs?: number;
  /** 低于此长度的段直接丢弃（清嗓子、椅子响） */
  minSpeechMs?: number;
  /** 超过此长度强制切一刀 */
  maxSpeechMs?: number;
  /** 起点前保留的音频时长 */
  preRollMs?: number;
}

interface ResolvedOptions extends Required<SegmenterOptions> {}

const DEFAULTS: ResolvedOptions = {
  speechThresholdDb: 9,
  startFrames: 3,
  endSilenceMs: 700,
  minSpeechMs: 320,
  maxSpeechMs: 15000,
  preRollMs: 300,
};

/** 帧的均方根转 dBFS；全零帧返回 -100 而不是 -Infinity，便于比较。 */
export function frameDb(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / Math.max(1, frame.length));
  if (rms < 1e-7) return -100;
  return 20 * Math.log10(rms);
}

/**
 * 逐帧喂入，吐出「整句」。无状态之外的副作用，方便单元测试。
 */
export class UtteranceSegmenter {
  private opts: ResolvedOptions;

  /** 自适应噪声底（dBFS），初始给一个保守值 */
  private noiseFloorDb = -60;

  private speechRun = 0;
  private silenceRun = 0;
  private inSpeech = false;

  /** 预滚环形缓冲（保留最近 preRollMs 的帧） */
  private preRoll: Float32Array[] = [];
  private preRollFrames: number;

  /** 当前段已累积的音频块 */
  private acc: Float32Array[] = [];
  private accSamples = 0;

  /** 会话已处理的音频总时长（毫秒），用于给段落打时间戳 */
  private elapsedMs = 0;
  /** 当前段的起点（毫秒） */
  private segmentStartMs = 0;

  private readonly frameMs: number;

  constructor(opts: SegmenterOptions = {}, sampleRate = 16000, frameSize = 1600) {
    this.opts = { ...DEFAULTS, ...opts };
    this.frameMs = (frameSize / sampleRate) * 1000;
    this.preRollFrames = Math.max(1, Math.round(this.opts.preRollMs / this.frameMs));
  }

  /** 当前噪声底，调试用 */
  get noiseFloor(): number {
    return this.noiseFloorDb;
  }

  /**
   * 喂入一帧 16kHz 单声道 Float32。
   * 返回非 null 表示刚刚切出一个完整的说话段。
   */
  push(frame: Float32Array): Utterance | null {
    const db = frameDb(frame);
    const isSpeech = db > this.noiseFloorDb + this.opts.speechThresholdDb;

    // --- 噪声底跟踪 ---
    // 只有在「静音」时才更新，且上升极慢（0.01）、下降稍快（0.05），
    // 这样空调噪声突然出现时不会立刻把语音判定门槛抬高。
    if (!isSpeech) {
      const alpha = db < this.noiseFloorDb ? 0.05 : 0.01;
      this.noiseFloorDb = this.noiseFloorDb * (1 - alpha) + db * alpha;
    }

    if (!this.inSpeech) {
      // 维护预滚缓冲
      this.preRoll.push(frame);
      if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();

      if (isSpeech) {
        this.speechRun++;
        if (this.speechRun >= this.opts.startFrames) {
          this.inSpeech = true;
          this.silenceRun = 0;
          // 把预滚里的音频回灌，时间戳相应提前
          const head = this.preRoll.splice(0, this.preRoll.length);
          this.acc = head;
          this.accSamples = head.reduce((n, f) => n + f.length, 0);
          this.segmentStartMs = Math.max(0, this.elapsedMs + this.frameMs - this.accSamples / 16);
        }
      } else {
        this.speechRun = 0;
      }
      this.elapsedMs += this.frameMs;
      return null;
    }

    // --- 说话中 ---
    this.acc.push(frame);
    this.accSamples += frame.length;
    this.elapsedMs += this.frameMs;

    const speechMs = (this.accSamples / 16000) * 1000;

    if (!isSpeech) {
      this.silenceRun++;
      if (this.silenceRun * this.frameMs >= this.opts.endSilenceMs) {
        // 静音够长 → 收尾。裁掉尾部静音，只留 2 帧自然尾音让落字不突兀。
        const tailKeep = 2;
        const dropFrames = this.silenceRun - tailKeep;
        if (dropFrames > 0 && dropFrames <= this.acc.length) {
          this.acc.splice(this.acc.length - dropFrames, dropFrames);
          this.accSamples -= dropFrames * (this.acc[0]?.length ?? frame.length);
          if (this.accSamples < 0) this.accSamples = 0;
        }
        const out = this.flush(false, speechMs);
        if (out) return out;
      }
    } else {
      this.silenceRun = 0;
    }

    // 超长强制切分：不清空累积（保持相位连续），只吐出当前这一刀。
    if (this.inSpeech && speechMs >= this.opts.maxSpeechMs) {
      return this.flush(true, speechMs);
    }

    return null;
  }

  /**
   * 结束采集时调用：把还在缓冲区里的音频强行收尾。
   */
  drain(): Utterance | null {
    if (!this.inSpeech || this.accSamples === 0) {
      this.reset();
      return null;
    }
    return this.flush(false, (this.accSamples / 16000) * 1000);
  }

  private flush(forced: boolean, speechMs: number): Utterance | null {
    const samples = concatFloat32(this.acc, this.accSamples);
    const startMs = this.segmentStartMs;
    const endMs = startMs + (samples.length / 16000) * 1000;

    if (forced) {
      // 强制切分：吐出去的音频不再保留，新段从下一帧开始。
      this.acc = [];
      this.accSamples = 0;
      this.silenceRun = 0;
      this.segmentStartMs = this.elapsedMs;
      return samples.length > 0 ? { samples, startMs, endMs, forced: true } : null;
    }

    // 正常收尾：回到「未说话」状态
    this.inSpeech = false;
    this.speechRun = 0;
    this.silenceRun = 0;
    this.acc = [];
    this.accSamples = 0;
    this.preRoll = [];
    this.segmentStartMs = this.elapsedMs;

    if (speechMs < this.opts.minSpeechMs) return null;
    return { samples, startMs, endMs, forced: false };
  }

  private reset() {
    this.acc = [];
    this.accSamples = 0;
    this.speechRun = 0;
    this.silenceRun = 0;
    this.inSpeech = false;
  }
}

export function concatFloat32(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

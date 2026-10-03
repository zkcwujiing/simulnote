/**
 * 本地 Whisper（transformers.js + onnxruntime-web）语音识别。
 *
 * 定位：**隐私模式 / 无网可用 / 浏览器没有原生识别的兜底**。
 * 与原生识别的取舍：
 *  - 优点：音频完全不出设备；离线可用；识别质量对小模型来说相当好。
 *  - 代价：首次要下 40–80MB 量化模型；手机上单句解码 0.5–2s，
 *    因此**不做逐字草稿**（supportsPartial=false），只在每句话说完后出结果。
 *
 * 模型选择策略：候选表依次尝试。HF 上模型改名/下架是常态，
 * 硬编码单一 id 迟早会让整个应用变砖 —— 这是同类项目常见的坑。
 */

import type { FinalSegment } from '@/types';
import type {
  AsrEngine,
  AsrHandlers,
  EngineAvailability,
  ProgressFn,
  UtteranceAudio,
} from '../types';
import { log } from '@/lib/logger';
import { configureOrtWasm, type OrtDtype } from '@/lib/ortEnv';
import { isLikelyMobile } from '@/lib/device';

/** 按「小 → 稍大」排列；先用最小的把流程跑通，用户可在设置里升级。 */
export interface WhisperModelSpec {
  id: string;
  label: string;
  approxBytes: number;
  /** .en 模型只认英文，不能传 language/task */
  englishOnly: boolean;
}

export const WHISPER_MODELS: WhisperModelSpec[] = [
  { id: 'Xenova/whisper-tiny.en', label: 'Whisper Tiny（英文，~45MB）', approxBytes: 45 * 1024 * 1024, englishOnly: true },
  { id: 'onnx-community/whisper-tiny.en', label: 'Whisper Tiny（英文·社区版，~45MB）', approxBytes: 45 * 1024 * 1024, englishOnly: true },
  { id: 'Xenova/whisper-base.en', label: 'Whisper Base（英文，~80MB）', approxBytes: 80 * 1024 * 1024, englishOnly: true },
  { id: 'Xenova/whisper-tiny', label: 'Whisper Tiny（多语言，~45MB）', approxBytes: 45 * 1024 * 1024, englishOnly: false },
];

type TranscriberOutput = { text: string };
type TranscriberFn = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<TranscriberOutput | TranscriberOutput[]>;

/** 可被 dispose() 释放的 pipeline 对象 */
interface DisposablePipeline {
  dispose?: () => Promise<void> | void;
}

export interface WhisperAsrOptions {
  /** 指定模型；不传则按 WHISPER_MODELS 顺序尝试 */
  modelId?: string;
  /** 强制设备；默认自动（桌面有 WebGPU 用 WebGPU，手机一律 WASM） */
  device?: 'webgpu' | 'wasm';
  /** 强制权重精度；默认 webgpu→fp32、wasm→q8 */
  dtype?: OrtDtype;
  /** 会话语言；模型为多语言时生效 */
  language?: string;
}

export class TransformersWhisperAsrEngine implements AsrEngine {
  readonly id = 'asr-whisper-local';
  readonly label = '本地 Whisper 模型';
  readonly stage = 'asr' as const;
  readonly privacy = 'on-device' as const;

  readonly audioSource = 'external' as const;
  readonly supportsPartial = false;
  readonly supportsReplay = true;

  private transcriber: TranscriberFn | null = null;
  private pipelineRef: DisposablePipeline | null = null;
  private handlers: AsrHandlers | null = null;
  private active = false;
  private seq = 0;

  /** 串行队列：onnxruntime 的同一个 session 并发调用会互相踩内存 */
  private queue: Promise<void> = Promise.resolve();

  private resolvedModel: WhisperModelSpec | null = null;
  private readonly options: WhisperAsrOptions;

  constructor(options: WhisperAsrOptions = {}) {
    this.options = options;
  }

  get modelLabel(): string {
    return this.resolvedModel?.label ?? '未加载';
  }

  /** 上一次解码耗时（毫秒），用于 UI 预估 */
  lastInferenceMs = 0;

  async probe(): Promise<EngineAvailability> {
    if (typeof WebAssembly === 'undefined') {
      return { status: 'unavailable', reason: '此浏览器不支持 WebAssembly。' };
    }
    if (!window.isSecureContext) {
      return { status: 'unavailable', reason: '加载本地模型需要 HTTPS 或 localhost 环境。' };
    }
    if (this.transcriber) return { status: 'ready' };

    const spec = this.resolveCandidate();
    return {
      status: 'downloadable',
      bytes: spec.approxBytes,
      note: `${spec.label}${this.hasWebGpu() ? '（将使用 WebGPU 加速）' : '（使用 CPU/WASM）'}`,
    };
  }

  private hasWebGpu(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  private resolveCandidate(): WhisperModelSpec {
    if (this.options.modelId) {
      const found = WHISPER_MODELS.find((m) => m.id === this.options.modelId);
      return found ?? {
        id: this.options.modelId,
        label: this.options.modelId,
        approxBytes: 45 * 1024 * 1024,
        englishOnly: this.options.modelId.endsWith('.en'),
      };
    }
    return WHISPER_MODELS[0];
  }

  async init(onProgress?: ProgressFn): Promise<void> {
    if (this.transcriber) return;

    const { pipeline, env } = await import('@huggingface/transformers');

    // 模型一律走 HF Hub 远程拉取 + 浏览器 Cache API 缓存。
    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    // 若构建时外置了 ORT 的 wasm（Cloudflare Pages 有 25MiB 单文件上限），
    // 这里把基址交给 ORT。不设 VITE_ORT_WASM_BASE 时是空操作。
    configureOrtWasm(env);

    // WebGPU 只在**桌面**上开：手机上 WebGPU 跑 Whisper 的显存/内存占用是 GB 级，
    // 属于 docs/07 的 R1（手机内存不足）。手机上宁可慢，也不能白屏。
    const device = this.options.device ?? (this.hasWebGpu() && !isLikelyMobile() ? 'webgpu' : 'wasm');
    // WebGPU 后端对 int8 算子支持不完整，用 fp32；WASM 用 q8 把体积和内存压下来。
    const dtype = this.options.dtype ?? (device === 'webgpu' ? 'fp32' : 'q8');

    const candidates = this.options.modelId
      ? [this.resolveCandidate()]
      : WHISPER_MODELS;

    const failures: string[] = [];

    for (const spec of candidates) {
      try {
        onProgress?.({
          progress: null,
          label: `正在加载 ${spec.label}`,
          loadedBytes: 0,
          totalBytes: spec.approxBytes,
        });

        const instance = await pipeline('automatic-speech-recognition', spec.id, {
          device,
          dtype,
          progress_callback: (info: {
            status?: string;
            file?: string;
            progress?: number;
            loaded?: number;
            total?: number;
          }) => {
            if (!onProgress) return;
            if (info.status === 'progress') {
              onProgress({
                progress: typeof info.progress === 'number' ? info.progress / 100 : null,
                label: `正在下载 ${spec.label}`,
                loadedBytes: info.loaded ?? 0,
                totalBytes: info.total ?? spec.approxBytes,
              });
            } else if (info.status === 'ready') {
              onProgress({
                progress: 1,
                label: `${spec.label} 已就绪`,
                loadedBytes: spec.approxBytes,
                totalBytes: spec.approxBytes,
              });
            }
          },
        });

        this.pipelineRef = instance as unknown as DisposablePipeline;
        this.transcriber = instance as unknown as TranscriberFn;
        this.resolvedModel = spec;
        log.info('asr', `本地 Whisper 就绪 model=${spec.id} device=${device} dtype=${dtype}`);
        return;
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        failures.push(`${spec.id}: ${message}`);
        log.warn('asr', `模型 ${spec.id} 加载失败，尝试下一个候选`, err);
      }
    }

    throw new Error(
      `本地语音识别模型全部加载失败。请检查网络后重试，或改用浏览器原生识别。\n${failures.join('\n')}`,
    );
  }

  async start(handlers: AsrHandlers): Promise<void> {
    this.handlers = handlers;
    this.active = true;
    this.seq = 0;
    // 注意：这里刻意不调用 init()。加载模型必须发生在用户手势里，
    // 由管线在「开始」按钮的调用栈中显式 await init()，否则移动端 Safari
    // 可能拒绝创建较大的 WASM 堆。
  }

  /**
   * 管线切好一句话后调用。本方法立即返回，解码在内部队列里排队。
   */
  feed(audio: UtteranceAudio): void {
    if (!this.active) return;
    const handlers = this.handlers;
    const transcriber = this.transcriber;
    if (!handlers || !transcriber) {
      handlers?.onError(new Error('本地识别模型尚未就绪。'));
      return;
    }

    this.queue = this.queue
      .then(async () => {
        if (!this.active) return;
        // 丢弃过短或过长的音频
        const seconds = audio.samples.length / 16000;
        if (seconds < 0.25) return;
        if (seconds > 30) {
          log.warn('asr', `音频过长（${seconds.toFixed(1)}s），截断到 30s`);
        }

        const started = performance.now();
        const options: Record<string, unknown> = {
          chunk_length_s: 30,
          stride_length_s: 5,
        };
        if (this.resolvedModel && !this.resolvedModel.englishOnly) {
          options.language = this.options.language ?? 'en';
          options.task = 'transcribe';
        }

        let text = '';
        try {
          const output = await transcriber(audio.samples, options);
          const first = Array.isArray(output) ? output[0] : output;
          text = (first?.text ?? '').trim();
        } catch (err) {
          log.error('asr', '本地解码失败', err);
          handlers.onError(new Error('本地识别这一段失败了，已跳过。'));
          return;
        }

        this.lastInferenceMs = performance.now() - started;

        if (!text) return;
        // 小模型常见的幻觉：整段静音被识别成一个词。长度过短且无字母时丢弃。
        if (!/[a-zA-Z]/.test(text) && text.length < 3) return;

        this.seq += 1;
        const segment: FinalSegment = {
          id: `seg_${this.seq}`,
          text,
          startMs: Math.round(audio.startMs),
          endMs: Math.round(audio.endMs),
        };
        log.debug('asr', `本地解码 ${this.lastInferenceMs.toFixed(0)}ms → ${text.slice(0, 60)}`);
        handlers.onFinal(segment);
      })
      .catch((err) => {
        log.error('asr', '本地识别队列异常', err);
      });
  }

  async stop(): Promise<void> {
    this.active = false;
    // 等待在途解码落地，避免用户点「结束」后还有句子冒出来。
    try {
      await this.queue;
    } catch {
      /* 队列内部已经吞掉异常 */
    }
    this.handlers = null;
  }

  async dispose(): Promise<void> {
    this.active = false;
    try {
      await this.pipelineRef?.dispose?.();
    } catch (err) {
      log.warn('asr', '释放本地模型失败', err);
    }
    this.transcriber = null;
    this.pipelineRef = null;
  }
}

/**
 * 本地翻译（transformers.js）。手机端的主力方案，也是桌面端的兜底。
 *
 * 取舍：
 *  - 优点：完全 on-device，离线可用，零成本。
 *  - 代价：要下几十到几百 MB 的模型；WASM 上每句几百毫秒；小模型对
 *    **数字、专有名词**不可靠（hayamimi 的 Limitations 原文：
 *    "numeric values are not reliably preserved"）。
 *    对策不在这一层 —— 数字由摘要层直接从**英文原文**抽取，见 sum/extractiveSum.ts。
 *
 * 候选模型按「小 → 大、快 → 慢」排序，逐个尝试。HF 上模型改名下架很常见，
 * 硬编码单一 id 迟早变砖。
 */

import type { EngineAvailability, MtEngine, ProgressFn } from '../types';
import { log } from '@/lib/logger';
import { configureOrtWasm, type OrtDtype } from '@/lib/ortEnv';
import { shouldUseLightweightModels } from '@/lib/device';

interface MtModelSpec {
  id: string;
  label: string;
  approxBytes: number;
  /** marian = 单语向模型；multilingual = 需要显式指定 src_lang/tgt_lang */
  kind: 'marian' | 'multilingual';
  /** 仅 multilingual 使用 */
  langArgs?: Record<string, string>;
}

export const MT_MODELS: MtModelSpec[] = [
  {
    id: 'Xenova/opus-mt-en-zh',
    label: 'Opus-MT 英中（~80MB，最快）',
    approxBytes: 80 * 1024 * 1024,
    kind: 'marian',
  },
  {
    id: 'Xenova/nllb-200-distilled-600M',
    label: 'NLLB-200 蒸馏版（~600MB，质量更好）',
    approxBytes: 600 * 1024 * 1024,
    kind: 'multilingual',
    langArgs: { src_lang: 'eng_Latn', tgt_lang: 'zho_Hans' },
  },
  {
    id: 'Xenova/m2m100_418M',
    label: 'M2M-100（~450MB）',
    approxBytes: 450 * 1024 * 1024,
    kind: 'multilingual',
    langArgs: { src_lang: 'en', tgt_lang: 'zh' },
  },
];

type TranslationOutput = { translation_text: string };
type TranslatorFn = (
  text: string | string[],
  options?: Record<string, unknown>,
) => Promise<TranslationOutput[]>;

interface DisposablePipeline {
  dispose?: () => Promise<void> | void;
}

export interface TransformersMtOptions {
  /** 指定模型 id；不传则按 MT_MODELS 顺序尝试 */
  modelId?: string;
  device?: 'webgpu' | 'wasm';
  /** 强制权重精度；默认 webgpu→fp32、wasm→q8 */
  dtype?: OrtDtype;
}

export class TransformersMtEngine implements MtEngine {
  readonly id = 'mt-local-transformer';
  readonly label = '本地翻译模型';
  readonly stage = 'mt' as const;
  readonly privacy = 'on-device' as const;

  private translator: TranslatorFn | null = null;
  private pipelineRef: DisposablePipeline | null = null;
  private resolved: MtModelSpec | null = null;
  private readonly options: TransformersMtOptions;

  /** WASM 上并发推理会互相踩内存，必须串行 */
  private queue: Promise<unknown> = Promise.resolve();

  /** 实测的「每字符毫秒数」，用于 UI 预估 */
  charsPerSecond = 40;

  constructor(options: TransformersMtOptions = {}) {
    this.options = options;
  }

  get modelLabel(): string {
    return this.resolved?.label ?? '未加载';
  }

  private hasWebGpu(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  private candidates(): MtModelSpec[] {
    if (!this.options.modelId) return MT_MODELS;
    const found = MT_MODELS.find((m) => m.id === this.options.modelId);
    return [
      found ?? {
        id: this.options.modelId,
        label: this.options.modelId,
        approxBytes: 80 * 1024 * 1024,
        kind: this.options.modelId.includes('nllb') || this.options.modelId.includes('m2m')
          ? 'multilingual'
          : 'marian',
        langArgs: this.options.modelId.includes('nllb')
          ? { src_lang: 'eng_Latn', tgt_lang: 'zho_Hans' }
          : undefined,
      },
    ];
  }

  async probe(): Promise<EngineAvailability> {
    if (typeof WebAssembly === 'undefined') {
      return { status: 'unavailable', reason: '此浏览器不支持 WebAssembly。' };
    }
    if (!window.isSecureContext) {
      return { status: 'unavailable', reason: '加载本地模型需要 HTTPS 或 localhost 环境。' };
    }
    if (this.translator) return { status: 'ready' };
    const spec = this.candidates()[0];
    return {
      status: 'downloadable',
      bytes: spec.approxBytes,
      note: spec.label,
    };
  }

  async init(onProgress?: ProgressFn): Promise<void> {
    if (this.translator) return;

    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    // 与 ASR 引擎共用同一份 wasm 外置配置（见 lib/ortEnv.ts）
    configureOrtWasm(env);

    // 桌面有 WebGPU 就用；手机上 WebGPU 跑机器翻译会吃掉大量内存（docs/07 R1），
    // 一律退回 WASM。轻量档（手机 / 小内存）连 WASM 也用最省的配置。
    const light = shouldUseLightweightModels();
    const device = this.options.device ?? (this.hasWebGpu() && !light ? 'webgpu' : 'wasm');
    const dtype = this.options.dtype ?? (device === 'webgpu' ? 'fp32' : 'q8');

    const failures: string[] = [];

    for (const spec of this.candidates()) {
      try {
        onProgress?.({
          progress: null,
          label: `正在加载 ${spec.label}`,
          loadedBytes: 0,
          totalBytes: spec.approxBytes,
        });

        const instance = await pipeline('translation', spec.id, {
          device,
          dtype,
          ...(spec.langArgs ?? {}),
          progress_callback: (info: {
            status?: string;
            progress?: number;
            loaded?: number;
            total?: number;
          }) => {
            if (!onProgress || info.status !== 'progress') return;
            onProgress({
              progress: typeof info.progress === 'number' ? info.progress / 100 : null,
              label: `正在下载 ${spec.label}`,
              loadedBytes: info.loaded ?? 0,
              totalBytes: info.total ?? spec.approxBytes,
            });
          },
        });

        this.pipelineRef = instance as unknown as DisposablePipeline;
        this.translator = instance as unknown as TranslatorFn;
        this.resolved = spec;
        log.info('mt', `本地翻译就绪 model=${spec.id} device=${device} dtype=${dtype}`);
        return;
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        failures.push(`${spec.id}: ${message}`);
        log.warn('mt', `翻译模型 ${spec.id} 加载失败，尝试下一个候选`, err);
      }
    }

    throw new Error(
      `本地翻译模型全部加载失败。请检查网络后重试，或改用浏览器内置翻译。\n${failures.join('\n')}`,
    );
  }

  translate(text: string, signal?: AbortSignal): Promise<string> {
    const run = async (): Promise<string> => {
      if (!this.translator) throw new Error('本地翻译模型尚未就绪。');
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      const trimmed = text.trim();
      if (!trimmed) return '';

      const started = performance.now();
      const output = await this.translator(trimmed, {
        // 关掉采样，翻译任务要确定性输出
        num_beams: 1,
        do_sample: false,
        max_new_tokens: Math.min(512, Math.max(64, Math.ceil(trimmed.length * 2))),
      });
      const first = Array.isArray(output) ? output[0] : undefined;
      const result = (first?.translation_text ?? '').trim();

      const elapsed = performance.now() - started;
      if (elapsed > 0 && result.length > 0) {
        // 指数滑动平均，避免个别长句把预估带偏
        const rate = (result.length / elapsed) * 1000;
        this.charsPerSecond = this.charsPerSecond * 0.7 + rate * 0.3;
      }
      return result;
    };

    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * 批量翻译。Marian / NLLB 都支持一次吃多条，比逐条快得多；
   * 但为了不让 UI 长时间无反馈，按 8 条一批切分。
   */
  async translateBatch(texts: string[], onBatch?: (done: number, total: number) => void): Promise<string[]> {
    if (!this.translator) throw new Error('本地翻译模型尚未就绪。');
    const out: string[] = [];
    const BATCH = 8;
    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH).map((t) => t.trim() || ' ');
      try {
        const output = await this.translator(slice, { num_beams: 1, do_sample: false });
        for (const item of output) out.push((item.translation_text ?? '').trim());
      } catch (err) {
        log.warn('mt', '批量翻译失败，回退逐条', err);
        for (const text of slice) {
          out.push(await this.translate(text));
        }
      }
      onBatch?.(Math.min(texts.length, i + BATCH), texts.length);
    }
    return out;
  }

  async dispose(): Promise<void> {
    try {
      await this.pipelineRef?.dispose?.();
    } catch (err) {
      log.warn('mt', '释放本地翻译模型失败', err);
    }
    this.translator = null;
    this.pipelineRef = null;
  }
}

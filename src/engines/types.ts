/**
 * 引擎层接口。
 *
 * 这是整个项目的「地基契约」：管线只认这些接口，不认识任何具体实现。
 * 只要新实现满足接口，就能插进注册表并参与降级链，无需改动管线与 UI。
 */

import type { FinalSegment, PartialSegment, Stage, SummaryResult } from '@/types';

// ---------------------------------------------------------------------------
// 公共部分
// ---------------------------------------------------------------------------

/** 引擎的可用性四态。命名刻意与 Chrome Translator API 对齐。 */
export type EngineAvailability =
  /** 立即可用，无需下载、无需授权 */
  | { status: 'ready' }
  /** 该设备支持，但需要先下载资源（必须由用户手势触发） */
  | { status: 'downloadable'; bytes: number; note?: string }
  /** 正在下载中 */
  | { status: 'downloading'; progress: number }
  /** 该设备不支持 */
  | { status: 'unavailable'; reason: string };

export interface DownloadProgress {
  /** 0..1；未知总量时为 null */
  progress: number | null;
  /** 面向用户的中文说明，如「正在下载语音识别模型」 */
  label: string;
  loadedBytes: number;
  totalBytes: number | null;
}

export type ProgressFn = (p: DownloadProgress) => void;

/** 资源是否会离开用户设备 */
export type PrivacyLevel = 'on-device' | 'network';

export interface Engine {
  /** 稳定标识，出现在 UI 与 plan 里，不要随意改名 */
  readonly id: string;
  /** 面向用户的中文名 */
  readonly label: string;
  readonly stage: Stage;
  readonly privacy: PrivacyLevel;
  /**
   * 无需用户手势即可调用的探测。
   * 绝对不能在这里下载模型或申请权限。
   */
  probe(): Promise<EngineAvailability>;
  /**
   * 真正就绪。可能触发模型下载 —— 因此**必须**在用户手势的调用栈里执行。
   * 重复调用应当幂等。
   */
  init(onProgress?: ProgressFn): Promise<void>;
  /** 释放资源（GPU buffer / worker / WASM 堆），供 LRU 在内存吃紧时调用 */
  dispose(): Promise<void>;
}

export class EngineError extends Error {
  /**
   * 三个字段写成显式属性 + 构造函数体内赋值，**不是**构造函数参数属性。
   * 参数属性（`constructor(readonly engineId: string)`）在 Node 的
   * type-stripping 模式下会抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，
   * 而单测一旦走到任何 import 到这个模块的路径就会整体失败 ——
   * 这类错误只在「某个测试恰好引到它」时才出现，排查成本远高于写这两行。
   */
  readonly engineId: string;
  readonly stage: Stage;
  readonly cause?: unknown;

  constructor(message: string, engineId: string, stage: Stage, cause?: unknown) {
    super(message);
    this.name = 'EngineError';
    this.engineId = engineId;
    this.stage = stage;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// 语音识别
// ---------------------------------------------------------------------------

export interface AsrHandlers {
  /** 逐字草稿。只有 `supportsPartial` 为 true 的引擎会调用。 */
  onPartial(partial: PartialSegment): void;
  /** 一句话定稿。 */
  onFinal(segment: FinalSegment): void;
  /** 发生错误但会话未中断（例如某一句识别失败）。 */
  onError(error: Error): void;
}

export interface UtteranceAudio {
  /** 16kHz 单声道 Float32，取值 -1..1 */
  samples: Float32Array;
  startMs: number;
  endMs: number;
}

export interface AsrEngine extends Engine {
  readonly stage: 'asr';
  /**
   * 音频从哪来：
   * - `'external'`：本引擎只管解码，由管线负责采集麦克风、断句，再调用 `feed()`。
   * - `'self'`：本引擎自己占用麦克风（浏览器原生识别就是这种），管线不得再开一路采集。
   */
  readonly audioSource: 'external' | 'self';
  /** 是否提供逐字 partial（决定 UI 是否显示灰色草稿行） */
  readonly supportsPartial: boolean;
  /** 是否支持「再解码一遍已有音频」（决定能否做二次精修） */
  readonly supportsReplay: boolean;

  start(handlers: AsrHandlers): Promise<void>;
  /**
   * 仅在 `audioSource === 'external'` 时有效：喂一段已经切好的完整语句。
   * 实现必须自行排队，并在结果产出后调用 `handlers.onFinal`。
   */
  feed?(audio: UtteranceAudio): void;
  /** 主动结束会话，等待所有在途解码落地。 */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 机器翻译
// ---------------------------------------------------------------------------

export interface MtEngine extends Engine {
  readonly stage: 'mt';
  /** 单条翻译。实现必须内部串行化，避免并发挤爆 WASM。 */
  translate(text: string, signal?: AbortSignal): Promise<string>;
  /**
   * 批量翻译（用于会话结束后的整段精修）。
   * 不实现的话，管线会退化成逐条调用 `translate`。
   */
  translateBatch?(texts: string[]): Promise<string[]>;
  /** 该引擎每秒大致能处理多少字符，用于给用户预估等待时间 */
  readonly throughputHint?: number;
}

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------

export interface SummarizeInput {
  /** 精修后的完整转写（有序） */
  segments: FinalSegment[];
  /** 与 segments 一一对应的中文译文；缺失处为 undefined */
  translations: (string | undefined)[];
  /** 已经翻译好的段落（如果有），用于避免重复翻译 */
  onProgress?: (stage: string, progress: number | null) => void;
}

export interface SumEngine extends Engine {
  readonly stage: 'sum';
  /** 产出模式，用于在 UI 上诚实标注「AI 生成」还是「抽取式」 */
  readonly mode: 'extractive' | 'generative';
  /**
   * `onChunk` 用于流式展示（生成式引擎会逐段回调）。
   * 实现**不得抛错**——任何内部异常都要自行降级并返回可用结果。
   */
  summarize(input: SummarizeInput, onChunk?: (text: string) => void): Promise<SummaryResult>;
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

export interface EngineRegistry {
  readonly asr: AsrEngine[];
  readonly mt: MtEngine[];
  readonly sum: SumEngine[];
}

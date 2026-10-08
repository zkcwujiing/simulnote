/**
 * SimulNote 领域类型定义。
 *
 * 这里只放「业务概念」，不放任何引擎（ASR / MT / SUM）的实现细节。
 * 引擎接口见 `src/engines/types.ts`。
 */

/** 管线环节 */
export type Stage = 'asr' | 'mt' | 'sum';

/** 正在识别中的草稿句（会被后续结果替换或定稿） */
export interface PartialSegment {
  id: string;
  /** 英文原文（可能不完整） */
  text: string;
  startMs: number;
}

/** 已定稿的一句（不会再变，除非被精修替换） */
export interface FinalSegment {
  id: string;
  /** 英文原文 */
  text: string;
  startMs: number;
  endMs: number;
  /** 是否经过二次精修 */
  refined?: boolean;
  /** 说话人编号（一期不启用） */
  speaker?: number;
}

/** 从英文原文抽取出来的事实（绕开翻译链路，避免小模型翻错数字） */
export interface ExtractedFact {
  /** 英文原文里的原始表述，如 "about 12 percent" */
  raw: string;
  /** 中文参考译法 */
  zh: string;
  /** 所在句子（英文） */
  context: string;
  /** 该句在会话中的序号 */
  segIndex: number;
  kind: FactKind;
}

export type FactKind = 'percent' | 'money' | 'date' | 'duration' | 'quantity' | 'proper';

export interface Keyword {
  en: string;
  zh: string;
  weight: number;
}

export interface SummaryResult {
  /** 产出该纪要的引擎 id */
  engineId: string;
  /** 一句话主题 */
  title: string;
  /** 三行以内速览 */
  tldr: string;
  /** 中文要点 */
  keyPoints: string[];
  /** 关键数字与事实 */
  numbers: ExtractedFact[];
  /** 结论 / 决议 */
  decisions: string[];
  /** 待办 / 行动计划 */
  actions: string[];
  /** 高频关键词（中英对照） */
  keywords: Keyword[];
  generatedAt: number;
  /** extractive = 抽取式（永不失败）；generative = 生成式 */
  mode: 'extractive' | 'generative';
  /** 覆盖了多少段、多少字，便于用户判断纪要是否可信 */
  coverage: { segments: number; chars: number };
  /**
   * 数字回填的现场记录（R4）。
   * 每一条都是「我改动了什么、或者哪里没对上」，供 UI 摊开给用户看 ——
   * 自动改写译文却不吭声，比不改更糟。
   */
  numberFixes?: string[];
}

export interface SessionStats {
  startedAt: number;
  endedAt: number | null;
  finalCount: number;
  /**
   * 采集回调**真正收到**的音频总长（毫秒）。
   * 注意它不是墙上时钟 —— 麦克风被系统挂起、标签页被冻结时这个数会停止增长，
   * 而这正是我们要的：它回答的是「应用听见了多久」。
   */
  audioDurationMs: number;
  /** VAD 判定「有人在说话」并送进识别的音频总长（毫秒） */
  speechDurationMs: number;
  /** 识别交回来的句子时长之和（毫秒），与 `speechDurationMs` 对比用于丢句检测 */
  transcriptDurationMs: number;
  /** 平均「说完 → 出译文」延迟（毫秒） */
  meanLatencyMs: number;
  /** 翻译失败/降级的次数 */
  degradedCount: number;
}

/** 某一环节最终选用哪个引擎，以及为什么 */
export interface StagePlan {
  engineId: string;
  label: string;
  reason: string;
  privacy: 'on-device' | 'network';
  /** 该引擎需要下载的字节数（已缓存则为 0） */
  bytes: number;
}

export interface PipelinePlan {
  asr: StagePlan;
  mt: StagePlan;
  sum: StagePlan;
  /** 是否包含任何联网环节 */
  anyNetwork: boolean;
  /** 是否至少有一环被降级 */
  degraded: boolean;
  /** 预估总下载字节数 */
  totalBytes: number;
}

export type SessionStatus =
  | 'idle'
  | 'probing'
  | 'preparing'
  | 'ready'
  | 'running'
  | 'summarizing'
  | 'done'
  | 'error';

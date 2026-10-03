/**
 * 引擎注册表与降级决策。
 *
 * 这个文件回答一个问题：**在这台设备上，现在到底该用哪套引擎？**
 *
 * 三条模式（对应 docs/03 的四层渐进增强，落地为三档）：
 *
 *  - `auto`（默认）：**音频不出设备，文字尽量走系统内置**。
 *      ASR：本地 Whisper → 浏览器原生识别
 *      MT ：浏览器内置翻译 → 本地翻译模型
 *      这正是用户要的组合：桌面吃内置翻译的零下载，手机退到本地小模型。
 *
 *  - `privacy`：全链路本地。ASR 本地 Whisper，MT 本地模型，
 *      不依赖任何云端能力，模型全部下完后**可以完全离线**。
 *
 *  - `speed`：启动最快。ASR 用浏览器原生识别（秒开、无下载，
 *      但音频会发往浏览器厂商的服务器），MT 优先内置翻译。
 *
 * 决策规则：**探测顺序即优先级**，第一个既非 unavailable 的候选获胜。
 * 「downloadable」也算获胜 —— 模型下载由用户在界面上点一下触发（init 必须
 * 落在用户手势的调用栈里，这是 Chrome 内置翻译 API 的硬性要求，
 * 本地模型沿用同一套交互，用户心智一致）。
 */

import type { PipelinePlan, Stage, StagePlan } from '@/types';
import type { AsrEngine, EngineAvailability, EngineRegistry, MtEngine, PrivacyLevel, SumEngine } from './types';
import { WebSpeechAsrEngine } from './asr/webSpeechAsr';
import { TransformersWhisperAsrEngine } from './asr/transformersWhisperAsr';
import { ChromeTranslatorMtEngine } from './mt/chromeTranslatorMt';
import { TransformersMtEngine } from './mt/transformersMt';
import { ExtractiveSumEngine } from './sum/extractiveSum';

export type PipelineMode = 'auto' | 'privacy' | 'speed';

export const PIPELINE_MODES: { value: PipelineMode; label: string; hint: string }[] = [
  {
    value: 'auto',
    label: '自动（推荐）',
    hint: '音频只在本机处理；文字优先用系统内置翻译，不支持时自动切到本地模型。',
  },
  {
    value: 'privacy',
    label: '完全本地',
    hint: '识别与翻译都在本机完成。模型全部下载后可断网使用。',
  },
  {
    value: 'speed',
    label: '最快启动',
    hint: '用浏览器原生识别，无需下载模型。注意：音频会发送到浏览器厂商的服务器。',
  },
];

/** 一次探测的原始记录，用于在 UI 上如实展示「为什么选了这个」。 */
export interface ProbeReport {
  stage: Stage;
  engineId: string;
  label: string;
  privacy: PrivacyLevel;
  status: EngineAvailability['status'];
  bytes?: number;
  reason?: string;
}

export interface ResolvedPlan {
  mode: PipelineMode;
  plan: PipelinePlan;
  /** 决策时使用的**同一批**引擎实例，管线必须拿这一份去 init/start */
  registry: EngineRegistry;
  asr: AsrEngine;
  /** 翻译可能缺席（还有「只转写不翻译」的降级） */
  mt: MtEngine | null;
  sum: SumEngine;
  reports: ProbeReport[];
}

/** 构建候选引擎列表。每次调用都返回**全新实例**，避免跨会话残留状态。 */
export function createCandidates(mode: PipelineMode): EngineRegistry {
  const whisper = () => new TransformersWhisperAsrEngine();
  const webSpeech = () => new WebSpeechAsrEngine();
  const builtinMt = () => new ChromeTranslatorMtEngine('en', 'zh');
  const localMt = () => new TransformersMtEngine();
  const sum = () => new ExtractiveSumEngine();

  switch (mode) {
    case 'privacy':
      return {
        asr: [whisper(), webSpeech()],
        mt: [localMt(), builtinMt()],
        sum: [sum()],
      };
    case 'speed':
      return {
        asr: [webSpeech(), whisper()],
        mt: [builtinMt(), localMt()],
        sum: [sum()],
      };
    case 'auto':
    default:
      return {
        // 音频优先本地：这是本项目对隐私的核心承诺
        asr: [whisper(), webSpeech()],
        // 文字优先内置：零下载，且模型本来就在设备上
        mt: [builtinMt(), localMt()],
        sum: [sum()],
      };
  }
}

/** 依次探测所有候选，**不下载任何东西、不申请任何权限**。 */
export async function probeAll(
  registry: EngineRegistry,
  onReport?: (report: ProbeReport) => void,
): Promise<ProbeReport[]> {
  const reports: ProbeReport[] = [];

  const run = async (stage: Stage, engines: { id: string; label: string; privacy: PrivacyLevel; probe: () => Promise<EngineAvailability> }[]) => {
    for (const engine of engines) {
      let status: EngineAvailability;
      try {
        status = await engine.probe();
      } catch (error) {
        status = {
          status: 'unavailable',
          reason: error instanceof Error ? error.message : '探测时发生未知错误',
        };
      }
      const report: ProbeReport = {
        stage,
        engineId: engine.id,
        label: engine.label,
        privacy: engine.privacy,
        status: status.status,
        bytes: status.status === 'downloadable' ? status.bytes : undefined,
        reason:
          status.status === 'unavailable'
            ? status.reason
            : status.status === 'downloadable'
              ? status.note
              : undefined,
      };
      reports.push(report);
      onReport?.(report);
    }
  };

  await run('asr', registry.asr);
  await run('mt', registry.mt);
  await run('sum', registry.sum);

  return reports;
}

function pickFirst<T extends { id: string; stage: Stage }>(engines: T[], reports: ProbeReport[]): T | null {
  for (const engine of engines) {
    const report = reports.find((r) => r.engineId === engine.id && r.stage === engine.stage);
    if (report && report.status !== 'unavailable') return engine;
  }
  return null;
}

function toStagePlan(report: ProbeReport, preferredId: string | null): StagePlan {
  const bytes = report.status === 'downloadable' ? (report.bytes ?? 0) : 0;
  let reason: string;
  if (report.engineId === preferredId) {
    reason = bytes > 0 ? `需要下载约 ${formatMb(bytes)}` : '本机已就绪';
  } else {
    reason = '首选方案在本机不可用，已自动降级';
  }
  return {
    engineId: report.engineId,
    label: report.label,
    reason,
    privacy: report.privacy,
    bytes,
  };
}

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * 探测 + 决策。返回可直接交给管线的具体引擎实例。
 * 任一环节连兜底都不可用（例如非安全上下文里既没有本地模型也没有原生识别）
 * 时抛错，由 UI 展示中文原因。
 */
export async function resolvePlan(
  mode: PipelineMode,
  onReport?: (report: ProbeReport) => void,
): Promise<ResolvedPlan> {
  const registry = createCandidates(mode);
  const reports = await probeAll(registry, onReport);

  const asr = pickFirst(registry.asr, reports);
  const mt = pickFirst(registry.mt, reports);
  const sum = pickFirst(registry.sum, reports);

  if (!asr) {
    throw new Error(
      '这台设备上没有任何可用的语音识别方案：本地模型无法加载，浏览器原生识别也不可用。' +
        '请改用 Chrome / Edge 桌面版，或在手机 Chrome 上打开。',
    );
  }
  if (!sum) {
    throw new Error('摘要引擎初始化失败，这通常意味着当前浏览器不支持 ES2022 语法。');
  }

  const asrReport = reports.find((r) => r.engineId === asr.id && r.stage === 'asr')!;
  const sumReport = reports.find((r) => r.engineId === sum.id && r.stage === 'sum')!;

  // 翻译允许**缺席**：实在不行还有「只转写不翻译」的降级，总比白屏好。
  const mtReport = mt ? reports.find((r) => r.engineId === mt.id && r.stage === 'mt') : undefined;

  const asrPlan = toStagePlan(asrReport, registry.asr[0]?.id ?? null);
  const sureSumPlan = toStagePlan(sumReport, registry.sum[0]?.id ?? null);
  const mtPlan: StagePlan = mtReport
    ? toStagePlan(mtReport, registry.mt[0]?.id ?? null)
    : {
        engineId: 'mt-none',
        label: '仅转写（不翻译）',
        reason: '本机没有可用的翻译方案，将只保留英文原文',
        privacy: 'on-device',
        bytes: 0,
      };

  const anyNetwork = [asrPlan, mtPlan, sureSumPlan].some((p) => p.privacy === 'network');
  const degraded = anyNetwork || (!mtReport) || asrPlan.engineId !== (registry.asr[0]?.id ?? null);
  const totalBytes = asrPlan.bytes + mtPlan.bytes + sureSumPlan.bytes;

  const plan: PipelinePlan = {
    asr: asrPlan,
    mt: mtPlan,
    sum: sureSumPlan,
    anyNetwork,
    degraded,
    totalBytes,
  };

  return { mode, plan, registry, asr, mt, sum, reports };
}

/** 释放全部候选引擎占用的资源（切换模式 / 离开页面时调用）。 */
export async function disposeAll(registry: Partial<EngineRegistry>): Promise<void> {
  const all = [...(registry.asr ?? []), ...(registry.mt ?? []), ...(registry.sum ?? [])];
  await Promise.all(
    all.map(async (engine) => {
      try {
        await engine.dispose();
      } catch {
        // 释放失败不影响用户，忽略
      }
    }),
  );
}

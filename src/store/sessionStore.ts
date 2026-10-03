/**
 * 会话状态。
 *
 * 刻意做成「一个 store + 一个管线实例」：管线是命令式的长生命周期对象，
 * 不适合塞进 React state；store 只保存**可渲染的快照**。
 * React 组件永远不直接碰管线，只调这里的 action。
 */

import { create } from 'zustand';
import type {
  FinalSegment,
  PartialSegment,
  PipelinePlan,
  SessionStats,
  SessionStatus,
  SummaryResult,
} from '@/types';
import type { DownloadProgress } from '@/engines/types';
import {
  TranslatorPipeline,
  type PipelineEvent,
} from '@/pipeline/translatorPipeline';
import type { ProbeReport } from '@/engines/registry';
import { toChineseError } from '@/lib/errors';
import { log } from '@/lib/logger';

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  at: number;
}

const MODE_KEY = 'simulnote.mode';

function readStoredMode(): 'auto' | 'privacy' | 'speed' {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (raw === 'auto' || raw === 'privacy' || raw === 'speed') return raw;
  } catch {
    /* 隐私模式下 localStorage 可能被禁 */
  }
  return 'auto';
}

let pipeline: TranslatorPipeline | null = null;
let noticeSeq = 0;

export interface SessionState {
  status: SessionStatus;
  mode: 'auto' | 'privacy' | 'speed';
  plan: PipelinePlan | null;
  reports: ProbeReport[];
  notices: Notice[];
  segments: FinalSegment[];
  translations: Record<string, string>;
  partial: PartialSegment | null;
  summary: SummaryResult | null;
  summaryProgress: string;
  stats: SessionStats | null;
  download: DownloadProgress | null;
  error: string | null;
  /** 本次会话开始的时间，用于导出文件头的时间戳。 */
  startedAt: number | null;

  setMode: (mode: 'auto' | 'privacy' | 'speed') => void;
  prepare: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => void;
}

const initial = {
  status: 'idle' as SessionStatus,
  mode: readStoredMode(),
  plan: null,
  reports: [] as ProbeReport[],
  notices: [] as Notice[],
  segments: [] as FinalSegment[],
  translations: {} as Record<string, string>,
  partial: null,
  summary: null,
  summaryProgress: '',
  stats: null,
  download: null,
  error: null,
  startedAt: null,
};

export const useSessionStore = create<SessionState>()((set, get) => {
  function pushNotice(level: Notice['level'], message: string): void {
    noticeSeq += 1;
    const notice: Notice = { id: noticeSeq, level, message, at: Date.now() };
    set((state) => ({ notices: [...state.notices.slice(-40), notice] }));
  }

  function handleEvent(event: PipelineEvent): void {
    switch (event.type) {
      case 'status':
        set({ status: event.status, ...(event.status !== 'error' ? { error: null } : {}) });
        break;
      case 'probe':
        set((state) => ({ reports: [...state.reports, event.report] }));
        break;
      case 'plan':
        set({ plan: event.plan });
        break;
      case 'download':
        set({ download: event.progress });
        break;
      case 'partial':
        set({ partial: event.partial });
        break;
      case 'final':
        set((state) => ({ segments: [...state.segments, event.segment], partial: null }));
        break;
      case 'translation':
        set((state) => ({ translations: { ...state.translations, [event.id]: event.text } }));
        break;
      case 'translation-failed':
        pushNotice('warn', `有一句没翻译出来：${event.message}`);
        break;
      case 'stats':
        set({ stats: event.stats });
        break;
      case 'summary-progress':
        set({ summaryProgress: event.text });
        break;
      case 'summary':
        set({ summary: event.summary, summaryProgress: '' });
        break;
      case 'notice':
        pushNotice(event.level, event.message);
        break;
      case 'error':
        set({ error: event.message });
        pushNotice('error', event.message);
        break;
      default:
        break;
    }
  }

  function ensurePipeline(): TranslatorPipeline {
    if (!pipeline) {
      pipeline = new TranslatorPipeline({ mode: get().mode, onEvent: handleEvent });
    }
    return pipeline;
  }

  async function teardown(): Promise<void> {
    if (!pipeline) return;
    const old = pipeline;
    pipeline = null;
    try {
      await old.dispose();
    } catch (error) {
      log.warn('store', '释放管线失败', error);
    }
  }

  return {
    ...initial,

    setMode(mode) {
      if (mode === get().mode) return;
      try {
        localStorage.setItem(MODE_KEY, mode);
      } catch {
        /* 忽略 */
      }
      void teardown();
      set({ ...initial, mode });
    },

    async prepare() {
      await teardown();
      set({ ...initial, mode: get().mode, status: 'probing' });
      try {
        await ensurePipeline().prepare();
      } catch (error) {
        const message = toChineseError(error, '环境检测失败');
        set({ status: 'error', error: message });
        pushNotice('error', message);
      }
    },

    async start() {
      if (get().startedAt === null) set({ startedAt: Date.now() });
      try {
        await ensurePipeline().start();
      } catch (error) {
        const message = toChineseError(error, '启动失败');
        set({ status: 'error', error: message });
        pushNotice('error', message);
      }
    },

    async stop() {
      if (!pipeline) return;
      try {
        await pipeline.stop();
      } catch (error) {
        const message = toChineseError(error, '收尾失败');
        set({ status: 'error', error: message });
        pushNotice('error', message);
      }
    },

    reset() {
      void teardown();
      set({ ...initial, mode: get().mode });
    },
  };
});

/** 给导出 / 分享功能用：按时间顺序取出「原文 + 译文」对。 */
export function selectPairs(state: SessionState): { segment: FinalSegment; zh?: string }[] {
  return [...state.segments]
    .sort((a, b) => a.startMs - b.startMs)
    .map((segment) => ({ segment, zh: state.translations[segment.id] }));
}

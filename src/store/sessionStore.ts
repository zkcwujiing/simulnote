/**
 * 会话状态。
 *
 * 刻意做成「一个 store + 一个管线实例」：管线是命令式的长生命周期对象，
 * 不适合塞进 React state；store 只保存**可渲染的快照**。
 * React 组件永远不直接碰管线，只调这里的 action。
 *
 * M2 起这里还多了三件与「手机可用」直接相关的事：
 *   1. **中断**：监听页面生命周期，发现「切后台/锁屏」并记下来；
 *   2. **恢复**：回到前台时检查采集还活着没，必要时重挂麦克风；
 *   3. **留痕**：定期把已定稿的句子写进 sessionStorage，对抗标签页被杀。
 * 三者的设计理由分别见 `lib/session/lifecycle.ts`、`lib/audio/capture.ts`
 * 的 `captureHealthOf`、`lib/session/draft.ts` 的文件头注释。
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
import {
  LifecycleTracker,
  classifyInterruption,
  watchLifecycle,
  type InterruptionLevel,
  type LifecycleSnapshot,
} from '@/lib/session/lifecycle';
import {
  buildDraft,
  clearDraft,
  describeDraft,
  loadDraft,
  needsSummary,
  saveDraft,
  type SessionDraft,
} from '@/lib/session/draft';
import {
  MEMORY_GUARD_INTERVAL_MS,
  describeHeap,
  heapLevel,
  heapTrend,
  readHeap,
  type HeapReading,
} from '@/lib/session/memory';
import { describeMicPickup, detectTranscriptLoss } from '@/lib/session/quality';
import { AudioFileError, FILE_SAMPLE_RATE, readAudioFile } from '@/lib/audio/fileSource';

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  at: number;
}

/** 一次「离开前台」的现场。回来后 `active` 会变 false，但提示保留到用户看为止。 */
export interface InterruptionNotice {
  /** true = 现在还在后台；false = 已经回来并处理完了 */
  active: boolean;
  level: InterruptionLevel;
  message: string;
  since: number | null;
  /** 回到前台之后的处置结果（已恢复 / 已重挂麦克风 / 救不回来） */
  outcome: string | null;
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

/** 留痕节流：定稿一句就写一次太浪费，攒一会儿再写。 */
const DRAFT_THROTTLE_MS = 1500;
let draftTimer: ReturnType<typeof setTimeout> | null = null;

/** 内存守卫的定时器与上一次读数（只比趋势，见 `lib/session/memory.ts`）。 */
let memoryTimer: ReturnType<typeof setInterval> | null = null;
let lastHeap: HeapReading | null = null;
let heapWarnedAt = 0;

/** 启动时问用户「要不要恢复」的那份草稿。放在模块变量里，不进 React state。 */
let pendingDraft: SessionDraft | null = null;

/** 正在进行的「上传音频文件」任务。放在模块变量里，因为它同时是取消句柄。 */
let fileAbort: AbortController | null = null;

/** 「上传音频文件」任务的进度，用于在界面上替换掉「正在录音」那套提示。 */
export interface FileJob {
  name: string;
  /** 0~1 的读取进度。注意它**只表示读取**，识别进度看 `phase` 的措辞。 */
  ratio: number;
  phase: string;
}

/**
 * 文件模式允许「已送出」领先「已定稿字幕」多少毫秒。
 *
 * 这个数不是随手取的：它要大于**单句最长时长**（`UtteranceSegmenter` 的
 * `maxSpeechMs = 15000`），否则一句长话还没定稿就被判定成「落后」，
 * 背压会一直卡在等它。60 秒给了 4 倍余量，同时把待识别队列的上限
 * 压在「一分钟音频 + 在途那一段」的量级上。
 */
const FILE_MAX_LAG_MS = 60_000;

/** 触发背压后多久回头看一眼是否追上。250 ms 是「不烧 CPU」与「不空转太久」的折中。 */
const FILE_LAG_POLL_MS = 250;

const lifecycle = new LifecycleTracker();

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
  /** 切后台 / 锁屏的现场（M2） */
  interruption: InterruptionNotice | null;
  /** 启动时发现一份没做完的留痕，这里是给用户看的一句话（M2） */
  draftOffer: string | null;
  /** 正在处理一个上传的音频文件（M4） */
  fileJob: FileJob | null;

  setMode: (mode: 'auto' | 'privacy' | 'speed') => void;
  prepare: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** 上传一个音频文件，跑完整条管线并出纪要（M4） */
  transcribeFile: (file: File) => Promise<void>;
  /** 用户在文件处理中途按了停止（M4） */
  cancelFile: () => void;
  reset: () => void;
  /** 页面离开前台（M2） */
  handleHidden: (snapshot: LifecycleSnapshot) => void;
  /** 页面回到前台（M2） */
  handleVisible: (hiddenMs: number) => Promise<void>;
  /** 用户看过中断提示了，收起它（M2） */
  dismissInterruption: () => void;
  /** 用户点了「恢复上次的会话」（M2） */
  acceptDraftOffer: () => Promise<void>;
  dismissDraftOffer: () => void;
  /** 主动释放识别模型，腾内存（M2） */
  releaseModels: () => Promise<boolean>;
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
  interruption: null,
  draftOffer: null,
  fileJob: null,
};

export const useSessionStore = create<SessionState>()((set, get) => {
  function pushNotice(level: Notice['level'], message: string): void {
    noticeSeq += 1;
    const notice: Notice = { id: noticeSeq, level, message, at: Date.now() };
    set((state) => ({ notices: [...state.notices.slice(-40), notice] }));
  }

  /**
   * 把「已经定稿的文字」写进 sessionStorage。
   *
   * 这是整个 M2 里唯一对抗**标签页被杀**的手段 —— 那种情况下没有任何事件会触发，
   * 唯一的机会就是在被杀之前就已经写出去。所以它在每个 final/translation 之后
   * 被节流调用，而不是等到 stop()。
   */
  function persistDraft(): void {
    const active = pipeline;
    if (!active) return;
    const state = get();
    if (state.startedAt === null) return;
    const snapshot = active.snapshotForDraft();
    if (snapshot.segments.length === 0) return;
    saveDraft(
      buildDraft({
        startedAt: state.startedAt,
        status: state.status,
        audioDurationMs: snapshot.audioDurationMs,
        degradedCount: snapshot.degradedCount,
        segments: snapshot.segments,
        translations: snapshot.translations,
      }),
    );
  }

  function scheduleDraftSave(): void {
    if (draftTimer !== null) return;
    draftTimer = setTimeout(() => {
      draftTimer = null;
      try {
        persistDraft();
      } catch (error) {
        log.warn('store', '写留痕失败', error);
      }
    }, DRAFT_THROTTLE_MS);
  }

  function flushDraftNow(): void {
    if (draftTimer !== null) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
    try {
      persistDraft();
    } catch (error) {
      log.warn('store', '写留痕失败', error);
    }
  }

  /**
   * 内存守卫：**只判断趋势 + 越过高水位时提醒一次**，不做自动降档。
   * 理由见 `lib/session/memory.ts` 的文件头 —— 建立在不可信读数上的自动降档
   * 比不降档更糟。
   */
  function startMemoryGuard(): void {
    if (memoryTimer !== null) return;
    lastHeap = readHeap();
    memoryTimer = setInterval(() => {
      const current = readHeap();
      const trend = heapTrend(lastHeap, current);
      const level = heapLevel(current);
      lastHeap = current;
      if (level !== 'high' || trend !== 'rising') return;
      const now = Date.now();
      if (now - heapWarnedAt < 5 * 60_000) return;
      heapWarnedAt = now;
      pushNotice(
        'warn',
        `内存占用持续上涨（${describeHeap(current)}）建议先结束本场、生成纪要，再开下一场。`,
      );
    }, MEMORY_GUARD_INTERVAL_MS);
  }

  function stopMemoryGuard(): void {
    if (memoryTimer !== null) {
      clearInterval(memoryTimer);
      memoryTimer = null;
    }
    lastHeap = null;
  }

  function handleEvent(event: PipelineEvent): void {
    switch (event.type) {
      case 'status':
        set({ status: event.status, ...(event.status !== 'error' ? { error: null } : {}) });
        if (event.status === 'running') startMemoryGuard();
        if (event.status === 'done' || event.status === 'idle' || event.status === 'error') {
          stopMemoryGuard();
        }
        if (event.status === 'done') {
          // 会话已经结束，留痕没有意义了 —— 留着反而会在下次打开时被当成「未完成的会话」。
          clearDraft();
          // M4 · 丢句告警。放在这里而不是放在纪要里，是因为它是**关于这次录音**的判断，
          // 用户此刻还记得自己讲了什么，能立刻判断「是不是真丢了」。
          const quality = pipeline?.getStats() ?? get().stats;
          const loss = detectTranscriptLoss(quality);
          if (loss && loss.level !== 'ok') {
            pushNotice('warn', loss.message);
          }
          const pickup = describeMicPickup(quality);
          if (pickup) pushNotice('info', pickup);
          // M2 · 长时间会话的内存回收：会话结束后卸掉识别模型。
          // 只卸 ASR（大且不再需要）；再次开始时 init() 会从本地缓存重新加载。
          void pipeline?.releaseAsr().then((released) => {
            if (released) {
              pushNotice('info', '已释放识别模型以腾出内存；再次开始录音会自动重新加载（通常几秒）。');
            }
          });
        }
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
        scheduleDraftSave();
        break;
      case 'translation':
        set((state) => ({ translations: { ...state.translations, [event.id]: event.text } }));
        scheduleDraftSave();
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
      // 注意保留 draftOffer：`prepare()` 在挂载时就被调用，而「上次没做完的会话」
      // 提示是紧接着它同步设置的。这里要是整块重置，那条提示会在创建的同一帧里被抹掉，
      // 用户永远看不到 —— 留痕功能等于白做。
      set((state) => ({ ...initial, mode: state.mode, status: 'probing', draftOffer: state.draftOffer }));
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
      set({ interruption: null });
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

    /**
     * 上传一个音频文件，跑完整条管线。
     *
     * 与麦克风那条路的关键差别是**它不申请麦克风**，音频由 `acceptFileFrame()`
     * 从文件里喂进去。除此之外完全复用同一条管线，所以字幕、译文、纪要、
     * 丢句告警、导出全都一样能用。
     *
     * 背压是这个函数里唯一不显然的地方：文本型的识别引擎没有「我还跟得上」的
     * 回调，所以在手机上把 30 分钟音频一次性灌进去，只会得到一个越来越长的
     * 待识别队列，最后表现为「进度条走完了但字幕一直不出」。这里的做法是
     * 拿**已定稿字幕的时长**当消费速度的代理指标，落后超过 `FILE_MAX_LAG_MS`
     * 就等一下再喂。
     */
    async transcribeFile(file: File) {
      // 重新来一条干净的管线：上一次会话的段落、译文、统计都不该混进来。
      await teardown();
      const active = ensurePipeline();
      const controller = new AbortController();
      fileAbort = controller;

      const update = (patch: Partial<FileJob>): void => {
        set((state) => (state.fileJob ? { fileJob: { ...state.fileJob, ...patch } } : {}));
      };

      set({
        ...initial,
        mode: get().mode,
        fileJob: { name: file.name, ratio: 0, phase: '正在读取音频…' },
        startedAt: Date.now(),
      });

      try {
        await active.prepare();
        await active.start({ source: 'file' });
        // `start()` 把错误走事件发出去（不 throw），所以这里要**回读状态**确认
        // 真的开始了；否则我们会往一条没起来的管线里灌音频。
        if (get().status === 'error') return;

        let fedFrames = 0;
        for await (const chunk of readAudioFile(file, {
          signal: controller.signal,
          onProgress: (ratio) => update({ ratio, phase: '正在识别…' }),
        })) {
          if (controller.signal.aborted) break;
          if (!active.acceptFileFrame(chunk.samples)) break;
          fedFrames += chunk.samples.length;

          // 背压：落后太多就先等一等，别把队列堆到手机内存里。
          const fedMs = (fedFrames / FILE_SAMPLE_RATE) * 1000;
          while (
            !controller.signal.aborted &&
            fedMs - active.getStats().transcriptDurationMs > FILE_MAX_LAG_MS
          ) {
            update({ phase: `正在识别…（已送出 ${Math.round(fedMs / 1000)} 秒）` });
            await new Promise((resolve) => setTimeout(resolve, FILE_LAG_POLL_MS));
          }
        }

        update({ phase: '正在收尾、生成纪要…' });
        await active.stop();
      } catch (error) {
        if (error instanceof AudioFileError) {
          // 解码失败是用户能自己解决的问题（换个格式），给可执行的建议而不是堆栈。
          pushNotice('error', `${error.message}${error.hint ? `（${error.hint}）` : ''}`);
          set({ status: 'error', error: error.message });
        } else {
          const message = toChineseError(error, '处理音频文件失败');
          pushNotice('error', message);
          set({ status: 'error', error: message });
        }
      } finally {
        if (fileAbort === controller) fileAbort = null;
        set({ fileJob: null });
      }
    },

    cancelFile() {
      fileAbort?.abort();
      fileAbort = null;
      // 停止喂帧还不够 —— 管线那边也要收尾，否则它一直停在 running，
      // 界面会显示成「还在识别」。
      void pipeline?.stop();
      set({ fileJob: null });
    },

    reset() {
      void teardown();
      stopMemoryGuard();
      clearDraft();
      set({ ...initial, mode: get().mode });
    },

    handleHidden(snapshot) {
      const state = get();
      const live = state.status === 'running' || state.status === 'preparing';
      if (!live) return;
      // 先把留痕写掉再走：接下来标签页有可能永远不会再醒过来。
      flushDraftNow();
      set({
        interruption: {
          active: true,
          level: 'paused',
          message: '已切到后台或锁屏，录音可能已被浏览器挂起。',
          since: snapshot.hiddenSince,
          outcome: null,
        },
      });
    },

    async handleVisible(hiddenMs) {
      const state = get();
      const live = state.status === 'running' || state.status === 'preparing';
      if (!live) {
        set({ interruption: null });
        return;
      }

      const active = pipeline;
      let outcome: string | null = null;
      let audioAlive: boolean | null = null;
      if (active) {
        try {
          const result = await active.recoverCapture();
          outcome = result.message;
          audioAlive = result.level !== 'audio-lost';
        } catch (error) {
          log.warn('store', '恢复采集失败', error);
          outcome = toChineseError(error, '恢复采集失败');
          audioAlive = false;
        }
      }

      const level = classifyInterruption({ hiddenDurationMs: hiddenMs, audioAlive });
      const seconds = Math.round(hiddenMs / 1000);
      const who = seconds < 60 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`;

      if (level === 'none') {
        set({ interruption: null });
        return;
      }

      const message =
        level === 'audio-lost'
          ? `刚才离开 ${who}，麦克风被系统回收了，已重新打开。那段时间的音频没有录到。`
          : `刚才离开 ${who}，音频处理被挂起，已恢复。`;

      set({
        interruption: {
          active: false,
          level,
          message,
          since: null,
          outcome,
        },
      });
      pushNotice(level === 'audio-lost' ? 'warn' : 'info', outcome ? `${message}（${outcome}）` : message);
    },

    dismissInterruption() {
      set({ interruption: null });
    },

    async acceptDraftOffer() {
      const draft = pendingDraft;
      if (!draft) return;
      pendingDraft = null;
      // 先把可能正在探测的那条管线收掉，再建新的：否则 `ensurePipeline()`
      // 会拿到旧实例，而旧实例的 `prepare()` 可能还在飞。
      await teardown();
      set({ ...initial, mode: get().mode, draftOffer: null, status: 'preparing' });

      try {
        const active = ensurePipeline();
        // prepare() 只探测环境、不下载模型（模型在 Cache Storage 里）。
        await active.prepare();
        active.restoreDraft({
          segments: draft.segments,
          translations: draft.translations,
          audioDurationMs: draft.audioDurationMs,
          degradedCount: draft.degradedCount,
          startedAt: draft.startedAt,
        });
        set({
          startedAt: draft.startedAt,
          segments: draft.segments,
          translations: draft.translations,
          status: 'summarizing',
        });
        pushNotice('info', `已恢复上次的 ${draft.segments.length} 句转写，正在重新生成纪要…`);
        await active.summarizeRestored();
      } catch (error) {
        const message = toChineseError(error, '恢复上次会话失败');
        set({ status: 'error', error: message });
        pushNotice('error', message);
      }
    },

    dismissDraftOffer() {
      pendingDraft = null;
      set({ draftOffer: null });
    },

    async releaseModels() {
      if (!pipeline) return false;
      const released = await pipeline.releaseAsr();
      if (released) pushNotice('info', '已释放识别模型，腾出内存。');
      return released;
    },
  };
});

/**
 * 启动时检查有没有没做完的留痕。
 *
 * 抽成独立函数（而不是塞进 `prepare()`）是因为 `prepare()` 会在切换模式时重跑，
 * 那时候去问「要不要恢复」是打扰。
 */
export function checkDraftOnBoot(): void {
  try {
    const draft = loadDraft();
    if (!draft || !needsSummary(draft)) return;
    const description = describeDraft(draft);
    if (!description) return;
    pendingDraft = draft;
    useSessionStore.setState({ draftOffer: description });
  } catch (error) {
    log.warn('store', '读取留痕失败', error);
  }
}

// 页面生命周期只订阅一次。Node（单测）里 `document` 不存在，
// `watchLifecycle` 会直接返回一个空函数，所以这里不需要额外判断。
watchLifecycle(lifecycle, (snapshot, resumedAfterMs) => {
  const state = useSessionStore.getState();
  if (resumedAfterMs === null) state.handleHidden(snapshot);
  else void state.handleVisible(resumedAfterMs);
});

/** 给导出 / 分享功能用：按时间顺序取出「原文 + 译文」对。 */
export function selectPairs(state: SessionState): { segment: FinalSegment; zh?: string }[] {
  return [...state.segments]
    .sort((a, b) => a.startMs - b.startMs)
    .map((segment) => ({ segment, zh: state.translations[segment.id] }));
}

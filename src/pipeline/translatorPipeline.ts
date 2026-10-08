/**
 * TranslatorPipeline —— 整条链路的唯一编排者。
 *
 * 数据流（以默认的 external ASR 为例）：
 *
 *   AudioWorklet ──100ms 帧──▶ UtteranceSegmenter ──整句 Float32──▶ AsrEngine.feed
 *                                                                        │
 *                                              handlers.onFinal ◀────────┘
 *                                                        │
 *                                         ┌──────────────┴───────────────┐
 *                                         ▼                              ▼
 *                                  MtEngine.translate            （会话结束后）
 *                                         │                              │
 *                                 emit 'translation'              SumEngine.summarize
 *
 * 两条不可动摇的规则：
 *  1. **翻译是串行的**。onnxruntime 的同一个 session 并发推理会踩内存，
 *     内置翻译 API 也不保证并发安全。串行化换来的是稳定，代价只是一点排队。
 *  2. **任何单点失败都不能中断会话**。翻译挂一句就记一次 degraded 并继续，
 *     识别出错误就 emit notice，只有「什么都没法开始」才升级为致命错误。
 */

import type {
  FinalSegment,
  PartialSegment,
  PipelinePlan,
  SessionStats,
  SessionStatus,
  SummaryResult,
} from '@/types';
import type { AsrHandlers, DownloadProgress, EngineRegistry } from '@/engines/types';
import { EngineError } from '@/engines/types';
import {
  disposeAll,
  resolvePlan,
  type PipelineMode,
  type ProbeReport,
  type ResolvedPlan,
} from '@/engines/registry';
import { startCapture, type CaptureHandle, type CaptureHealth } from '@/lib/audio/capture';
import { UtteranceSegmenter } from '@/lib/audio/vad';
import { toChineseError } from '@/lib/errors';
import { log } from '@/lib/logger';
import type { InterruptionLevel } from '@/lib/session/lifecycle';

export type PipelineEvent =
  | { type: 'status'; status: SessionStatus; detail?: string }
  | { type: 'probe'; report: ProbeReport }
  | { type: 'plan'; plan: PipelinePlan; reports: ProbeReport[] }
  | { type: 'download'; progress: DownloadProgress }
  | { type: 'partial'; partial: PartialSegment }
  | { type: 'final'; segment: FinalSegment }
  | { type: 'translation'; id: string; text: string; latencyMs: number }
  | { type: 'translation-failed'; id: string; message: string }
  | { type: 'stats'; stats: SessionStats }
  | { type: 'summary-progress'; text: string }
  | { type: 'summary'; summary: SummaryResult }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'error'; message: string };

export interface TranslatorPipelineOptions {
  mode: PipelineMode;
  onEvent: (event: PipelineEvent) => void;
}

export class TranslatorPipeline {
  private readonly options: TranslatorPipelineOptions;
  private registry: EngineRegistry | null = null;
  private resolved: ResolvedPlan | null = null;
  private capture: CaptureHandle | null = null;
  private readonly segmenter = new UtteranceSegmenter();

  private segments: FinalSegment[] = [];
  private translations = new Map<string, string>();
  private translationQueue: Promise<void> = Promise.resolve();
  /**
   * 「这句是什么时候到的」——翻译延迟的分母。
   *
   * 这个 Map **必须在译完之后删掉**。它原先只 set 不 delete，一场两小时的会
   * 就是几千条永远不释放的条目；单条很小，但它是「长会话内存只涨不落」的第一块砖。
   */
  private arrivalTimes = new Map<string, number>();
  /**
   * 延迟统计只留「和」与「个数」，不再留整个数组。
   * 我们要的只是平均值（见 `buildStats`），存下每一笔是纯粹的浪费 ——
   * 而且是个无界数组，会话越长越大。
   */
  private latencySum = 0;
  private latencyCount = 0;
  private degradedCount = 0;
  private audioDurationMs = 0;
  private startedAt = 0;
  private stopped = false;

  constructor(options: TranslatorPipelineOptions) {
    this.options = options;
  }

  private emit(event: PipelineEvent): void {
    this.options.onEvent(event);
  }

  /** 只探测，不下载。安全地在页面加载时调用。 */
  async prepare(): Promise<PipelinePlan> {
    this.emit({ type: 'status', status: 'probing' });

    // resolvePlan 内部会 probeAll 一遍，并**原样返回它决策时使用的那批实例**，
    // 所以这里不需要（也不能）另建一批 —— 否则 init 的和 start 的会是两套引擎。
    const resolved = await resolvePlan(this.options.mode, (report) =>
      this.emit({ type: 'probe', report }),
    );

    this.resolved = resolved;
    this.registry = resolved.registry;

    this.emit({ type: 'plan', plan: resolved.plan, reports: resolved.reports });
    this.emit({ type: 'status', status: 'ready' });
    return resolved.plan;
  }

  getPlan(): PipelinePlan | null {
    return this.resolved?.plan ?? null;
  }

  /**
   * 真正开始。**必须由用户手势的调用栈触发** —— 里面会下载模型、
   * 申请麦克风权限。浏览器对这两件事都有手势要求。
   */
  async start(): Promise<void> {
    const resolved = this.ensureResolved();
    this.stopped = false;
    this.emit({ type: 'status', status: 'preparing' });

    try {
      if (resolved.mt) {
        await resolved.mt.init((progress) => this.emit({ type: 'download', progress }));
      }
      await resolved.asr.init((progress) => this.emit({ type: 'download', progress }));
    } catch (error) {
      const message = toChineseError(error, '模型加载失败');
      this.emit({ type: 'error', message });
      this.emit({ type: 'status', status: 'error', detail: message });
      return;
    }

    this.startedAt = Date.now();
    this.emit({ type: 'status', status: 'running' });

    const handlers: AsrHandlers = {
      onPartial: (partial) => {
        if (this.stopped) return;
        this.emit({ type: 'partial', partial });
      },
      onFinal: (segment) => {
        if (this.stopped) return;
        this.acceptFinal(segment);
      },
      onError: (error) => {
        this.degradedCount += 1;
        this.emit({
          type: 'notice',
          level: 'warn',
          message: `识别出错，已跳过这一句：${toChineseError(error, '识别失败')}`,
        });
      },
    };

    try {
      if (resolved.asr.audioSource === 'external') {
        this.emit({ type: 'notice', level: 'info', message: '正在开启麦克风…' });
        const capture = await startCapture(this.onAudioFrame, { targetRate: 16000 });
        this.capture = capture;
        if (capture.usingFallback) {
          this.emit({
            type: 'notice',
            level: 'warn',
            message: '当前浏览器不支持 AudioWorklet，已退回到兼容模式（延迟略高）。',
          });
        }
        await resolved.asr.start(handlers);
      } else {
        // 引擎自己占用麦克风（浏览器原生识别），管线不得再开一路采集
        await resolved.asr.start(handlers);
      }
    } catch (error) {
      const message = toChineseError(error, '无法开始录音');
      this.emit({ type: 'error', message });
      this.emit({ type: 'status', status: 'error', detail: message });
      await this.cleanupCapture();
    }
  }

  /**
   * 采集帧的唯一入口。抽成字段（而不是内联箭头函数）是为了让
   * **锁屏中断之后重挂麦克风**能复用同一个处理函数 —— 否则重挂时要么复制一份
   * 逻辑、要么把回调再传一层，两边迟早会走歪。
   */
  private readonly onAudioFrame = (frame: Float32Array): void => {
    if (this.stopped) return;
    const utterance = this.segmenter.push(frame);
    if (utterance) this.feedUtterance(utterance.samples, utterance.startMs, utterance.endMs);
  };

  private feedUtterance(samples: Float32Array, startMs: number, endMs: number): void {
    const asr = this.resolved?.asr;
    if (!asr?.feed) return;
    this.audioDurationMs += Math.max(0, endMs - startMs);
    try {
      asr.feed({ samples, startMs, endMs });
    } catch (error) {
      this.degradedCount += 1;
      log.warn('pipeline', 'feed 失败', error);
      this.emit({ type: 'notice', level: 'warn', message: '有一段音频没能送去识别，已跳过。' });
    }
  }

  private acceptFinal(segment: FinalSegment): void {
    this.segments.push(segment);
    this.arrivalTimes.set(segment.id, performance.now());
    this.emit({ type: 'final', segment });
    this.enqueueTranslation(segment);
  }

  /**
   * 翻译队列。用一条 then 链串起来，保证严格按顺序、严格串行。
   * 所有异常都在这里被吃掉并转成 translation-failed 事件。
   */
  private enqueueTranslation(segment: FinalSegment): void {
    const mt = this.resolved?.mt;
    if (!mt) return;

    this.translationQueue = this.translationQueue.then(async () => {
      if (this.stopped && !this.flushing) return;
      const arrival = this.arrivalTimes.get(segment.id) ?? performance.now();
      try {
        const text = await mt.translate(segment.text);
        const cleaned = text.trim();
        if (!cleaned) throw new Error('引擎返回了空译文');
        this.translations.set(segment.id, cleaned);
        const latencyMs = performance.now() - arrival;
        this.latencySum += latencyMs;
        this.latencyCount += 1;
        this.emit({ type: 'translation', id: segment.id, text: cleaned, latencyMs });
      } catch (error) {
        this.degradedCount += 1;
        const message = error instanceof EngineError ? error.message : toChineseError(error, '翻译失败');
        this.emit({ type: 'translation-failed', id: segment.id, message });
      }
      this.arrivalTimes.delete(segment.id);
      this.emitStats();
    });
  }

  private flushing = false;

  private emitStats(): void {
    this.emit({ type: 'stats', stats: this.buildStats() });
  }

  private buildStats(): SessionStats {
    const meanLatencyMs = this.latencyCount > 0 ? this.latencySum / this.latencyCount : 0;
    const transcriptDurationMs = this.segments.reduce(
      (sum, s) => sum + Math.max(0, s.endMs - s.startMs),
      0,
    );
    return {
      startedAt: this.startedAt,
      endedAt: this.stopped ? Date.now() : null,
      finalCount: this.segments.length,
      audioDurationMs: Math.round(this.audioDurationMs),
      transcriptDurationMs: Math.round(transcriptDurationMs),
      meanLatencyMs: Math.round(meanLatencyMs),
      degradedCount: this.degradedCount,
    };
  }

  /**
   * 停止录音、等在途的识别与翻译落地，然后生成纪要。
   * 反复调用是安全的（第二次会直接返回上一份纪要）。
   */
  async stop(): Promise<SummaryResult | null> {
    if (this.stopped && this.lastSummary) return this.lastSummary;
    this.stopped = true;
    this.emit({ type: 'status', status: 'preparing', detail: '正在收尾…' });

    const asr = this.resolved?.asr;

    // 1) 把分段器里剩下的尾句放出来（很多人会在最后一句说完就点停止）
    if (this.capture) {
      const tail = this.segmenter.drain();
      if (tail) this.feedUtterance(tail.samples, tail.startMs, tail.endMs);
    }

    // 2) 先停采集，再停引擎：顺序反了会让采集继续往已关闭的引擎里灌数据
    await this.cleanupCapture();

    try {
      await asr?.stop();
    } catch (error) {
      log.warn('pipeline', 'asr.stop 失败', error);
    }

    // 3) 等在途翻译。flushing 置位后队列里剩下的都会执行完。
    this.flushing = true;
    try {
      await this.translationQueue;
    } catch {
      // 队列内部已处理异常，这里不会触发
    }

    this.emitStats();

    // 4) 收尾翻译：把仍缺译文的段落补一遍（例如被跳过、或结束时才定稿的句子）
    await this.retryMissingTranslations();

    // 5) 生成纪要
    const summary = await this.summarize();
    return summary;
  }

  private lastSummary: SummaryResult | null = null;

  private async retryMissingTranslations(): Promise<void> {
    const mt = this.resolved?.mt;
    if (!mt) return;
    const missing = this.segments.filter((s) => !this.translations.get(s.id));
    if (missing.length === 0) return;
    this.emit({
      type: 'notice',
      level: 'info',
      message: `正在补翻 ${missing.length} 句尚未翻译的内容…`,
    });
    for (const segment of missing) {
      try {
        const text = (await mt.translate(segment.text)).trim();
        if (text) this.translations.set(segment.id, text);
      } catch {
        this.degradedCount += 1;
      }
    }
  }

  private async summarize(): Promise<SummaryResult | null> {
    const sum = this.resolved?.sum;
    if (!sum) return null;
    this.emit({ type: 'status', status: 'summarizing' });

    const orderedSegments = [...this.segments].sort((a, b) => a.startMs - b.startMs);
    const translations = orderedSegments.map((s) => this.translations.get(s.id));

    try {
      const result = await sum.summarize({ segments: orderedSegments, translations }, (text) =>
        this.emit({ type: 'summary-progress', text }),
      );
      this.lastSummary = result;
      this.emit({ type: 'summary', summary: result });
      this.emit({ type: 'status', status: 'done' });
      return result;
    } catch (error) {
      // 摘要引擎契约上不允许抛错；真抛了说明是代码 bug，不能因此丢掉整场转写。
      const message = toChineseError(error, '生成纪要失败');
      this.emit({ type: 'notice', level: 'error', message: `${message}（转写内容仍然保留）` });
      this.emit({ type: 'status', status: 'done' });
      return null;
    }
  }

  private async cleanupCapture(): Promise<void> {
    const capture = this.capture;
    this.capture = null;
    if (!capture) return;
    try {
      await capture.stop();
    } catch (error) {
      log.warn('pipeline', '停止采集失败', error);
    }
  }

  /** 中途放弃：不生成纪要，直接释放资源。 */
  async abort(): Promise<void> {
    this.stopped = true;
    this.flushing = false;
    await this.cleanupCapture();
    try {
      await this.resolved?.asr.stop();
    } catch {
      /* 忽略 */
    }
    this.emit({ type: 'status', status: 'idle' });
  }

  /** 释放所有引擎（切换模式 / 卸载页面时调用）。 */
  async dispose(): Promise<void> {
    await this.cleanupCapture();
    if (this.registry) await disposeAll(this.registry);
    this.registry = null;
    this.resolved = null;
  }

  getSegments(): FinalSegment[] {
    return [...this.segments];
  }

  getTranslation(id: string): string | undefined {
    return this.translations.get(id);
  }

  // ==================================================================
  // M2 · 锁屏 / 切后台的中断与恢复
  //
  // 手机浏览器的行为是：锁屏或切走 → 音频图被挂起 → 久一点音轨直接被系统回收。
  // 这两件事**都不会报错**，`status` 还是 running，用户回来以为还在录。
  // 所以下面这组方法要回答两个问题：现在采集还活着吗？不活能不能救？
  // ==================================================================

  /** 不使用麦克风采集的链路（浏览器原生识别）返回 null。 */
  captureHealth(): CaptureHealth | null {
    return this.capture?.health() ?? null;
  }

  /**
   * 回到前台之后调用。
   * 分级返回给 UI：`paused` 只是挂起、已经叫醒；`audio-lost` 是音轨没了、重开了麦克风。
   */
  async recoverCapture(): Promise<{ level: InterruptionLevel; message: string }> {
    const capture = this.capture;
    if (!capture) {
      return this.stopped
        ? { level: 'none', message: '会话已结束' }
        : { level: 'audio-lost', message: '麦克风采集已经不在了，请重新开始录音' };
    }

    const health = capture.health();
    if (health.live) return { level: 'none', message: '采集正常' };
    if (health.state === 'closed') return { level: 'none', message: '采集已停止' };

    if (health.state === 'suspended') {
      const ok = await capture.resume();
      if (ok) return { level: 'paused', message: '音频处理已恢复，继续录音' };
      return this.reattachCapture('音频处理叫不醒');
    }

    return this.reattachCapture(health.reason);
  }

  /**
   * 音轨被回收之后唯一的办法是重新 `getUserMedia`。
   * **刻意不重建引擎**：模型还在内存里，重建要多等十几秒，而用户只是锁了个屏。
   */
  private async reattachCapture(
    why: string,
  ): Promise<{ level: InterruptionLevel; message: string }> {
    const resolved = this.resolved;
    if (!resolved || this.stopped) {
      return { level: 'audio-lost', message: `${why}；会话已结束，不再重开麦克风` };
    }
    if (resolved.asr.audioSource !== 'external') {
      // 浏览器原生识别自己占着麦克风，管线无从代劳。
      return {
        level: 'audio-lost',
        message: `${why}；当前识别引擎自己占用麦克风，需要你手动重新开始`,
      };
    }
    await this.cleanupCapture();
    try {
      this.capture = await startCapture(this.onAudioFrame, { targetRate: 16000 });
      this.emit({
        type: 'notice',
        level: 'warn',
        message: `${why}，已重新打开麦克风。刚才那段时间的音频没有录到。`,
      });
      return { level: 'audio-lost', message: `${why}，已重新打开麦克风` };
    } catch (error) {
      const message = toChineseError(error, '重新打开麦克风失败');
      this.emit({ type: 'notice', level: 'error', message });
      return { level: 'audio-lost', message };
    }
  }

  /**
   * M2 · 长时间会话的内存回收：把识别模型卸掉。
   *
   * 为什么只卸 ASR 不卸 MT：ASR（Whisper）是两者里大的那个，而且**纪要生成之后
   * 就不再需要它**；MT 留着，用户翻看纪要时若还有零星补翻不用重新加载。
   *
   * 为什么可以放心卸：引擎的 `dispose()` 会把 `transcriber` 置空，下一次
   * `start()` 调 `init()` 会重新加载 —— 模型文件在 Cache Storage 里，通常是几秒
   * 而不是几十秒。只有在会话已经停下来之后才允许调用（录音中卸掉会直接断链）。
   */
  async releaseAsr(): Promise<boolean> {
    const asr = this.resolved?.asr;
    if (!asr) return false;
    if (!this.stopped) {
      log.warn('pipeline', '会话仍在进行，拒绝释放识别模型');
      return false;
    }
    if (asr.audioSource !== 'external') {
      // 浏览器原生识别（Web Speech）不占我们的内存，卸了也没有东西可回收，
      // 反而会让下次「开始」多绕一圈。
      return false;
    }
    try {
      await asr.dispose();
      log.info('pipeline', '已释放识别模型（长时间会话内存回收）');
      return true;
    } catch (error) {
      log.warn('pipeline', '释放识别模型失败', error);
      return false;
    }
  }

  // ==================================================================
  // M2 · 会话留痕（标签页被杀之后的恢复）
  // ==================================================================

  /** 供「留痕」取一份当前状态的快照。 */
  snapshotForDraft(): {
    segments: FinalSegment[];
    translations: Record<string, string>;
    audioDurationMs: number;
    degradedCount: number;
  } {
    return {
      segments: [...this.segments],
      translations: Object.fromEntries(this.translations),
      audioDurationMs: Math.round(this.audioDurationMs),
      degradedCount: this.degradedCount,
    };
  }

  /**
   * 把留痕读回来。**只恢复文字，不恢复音频** —— 音频从来就没落过盘，
   * 所以恢复之后能看、能导出、能重新出纪要，但补不上缺掉的那一段。
   */
  restoreDraft(input: {
    segments: FinalSegment[];
    translations: Record<string, string>;
    audioDurationMs?: number;
    degradedCount?: number;
    startedAt?: number;
  }): void {
    this.segments = [...input.segments];
    this.translations = new Map(Object.entries(input.translations));
    this.audioDurationMs = input.audioDurationMs ?? 0;
    this.degradedCount = input.degradedCount ?? 0;
    this.startedAt = input.startedAt ?? Date.now();
    this.stopped = true;
    this.flushing = true;
    log.info('pipeline', `已恢复留痕：${this.segments.length} 句`);
  }

  /** 恢复之后重新生成纪要（需要先 `prepare()`，它只探测、不下载模型）。 */
  async summarizeRestored(): Promise<SummaryResult | null> {
    if (this.segments.length === 0) return null;
    this.stopped = true;
    return this.summarize();
  }

  getStats(): SessionStats {
    return this.buildStats();
  }

  private ensureResolved(): ResolvedPlan {
    if (!this.resolved) {
      throw new Error('管线尚未完成环境探测，请先调用 prepare()。');
    }
    return this.resolved;
  }
}

/** 供 UI 一次性展示「这台设备会怎么跑」。 */
export function describePlan(plan: PipelinePlan): string {
  const mb = plan.totalBytes > 0 ? `，首次需下载约 ${(plan.totalBytes / 1024 / 1024).toFixed(0)} MB` : '';
  const net = plan.anyNetwork ? '包含联网环节' : '全程在本机完成';
  return `${net}${mb}。识别：${plan.asr.label}；翻译：${plan.mt.label}；纪要：${plan.sum.label}。`;
}

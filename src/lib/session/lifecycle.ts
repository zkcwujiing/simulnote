/**
 * 页面生命周期追踪 —— M2「锁屏中断恢复」的判据层。
 *
 * 为什么需要它：
 *   手机上这个应用被杀死的**头号原因不是内存不足，而是用户锁屏或切到别的 App**。
 *   浏览器对后台标签页会做三件事：冻结定时器、把 AudioContext 挂起、实在不行
 *   直接杀掉标签页。前两件是可恢复的，第三件只能靠留痕。而这三件事发生时，
 *   页面上**没有任何报错** —— `status` 还是 `running`，UI 还在转圈，
 *   用户回来时以为还在录，其实麦克风早就停了。这才是最坏的情况：
 *   不是崩了，是**静默地不再工作**。
 *
 * 所以这里只做一件事：把「离开前台 / 回到前台 / 被冻结」变成一个**可判定的状态**，
 * 让管线能据此决定「这条采集还活着吗」。
 *
 * 这个类不碰 DOM：宿主环境通过 `LifecycleHost` 注入，单测里塞一个假的就能跑。
 */

export type LifecyclePhase = 'visible' | 'hidden' | 'frozen';

export interface LifecycleSnapshot {
  phase: LifecyclePhase;
  /** 本次会话里「离开前台」的次数 */
  hiddenCount: number;
  /** 累计离开前台的毫秒数 */
  hiddenTotalMs: number;
  /** 当前这次离开前台是什么时候开始的；在前台则为 null */
  hiddenSince: number | null;
  /** 最近一次回到前台是什么时候 */
  lastResumedAt: number | null;
}

/** 追踪器只依赖这三个方法，所以单测里可以塞一个纯对象。 */
export interface LifecycleHost {
  readonly visibilityState: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export class LifecycleTracker {
  private phase: LifecyclePhase = 'visible';
  private hiddenCount = 0;
  private hiddenTotalMs = 0;
  private hiddenSince: number | null = null;
  private lastResumedAt: number | null = null;

  /**
   * 时钟做成注入参数，而不是直接调 `Date.now()`。
   * 这样「离开 45 秒」在单测里是一次变量赋值，而不是真的等 45 秒 ——
   * 中断恢复这种东西在真机上极难复现，判断逻辑必须能脱离浏览器被测到。
   *
   * 注意这里写成显式字段赋值而不是构造函数参数属性（`constructor(private ...)`）：
   * 本项目的单测跑在 Node 的 type-stripping 模式下，它**不支持参数属性**
   * （`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）。
   */
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  get snapshot(): LifecycleSnapshot {
    return {
      phase: this.phase,
      hiddenCount: this.hiddenCount,
      hiddenTotalMs: this.hiddenTotalMs,
      hiddenSince: this.hiddenSince,
      lastResumedAt: this.lastResumedAt,
    };
  }

  /** 离开前台（切标签、切 App、锁屏）。返回是否真的发生了状态变化。 */
  markHidden(): boolean {
    if (this.phase !== 'visible') return false;
    this.phase = 'hidden';
    this.hiddenCount += 1;
    this.hiddenSince = this.now();
    return true;
  }

  /**
   * 被浏览器冻结（Chrome 的 `freeze` 事件）。
   * 冻结前不一定会先发 `visibilitychange`，所以这里要能**从 visible 直接进 frozen**。
   */
  markFrozen(): boolean {
    if (this.phase === 'frozen') return false;
    if (this.phase === 'visible') {
      this.hiddenCount += 1;
      this.hiddenSince = this.now();
    }
    this.phase = 'frozen';
    return true;
  }

  /** 回到前台。返回「这次离开持续了多久」；本来就在前台则返回 null。 */
  markVisible(): number | null {
    if (this.phase === 'visible') return null;
    const since = this.hiddenSince ?? this.now();
    const durationMs = Math.max(0, this.now() - since);
    this.hiddenTotalMs += durationMs;
    this.hiddenSince = null;
    this.lastResumedAt = this.now();
    this.phase = 'visible';
    return durationMs;
  }

  /** 当前已经离开前台多久（毫秒）；在前台则为 0。 */
  hiddenMs(): number {
    if (this.phase === 'visible' || this.hiddenSince === null) return 0;
    return Math.max(0, this.now() - this.hiddenSince);
  }
}

/**
 * 中断的严重程度。UI 与管线都按这个分级决定动作：
 *   none          没中断过（或刚回到前台且一切正常）
 *   paused        短暂离开（<30s），AudioContext 大概率只是 suspended，resume 即可
 *   needs-resume  离开较久（≥30s），必须显式 resume + 确认采集还活着
 *   audio-lost    回到前台时采集已经死了，只能重挂麦克风
 */
export type InterruptionLevel = 'none' | 'paused' | 'needs-resume' | 'audio-lost';

/** 离开多久之后就不再「悄悄继续」，而是明确告诉用户「我停过」。 */
export const NOTICEABLE_HIDDEN_MS = 30_000;

export function classifyInterruption(input: {
  hiddenDurationMs: number;
  /** null = 还没测；false = 测过了，采集确实死了 */
  audioAlive: boolean | null;
}): InterruptionLevel {
  if (input.audioAlive === false) return 'audio-lost';
  if (input.hiddenDurationMs >= NOTICEABLE_HIDDEN_MS) return 'needs-resume';
  if (input.hiddenDurationMs > 0) return 'paused';
  return 'none';
}

/**
 * 把追踪器接到真实的 DOM 事件上。返回取消订阅的函数。
 *
 * 为什么同时挂 document 和 window：
 *   `freeze` / `resume` / `visibilitychange` 派发在 document 上；
 *   `pageshow` / `pagehide`（bfcache 进出）派发在 window 上。
 *   只挂一个会漏掉另一半信号 —— 而漏掉的恰好是「iOS Safari 用 bfcache 恢复」这条路径。
 */
export function watchLifecycle(
  tracker: LifecycleTracker,
  onChange: (snapshot: LifecycleSnapshot, resumedAfterMs: number | null) => void,
  host?: LifecycleHost,
  pageHost?: LifecycleHost,
): () => void {
  const doc =
    host ??
    (typeof document !== 'undefined' ? (document as unknown as LifecycleHost) : null);
  if (!doc) return () => undefined;
  const page =
    pageHost ?? (typeof window !== 'undefined' ? (window as unknown as LifecycleHost) : doc);

  const onHidden = (): void => {
    if (tracker.markHidden()) onChange(tracker.snapshot, null);
  };
  const onVisible = (): void => {
    const ms = tracker.markVisible();
    if (ms !== null) onChange(tracker.snapshot, ms);
  };
  const onFreeze = (): void => {
    if (tracker.markFrozen()) onChange(tracker.snapshot, null);
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') onHidden();
    else onVisible();
  };

  doc.addEventListener('visibilitychange', onVisibility);
  doc.addEventListener('freeze', onFreeze);
  doc.addEventListener('resume', onVisible);
  page.addEventListener('pagehide', onHidden);
  page.addEventListener('pageshow', onVisible);

  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    doc.removeEventListener('freeze', onFreeze);
    doc.removeEventListener('resume', onVisible);
    page.removeEventListener('pagehide', onHidden);
    page.removeEventListener('pageshow', onVisible);
  };
}

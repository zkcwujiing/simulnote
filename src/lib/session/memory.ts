/**
 * 内存守卫 —— M2「长时间会话的内存回收」的观测层。
 *
 * ## 先说清楚它**不能**做什么
 *
 * 浏览器里没有一个 API 能告诉你「现在还剩多少内存」。`performance.memory`
 * 只在 Chromium 系暴露，而且：
 *   - 它量的是 **JS 堆**，而模型权重、`Float32Array` 的后备存储、ORT 的
 *     arena 全都在堆外。V8 探针已经实测过这一点：同一台小米平板上，
 *     两个模型都驻留之后堆读数几乎不动（`3585.82 → 3585.82 MB`）。
 *   - `usedJSHeapSize` 超过 `jsHeapSizeLimit` 是**正常现象**，
 *     不是「快爆了」（探针的 `heapReadingSane()` 就是为此写的）。
 *
 * 所以这里**不做「还剩多少」的估计，也不做自动降档**。一个建立在错误读数上的
 * 自动降档，比不降档更危险 —— 它会在设备其实很宽裕的时候把模型卸掉，
 * 让用户白白等一次重载。
 *
 * ## 它真正做的事
 *
 * 1. **只判断趋势**：同一个会话里堆占用是不是在单调上涨。涨说明有东西在泄漏
 *    （这是我们**能**修的），不涨就什么都不做。
 * 2. 越过绝对水位（接近内核给的堆上限）时给用户一句实话，让他决定要不要停下
 *    来出纪要 —— 而不是替他决定。
 * 3. 读到不可信的读数（iOS Safari 根本没有、或 used > limit）时**明确返回 null**，
 *    让调用方知道「这台设备量不了」，而不是拿一个假数字去判断。
 */

export interface HeapReading {
  usedMb: number;
  limitMb: number;
  /** used / limit。> 1 在 Chromium 上很常见，不代表异常。 */
  ratio: number;
}

/** `performance.memory` 的最小可用形状（非标准 API，各内核字段名一致）。 */
export interface MemoryScopeLike {
  memory?: {
    usedJSHeapSize?: number;
    jsHeapSizeLimit?: number;
    totalJSHeapSize?: number;
  };
}

/** 观测间隔。太密没有意义（GC 本来就有噪声），太疏会漏掉一段持续上涨。 */
export const MEMORY_GUARD_INTERVAL_MS = 15_000;

/** 高于这个比例算「值得留意」，高于 `HEAP_HIGH_RATIO` 才算「该跟用户说一声」。 */
export const HEAP_WATCH_RATIO = 0.7;
export const HEAP_HIGH_RATIO = 0.85;

const MB = 1024 * 1024;

/** 读一次堆占用。**读不到可信值时返回 null**，不要用 0 冒充。 */
export function readHeap(scope?: MemoryScopeLike): HeapReading | null {
  const target =
    scope ?? (typeof performance !== 'undefined' ? (performance as MemoryScopeLike) : undefined);
  const memory = target?.memory;
  if (!memory) return null;
  const used = memory.usedJSHeapSize;
  const limit = memory.jsHeapSizeLimit;
  if (typeof used !== 'number' || typeof limit !== 'number') return null;
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return { usedMb: used / MB, limitMb: limit / MB, ratio: used / limit };
}

export type HeapLevel = 'unknown' | 'ok' | 'watch' | 'high';

export function heapLevel(reading: HeapReading | null): HeapLevel {
  if (!reading) return 'unknown';
  if (reading.ratio >= HEAP_HIGH_RATIO) return 'high';
  if (reading.ratio >= HEAP_WATCH_RATIO) return 'watch';
  return 'ok';
}

/**
 * 只比「涨没涨」，不比绝对值。
 * `toleranceMb` 是给 GC 抖动的余量：涨了不到 8 MB 不算涨。
 */
export function heapTrend(
  previous: HeapReading | null,
  current: HeapReading | null,
  toleranceMb = 8,
): 'unknown' | 'flat' | 'rising' {
  if (!previous || !current) return 'unknown';
  if (current.usedMb - previous.usedMb > toleranceMb) return 'rising';
  return 'flat';
}

export function describeHeap(reading: HeapReading | null): string {
  if (!reading) {
    return '这个内核不暴露 performance.memory（iOS Safari 就是这样），本机看不了堆占用。';
  }
  const level = heapLevel(reading);
  const base = `JS 堆 ${reading.usedMb.toFixed(0)} / ${reading.limitMb.toFixed(0)} MB`;
  if (level === 'high') {
    return `${base}。注意：模型权重不在 JS 堆里，所以这个数字**不代表**真实内存压力，仅供参考。`;
  }
  return `${base}。`;
}

/**
 * M0 可行性探针 —— 在真实设备上回答 docs/06 §6.2 的 V1–V8 问题。
 *
 * 设计原则：
 * 1. **只回答一个问题，不做美化**（docs/06 原文要求）。
 * 2. **不改动主应用状态**：探针页是独立入口（probe.html），不碰 sessionStore。
 * 3. **失败也要出数据**：任何探针抛错都记录成结论，而不是让整页崩掉。
 * 4. **能自己算的就自己算**：设备画像、内存上限、存储配额、RTF 都是数字；
 *    只有「翻译质量」「摘要命中率」需要人看，所以把原文和译文并排贴出来。
 *
 * 注意：探针和主应用一样，模型只从本站 `/models/` 读（见 lib/modelSource.ts），
 * 所以这里能测的模型 = `scripts/fetch-models.mjs` 清单里的那些。
 * 测别的 id 会立刻报 `ModelFileNotFoundError`，那不是坏了，是本站没托管它。
 */

import { configureModelSource } from '@/lib/modelSource';
import { configureOrtWasm } from '@/lib/ortEnv';

export type ProbeState = 'idle' | 'running' | 'pass' | 'warn' | 'fail' | 'skip';

/**
 * 把实际生效的 ORT 运行时位置说成人话，写进报告。
 *
 * 加这一条是因为上一次真机翻车时，报告里只有一句 `TypeError: Load failed`，
 * 完全看不出「ORT 的 wasm 其实被送到了 cdn.jsdelivr.net」——
 * 结果把一个 CDN 连不上的问题误判成了模型问题。以后报告里必须有这一行。
 */
export function describeWasmPaths(value: string | Record<string, string> | null): string {
  if (value === null) return '⚠️ 无法设置（transformers.js 版本过老），由 ORT 自行决定';
  if (typeof value === 'string') return `外置基址 ${value}`;
  const mjs = value.mjs ?? '';
  const wasm = value.wasm ?? '';
  const host = (() => {
    try {
      return new URL(mjs).host;
    } catch {
      return '（相对路径）';
    }
  })();
  return `${host} → ${mjs.split('/').pop()} + ${wasm.split('/').pop()}`;
}

export interface ProbeResult {
  id: string;
  title: string;
  /** 一句话结论，会进报告 */
  verdict: string;
  state: ProbeState;
  /** 任意结构化明细，报告里按 key: value 展开 */
  details: Record<string, unknown>;
  /** 需要人眼看的东西（原文/译文/摘要句） */
  samples?: string[];
  error?: string;
}

export const emptyResult = (id: string, title: string): ProbeResult => ({
  id,
  title,
  verdict: '未运行',
  state: 'idle',
  details: {},
});

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

const MB = 1024 * 1024;

export function fmtBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / 1024 / MB).toFixed(2)} GB`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** 带超时的 fetch + 读流，用来测「模型下载速度」这个最不可控的变量。 */
export async function timedFetch(
  url: string,
  onProgress?: (loaded: number, total: number | null) => void,
  timeoutMs = 120_000,
): Promise<{ bytes: number; ms: number; ok: boolean; status: number; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    let loaded = 0;
    const total = res.headers.get('content-length')
      ? Number(res.headers.get('content-length'))
      : null;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        loaded += value?.byteLength ?? 0;
        onProgress?.(loaded, total);
      }
    } else {
      const buf = await res.arrayBuffer();
      loaded = buf.byteLength;
      onProgress?.(loaded, total);
    }
    return { bytes: loaded, ms: performance.now() - started, ok: res.ok, status: res.status };
  } catch (err) {
    return {
      bytes: 0,
      ms: performance.now() - started,
      ok: false,
      status: -1,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────
// P0 设备画像（其余所有探针的解释基础）
// ─────────────────────────────────────────────────────────────

function hasWasmSimd(): boolean {
  try {
    // 一个最小合法模块：导出接受 v128 参数的函数，只有支持 SIMD 的引擎才 validate 通过
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
        253, 15, 253, 98, 11,
      ]),
    );
  } catch {
    return false;
  }
}

export interface GpuInfo {
  available: boolean;
  vendor?: string;
  architecture?: string;
  description?: string;
  maxBufferSizeMb?: number;
  maxStorageBindingMb?: number;
  maxComputeWorkgroupKb?: number;
  features?: string[];
  error?: string;
}

/**
 * 极简的 WebGPU 类型替身。
 * 项目没有安装 @webgpu/types（见 tsconfig.app.json 的 types 只留 vite/client），
 * 而这里只用到三个 limit 字段，自己声明比多引一个类型包更省。
 */
interface MinimalGpuAdapter {
  limits?: {
    maxBufferSize?: number;
    maxStorageBufferBindingSize?: number;
    maxComputeWorkgroupStorageSize?: number;
  };
  features?: Iterable<string>;
  info?: { vendor?: string; architecture?: string; description?: string };
}
interface MinimalGpu {
  requestAdapter: () => Promise<MinimalGpuAdapter | null>;
}

export async function probeGpu(): Promise<GpuInfo> {
  const gpu = (navigator as unknown as { gpu?: MinimalGpu }).gpu;
  if (!gpu) return { available: false, error: '这个浏览器没有 navigator.gpu（不支持 WebGPU）' };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { available: false, error: '有 navigator.gpu 但 requestAdapter() 返回 null' };
    const limits = adapter.limits;
    const info = adapter.info;
    return {
      available: true,
      vendor: info?.vendor ?? '（浏览器未暴露）',
      architecture: info?.architecture ?? '（浏览器未暴露）',
      description: info?.description ?? '（浏览器未暴露）',
      maxBufferSizeMb: limits?.maxBufferSize ? round(limits.maxBufferSize / MB) : undefined,
      maxStorageBindingMb: limits?.maxStorageBufferBindingSize
        ? round(limits.maxStorageBufferBindingSize / MB)
        : undefined,
      maxComputeWorkgroupKb: limits?.maxComputeWorkgroupStorageSize
        ? round(limits.maxComputeWorkgroupStorageSize / 1024)
        : undefined,
      features: adapter.features ? Array.from(adapter.features).slice(0, 20) : [],
    };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface MemoryPerformance extends Performance {
  memory?: {
    jsHeapSizeLimit: number;
    totalJSHeapSize: number;
    usedJSHeapSize: number;
  };
}

export interface DeviceProfile {
  userAgent: string;
  uaDataMobile: boolean | null;
  platform: string;
  language: string;
  hardwareConcurrency: number | null;
  deviceMemoryGb: number | null;
  nativeDeviceMemory: boolean;
  jsHeapLimitMb: number | null;
  jsHeapUsedMb: number | null;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  wasmSimd: boolean;
  wasmThreads: boolean;
  secureContext: boolean;
  screen: string;
  dpr: number;
  online: boolean;
  connectionType: string | null;
  battery: string | null;
}

export async function probeDevice(): Promise<DeviceProfile> {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { mobile?: boolean };
    connection?: { effectiveType?: string };
  };
  const perf = performance as MemoryPerformance;

  let battery: string | null = null;
  try {
    const getBattery = (navigator as unknown as {
      getBattery?: () => Promise<{ level: number; charging: boolean }>;
    }).getBattery;
    if (getBattery) {
      const b = await getBattery.call(navigator);
      battery = `${Math.round(b.level * 100)}%${b.charging ? ' 充电中' : ''}`;
    }
  } catch {
    battery = null;
  }

  return {
    userAgent: navigator.userAgent,
    uaDataMobile: nav.userAgentData?.mobile ?? null,
    platform: nav.platform ?? '—',
    language: nav.language,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemoryGb: nav.deviceMemory ?? null,
    nativeDeviceMemory: 'deviceMemory' in nav,
    jsHeapLimitMb: perf.memory ? round(perf.memory.jsHeapSizeLimit / MB) : null,
    jsHeapUsedMb: perf.memory ? round(perf.memory.usedJSHeapSize / MB) : null,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    wasmSimd: hasWasmSimd(),
    wasmThreads: typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true,
    secureContext: globalThis.isSecureContext === true,
    screen: `${screen.width}×${screen.height}`,
    dpr: round(window.devicePixelRatio, 2),
    online: navigator.onLine,
    connectionType: nav.connection?.effectiveType ?? null,
    battery,
  };
}

// ─────────────────────────────────────────────────────────────
// P1（=V8）内存压力测试 —— 最关键的一个数字
// ─────────────────────────────────────────────────────────────

export interface MemoryStressResult {
  stepMb: number;
  /** 成功分配并真正写入（touch）的累计 MB */
  achievedMb: number;
  failedAtMb: number | null;
  failureMessage: string | null;
  durationMs: number;
  releasedOk: boolean;
}

/**
 * 一块一块地要内存，直到要不到为止。
 *
 * 为什么要「写入」而不只是分配：现代引擎的 ArrayBuffer 是惰性提交的，只分配
 * 不写的话能"分配"出远超真实上限的量，数字没有意义。所以每块都填一遍 1，
 * 强制物理提交。
 *
 * ⚠️ 这个探针会把内存用到接近极限，手机上有可能导致标签页被系统杀掉。
 *    这是**故意**的：我们要的就是那个阈值。
 */
export async function stressMemory(
  maxMb = 3072,
  stepMb = 64,
  onStep?: (achievedMb: number) => void,
): Promise<MemoryStressResult> {
  const blocks: Float32Array[] = [];
  const started = performance.now();
  let achieved = 0;
  let failedAt: number | null = null;
  let failureMessage: string | null = null;

  try {
    for (let m = stepMb; m <= maxMb; m += stepMb) {
      let block: Float32Array | null = null;
      try {
        block = new Float32Array((stepMb * MB) / 4);
        // 强制物理提交（分页写入，避免被优化掉）
        block.fill(1);
      } catch (err) {
        failedAt = m;
        failureMessage = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        break;
      }
      blocks.push(block);
      achieved = m;
      onStep?.(achieved);
      // 让出主线程，否则手机上整个界面会假死
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    // 一定要还回去，否则后面的模型探针跑不动
    blocks.length = 0;
  }

  // 等一下让 GC 有机会回收，再看一次堆占用
  await new Promise((r) => setTimeout(r, 300));

  return {
    stepMb,
    achievedMb: achieved,
    failedAtMb: failedAt,
    failureMessage,
    durationMs: round(performance.now() - started, 0),
    releasedOk: true,
  };
}

export interface StorageInfo {
  quotaMb: number | null;
  usageMb: number | null;
  persistent: boolean | null;
  cacheStorage: boolean;
  indexedDb: boolean;
}

export async function probeStorage(): Promise<StorageInfo> {
  let quotaMb: number | null = null;
  let usageMb: number | null = null;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) quotaMb = round(est.quota / MB);
    if (est?.usage !== undefined) usageMb = round(est.usage / MB);
  } catch {
    /* 某些隐私模式下 estimate 会抛 */
  }
  let persistent: boolean | null = null;
  try {
    if (navigator.storage?.persisted) persistent = await navigator.storage.persisted();
  } catch {
    persistent = null;
  }
  return {
    quotaMb,
    usageMb,
    persistent,
    cacheStorage: typeof caches !== 'undefined',
    indexedDb: typeof indexedDB !== 'undefined',
  };
}

/** 真的写一份 4 MB 进 Cache Storage 再读回来 —— 只判断 API 存在是不够的。 */
export async function probeCacheWrite(): Promise<{ ok: boolean; ms: number; detail: string }> {
  const started = performance.now();
  try {
    if (typeof caches === 'undefined') return { ok: false, ms: 0, detail: '没有 Cache Storage' };
    const cache = await caches.open('simulnote-probe');
    const payload = new Uint8Array(4 * MB);
    const res = new Response(payload, {
      headers: { 'content-type': 'application/octet-stream' },
    });
    await cache.put('/__probe_blob', res);
    const back = await cache.match('/__probe_blob');
    const buf = back ? await back.arrayBuffer() : new ArrayBuffer(0);
    await cache.delete('/__probe_blob');
    const ok = buf.byteLength === payload.byteLength;
    return {
      ok,
      ms: round(performance.now() - started, 0),
      detail: ok ? '写入并读回 4 MB 成功（模型可以持久化缓存）' : `读回大小不符：${buf.byteLength}`,
    };
  } catch (err) {
    return {
      ok: false,
      ms: round(performance.now() - started, 0),
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

// ─────────────────────────────────────────────────────────────
// P2（=V3）Chrome 内置 Translator API
// ─────────────────────────────────────────────────────────────

export const MT_SAMPLES: string[] = [
  'Revenue grew 23% to $4.8 million in the fourth quarter.',
  'The deadline is March 15, 2026, and we cannot move it.',
  'We decided to migrate the billing service to PostgreSQL last week.',
  'Action item: Sarah will send the revised forecast by Friday.',
  'The board rejected the acquisition because the valuation was too high.',
  'Latency dropped from 820 milliseconds to 140 milliseconds after the rewrite.',
  'About 60% of the test group preferred the new onboarding flow.',
  'Please review the contract before the 31st of January.',
  'There is a risk that the vendor will raise prices next year.',
  'The team shipped three releases in two weeks.',
];

export interface TranslatorProbeResult {
  ctorAvailable: boolean;
  availability: string | null;
  created: boolean;
  pair: { sourceLanguage: string; targetLanguage: string };
  perSentenceMs: number[];
  meanMs: number | null;
  throughputPerSec: number | null;
  outputs: string[];
  error?: string;
}

type TranslatorLike = {
  availability: (opts: { sourceLanguage: string; targetLanguage: string }) => Promise<string>;
  create: (opts: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: EventTarget) => void;
  }) => Promise<{ translate: (t: string) => Promise<string>; destroy?: () => void }>;
};

export async function probeTranslatorApi(
  onNote?: (note: string) => void,
  onProgress?: (p: number) => void,
): Promise<TranslatorProbeResult> {
  const pair = { sourceLanguage: 'en', targetLanguage: 'zh' };
  const ctor = (globalThis as unknown as { Translator?: TranslatorLike }).Translator;
  const base: TranslatorProbeResult = {
    ctorAvailable: Boolean(ctor),
    availability: null,
    created: false,
    pair,
    perSentenceMs: [],
    meanMs: null,
    throughputPerSec: null,
    outputs: [],
  };
  if (!ctor) {
    return { ...base, error: '没有全局 Translator 构造器（旧版 window.ai.translator 已废弃，本项目不使用）' };
  }

  try {
    // 必须把**同一个** {sourceLanguage,targetLanguage} 对象传给 availability 和 create
    const availability = await ctor.availability(pair);
    base.availability = availability;
    onNote?.(`availability() = ${availability}`);
    if (availability === 'unavailable') {
      return { ...base, error: '这台设备上 en→zh 不可用' };
    }

    onNote?.('正在调用 create()（下载语言包可能需要几十秒）…');
    const translator = await ctor.create({
      ...pair,
      monitor(m: EventTarget) {
        m.addEventListener('downloadprogress', (e) => {
          const loaded = (e as unknown as { loaded?: number }).loaded;
          if (typeof loaded === 'number') onProgress?.(loaded);
        });
      },
    });
    base.created = true;

    for (const text of MT_SAMPLES) {
      const t0 = performance.now();
      const out = await translator.translate(text);
      base.perSentenceMs.push(round(performance.now() - t0, 0));
      base.outputs.push(out);
    }

    const sum = base.perSentenceMs.reduce((a, b) => a + b, 0);
    base.meanMs = round(sum / base.perSentenceMs.length, 0);
    base.throughputPerSec = round(1000 / (base.meanMs || 1), 1);
    translator.destroy?.();
    return base;
  } catch (err) {
    return {
      ...base,
      error:
        err instanceof Error
          ? `${err.name}: ${err.message}${err.name === 'NotAllowedError' ? '（create() 必须由用户手势触发）' : ''}`
          : String(err),
    };
  }
}

// ─────────────────────────────────────────────────────────────
// P3（=V2 / V4）本地模型：下载、加载、推理
// ─────────────────────────────────────────────────────────────

export interface ModelTimingResult {
  modelId: string;
  device: string;
  dtype: string;
  downloadMs: number | null;
  downloadedBytes: number | null;
  initMs: number | null;
  /** 推理耗时 / 音频时长 */
  rtf: number | null;
  audioSec: number;
  inferMs: number | null;
  text: string | null;
  /** ORT 运行时实际从哪儿取（人话）。用来一眼看出有没有被送去第三方 CDN。 */
  ortRuntime: string | null;
  error?: string;
}

/**
 * 合成一段「像语音」的音频：基频 + 谐波 + 轻微噪声。
 * 只用来量速度和内存 —— **不能用来判断识别质量**（那不是真语音）。
 */
export function synthSpeech(seconds: number, sampleRate = 16000): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // 音高在 90–180Hz 之间缓慢滑动，模拟句子的语调起伏
    const f0 = 120 + 40 * Math.sin(2 * Math.PI * 0.25 * t);
    phase += (2 * Math.PI * f0) / sampleRate;
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(phase * h) / h;
    v = v / 2.4 + (Math.random() - 0.5) * 0.05;
    // 每 2 秒留 0.3 秒停顿，更像真实讲话
    const inPause = t % 2 > 1.7;
    out[i] = inPause ? v * 0.02 : v * 0.35;
  }
  return out;
}

export interface WhisperBenchOptions {
  modelId: string;
  audioSec: number;
  device: 'webgpu' | 'wasm';
  dtype: string;
  onNote?: (note: string) => void;
  onProgress?: (ratio: number, label: string) => void;
}

export async function benchWhisper(opts: WhisperBenchOptions): Promise<ModelTimingResult> {
  const result: ModelTimingResult = {
    modelId: opts.modelId,
    device: opts.device,
    dtype: opts.dtype,
    downloadMs: null,
    downloadedBytes: null,
    initMs: null,
    rtf: null,
    audioSec: opts.audioSec,
    inferMs: null,
    text: null,
    ortRuntime: null,
  };
  try {
    opts.onNote?.('动态导入 @huggingface/transformers …');
    const t0 = performance.now();
    const mod = await import('@huggingface/transformers');
    const { pipeline, env } = mod;
    opts.onNote?.(`模块加载完成（${Math.round(performance.now() - t0)} ms）`);

    configureModelSource(env);
    const wasmPaths = configureOrtWasm(env);
    opts.onNote?.(
      `模型来源：本站 ${String((env as { localModelPath?: string }).localModelPath ?? '')}；` +
        `ORT 运行时：${describeWasmPaths(wasmPaths)}`,
    );
    result.ortRuntime = describeWasmPaths(wasmPaths);

    let bytes = 0;
    let firstProgressAt: number | null = null;
    const loadStart = performance.now();

    const transcriber = await pipeline('automatic-speech-recognition', opts.modelId, {
      device: opts.device,
      dtype: opts.dtype,
      progress_callback: (info: {
        status?: string;
        progress?: number;
        loaded?: number;
        file?: string;
      }) => {
        if (info.status === 'progress') {
          if (firstProgressAt === null) firstProgressAt = performance.now();
          if (typeof info.loaded === 'number') bytes = Math.max(bytes, info.loaded);
          opts.onProgress?.((info.progress ?? 0) / 100, info.file ?? '');
        }
      },
    } as never);

    result.initMs = round(performance.now() - loadStart, 0);
    result.downloadMs = firstProgressAt === null ? 0 : round(performance.now() - firstProgressAt, 0);
    result.downloadedBytes = bytes || null;
    opts.onNote?.(`模型就绪（${result.initMs} ms）`);

    const audio = synthSpeech(opts.audioSec);
    opts.onNote?.('开始推理…');
    const t1 = performance.now();
    const output = await (transcriber as unknown as (
      a: Float32Array,
      o: Record<string, unknown>,
    ) => Promise<{ text: string } | { text: string }[]>)(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    result.inferMs = round(performance.now() - t1, 0);
    const first = Array.isArray(output) ? output[0] : output;
    result.text = first?.text ?? '';
    result.rtf = round((result.inferMs ?? 0) / 1000 / opts.audioSec, 3);

    (transcriber as unknown as { dispose?: () => Promise<void> }).dispose?.();
    return result;
  } catch (err) {
    result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return result;
  }
}

export interface MtBenchResult {
  modelId: string;
  device: string;
  dtype: string;
  initMs: number | null;
  perSentenceMs: number[];
  meanMs: number | null;
  throughputPerSec: number | null;
  outputs: string[];
  /** ORT 运行时实际从哪儿取（人话）。 */
  ortRuntime: string | null;
  error?: string;
}

export async function benchMt(opts: {
  modelId: string;
  device: 'webgpu' | 'wasm';
  dtype: string;
  onNote?: (note: string) => void;
  onProgress?: (ratio: number, label: string) => void;
}): Promise<MtBenchResult> {
  const result: MtBenchResult = {
    modelId: opts.modelId,
    device: opts.device,
    dtype: opts.dtype,
    initMs: null,
    perSentenceMs: [],
    meanMs: null,
    throughputPerSec: null,
    outputs: [],
    ortRuntime: null,
  };
  try {
    opts.onNote?.('动态导入 @huggingface/transformers …');
    const { pipeline, env } = await import('@huggingface/transformers');
    configureModelSource(env);
    const wasmPaths = configureOrtWasm(env);
    opts.onNote?.(`ORT 运行时：${describeWasmPaths(wasmPaths)}`);
    result.ortRuntime = describeWasmPaths(wasmPaths);

    const loadStart = performance.now();
    const translator = await pipeline('translation', opts.modelId, {
      device: opts.device,
      dtype: opts.dtype,
      progress_callback: (info: { status?: string; progress?: number; file?: string }) => {
        if (info.status === 'progress') opts.onProgress?.((info.progress ?? 0) / 100, info.file ?? '');
      },
    } as never);
    result.initMs = round(performance.now() - loadStart, 0);
    opts.onNote?.(`模型就绪（${result.initMs} ms）`);

    const call = translator as unknown as (
      t: string[],
      o?: Record<string, unknown>,
    ) => Promise<{ translation_text: string }[]>;

    // opus-mt 这类模型需要显式给源语言前缀时才稳；先试带前缀，失败了再试不带
    for (const text of MT_SAMPLES) {
      const t0 = performance.now();
      let out = '';
      try {
        const r = await call([text], { src_lang: 'eng_Latn', tgt_lang: 'zho_Hans' });
        out = r?.[0]?.translation_text ?? '';
      } catch {
        const r = await call([text]);
        out = r?.[0]?.translation_text ?? '';
      }
      result.perSentenceMs.push(round(performance.now() - t0, 0));
      result.outputs.push(out);
    }

    const sum = result.perSentenceMs.reduce((a, b) => a + b, 0);
    result.meanMs = round(sum / result.perSentenceMs.length, 0);
    result.throughputPerSec = round(1000 / (result.meanMs || 1), 1);
    (translator as unknown as { dispose?: () => Promise<void> }).dispose?.();
    return result;
  } catch (err) {
    result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return result;
  }
}

// ─────────────────────────────────────────────────────────────
// P4（=V6）抽取式摘要自检
// ─────────────────────────────────────────────────────────────

export const SUMMARY_SAMPLE: string[] = [
  'We reviewed the quarterly results and the numbers came in well above plan.',
  'Revenue reached 4.8 million dollars, which is up 23 percent from last quarter.',
  'Gross margin held steady at 61 percent despite the increase in infrastructure cost.',
  'The main driver was enterprise renewals, especially in the manufacturing segment.',
  'On the product side, we finally shipped the new billing pipeline three weeks late.',
  'The delay was caused by the migration to PostgreSQL, which took longer than estimated.',
  'Latency dropped from 820 milliseconds to 140 milliseconds after the rewrite, so users did notice.',
  'For next quarter, the plan is to double the size of the data team.',
  'We decided to postpone the European launch until the second half of the year.',
  'The board rejected the acquisition of Northwind because the valuation was too high.',
  'Action item: Sarah will send the revised forecast by Friday the fifteenth of March.',
  'Action item: the platform team must publish a written incident review before the next review meeting.',
  'There is a real risk that our main vendor will raise prices again next year.',
  'We should also watch the churn rate, which moved from 2.1 to 3.4 percent this quarter.',
];

export interface ExtractiveProbeResult {
  ok: boolean;
  keyPoints: string[];
  keywords: string[];
  facts: { raw: string; zh: string; kind: string }[];
  elapsedMs: number;
  error?: string;
}

export async function probeExtractive(): Promise<ExtractiveProbeResult> {
  const t0 = performance.now();
  try {
    const { extractKeywords } = await import('@/engines/sum/extractiveSum');
    const { extractFacts } = await import('@/engines/sum/facts');
    const { textRank } = await import('@/engines/sum/textRank');

    // textRank 返回的是**原文顺序**的完整排名，取前 5 要自己按 score 排。
    const ranked = textRank(SUMMARY_SAMPLE)
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const keywords = extractKeywords(SUMMARY_SAMPLE, 8).map((k) =>
      k.zh && k.zh !== k.en ? `${k.en}（${k.zh}）` : k.en,
    );
    const facts = extractFacts(SUMMARY_SAMPLE);
    return {
      ok: true,
      keyPoints: ranked.map((r) => `[第 ${r.index + 1} 句 · ${r.score.toFixed(2)}] ${r.text}`),
      keywords,
      facts: facts.map((f) => ({ raw: f.raw, zh: f.zh, kind: f.kind })),
      elapsedMs: round(performance.now() - t0, 0),
    };
  } catch (err) {
    return {
      ok: false,
      keyPoints: [],
      keywords: [],
      facts: [],
      elapsedMs: round(performance.now() - t0, 0),
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

// ─────────────────────────────────────────────────────────────
// P5 麦克风与语音识别可用性（不弹权限，只查能力）
// ─────────────────────────────────────────────────────────────

export interface MicCapability {
  mediaDevices: boolean;
  getUserMedia: boolean;
  enumerateDevices: boolean;
  audioWorklet: boolean;
  scriptProcessor: boolean;
  speechRecognition: boolean;
  speechRecognitionPrefixed: boolean;
  audioContextRate: number | null;
  canForce16k: boolean;
}

export async function probeMicCapability(): Promise<MicCapability> {
  const nav = navigator as Navigator & {
    webkitGetUserMedia?: unknown;
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  const mediaDevices = typeof navigator.mediaDevices !== 'undefined';
  let audioContextRate: number | null = null;
  let canForce16k = false;
  try {
    const ctx = new AudioContext({ sampleRate: 16000 });
    audioContextRate = ctx.sampleRate;
    canForce16k = Math.abs(ctx.sampleRate - 16000) < 1;
    await ctx.close();
  } catch {
    audioContextRate = null;
  }
  return {
    mediaDevices,
    getUserMedia: Boolean(navigator.mediaDevices?.getUserMedia) || Boolean(nav.webkitGetUserMedia),
    enumerateDevices: Boolean(navigator.mediaDevices?.enumerateDevices),
    audioWorklet: typeof AudioWorkletNode !== 'undefined',
    scriptProcessor: typeof ScriptProcessorNode !== 'undefined',
    speechRecognition: typeof nav.SpeechRecognition !== 'undefined',
    speechRecognitionPrefixed: typeof nav.webkitSpeechRecognition !== 'undefined',
    audioContextRate,
    canForce16k,
  };
}

// ─────────────────────────────────────────────────────────────
// 报告生成：把结果变成一段能直接粘回来的 Markdown
// ─────────────────────────────────────────────────────────────

export function toMarkdownReport(results: ProbeResult[]): string {
  const lines: string[] = [];
  lines.push('# SimulNote M0 探针报告');
  lines.push('');
  lines.push(`- 采集时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`- 页面地址：${location.href}`);
  lines.push('');
  for (const r of results) {
    if (r.state === 'idle') continue;
    lines.push(`## ${r.id} · ${r.title}`);
    lines.push('');
    lines.push(`**结论（${stateLabel(r.state)}）**：${r.verdict}`);
    if (r.error) lines.push(`\n**错误**：\`${r.error}\``);
    const entries = Object.entries(r.details);
    if (entries.length) {
      lines.push('');
      for (const [k, v] of entries) {
        lines.push(`- ${k}: ${formatValue(v)}`);
      }
    }
    if (r.samples?.length) {
      lines.push('');
      lines.push('```');
      for (const s of r.samples) lines.push(s);
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function stateLabel(s: ProbeState): string {
  switch (s) {
    case 'pass':
      return '通过';
    case 'warn':
      return '及格但有隐患';
    case 'fail':
      return '不通过';
    case 'skip':
      return '跳过';
    case 'running':
      return '运行中';
    default:
      return '未运行';
  }
}

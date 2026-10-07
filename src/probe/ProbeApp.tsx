import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  benchMt,
  benchWhisper,
  emptyResult,
  fmtBytes,
  fmtMs,
  MT_SAMPLES,
  benchOrtRuntime,
  benchMemoryFull,
  clearMemoryPartial,
  readMemoryPartial,
  probeCacheWrite,
  probeDevice,
  probeExtractive,
  probeGpu,
  probeMicCapability,
  probeStorage,
  probeTranslatorApi,
  stateLabel,
  toMarkdownReport,
  type ProbeResult,
  type ProbeState,
} from './probes';
import { activeSource, clearModelCache, encoderRelFor, forgetSource, sourceUrlsForTest } from '@/lib/modelSource';
import { deviceMemoryGb, mobileEvidence } from '@/lib/device';

const CARD = 'rounded-2xl border border-slate-700/70 bg-slate-900/70 p-4';
const BTN =
  'inline-flex min-h-10 items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const BTN_PRIMARY = `${BTN} bg-teal-500 text-slate-950 hover:bg-teal-400`;
const BTN_GHOST = `${BTN} border border-slate-600 text-slate-200 hover:bg-slate-800`;
const BTN_DANGER = `${BTN} bg-red-600 text-white hover:bg-red-500`;

const TONE: Record<ProbeState, string> = {
  idle: 'border-slate-600 text-slate-400',
  running: 'border-sky-500/60 text-sky-300',
  pass: 'border-teal-500/60 text-teal-300',
  warn: 'border-amber-400/60 text-amber-300',
  fail: 'border-red-500/60 text-red-300',
  skip: 'border-slate-600 text-slate-400',
};

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
      {hint && <p className="mt-1 text-xs leading-5 text-slate-400">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ResultCard({ r }: { r: ProbeResult }) {
  return (
    <div className={`mt-3 rounded-xl border px-3 py-2.5 ${TONE[r.state]}`}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px]">{r.id}</span>
        <span className="text-xs font-medium">{r.title}</span>
        <span className="ml-auto text-[11px]">{stateLabel(r.state)}</span>
      </div>
      <p className="mt-1.5 text-sm leading-6 text-slate-100">{r.verdict}</p>
      {r.error && (
        <p className="mt-1.5 break-all font-mono text-[11px] leading-5 text-red-300">{r.error}</p>
      )}
      {Object.keys(r.details).length > 0 && (
        <dl className="mt-2 grid grid-cols-[minmax(0,auto)_1fr] gap-x-3 gap-y-0.5 text-[11px] leading-5">
          {Object.entries(r.details).map(([k, v]) => (
            <div key={k} className="col-span-2 grid grid-cols-[minmax(0,auto)_1fr] gap-x-3">
              <dt className="text-slate-400">{k}</dt>
              <dd className="break-words text-slate-200">
                {v === null || v === undefined
                  ? '—'
                  : typeof v === 'object'
                    ? JSON.stringify(v)
                    : String(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {r.samples && r.samples.length > 0 && (
        <pre className="scroll-area mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/70 p-2 text-[11px] leading-5 text-slate-300">
          {r.samples.join('\n')}
        </pre>
      )}
    </div>
  );
}

export default function ProbeApp() {
  const [results, setResults] = useState<Record<string, ProbeResult>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [whisperModel, setWhisperModel] = useState('Xenova/whisper-tiny.en');
  const [whisperDevice, setWhisperDevice] = useState<'webgpu' | 'wasm'>('wasm');
  const [whisperSec, setWhisperSec] = useState(10);
  const [mtModel, setMtModel] = useState('Xenova/opus-mt-en-zh');
  const [copied, setCopied] = useState(false);
  const [cacheMsg, setCacheMsg] = useState<string | null>(null);
  // 上一轮内存探针的留痕：第一段会把内存推到极限，被系统杀掉标签页时
  // 只能靠 localStorage 里那几步把数字带回来。
  const [v8Partial, setV8Partial] = useState(() => readMemoryPartial());
  const reportRef = useRef<HTMLTextAreaElement>(null);

  const log = useCallback((line: string) => {
    setLogs((prev) => [...prev.slice(-60), `${new Date().toLocaleTimeString('zh-CN')}  ${line}`]);
  }, []);

  const put = useCallback((r: ProbeResult) => {
    setResults((prev) => ({ ...prev, [r.id]: r }));
  }, []);

  const run = useCallback(
    async (id: string, title: string, fn: () => Promise<ProbeResult>) => {
      setBusy(id);
      put({ ...emptyResult(id, title), state: 'running', verdict: '运行中…' });
      try {
        put(await fn());
      } catch (err) {
        put({
          ...emptyResult(id, title),
          state: 'fail',
          verdict: '探针本身崩了',
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
      } finally {
        setBusy(null);
      }
    },
    [put],
  );

  /**
   * 复测前清掉模型缓存。
   *
   * 为什么必须有这个按钮：transformers.js 自己读缓存时只做 `caches.match()`，
   * 命中就直接返回、**从不校验长度**。一次断线留下的半截 `.onnx` 会被永久命中，
   * 症状是「清了缓存就好、不清就永远坏」——而手机上从浏览器菜单里清缓存非常难找。
   */
  const runClearCache = useCallback(async () => {
    setBusy('clear');
    setCacheMsg('清除中…');
    try {
      const n = await clearModelCache();
      forgetSource();
      setCacheMsg(n === 0 ? '模型缓存本来就是空的（不影响复测）' : `已清掉 ${n} 项已下载的模型文件`);
      log(`清空模型缓存：删除 ${n} 项；同时忘掉上次的测速结论`);
    } finally {
      setBusy(null);
    }
  }, [log]);

  const all = useMemo(() => Object.values(results), [results]);  const done = all.filter((r) => r.state !== 'idle' && r.state !== 'running');

  // ── 零下载的安全项，一次跑完 ──────────────────────────────
  const runSafe = () =>
    run('P0', '设备画像 / 运行环境', async () => {
      const [device, gpu, storage, cache, mic] = await Promise.all([
        probeDevice(),
        probeGpu(),
        probeStorage(),
        probeCacheWrite(),
        probeMicCapability(),
      ]);
      log(`GPU 可用=${gpu.available} SIMD=${device.wasmSimd} 线程=${device.wasmThreads}`);
      log(`存储配额=${storage.quotaMb} MB 缓存写入=${cache.ok}`);

      const notes: string[] = [];
      if (!device.secureContext) notes.push('不是安全上下文（麦克风会被拒）');
      if (!device.wasmSimd) notes.push('没有 WASM SIMD（本地模型会非常慢）');
      if (!device.wasmThreads) notes.push('没有多线程 WASM（缺 COOP/COEP，速度约为一半）');
      if (gpu.available) notes.push('有 WebGPU');
      if (!mic.audioWorklet && !mic.scriptProcessor) notes.push('既没有 AudioWorklet 也没有 ScriptProcessor');
      if (!device.uaDataMobile) {
        const ev = mobileEvidence();
        if (!ev.verdict) notes.push(`判定为「不是手机/平板」（${ev.signals.join('；')}）`);
      }

      return {
        id: 'P0',
        title: '设备画像 / 运行环境',
        state: notes.length === 0 ? 'pass' : 'warn',
        verdict:
          notes.length === 0
            ? '环境齐备：安全上下文、WASM SIMD、缓存与麦克风接口都在。'
            : `发现 ${notes.length} 个需要注意的点，见下方 notes。`,
        details: {
          运行环境: notes.length ? notes.join('；') : '无异常',
          '是否移动端（含依据）': mobileEvidence().verdict
            ? `是 —— ${mobileEvidence().signals.join('；')}`
            : `否 —— ${mobileEvidence().signals.join('；')}`,
          机型: `${device.platform} · ${device.screen} · DPR ${device.dpr}`,
          逻辑核心数: device.hardwareConcurrency,
          'deviceMemory（GB）': device.deviceMemoryGb ?? '浏览器未暴露',
          'JS 堆上限（MB）': device.jsHeapLimitMb ?? '非 Chromium 内核',
          '在线/网络': `${device.online ? '在线' : '离线'} · ${device.connectionType ?? '未知'}`,
          电池: device.battery ?? '未暴露',
          'WebGPU': gpu.available
            ? `${gpu.vendor} · maxBuffer ${gpu.maxBufferSizeMb} MB · maxStorageBinding ${gpu.maxStorageBindingMb} MB`
            : (gpu.error ?? '不可用'),
          'WASM SIMD': device.wasmSimd,
          'WASM 多线程': device.wasmThreads,
          'SharedArrayBuffer': device.sharedArrayBuffer,
          'crossOriginIsolated': device.crossOriginIsolated,
          '存储配额（MB）': storage.quotaMb ?? '未暴露',
          '已用（MB）': storage.usageMb ?? '未暴露',
          'Cache Storage': storage.cacheStorage ? `可用，写读 4MB ${cache.ok ? '成功' : '失败'}` : '不可用',
          'IndexedDB': storage.indexedDb,
          'AudioContext 实际采样率': mic.audioContextRate ?? '创建失败',
          '能强制 16kHz': mic.canForce16k,
          AudioWorklet: mic.audioWorklet,
          ScriptProcessor: mic.scriptProcessor,
          '浏览器原生识别': mic.speechRecognition
            ? '有 SpeechRecognition'
            : mic.speechRecognitionPrefixed
              ? '有 webkitSpeechRecognition'
              : '没有（手机基本都没有）',
          'User-Agent': device.userAgent,
        },
      };
    });

  // ── V8 内存探针（两段）────────────────────────────────────
  const runMemory = () =>
    run('V8', '内存探针（设备上限 + 两个模型驻留后的余量）', async () => {
      log('内存探针：第一段量设备上限，第二段把 ASR 与 MT 同时驻留再量余量…');
      clearMemoryPartial();
      setV8Partial(null);
      const dtype = whisperDevice === 'webgpu' ? 'fp32' : 'q8';
      const r = await benchMemoryFull({
        asrModelId: whisperModel,
        mtModelId: mtModel,
        device: whisperDevice,
        dtype,
        onNote: log,
      });
      setV8Partial(readMemoryPartial());

      const ceilingMb = r.ceiling.achievedMb;
      const res = r.resident;
      const headroom = res?.headroomMb ?? null;
      log(`内存探针结束：上限 ${ceilingMb} MB，两个模型驻留后余量 ${headroom ?? '—'} MB`);

      const need = 700; // 手机档「ASR + MT」两个 q8 模型的粗估常驻需求
      const bothLoaded = res !== null && res.asrError === null && res.mtError === null;
      // 到探针自己的上限就停 = 只量到一个**下界**，真实余量更大。
      // 上一份报告把下界当成精确值写了（「还剩 2048 MB」），那是读数的人为天花板。
      const headroomAtLeast = res?.headroomStoppedEarly ?? false;
      const ceilingAtLeast = r.ceiling.failedAtMb === null;
      const headroomText =
        headroom === null ? '没跑成' : `${headroomAtLeast ? '≥ ' : ''}${headroom} MB`;
      const state: ProbeState =
        bothLoaded && headroom !== null
          ? headroom >= 256
            ? 'pass'
            : headroom >= 128
              ? 'warn'
              : 'fail'
          : ceilingMb >= need
            ? 'warn'
            : 'fail';

      const verdict = bothLoaded && headroom !== null
        ? headroom >= 256
          ? `两个模型同时驻留后还剩 ${headroomText}${headroomAtLeast ? '（只量到下界，真实余量更大）' : ''} ——「边听边译」有余量。`
          : headroom >= 128
            ? `两个模型同时驻留后只剩 ${headroomText} —— 能跑，但**不该再加任何常驻模型**（本地 LLM、第二语言、长会话都要省着用）。`
            : `两个模型同时驻留后只剩 ${headroomText} —— 余量太薄，「ASR + MT」同时跑有被系统杀标签页的风险。`
        : ceilingMb >= need
          ? `空设备能拿 ${ceilingMb} MB，但第二段没能跑起来（${res?.asrError ?? res?.mtError ?? r.residentError ?? '原因不明'}），「两个模型同时驻留」还没有凭据。`
          : `空设备只拿到 ${ceilingMb} MB，低于 ${need} MB 的安全线 —— 这台设备必须走「零下载 / 服务器识别」档。`;

      const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v} ms`);
      // 设备身份必须自带证据：连收三份写「是否移动端: false」却说是手机的报告，
      // 而报告里又没有「运行环境」段，谁都说不清跑的是哪台机器。
      const dev = mobileEvidence();
      const touchPoints = typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0;
      const uaDataMobile = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile;
      const devMemory = deviceMemoryGb();
      const screenText =
        typeof screen === 'undefined' ? '—' : `${screen.width}×${screen.height} @${devicePixelRatio}`;
      const details: Record<string, string> = {
        '第一段 · 空设备上限': `${ceilingMb} MB（步长 ${r.ceiling.stepMb} MB；${
          ceilingAtLeast
            ? '到探针上限就停，**真实上限更高**，这只是下界'
            : `在 ${r.ceiling.failedAtMb} MB 处真的写不进去了`
        }）`,
        '第一段 · 耗时（秒）': (r.ceiling.durationMs / 1000).toFixed(1),
        '第二段 · ASR 驻留': res?.asrError ? `失败：${res.asrError}` : pct(res?.asrMs),
        '第二段 · MT 驻留': res?.mtError ? `失败：${res.mtError}` : pct(res?.mtMs),
        '第二段 · 两个模型都驻留后的余量':
          headroom === null
            ? '没跑成'
            : `${headroomText}${headroomAtLeast ? `（到 ${res?.headroomCapMb} MB 上限主动停，真实余量比这个数大）` : ''}`,
        '第二段 · 是否到顶就停': res
          ? res.headroomStoppedEarly
            ? `是（到 ${res.headroomCapMb} MB 上限主动停，没往死里推）`
            : `否，在 ${res.headroomFailure ?? '未知位置'} 处真的失败了`
          : '—',
        '堆占用（加载前 → 模型就绪）':
          res && res.heapUsedBeforeMb !== null
            ? res.heapReadingSane
              ? `${res.heapUsedBeforeMb} → ${res.heapUsedLoadedMb} MB（内核上限 ${res.heapLimitMb} MB）`
              : `${res.heapUsedBeforeMb} → ${res.heapUsedLoadedMb} MB（内核上限 ${res.heapLimitMb} MB）—— **读数不可信**：模型权重与探针的 Float32Array 都是堆外后备存储，不计入 JS 堆，所以 used 会超过 limit 且几乎不变。这个数字对「边听边译」没有参考价值。`
            : '这个内核不暴露 performance.memory（iOS Safari 就是这样）',
        'ASR 模型': whisperModel,
        'MT 模型': mtModel,
        '推理后端 / dtype': `${whisperDevice} / ${dtype}`,
        是否移动端: `${dev.verdict ? '是' : '否'} —— 依据：${dev.signals.join('；')}`,
        '设备原始信息（自己核对）': `UA: ${navigator.userAgent}`,
        '设备原始信息（续）': `触点数 ${touchPoints} · uaData.mobile ${uaDataMobile ?? '不可用'} · 屏幕 ${screenText} · 逻辑核心 ${navigator.hardwareConcurrency ?? '未知'} · deviceMemory ${devMemory ?? '未暴露'} GB`,
        '第一段失败信息': r.ceiling.failureMessage ?? '无',
        备注: [...(res?.notes ?? []), r.residentError ? `第二段异常：${r.residentError}` : '']
          .filter(Boolean)
          .join(' '),
      };

      return {
        id: 'V8',
        title: '内存探针（设备上限 + 两个模型驻留后的余量）',
        state,
        verdict,
        details,
      };
    });

  // ── V9 ORT 运行时自取（只下运行时，不碰模型）─────────────
  const runOrtRuntime = () =>
    run('V9', 'ORT 运行时自取', async () => {
      log('只取 ORT 运行时，不下载任何模型 —— 成不成几十秒就能看出来。');
      const r = await benchOrtRuntime((note) => log(note));
      log(`ORT 运行时结论：${r.state}`);
      return {
        id: r.id,
        title: r.title,
        state: r.state,
        verdict: r.verdict,
        details: r.details,
      };
    });

  // ── V6 抽取式摘要 ───────────────────────────────────────
  const runExtractive = () =>
    run('V6', '抽取式摘要自检', async () => {
      const r = await probeExtractive();
      log(`抽取式摘要耗时 ${r.elapsedMs} ms`);
      return {
        id: 'V6',
        title: '抽取式摘要自检',
        state: r.ok ? 'pass' : 'fail',
        verdict: r.ok
          ? `纯 JS TextRank 跑通，${r.elapsedMs} ms；下面是它挑出来的句子和抽到的数字，请你判断准不准。`
          : '跑不通，抽取式兜底失效（这是最后一道防线，必须修）。',
        error: r.error,
        details: {
          '耗时（ms）': r.elapsedMs,
          关键词: r.keywords.join('、'),
          抽到的数字: r.facts.map((f) => `${f.raw} → ${f.zh}(${f.kind})`).join('；') || '（一条都没抽到）',
        },
        samples: ['【TextRank 挑出的要点】', ...r.keyPoints],
      };
    });

  // ── V3 内置翻译 ─────────────────────────────────────────
  const runTranslator = () =>
    run('V3', '浏览器内置翻译 API（en→zh）', async () => {
      const r = await probeTranslatorApi(
        (note) => log(note),
        (p) => log(`下载语言包 ${Math.round(p * 100)}%`),
      );
      const pairs = MT_SAMPLES.map((en, i) => `${i + 1}. EN  ${en}\n   ZH  ${r.outputs[i] ?? '（无输出）'}`);
      return {
        id: 'V3',
        title: '浏览器内置翻译 API（en→zh）',
        state: r.created ? 'pass' : r.ctorAvailable ? 'warn' : 'skip',
        verdict: r.created
          ? `可用。平均 ${fmtMs(r.meanMs)}/句（约 ${r.throughputPerSec} 句/秒）。下面中英对照请人眼判断质量。`
          : r.ctorAvailable
            ? `有 Translator 构造器但用不起来：${r.error ?? ''}`
            : '这个浏览器没有 Translator API（Chrome 138+ 桌面版才有，手机一定没有）。',
        error: r.error,
        details: {
          'availability() 四态': r.availability ?? '未取到',
          是否成功创建: r.created,
          '平均耗时/句': fmtMs(r.meanMs),
          '吞吐（句/秒）': r.throughputPerSec ?? '—',
          '单句耗时（ms）': r.perSentenceMs.join(', ') || '—',
        },
        samples: pairs,
      };
    });

  // ── V2 本地 Whisper ─────────────────────────────────────
  const runWhisper = () =>
    run('V2', `本地 Whisper（${whisperModel}）`, async () => {
      log(`开始下载并跑 ${whisperModel}（device=${whisperDevice}）…`);
      const dtype = whisperDevice === 'webgpu' ? 'fp32' : 'q8';
      const r = await benchWhisper({
        modelId: whisperModel,
        audioSec: whisperSec,
        device: whisperDevice,
        dtype,
        onNote: log,
        onProgress: (p) => {
          if (Math.round(p * 100) % 20 === 0) log(`模型下载 ${Math.round(p * 100)}%`);
        },
      });
      log(r.error ? `失败：${r.error}` : `RTF = ${r.rtf}`);
      const rtf = r.rtf;
      const state: ProbeState =
        r.error ? 'fail' : rtf !== null && rtf <= 0.6 ? 'pass' : rtf !== null && rtf <= 1.5 ? 'warn' : 'fail';
      return {
        id: 'V2',
        title: `本地 Whisper（${whisperModel} / ${whisperDevice} / ${dtype}）`,
        state,
        verdict: r.error
          ? '跑不起来。'
          : rtf === null
            ? '没有拿到耗时数据。'
            : rtf <= 0.6
              ? `RTF = ${rtf}（比实时快 ${(1 / rtf).toFixed(1)} 倍），这条档位在手机上可行。`
              : rtf <= 1.5
                ? `RTF = ${rtf}，比实时慢，只能做「说完再识别」而不是边听边出。`
                : `RTF = ${rtf}，太慢了，这台设备不能跑本地 Whisper。`,
        error: r.error,
        details: {
          模型: r.modelId,
          后端: `${r.device} / ${r.dtype}`,
          '音频时长（秒）': r.audioSec,
          '下载+加载（ms）': r.initMs,
          '其中下载（ms）': r.downloadMs,
          '下载体积': fmtBytes(r.downloadedBytes),
          '推理耗时（ms）': r.inferMs,
          RTF: r.rtf,
          'ORT 运行时来源': r.ortRuntime ?? '—',
          '模型来源（自动测速）': activeSource()?.note ?? '—',
          '模型地址（所有源，供核对）': sourceUrlsForTest(encoderRelFor(whisperModel)).join('  |  '),
          '识别输出（合成音频，仅证明链路通，不代表质量）': r.text?.slice(0, 200) ?? '—',
          '库发出的网络请求（最近 8 条）': r.fetchLog ?? '—',
        },
      };
    });

  // ── V4 本地翻译模型 ─────────────────────────────────────
  const runMt = () =>
    run('V4', `本地翻译模型（${mtModel}）`, async () => {
      log(`开始下载并跑 ${mtModel}…`);
      const r = await benchMt({
        modelId: mtModel,
        device: whisperDevice,
        dtype: whisperDevice === 'webgpu' ? 'fp32' : 'q8',
        onNote: log,
        onProgress: (p) => {
          if (Math.round(p * 100) % 20 === 0) log(`模型下载 ${Math.round(p * 100)}%`);
        },
      });
      log(r.error ? `失败：${r.error}` : `平均 ${r.meanMs} ms/句`);
      const pairs = MT_SAMPLES.map((en, i) => `${i + 1}. EN  ${en}\n   ZH  ${r.outputs[i] || '（空）'}`);
      return {
        id: 'V4',
        title: `本地翻译模型（${mtModel}）`,
        state: r.error ? 'fail' : (r.meanMs ?? 9999) <= 800 ? 'pass' : 'warn',
        verdict: r.error
          ? '跑不起来 —— 把下面的报错整段复制回来。先看「库发出的网络请求」里失败的是哪一条。'
          : `可用。平均 ${fmtMs(r.meanMs)}/句（约 ${r.throughputPerSec} 句/秒）。中英对照请人眼判断质量。`,
        error: r.error,
        details: {
          模型: r.modelId,
          '加载（ms）': r.initMs,
          '平均耗时/句': fmtMs(r.meanMs),
          '吞吐（句/秒）': r.throughputPerSec ?? '—',
          '单句耗时（ms）': r.perSentenceMs.join(', ') || '—',
          'ORT 运行时来源': r.ortRuntime ?? '—',
          '模型来源（自动测速）': activeSource()?.note ?? '—',
          '模型地址（所有源，供核对）': sourceUrlsForTest(encoderRelFor(mtModel)).join('  |  '),
          // 这一行是**对照组**：故意用最朴素的一次性 fetch 把整个文件拿下来，
          // 绕开 transformers 与 ORT。它报成功还是失败，都能说明「网络这一层」的状态：
          // 失败 = 这条源站确实撑不住长响应；成功 = 就是库或缓存的问题。
          '裸取诊断（对照组：绕开库直连，一次性整取）': r.rawProbe ?? '（没跑，说明加载成功）',
          '库发出的网络请求（最近 8 条）': r.fetchLog ?? '—',
          '产物样例（空字符串通常意味着需要用带语言前缀的模型）': r.outputs[0] ?? '—',
        },
        samples: pairs,
      };
    });

  const copyReport = async () => {
    const md = toMarkdownReport(all);
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      const el = reportRef.current;
      if (el) {
        el.value = md;
        el.select();
        document.execCommand?.('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }
    }
  };

  const downloadReport = () => {
    const md = toMarkdownReport(all);
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `simulnote-m0-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };

  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 pt-6">
      <header>
        <h1 className="text-xl font-bold text-slate-50">SimulNote · M0 可行性探针</h1>
        <p className="mt-2 text-sm leading-6 text-slate-300">
          这一页只做一件事：<strong className="text-slate-100">在你这台真实设备上量出数字</strong>
          ，回答 docs/06 §6.2 里 V1–V8 的问题。它不碰主应用的状态，也不会把任何数据发出去 ——
          报告是你自己复制、自己带走的。
        </p>
        <p className="mt-2 text-xs leading-5 text-amber-300">
          ⚠️ 「内存压力测试」会故意把内存用到接近极限，手机上有可能导致标签页被系统杀掉。
          这是故意的 —— 我们要的就是那个阈值。跑之前先保存好别的页面。
        </p>
      </header>

      <div className="mt-5 grid gap-3">
        <Section
          title="① 零下载项（安全，先跑这个）"
          hint="设备画像、WebGPU、存储配额、缓存写入、麦克风接口、抽取式摘要 —— 全都不下载模型，几秒出结果。"
        >
          <button className={BTN_PRIMARY} disabled={busy !== null} onClick={() => void runSafe()}>
            {busy === 'P0' ? '运行中…' : '开始'}
          </button>
          {results.P0 && <ResultCard r={results.P0} />}
        </Section>

        <Section
          title="② V9 · ORT 运行时自取（只下运行时，不碰模型）"
          hint="约 27 MB、几十秒。它失败的话 V2/V4 一定失败，不用再白下 160 MB 模型。"
        >
          <button className={BTN_DANGER} disabled={busy !== null} onClick={() => void runOrtRuntime()}>
            {busy === 'V9' ? '运行中…' : '先跑这个'}
          </button>
          {results.V9 && <ResultCard r={results.V9} />}
        </Section>

        <Section
          title="③ V8 · 内存探针（最关键的一个数字）"
          hint="分两段：先量这台设备最多能要到多少内存，再把 ASR 与 MT 两个模型同时驻留、量还剩多少余量。第二段才是「边听边译」能不能做的直接凭据。"
        >
          <button className={BTN_DANGER} disabled={busy !== null} onClick={() => void runMemory()}>
            {busy === 'V8' ? '运行中…' : '开始内存探针（两段）'}
          </button>
          <p className="mt-2 text-xs leading-relaxed text-amber-300/90">
            ⚠️ 第一段会故意把内存写到写不进去为止，手机上**有可能被系统直接杀掉标签页**。
            每一步都会先存进本机 localStorage，真被杀了、重新打开这一页，下边也能看到跑到了哪一步。
          </p>
          {v8Partial && (
            <div className="mt-3 rounded-lg border border-amber-400/50 bg-amber-400/10 p-3 text-xs leading-relaxed text-amber-200">
              <div className="font-medium">上一次内存探针的留痕（{new Date(v8Partial.at).toLocaleString('zh-CN')}）</div>
              <div className="mt-1">
                阶段：{v8Partial.stage} · 空设备上限：
                {v8Partial.ceilingMb === null ? '未记录' : `${v8Partial.ceilingMb} MB`} · 两个模型驻留后余量：
                {v8Partial.headroomMb === null ? '未记录' : `${v8Partial.headroomMb} MB`}
              </div>
              {v8Partial.stage !== 'done' && (
                <div className="mt-1">
                  这一轮**没有跑完**（多半是标签页被系统杀掉了）—— 上边的数字就是它死之前拿到的最后一步。
                </div>
              )}
              <button
                className={`${BTN_GHOST} mt-2`}
                disabled={busy !== null}
                onClick={() => {
                  clearMemoryPartial();
                  setV8Partial(null);
                }}
              >
                清掉这条留痕
              </button>
            </div>
          )}
          {results.V8 && <ResultCard r={results.V8} />}
        </Section>

        <Section title="④ V6 · 抽取式摘要自检" hint="纯 JS，零下载。它跑不通就说明兜底防线失效。">
          <button className={BTN_GHOST} disabled={busy !== null} onClick={() => void runExtractive()}>
            {busy === 'V6' ? '运行中…' : '开始'}
          </button>
          {results.V6 && <ResultCard r={results.V6} />}
        </Section>

        <Section
          title="④ V3 · 浏览器内置翻译（桌面 Chrome 138+ 才有）"
          hint="手机上这个构造器一定不存在，那属于预期结果，不算失败。"
        >
          <button className={BTN_GHOST} disabled={busy !== null} onClick={() => void runTranslator()}>
            {busy === 'V3' ? '运行中…' : '开始'}
          </button>
          {results.V3 && <ResultCard r={results.V3} />}
        </Section>

        <Section
          title="⑤ V2 / V4 · 本地模型实测（会从本站下载几十到一百多 MB）"
          hint="第一次跑要等下载。模型随站点发布，不访问任何外部服务。RTF = 推理耗时 ÷ 音频时长，小于 1 才叫「比实时快」。"
        >
          <div className="grid gap-2 text-xs text-slate-300">
            <label className="grid gap-1">
              <span>Whisper 模型</span>
              <select
                className="rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-slate-100"
                value={whisperModel}
                onChange={(e) => setWhisperModel(e.target.value)}
              >
                <option value="Xenova/whisper-tiny.en">Xenova/whisper-tiny.en（42 MB）</option>
              </select>
              <span className="text-xs text-slate-400">
                只列本站托管了的模型（scripts/fetch-models.mjs 的清单）。测别的 id 会直接报
                ModelFileNotFoundError。
              </span>
            </label>
            <label className="grid gap-1">
              <span>后端</span>
              <select
                className="rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-slate-100"
                value={whisperDevice}
                onChange={(e) => setWhisperDevice(e.target.value as 'webgpu' | 'wasm')}
              >
                <option value="wasm">WASM（q8，省内存，所有浏览器都有）</option>
                <option value="webgpu">WebGPU（fp32，快但吃显存）</option>
              </select>
            </label>
            <label className="grid gap-1">
              <span>合成音频时长：{whisperSec} 秒</span>
              <input
                type="range"
                min={5}
                max={30}
                step={5}
                value={whisperSec}
                onChange={(e) => setWhisperSec(Number(e.target.value))}
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={BTN_PRIMARY} disabled={busy !== null} onClick={() => void runWhisper()}>
              {busy === 'V2' ? '运行中…' : '跑 Whisper'}
            </button>
          </div>
          {results.V2 && <ResultCard r={results.V2} />}

          <div className="mt-5 grid gap-2 text-xs text-slate-300">
            <label className="grid gap-1">
              <span>翻译模型</span>
              <select
                className="rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-slate-100"
                value={mtModel}
                onChange={(e) => setMtModel(e.target.value)}
              >
                <option value="Xenova/opus-mt-en-zh">Xenova/opus-mt-en-zh（117 MB，en 专用）</option>
              </select>
              <span className="text-xs text-slate-400">
                同样只列本站托管了的模型。nllb / m2m100 没有并进站点 —— 那会让朋友首访多下半个 GB。
              </span>
            </label>
          </div>
          <div className="mt-3">
            <button className={BTN_PRIMARY} disabled={busy !== null} onClick={() => void runMt()}>
              {busy === 'V4' ? '运行中…' : '跑翻译模型'}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button className={BTN_GHOST} disabled={busy !== null} onClick={() => void runClearCache()}>
              {busy === 'clear' ? '清除中…' : '清空模型缓存'}
            </button>
            <span className="text-xs text-slate-400">
              {cacheMsg ??
                '复测前先点一下：库里自带的缓存命中时不校验长度，断线留下的半截文件会被永久命中。它只删已下载的模型，不会碰 ORT 运行时（省下 26.8 MB 重下）。'}
            </span>
          </div>
          {results.V4 && <ResultCard r={results.V4} />}
        </Section>

        <Section
          title="⑥ 把报告带走"
          hint={`已经完成 ${done.length} 项。复制或下载这份 Markdown，发回来就能直接写进 docs/results/。`}
        >
          <div className="flex flex-wrap gap-2">
            <button className={BTN_PRIMARY} disabled={done.length === 0} onClick={() => void copyReport()}>
              {copied ? '已复制 ✓' : '复制报告'}
            </button>
            <button className={BTN_GHOST} disabled={done.length === 0} onClick={downloadReport}>
              下载 .md
            </button>
          </div>
          <textarea
            ref={reportRef}
            readOnly
            className="scroll-area mt-3 h-40 w-full rounded-lg border border-slate-700 bg-slate-950/70 p-2 font-mono text-[11px] leading-5 text-slate-300"
            value={done.length ? toMarkdownReport(all) : '（还没有结果）'}
          />
        </Section>

        <Section title="运行日志" hint="出问题时把这部分一起复制回去，比截图有用。">
          <pre className="scroll-area max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/70 p-2 text-[11px] leading-5 text-slate-400">
            {logs.length ? logs.join('\n') : '（空）'}
          </pre>
        </Section>
      </div>

      <p className="mt-6 text-center text-xs leading-5 text-slate-500">
        这一页是开发用的诊断工具，不是给最终用户看的。主应用在{' '}
        <a className="text-teal-400 underline" href="./">
          首页
        </a>
        。
      </p>
    </div>
  );
}

/**
 * ONNX Runtime Web 的 wasm 从哪儿来。
 *
 * ⚠️ 这是本项目最凶险的一个坑，踩了两次，两次都是「打开就是砖」。
 *
 * ## 第一次：产物太大
 * transformers.js v4 会让 Vite 顺带产出一个
 * `ort-wasm-simd-threaded.asyncify.wasm`，**26,861,777 字节**，
 * 超过 Cloudflare Pages 的 **25 MiB（26,214,400 字节）**单文件上限。
 * 解法是允许用 `VITE_ORT_WASM_BASE` 把 wasm 挪到本仓库的 GitHub Release 资产。
 *
 * ## 第二次（真机实测才暴露）：ORT 的运行时被偷偷送去第三方 CDN
 * transformers.js 打包好的代码里有这么一段（见 `dist/assets/transformers-*.js`）：
 *
 * ```js
 * if (... && Ye.versions?.web && !Ye.wasm.wasmPaths) {
 *   const t = `https://<第三方静态资源 CDN>/onnxruntime-web@${Ye.versions.web}/dist/`;
 *   Ye.wasm.wasmPaths = { mjs: `${t}ort-wasm-simd-threaded.asyncify.mjs`,
 *                         wasm: `${t}ort-wasm-simd-threaded.asyncify.wasm` };
 * }
 * ```
 *
 * （真实主机名是 jsDelivr，写在 `scripts/check-zero-cost.mjs` 的 NAMED_BAD_HOSTS 里。
 * 这里刻意不写字面量 —— 那个脚本扫源码时会把 `https://` 开头的任何主机当成真实引用，
 * 而这段只是注释。）
 *
 * 也就是说：**只要我们没自己设 `wasmPaths`，ORT 的 JS 胶水和 26.8 MB 的 wasm
 * 都会去那个 CDN 取。** 国内的手机网络到它经常不通，报的就是
 * `TypeError: Load failed` —— 而且报在 `pipeline()` 里，看起来像「模型加载失败」，
 * 极易误判成模型文件或跨域问题。
 *
 * 我们对外承诺的是「音频不出设备、运行时零外部依赖」，所以这**必须**堵死：
 * 现在 `configureOrtWasm` 会**无条件**把 `wasmPaths` 指到本站自己的
 * `/<base>/ort/`，不再有「没设变量就回落到 CDN」这条路径。
 *
 * 产物侧由 `vite.config.ts` 的 `ortRuntime()` 插件从
 * `node_modules/onnxruntime-web/dist/` 拷两份到 `dist/ort/`：
 *   - `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` —— 默认用这份
 *   - `ort-wasm-simd-threaded.{mjs,wasm}`         —— Safari < 26 且无 WebGPU 时用
 * 这与 transformers.js 自己的选择规则一致（见上面那段 `r = ".asyncify"`）。
 *
 * ## 第三次：堵死了 CDN，却把自己变成了唯一的瓶颈
 * 上面那次修复把 wasm 钉死在**自建 GitHub Pages** 上。当时是对的（别的地方都连不上），
 * 但 2026/10/5 实测自建只有 **27,589 B/s** —— 26.8 MB 的 asyncify wasm 要 **16 分钟**，
 * 而且它**不在**模型双源测速的覆盖范围里（那套逻辑只认 `/models/`）。
 * 于是「模型已经用上镜像了，界面还是卡着不动」。
 *
 * 现在的取法：**npmmirror（阿里 npm 镜像）优先，自建兜底**。
 * 同一个文件在 `registry.npmmirror.com` 实测 **3.44 MB/s**，快 125 倍，
 * CORS 返回 `Access-Control-Allow-Origin`，`Content-Type: application/wasm` 正确。
 * 版本号构建期由 `vite.config.ts` 注入（`__ORT_VERSION__`），地址与
 * `node_modules` 里那份**同版本同字节**（26,861,777），不是另一份构建。
 *
 * 这里刻意**不用 blob: / 不自己下载**：`wasmPaths.wasm` 一旦不是以 `.wasm` 结尾，
 * ORT 内部的路径推断就会失效。我们只做「换基址」，命名规则原样保留。
 */

declare const __ORT_VERSION__: string;

import { pushFetchRecord, siteBase } from './modelSource';

/** 站点里存放 ORT 运行时的目录名（相对站点根），与 vite.config.ts 的 ortRuntime() 一致。 */
const ORT_DIR = 'ort';

const ASYNCIFY_STEM = 'ort-wasm-simd-threaded.asyncify';
const PLAIN_STEM = 'ort-wasm-simd-threaded';

/**
 * ORT 运行时的加速源（阿里 npm 镜像）。版本号构建期注入，与自托管那份同版本同字节。
 * 末尾的斜杠必须有 —— 下面靠字符串拼接补文件名。
 */
const ORT_NPM_BASE = `https://registry.npmmirror.com/onnxruntime-web/${__ORT_VERSION__}/files/dist/`;

/** 探测加速源用的小文件（.mjs 只有几十 KB）的超时。 */
const PROBE_TIMEOUT_MS = 6000;

/**
 * transformers.js 的权重精度取值。收窄成联合类型，
 * 免得 `dtype` 变成裸 string 而在 pipeline() 处报类型错。
 */
export type OrtDtype =
  | 'auto'
  | 'fp32'
  | 'fp16'
  | 'q8'
  | 'int8'
  | 'uint8'
  | 'q4'
  | 'bnb4'
  | 'q4f16'
  | 'q2'
  | 'q2f16'
  | 'q1'
  | 'q1f16';

interface OrtWasmBackend {
  wasmPaths?: string | Record<string, string>;
}

interface TransformersLikeEnv {
  backends?: {
    onnx?: {
      wasm?: OrtWasmBackend;
    };
  };
}

/** 读取构建期注入的外置 wasm 基址；没有就返回空串。 */
export function ortWasmBase(): string {
  const raw = import.meta.env.VITE_ORT_WASM_BASE;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * 是不是「Safari 且主版本 < 26」。
 *
 * 用途只有一个：ORT 在这类浏览器上没有 WebGPU 时**不能**用 asyncify 变体，
 * 必须退回不带 asyncify 的那份。判定规则抄的是 transformers.js 自己的
 * `IS_SAFARI_BELOW_26`，并且排除掉一堆套壳（Chrome / Edge / 微信 / Firefox）。
 */
function isSafariBelow26(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/Chrome|CriOS|Chromium|Edg\/|OPR\/|Firefox|FxiOS|MicroMessenger|HuaweiBrowser/i.test(ua)) {
    return false;
  }
  const match = /Version\/(\d+)[\d.]* .*Safari\//.exec(ua);
  if (!match) return false;
  return Number(match[1]) < 26;
}

/** 两套运行时的确切字节数（与 `node_modules/onnxruntime-web/dist/` 里那份逐字节一致）。 */
const RUNTIME_BYTES: Record<string, { mjs: number; wasm: number }> = {
  [ASYNCIFY_STEM]: { mjs: 53057, wasm: 26861777 },
  [PLAIN_STEM]: { mjs: 24381, wasm: 14264838 },
};

/** 运行时在 Cache Storage 里的桶名。与模型缓存分开，清模型缓存时不会误删它。 */
const ORT_CACHE = 'simulnote-ort-v1';

/** 分块下载参数，与 `lib/modelSource.ts` 里 `.onnx` 那套同源同思路。 */
const CHUNK_BYTES = 2 * 1024 * 1024;
const MIN_CHUNK_BYTES = 512 * 1024;
const MAX_ATTEMPTS = 6;
const WASM_TIMEOUT_MS = 30000;

/**
 * 单块的超时。
 *
 * **不能是固定值** —— 实测自建源只有 27~39 KB/s，2 MB 一块要 60 秒以上，
 * 固定 30 秒会把「慢但能用的源」判死（离线复刻时自建那条就死在 21 MB 处）。
 * 折成「底 30 秒 + 按 25 KB/s 折算」，于是块缩小之后超时也跟着缩短：
 * 2 MB → 82 秒，512 KB → 43 秒。
 */
function timeoutForChunk(bytes: number): number {
  return WASM_TIMEOUT_MS + Math.round(bytes / 40);
}

/**
 * 首选哪一套运行时。
 *
 * 规则照抄 transformers.js 自己的选择（`IS_SAFARI_BELOW_26 && !IS_WEBGPU_AVAILABLE`）：
 * 默认 asyncify，只有「Safari 且主版本 < 26 且没有 WebGPU」才退回不带后缀的那份。
 */
function primaryStem(): string {
  return isSafariBelow26() ? PLAIN_STEM : ASYNCIFY_STEM;
}

/** 某个基址 + 某一套变体下的两个文件地址。 */
function filesUnder(base: string, stem: string): { mjs: string; wasm: string } {
  return { mjs: `${base}${stem}.mjs`, wasm: `${base}${stem}.wasm` };
}

/** 本站 ORT 运行时的两个文件地址（绝对路径，带 base 前缀）。 */
export function ortRuntimeFiles(): { mjs: string; wasm: string } {
  return filesUnder(`${siteBase()}${ORT_DIR}/`, primaryStem());
}

/** 本次会话实际用上的运行时，给探针页展示。 */
export interface OrtRuntimeChoice {
  /** 变体名，例如 `asyncify`。 */
  stem: string;
  /** 来自哪个源。 */
  source: string;
  mjs: string;
  bytes: number;
  ms: number;
  cached: boolean;
  note: string;
}

let runtimeChoice: OrtRuntimeChoice | null = null;

export function activeOrtRuntime(): OrtRuntimeChoice | null {
  return runtimeChoice;
}

async function openOrtCache(): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null;
    return await caches.open(ORT_CACHE);
  } catch {
    return null;
  }
}

/** 从缓存里取一份**长度正确**的运行时字节。长度不对就当没有（半截文件比没有更坏）。 */
async function readOrtCache(key: string, want: number): Promise<ArrayBuffer | null> {
  const cache = await openOrtCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(key);
    if (!hit) return null;
    const buf = await hit.arrayBuffer();
    if (buf.byteLength !== want) {
      await cache.delete(key);
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

async function writeOrtCache(key: string, buf: ArrayBuffer): Promise<void> {
  const cache = await openOrtCache();
  if (!cache) return;
  try {
    await cache.put(key, new Response(buf, { headers: { 'content-type': 'application/wasm' } }));
  } catch {
    // 配额满等情况：缓存写不进去不影响正确性
  }
}

/** 取一段，返回这一段以及从 `Content-Range` 解出的总长度。 */
async function fetchRangeOnce(
  url: string,
  start: number,
  end: number,
): Promise<{ buf: ArrayBuffer; total: number | null; whole: boolean }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutForChunk(end - start + 1));
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
      cache: 'no-store',
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? NaN);
    return { buf, total: Number.isFinite(total) ? total : null, whole: res.status === 200 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 分块把整个 wasm 拉下来。
 *
 * 为什么不交给 ORT 自己 fetch：**单次长响应在手机上必断**（R17 就是这么来的）。
 * 26.8 MB 一次拉完在国内链路上是很高的失败率，分块之后断的只是那一块，
 * 重试代价从「整份重来」变成「重来 2 MB」。顺带还能核对总长度。
 */
async function downloadWasm(url: string, want: number): Promise<ArrayBuffer> {
  const parts: ArrayBuffer[] = [];
  let start = 0;
  let total: number | null = null;
  let chunk = CHUNK_BYTES;
  let attempts = 0;
  while (total === null || start < total) {
    const end = start + chunk - 1;
    try {
      const got = await fetchRangeOnce(url, start, end);
      if (got.buf.byteLength === 0) throw new Error('收到 0 字节');
      parts.push(got.buf);
      if (got.total !== null) total = got.total;
      if (got.whole) {
        total = got.buf.byteLength;
      }
      start += got.buf.byteLength;
      attempts = 0;
      // 连着几块都顺，就把块涨回去 —— 不能只降不升（R18 的教训）。
      if (chunk < CHUNK_BYTES && parts.length % 4 === 0) chunk = Math.min(CHUNK_BYTES, chunk * 2);
    } catch (err) {
      attempts += 1;
      if (attempts >= MAX_ATTEMPTS) {
        throw new Error(`第 ${Math.floor(start / 1048576)}MB 处连续失败：${err instanceof Error ? err.message : String(err)}`);
      }
      chunk = Math.max(MIN_CHUNK_BYTES, Math.floor(chunk / 2));
    }
  }
  const out = new Uint8Array(start);
  let at = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p), at);
    at += p.byteLength;
  }
  if (want > 0 && out.byteLength !== want) {
    throw new Error(`长度不对：收到 ${out.byteLength}，应当是 ${want}`);
  }
  return out.buffer;
}

/**
 * 加速源此刻可用吗？取一次 `.mjs`（几十 KB）并**核对长度**。
 *
 * 只核长度不核哈希：版本被钉死，长度不符已能挡住「镜像上没有这个版本」这一类事故。
 * wasm 那 26.8 MB 也核对长度，而且是**我们自己下载后再交给 ORT**（见 downloadWasm）。
 */
async function mjsUsable(url: string, stem: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
    if (!res.ok) return false;
    const buf = await res.arrayBuffer();
    return buf.byteLength === RUNTIME_BYTES[stem].mjs;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 按优先级试出一个能用的运行时：先首选的变体，再另一个变体；
 * 每个变体内部先试 npmmirror，再试自建。
 *
 * 返回 `.mjs` 的地址与 wasm 的**字节**；wasm 交给调用方包成 blob。
 */
async function pickRuntime(): Promise<{
  stem: string;
  source: string;
  mjs: string;
  bytes: ArrayBuffer;
  ms: number;
  cached: boolean;
}> {
  const primary = primaryStem();
  const stems = primary === ASYNCIFY_STEM ? [ASYNCIFY_STEM, PLAIN_STEM] : [PLAIN_STEM, ASYNCIFY_STEM];
  const sources = [
    { label: 'npmmirror', base: ORT_NPM_BASE },
    { label: '自建', base: `${siteBase()}${ORT_DIR}/` },
  ];
  let lastError = '没有可用的源';
  for (const stem of stems) {
    for (const src of sources) {
      const files = filesUnder(src.base, stem);
      if (!(await mjsUsable(files.mjs, stem))) continue;
      const startedAt = Date.now();
      // 缓存键用**自建规范地址**：换源不重下。
      const key = filesUnder(`${siteBase()}${ORT_DIR}/`, stem).wasm;
      const cached = await readOrtCache(key, RUNTIME_BYTES[stem].wasm);
      if (cached) {
        pushFetchRecord({
          url: `${src.label}/${stem}.wasm`,
          status: 200,
          ok: true,
          bytes: cached.byteLength,
          ms: 0,
          error: null,
          note: '来自 Cache Storage，没有联网',
        });
        return { stem, source: `${src.label}（缓存）`, mjs: files.mjs, bytes: cached, ms: 0, cached: true };
      }
      try {
        const buf = await downloadWasm(files.wasm, RUNTIME_BYTES[stem].wasm);
        const ms = Date.now() - startedAt;
        await writeOrtCache(key, buf);
        pushFetchRecord({
          url: `${src.label}/${stem}.wasm`,
          status: 206,
          ok: true,
          bytes: buf.byteLength,
          ms,
          error: null,
          note: `${(buf.byteLength / 1048576 / (ms / 1000)).toFixed(2)} MB/s，分块下载`,
        });
        return { stem, source: src.label, mjs: files.mjs, bytes: buf, ms, cached: false };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        pushFetchRecord({
          url: `${src.label}/${stem}.wasm`,
          status: null,
          ok: false,
          bytes: null,
          ms: Date.now() - startedAt,
          error: lastError,
          note: files.wasm,
        });
      }
    }
  }
  throw new Error(`ORT 运行时取不到：${lastError}`);
}

/**
 * 把 ORT 运行时的位置写进 transformers.js 的 env。
 * 必须在任何 `pipeline()` 调用**之前**执行（异步，必须 await）。
 *
 * 顺序：外置基址（`VITE_ORT_WASM_BASE`）→ 自建缓存 → npmmirror/自建分块下载。
 *
 * **wasm 是我们自己下好、核对完长度，再以 blob: 交给 ORT 的。**
 * 这样做的理由有两个：
 *   1. 单次 26.8 MB 的长响应在手机上必断，而 ORT 自己 fetch 不会分块也不会重试；
 *   2. 断在哪儿、下了多少、总长多少，全都能写进报告 —— 上一版这块是完全的黑盒。
 * `.mjs` 仍然是直接地址（只有几十 KB，且它内部用 `import.meta.url` 推 worker 路径，
 * 换成 blob 会破坏多线程那条路）。
 */
export async function configureOrtWasm(
  env: unknown,
): Promise<string | Record<string, string> | null> {
  const target = env as TransformersLikeEnv;
  if (!target.backends?.onnx?.wasm) {
    // 老版本 transformers.js 没有 backends，这时改不了，只能听天由命。
    return null;
  }

  // 外置基址（Cloudflare 那条路）优先；直接给字符串，ORT 会自己拼文件名。
  const external = ortWasmBase();
  if (external) {
    const value = external.endsWith('/') ? external : `${external}/`;
    target.backends.onnx.wasm.wasmPaths = value;
    return value;
  }

  const picked = await pickRuntime();
  const blob = new Blob([picked.bytes], { type: 'application/wasm' });
  const wasmUrl = URL.createObjectURL(blob);
  const paths = { mjs: picked.mjs, wasm: wasmUrl };
  target.backends.onnx.wasm.wasmPaths = paths;
  runtimeChoice = {
    stem: picked.stem,
    source: picked.source,
    mjs: picked.mjs,
    bytes: picked.bytes.byteLength,
    ms: picked.ms,
    cached: picked.cached,
    note: picked.cached
      ? `${picked.source} · ${(picked.bytes.byteLength / 1048576).toFixed(1)}MB · 来自本机缓存`
      : `${picked.source} · ${(picked.bytes.byteLength / 1048576).toFixed(1)}MB · ${(
          picked.bytes.byteLength / 1048576 / Math.max(0.001, picked.ms / 1000)
        ).toFixed(2)} MB/s`,
  };
  return paths;
}

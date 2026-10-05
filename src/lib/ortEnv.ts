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

import { siteBase } from './modelSource';

/** 站点里存放 ORT 运行时的目录名（相对站点根），与 vite.config.ts 的 ortRuntime() 一致。 */
const ORT_DIR = 'ort';

const ASYNCIFY_STEM = 'ort-wasm-simd-threaded.asyncify';
const PLAIN_STEM = 'ort-wasm-simd-threaded';

/**
 * ORT 运行时的加速源（阿里 npm 镜像）。版本号构建期注入，与自托管那份同版本同字节。
 * 末尾的斜杠必须有 —— 下面靠字符串拼接补文件名。
 */
const ORT_NPM_BASE = `https://registry.npmmirror.com/onnxruntime-web/${__ORT_VERSION__}/files/dist/`;

/** 探测加速源用的小文件（.mjs 只有几十 KB），以及它应有的长度。长度不符就当源不可用。 */
const PROBE_FILE_BYTES: Record<string, number> = {
  [`${ASYNCIFY_STEM}.mjs`]: 53057,
  [`${PLAIN_STEM}.mjs`]: 24381,
};
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

/** 某个基址下的 ORT 运行时两个文件（与 transformers.js 的命名规则一致）。 */
function filesUnder(base: string): { mjs: string; wasm: string } {
  const stem = isSafariBelow26() ? PLAIN_STEM : ASYNCIFY_STEM;
  return { mjs: `${base}${stem}.mjs`, wasm: `${base}${stem}.wasm` };
}

/** 本站 ORT 运行时的两个文件地址（绝对路径，带 base 前缀）。 */
export function ortRuntimeFiles(): { mjs: string; wasm: string } {
  return filesUnder(`${siteBase()}${ORT_DIR}/`);
}

/**
 * 加速源此刻可用吗？取一次 `.mjs`（几十 KB）并**核对长度**。
 *
 * 只核长度不核哈希：这是一个版本被钉死的静态文件，长度不符已经能挡住
 * 「镜像上没有这个版本 / 被换成了别的东西」这两类事故，
 * 而真要做哈希校验就得自己下载 26.8 MB 再交给 ORT，反而失去意义。
 */
async function mirrorUsable(mjsUrl: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(mjsUrl, { cache: 'no-store', signal: ctl.signal });
    if (!res.ok) return false;
    const buf = await res.arrayBuffer();
    const want = PROBE_FILE_BYTES[mjsUrl.split('/').pop() ?? ''];
    return want === undefined ? buf.byteLength > 0 : buf.byteLength === want;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把 ORT 运行时的位置写进 transformers.js 的 env。
 * 必须在任何 `pipeline()` 调用**之前**执行（现在是异步的，要 await）。
 *
 * 顺序：外置基址（`VITE_ORT_WASM_BASE`）→ npmmirror → 自建。
 * 探测失败只意味着「这次用自建」，不影响正确性 —— 自建的产物一直都在。
 *
 * 返回实际生效的 `wasmPaths`，供探针把「到底从哪儿取」写进报告 ——
 * 上一次就是因为报告里没有这个信息，才把一个 CDN 问题误判成模型问题。
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

  // 加速源：显式给两个文件名。**不能只给基址字符串** ——
  // 字符串形式下由 ORT 自己决定文件名，它未必挑 asyncify 那一份。
  const fast = filesUnder(ORT_NPM_BASE);
  if (await mirrorUsable(fast.mjs)) {
    target.backends.onnx.wasm.wasmPaths = fast;
    return fast;
  }

  // 兜底：本站自托管。
  const files = ortRuntimeFiles();
  target.backends.onnx.wasm.wasmPaths = files;
  return files;
}

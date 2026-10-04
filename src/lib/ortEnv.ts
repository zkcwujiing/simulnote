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
 */

import { siteBase } from './modelSource';

/** 站点里存放 ORT 运行时的目录名（相对站点根），与 vite.config.ts 的 ortRuntime() 一致。 */
const ORT_DIR = 'ort';

const ASYNCIFY_STEM = 'ort-wasm-simd-threaded.asyncify';
const PLAIN_STEM = 'ort-wasm-simd-threaded';

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

/** 本站 ORT 运行时的两个文件地址（绝对路径，带 base 前缀）。 */
export function ortRuntimeFiles(): { mjs: string; wasm: string } {
  const stem = isSafariBelow26() ? PLAIN_STEM : ASYNCIFY_STEM;
  const dir = `${siteBase()}${ORT_DIR}/`;
  return { mjs: `${dir}${stem}.mjs`, wasm: `${dir}${stem}.wasm` };
}

/**
 * 把 ORT 运行时的位置写进 transformers.js 的 env。
 * 必须在任何 `pipeline()` 调用**之前**执行。
 *
 * 返回实际生效的 `wasmPaths`，供探针把「到底从哪儿取」写进报告 ——
 * 上一次就是因为报告里没有这个信息，才把一个 CDN 问题误判成模型问题。
 */
export function configureOrtWasm(env: unknown): string | Record<string, string> | null {
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

  // 默认：本站自托管。**这一步是无条件的**，就是为了不给 jsDelivr 留任何机会。
  const files = ortRuntimeFiles();
  target.backends.onnx.wasm.wasmPaths = files;
  return files;
}

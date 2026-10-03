/**
 * ONNX Runtime Web 的 wasm 加载位置。
 *
 * 背景（这是本项目踩过的真实坑，docs/07 R13）：
 * transformers.js v4 会在打包时让 Vite 顺带产出一个
 * `ort-wasm-simd-threaded.asyncify.wasm`，**26,861,777 字节**。
 * 而 Cloudflare Pages 对单个文件的上限是 **25 MiB = 26,214,400 字节**，
 * 超了就直接部署失败（GitHub Pages 没有这个限制）。
 *
 * 解法：把 wasm 从站点里拿出来，放到一个体积不受限的地方（例如本仓库的
 * GitHub Release 资产），构建时用 `VITE_ORT_WASM_BASE` 指定基址：
 *
 *     VITE_ORT_WASM_BASE=https://github.com/<你>/<仓库>/releases/download/wasm-v1/
 *
 * 配套的 Vite 插件 `ortWasmPolicy` 会在这个变量存在时，把超大的 .wasm
 * 从产物中删掉，避免 Cloudflare 上传失败。两件事必须同时做，缺一个就会
 * 出现「文件在站里但云厂商拒绝」或「文件不在站里也没人提供」。
 *
 * 不设这个变量时（默认，例如本地开发、GitHub Pages 部署）行为完全不变：
 * ORT 直接用打包进站点的 wasm。
 */

interface OrtWasmBackend {
  wasmPaths?: string | Record<string, string>;
}

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

interface TransformersLikeEnv {
  backends?: {
    onnx?: {
      wasm?: OrtWasmBackend;
    };
  };
}

/** 读取构建期注入的 wasm 基址；没有就返回空串。 */
export function ortWasmBase(): string {
  const raw = import.meta.env.VITE_ORT_WASM_BASE;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * 把 wasm 基址写进 transformers.js 的 env。
 * 必须在任何 `pipeline()` 调用**之前**执行。
 */
export function configureOrtWasm(env: unknown): void {
  const base = ortWasmBase();
  if (!base) return;

  const target = env as TransformersLikeEnv;
  if (!target.backends?.onnx?.wasm) {
    // 老版本 transformers.js 没有 backends，这时只能放弃外置，
    // 让 ORT 用它自己的默认逻辑（会去找同目录下的 wasm）。
    return;
  }
  // 结尾必须有斜杠，ORT 会拿它做字符串拼接
  target.backends.onnx.wasm.wasmPaths = base.endsWith('/') ? base : `${base}/`;
}

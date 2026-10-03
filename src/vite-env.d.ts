/// <reference types="vite/client" />

/**
 * 本项目只用到两个构建期变量，显式声明出来，
 * 免得 `import.meta.env.XXX` 变成 any 而丢掉类型检查。
 */
interface ImportMetaEnv {
  /** 部署子路径。GitHub Pages 项目站需要 '/<仓库名>/'，Cloudflare Pages 用 '/'。 */
  readonly VITE_BASE?: string;
  /**
   * ONNX Runtime wasm 的外部基址，必须以 '/' 结尾。
   * 设置后构建产物里不会包含超大的 .wasm（Cloudflare Pages 有 25MiB 单文件上限）。
   * 例：https://github.com/<你>/<仓库>/releases/download/wasm-v1/
   */
  readonly VITE_ORT_WASM_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

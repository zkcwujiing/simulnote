import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// GitHub Pages 的项目站点部署在 /<仓库名>/ 子路径下，Cloudflare Pages 部署在根路径。
// 因此 base 由环境变量注入：构建 GH Pages 版时设 VITE_BASE='/<仓库名>/'。
const base = process.env.VITE_BASE || '/';

/**
 * ONNX Runtime 的 wasm 外置策略（只管「太大」这一件事）。
 *
 * transformers.js v4 会让 Vite 顺带产出一个
 * `ort-wasm-simd-threaded.asyncify.wasm`，**26,861,777 字节**。
 * 现在这个文件**永远不会被用到** —— `lib/ortEnv.ts` 会无条件把 ORT 的
 * `wasmPaths` 指到 `/<base>/ort/`（真机实测：不指过去，ORT 就会去
 * cdn.jsdelivr.net 取，手机上直接 `TypeError: Load failed`）。
 * 所以这里把它从产物里删掉，免得白白多传 26.8 MB。
 *
 * 设置了 `VITE_ORT_WASM_BASE`（指向本仓库 GitHub Release 资产）时，
 * 下面的 `ortRuntime()` 不会再往站点里拷 ORT 运行时，由外部提供。
 */
const ORT_WASM_DROP_THRESHOLD = 12 * 1024 * 1024;

function ortWasmPolicy(): Plugin {
  const externalBase = (process.env.VITE_ORT_WASM_BASE || '').trim();
  return {
    name: 'simulnote:ort-wasm-policy',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'asset' || !fileName.endsWith('.wasm')) continue;
        const bytes =
          typeof output.source === 'string'
            ? Buffer.byteLength(output.source)
            : output.source.byteLength;
        if (bytes <= ORT_WASM_DROP_THRESHOLD) continue;
        delete bundle[fileName];
        this.warn(
          `已从产物中剔除 ${fileName}（${(bytes / 1024 / 1024).toFixed(1)} MB）：` +
            (externalBase
              ? `改由 VITE_ORT_WASM_BASE=${externalBase} 提供。`
              : `改由站点自带的 /ort/ 目录提供（见 vite.config.ts 的 ortRuntime()）。`),
        );
      }
    },
  };
}

/**
 * 把 ONNX Runtime 的运行时（JS 胶水 + wasm）拷进产物，**放在站点自己的域下**。
 *
 * 为什么必须有这一步：transformers.js 在 `wasmPaths` 为空时会把它指到
 * `https://cdn.jsdelivr.net/npm/onnxruntime-web@<版本>/dist/`。国内手机上那个
 * CDN 连不上，报 `TypeError: Load failed`，而且看起来像是「模型加载失败」。
 * 详见 `src/lib/ortEnv.ts` 的注释。
 *
 * 拷两份：
 *   - asyncify 变体（26.8 MB）—— 默认，Android / iOS 26+ 都走这个
 *   - 普通变体（14.3 MB）—— Safari < 26 且没有 WebGPU 时 ORT 会要这个
 * 体积换的是「任何一台设备都不会因为 CDN 连不上而变成砖」。
 */
const ORT_RUNTIME_FILES = [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];

function ortRuntime(): Plugin {
  const externalBase = (process.env.VITE_ORT_WASM_BASE || '').trim();
  return {
    name: 'simulnote:ort-runtime',
    apply: 'build',
    writeBundle(options) {
      if (externalBase) return; // 由外部提供，站点里不放
      const from = fileURLToPath(
        new URL('./node_modules/onnxruntime-web/dist/', import.meta.url),
      );
      const to = join(options.dir ?? fileURLToPath(new URL('./dist', import.meta.url)), 'ort');
      mkdirSync(to, { recursive: true });
      for (const name of ORT_RUNTIME_FILES) {
        const src = join(from, name);
        if (!existsSync(src)) {
          this.warn(`ORT 运行时缺少 ${name}，跳过（真机上可能加载失败）。`);
          continue;
        }
        copyFileSync(src, join(to, name));
      }
    },
  };
}

/**
 * 把分享预览图改成**绝对地址**。
 *
 * 微信、QQ、Telegram 抓取 `og:image` 时基本不做相对路径解析，写
 * `content="og-image.png"` 的结果通常是没有预览图。所以部署时用
 * `VITE_SITE_URL` 告诉构建「站点的公开根地址是什么」，这里把 meta 补全。
 *
 * 没设这个变量时**行为完全不变**（保持相对路径），本地开发不受影响。
 */
function socialMeta(): Plugin {
  const raw = (process.env.VITE_SITE_URL || '').trim();
  const siteUrl = raw ? raw.replace(/\/+$/, '') + '/' : '';
  return {
    name: 'simulnote:social-meta',
    transformIndexHtml(html) {
      if (!siteUrl) return html;
      return html.replaceAll('content="og-image.png"', `content="${siteUrl}og-image.png"`);
    },
  };
}

/**
 * onnxruntime-web 的版本号，注入成 `__ORT_VERSION__`。
 *
 * `lib/ortEnv.ts` 靠它拼 npmmirror 的地址：
 *   https://registry.npmmirror.com/onnxruntime-web/<版本>/files/dist/ort-wasm-*.wasm
 * 必须是**构建时真正装的那一份**，否则镜像上可能根本没有这个版本，
 * 运行时会退化成自建 —— 慢，但仍然正确（`configureOrtWasm` 会核对文件长度）。
 */
function ortVersion(): string {
  const pkg = join(fileURLToPath(new URL('.', import.meta.url)), 'node_modules/onnxruntime-web/package.json');
  return JSON.parse(readFileSync(pkg, 'utf8')).version as string;
}

export default defineConfig({
  base,
  define: {
    __ORT_VERSION__: JSON.stringify(ortVersion()),
  },
  plugins: [react(), tailwindcss(), ortWasmPolicy(), ortRuntime(), socialMeta()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // transformers.js / onnxruntime-web 自带 worker 与 wasm 的加载逻辑，交给它们自己处理，
  // 不要被 Vite 的依赖预打包改写。
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    // 模型不在 bundle 里，但 transformers.js 的 JS 本体较大，放宽警告阈值。
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      // 两个入口：主应用（index.html）与 M0 可行性探针（probe.html）。
      // 探针页要和主站一起部署 —— 真机测试时用户只要在链接后面加 /probe.html，
      // 不需要再跑一次本地服务器。它不碰主应用状态，只是多一个页面。
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        probe: fileURLToPath(new URL('./probe.html', import.meta.url)),
      },
      output: {
        manualChunks: {
          // 让 transformers.js 单独成一个 chunk，首屏不必下载它
          transformers: ['@huggingface/transformers'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    port: 4173,
    host: true,
  },
});

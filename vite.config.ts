import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// GitHub Pages 的项目站点部署在 /<仓库名>/ 子路径下，Cloudflare Pages 部署在根路径。
// 因此 base 由环境变量注入：构建 GH Pages 版时设 VITE_BASE='/<仓库名>/'。
const base = process.env.VITE_BASE || '/';

/**
 * ONNX Runtime 的 wasm 外置策略。
 *
 * transformers.js v4 会让 Vite 顺带产出一个
 * `ort-wasm-simd-threaded.asyncify.wasm`，**26,861,777 字节**，
 * 超过 Cloudflare Pages 的 **25 MiB（26,214,400 字节）单文件上限**，
 * 不处理的话 Cloudflare 那边的部署会直接失败。
 *
 * 约定：只要设置了 `VITE_ORT_WASM_BASE`（例如指向本仓库 GitHub Release 的资产目录），
 * 就认为 wasm 由外部提供 —— 把它们从产物里删掉，运行时由 lib/ortEnv.ts 交给 ORT。
 * 没设这个变量时**行为完全不变**，wasm 正常打进站点（本地开发、GitHub Pages 都用这条）。
 *
 * 两个开关必须成对使用，不能只做一半：
 *   - 只删文件不设基址 → 本地模型直接加载失败；
 *   - 只设基址不删文件 → Cloudflare 上传被拒。
 */
const ORT_WASM_DROP_THRESHOLD = 12 * 1024 * 1024;

function ortWasmPolicy(): Plugin {
  const externalBase = (process.env.VITE_ORT_WASM_BASE || '').trim();
  return {
    name: 'simulnote:ort-wasm-policy',
    apply: 'build',
    generateBundle(_options, bundle) {
      if (!externalBase) return;
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
            `改由 VITE_ORT_WASM_BASE=${externalBase} 在运行时提供。`,
        );
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

export default defineConfig({
  base,
  plugins: [react(), tailwindcss(), ortWasmPolicy(), socialMeta()],
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

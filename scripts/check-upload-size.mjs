#!/usr/bin/env node
/**
 * 上传体积闸门（`node scripts/check-upload-size.mjs`）。
 *
 * 存在的理由：Cloudflare Pages 对单个文件的上限是 **25 MiB**，超限时它只会丢回
 * 一句没什么信息量的报错。产物里有两类文件会踩这条线：
 *   1. `ort-wasm-simd-threaded.asyncify.wasm`（**26.8MB**，transformers.js 带出来的）；
 *   2. 自托管模型（`models/` 下的 `.onnx`，30–60MB 一个）—— 见 scripts/fetch-models.mjs。
 * 与其让部署在云厂商那边莫名其妙地挂掉，不如在本地就把话说清楚：
 * 是哪个文件、超了多少、怎么办。
 *
 * ⚠️ **走 GitHub Pages 时这一条根本不存在** —— 它没有单文件上限。
 * 所以本脚本的结论只在 Cloudflare 那条路上要紧；`pnpm verify` 用 `--warn-only`
 * 调用它，就是为了不让「另一个源站的问题」打断主路线。
 *
 * 用 `--limit-mb=<n>` 可以改阈值；`--warn-only` 只警告不失败。
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith('--limit-mb='));
const warnOnly = args.includes('--warn-only');

const LIMIT_MB = limitArg ? Number.parseFloat(limitArg.split('=')[1]) : 25;
if (!Number.isFinite(LIMIT_MB) || LIMIT_MB <= 0) {
  console.error(`--limit-mb 需要一个正数，收到：${limitArg}`);
  process.exit(2);
}
const LIMIT_BYTES = Math.floor(LIMIT_MB * 1024 * 1024);

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const files = await walk(DIST);
if (files.length === 0) {
  console.error('dist/ 是空的，先跑一次构建（pnpm build）。');
  process.exit(2);
}

let total = 0;
const oversized = [];
for (const file of files) {
  const info = await stat(file);
  total += info.size;
  if (info.size > LIMIT_BYTES) oversized.push({ file: path.relative(DIST, file), size: info.size });
}

const mb = (n) => (n / 1024 / 1024).toFixed(2);
console.log(
  `上传体积检查 —— ${files.length} 个文件，合计 ${mb(total)} MB，单文件上限 ${LIMIT_MB} MiB`,
);

if (oversized.length === 0) {
  console.log('  ✓ 没有任何文件超限');
  process.exit(0);
}

// 超限的两种来源，处理方式完全不同，所以分开说：
//   - wasm：ONNX Runtime 带出来的，和路线无关，走哪条路都得先解决
//   - models/：**自托管模型本来就是几十 MB**，它只在 Cloudflare Pages 上是问题
const wasm = oversized.filter((i) => i.file.endsWith('.wasm'));
const models = oversized.filter((i) => !i.file.endsWith('.wasm'));

console.log(`  ⚠ ${oversized.length} 个文件超过单文件上限（wasm ${wasm.length} 个，模型 ${models.length} 个）`);

if (wasm.length > 0) {
  console.log('\n■ ONNX Runtime 的 wasm（只有 1 个，且可以外置）：');
  for (const item of wasm) {
    console.log(`  - ${item.file}  ${mb(item.size)} MB（超出 ${mb(item.size - LIMIT_BYTES)} MB）`);
  }
}

if (models.length > 0) {
  console.log('\n■ 自托管模型（模型随站点发布，本来就是几十 MB —— 只在 Cloudflare 上是问题）：');
  for (const item of models) {
    console.log(`  - ${item.file}  ${mb(item.size)} MB（超出 ${mb(item.size - LIMIT_BYTES)} MB）`);
  }
}

console.log(
  [
    '',
    '怎么理解这个结果：',
    '  · 走 **GitHub Pages**（推荐的那条）：它**没有单文件上限**，上面这些全都不影响，',
    '    功能完全一样。这一整段可以直接忽略。',
    '  · 走 Cloudflare Pages：这些文件会被直接拒收，必须先处理掉。两条出路：',
    '      1. 放弃 Cloudflare，只用 GitHub Pages 的链接。',
    '      2. wasm 可以外置成 Release 资产（见下）；但模型文件目前没有外置方案，',
    '         要么接受 Cloudflare 不可用，要么把模型清单改小（比如只留 whisper）。',
    '           把 .wasm 上传为本仓库的一个 GitHub Release 资产，然后设置仓库变量',
    '           VITE_ORT_WASM_BASE=https://github.com/<你>/<仓库>/releases/download/<tag>/',
    '           重新构建即可（vite.config.ts 会把它从产物里剔除，运行时由 lib/ortEnv.ts 提供）。',
    '',
  ].join('\n'),
);

process.exit(warnOnly ? 0 : 1);

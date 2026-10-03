#!/usr/bin/env node
/**
 * 上传体积闸门（`node scripts/check-upload-size.mjs`）。
 *
 * 存在的理由：Cloudflare Pages 对单个文件的上限是 **25 MiB**，超限时它只会丢回
 * 一句没什么信息量的报错，而产物里恰好躺着一个 26.8MB 的
 * `ort-wasm-simd-threaded.asyncify.wasm`（transformers.js 带出来的）。
 * 与其让部署在云厂商那边莫名其妙地挂掉，不如在本地就把话说清楚：
 * 是哪个文件、超了多少、怎么办。
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

console.error('\n以下文件超过单文件上限，Cloudflare Pages 会拒绝这次部署：');
for (const item of oversized) {
  console.error(`  - ${item.file}  ${mb(item.size)} MB（超出 ${mb(item.size - LIMIT_BYTES)} MB）`);
}
console.error(
  [
    '',
    '处理办法（二选一）：',
    '  1. 只用 GitHub Pages 的链接 —— 它没有单文件上限，功能完全一样。',
    '  2. 把上面的 .wasm 上传为本仓库的一个 GitHub Release 资产，然后设置',
    '     仓库变量 VITE_ORT_WASM_BASE=https://github.com/<你>/<仓库>/releases/download/<tag>/',
    '     重新构建即可（vite.config.ts 会把它从产物里剔除，运行时由 lib/ortEnv.ts 提供）。',
    '',
  ].join('\n'),
);

process.exit(warnOnly ? 0 : 1);

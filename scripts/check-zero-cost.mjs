#!/usr/bin/env node
/**
 * 零成本护栏（`pnpm lint:cost`）。
 *
 * 这个项目对朋友的三个承诺是：不注册、不付费、不把音频交出去。
 * 三个承诺都能被一行代码悄悄破坏 —— 只要有人（包括未来的我自己）随手加一个
 * 云翻译 API、一个统计脚本、或者一段硬编码的 key。所以这里做一道机械检查，
 * 让「零成本」不是口号而是可验证的约束。
 *
 * 规则只有两条：
 *   1. 源码里出现的每一个外部主机名，必须在 ALLOWED_HOSTS 里。
 *   2. 源码里不允许出现任何形似密钥的字符串。
 *
 * **模型现在随站点一起发布**（构建期由 scripts/fetch-models.mjs 拉进 public/models/，
 * 见该脚本头部说明）。也就是说：运行时不访问任何外部服务 ——
 * 连 huggingface.co 都不在允许清单里了。这份清单越短，承诺越硬。
 * 清单里剩下的 github.com 只服务于一个可选项：把 26.8MB 的 ORT wasm 外置到
 * 本仓库自己的 Release（Cloudflare Pages 有 25MiB 单文件上限，GitHub Pages 没有）。
 * 默认部署根本不走这条路。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src', 'public'];
// 每个 HTML 入口都要扫：主应用 index.html 与 M0 探针 probe.html。
// 新增页面时别忘了加进来，否则护栏会留一个盲区。
const SCAN_FILES = ['index.html', 'probe.html'];
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2', '.onnx', '.wasm', '.mp3']);

/** 允许出现的外部主机：只剩「本项目自己的 GitHub Release 资产」这一类。 */
const ALLOWED_HOSTS = [
  // 仅用于「本仓库自己的 GitHub Release 资产」（ORT 的 wasm 体积超过
  // Cloudflare Pages 的 25MiB 单文件上限，只能外置）。免费、无需账号、无配额费用。
  // 注意：这是**我们自己的**仓库，不是第三方 API；github.com 上的 Release 下载会
  // 302 跳到 objects.githubusercontent.com，所以两个都要放行。
  // 默认部署（GitHub Pages）根本用不到这些：wasm 直接打包进站点。
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];

/** 显式点名的高风险主机 —— 命中就直接报错，不必等 allowlist 判断。 */
const NAMED_BAD_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'translation.googleapis.com',
  'api.deepl.com',
  'api-free.deepl.com',
  'api.cognitive.microsofttranslator.com',
  'api.mymemory.translated.net',
  'fanyi.baidu.com',
  'openapi.youdao.com',
  'mt.tencentcloudapi.com',
  'speech.tencentcloudapi.com',
  'nls-gateway.aliyuncs.com',
  'api.speechmatics.com',
  'api.assemblyai.com',
  'api.rev.ai',
  'api.elevenlabs.io',
];

/** 形似密钥的字符串。宁可误报也不要漏报。 */
const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, 'OpenAI 风格密钥'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/, 'Anthropic 风格密钥'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS Access Key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API Key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub Token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack Token'],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}\b/, '硬编码 Bearer Token'],
];

const HOST_RE = /https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi;

async function collectFiles() {
  const out = [...SCAN_FILES.map((f) => path.join(ROOT, f))];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // public/models/ 是构建期拉下来的模型权重（见 scripts/fetch-models.mjs）。
      // 它们不进 git，也不含任何 URL；扫进来只会让「扫描 N 个文件」这个数字失真。
      const relFromRoot = path.relative(ROOT, full).replace(/\\/g, '/');
      if (relFromRoot === 'public/models' || relFromRoot.startsWith('public/models/')) continue;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        await walk(full);
      } else if (!SKIP_EXT.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  for (const dir of SCAN_DIRS) await walk(path.join(ROOT, dir));

  const existing = [];
  for (const file of out) {
    try {
      const info = await stat(file);
      if (info.isFile() && info.size < 2 * 1024 * 1024) existing.push(file);
    } catch {
      /* 不存在的引用（例如尚未创建的资源）跳过 */
    }
  }
  return existing;
}

function hostAllowed(host) {
  return ALLOWED_HOSTS.some((allowed) =>
    allowed.startsWith('.') ? host.endsWith(allowed) : host === allowed,
  );
}

const files = await collectFiles();
const problems = [];
const hosts = new Map();

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const text = await readFile(file, 'utf8');

  for (const [re, why] of SECRET_PATTERNS) {
    const hit = text.match(re);
    if (hit) problems.push(`${rel}: 疑似${why} —— ${hit[0].slice(0, 12)}…`);
  }

  for (const match of text.matchAll(HOST_RE)) {
    const host = match[1].toLowerCase();
    if (host.startsWith('www.')) continue;
    hosts.set(host, rel);
    if (NAMED_BAD_HOSTS.includes(host)) {
      problems.push(`${rel}: 引用了付费/第三方服务 ${host}`);
    } else if (!hostAllowed(host)) {
      problems.push(`${rel}: 未在允许清单内的外部主机 ${host}`);
    }
  }
}

console.log(`零成本检查 —— 扫描 ${files.length} 个文件`);
if (hosts.size === 0) {
  console.log('  未发现任何外部主机引用');
} else {
  for (const [host, where] of hosts) {
    console.log(`  ${hostAllowed(host) ? '✓' : '×'} ${host}  (${where})`);
  }
}

if (problems.length > 0) {
  console.error('\n发现破坏「零成本 / 零第三方」承诺的问题：');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\n如果确实需要新增外部主机，请先更新本脚本的 ALLOWED_HOSTS，并说明它为什么是免费的。',
  );
  process.exit(1);
}

console.log('\n通过：所有外部引用都在免费允许清单内，且未发现硬编码密钥。');

#!/usr/bin/env node
/**
 * 把本站要托管的模型下载到 `public/models/`（`pnpm fetch-models`）。
 *
 * ## 为什么必须自托管
 *
 * 2026 实测（本机，普通家宽，无代理）：
 *   - `huggingface.co`   0/3 成功 —— DNS 被污染成 59.188.250.54 这类无效地址
 *   - `cdn-lfs.huggingface.co`  TCP 443 不通 —— 而模型权重正是从这里下
 *   - `hf-mirror.com`    10/10 成功
 *   - `pages.github.com` 10/10 成功
 *
 * 也就是说：在「浏览器里直接 download huggingface.co」这条路上，站点能部署成功、
 * 但**打开就是砖** —— 用户会卡在「正在下载模型」，最后退化成「只转写、不翻译」。
 * 把模型并进站点，运行时就不再需要任何外部服务，朋友那边什么网络都能用。
 *
 * ## 关键约定
 *
 * 1. `public/models/` **不进 git**（见 .gitignore）。仓库仍然只有几百 KB，
 *    push 又快又不会因为跨境丢包反复重试失败；模型由本脚本在构建前拉下来。
 * 2. 目录布局必须和 transformers.js 的 `buildResourcePaths()` 对得上：
 *    `env.localModelPath` + `<组织>/<模型名>/<文件名>`。
 * 3. 只下**用得到的那几个变体**：q8（`_quantized`）。整个仓库动辄 1.8GB / 3.9GB，
 *    但下面清单里的加起来只有约 160MB。
 * 4. 候选表在 `src/engines/asr/transformersWhisperAsr.ts` 与
 *    `src/engines/mt/transformersMt.ts`。**改候选表就必须同步改下面的 MODELS**，
 *    否则那道「模型下架还能换 id 续命」的保险会变成逐个 404。
 *
 * ## 为什么用 tree API 而不是 HEAD 拿文件大小
 *
 * 最初这里用 `HEAD` 的 `Content-Length` 来决定「要不要跳过」和「下全了没有」。
 * 实测被坑过：hf-mirror 对 `Xenova/whisper-tiny.en/tokenizer_config.json` 的 HEAD
 * 返回了一个 200、`content-length: 20` 的响应（真实文件 835 字节），于是好好的
 * 文件被当成「长度不符」删掉了。`/api/models/<id>/tree/main?recursive=true` 返回的
 * `size` 字段才是可靠的，所以现在大小一律以它为准。
 *
 * 用法：
 *   pnpm fetch-models              # 缺什么补什么，大小对得上就跳过
 *   pnpm fetch-models --force      # 全部重下
 *   pnpm fetch-models --only=whisper
 *   HF_HOST=https://huggingface.co pnpm fetch-models   # 换主源
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(ROOT, 'public', 'models');
const REVISION = 'main';

/** 依次尝试。留 huggingface.co 兜底是因为 GitHub Actions 的构建机在海外，直连它更快。 */
const HOSTS = [
  ...(process.env.HF_HOST ? [process.env.HF_HOST.replace(/\/+$/, '')] : []),
  'https://hf-mirror.com',
  'https://huggingface.co',
];

/**
 * 唯一的模型清单。**这里列出来的就是站点会发出去的模型**。
 * `onnx/` 下只要 `_quantized`（q8）两个文件：
 *   - encoder_model_quantized.onnx          —— 编码器
 *   - decoder_model_merged_quantized.onnx   —— 合并了 with_past 的解码器
 * 依据：node_modules/@huggingface/transformers/dist/transformers.web.js
 *   - DEFAULT_DTYPE_SUFFIX_MAPPING: q8 → "_quantized"
 *   - MODEL_SESSION_CONFIG[Seq2Seq]: { model: "encoder_model", decoder_model_merged: "decoder_model_merged" }
 * 不要下 `decoder_model.onnx` + `decoder_with_past_model.onnx`，那对是 merged 的展开版，
 * 体积翻倍而且 transformers.js v4 不会去读。
 */
const MODELS = [
  {
    key: 'whisper',
    id: 'Xenova/whisper-tiny.en',
    why: '语音识别（英文，q8 量化）',
    files: [
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'quantize_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'special_tokens_map.json',
      'added_tokens.json',
      'vocab.json',
      'merges.txt',
      'normalizer.json',
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx',
    ],
  },
  {
    key: 'mt',
    id: 'Xenova/opus-mt-en-zh',
    why: '英译中（q8 量化）',
    files: [
      'config.json',
      'generation_config.json',
      'quantize_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'special_tokens_map.json',
      'vocab.json',
      'source.spm',
      'target.spm',
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx',
    ],
  },
];

const args = process.argv.slice(2);
const force = args.includes('--force');
const check = args.includes('--check');
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()) : null;

if (force && check) {
  console.error('--force 和 --check 不能一起用：--check 只做本地体检，不下载。');
  process.exit(2);
}

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

async function sizeOf(file) {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : -1;
  } catch {
    return -1;
  }
}

/** 从 tree API 拿「文件名 → 字节数」。拿不到就返回 null，退化成不做长度校验。 */
async function fetchTree(host, id) {
  try {
    const res = await fetch(`${host}/api/models/${id}/tree/${REVISION}?recursive=true`, {
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!Array.isArray(json)) return null;
    const sizes = new Map();
    for (const entry of json) {
      if (entry?.type === 'file' && entry.path) sizes.set(entry.path, Number(entry.size));
    }
    return sizes.size > 0 ? sizes : null;
  } catch {
    return null;
  }
}

/**
 * 下载单个文件，先写 `.part` 再改名：中途断了不会留下半个
 * 「看起来已经下好」的文件去骗下一次的跳过判断。
 */
async function downloadOne(url, dest, expectedBytes) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) throw new Error('响应没有 body');

  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }

  const got = await sizeOf(tmp);
  if (got <= 0) {
    await rm(tmp, { force: true });
    throw new Error('下载到的文件是空的');
  }
  if (expectedBytes > 0 && got !== expectedBytes) {
    await rm(tmp, { force: true });
    throw new Error(`长度不符：期望 ${expectedBytes}，实际 ${got}`);
  }
  await rename(tmp, dest);
  return got;
}

const wanted = MODELS.filter((m) => !only || only.includes(m.key));
if (wanted.length === 0) {
  console.error(
    `--only=${only?.join(',')} 没有匹配到任何模型。可选：${MODELS.map((m) => m.key).join(', ')}`,
  );
  process.exit(1);
}

/**
 * `--check`：只做本地体检，**完全不联网**。
 *
 * 放在 `pnpm build` 的最前面，用来堵住一个很容易发生的事故：
 * `public/models/` 不进 git，新克隆的仓库里它是空的，这时候直接构建会打出一个
 * 「能打开、但一按开始就 404」的站点 —— 而且本地看不出问题，要等朋友点开才发现。
 * 这里只查「文件在不在、非不非空」；**长度校验留给真正下载的那条路径**，
 * 否则离线开发时每次构建都要等两个 tree API 超时。
 */
if (check) {
  const missing = [];
  let present = 0;
  let bytes = 0;
  for (const model of wanted) {
    for (const file of model.files) {
      const dest = path.join(OUT_ROOT, model.id, ...file.split('/'));
      const size = await sizeOf(dest);
      if (size > 0) {
        present += 1;
        bytes += size;
      } else {
        missing.push(`${model.id}/${file}`);
      }
    }
  }
  const expectedCount = wanted.reduce((n, m) => n + m.files.length, 0);
  if (missing.length === 0) {
    console.log(
      `模型自托管 —— 本地体检通过：${present}/${expectedCount} 个文件，合计 ${human(bytes)}。`,
    );
    process.exit(0);
  }
  console.error(
    `模型自托管 —— 本地体检不通过：${present}/${expectedCount} 个文件，缺 ${missing.length} 个。`,
  );
  for (const f of missing.slice(0, 10)) console.error(`  - ${f}`);
  if (missing.length > 10) console.error(`  …还有 ${missing.length - 10} 个`);
  console.error(
    '\n模型不进 git（仓库才几百 KB），必须先在**能联网的机器**上跑一次：\n' +
      '  pnpm fetch-models\n' +
      '跑完再构建。这一步不能省 —— 少了它打出来的站点会「能打开、但一按开始就 404」。',
  );
  process.exit(1);
}

console.log(`模型自托管 —— 输出到 ${path.relative(ROOT, OUT_ROOT).replace(/\\/g, '/')}/`);
console.log(`源（按顺序尝试）：${HOSTS.join('  →  ')}`);
if (force) console.log('--force：忽略本地已有的文件，全部重下');

let totalBytes = 0;
let downloaded = 0;
let skipped = 0;
const failures = [];

for (const model of wanted) {
  console.log(`\n■ ${model.id}  —— ${model.why}`);
  const modelDir = path.join(OUT_ROOT, model.id);

  let sizes = null;
  for (const host of HOSTS) {
    sizes = await fetchTree(host, model.id);
    if (sizes) {
      console.log(`  （文件大小以 ${host} 的 tree API 为准，共 ${sizes.size} 个条目）`);
      break;
    }
  }
  if (!sizes) {
    console.log('  ！所有源的 tree API 都不可用，本次不做长度校验，只保证文件非空');
  }

  for (const file of model.files) {
    const dest = path.join(modelDir, ...file.split('/'));
    const label = `${model.id}/${file}`;
    const expected = sizes?.get(file) ?? -1;
    const existing = await sizeOf(dest);

    if (!force && existing > 0 && expected > 0 && existing === expected) {
      totalBytes += existing;
      skipped += 1;
      console.log(`  · ${file}  ${human(existing)}（已存在，跳过）`);
      continue;
    }

    let lastError = null;
    let ok = false;
    for (const host of HOSTS) {
      const url = `${host}/${model.id}/resolve/${REVISION}/${file}`;
      try {
        const got = await downloadOne(url, dest, expected);
        totalBytes += got;
        downloaded += 1;
        ok = true;
        console.log(`  ✓ ${file}  ${human(got)}`);
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!ok) {
      const message = lastError?.message ?? '未知错误';
      failures.push(`${label}：${message}`);
      console.error(`  ✗ ${file} —— ${message}`);
    }
  }
}

console.log(`\n合计 ${human(totalBytes)}（新下载 ${downloaded} 个，跳过 ${skipped} 个文件）`);

if (failures.length > 0) {
  console.error('\n以下文件没能拿到：');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\n可以重跑本命令（已下好的会跳过）。若镜像整体挂了，试试：\n' +
      '  $env:HF_HOST="https://huggingface.co"; pnpm fetch-models\n' +
      '或在能直连 HF 的机器上跑完后把 public/models/ 整个拷过来。',
  );
  process.exit(1);
}

console.log('通过：模型已就位，站点运行时不需要再访问任何外部服务。');

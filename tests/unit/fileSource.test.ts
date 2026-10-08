/**
 * 音频文件音源的单元测试。
 *
 * 只测**纯函数**部分（分块、时长格式化、上限判定）。真正的解码与重采样需要
 * `AudioContext` / `OfflineAudioContext`，Node 里没有 —— 把它们抽成纯函数
 * 就是为了这个：核心逻辑有测试兜底，浏览器交互留给真机验证。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHUNK_FRAMES,
  FILE_SAMPLE_RATE,
  MAX_FILE_DURATION_SEC,
  RENDER_SEGMENT_SEC,
  chunkFrames,
  exceedsMaxDuration,
  formatDurationZh,
} from '@/lib/audio/fileSource';

/** 造一段确定的、不会因为浮点巧合而相等的音频（不要用全 0，那连切错都看不出来）。 */
function makeSamples(length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.sin(i * 0.37) * 0.5;
  return out;
}

/** 逐元素比较两个 Float32Array。刻意不用 deepEqual 比类型化数组。 */
function assertSameSamples(actual: Float32Array, expected: Float32Array, label: string): void {
  assert.equal(actual.length, expected.length, `${label}：长度不一致`);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(actual[i], expected[i], `${label}：第 ${i} 个采样不一致`);
  }
}

function concat(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// ───────────────────────────── 分块 ─────────────────────────────

test('分块：长度刚好整除时每块都满且不多出一块', () => {
  const chunks = chunkFrames(makeSamples(12), 4);
  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [4, 4, 4],
  );
});

test('分块：不整除时最后一块是余数', () => {
  const chunks = chunkFrames(makeSamples(10), 4);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [4, 4, 2],
  );
});

test('分块：比一块还短时只产出一块，且不补齐', () => {
  const chunks = chunkFrames(makeSamples(3), 4);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, 3);
});

test('分块：空输入产出空数组，而不是一块空音频', () => {
  // 下游拿到长度 0 的帧会算出 frameDb = -100 之类的怪值，不如根本不给。
  assert.deepEqual(chunkFrames(new Float32Array(0), 4), []);
});

test('分块：每块都不超过 chunkFrames，且拼起来与输入逐元素相等', () => {
  const input = makeSamples(CHUNK_FRAMES * 2 + 5);
  const chunks = chunkFrames(input, CHUNK_FRAMES);

  assert.equal(chunks.length, 3);
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0 && chunk.length <= CHUNK_FRAMES, `块长越界：${chunk.length}`);
  }
  assertSameSamples(concat(chunks), input, '拼接结果');
});

test('分块：非法 chunkFrames 直接抛错（否则 chunkFrames=0 会死循环）', () => {
  const input = makeSamples(4);
  assert.throws(() => chunkFrames(input, 0), RangeError);
  assert.throws(() => chunkFrames(input, -1), RangeError);
  assert.throws(() => chunkFrames(input, Number.NaN), RangeError);
});

// ───────────────────────────── 时长格式化 ─────────────────────────────

test('时长格式化：不满一分钟只说秒', () => {
  assert.equal(formatDurationZh(0), '0 秒');
  assert.equal(formatDurationZh(1), '1 秒');
  assert.equal(formatDurationZh(59), '59 秒');
  assert.equal(formatDurationZh(59.9), '59 秒');
});

test('时长格式化：满一分钟起说「几分几秒」，秒补零', () => {
  assert.equal(formatDurationZh(60), '1 分 00 秒');
  assert.equal(formatDurationZh(61), '1 分 01 秒');
  assert.equal(formatDurationZh(125), '2 分 05 秒');
  assert.equal(formatDurationZh(3600), '60 分 00 秒');
});

test('时长格式化：负数与非法输入兜底成 0 秒，不显示 NaN', () => {
  assert.equal(formatDurationZh(-1), '0 秒');
  assert.equal(formatDurationZh(Number.NaN), '0 秒');
  assert.equal(formatDurationZh(Number.POSITIVE_INFINITY), '0 秒');
});

// ───────────────────────────── 时长上限 ─────────────────────────────

test('时长上限：恰好等于上限算通过，超过 1 秒才拒绝', () => {
  assert.equal(exceedsMaxDuration(MAX_FILE_DURATION_SEC), false);
  assert.equal(exceedsMaxDuration(MAX_FILE_DURATION_SEC + 1), true);
});

test('时长上限：普通长度放行，未知长度一律拒绝', () => {
  assert.equal(exceedsMaxDuration(0), false);
  assert.equal(exceedsMaxDuration(600), false);
  // 拿不准的时候必须拒绝：放行一段长度未知的音频可能直接吃掉几百 MB 内存。
  assert.equal(exceedsMaxDuration(Number.NaN), true);
  assert.equal(exceedsMaxDuration(Number.POSITIVE_INFINITY), true);
});

test('时长上限：可以传更小的上限（给「试听 5 分钟」这类入口用）', () => {
  assert.equal(exceedsMaxDuration(300, 300), false);
  assert.equal(exceedsMaxDuration(301, 300), true);
});

// ───────────────────────────── 常量契约 ─────────────────────────────

test('常量：帧长必须与麦克风路径一致（16kHz / 100ms）', () => {
  // 这两个数一旦改了，下游 VAD 的时间戳会静默错位，所以在这里钉死。
  assert.equal(FILE_SAMPLE_RATE, 16000);
  assert.equal(CHUNK_FRAMES, 1600);
  assert.equal(CHUNK_FRAMES / FILE_SAMPLE_RATE, 0.1);
  assert.equal(MAX_FILE_DURATION_SEC, 7200);
  assert.equal(RENDER_SEGMENT_SEC, 300);
  assert.ok(RENDER_SEGMENT_SEC * FILE_SAMPLE_RATE > CHUNK_FRAMES);
});

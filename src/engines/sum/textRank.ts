/**
 * TextRank + MMR：抽取式摘要的排序内核。
 *
 * 选它的理由（对应设计文档 04 的三段式摘要）：
 *  - 纯计算、零依赖、零下载，在手机上对一场 1 小时会议的耗时是毫秒级；
 *  - **永不失败**，因此可以作为整条链路的最后一道兜底：翻译挂了、模型没下完、
 *    内存不够 —— 纪要照样出得来，只是以英文原句为主。
 *
 * 与经典 TextRank 的差异：
 *  - 相似度用词的**余弦**（去停用词后），而不是共现窗口，因为输入是句子而非词；
 *  - 排序后接一步 MMR 去冗余，否则选出来的三句话经常在说同一件事；
 *  - 位置先验很轻（前 20% 的句子 ×1.1），避免「开场白」霸榜。
 */

import { STOPWORDS } from '@/lib/glossary';

/** 缩写里的小圆点不应触发断句。 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'inc', 'ltd',
  'co', 'corp', 'gov', 'no', 'fig', 'eg', 'ie', 'al', 'approx', 'dept', 'est',
]);

/**
 * 英文断句。刻意保守：宁可把两句合成一句，也不要把一句切成两句
 * （切开会让 TextRank 选到半句话，读起来像坏掉了）。
 */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const out: string[] = [];
  let buffer = '';

  const chars = Array.from(normalized);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    buffer += ch;

    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '。' && ch !== '！' && ch !== '？') {
      continue;
    }
    if (ch === '.') {
      // 检查前一个词是不是缩写
      const before = buffer.slice(0, -1);
      const lastWord = (before.match(/([A-Za-z]+)$/)?.[1] ?? '').toLowerCase();
      if (ABBREVIATIONS.has(lastWord)) continue;
      // "U.S." / "3.5" 这类：点号两侧都是字母或都是数字
      const prev = chars[i - 1];
      const next = chars[i + 1];
      if (prev && next && /[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next)) {
        // 单字母缩写如 "U.S." —— 看更前面的字符
        const twoBack = chars[i - 2];
        if (twoBack === '.' || /[A-Z]/.test(prev)) continue;
      }
      if (prev && next && /\d/.test(prev) && /\d/.test(next)) continue;
    }

    const next = chars[i + 1];
    if (next && !/\s/.test(next)) continue;

    const sentence = buffer.trim();
    buffer = '';
    // 丢掉过短碎片（"Yes." / "Okay."）
    if (sentence.replace(/[^A-Za-z\u4e00-\u9fa5]/g, '').length >= 8) {
      out.push(sentence);
    }
  }

  const tail = buffer.trim();
  if (tail && tail.replace(/[^A-Za-z\u4e00-\u9fa5]/g, '').length >= 8) {
    out.push(tail);
  }

  return out;
}

export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z][a-z'-]*|\d+(?:\.\d+)?%?/g);
  if (!matches) return [];
  const out: string[] = [];
  for (const token of matches) {
    const bare = token.replace(/^'+|'+$/g, '');
    if (bare.length < 2 && !/^\d/.test(bare)) continue;
    if (STOPWORDS.has(bare)) continue;
    out.push(bare);
  }
  return out;
}

export function termVector(tokens: string[]): Map<string, number> {
  const vector = new Map<string, number>();
  for (const token of tokens) {
    vector.set(token, (vector.get(token) ?? 0) + 1);
  }
  // 次线性缩放，抑制高频词
  for (const [term, count] of vector) {
    vector.set(term, 1 + Math.log(count));
  }
  return vector;
}

function norm(vector: Map<string, number>): number {
  let sum = 0;
  for (const value of vector.values()) sum += value * value;
  return Math.sqrt(sum) || 1;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, value] of small) {
    const other = large.get(term);
    if (other) dot += value * other;
  }
  return dot / (norm(a) * norm(b));
}

export interface RankedSentence {
  index: number;
  text: string;
  score: number;
}

export interface TextRankOptions {
  /** 阻尼系数 */
  damping?: number;
  /** 迭代次数；句子多时收敛慢，给多一点 */
  iterations?: number;
  /** 句子超过这个数就分块跑，避免 O(n²) 内存爆掉 */
  chunkThreshold?: number;
}

/**
 * 对句子集合做 TextRank。
 * 返回按**原文顺序**的完整排名（score 已归一化到 0..1）。
 */
export function textRank(sentences: string[], options: TextRankOptions = {}): RankedSentence[] {
  const damping = options.damping ?? 0.85;
  const iterations = options.iterations ?? 30;
  const n = sentences.length;
  if (n === 0) return [];
  if (n === 1) return [{ index: 0, text: sentences[0], score: 1 }];

  const vectors = sentences.map((s) => termVector(tokenize(s)));

  // 相似度矩阵用对称存储，O(n²) 浮点数。n=600 时约 1.4MB，可接受。
  const sim: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const row = new Float32Array(n);
    sim.push(row);
  }
  const rowSum = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // 相邻句子的相似度略微折扣，避免同一个话题的连续句子互相强化
      const distancePenalty = Math.abs(i - j) <= 1 ? 0.85 : 1;
      const value = cosine(vectors[i], vectors[j]) * distancePenalty;
      sim[i][j] = value;
      sim[j][i] = value;
      rowSum[i] += value;
      rowSum[j] += value;
    }
  }

  let scores = new Float32Array(n).fill(1 / n);
  let next = new Float32Array(n);

  for (let iter = 0; iter < iterations; iter++) {
    let delta = 0;
    for (let i = 0; i < n; i++) {
      let incoming = 0;
      for (let j = 0; j < n; j++) {
        if (j === i || rowSum[j] === 0) continue;
        incoming += (sim[j][i] / rowSum[j]) * scores[j];
      }
      next[i] = (1 - damping) / n + damping * incoming;
    }
    for (let i = 0; i < n; i++) {
      delta += Math.abs(next[i] - scores[i]);
    }
    const swap = scores;
    scores = next;
    next = swap;
    if (delta < 1e-6) break;
  }

  // 位置先验：开场 20% 的句子权重 ×1.1
  const positionBonus = Math.max(1, Math.round(n * 0.2));
  let max = 0;
  for (let i = 0; i < n; i++) {
    if (i < positionBonus) scores[i] *= 1.1;
    if (scores[i] > max) max = scores[i];
  }
  if (max === 0) max = 1;

  const ranked: RankedSentence[] = [];
  for (let i = 0; i < n; i++) {
    ranked.push({ index: i, text: sentences[i], score: scores[i] / max });
  }
  return ranked;
}

/**
 * MMR 去冗余选句，返回**原文顺序**的结果。
 * @param k 想选多少句
 * @param lambda 越大越偏重重要性，越小越偏重多样性
 */
export function mmrSelect(
  ranked: RankedSentence[],
  k: number,
  lambda = 0.72,
): RankedSentence[] {
  if (ranked.length <= k) return [...ranked].sort((a, b) => a.index - b.index);

  const vectors = ranked.map((r) => termVector(tokenize(r.text)));

  const selected: number[] = [];
  const candidates = new Set(ranked.map((_, i) => i));

  while (selected.length < k && candidates.size > 0) {
    let best = -1;
    let bestScore = -Infinity;

    for (const i of candidates) {
      let maxSim = 0;
      for (const j of selected) {
        const value = cosine(vectors[i], vectors[j]);
        if (value > maxSim) maxSim = value;
      }
      const score = lambda * ranked[i].score - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }

    if (best < 0) break;
    selected.push(best);
    candidates.delete(best);
  }

  return selected
    .map((i) => ranked[i])
    .sort((a, b) => a.index - b.index);
}

/**
 * 超长输入的分块处理：先把句子按字数切成若干块分别跑 TextRank，
 * 每块取前若干句，再对候选集合跑一次全局 TextRank。
 * 这样能把 O(n²) 的峰值内存压在可接受范围内。
 */
export function hierarchicalTextRank(
  sentences: string[],
  targetK: number,
  options: TextRankOptions = {},
): RankedSentence[] {
  const threshold = options.chunkThreshold ?? 600;
  if (sentences.length <= threshold) {
    return mmrSelect(textRank(sentences, options), targetK);
  }

  const chunkSize = threshold;
  const perChunk = Math.max(3, Math.ceil(targetK * 1.6 * (chunkSize / sentences.length)) + 2);
  const candidates: string[] = [];

  for (let start = 0; start < sentences.length; start += chunkSize) {
    const chunk = sentences.slice(start, start + chunkSize);
    const picked = mmrSelect(textRank(chunk), perChunk);
    for (const item of picked) candidates.push(item.text);
  }

  return mmrSelect(textRank(candidates, options), targetK);
}

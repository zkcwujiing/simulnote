/**
 * 抽取式纪要引擎（**永不失败的兜底**）。
 *
 * 为什么摘要是抽取式而不是生成式：
 *  - 生成式要一个 LLM（几百 MB 到几 GB），手机端内存风险极高（设计文档 R1）；
 *  - 生成式会**编造**。纪要一旦编造，用户就无法信任整份记录 —— 这是这类
 *    工具最致命的失败模式；
 *  - 抽取式可以做到「每一条要点都能指回原文第几句」，可信、可核查。
 *  因此一期把抽取式定为默认，生成式（WebLLM）只在桌面且内存充裕时作为可选增强。
 *
 * 三段式（对应设计文档 04）：
 *  1. 切分：段 → 句，并记录每句所属的段；
 *  2. 归并：句级 TextRank 打分，再聚合到段级，用 MMR 选出覆盖度好的若干段；
 *  3. 成稿：把选中的段排回原序，配上译文；数字/日期/金额另走 facts.ts。
 */

import type { FinalSegment, Keyword, SummaryResult } from '@/types';
import type { SumEngine, SummarizeInput } from '../types';
import { DECISION_CUES, ACTION_CUES, GLOSSARY, STOPWORDS } from '@/lib/glossary';
import { extractFacts } from './facts';
import { hierarchicalTextRank, mmrSelect, textRank, tokenize } from './textRank';

interface SentenceRef {
  text: string;
  segIndex: number;
}

export interface ExtractiveSumOptions {
  /** 要点条数上限 */
  maxKeyPoints?: number;
  /** 关键词条数 */
  maxKeywords?: number;
  /** 是否把数字事实一起抽出来（关掉可省几毫秒） */
  withFacts?: boolean;
}

export class ExtractiveSumEngine implements SumEngine {
  readonly id = 'sum-extractive-textrank';
  readonly label = '抽取式纪要（本地规则）';
  readonly stage = 'sum' as const;
  readonly privacy = 'on-device' as const;
  readonly mode = 'extractive' as const;

  private readonly options: ExtractiveSumOptions;

  constructor(options: ExtractiveSumOptions = {}) {
    this.options = options;
  }

  async probe() {
    // 纯计算，任何支持 ES2022 的浏览器都能跑
    return { status: 'ready' as const };
  }

  async init(): Promise<void> {
    /* 无需加载任何资源 */
  }

  async dispose(): Promise<void> {
    /* 无资源可释放 */
  }

  async summarize(input: SummarizeInput, onChunk?: (text: string) => void): Promise<SummaryResult> {
    const { segments, translations } = input;
    const maxKeyPoints = this.options.maxKeyPoints ?? defaultKeyPointCount(segments.length);
    const maxKeywords = this.options.maxKeywords ?? 10;

    const englishTexts = segments.map((s) => s.text);

    onChunk?.('正在断句…');
    const sentences = buildSentences(segments);

    onChunk?.('正在挑选要点…');
    const pickedSegments = pickSegments(sentences, segments, maxKeyPoints);

    const keyPoints = pickedSegments.map((index) => {
      const zh = translations[index];
      if (zh && zh.trim()) return zh.trim();
      // 没有译文时诚实标注，不假装是中文
      return `〔原文〕${segments[index].text.trim()}`;
    });

    onChunk?.('正在扫描结论与待办…');
    const decisions = collectByCues(segments, translations, DECISION_CUES, 5);
    const actions = collectByCues(segments, translations, ACTION_CUES, 6);

    onChunk?.('正在统计关键词…');
    const keywords = collectKeywords(englishTexts, maxKeywords);

    onChunk?.('正在核对数字…');
    const numbers = this.options.withFacts === false ? [] : extractFacts(englishTexts);

    const title = buildTitle(keywords, keyPoints, segments);

    const chars = englishTexts.reduce((n, t) => n + t.length, 0);
    const tldr = keyPoints.slice(0, 3).join('　').slice(0, 220);

    onChunk?.('纪要完成');

    return {
      engineId: this.id,
      title,
      tldr: tldr || '本场没有识别到足够的语音内容，因此没有生成要点。',
      keyPoints,
      numbers,
      decisions,
      actions,
      keywords,
      generatedAt: Date.now(),
      mode: 'extractive',
      coverage: { segments: segments.length, chars },
    };
  }
}

/** 段数越多，允许的要点越多，但封顶 10 条 —— 超过 10 条就不叫「要点」了。 */
function defaultKeyPointCount(segmentCount: number): number {
  if (segmentCount <= 0) return 0;
  return Math.min(10, Math.max(3, Math.round(Math.sqrt(segmentCount) / 1.2)));
}

function buildSentences(segments: FinalSegment[]): SentenceRef[] {
  const out: SentenceRef[] = [];
  segments.forEach((segment, segIndex) => {
    const text = segment.text.trim();
    if (!text) return;
    // 复用 textRank 里的断句能力，但这里允许保留较短的句子，
    // 因为段级聚合会把碎片拉回平均值。
    const parts = splitInline(text);
    if (parts.length === 0) {
      out.push({ text, segIndex });
      return;
    }
    for (const part of parts) out.push({ text: part, segIndex });
  });
  return out;
}

/** 轻量断句：只按句末标点切，不处理缩写（段内粒度足够）。 */
function splitInline(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?。！？])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts;
}

/**
 * 句级 TextRank → 段级聚合 → MMR。
 * 聚合用 **max** 而不是 sum：否则长段（说了很多但都是废话）会霸榜。
 */
function pickSegments(
  sentences: SentenceRef[],
  segments: FinalSegment[],
  k: number,
): number[] {
  if (k <= 0) return [];
  if (segments.length <= k) return segments.map((_, i) => i);
  if (sentences.length === 0) return segments.slice(0, k).map((_, i) => i);

  const ranked = hierarchicalTextRank(
    sentences.map((s) => s.text),
    Math.max(k * 2, k + 4),
  );

  const segScores = new Map<number, number>();
  for (const item of ranked) {
    const ref = sentences[item.index];
    if (!ref) continue;
    const previous = segScores.get(ref.segIndex) ?? 0;
    if (item.score > previous) segScores.set(ref.segIndex, item.score);
  }

  const candidates = segments
    .map((segment, index) => ({
      index,
      text: segment.text,
      score: segScores.get(index) ?? 0,
    }))
    // 没有任何句子上榜的段给一个极小值，保留被选中的可能性（覆盖度）
    .map((c) => ({ ...c, score: c.score > 0 ? c.score : 0.01 }));

  const selected = mmrSelect(candidates, k, 0.75);
  return selected.map((s) => s.index).sort((a, b) => a - b);
}

/**
 * 用线索短语抓「结论」与「待办」。
 * 命中后输出的是该段的**中文译文**（有的话），因为用户看的是中文纪要。
 */
function collectByCues(
  segments: FinalSegment[],
  translations: (string | undefined)[],
  cues: readonly string[],
  limit: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < segments.length; i++) {
    const lower = segments[i].text.toLowerCase();
    const hit = cues.find((cue) => lower.includes(cue));
    if (!hit) continue;

    const zh = translations[i]?.trim();
    const line = zh && zh.length > 0 ? zh : `〔原文〕${segments[i].text.trim()}`;
    const fingerprint = line.slice(0, 40).toLowerCase();
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(line);
    if (out.length >= limit) break;
  }

  return out;
}

/** TF 排序取关键词，并用内置词表补中文。 */
function collectKeywords(texts: string[], limit: number): Keyword[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const token of tokenize(text)) {
      // 纯数字不适合当关键词（它们已经在「关键数字」里了）
      if (/^\d/.test(token) && !/[a-z]/.test(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  // 只有出现两次以上的词才算关键词；文本太短时放宽
  const threshold = texts.length > 8 ? 2 : 1;

  const ranked = [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  if (ranked.length === 0) {
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([en, weight]) => ({ en, zh: GLOSSARY[en] ?? '', weight }));
  }

  return ranked.map(([en, weight]) => ({ en, zh: GLOSSARY[en] ?? '', weight }));
}

function buildTitle(keywords: Keyword[], keyPoints: string[], segments: FinalSegment[]): string {
  if (keywords.length >= 2) {
    const zh = keywords
      .slice(0, 3)
      .map((k) => k.zh || k.en)
      .filter(Boolean);
    if (zh.length) return zh.join(' · ');
  }
  const first = keyPoints[0] ?? segments[0]?.text ?? '';
  const trimmed = first.replace(/^〔原文〕/, '').trim();
  return trimmed.length > 26 ? `${trimmed.slice(0, 26)}…` : trimmed || '本场纪要';
}

/** 供 UI 显示「这份纪要是怎么来的」。 */
export const EXTRACTIVE_PIPELINE_NOTE =
  '要点由 TextRank 从转写文本中抽取，每一条都对应原文里的真实语句；' +
  '数字、日期、金额直接从英文原文解析，不经过翻译模型。';

/** 便于单元测试与外部复用：只做关键词。 */
export function extractKeywords(texts: string[], limit = 10): Keyword[] {
  return collectKeywords(texts, limit);
}

/** 便于单元测试与外部复用：只做句级打分。 */
export function rankSentences(texts: string[]): { text: string; score: number }[] {
  return textRank(texts).map((r) => ({ text: r.text, score: r.score }));
}

/** 便于外部检查停用词表是否覆盖了某词。 */
export function isStopword(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase());
}

/** 便于外部查询词表中的中文。 */
export function glossaryLookup(word: string): string | undefined {
  return GLOSSARY[word.toLowerCase()];
}

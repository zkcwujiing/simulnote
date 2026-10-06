/**
 * 事实抽取：**只读英文原文**。
 *
 * 这是本项目针对「小模型翻译数字不可靠」的核心对策（设计文档 07 的 R4）。
 * 无论翻译链路走内置 API 还是本地小模型，纪要里的数字、日期、金额都来自这里，
 * 而不是来自译文。这样即使译文把数字翻错，纪要面板仍然是对的 —— 并且两条信息
 * 同时呈现，用户一眼能看出译文哪里不对。
 */

import type { ExtractedFact, FactKind } from '@/types';
import {
  currencyZh,
  durationZh,
  formatNumber,
  isNumberWord,
  numberFromWords,
  scaledZh,
} from '@/lib/numberZh';

const MONTHS: Record<string, string> = {
  january: '1月', february: '2月', march: '3月', april: '4月', may: '5月',
  june: '6月', july: '7月', august: '8月', september: '9月', october: '10月',
  november: '11月', december: '12月',
  jan: '1月', feb: '2月', mar: '3月', apr: '4月', jun: '6月',
  jul: '7月', aug: '8月', sep: '9月', sept: '9月', oct: '10月', nov: '11月', dec: '12月',
};

const WEEKDAYS: Record<string, string> = {
  monday: '周一', tuesday: '周二', wednesday: '周三', thursday: '周四',
  friday: '周五', saturday: '周六', sunday: '周日',
  mon: '周一', tue: '周二', tues: '周二', wed: '周三', thu: '周四', thur: '周四',
  thurs: '周四', fri: '周五', sat: '周六', sun: '周日',
};

/** 把一段英文里的数词片段解析成数值；解析不出返回 null。 */
function parseNumericPhrase(phrase: string): number | null {
  const trimmed = phrase.trim();
  if (!trimmed) return null;
  if (/^\d[\d,]*(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed.replace(/,/g, ''));
  }
  const words = trimmed.split(/\s+/).filter((w) => w && w !== 'and');
  if (words.length === 0) return null;
  if (!words.every((w) => isNumberWord(w))) return null;
  return numberFromWords(words);
}

const NUMBER_PHRASE = String.raw`(?:\d[\d,]*(?:\.\d+)?|(?:[a-z]+(?:[-\s]+[a-z]+){0,3}))`;

interface RawMatch {
  raw: string;
  zh: string;
  index: number;
  kind: FactKind;
}

function pct(phrase: string): string | null {
  const value = parseNumericPhrase(phrase);
  if (value === null) return null;
  return `${formatNumber(value)}%`;
}

/** 从一句话里把所有数字类事实抠出来。 */
function extractFromSentence(sentence: string, segIndex: number, context: string): ExtractedFact[] {
  const found: RawMatch[] = [];
  const lower = sentence.toLowerCase();

  // ---- 百分比 ----
  const percentRe = new RegExp(String.raw`(${NUMBER_PHRASE})\s*(?:percent|per\s*cent|%)`, 'gi');
  for (const m of sentence.matchAll(percentRe)) {
    const zh = pct(m[1]);
    if (zh) found.push({ raw: m[0].trim(), zh, index: m.index ?? 0, kind: 'percent' });
  }
  // "12%" 已被上面覆盖；"a third of" 这类分数不强求

  // ---- 金额 ----
  const symbolMoney = /([$€£¥])\s*(\d[\d,]*(?:\.\d+)?)\s*(million|billion|thousand|trillion|m|mn|bn|k)?/gi;
  for (const m of sentence.matchAll(symbolMoney)) {
    const value = Number(m[2].replace(/,/g, ''));
    const cur = currencyZh(m[1]) ?? '';
    // ⚠️ 必须「先乘倍率、再按中文进位渲染」：4.8 million 是 480万，不是 4.8万。
    const text = scaledZh(value, m[3]) + cur;
    found.push({ raw: m[0].trim(), zh: text, index: m.index ?? 0, kind: 'money' });
  }

  const wordMoney =
    /(\d[\d,]*(?:\.\d+)?)\s*(million|billion|thousand|trillion|m|mn|bn|k)?\s*(dollars?|euros?|pounds?|yuan|rmb|yen|usd|eur|gbp)/gi;
  for (const m of sentence.matchAll(wordMoney)) {
    const raw = m[0].trim();
    if (found.some((f) => f.raw.includes(raw))) continue;
    const value = Number(m[1].replace(/,/g, ''));
    const cur = currencyZh(m[3]) ?? '';
    found.push({
      raw,
      zh: scaledZh(value, m[2]) + cur,
      index: m.index ?? 0,
      kind: 'money',
    });
  }

  // ---- 工期 / 时长 ----
  const durationRe =
    /(\d[\d,]*(?:\.\d+)?|(?:[a-z]+(?:[-\s]+[a-z]+){0,2}))\s*(milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|quarters?|years?|ms|secs?|mins?|hrs?|wks?|yrs?)\b/gi;
  for (const m of sentence.matchAll(durationRe)) {
    // 跳过 "3 years old" 这种；以及 "two days ago" 其实也是时长，保留
    const value = parseNumericPhrase(m[1]);
    if (value === null) continue;
    const unit = durationZh(m[2]);
    if (!unit) continue;
    found.push({
      raw: m[0].trim(),
      zh: `${formatNumber(value)}${unit}`,
      index: m.index ?? 0,
      kind: 'duration',
    });
  }

  // ---- 规模量词 ----
  const scaleRe = /(\d[\d,]*(?:\.\d+)?)\s*(million|billion|trillion|thousand)\b/gi;
  for (const m of sentence.matchAll(scaleRe)) {
    const raw = m[0].trim();
    if (found.some((f) => f.raw.includes(raw))) continue;
    const value = Number(m[1].replace(/,/g, ''));
    found.push({ raw, zh: scaledZh(value, m[2]), index: m.index ?? 0, kind: 'quantity' });
  }

  const compactScale = /\b(\d+(?:\.\d+)?)\s*(k|m|mn|bn|tn)\b/g;
  for (const m of sentence.matchAll(compactScale)) {
    const raw = m[0].trim();
    if (found.some((f) => f.raw.includes(raw))) continue;
    found.push({
      raw,
      zh: scaledZh(Number(m[1]), m[2]),
      index: m.index ?? 0,
      kind: 'quantity',
    });
  }

  // ---- 日期与时间点 ----
  // "March 15, 2026" 整体成一条（英文里年份跟在逗号后面，前面没有介词，
  // 所以下面的 yearRe 抓不到它 —— 结果就是「月日有了、年份丢了」）。
  // 先跑这条长的，并记下它占用的区间，免得短的那条再把 "March 15" 抓一遍。
  const monthDayYearRe = new RegExp(
    String.raw`\b(${Object.keys(MONTHS).join('|')})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s+((?:19|20)\d{2})\b`,
    'gi',
  );
  const consumed: Array<[number, number]> = [];
  for (const m of sentence.matchAll(monthDayYearRe)) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) continue;
    const start = m.index ?? 0;
    consumed.push([start, start + m[0].length]);
    found.push({
      raw: m[0].trim(),
      zh: `${m[3]}年${month}${Number(m[2])}日`,
      index: start,
      kind: 'date',
    });
  }
  const overlapsConsumed = (index: number) => consumed.some(([a, b]) => index >= a && index < b);

  const monthRe = new RegExp(
    String.raw`\b(${Object.keys(MONTHS).join('|')})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b`,
    'gi',
  );
  for (const m of sentence.matchAll(monthRe)) {
    if (overlapsConsumed(m.index ?? 0)) continue;
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) continue;
    found.push({ raw: m[0].trim(), zh: `${month}${Number(m[2])}日`, index: m.index ?? 0, kind: 'date' });
  }

  // 注：故意**不做**「光秃秃的月份名」（"in February"）—— `may` / `march` 同时也是
  // 情态动词和普通动词，句首大写的 "May" 更是无法与月份区分，误报率远高于收益。

  const weekdayRe = new RegExp(String.raw`\b(${Object.keys(WEEKDAYS).join('|')})\b`, 'gi');
  for (const m of sentence.matchAll(weekdayRe)) {
    const day = WEEKDAYS[m[1].toLowerCase()];
    if (!day) continue;
    found.push({ raw: m[0].trim(), zh: day, index: m.index ?? 0, kind: 'date' });
  }

  const quarterRe = /\bq([1-4])\b/gi;
  for (const m of sentence.matchAll(quarterRe)) {
    found.push({ raw: m[0].trim(), zh: `第${m[1]}季度`, index: m.index ?? 0, kind: 'date' });
  }

  const yearRe = /\b(?:in|by|since|from|until|before|after|during)\s+((?:19|20)\d{2})\b/gi;
  for (const m of sentence.matchAll(yearRe)) {
    found.push({ raw: m[1], zh: `${m[1]}年`, index: m.index ?? 0, kind: 'date' });
  }

  const relativeRe =
    /\b(next|last|this)\s+(week|month|quarter|year)\b|\bend of (?:the )?(week|month|quarter|year)\b/gi;
  for (const m of sentence.matchAll(relativeRe)) {
    const zhMap: Record<string, string> = {
      week: '周', month: '月', quarter: '季度', year: '年',
    };
    if (m[1] && m[2]) {
      const prefix = m[1].toLowerCase() === 'next' ? '下' : m[1].toLowerCase() === 'last' ? '上' : '本';
      found.push({ raw: m[0].trim(), zh: `${prefix}${zhMap[m[2].toLowerCase()] ?? m[2]}`, index: m.index ?? 0, kind: 'date' });
    } else if (m[3]) {
      found.push({
        raw: m[0].trim(),
        zh: `${zhMap[m[3].toLowerCase()] ?? m[3]}底`,
        index: m.index ?? 0,
        kind: 'date',
      });
    }
  }

  // ---- 比例分数（half / a third）----
  if (/\bhalf\b/i.test(sentence)) {
    const m = /\bhalf\b/i.exec(sentence);
    if (m) found.push({ raw: m[0], zh: '一半', index: m.index, kind: 'quantity' });
  }
  if (/\b(a |one )?third\b/i.test(lower)) {
    const m = /\b(a |one )?third\b/i.exec(sentence);
    if (m) found.push({ raw: m[0].trim(), zh: '三分之一', index: m.index, kind: 'quantity' });
  }

  // 去重（同 raw 只留一次），并按出现位置排序
  const seen = new Set<string>();
  const deduped: RawMatch[] = [];
  for (const item of found.sort((a, b) => a.index - b.index)) {
    const key = `${item.kind}:${item.raw.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped.map((item) => ({
    raw: item.raw.replace(/^[\s,.;:]+|[\s,.;:]+$/g, ''),
    zh: item.zh,
    context,
    segIndex,
    kind: item.kind,
  }));
}

/** 句首出现时不可信的普通词（避免把 "The team" 当成专名）。 */
const SENTENCE_STARTERS = new Set([
  'the', 'we', 'this', 'that', 'there', 'they', 'it', 'and', 'i', 'you',
  'he', 'she', 'a', 'an', 'but', 'so', 'now', 'then', 'if', 'our', 'my',
]);

/** 句中也可能大写、但不是专名的词。 */
const COMMON_CAPITALIZED = new Set([
  'i', "i'm", "i've", "i'll", "i'd", 'ok', 'okay', 'god', 'yeah', 'well',
  'today', 'tomorrow', 'yesterday', 'next', 'first', 'second', 'third',
]);

export interface ProperHit {
  name: string;
  /** 这个专名第一次出现时所在的句子（英文），用作「出处」 */
  context: string;
  segIndex: number;
}

/**
 * 抽取专有名词。
 *
 * 两条路一起走：
 *  1. **连续 2 个以上首字母大写词** —— "Google Cloud"、"Project Atlas" 这类；
 *  2. **单个大写单词** —— "PostgreSQL"、"Kubernetes"、"Kafka"。
 *     单个词要能信，必须满足「不在句首」或「带内部大写」（`/[a-z][A-Z]/`，
 *     如 PostgreSQL、YouTube）。句首那个大写词永远只是句子的开头，
 *     拿它当专名会把 "Revenue"、"Growth" 这类普通词全捞进来。
 *
 * 为什么必须把单个词也捞上：R4 的对策是「英文里的数字/日期/**专有名词**
 * 单独抽出，作为不受翻译影响的独立字段」。而技术会议里最需要保真的恰恰是
 * PostgreSQL / Kubernetes / Kafka 这种单词专名 —— 译文里它们经常被直译成
 * 「邮局」「库伯内蒂斯」之类。只认连续大写词等于把这一类整个漏掉。
 */
function extractProperNouns(texts: string[]): ProperHit[] {
  const count = new Map<string, number>();
  const firstSeen = new Map<string, ProperHit>();

  const add = (name: string, sentence: string, segIndex: number) => {
    const cleaned = name.trim().replace(/[.,;:]+$/, '').replace(/['’]s$/, '');
    if (cleaned.length < 3) return;
    const key = cleaned.toLowerCase();
    count.set(key, (count.get(key) ?? 0) + 1);
    if (!firstSeen.has(key)) firstSeen.set(key, { name: cleaned, context: sentence.trim(), segIndex });
  };

  texts.forEach((text, segIndex) => {
    for (const sentence of text.split(/(?<=[.!?。！？])\s+/)) {
      if (!sentence.trim()) continue;

      // 已经在多词专名里用掉的位置，不再被单词那一路重复认领
      const consumed: Array<[number, number]> = [];

      const multi = sentence.match(/\b[A-Z][a-zA-Z0-9.'-]*(?:\s+[A-Z][a-zA-Z0-9.'-]*){1,3}\b/g) ?? [];
      for (const raw of multi) {
        const start = sentence.indexOf(raw);
        if (start < 0) continue;
        const words = raw.trim().split(/\s+/);
        if (words.length === 2 && SENTENCE_STARTERS.has(words[0].toLowerCase())) continue;
        consumed.push([start, start + raw.length]);
        add(raw, sentence, segIndex);
      }

      const tokens = [...sentence.matchAll(/\b[A-Z][a-zA-Z0-9.'-]*\b/g)];
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i][0];
        const at = tokens[i].index ?? 0;
        if (consumed.some(([from, to]) => at >= from && at < to)) continue;
        const innerCapital = /[a-z][A-Z]/.test(token);
        if (i === 0 && !innerCapital) continue; // 句首大写词不可信
        const lower = token.toLowerCase();
        if (COMMON_CAPITALIZED.has(lower)) continue;
        if (/^[A-Z]{1,3}\d+$/.test(token)) continue; // Q3 之类交给日期抽取
        add(token, sentence, segIndex);
      }
    }
  });

  return [...firstSeen.entries()]
    .sort((a, b) => (count.get(b[0]) ?? 0) - (count.get(a[0]) ?? 0))
    .slice(0, 24)
    .map(([, hit]) => hit);
}

export interface ExtractFactsOptions {
  /** 每句最多抽几条，避免长句刷屏 */
  perSentenceLimit?: number;
  /** 总上限 */
  totalLimit?: number;
}

/**
 * 从整场会话的英文原文里抽取全部事实。
 * @param texts 每段的英文原文，顺序即段落顺序
 */
export function extractFacts(texts: string[], options: ExtractFactsOptions = {}): ExtractedFact[] {
  const perSentenceLimit = options.perSentenceLimit ?? 4;
  const totalLimit = options.totalLimit ?? 200;

  const all: ExtractedFact[] = [];

  texts.forEach((text, segIndex) => {
    // 句子切分交给调用方传进来的粒度（通常是段），这里再按标点细分
    const rough = text.split(/(?<=[.!?])\s+/);
    for (const sentence of rough) {
      if (!sentence.trim()) continue;
      const matches = extractFromSentence(sentence, segIndex, sentence.trim());
      const picked: ExtractedFact[] = matches.slice(0, perSentenceLimit);
      all.push(...picked);
      if (all.length >= totalLimit) break;
    }
  });

  // 专有名词单独补一轮，标为 proper
  const proper = extractProperNouns(texts);
  for (const hit of proper) {
    if (all.length >= totalLimit + 30) break;
    if (all.some((f) => f.raw.toLowerCase() === hit.name.toLowerCase())) continue;
    all.push({
      raw: hit.name,
      zh: hit.name,
      context: hit.context,
      segIndex: hit.segIndex,
      kind: 'proper',
    });
  }

  return all;
}

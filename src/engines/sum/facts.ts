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
  scaleZh,
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
  const symbolMoney = /([$€£¥])\s*(\d[\d,]*(?:\.\d+)?)\s*(million|billion|thousand|m|bn|k)?/gi;
  for (const m of sentence.matchAll(symbolMoney)) {
    const value = Number(m[2].replace(/,/g, ''));
    const scale = m[3] ? scaleZh(normalizeScale(m[3])) : null;
    const cur = currencyZh(m[1]) ?? '';
    const text = scale ? `${formatNumber(value)}${scale}${cur}` : `${formatNumber(value)}${cur}`;
    found.push({ raw: m[0].trim(), zh: text, index: m.index ?? 0, kind: 'money' });
  }

  const wordMoney =
    /(\d[\d,]*(?:\.\d+)?)\s*(million|billion|thousand)?\s*(dollars?|euros?|pounds?|yuan|rmb|yen|usd|eur|gbp)/gi;
  for (const m of sentence.matchAll(wordMoney)) {
    const raw = m[0].trim();
    if (found.some((f) => f.raw.includes(raw))) continue;
    const value = Number(m[1].replace(/,/g, ''));
    const scale = m[2] ? scaleZh(normalizeScale(m[2])) : null;
    const cur = currencyZh(m[3]) ?? '';
    found.push({
      raw,
      zh: scale ? `${formatNumber(value)}${scale}${cur}` : `${formatNumber(value)}${cur}`,
      index: m.index ?? 0,
      kind: 'money',
    });
  }

  // ---- 工期 / 时长 ----
  const durationRe =
    /(\d[\d,]*(?:\.\d+)?|(?:[a-z]+(?:[-\s]+[a-z]+){0,2}))\s*(seconds?|minutes?|hours?|days?|weeks?|months?|quarters?|years?)\b/gi;
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
    const scale = scaleZh(m[2]);
    if (!scale) continue;
    found.push({ raw, zh: `${formatNumber(value)}${scale}`, index: m.index ?? 0, kind: 'quantity' });
  }

  const compactScale = /\b(\d+(?:\.\d+)?)\s*(k|m|bn)\b/g;
  for (const m of sentence.matchAll(compactScale)) {
    const raw = m[0].trim();
    if (found.some((f) => f.raw.includes(raw))) continue;
    const map: Record<string, string> = { k: '千', m: '万', bn: '亿' };
    found.push({
      raw,
      zh: `${formatNumber(Number(m[1]))}${map[m[2].toLowerCase()]}`,
      index: m.index ?? 0,
      kind: 'quantity',
    });
  }

  // ---- 日期与时间点 ----
  const monthRe = new RegExp(String.raw`\b(${Object.keys(MONTHS).join('|')})\.?\s+(\d{1,2})\b`, 'gi');
  for (const m of sentence.matchAll(monthRe)) {
    const month = MONTHS[m[1].toLowerCase()];
    if (!month) continue;
    found.push({ raw: m[0].trim(), zh: `${month}${Number(m[2])}日`, index: m.index ?? 0, kind: 'date' });
  }

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

function normalizeScale(word: string): string {
  const w = word.toLowerCase();
  if (w === 'm' || w === 'mm') return 'million';
  if (w === 'bn' || w === 'b') return 'billion';
  if (w === 'k') return 'thousand';
  return w;
}

/**
 * 抽取专有名词：连续 2 个以上的首字母大写词，且不是句首的普通词。
 * 用于把 "Project Atlas"、"Google Cloud" 这类实体捞出来放进关键词/事实里。
 */
function extractProperNouns(sentences: string[]): string[] {
  const counts = new Map<string, number>();
  for (const sentence of sentences) {
    const matches = sentence.match(/\b[A-Z][a-zA-Z0-9.'-]*(?:\s+[A-Z][a-zA-Z0-9.'-]*){1,3}\b/g);
    if (!matches) continue;
    for (const match of matches) {
      const cleaned = match.trim();
      const words = cleaned.split(/\s+/);
      // 去掉句首的普通大写词（The, We, This...）
      const first = words[0].toLowerCase();
      if (words.length === 2 && ['the', 'we', 'this', 'that', 'there', 'they', 'it', 'and'].includes(first)) {
        continue;
      }
      if (cleaned.length < 4) continue;
      counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([name]) => name);
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
  for (const name of proper) {
    if (all.length >= totalLimit + 30) break;
    if (all.some((f) => f.raw.toLowerCase() === name.toLowerCase())) continue;
    all.push({
      raw: name,
      zh: name,
      context: '',
      segIndex: -1,
      kind: 'proper',
    });
  }

  return all;
}

/**
 * 数字回填：把翻译模型**丢掉或占位化**的数字，用英文原文里的真值补回去。
 *
 * 为什么需要它（设计文档 07 的 R4）：
 *   小模型翻译数字不可靠，这不是猜测。2026/10/6 的真机样本里直接抓到了两种形态 ——
 *     · `About 60% of the test group` → 「大约 __ 个测试组」
 *       （模型**自己吐了个占位符**，说明它知道这里该有个数字，只是没写出来）
 *     · `March 15, 2026` → 「3月15日,2026年3月15日」（日期写了两遍）
 *   前者是最理想的修复对象：位置由模型自己标出来了，我们只要把
 *   `extractFacts()`（**只读英文原文**，不经过翻译）解析出的真值填进去。
 *
 * 设计原则 —— **宁可不改，不可改错**：
 *   1. 只填「模型自己留了占位符」的空位。没有占位符就只报告缺失，绝不猜位置硬塞；
 *   2. 只折叠**明显重复的日期片段**（一个片段整个包含在紧邻的下一个片段里，
 *      且两边都带数字），不做任何语义级改写；
 *   3. 每一次改动都记进 `edits`，UI 可以把「改了哪几处」摊开给用户看。
 *      纪要这类东西，**未经说明的自动改写比不改更糟**。
 */

import type { ExtractedFact } from '@/types';
import { compactValue, formatNumber, scaleValue } from '@/lib/numberZh';
import { extractFacts } from './facts';

export interface BackfillEdit {
  /** placeholder = 填回模型留下的空位；duplicate-date = 折叠重复的日期片段 */
  reason: 'placeholder' | 'duplicate-date';
  /** 被替换掉的原文片段 */
  from: string;
  /** 替换成的内容 */
  to: string;
  /** 触发这次改写的英文原文片段（对不上时显示这个更有用） */
  raw: string;
}

export interface BackfillResult {
  /** 回填之后的译文；没有任何可改的地方时原样返回 */
  text: string;
  edits: BackfillEdit[];
  /** 英文里有、译文里既找不到、也没有空位可填的事实（只报告，不猜） */
  missing: ExtractedFact[];
}

/** 阿拉伯数字 token（含千分位）。 */
const DIGITS_RE = /\d[\d,]*(?:\.\d+)?/g;

/** 模型留给数字的空位。故意只认「不可能出现在正常中文里」的形状。 */
const PLACEHOLDER_RE =
  /_{2,}|\[\s*_+\s*\]|【\s*_*\s*】|\[\s*\]|【\s*】|□+|■+|◻+|（空）|\(\s*空\s*\)/g;

/** 从一段文本里取出全部阿拉伯数字 token（去掉千分位）。 */
function digitTokens(text: string): string[] {
  return (text.match(DIGITS_RE) ?? []).map((n) => n.replace(/,/g, ''));
}

/**
 * 一条事实在译文里**可以接受的**阿拉伯数字写法。
 *
 * 例如 "4.8 million dollars" 的 zh 是 "480万美元"，那么译文里出现
 * `480`（正确写法）或 `4.8`（模型常见的错写法）都算「数字没丢」——
 * 这里只判断「丢没丢」，判断「对不对」是数字对照表的职责。
 */
function acceptableForms(fact: ExtractedFact): string[] {
  const forms = new Set<string>(digitTokens(fact.raw));
  const scaled = /(\d[\d,]*(?:\.\d+)?)\s*(hundred|thousand|million|billion|trillion|k|mn|bn|tn|m)\b/i.exec(
    fact.raw,
  );
  if (scaled) {
    const multiplier = scaleValue(scaled[2]) ?? compactValue(scaled[2]) ?? 1;
    const value = Number(scaled[1].replace(/,/g, '')) * multiplier;
    forms.add(String(value));
    forms.add(formatNumber(value / 1e4));
    forms.add(formatNumber(value / 1e8));
  }
  for (const d of digitTokens(fact.zh)) forms.add(d);
  return [...forms].filter((f) => f.length > 0);
}

function isPresent(fact: ExtractedFact, zhDigits: Set<string>): boolean {
  return acceptableForms(fact).some((form) => zhDigits.has(form));
}

const DATE_LIKE_RE = /\d\s*(?:年|月|日|号)|\d{4}/;

/**
 * 折叠「一个日期片段整个重复在下一个片段里」的写法。
 *
 * `3月15日,2026年3月15日` → `2026年3月15日`
 * `交易在3月15日,2026年3月15日完成。` → `交易在2026年3月15日完成。`
 *
 * 判定很窄：逗号分开的两段都带数字、且都像日期，并且**前一段去掉中文前缀后的
 * 数字核心**整个出现在后一段里。任何一条不满足就一个字都不动。
 */
function collapseDuplicateDates(text: string): { text: string; edits: BackfillEdit[] } {
  const edits: BackfillEdit[] = [];
  const out = text.replace(
    /([^，,、;；]{1,14})[，,、]\s*([^，,、;；]{1,24})/g,
    (whole, firstRaw, secondRaw) => {
      const first = String(firstRaw);
      const second = String(secondRaw).trim();
      if (!/\d/.test(first) || !/\d/.test(second)) return whole;
      if (!DATE_LIKE_RE.test(first) || !DATE_LIKE_RE.test(second)) return whole;

      // 去掉前面的中文（"交易在3月15日" → "3月15日"），只拿数字核心做包含判断
      const core = first.replace(/^[^\d]*/, '').trim();
      if (core.length < 3) return whole;
      if (!DATE_LIKE_RE.test(core)) return whole;
      if (!second.includes(core)) return whole;

      const prefix = first.slice(0, first.indexOf(core));
      edits.push({ reason: 'duplicate-date', from: `${core}，${second}`, to: second, raw: core });
      return prefix + second;
    },
  );
  return { text: out, edits };
}

/**
 * 主入口：把英文原文里的数字，回填进对应的中文译文。
 *
 * @param english 该段的英文原文（数字的**唯一**来源）
 * @param chinese 该段的中文译文（可能缺数字或带占位符）
 */
export function backfillNumbers(english: string, chinese: string): BackfillResult {
  const empty: BackfillResult = { text: chinese, edits: [], missing: [] };
  if (!english.trim() || !chinese.trim()) return empty;

  const facts = extractFacts([english]);
  if (facts.length === 0) return empty;

  const edits: BackfillEdit[] = [];
  let text = chinese;

  // ---- 1) 占位符回填 ----
  const zhDigits = new Set(digitTokens(text));
  const missing = facts.filter((fact) => !isPresent(fact, zhDigits));

  if (missing.length > 0 && (text.match(PLACEHOLDER_RE)?.length ?? 0) > 0) {
    const queue = [...missing];
    let used = 0;
    text = text.replace(PLACEHOLDER_RE, (placeholder) => {
      const fact = queue[used];
      if (!fact) return placeholder;
      used += 1;
      edits.push({ reason: 'placeholder', from: placeholder, to: fact.zh, raw: fact.raw });
      return fact.zh;
    });
    missing.splice(0, used);
  }

  // ---- 2) 折叠重复日期 ----
  const collapsed = collapseDuplicateDates(text);
  if (collapsed.edits.length > 0) {
    text = collapsed.text;
    edits.push(...collapsed.edits);
  }

  return { text, edits, missing };
}

/** 把结果压成一句给用户看的话；没有可说的返回 null。 */
export function describeBackfill(edits: BackfillEdit[], missing: ExtractedFact[]): string | null {
  const parts: string[] = [];
  const filled = edits.filter((e) => e.reason === 'placeholder').length;
  const collapsed = edits.filter((e) => e.reason === 'duplicate-date').length;
  if (filled > 0) parts.push(`补回 ${filled} 处被模型丢掉或占位化的数字`);
  if (collapsed > 0) parts.push(`折叠 ${collapsed} 处重复日期`);
  if (missing.length > 0) {
    const sample = missing
      .slice(0, 3)
      .map((f) => f.zh)
      .join('、');
    parts.push(`另有 ${missing.length} 处数字译文里找不到（${sample}${missing.length > 3 ? '…' : ''}），请看数字表`);
  }
  return parts.length > 0 ? parts.join('；') : null;
}

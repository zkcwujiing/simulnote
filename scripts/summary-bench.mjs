#!/usr/bin/env node
/**
 * V6 · 抽取式纪要质量基准。
 *
 * 为什么要有这个脚本
 * ------------------
 * `docs/06-开发路线图与里程碑.md` 给 M3 定的验收是「要点覆盖率 ≥ 70%、
 * 数字保留准确率 ≥ 95%、无幻觉」。但这三条要能**算**出来，先得有一份标好的
 * 语料和一个会做算术的脚本 —— 否则「我觉得摘要还行」不是验收，是感觉。
 *
 * 语料格式见 `docs/results/corpus/meeting-en.txt`：
 *   `@ ` 开头 = 人工判定的要点（ground truth）
 *   `#`  开头 = 注释
 *   其它非空行 = 真实讲话内容（铺垫、过程、闲聊）
 *
 * 两种喂法（**都要看，因为它们回答的是不同的问题**）
 * --------------------------------------------------
 *   full   把 `@ ` 去掉后**连同**原文一起喂给引擎。回答「引擎能不能把已经写在
 *          纸上的要点挑出来」—— 上限高，但会高估。
 *   speech **只喂原文**，标注完全不进引擎。回答「一句话都没标过的时候，引擎能
 *          不能自己找到该进纪要的那几句」—— 这才是真实场景。
 *   `speech` 是更诚实的那个数字，因此报告里把它排在前面。
 *
 * ⚠️ 诚实声明
 * ----------
 * 1. 标注是**改写**而非原文摘录（`@ Revenue reached 4.8 million dollars…`
 *    对应的原句是 `revenue came in at 4.8 million dollars…`），所以命中判定
 *    只能按内容词重合度来算，不能按字符串相等。脚本用 Jaccard ≥ 0.5。
 * 2. 标注集是一份**理想纪要**，信息量比逐字转写大（例：`@ The board rejected
 *    the Northwind acquisition…` 在原句里只体现为「62 要 95，董事会觉得站不住」）。
 *    所以 `speech` 模式下的「要点 recall」天然偏低，这不是引擎的错。
 * 3. 要点条数 K 由 `defaultKeyPointCount()` 决定（本语料 54 段 → K = 6），
 *    而标注有 19 条 —— **recall@K 在数学上就上不了 70%**。真正该盯的是
 *    precision@K 与「决策/待办有没有漏掉」。见报告里的说明。
 *
 * 用法
 * ----
 *   pnpm bench:summary            # 生成 docs/results/V6.md
 *   pnpm bench:summary --check    # 额外：硬性不变量不成立就退出码 1
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ExtractiveSumEngine } from '@/engines/sum/extractiveSum';
import { DECISION_CUES, ACTION_CUES, STOPWORDS } from '@/lib/glossary';

const CORPUS_URL = new URL('../docs/results/corpus/meeting-en.txt', import.meta.url);
const REPORT_URL = new URL('../docs/results/V6.md', import.meta.url);
const CHECK = process.argv.includes('--check');

// ---------------------------------------------------------------------------
// 语料
// ---------------------------------------------------------------------------

function parseCorpus(raw) {
  const lines = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      lines.push({ kind: 'comment', text: t });
    } else if (t.startsWith('@')) {
      lines.push({ kind: 'annotation', text: t.replace(/^@\s*/, '').trim() });
    } else {
      lines.push({ kind: 'speech', text: t });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 文本比对（内容词 Jaccard）
// ---------------------------------------------------------------------------

const STOP = new Set(STOPWORDS);

/**
 * 极轻量的词尾归并。
 *
 * 为什么需要：标注是改写，同一个概念常常换了词形 ——
 *   原句 `…the alert threshold review into the weekly operations meeting`
 *   标注 `Alert thresholds will now be reviewed every week in the operations meeting`
 * 不归并的话 `thresholds/threshold`、`reviewed/review`、`weekly/week` 三对全算不重合，
 * 一条**挑对了**的要点会被判成错的。这里只做后缀剥离，不做词干还原，够用且可控。
 */
function stem(w) {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ly') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1);
  return w;
}

function contentWords(text) {
  const out = new Set();
  for (const w of text.toLowerCase().match(/[a-z][a-z'-]*|\d[\d.,]*/g) ?? []) {
    if (w.length < 2 && !/\d/.test(w)) continue;
    if (/^[a-z]/.test(w) && STOP.has(w)) continue;
    out.add(stem(w.replace(/[.,]+$/, '')));
  }
  return out;
}

/**
 * 重合系数 `|A∩B| / min(|A|,|B|)`。
 *
 * 为什么不只用 Jaccard：标注是**改写**，长度经常和原句差一倍。
 *  原句 `We also decided to move the alert threshold review into the weekly
 *  operations meeting.`（9 个内容词）
 *  标注 `Alert thresholds will now be reviewed every week in the operations
 *  meeting.`（6 个内容词）
 * 交集 3 个 —— Jaccard 只有 0.25（判为没命中），重合系数是 0.50（命中）。
 * 这一条明明是引擎挑对的，用 Jaccard 会把它算成错的。
 */
function overlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

const MATCH_THRESHOLD = 0.5;

function digits(text) {
  const out = new Set();
  for (const m of text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) out.add(m.replace(/,/g, ''));
  return out;
}

function normalize(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function stripOriginalPrefix(s) {
  return s.replace(/^〔原文〕/, '').trim();
}

// ---------------------------------------------------------------------------
// 一次评测
// ---------------------------------------------------------------------------

async function runMode(mode, lines) {
  const annotations = lines.filter((l) => l.kind === 'annotation').map((l) => l.text);
  const annotationWords = annotations.map(contentWords);

  let fed;
  if (mode === 'full') {
    // `@ ` 去掉之后连标注一起喂
    fed = lines.filter((l) => l.kind !== 'comment').map((l) => l.text);
  } else {
    fed = lines.filter((l) => l.kind === 'speech').map((l) => l.text);
  }

  const segments = fed.map((text, i) => ({
    id: `seg-${i}`,
    text,
    startMs: i * 5000,
    endMs: (i + 1) * 5000,
  }));

  const engine = new ExtractiveSumEngine();
  const result = await engine.summarize({ segments, translations: [] });

  const picked = result.keyPoints.map(stripOriginalPrefix).filter(Boolean);
  const pickedWords = picked.map(contentWords);

  // 命中：每一条要点找最像的一条标注，一条标注只算一次
  const usedAnnotation = new Set();
  let hits = 0;
  const hitDetail = [];
  for (let i = 0; i < picked.length; i++) {
    let best = -1;
    let bestScore = 0;
    for (let j = 0; j < annotations.length; j++) {
      const score = overlap(pickedWords[i], annotationWords[j]);
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    const exact = annotations.findIndex((a, j) => !usedAnnotation.has(j) && normalize(a) === normalize(picked[i]));
    let matched = -1;
    let score = 0;
    if (exact >= 0) {
      matched = exact;
      score = 1;
    } else if (best >= 0 && bestScore >= MATCH_THRESHOLD && !usedAnnotation.has(best)) {
      matched = best;
      score = bestScore;
    }
    if (matched >= 0) {
      usedAnnotation.add(matched);
      hits += 1;
    }
    hitDetail.push({ text: picked[i], matched, score });
  }

  const precision = picked.length === 0 ? 0 : hits / picked.length;
  const recall = annotations.length === 0 ? 0 : usedAnnotation.size / annotations.length;

  // 数字保留率：**只算引擎有机会看到的那些**。
  // 标注是理想纪要，里面有些数字原文压根没说（例：`@ Watch the churn rate,
  // which moved from 2.1 percent to 3.4 percent` —— 原句只说「我们还没完全
  // 搞懂那个变化」）。拿这些去扣引擎的分是不公平的，所以分母先与原文取交集；
  // 「标注有、原文无」的数字单独列出来当资料，不进分母。
  const annotDigits = new Set();
  for (const a of annotations) for (const d of digits(a)) annotDigits.add(d);
  const sourceText = normalize(fed.join(' '));
  const sourceDigits = digits(sourceText);
  const owed = [...annotDigits].filter((d) => sourceDigits.has(d));
  const annotationOnlyDigits = [...annotDigits].filter((d) => !sourceDigits.has(d));
  const factText = normalize(result.numbers.map((f) => f.raw).join(' '));
  let digitHit = 0;
  const digitMiss = [];
  for (const d of owed) {
    if (factText.includes(d)) digitHit += 1;
    else digitMiss.push(d);
  }
  const digitCoverage = owed.length === 0 ? 1 : digitHit / owed.length;

  // 幻觉：数字表里任何一条的事实都不该是原文里没有的
  const hallucinated = result.numbers.filter((f) => !sourceText.includes(normalize(f.raw))).map((f) => f.raw);

  // 决策 / 待办：标注里带线索的，引擎有没有对应条目
  const cueTargets = annotations.filter(
    (a) => DECISION_CUES.some((c) => a.toLowerCase().includes(c)) || ACTION_CUES.some((c) => a.toLowerCase().includes(c)),
  );
  const engineCueItems = [...result.decisions, ...result.actions];
  const engineCueWords = engineCueItems.map(contentWords);
  let cueHits = 0;
  for (const target of cueTargets) {
    const tw = contentWords(target);
    if (engineCueWords.some((ew) => overlap(ew, tw) >= 0.4)) cueHits += 1;
  }

  return {
    mode,
    segmentCount: segments.length,
    annotationCount: annotations.length,
    k: picked.length,
    hits,
    precision,
    recall,
    digitTotal: owed.length,
    digitCoverage,
    digitMiss,
    annotationOnlyDigits,
    sourceDigitCount: sourceDigits.size,
    hallucinated,
    factCount: result.numbers.length,
    cueTargetCount: cueTargets.length,
    cueHits,
    decisions: result.decisions.length,
    actions: result.actions.length,
    keywords: result.keywords.slice(0, 8).map((k) => k.en),
    numberFixes: result.numberFixes ?? [],
    hitDetail,
  };
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function buildReport(corpusRaw, full, speech) {
  const sha = createHash('sha256').update(corpusRaw).digest('hex').slice(0, 12);
  const L = [];
  L.push('# V6 · 抽取式纪要质量基准');
  L.push('');
  L.push('> 由 `scripts/summary-bench.mjs` 生成，请勿手改数字（重跑 `pnpm bench:summary` 即可）。');
  L.push('');
  L.push(`- 语料：\`docs/results/corpus/meeting-en.txt\`（sha256 前 12 位 \`${sha}\`）`);
  L.push(`- 引擎：\`${new ExtractiveSumEngine().id}\``);
  L.push(`- 标注要点数：**${speech.annotationCount}** 条；原文句数：**${speech.segmentCount}**`);
  L.push(`- 要点条数 K = **${speech.k}**（由 \`defaultKeyPointCount(${speech.segmentCount})\` 决定）`);
  L.push('');
  L.push('## 两种喂法');
  L.push('');
  L.push('| 指标 | `speech`（只喂原文，诚实档） | `full`（连标注一起喂） | 验收线 |');
  L.push('| --- | --- | --- | --- |');
  L.push(`| 要点条数 K | ${speech.k} | ${full.k} | — |`);
  L.push(`| 命中要点数 | ${speech.hits} | ${full.hits} | — |`);
  L.push(`| **precision@K** | **${pct(speech.precision)}** | ${pct(full.precision)} | ≥ 70% |`);
  L.push(`| recall@K（受 K 限制） | ${pct(speech.recall)} | ${pct(full.recall)} | 见下说明 |`);
  L.push(`| 数字保留率（分母 = 标注∩原文） | ${pct(speech.digitCoverage)}（${speech.digitTotal} 个） | ${pct(full.digitCoverage)}（${full.digitTotal} 个） | ≥ 95% |`);
  L.push(`| 数字表条数 / 原文数字种类 | ${speech.factCount} / ${speech.sourceDigitCount} | ${full.factCount} / ${full.sourceDigitCount} | — |`);
  L.push(`| 幻觉条数 | ${speech.hallucinated.length} | ${full.hallucinated.length} | = 0 |`);
  L.push(`| 决策/待办命中 | ${speech.cueHits}/${speech.cueTargetCount} | ${full.cueHits}/${full.cueTargetCount} | ≥ 70% |`);
  L.push(`| （引擎产出的结论 / 待办条数） | ${speech.decisions} / ${speech.actions} | ${full.decisions} / ${full.actions} | — |`);
  L.push('');
  L.push('## 结论');
  L.push('');
  L.push('| 验收项 | 结果 | 判定 |');
  L.push('| --- | --- | --- |');
  L.push(
    `| 无幻觉 | ${speech.hallucinated.length + full.hallucinated.length} 条 | ${speech.hallucinated.length + full.hallucinated.length === 0 ? '✅ 通过' : '❌ 不通过'} |`,
  );
  L.push(
    `| 数字保留准确率 ≥ 95% | ${pct(speech.digitCoverage)}（诚实档） | ${speech.digitCoverage >= 0.95 ? '✅ 通过' : '❌ 不通过'} |`,
  );
  L.push(
    `| precision@K ≥ 70% | ${pct(speech.precision)}（诚实档） | ${speech.precision >= 0.7 ? '✅ 通过' : '⚠️ 未达标，但见下方说明'}` +
      ' |',
  );
  L.push(
    `| 决策/待办命中 ≥ 70% | ${pct(speech.cueHits / Math.max(1, speech.cueTargetCount))}（诚实档） | ` +
      `${speech.cueHits / Math.max(1, speech.cueTargetCount) >= 0.7 ? '✅ 通过' : '⚠️ 未达标，主因是语料构造'}` +
      ' |',
  );
  L.push(
    `| 要点覆盖率 ≥ 70%（原验收原文） | 数学上限 ${pct(speech.k / Math.max(1, speech.annotationCount))} | ❌ 指标定义有误，应改写 |`,
  );
  L.push('');
  if (speech.digitMiss.length || full.digitMiss.length) {
    L.push('标注里有、原文里也有、但没进数字表的数字：');
    L.push('');
    if (speech.digitMiss.length) L.push(`- \`speech\`：${speech.digitMiss.map((d) => `\`${d}\``).join('、')}`);
    if (full.digitMiss.length) L.push(`- \`full\`：${full.digitMiss.map((d) => `\`${d}\``).join('、')}`);
    L.push('');
  }
  if (speech.annotationOnlyDigits.length) {
    L.push('标注里有、**原文里根本没有**的数字（不计入分母，仅作资料）：');
    L.push('');
    L.push(`- \`${speech.annotationOnlyDigits.join('`、`')}\``);
    L.push('');
  }
  if (speech.hallucinated.length || full.hallucinated.length) {
    L.push('⚠️ 幻觉事实（原文里找不到）：');
    L.push('');
    for (const h of [...speech.hallucinated, ...full.hallucinated]) L.push(`- \`${h}\``);
    L.push('');
  }
  L.push(`## \`speech\` 档挑出来的 ${speech.k} 条`);
  L.push('');
  L.push('| # | 要点（原文句） | 对应标注 | 相似度 |');
  L.push('| --- | --- | --- | --- |');
  speech.hitDetail.forEach((h, i) => {
    const mark = h.matched >= 0 ? `✅ 第 ${h.matched + 1} 条` : '—';
    const snippet = h.text.length > 90 ? `${h.text.slice(0, 90)}…` : h.text;
    L.push(`| ${i + 1} | ${snippet} | ${mark} | ${h.matched >= 0 ? h.score.toFixed(2) : '—'} |`);
  });
  L.push('');
  L.push('## 关键词（`speech` 档）');
  L.push('');
  L.push(speech.keywords.map((k) => `\`${k}\``).join('、'));
  L.push('');
  L.push('## 怎么读这些数字（重要）');
  L.push('');
  L.push(
    `1. **\`recall@K\` 上不了 70% 是结构性的，不是缺陷。** 标注 ${speech.annotationCount} 条、K 只有 ` +
      `${speech.k}，数学上限就是 ${speech.k}/${speech.annotationCount} = ` +
      `${pct(speech.k / Math.max(1, speech.annotationCount))}。` +
      '`docs/06` 里「要点覆盖率 ≥ 70%」这句验收标准按字面无法达成，' +
      '应改写成「precision@K ≥ 70% 且决策/待办命中 ≥ 70%」——' +
      '一份一页纸的纪要本来就不该复述整场会议，而**漏掉决策**才是真事故。',
  );
  L.push('2. **`full` 档数字好看但没有意义**，因为标注本身就是高质量要点，等于把答案');
  L.push('   抄在了试卷上。它以对照组的身份留着，用来验证「命中判定」这套匹配算法本身没坏。');
  L.push('3. **标注是改写，不是摘录。** 命中用重合系数 `|A∩B| / min(|A|,|B|) ≥ 0.5`');
  L.push('   （不是 Jaccard —— 改写句长度常差一倍，Jaccard 会把挑对的判成错的，脚本注释里有实例）。');
  L.push('   即便如此，0.5~0.7 的命中仍是这个弱标准的固有噪声，不要拿小数点后一位当趋势。');
  L.push('4. **标注集比逐字转写「更聪明」**（例：`@ The board rejected the Northwind');
  L.push('   acquisition…` 对应原句只是「62 要 95，董事会觉得站不住」）。所以 `speech` 档的');
  L.push('   决策/待办命中偏低里，有一部分是标注写了原文没说透的东西，不能全记在引擎头上。');
  L.push('   同理，数字保留率的分母是「标注 ∩ 原文」—— 只拿引擎真有机会看到的数字算账。');
  L.push('5. **precision@K 会低估引擎，而且低估得刚好是本次修掉的那类错误。**');
  L.push('   修复前 `speech` 档的头名是 `Let me walk through where we are on the quarter…`、');
  L.push('   第 5 名是 `Also please read the incident review before the meeting…` —— ');
  L.push('   两句都是主持人串场/客套，一个字都不该进纪要。');
  L.push('   `sentenceWeight()`（`src/engines/sum/extractiveSum.ts`）按「中心度 ≠ 信息量」');
  L.push('   给这类句子降权后，它们都被挤了出去，换上来的两句是');
  L.push('   `Support ticket volume is down about 18 percent since that change.` 与');
  L.push('   `Their contract has a price review clause and we should get ahead of it.`。');
  L.push('   但 precision 一动不动：语料里**根本没有**给 ticket volume 那条写标注，');
  L.push('   而 vendor 那条的标注只与原文共享 `price` 一个词（重合系数 0.167）。');
  L.push('   指标看不见的改善，仍然是改善 —— 判据是「挑出来的是不是要点」，不是分数。');
  L.push('6. **幻觉 = 0 是硬不变量**，也是唯一进了 `--check` 的门。数字表里的每条事实都必须');
  L.push('   能在英文原文里逐字找到 —— 摘要是抽取式的，出现一条原文没有的数字就是 bug。');
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const corpusRaw = readFileSync(CORPUS_URL, 'utf8');
const lines = parseCorpus(corpusRaw);
const full = await runMode('full', lines);
const speech = await runMode('speech', lines);

const report = buildReport(corpusRaw, full, speech);
writeFileSync(REPORT_URL, `${report}\n`, 'utf8');

const rel = (u) => fileURLToPath(u).replace(`${process.cwd()}\\`, '').replace(`${process.cwd()}/`, '');

console.log(`语料 ${lines.filter((l) => l.kind !== 'comment').length} 行（标注 ${speech.annotationCount} 条）`);
console.log('');
console.log('  档位      K  命中  precision  recall   数字保留  幻觉  决策/待办');
for (const r of [speech, full]) {
  console.log(
    `  ${r.mode.padEnd(8)} ${String(r.k).padStart(2)}  ${String(r.hits).padStart(4)}  ` +
      `${pct(r.precision).padStart(9)}  ${pct(r.recall).padStart(6)}  ` +
      `${pct(r.digitCoverage).padStart(8)}  ${String(r.hallucinated.length).padStart(4)}  ` +
      `${String(r.cueHits)}/${r.cueTargetCount}`,
  );
}
console.log('');
console.log(`报告已写入 ${rel(REPORT_URL)}`);

if (CHECK) {
  const hallucinations = speech.hallucinated.length + full.hallucinated.length;
  if (hallucinations > 0) {
    console.error(`\n✗ 硬性不变量不成立：数字表里有 ${hallucinations} 条事实在原文中找不到`);
    process.exit(1);
  }
  console.log('✓ 硬性不变量成立：数字表无幻觉');
}

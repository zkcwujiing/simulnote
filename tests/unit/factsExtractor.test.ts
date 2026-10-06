/**
 * `factsExtractor` 的单测（设计文档 06 §6.5 第 6 步明确要求）。
 *
 * 重点盯住**英中进位错位**这一类错误：英文 `4.8 million` 是 4,800,000，
 * 中文要写「480万」；写成「4.8万」就差 100 倍。这类错误在真机报告里
 * 出现过（`docs/results/V2V4-Xiaomi-tablet.md` 数字 5 处对 1 错 4），
 * 而且**看起来完全像对的**，只有单测能拦住。
 *
 * 这些断言全部只依赖 `src/engines/sum/facts.ts` 与 `src/lib/numberZh.ts`，
 * 不加载任何模型、不联网。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { extractFacts } from '@/engines/sum/facts';

/** 取出第一条 raw 含 `needle` 的事实的中文译法。 */
function zhFor(text: string, needle: string): string {
  const facts = extractFacts([text]);
  const hit = facts.find((f) => f.raw.toLowerCase().includes(needle.toLowerCase()));
  assert.ok(hit, `没能从「${text}」里抽出含「${needle}」的事实；实际抽到：${facts.map((f) => f.raw).join(' | ')}`);
  return hit.zh;
}

test('百万级金额：英文 million 必须先乘 1e6 再按中文进位写', () => {
  assert.equal(zhFor('The contract is worth 4.8 million dollars.', 'million'), '480万美元');
});

test('缩写金额：$4.8M 与 $4.8 million 等价', () => {
  assert.equal(zhFor('We booked $4.8M in revenue.', '4.8m'), '480万美元');
});

test('十亿级金额：3 billion 是 30 亿，不是 3 亿', () => {
  assert.equal(zhFor('The market is worth 3 billion dollars.', 'billion'), '30亿美元');
});

test('百分比：about 60 percent → 60%', () => {
  assert.equal(zhFor('About 60 percent of the test group churned.', '60'), '60%');
});

test('百分比带百分号：12%', () => {
  assert.equal(zhFor('Latency dropped by 12%.', '12'), '12%');
});

test('时长：毫秒级不能被吞掉', () => {
  assert.equal(zhFor('Each request took 820 milliseconds.', 'milliseconds'), '820毫秒');
});

test('时长：分钟级', () => {
  assert.equal(zhFor('The call lasted 45 minutes.', 'minutes'), '45分钟');
});

test('日期：年-月-日整条抽出，且年份不能丢', () => {
  const zh = zhFor('The deal closes on March 15, 2026.', 'march');
  assert.ok(zh.includes('2026'), `日期里必须带年份，实际是「${zh}」`);
  assert.ok(zh.includes('3') && zh.includes('15'), `日期里必须带月和日，实际是「${zh}」`);
});

test('专有名词被单独抽出（不经翻译链路）', () => {
  const facts = extractFacts(['We migrated the service to PostgreSQL last quarter.']);
  assert.ok(
    facts.some((f) => f.raw.toLowerCase().includes('postgresql')),
    `PostgreSQL 应当作为事实被抽出；实际：${facts.map((f) => f.raw).join(' | ')}`,
  );
});

test('单词专名（无内部大写）也要抽出来', () => {
  // 技术会议里最需要保真的恰恰是这一类，译文里它们最容易被直译坏。
  const facts = extractFacts(['The team adopted Kubernetes and Kafka in Q3.']);
  const names = facts.filter((f) => f.kind === 'proper').map((f) => f.raw);
  assert.ok(names.includes('Kubernetes'), `实际专名：${names.join(' | ')}`);
  assert.ok(names.includes('Kafka'), `实际专名：${names.join(' | ')}`);
});

test('句首的大写普通词不会被当成专名', () => {
  const facts = extractFacts([
    'Revenue grew 20 percent. Growth of 20 percent is strong. Costs stayed flat.',
  ]);
  const names = facts.filter((f) => f.kind === 'proper').map((f) => f.raw);
  assert.deepEqual(names, [], `句首大写词被误判成专名：${names.join(' | ')}`);
});

test('多词专名整体抽出，不会被拆成两个单词', () => {
  const facts = extractFacts(['We deployed Project Atlas on Google Cloud last week.']);
  const names = facts.filter((f) => f.kind === 'proper').map((f) => f.raw);
  assert.ok(names.includes('Project Atlas'), `实际专名：${names.join(' | ')}`);
  assert.ok(names.includes('Google Cloud'), `实际专名：${names.join(' | ')}`);
});

test('专名带着它出现的原句作为出处', () => {
  const facts = extractFacts(['We migrated the service to PostgreSQL last quarter.']);
  const pg = facts.find((f) => f.raw.toLowerCase().includes('postgresql'));
  assert.ok(pg);
  assert.ok(pg.context.toLowerCase().includes('postgresql'), `出处应当是原句，实际「${pg.context}」`);
  assert.equal(pg.segIndex, 0);
});

test('纯铺垫句不产生任何事实（不制造幻觉）', () => {
  assert.deepEqual(extractFacts(['So, um, let me think about that for a second.']), []);
});

test('同一数字在不同句子里各留一条，且各自带自己的出处', () => {
  // 刻意不去重：数字对照表要的是「原文 | 中文 | 出处」，
  // 把两处出现合并成一条会让用户没法核对它到底出现在哪句。
  const facts = extractFacts(['Revenue grew 20 percent. Growth of 20 percent is strong.']);
  const percent = facts.filter((f) => f.zh === '20%');
  assert.equal(percent.length, 2, `两处出现应当各留一条，实际 ${percent.length} 条`);
  assert.notEqual(percent[0].context, percent[1].context, '两条的出处必须能区分开');
});

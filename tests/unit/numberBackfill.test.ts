/**
 * 数字回填的单测。
 *
 * 回填是这个项目里**唯一会改写译文**的地方，所以它的验收标准和别处不同：
 * 不是「改得多」，而是「不该改的一个字都不改」。
 * 下面每条「不动手」的用例，都比「动手」的用例更重要。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { backfillNumbers, describeBackfill } from '@/engines/sum/backfill';

test('真机样本：模型吐出来的 __ 占位符被填回真值', () => {
  const r = backfillNumbers('About 60% of the test group churned.', '大约 __ 个测试组流失了。');
  assert.equal(r.text, '大约 60% 个测试组流失了。');
  assert.equal(r.edits.length, 1);
  assert.equal(r.edits[0].reason, 'placeholder');
  assert.equal(r.edits[0].to, '60%');
});

test('多个占位符按英文原文顺序依次回填', () => {
  const r = backfillNumbers(
    'Revenue rose 23 percent and churn fell to 4 percent.',
    '营收增长 __，流失率降到 __。',
  );
  assert.equal(r.text, '营收增长 23%，流失率降到 4%。');
  assert.deepEqual(
    r.edits.map((e) => e.to),
    ['23%', '4%'],
  );
});

test('没有占位符时只报告缺失，绝不猜位置硬塞', () => {
  const r = backfillNumbers('Revenue rose 23 percent.', '营收有所增长。');
  assert.equal(r.text, '营收有所增长。');
  assert.deepEqual(r.edits, []);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].zh, '23%');
});

test('译文里已经有正确的数字时，一个字都不改', () => {
  const r = backfillNumbers('We booked $4.8M in revenue.', '我们录得480万美元营收。');
  assert.equal(r.text, '我们录得480万美元营收。');
  assert.deepEqual(r.edits, []);
  assert.deepEqual(r.missing, []);
});

test('译文里的数字写错了，也不擅自改（报告交给数字对照表）', () => {
  // 480万美元 写成了 4.8万美元 —— 差 100 倍，是真实出现过的错法。
  const r = backfillNumbers('We booked $4.8M in revenue.', '我们录得4.8万美元营收。');
  assert.equal(r.text, '我们录得4.8万美元营收。');
  assert.deepEqual(r.edits, []);
});

test('折叠重复日期：真机样本 March 15, 2026 → 3月15日,2026年3月15日', () => {
  const r = backfillNumbers('The deal closed on March 15, 2026.', '交易在3月15日,2026年3月15日完成。');
  assert.equal(r.text, '交易在2026年3月15日完成。');
  assert.equal(r.edits.length, 1);
  assert.equal(r.edits[0].reason, 'duplicate-date');
});

test('两个不同的日期并排出现时不动手', () => {
  const r = backfillNumbers(
    'Kickoff was March 15, 2026 and launch is April 2, 2026.',
    '启动是3月15日，上线是4月2日。',
  );
  assert.equal(r.text, '启动是3月15日，上线是4月2日。');
  assert.deepEqual(r.edits, []);
});

test('纯数字并列（没有日期）不动手', () => {
  const r = backfillNumbers('Latency dropped to 820 milliseconds from 1400 milliseconds.', '延迟从1400毫秒降到820毫秒。');
  assert.equal(r.text, '延迟从1400毫秒降到820毫秒。');
  assert.deepEqual(r.edits, []);
});

test('空输入原样返回，不抛异常', () => {
  assert.deepEqual(backfillNumbers('', '你好').edits, []);
  assert.equal(backfillNumbers('', '你好').text, '你好');
  assert.equal(backfillNumbers('Hello number 3.', '').text, '');
});

test('describeBackfill 把改动摊开成人话', () => {
  const r = backfillNumbers('About 60% churned.', '大约 __ 流失了。');
  const line = describeBackfill(r.edits, r.missing);
  assert.ok(line && line.includes('补回 1 处'), `实际：${line}`);
});

test('describeBackfill 在无事可报时返回 null', () => {
  const r = backfillNumbers('We booked $4.8M in revenue.', '我们录得480万美元营收。');
  assert.equal(describeBackfill(r.edits, r.missing), null);
});

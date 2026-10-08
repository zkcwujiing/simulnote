/**
 * 「丢句告警」的判定逻辑。
 *
 * 这个模块的病根在旧设计里已经写清楚了（见 `src/lib/session/quality.ts` 的文件头）：
 * 拿 `transcriptDurationMs / audioDurationMs` 当丢句证据是错的 ——
 * 会议里大部分时间本来就没人说话。所以这里的测试**围绕这个区别**来写：
 * 一组是「沉默很多但一句没丢」（必须判 ok），另一组是「沉默不多但引擎吞了音频」
 * （必须判 lost）。这两组读数在旧设计下会给出同一个结论，这正是它坏掉的地方。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOSS_LOST_RATIO,
  LOSS_MIN_SPEECH_MS,
  LOSS_SUSPECT_RATIO,
  describeMicPickup,
  detectTranscriptLoss,
} from '@/lib/session/quality';
import type { SessionStats } from '@/types';

function stats(patch: Partial<SessionStats> = {}): SessionStats {
  return {
    startedAt: 0,
    endedAt: null,
    finalCount: 0,
    audioDurationMs: 0,
    speechDurationMs: 0,
    transcriptDurationMs: 0,
    meanLatencyMs: 0,
    degradedCount: 0,
    ...patch,
  };
}

test('没有统计信息时不猜，返回 null', () => {
  assert.equal(detectTranscriptLoss(null), null);
  assert.equal(detectTranscriptLoss(undefined), null);
});

test('送进识别的语音太少时不判，而不是硬给一个「正常」', () => {
  // 一句话的会话里，一句没识别出来就是 0%，但那是正常波动，不是故障。
  const verdict = detectTranscriptLoss(
    stats({ speechDurationMs: LOSS_MIN_SPEECH_MS - 1, transcriptDurationMs: 0 }),
  );
  assert.equal(verdict, null);
});

test('刚好跨过最小样本量就开始判', () => {
  const verdict = detectTranscriptLoss(
    stats({ speechDurationMs: LOSS_MIN_SPEECH_MS, transcriptDurationMs: LOSS_MIN_SPEECH_MS }),
  );
  assert.equal(verdict?.level, 'ok');
});

test('沉默很多但一句没丢 —— 这是旧设计会误报的那种会话', () => {
  // 30 分钟录音，其中只有 6 分钟有人说话，6 分钟全部识别出来了。
  // 旧设计会算出 6/30 = 20%，然后报「严重丢句」。
  const verdict = detectTranscriptLoss(
    stats({
      audioDurationMs: 30 * 60_000,
      speechDurationMs: 6 * 60_000,
      transcriptDurationMs: 6 * 60_000,
    }),
  );
  assert.equal(verdict?.level, 'ok');
  assert.equal(verdict?.ratio, 1);
});

test('整段吞掉：送检 10 分钟只回来 5 分钟，判 lost 并说清是引擎跟不上', () => {
  const verdict = detectTranscriptLoss(
    stats({ speechDurationMs: 10 * 60_000, transcriptDurationMs: 5 * 60_000 }),
  );
  assert.equal(verdict?.level, 'lost');
  assert.equal(verdict?.ratio, 0.5);
  // 措辞要指向「引擎跟不上实时速度」，因为那才是用户下次能改的东西。
  assert.match(verdict?.message ?? '', /跟不上/);
  assert.match(verdict?.message ?? '', /10\.0 分钟/);
  assert.match(verdict?.message ?? '', /5\.0 分钟/);
});

test('只丢了一点：判 suspect，措辞指向麦克风被占用而不是引擎太慢', () => {
  const verdict = detectTranscriptLoss(
    stats({ speechDurationMs: 10 * 60_000, transcriptDurationMs: 7 * 60_000 }),
  );
  assert.equal(verdict?.level, 'suspect');
  assert.equal(verdict?.ratio, 0.7);
  assert.match(verdict?.message ?? '', /麦克风/);
});

test('两个阈值都是「大于等于」：边界值落在更宽松的那一档', () => {
  const ok = detectTranscriptLoss(
    stats({ speechDurationMs: 100_000, transcriptDurationMs: 100_000 * LOSS_SUSPECT_RATIO }),
  );
  assert.equal(ok?.level, 'ok');

  // 恰好丢了一半判 lost（「丢了一半或更多」读起来就是这个意思）；
  // 只丢一点点的边界值落在 suspect。
  const suspect = detectTranscriptLoss(
    stats({ speechDurationMs: 100_000, transcriptDurationMs: 100_000 * (LOSS_LOST_RATIO + 0.05) }),
  );
  assert.equal(suspect?.level, 'suspect');

  const lost = detectTranscriptLoss(
    stats({ speechDurationMs: 100_000, transcriptDurationMs: 100_000 * LOSS_LOST_RATIO }),
  );
  assert.equal(lost?.level, 'lost');
});

test('一句都没回来：ratio 为 0 而不是 NaN 或负数', () => {
  const verdict = detectTranscriptLoss(
    stats({ speechDurationMs: 5 * 60_000, transcriptDurationMs: 0 }),
  );
  assert.equal(verdict?.level, 'lost');
  assert.equal(verdict?.ratio, 0);
});

test('脏数据（负数、超发）不会算出越界的比例', () => {
  const negative = detectTranscriptLoss(
    stats({ speechDurationMs: 60_000, transcriptDurationMs: -5_000 }),
  );
  assert.equal(negative?.ratio, 0);

  // 引擎不可能交回比送进去更多的语音；真出现了也不该让比例超过 1 而被当成「异常好」。
  const over = detectTranscriptLoss(
    stats({ speechDurationMs: 60_000, transcriptDurationMs: 90_000 }),
  );
  assert.equal(over?.level, 'ok');
  assert.ok((over?.ratio ?? 0) > 1);
});

test('麦克风拾音：录音太短就不提，免得刚点开始就报一句', () => {
  assert.equal(
    describeMicPickup(stats({ audioDurationMs: LOSS_MIN_SPEECH_MS - 1, speechDurationMs: 0 })),
    null,
  );
});

test('麦克风拾音：五分之一以上是说话声就不提', () => {
  assert.equal(
    describeMicPickup(stats({ audioDurationMs: 10 * 60_000, speechDurationMs: 2 * 60_000 })),
    null,
  );
});

test('麦克风拾音：基本没听见人说话时，建议指向设备而不是「丢句」', () => {
  // 10 分钟录音里只有 12 秒说话声 —— 设备放太远、被静音，或者选错了输入设备。
  const message = describeMicPickup(
    stats({ audioDurationMs: 10 * 60_000, speechDurationMs: 12_000 }),
  );
  assert.match(message ?? '', /麦克风/);
  assert.doesNotMatch(message ?? '', /丢句|丢失|跟不上/);
});

test('麦克风拾音：完全没有说话声也要给得出建议，而不是 null', () => {
  const message = describeMicPickup(stats({ audioDurationMs: 10 * 60_000, speechDurationMs: 0 }));
  assert.match(message ?? '', /0 秒/);
});

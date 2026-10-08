/**
 * M2「锁屏中断恢复 + 长时间会话内存回收」的单测。
 *
 * 这里全部是**纯逻辑**：不碰 DOM、不碰真实存储、不加载任何模型。
 * 之所以能这样，是因为三个新模块都把宿主环境做成了注入参数
 * （`LifecycleHost` / `DraftStorage` / `MemoryScopeLike`）——
 * 中断恢复这种东西在真机上极难复现（要真的锁屏、真的切后台、真的被系统杀掉），
 * 所以判断逻辑必须能脱离浏览器被测到。
 *
 * 盯住的三类错误：
 *   1. 离开时长算错（把一次中断算成两次、或漏算）→ 用户被告知错误的丢失时长；
 *   2. 留痕解析太宽松（半截 JSON 也当成可用）→ 恢复出一份缺字的转写；
 *   3. 堆读数被当成真实内存压力 → 在设备其实很宽裕时卸掉模型。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LifecycleTracker,
  classifyInterruption,
  watchLifecycle,
  NOTICEABLE_HIDDEN_MS,
  type LifecycleHost,
} from '@/lib/session/lifecycle';
import {
  DRAFT_MAX_SEGMENTS,
  DRAFT_TTL_MS,
  buildDraft,
  clearDraft,
  describeDraft,
  loadDraft,
  needsSummary,
  parseDraft,
  saveDraft,
  type DraftStorage,
  type SessionDraft,
} from '@/lib/session/draft';
import { describeHeap, heapLevel, heapTrend, readHeap } from '@/lib/session/memory';
import { captureHealthOf } from '@/lib/audio/capture';

// ---------------------------------------------------------------------------
// 假的宿主环境
// ---------------------------------------------------------------------------

function makeHost(initialVisibility = 'visible') {
  let visibility = initialVisibility;
  const map = new Map<string, Set<() => void>>();
  const host: LifecycleHost = {
    get visibilityState() {
      return visibility;
    },
    addEventListener(type: string, listener: () => void) {
      let set = map.get(type);
      if (!set) {
        set = new Set();
        map.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      map.get(type)?.delete(listener);
    },
  };
  return {
    host,
    setVisibility(next: string) {
      visibility = next;
    },
    fire(type: string) {
      for (const listener of [...(map.get(type) ?? [])]) listener();
    },
    listenerCount(type: string) {
      return map.get(type)?.size ?? 0;
    },
  };
}

function makeStorage(): DraftStorage & { size(): number } {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    size: () => data.size,
  };
}

function segment(id: string, text: string, startMs: number) {
  return { id, text, startMs, endMs: startMs + 1000 };
}

// ---------------------------------------------------------------------------
// 生命周期追踪
// ---------------------------------------------------------------------------

test('离开前台再回来：时长与次数都算对', () => {
  let clock = 1_000_000;
  const tracker = new LifecycleTracker(() => clock);

  assert.equal(tracker.markHidden(), true);
  assert.equal(tracker.markHidden(), false, '重复 markHidden 不该被算成两次中断');

  clock += 45_000;
  assert.equal(tracker.hiddenMs(), 45_000);

  const resumed = tracker.markVisible();
  assert.equal(resumed, 45_000);
  assert.equal(tracker.snapshot.hiddenTotalMs, 45_000);
  assert.equal(tracker.snapshot.hiddenCount, 1);
  assert.equal(tracker.hiddenMs(), 0);
  assert.equal(tracker.markVisible(), null, '本来就在前台时不该报告一次「回来」');
});

test('从 visible 直接被冻结：只算一次中断', () => {
  let clock = 2_000_000;
  const tracker = new LifecycleTracker(() => clock);

  assert.equal(tracker.markFrozen(), true);
  assert.equal(tracker.markFrozen(), false);
  assert.equal(tracker.snapshot.phase, 'frozen');
  assert.equal(tracker.snapshot.hiddenCount, 1);

  clock += 10_000;
  assert.equal(tracker.markVisible(), 10_000);
});

test('多次离开：累计时长是各次之和', () => {
  let clock = 0;
  const tracker = new LifecycleTracker(() => clock);

  tracker.markHidden();
  clock += 5_000;
  tracker.markVisible();
  tracker.markHidden();
  clock += 7_000;
  tracker.markVisible();

  assert.equal(tracker.snapshot.hiddenCount, 2);
  assert.equal(tracker.snapshot.hiddenTotalMs, 12_000);
});

test('中断分级：30 秒是「要显式恢复」的分界线', () => {
  assert.equal(classifyInterruption({ hiddenDurationMs: 0, audioAlive: null }), 'none');
  assert.equal(classifyInterruption({ hiddenDurationMs: 1, audioAlive: true }), 'paused');
  assert.equal(
    classifyInterruption({ hiddenDurationMs: NOTICEABLE_HIDDEN_MS - 1, audioAlive: true }),
    'paused',
  );
  assert.equal(
    classifyInterruption({ hiddenDurationMs: NOTICEABLE_HIDDEN_MS, audioAlive: true }),
    'needs-resume',
  );
  // 采集已经死了的话，离开多久都不重要 —— 只能重挂麦克风。
  assert.equal(classifyInterruption({ hiddenDurationMs: 1, audioAlive: false }), 'audio-lost');
  assert.equal(
    classifyInterruption({ hiddenDurationMs: 999_999, audioAlive: false }),
    'audio-lost',
  );
});

test('watchLifecycle：接到真实事件上，并在取消订阅后摘干净', () => {
  let clock = 100;
  const tracker = new LifecycleTracker(() => clock);
  const fake = makeHost('visible');
  const seen: { phase: string; resumed: number | null }[] = [];

  const stop = watchLifecycle(
    tracker,
    (snapshot, resumedAfterMs) => seen.push({ phase: snapshot.phase, resumed: resumedAfterMs }),
    fake.host,
    fake.host,
  );

  fake.setVisibility('hidden');
  fake.fire('visibilitychange');
  clock += 1_500;
  fake.setVisibility('visible');
  fake.fire('visibilitychange');

  assert.deepEqual(seen, [
    { phase: 'hidden', resumed: null },
    { phase: 'visible', resumed: 1_500 },
  ]);

  // bfcache 的 pageshow / pagehide 也要接上（iOS Safari 恢复走这条路）
  clock += 10;
  fake.fire('pagehide');
  clock += 2_000;
  fake.fire('pageshow');
  assert.equal(tracker.snapshot.hiddenCount, 2);
  assert.equal(tracker.snapshot.hiddenTotalMs, 3_500);

  stop();
  for (const type of ['visibilitychange', 'freeze', 'resume', 'pagehide', 'pageshow']) {
    assert.equal(fake.listenerCount(type), 0, `${type} 的监听没摘干净`);
  }
});

// ---------------------------------------------------------------------------
// 会话留痕
// ---------------------------------------------------------------------------

test('留痕：只保留已定稿的句子，并丢掉没有对应句子的译文', () => {
  const draft = buildDraft({
    startedAt: 1,
    status: 'running',
    audioDurationMs: 12_345,
    degradedCount: 2,
    segments: [segment('a', 'hello', 0), segment('b', 'world', 1000)],
    translations: { a: '你好', b: '世界', c: '孤儿译文' },
    now: 999,
  });

  assert.deepEqual(Object.keys(draft.translations).sort(), ['a', 'b']);
  assert.equal(draft.updatedAt, 999);
  assert.equal(draft.v, 1);
});

test('留痕：超过上限时保留**最近的**句子，而不是最早的', () => {
  const segments = Array.from({ length: DRAFT_MAX_SEGMENTS + 7 }, (_, i) =>
    segment(`s${i}`, `line ${i}`, i * 1000),
  );
  const draft = buildDraft({
    startedAt: 0,
    status: 'running',
    audioDurationMs: 0,
    degradedCount: 0,
    segments,
    translations: {},
  });

  assert.equal(draft.segments.length, DRAFT_MAX_SEGMENTS);
  assert.equal(draft.segments[draft.segments.length - 1].id, `s${DRAFT_MAX_SEGMENTS + 6}`);
  assert.equal(draft.segments[0].id, 's7');
});

test('留痕解析：任何一种残缺都整体作废，不做半截修复', () => {
  const good = JSON.stringify(
    buildDraft({
      startedAt: 1,
      status: 'running',
      audioDurationMs: 0,
      degradedCount: 0,
      segments: [segment('a', 'hello', 0)],
      translations: { a: '你好' },
      now: Date.now(),
    }),
  );

  assert.ok(parseDraft(good), '正常草稿应该能解析');
  assert.equal(parseDraft(null), null, '没有草稿');
  assert.equal(parseDraft('{ 不是 json'), null, '坏 JSON');
  assert.equal(parseDraft('[]'), null, '数组不是草稿');
  assert.equal(parseDraft(JSON.stringify({ v: 2, startedAt: 1, updatedAt: 1 })), null, '版本不匹配');
  assert.equal(
    parseDraft(JSON.stringify({ v: 1, startedAt: 1, updatedAt: 1, segments: [], translations: {} })),
    null,
    '一句都没有的草稿没有恢复价值',
  );
  assert.equal(
    parseDraft(
      JSON.stringify({
        v: 1,
        startedAt: 1,
        updatedAt: 1,
        segments: [{ id: 'a', text: 'x', startMs: 'not a number', endMs: 1 }],
        translations: {},
      }),
    ),
    null,
    'startMs 类型不对',
  );
  assert.equal(
    parseDraft(
      JSON.stringify({
        v: 1,
        startedAt: 1,
        updatedAt: 1,
        segments: [{ id: 'a', text: 'x', startMs: 0, endMs: 1 }],
        translations: { a: 42 },
      }),
    ),
    null,
    '译文不是字符串',
  );
});

test('留痕过期：放太久就不再提供恢复', () => {
  const now = 1_700_000_000_000;
  const draft: SessionDraft = buildDraft({
    startedAt: now - 1000,
    status: 'running',
    audioDurationMs: 0,
    degradedCount: 0,
    segments: [segment('a', 'hello', 0)],
    translations: {},
    now,
  });

  assert.ok(parseDraft(JSON.stringify(draft), now + DRAFT_TTL_MS - 1), '刚好没过期');
  assert.equal(parseDraft(JSON.stringify(draft), now + DRAFT_TTL_MS + 1), null, '过期了');
});

test('留痕：跑完的会话不再打扰用户', () => {
  const base = {
    startedAt: 1,
    audioDurationMs: 0,
    degradedCount: 0,
    segments: [segment('a', 'hello', 0)],
    translations: { a: '你好' },
    now: 1_700_000_000_000,
  };
  assert.equal(needsSummary(buildDraft({ ...base, status: 'done' })), false);
  assert.equal(needsSummary(buildDraft({ ...base, status: 'running' })), true);
  assert.equal(needsSummary(buildDraft({ ...base, status: 'error' })), true);
});

test('留痕：给用户的那句话要说清「多少句」和「多久以前」', () => {
  const now = 1_700_000_000_000;
  const draft = buildDraft({
    startedAt: now,
    status: 'running',
    audioDurationMs: 0,
    degradedCount: 0,
    segments: [segment('a', 'hello', 0), segment('b', 'world', 1000)],
    translations: { a: '你好' },
    now: now - 5 * 60_000,
  });

  const text = describeDraft(draft, now);
  assert.ok(text, '应该给出一句提示');
  assert.match(text, /5 分钟前/);
  assert.match(text, /2 句原文/);
  assert.match(text, /1 句译文/);
  assert.equal(describeDraft(null), null);
});

test('留痕读写：存储不可用时静默失败，不影响会话', () => {
  const storage = makeStorage();
  const draft = buildDraft({
    startedAt: 1,
    status: 'running',
    audioDurationMs: 0,
    degradedCount: 0,
    segments: [segment('a', 'hello', 0)],
    translations: {},
    now: Date.now(),
  });

  assert.equal(saveDraft(draft, storage), true);
  assert.ok(loadDraft(storage));
  clearDraft(storage);
  assert.equal(loadDraft(storage), null);
  assert.equal(storage.size(), 0);

  // storage 为 null（隐私模式）时不该抛
  assert.equal(saveDraft(draft, null), false);
  assert.equal(loadDraft(null), null);
  clearDraft(null);

  // 配额爆掉（setItem 抛异常）也要静默
  const full: DraftStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => undefined,
  };
  assert.equal(saveDraft(draft, full), false);
});

// ---------------------------------------------------------------------------
// 内存守卫
// ---------------------------------------------------------------------------

test('堆读数不可信时返回 null，而不是拿 0 冒充', () => {
  assert.equal(readHeap({}), null, '没有 performance.memory');
  assert.equal(readHeap({ memory: {} }), null, '字段缺失');
  assert.equal(readHeap({ memory: { usedJSHeapSize: 1, jsHeapSizeLimit: 0 } }), null, 'limit 为 0');
  assert.equal(
    readHeap({ memory: { usedJSHeapSize: Number.NaN, jsHeapSizeLimit: 100 } }),
    null,
    'NaN',
  );

  const reading = readHeap({ memory: { usedJSHeapSize: 512 * 1024 * 1024, jsHeapSizeLimit: 1024 * 1024 * 1024 } });
  assert.ok(reading);
  assert.equal(Math.round(reading.usedMb), 512);
  assert.equal(reading.ratio, 0.5);
});

test('堆分级：used > limit 在 Chromium 上是正常的，不该被判成异常', () => {
  // 小米平板的实测形状：used ≈ 3585 MB，limit ≈ 1077 MB
  const absurd = { usedMb: 3585, limitMb: 1077, ratio: 3585 / 1077 };
  assert.equal(heapLevel(absurd), 'high');
  assert.match(describeHeap(absurd), /不代表.*真实内存压力/, '必须提醒这个数字没有参考价值');

  assert.equal(heapLevel(null), 'unknown');
  assert.equal(heapLevel({ usedMb: 100, limitMb: 1000, ratio: 0.1 }), 'ok');
  assert.equal(heapLevel({ usedMb: 750, limitMb: 1000, ratio: 0.75 }), 'watch');
  assert.equal(heapLevel({ usedMb: 900, limitMb: 1000, ratio: 0.9 }), 'high');
  assert.match(describeHeap(null), /不暴露 performance\.memory/);
});

test('堆趋势：只有真的涨了才算涨，GC 抖动不算', () => {
  const at = (usedMb: number) => ({ usedMb, limitMb: 1000, ratio: usedMb / 1000 });

  assert.equal(heapTrend(null, at(500)), 'unknown');
  assert.equal(heapTrend(at(500), null), 'unknown');
  assert.equal(heapTrend(at(500), at(503)), 'flat', '3 MB 是 GC 抖动');
  assert.equal(heapTrend(at(500), at(520)), 'rising');
  assert.equal(heapTrend(at(500), at(400)), 'flat', '降下来当然不算涨');
});

// ---------------------------------------------------------------------------
// 采集健康判定
// ---------------------------------------------------------------------------

test('采集健康：四档各自对应一种处置方式', () => {
  const live = captureHealthOf('running', 'live', false);
  assert.equal(live.state, 'live');
  assert.equal(live.live, true);

  const suspended = captureHealthOf('suspended', 'live', false);
  assert.equal(suspended.state, 'suspended');
  assert.equal(suspended.live, false);
  assert.match(suspended.reason, /挂起/);

  // Safari 从锁屏回来会给 'interrupted'
  assert.equal(captureHealthOf('interrupted', 'live', false).state, 'suspended');

  const ended = captureHealthOf('running', 'ended', false);
  assert.equal(ended.state, 'ended');
  assert.equal(ended.live, false);
  assert.match(ended.reason, /回收/);

  const closed = captureHealthOf('closed', 'ended', true);
  assert.equal(closed.state, 'closed');
  assert.equal(closed.live, false);

  // 主动 stop 过的话，即使上下文状态还没更新也该报 closed
  assert.equal(captureHealthOf('running', 'live', true).state, 'closed');
});

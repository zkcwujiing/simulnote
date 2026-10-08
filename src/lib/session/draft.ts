/**
 * 会话留痕 —— M2「锁屏中断恢复」的兜底层。
 *
 * 分工要摆清楚，否则很容易做错东西：
 *
 *   生命周期追踪（`lifecycle.ts`）负责发现「我离开过前台」；
 *   采集健康探测（`capture.ts` 的 `health()`）负责判断「麦克风还活着吗」；
 *   **这个文件负责的是第三种情况：标签页被系统直接杀掉了，前两者都没机会运行。**
 *
 * 手机浏览器在后台内存吃紧时会把整个标签页丢掉 —— 没有 error、没有 beforeunload。
 * 唯一能对抗它的只有「定期把已经定稿的内容写出去」。所以这里每定稿一句就写一次
 * （节流在调用方，见 `sessionStore.ts`）。
 *
 * ## 为什么是 sessionStorage 而不是 localStorage
 *
 * 这是本项目里一条**明确划出的边界**，不是随手选的：
 *
 *   - `sessionStorage` 的生命周期是**这个标签页**：刷新、锁屏、切后台、bfcache
 *     恢复都在，关掉标签页就没了。它正好对应「这次没做完的会话」。
 *   - `localStorage` 会跨标签页、跨会话活着，那就变成了「历史记录」。而
 *     **F10「历史记录本地留存」需求方已经登记为「最后一步再说」**（见
 *     `docs/06-开发路线图与里程碑.md` §6.8），没有发话之前不该偷偷做出来。
 *
 * 换句话说：如果你想把这里的 `sessionStorage` 换成 `localStorage`，那你做的
 * 其实是 F10，不是 M2 —— 先去问需求方。
 */

import type { FinalSegment, SessionStatus } from '@/types';

export const DRAFT_KEY = 'simulnote.draft.v1';
/** 一份草稿最多留多少句。一小时的会约 800~1200 句，4000 是安全上限。 */
export const DRAFT_MAX_SEGMENTS = 4000;
/** 超过这个时长的草稿不再提供恢复（放了一天多半是忘了，恢复反而添乱）。 */
export const DRAFT_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionDraft {
  /** 格式版本。改了结构就 +1，旧草稿会被当作不合法丢掉。 */
  v: 1;
  startedAt: number;
  updatedAt: number;
  status: SessionStatus;
  /** 已处理的音频总时长，恢复后用来还原统计数字 */
  audioDurationMs: number;
  degradedCount: number;
  segments: FinalSegment[];
  translations: Record<string, string>;
}

/** 只用到这三个方法，单测里塞一个 Map 就能当存储。 */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DraftInput {
  startedAt: number;
  status: SessionStatus;
  audioDurationMs: number;
  degradedCount: number;
  segments: FinalSegment[];
  translations: Record<string, string>;
  now?: number;
}

/**
 * 组装一份草稿。**只保留已经定稿的句子** —— 半截的 partial 写出去，
 * 恢复时反而会让人误以为当时听到了那些话。
 */
export function buildDraft(input: DraftInput): SessionDraft {
  const now = input.now ?? Date.now();
  const segments =
    input.segments.length > DRAFT_MAX_SEGMENTS
      ? input.segments.slice(input.segments.length - DRAFT_MAX_SEGMENTS)
      : input.segments;

  // 只留下仍在 segments 里的译文，避免草稿越写越大
  const alive = new Set(segments.map((s) => s.id));
  const translations: Record<string, string> = {};
  for (const [id, text] of Object.entries(input.translations)) {
    if (alive.has(id)) translations[id] = text;
  }

  return {
    v: 1,
    startedAt: input.startedAt,
    updatedAt: now,
    status: input.status,
    audioDurationMs: input.audioDurationMs,
    degradedCount: input.degradedCount,
    segments,
    translations,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSegments(value: unknown): FinalSegment[] | null {
  if (!Array.isArray(value)) return null;
  const out: FinalSegment[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { id, text, startMs, endMs } = item;
    if (typeof id !== 'string' || typeof text !== 'string') return null;
    if (typeof startMs !== 'number' || typeof endMs !== 'number') return null;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    out.push({ id, text, startMs, endMs });
  }
  return out;
}

function parseTranslations(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [id, text] of Object.entries(value)) {
    if (typeof text !== 'string') return null;
    out[id] = text;
  }
  return out;
}

/**
 * 把存储里读出来的字符串变成草稿。**任何一处对不上就整体作废**，
 * 不做半截修复 —— 草稿是给用户看的转写，宁可没有，也不能有一份缺字的。
 */
export function parseDraft(raw: string | null, now: number = Date.now()): SessionDraft | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.v !== 1) return null;

  const { startedAt, updatedAt, status, audioDurationMs, degradedCount } = parsed;
  if (typeof startedAt !== 'number' || typeof updatedAt !== 'number') return null;
  if (!Number.isFinite(startedAt) || !Number.isFinite(updatedAt)) return null;
  if (now - updatedAt > DRAFT_TTL_MS) return null;

  const segments = parseSegments(parsed.segments);
  const translations = parseTranslations(parsed.translations);
  if (!segments || !translations) return null;
  if (segments.length === 0) return null;

  return {
    v: 1,
    startedAt,
    updatedAt,
    status: typeof status === 'string' ? (status as SessionStatus) : 'idle',
    audioDurationMs: typeof audioDurationMs === 'number' ? audioDurationMs : 0,
    degradedCount: typeof degradedCount === 'number' ? degradedCount : 0,
    segments,
    translations,
  };
}

/** 恢复之后要不要重新生成纪要：没做完的会话（没有 done）就值得重算一次。 */
export function needsSummary(draft: SessionDraft): boolean {
  return draft.status !== 'done';
}

/**
 * 什么时候该问用户「要不要恢复」。
 * 已经跑完的正常会话不再打扰，只提示还差一步的。
 */
export function describeDraft(draft: SessionDraft | null, now: number = Date.now()): string | null {
  if (!draft) return null;
  const minutes = Math.max(1, Math.round((now - draft.updatedAt) / 60000));
  const when = minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`;
  const translated = draft.segments.filter((s) => draft.translations[s.id]).length;
  return `发现一份未完成的会话（${when}），${draft.segments.length} 句原文、${translated} 句译文`;
}

function safeSessionStorage(): DraftStorage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    // 隐私模式下 sessionStorage 可能存在但一写就抛，所以这里真的试写一次。
    const probe = '__simulnote_probe__';
    sessionStorage.setItem(probe, '1');
    sessionStorage.removeItem(probe);
    return sessionStorage;
  } catch {
    return null;
  }
}

export function saveDraft(draft: SessionDraft, storage?: DraftStorage | null): boolean {
  const target = storage === undefined ? safeSessionStorage() : storage;
  if (!target) return false;
  try {
    target.setItem(DRAFT_KEY, JSON.stringify(draft));
    return true;
  } catch {
    // 配额爆了不算错误：留痕失败不该影响正在进行的会话。
    return false;
  }
}

export function loadDraft(
  storage?: DraftStorage | null,
  now: number = Date.now(),
): SessionDraft | null {
  const target = storage === undefined ? safeSessionStorage() : storage;
  if (!target) return null;
  try {
    return parseDraft(target.getItem(DRAFT_KEY), now);
  } catch {
    return null;
  }
}

export function clearDraft(storage?: DraftStorage | null): void {
  const target = storage === undefined ? safeSessionStorage() : storage;
  if (!target) return;
  try {
    target.removeItem(DRAFT_KEY);
  } catch {
    /* 忽略 */
  }
}

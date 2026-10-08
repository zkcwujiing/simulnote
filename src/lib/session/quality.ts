/**
 * 会话质量判读 —— 「丢句告警」。
 *
 * ## 为什么不是「转写时长 << 音频时长」
 *
 * 借鉴的做法是对比「转写时长」与「音频时长」。照字面实现会得到一个**永远不响的告警**，
 * 因为会议里大部分时间本来就是沉默：一场 30 分钟的会，真正的说话时间可能只有 12 分钟，
 * 拿 12 / 30 = 40% 当丢句证据，等于每次开会都报警。
 *
 * 所以这里把三个量分清楚（字段定义见 `src/types.ts` 的 `SessionStats`）：
 *
 * | 量 | 含义 | 会不会因为沉默而变小 |
 * |---|---|---|
 * | `audioDurationMs` | 采集回调真正收到的音频 | 不会（沉默也照收） |
 * | `speechDurationMs` | VAD 判定「有人说话」并**送进识别**的音频 | 会 |
 * | `transcriptDurationMs` | 识别**交回来**的句子时长之和 | 会 |
 *
 * **告警看的是 `transcriptDurationMs / speechDurationMs`** —— 分母是「引擎实际拿到的活」，
 * 分子是「它交回来的活」。送进去 10 分钟只回来 3 分钟，那才是真的丢句，
 * 与会议里有多少沉默无关。
 *
 * `speechDurationMs / audioDurationMs` 仍然有用，但它说明的是**另一件事**：
 * 麦克风是不是基本没听见人说话（放错位置、被静音、设备选错了）。
 * 这个数低不代表丢句，所以单独给一个函数，措辞也不一样。
 */

import type { SessionStats } from '@/types';

export type TranscriptLossLevel = 'ok' | 'suspect' | 'lost';

export interface TranscriptLossVerdict {
  level: TranscriptLossLevel;
  /** 识别交回的时长 ÷ 送进识别的时长。0 表示一句都没回来。 */
  ratio: number;
  /** 中文说明，可以直接显示给用户。 */
  message: string;
}

/**
 * 低于这个「送进识别的语音量」就不判了。
 * 一句话的会话里，一句没识别出来就是 0%，但那是正常波动，不是故障。
 */
export const LOSS_MIN_SPEECH_MS = 30_000;

/** 低于 `LOSS_SUSPECT_RATIO` 判 `suspect`；低到 `LOSS_LOST_RATIO` 及以下判 `lost`。 */
export const LOSS_SUSPECT_RATIO = 0.75;
export const LOSS_LOST_RATIO = 0.5;

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/**
 * 时长的人话写法。**不能一律用分钟** —— 「送进识别 0.0 分钟」这种句子
 * 用户读不出问题在哪（而它恰恰出现在「一句都没识别出来」这个最该说清楚的情况里）。
 */
function duration(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(0)} 秒` : `${(ms / 60_000).toFixed(1)} 分钟`;
}

/**
 * 判断有没有丢句。**判不了就返回 `null`**，而不是硬给一个 `ok` ——
 * 调用方需要能区分「确认没问题」和「样本不够，不知道」。
 */
export function detectTranscriptLoss(
  stats: SessionStats | null | undefined,
): TranscriptLossVerdict | null {
  if (!stats) return null;

  const speech = Math.max(0, stats.speechDurationMs);
  const transcript = Math.max(0, stats.transcriptDurationMs);
  if (speech < LOSS_MIN_SPEECH_MS) return null;

  const ratio = transcript / speech;
  if (ratio >= LOSS_SUSPECT_RATIO) {
    return {
      level: 'ok',
      ratio,
      message: `识别覆盖了送检语音的 ${pct(ratio)}，没有丢句。`,
    };
  }

  const facts = `送进识别 ${duration(speech)}，只交回 ${duration(transcript)}（${pct(ratio)}）。`;
  if (ratio <= LOSS_LOST_RATIO) {
    return {
      level: 'lost',
      ratio,
      message: `${facts}这通常意味着识别引擎跟不上实时速度、主动丢弃了前面的音频 —— 会话越长越容易发生。下一场可以试着把浏览器切到前台、关掉同时开着的重页面，或者改用「最快启动」档减少识别负担。`,
    };
  }

  return {
    level: 'suspect',
    ratio,
    message: `${facts}有一部分语音没能变成字幕。如果缺的正好是某一段，多半是那段时间麦克风被系统占用了（来电、锁屏、切到别的 App）。`,
  };
}

/**
 * 麦克风到底有没有听见人说话。
 *
 * 这个指标**偏低不是故障**：设备放得太远、会议上半场没人开口、浏览器把麦克风静音了，
 * 都会让它低。它只在「低到离谱」时才值得提一句，措辞也要往「检查一下设备」上引，
 * 而不是往「丢句了」上引。
 */
export function describeMicPickup(stats: SessionStats | null | undefined): string | null {
  if (!stats) return null;
  const audio = Math.max(0, stats.audioDurationMs);
  if (audio < LOSS_MIN_SPEECH_MS) return null;

  const density = Math.max(0, stats.speechDurationMs) / audio;
  if (density >= 0.05) return null;

  return `${duration(audio)}的录音里只认出 ${duration(Math.max(0, stats.speechDurationMs))} 的说话声。如果确实有人在讲，请检查麦克风是不是被静音、或者设备离说话人太远。`;
}

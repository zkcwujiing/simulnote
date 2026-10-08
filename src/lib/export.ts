/**
 * 导出与分享。
 *
 * 设计原则：**导出物必须自带上下文**。
 * 朋友拿到一份 Markdown，应该不依赖这个网站也能读懂：时间、用了什么引擎、
 * 每条要点对应哪一段。所以文件头部有元信息，正文有编号，结尾有引擎披露。
 */

import { detectTranscriptLoss } from '@/lib/session/quality';
import type { FinalSegment, PipelinePlan, SessionStats, SummaryResult } from '@/types';

export interface ExportInput {
  title: string;
  pairs: { segment: FinalSegment; zh?: string }[];
  summary: SummaryResult | null;
  stats: SessionStats | null;
  plan: PipelinePlan | null;
  startedAt: number;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 00:12:34.5 形式的时间码，便于和录音对齐。 */
export function timecode(ms: number): string {
  const total = Math.max(0, ms);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${tenths}`;
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function engineDisclosure(plan: PipelinePlan | null): string {
  if (!plan) return '（引擎信息缺失）';
  const privacy = plan.anyNetwork ? '⚠️ 会话中包含联网环节' : '✅ 全程在本机完成';
  return [
    `- 语音识别：${plan.asr.label}（${plan.asr.reason}）`,
    `- 翻译：${plan.mt.label}（${plan.mt.reason}）`,
    `- 纪要：${plan.sum.label}`,
    `- 隐私：${privacy}`,
  ].join('\n');
}

export function toMarkdown(input: ExportInput): string {
  const { title, pairs, summary, stats, plan, startedAt } = input;
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`> 由 SimulNote 同传笔记生成 · ${formatDateTime(startedAt)}`);
  lines.push('');

  if (summary) {
    lines.push('## 要点速览');
    lines.push('');
    lines.push(summary.tldr || '（无）');
    lines.push('');

    if (summary.keyPoints.length > 0) {
      lines.push('## 关键要点');
      lines.push('');
      summary.keyPoints.forEach((point, i) => lines.push(`${i + 1}. ${point}`));
      lines.push('');
    }

    if (summary.numbers.length > 0) {
      lines.push('## 关键数字');
      lines.push('');
      lines.push('| 英文原文 | 中文 | 类型 |');
      lines.push('| --- | --- | --- |');
      const kindZh: Record<string, string> = {
        percent: '比例',
        money: '金额',
        date: '日期',
        duration: '时长',
        quantity: '数量',
        proper: '专名',
      };
      for (const fact of summary.numbers) {
        const raw = fact.raw.replace(/\|/g, '\\|');
        lines.push(`| ${raw} | ${fact.zh} | ${kindZh[fact.kind] ?? fact.kind} |`);
      }
      lines.push('');
      lines.push('> 数字直接从英文原文解析，不经过翻译模型，因此不受小模型「数字翻错」的影响。');
      lines.push('');
    }

    if (summary.decisions.length > 0) {
      lines.push('## 结论与决议');
      lines.push('');
      for (const item of summary.decisions) lines.push(`- ${item}`);
      lines.push('');
    }

    if (summary.actions.length > 0) {
      lines.push('## 待办事项');
      lines.push('');
      for (const item of summary.actions) lines.push(`- [ ] ${item}`);
      lines.push('');
    }

    if (summary.keywords.length > 0) {
      lines.push('## 关键词');
      lines.push('');
      lines.push(
        summary.keywords
          .map((k) => (k.zh ? `${k.en}（${k.zh}）` : k.en))
          .join(' · '),
      );
      lines.push('');
    }
  }

  lines.push('## 完整转写');
  lines.push('');
  pairs.forEach((pair, i) => {
    const stamp = timecode(pair.segment.startMs);
    lines.push(`**${i + 1}. [${stamp}] ${pair.zh ?? '〔未翻译〕'}**`);
    lines.push('');
    lines.push(`> ${pair.segment.text}`);
    lines.push('');
  });

  lines.push('---');
  lines.push('');
  lines.push('### 运行环境');
  lines.push('');
  lines.push(engineDisclosure(plan));
  lines.push('');
  if (stats) {
    // 「听到多久」和「其中说话多久」是两个不同的量，凑成一个数会让读者
    // 以为会议真的开了那么久（会议里大部分时间是沉默的）。
    const minutesOf = (ms: number) => (ms / 60000).toFixed(1);
    lines.push(
      `- 收录 ${minutesOf(stats.audioDurationMs)} 分钟，其中识别到说话 ${minutesOf(
        stats.speechDurationMs,
      )} 分钟，共 ${stats.finalCount} 句，平均翻译延迟 ${(stats.meanLatencyMs / 1000).toFixed(2)} 秒`,
    );
    const loss = detectTranscriptLoss(stats);
    if (loss && loss.level !== 'ok') {
      lines.push('');
      lines.push(`> ⚠️ ${loss.message}`);
    }
  }
  if (summary) {
    lines.push(
      `- 纪要覆盖 ${summary.coverage.segments} 段 / ${summary.coverage.chars} 字符，产出方式：${
        summary.mode === 'extractive' ? '抽取式（每条都能指回原文）' : '生成式'
      }`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

export function toPlainText(input: ExportInput): string {
  const { pairs, summary } = input;
  const lines: string[] = [];

  if (summary) {
    lines.push(summary.title);
    lines.push('');
    lines.push(summary.tldr);
    lines.push('');
    summary.keyPoints.forEach((point, i) => lines.push(`${i + 1}. ${point}`));
    lines.push('');
    if (summary.numbers.length > 0) {
      lines.push('关键数字：');
      for (const fact of summary.numbers) lines.push(`  ${fact.raw} → ${fact.zh}`);
      lines.push('');
    }
    lines.push('————————');
    lines.push('');
  }

  for (const pair of pairs) {
    lines.push(`[${timecode(pair.segment.startMs)}] ${pair.zh ?? '〔未翻译〕'}`);
    lines.push(`${pair.segment.text}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * SRT 字幕。
 *
 * 三个刻意的决定：
 *
 * 1. **正文用中文译文**（同传的产出物就是中文），译不出来时退回英文原文 ——
 *    宁可给一句英文，也不要给一条空字幕，那会让播放器闪出一段莫名其妙的空白。
 * 2. **时间轴强制单调不重叠。** 识别给出的 `endMs` 偶尔会越过下一句的 `startMs`，
 *    而各家播放器对重叠区间的处理不一样（有的丢掉前一条、有的两条叠着显示）。
 *    这里把出点压到下一句入点前 1 ms。
 * 3. **文件里除了序号没有任何头。** SRT 规范没有注释语法 —— 加一行说明，
 *    那行说明就会真的以字幕形式出现在视频里。
 */
export function srtTimestamp(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const hours = Math.floor(t / 3_600_000);
  const minutes = Math.floor((t % 3_600_000) / 60_000);
  const seconds = Math.floor((t % 60_000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${String(t % 1000).padStart(3, '0')}`;
}

/** 识别没给出终点时的最小时长，避免出现 0 长度的字幕。 */
const SRT_FALLBACK_CUE_MS = 1200;

export function toSrt(input: ExportInput): string {
  const { pairs } = input;
  const cues: { start: number; end: number; text: string }[] = [];

  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i];
    const text = (pair.zh ?? pair.segment.text).replace(/\s*\n\s*/g, ' ').trim();
    if (!text) continue;

    const start = Math.max(0, pair.segment.startMs);
    let end = pair.segment.endMs > start ? pair.segment.endMs : start + SRT_FALLBACK_CUE_MS;

    const next = pairs[i + 1];
    if (next) {
      const boundary = next.segment.startMs - 1;
      if (boundary > start) end = Math.min(end, boundary);
    }
    // 相邻两句落在同一毫秒时，压完会得到非法区间。宁可重叠 1 ms 也不能写 start == end，
    // 有些播放器遇到非法区间会直接跳过后面所有字幕。
    if (end <= start) end = start + 1;

    cues.push({ start, end, text });
  }

  if (cues.length === 0) return '';

  return (
    cues
      .map((cue, i) => `${i + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${cue.text}`)
      .join('\n\n') + '\n'
  );
}

function safeFilename(title: string, ext: string): string {
  const base = title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60)
    .trim();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `${base || 'simulnote'}_${stamp}.${ext}`;
}

export function downloadText(filename: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器来不及下载，延迟释放
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function exportMarkdown(input: ExportInput): void {
  downloadText(safeFilename(input.title, 'md'), toMarkdown(input), 'text/markdown');
}

export function exportPlainText(input: ExportInput): void {
  downloadText(safeFilename(input.title, 'txt'), toPlainText(input), 'text/plain');
}

export function exportSrt(input: ExportInput): void {
  downloadText(safeFilename(input.title, 'srt'), toSrt(input), 'application/x-subrip');
}

export async function copyText(content: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
      return true;
    }
  } catch {
    /* 退回到 execCommand */
  }
  try {
    const area = document.createElement('textarea');
    area.value = content;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * 优先调用系统分享面板（手机上体验最好，能直接发微信），
 * 不支持时退回剪贴板。
 */
export async function shareText(title: string, content: string): Promise<'shared' | 'copied' | 'failed'> {
  const nav = navigator as Navigator & {
    share?: (data: { title?: string; text?: string }) => Promise<void>;
  };
  if (nav.share) {
    try {
      await nav.share({ title, text: content });
      return 'shared';
    } catch (error) {
      // 用户主动取消不算失败
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared';
    }
  }
  return (await copyText(content)) ? 'copied' : 'failed';
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSessionStore } from '@/store/sessionStore';
import { DownloadBar } from '@/components/DownloadBar';
import { EngineBar } from '@/components/EngineBar';
import { InterruptionBanner } from '@/components/SessionRecovery';
import { timecode } from '@/lib/export';
import type { FinalSegment } from '@/types';

/*
 * 字幕字号自适应（M2 第 6 条）。
 *
 * 「自适应」在这个项目里不该是靠 media query 猜屏幕 —— 同传的真实场景是
 * 「手机立在桌上、人离它一两米」，同一个 6 寸屏，站着看和坐下看需要的字号不同。
 * 所以做成**用户一键切换 + 记住**：三档，默认取中间档，存 localStorage。
 * 正文用 CSS 变量 `--sub` 下发，中英两行按固定比例跟着缩放，
 * 避免「中文调大了、英文还很小」这种半截效果。
 */
const SUB_SCALE_KEY = 'simulnote.subScale.v1';
const SUB_SCALES = [15, 18, 22] as const;
const SUB_SCALE_LABELS = ['小', '中', '大'] as const;
const SUB_SCALE_DEFAULT = 1;

function readSubScale(): number {
  try {
    const n = Number.parseInt(localStorage.getItem(SUB_SCALE_KEY) ?? '', 10);
    return Number.isInteger(n) && n >= 0 && n < SUB_SCALES.length ? n : SUB_SCALE_DEFAULT;
  } catch {
    // 隐私模式下 localStorage 会抛，字号偏好不值得让页面挂掉
    return SUB_SCALE_DEFAULT;
  }
}

interface Row {
  id: string;
  startMs: number;
  zh?: string;
  en: string;
  pending: boolean;
}

function RowView({ row, index }: { row: Row; index: number }) {
  return (
    <div className="border-b border-ink-800/70 px-3 py-3">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] text-slate-500">{index + 1}</span>
        <span className="font-mono text-[11px] text-slate-500">{timecode(row.startMs)}</span>
        {row.pending && (
          <span className="text-[11px] text-brand-400/80">翻译中…</span>
        )}
      </div>
      {row.zh ? (
        <p className="mt-1 leading-7 text-slate-50" style={{ fontSize: 'var(--sub, 15px)' }}>
          {row.zh}
        </p>
      ) : (
        <p className="mt-1 leading-7 text-slate-500" style={{ fontSize: 'var(--sub, 15px)' }}>
          {row.pending ? '（正在翻译）' : '（未翻译）'}
        </p>
      )}
      <p
        className="mt-1 leading-5 text-slate-500"
        style={{ fontSize: 'calc(var(--sub, 15px) * 0.8)' }}
      >
        {row.en}
      </p>
    </div>
  );
}

export function LiveView() {
  const segments = useSessionStore((s) => s.segments);
  const translations = useSessionStore((s) => s.translations);
  const partial = useSessionStore((s) => s.partial);
  const stop = useSessionStore((s) => s.stop);
  const status = useSessionStore((s) => s.status);
  const plan = useSessionStore((s) => s.plan);

  const parentRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [subScale, setSubScale] = useState(readSubScale);
  const download = useSessionStore((s) => s.download);
  const fileJob = useSessionStore((s) => s.fileJob);
  const cancelFile = useSessionStore((s) => s.cancelFile);

  const cycleSubScale = useCallback(() => {
    setSubScale((current) => {
      const next = (current + 1) % SUB_SCALES.length;
      try {
        localStorage.setItem(SUB_SCALE_KEY, String(next));
      } catch {
        // 存不下就算了，本次会话内仍然生效
      }
      return next;
    });
  }, []);

  const rows = useMemo<Row[]>(
    () =>
      segments.map((segment: FinalSegment) => {
        const zh = translations[segment.id];
        return {
          id: segment.id,
          startMs: segment.startMs,
          zh,
          en: segment.text,
          pending: !zh,
        };
      }),
    [segments, translations],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 108,
    overscan: 8,
  });

  // 跟随最新一句；用户主动往上翻时自动关掉，避免「我想看上面但页面乱跳」
  useEffect(() => {
    if (!autoScroll || rows.length === 0) return;
    virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [rows.length, autoScroll, virtualizer]);

  const onScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distanceFromBottom < 120);
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      style={{ '--sub': `${SUB_SCALES[subScale]}px` } as CSSProperties}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger-400 opacity-70" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger-600" />
        </span>
        <span className="text-xs text-slate-300">
          {plan?.asr.privacy === 'network' ? '识别中（音频会联网）' : '识别中（本机处理）'}
        </span>
        <span className="ml-auto font-mono text-xs text-slate-500">{rows.length} 句</span>
        {/* 手机立在桌上、人离它一两米时，15px 的字看不清。三档一键切换，选过就记住。 */}
        <button
          type="button"
          onClick={cycleSubScale}
          className="shrink-0 rounded-lg border border-ink-700 px-2 py-0.5 text-[11px] text-slate-400 active:bg-ink-800"
          aria-label={`字幕字号，当前${SUB_SCALE_LABELS[subScale]}，点击切换`}
          title="切换字幕字号"
        >
          字号·{SUB_SCALE_LABELS[subScale]}
        </button>
      </div>

      {/* 下载进度放在这里而不是只放在开始页：点了「开始」之后界面就是这一屏，
          模型还在下的时候必须让用户看得见进度（M2 验收第 3 条）。 */}
      {download && (
        <div className="px-3 pb-2">
          <DownloadBar compact />
        </div>
      )}

      {/* 中断提示必须贴在字幕上方：中断发生时页面是沉默的，
          用户不看到这句话就会以为还在录。 */}
      <div className="px-3 pb-2 empty:hidden">
        <InterruptionBanner />
      </div>

      {/* 引擎状态条常驻会话中：开始前那块面板点「开始」就没了，
          而档位是**每台机器都不一样**的，出问题时用户至少要能复述自己在用哪一档。 */}
      <div className="px-3 pb-2">
        <EngineBar />
      </div>

      <div
        ref={parentRef}
        onScroll={onScroll}
        className="scroll-area min-h-0 flex-1 overflow-y-auto rounded-2xl border border-ink-700/70 bg-ink-900/60"
      >
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <p className="text-sm text-slate-300">
              {status === 'preparing' ? '正在准备模型与麦克风…' : '正在听…'}
            </p>
            <p className="text-xs leading-5 text-slate-500">
              {download
                ? '正在把模型下载到本机，只有第一次需要。可以先去倒杯水，别关这个页面。'
                : '对着手机或电脑正常说话即可。停顿一下，识别结果就会出现。'}
            </p>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <div
                  key={row.id}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <RowView row={row} index={item.index} />
                </div>
              );
            })}
          </div>
        )}

        {partial && (
          <div className="sticky bottom-0 border-t border-ink-700/70 bg-ink-850/95 px-3 py-2 backdrop-blur">
            <div className="font-mono text-[11px] text-slate-500">正在识别</div>
            <p className="leading-7 text-slate-300" style={{ fontSize: 'var(--sub, 15px)' }}>
              {partial.text}
            </p>
          </div>
        )}
      </div>

      <div className="pt-3">
        {fileJob ? (
          // 文件模式下「结束并生成纪要」是没有意义的 —— 用户要的是把它跑完。
          // 这里给的是进度与一个真正的中止，而不是一句会被误读成「我已经处理完了」的按钮。
          <div className="grid gap-2">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="min-w-0 truncate">{fileJob.name}</span>
              <span className="shrink-0">{Math.round(fileJob.ratio * 100)}%</span>
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-ink-800"
              role="progressbar"
              aria-label="音频文件处理进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fileJob.ratio * 100)}
            >
              <div
                className="h-full rounded-full bg-brand-500 transition-[width] duration-300"
                style={{ width: `${Math.max(2, Math.round(fileJob.ratio * 100))}%` }}
              />
            </div>
            <p className="text-xs leading-5 text-slate-500">{fileJob.phase}</p>
            <button
              type="button"
              className="btn-ghost w-full py-2.5"
              onClick={() => cancelFile()}
            >
              停止处理
            </button>
          </div>
        ) : (
          <button type="button" className="btn-danger w-full py-3 text-base" onClick={() => void stop()}>
            结束并生成纪要
          </button>
        )}
      </div>
    </div>
  );
}

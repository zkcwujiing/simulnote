import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSessionStore } from '@/store/sessionStore';
import { timecode } from '@/lib/export';
import type { FinalSegment } from '@/types';

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
        <p className="mt-1 text-[15px] leading-6 text-slate-50">{row.zh}</p>
      ) : (
        <p className="mt-1 text-[15px] leading-6 text-slate-500">
          {row.pending ? '（正在翻译）' : '（未翻译）'}
        </p>
      )}
      <p className="mt-1 text-xs leading-5 text-slate-500">{row.en}</p>
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger-400 opacity-70" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger-600" />
        </span>
        <span className="text-xs text-slate-300">
          {plan?.asr.privacy === 'network' ? '识别中（音频会联网）' : '识别中（本机处理）'}
        </span>
        <span className="ml-auto font-mono text-xs text-slate-500">{rows.length} 句</span>
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
              对着手机或电脑正常说话即可。停顿一下，识别结果就会出现。
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
            <p className="text-sm leading-6 text-slate-300">{partial.text}</p>
          </div>
        )}
      </div>

      <div className="pt-3">
        <button type="button" className="btn-danger w-full py-3 text-base" onClick={() => void stop()}>
          结束并生成纪要
        </button>
      </div>
    </div>
  );
}

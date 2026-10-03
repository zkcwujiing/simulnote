import { useSessionStore } from '@/store/sessionStore';

const TONE: Record<string, string> = {
  info: 'border-ink-700 bg-ink-850/90 text-slate-300',
  warn: 'border-warn-400/40 bg-warn-600/10 text-warn-400',
  error: 'border-danger-600/50 bg-danger-600/10 text-danger-400',
};

/**
 * 只显示最近三条。
 * 长会话里提示可能很密集（每一句翻译失败都会推一条），全部铺开会把转写挤没了，
 * 所以这里刻意做「滚动窗口」而不是完整列表。
 */
export function NoticeBar() {
  const notices = useSessionStore((s) => s.notices);
  if (notices.length === 0) return null;

  const recent = notices.slice(-3);

  return (
    <div className="grid gap-2">
      {recent.map((notice) => (
        <div
          key={notice.id}
          className={`rounded-xl border px-3 py-2 text-xs leading-5 ${TONE[notice.level] ?? TONE.info}`}
        >
          {notice.message}
        </div>
      ))}
    </div>
  );
}

import { useSessionStore } from '@/store/sessionStore';

/**
 * 首次使用要先把模型下载到本机，手机上是 150 MB 上下，等一会儿很正常。
 *
 * 这个进度条**必须同时出现在「开始之前」（`PlanPanel`）和「准备中」（`LiveView`）**。
 * 之前只有 `PlanPanel` 里有，而点了「开始」之后界面切到 `LiveView`，
 * 进度条随之消失，屏幕上只剩一句静态的「正在准备模型与麦克风…」——
 * 手机上要盯着这句话等好几分钟，看起来和卡死没有区别。
 * 这是 M2 验收里「模型下载有进度提示」那一条的实体。
 */
export function DownloadBar({ compact = false }: { compact?: boolean }) {
  const download = useSessionStore((s) => s.download);
  if (!download) return null;

  const percent = download.progress === null ? null : Math.round(download.progress * 100);

  return (
    <div
      className={
        compact
          ? 'rounded-xl border border-ink-700/70 bg-ink-900/60 px-3 py-2'
          : 'card'
      }
    >
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="min-w-0 truncate text-slate-200">{download.label}</span>
        <span className="shrink-0 font-mono text-xs text-slate-400">
          {percent === null ? '…' : `${percent}%`}
        </span>
      </div>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-ink-800"
        role="progressbar"
        aria-label={download.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div
          className="h-full rounded-full bg-brand-500 transition-[width] duration-300"
          style={{ width: `${percent ?? 8}%` }}
        />
      </div>
      {!compact && (
        <p className="mt-2 text-xs leading-5 text-slate-400">
          首次使用需要把模型下载到本机，之后就不再下载了。下载完可以断网使用。
        </p>
      )}
    </div>
  );
}

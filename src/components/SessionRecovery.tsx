import { useSessionStore } from '@/store/sessionStore';

const TONE: Record<string, string> = {
  paused: 'border-warn-400/40 bg-warn-600/10 text-warn-400',
  'needs-resume': 'border-warn-400/40 bg-warn-600/10 text-warn-400',
  'audio-lost': 'border-danger-600/50 bg-danger-600/10 text-danger-400',
  none: 'border-ink-700 bg-ink-850/90 text-slate-300',
};

/**
 * 切后台 / 锁屏的提示条。
 *
 * 它存在的理由只有一个：**中断发生时页面是完全沉默的**。
 * `status` 还是 `running`、字幕还在滚，用户回来时以为还在录，
 * 其实麦克风早就停了 —— 直到会议结束才会发现中间空了一大段。
 * 所以这条提示宁可显眼一点，也要让他知道「刚才那段时间可能没录上」。
 */
export function InterruptionBanner() {
  const interruption = useSessionStore((s) => s.interruption);
  const dismiss = useSessionStore((s) => s.dismissInterruption);
  if (!interruption) return null;

  const tone = TONE[interruption.level] ?? TONE.none;

  return (
    <div className={`rounded-xl border px-3 py-2.5 text-xs leading-5 ${tone}`}>
      <div className="flex items-start gap-2">
        <span className="mt-px shrink-0">{interruption.active ? '⏸' : '⚠️'}</span>
        <div className="min-w-0 flex-1">
          <p>{interruption.message}</p>
          {interruption.outcome && interruption.outcome !== interruption.message && (
            <p className="mt-1 opacity-80">处置：{interruption.outcome}</p>
          )}
        </div>
        {!interruption.active && (
          <button
            type="button"
            className="shrink-0 rounded-lg px-2 py-0.5 text-[11px] opacity-70 hover:opacity-100"
            onClick={dismiss}
          >
            知道了
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 「发现一份没做完的会话」。
 *
 * 手机浏览器在后台内存吃紧时会直接杀掉标签页，不报错、不给机会收尾。
 * 唯一能对抗它的是「被杀之前就已经写出去」—— 见 `lib/session/draft.ts`。
 * 这里只负责问一句，恢复动作在 store 的 `acceptDraftOffer` 里。
 */
export function DraftBanner() {
  const offer = useSessionStore((s) => s.draftOffer);
  const accept = useSessionStore((s) => s.acceptDraftOffer);
  const dismiss = useSessionStore((s) => s.dismissDraftOffer);
  if (!offer) return null;

  return (
    <div className="rounded-2xl border border-brand-500/40 bg-brand-500/10 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-lg leading-none">📄</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-brand-400">这份会话上次没做完</p>
          <p className="mt-1 text-xs leading-5 text-slate-300">{offer}</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            音频从不落盘，所以只能找回文字；恢复后会用它重新生成一次纪要。
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="btn-primary px-3 py-1.5 text-xs"
              onClick={() => void accept()}
            >
              恢复并生成纪要
            </button>
            <button
              type="button"
              className="btn-ghost px-3 py-1.5 text-xs"
              onClick={dismiss}
            >
              重新开始
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

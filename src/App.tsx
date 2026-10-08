import { useEffect, useState } from 'react';
import { LiveView } from '@/components/LiveView';
import { NoticeBar } from '@/components/NoticeBar';
import { PlanPanel } from '@/components/PlanPanel';
import { DraftBanner } from '@/components/SessionRecovery';
import { ShareCard } from '@/components/ShareCard';
import { SummaryView } from '@/components/SummaryView';
import { checkDraftOnBoot, useSessionStore } from '@/store/sessionStore';

function SummaryProgress({ text }: { text: string }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-6">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-ink-700 border-t-brand-500" />
        <p className="mt-4 text-sm text-slate-200">正在整理纪要…</p>
        <p className="mt-1 text-xs leading-5 text-slate-500">{text || '分析讲话结构'}</p>
      </div>
    </div>
  );
}

export default function App() {
  const status = useSessionStore((s) => s.status);
  const summary = useSessionStore((s) => s.summary);
  const summaryProgress = useSessionStore((s) => s.summaryProgress);
  const prepare = useSessionStore((s) => s.prepare);
  const plan = useSessionStore((s) => s.plan);

  const [showShare, setShowShare] = useState(false);

  // 进页面就自动探测一次环境，把「这台设备会怎么跑」先摆出来。
  // 探测只读能力、不申请麦克风权限、不下载模型，所以可以放心自动执行。
  useEffect(() => {
    void prepare();
    // 顺手看一眼上次有没有没做完的会话（M2）。和探测分开：探测失败
    // 也不该影响「把上次的文字找回来」这件事。
    checkDraftOnBoot();
  }, [prepare]);

  const isLive = !summary && (status === 'running' || status === 'preparing');
  const isSummarizing = !summary && (status === 'summarizing' || (status === 'done' && !summary));
  const privacyKnown = plan !== null;
  const anyNetwork = plan?.anyNetwork ?? false;

  return (
    <div className="pb-safe pt-safe mx-auto flex h-dvh w-full max-w-3xl flex-col px-3">
      <header className="flex items-center gap-3 py-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-500/15 text-base">
          🎧
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold text-slate-50">SimulNote · 同传笔记</h1>
          <p className="truncate text-[11px] text-slate-500">
            英文实时转中文，说完自动出纪要
          </p>
        </div>
        {privacyKnown && (
          <span
            className={
              anyNetwork
                ? 'chip border-warn-400/50 text-warn-400'
                : 'chip border-brand-500/40 text-brand-400'
            }
          >
            {anyNetwork ? '含联网环节' : '全程本机'}
          </span>
        )}
        {!isLive && !isSummarizing && (
          <button
            type="button"
            className="btn-ghost px-3 text-xs"
            onClick={() => setShowShare((v) => !v)}
          >
            分享
          </button>
        )}
      </header>

      {!isLive && !isSummarizing && (
        <div className="pb-3">
          <NoticeBar />
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col">
        {isLive ? (
          <LiveView />
        ) : isSummarizing ? (
          <SummaryProgress text={summaryProgress} />
        ) : (
          <div className="scroll-area min-h-0 flex-1 overflow-y-auto pb-6">
            {/* 上次没做完的会话（M2）。放在最上面：它决定了这次要不要从头开始。 */}
            <div className="pb-3 empty:hidden">
              <DraftBanner />
            </div>
            {summary ? (
              <SummaryView />
            ) : (
              <PlanPanel>{showShare && <ShareCard />}</PlanPanel>
            )}

          </div>
        )}
      </main>

      <footer className="py-3 text-center text-[11px] leading-5 text-slate-600">
        无需注册 · 不收集音频 · 不产生费用
        <br />
        识别与翻译在本机完成时，音频与文字都不会离开你的设备
      </footer>
    </div>
  );
}

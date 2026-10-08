import { useState } from 'react';
import type { PipelinePlan, StagePlan } from '@/types';
import { useSessionStore } from '@/store/sessionStore';

/**
 * 会话进行中的「引擎状态条」。
 *
 * 为什么要有它：开始前 `PlanPanel` 已经把「这次会用哪一档、为什么」讲清楚了，
 * 但那块面板**点下「开始」就消失了**。会话中途如果某一环降级（比如 GPU 后端起不来、
 * 换了更小的量化档），用户看到的只是「好像变慢了/变差了」，没有任何线索。
 * 手机上尤其难受：同一个链接在不同机器、不同浏览器上跑出来的档位可能完全不同，
 * 出问题时用户能复述的只有「你的网站不准」。
 *
 * 所以这里在会话中常驻一行摘要，点开能看每一环的**实际**档位与理由。
 * 默认收起：它是解释用的，不是给每次会话都读一遍的。
 */

const STAGE_NAMES: Record<keyof Pick<PipelinePlan, 'asr' | 'mt' | 'sum'>, string> = {
  asr: '语音识别',
  mt: '翻译',
  sum: '纪要',
};

const STAGE_ORDER = ['asr', 'mt', 'sum'] as const;

function stageTitle(plan: StagePlan): string {
  // `label` 已经是引擎自己的可读名字（如「Whisper tiny（英文专用）」）。
  // 这里只在它为空时兜底，不去改写引擎的措辞 —— 那会让文案跟实际档位对不上。
  return plan.label || plan.engineId;
}

export function EngineBar() {
  const plan = useSessionStore((s) => s.plan);
  const [open, setOpen] = useState(false);
  if (!plan) return null;

  const degraded = plan.degraded;
  const summary = STAGE_ORDER.map((key) => stageTitle(plan[key])).join(' · ');

  return (
    <div className="rounded-xl border border-ink-700/70 bg-ink-900/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-slate-400 active:bg-ink-800"
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${degraded ? 'bg-warn-400' : 'bg-brand-400'}`} />
        <span className="shrink-0">{degraded ? '已降级运行' : '本次使用的引擎'}</span>
        <span className="min-w-0 flex-1 truncate text-slate-500">{summary}</span>
        <span className="shrink-0 text-slate-500">{open ? '收起' : '详情'}</span>
      </button>

      {open && (
        <dl className="grid gap-2 border-t border-ink-700/70 px-3 py-2.5">
          {STAGE_ORDER.map((key) => {
            const stage = plan[key];
            return (
              <div key={key} className="grid gap-0.5">
                <dt className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <span className="text-slate-300">{STAGE_NAMES[key]}</span>
                  <span className="truncate">{stageTitle(stage)}</span>
                  <span
                    className={`shrink-0 rounded px-1 py-px text-[10px] ${
                      stage.privacy === 'on-device'
                        ? 'bg-brand-600/15 text-brand-400'
                        : 'bg-warn-600/15 text-warn-400'
                    }`}
                  >
                    {stage.privacy === 'on-device' ? '本机' : '联网'}
                  </span>
                </dt>
                <dd className="text-[11px] leading-5 text-slate-500">{stage.reason}</dd>
              </div>
            );
          })}
          {plan.anyNetwork && (
            <p className="text-[11px] leading-5 text-warn-400">
              本次会话包含联网环节，原文会离开这台设备。
            </p>
          )}
        </dl>
      )}
    </div>
  );
}

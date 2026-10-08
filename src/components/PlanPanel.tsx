import { useRef, type ReactNode } from 'react';
import type { StagePlan } from '@/types';
import { PIPELINE_MODES, type PipelineMode } from '@/engines/registry';
import { DownloadBar } from '@/components/DownloadBar';
import { useSessionStore } from '@/store/sessionStore';

function PrivacyChip({ plan }: { plan: StagePlan }) {
  const local = plan.privacy === 'on-device';
  return (
    <span
      className={
        local
          ? 'chip border-brand-500/40 text-brand-400'
          : 'chip border-warn-400/50 text-warn-400'
      }
    >
      {local ? '本机处理' : '联网'}
    </span>
  );
}

function StageRow({ title, plan }: { title: string; plan: StagePlan }) {
  return (
    <div className="flex items-start justify-between gap-3 border-t border-ink-700/60 py-3 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <div className="text-xs text-slate-400">{title}</div>
        <div className="truncate text-sm font-medium text-slate-100">{plan.label}</div>
        <div className="mt-0.5 text-xs leading-5 text-slate-400">{plan.reason}</div>
      </div>
      <PrivacyChip plan={plan} />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0';
  const mb = bytes / 1024 / 1024;
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function ModeSelector() {
  const mode = useSessionStore((s) => s.mode);
  const setMode = useSessionStore((s) => s.setMode);
  const status = useSessionStore((s) => s.status);
  const locked = status === 'running' || status === 'preparing';

  return (
    <div className="grid gap-2">
      {(PIPELINE_MODES as { value: PipelineMode; label: string; hint: string }[]).map((item) => {
        const active = item.value === mode;
        return (
          <button
            key={item.value}
            type="button"
            disabled={locked}
            onClick={() => setMode(item.value)}
            className={
              'rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ' +
              (active
                ? 'border-brand-500/70 bg-brand-500/10'
                : 'border-ink-700 bg-ink-900/60 hover:bg-ink-800')
            }
          >
            <div className="flex items-center gap-2">
              <span
                className={
                  'h-2 w-2 shrink-0 rounded-full ' + (active ? 'bg-brand-400' : 'bg-ink-500')
                }
              />
              <span className="text-sm font-medium text-slate-100">{item.label}</span>
            </div>
            <p className="mt-1 pl-4 text-xs leading-5 text-slate-400">{item.hint}</p>
          </button>
        );
      })}
    </div>
  );
}

export function PlanPanel({ children }: { children?: ReactNode }) {
  const status = useSessionStore((s) => s.status);
  const plan = useSessionStore((s) => s.plan);
  const error = useSessionStore((s) => s.error);
  const download = useSessionStore((s) => s.download);
  const start = useSessionStore((s) => s.start);
  const transcribeFile = useSessionStore((s) => s.transcribeFile);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prepare = useSessionStore((s) => s.prepare);

  return (
    <div className="grid gap-3">
      <section className="card">
        <h2 className="text-sm font-semibold text-slate-100">这台设备会怎么跑</h2>
        {status === 'probing' || !plan ? (
          <p className="mt-2 text-sm text-slate-400">正在检测浏览器能力…</p>
        ) : (
          <>
            <div className="mt-3">
              <StageRow title="语音识别" plan={plan.asr} />
              <StageRow title="翻译" plan={plan.mt} />
              <StageRow title="纪要" plan={plan.sum} />
            </div>
            {plan.degraded && (
              <p className="mt-3 rounded-xl border border-warn-400/30 bg-warn-400/5 p-3 text-xs leading-5 text-warn-400">
                首选方案在这台设备上不可用，已经自动降级。功能都能用，但速度或隐私性会打折扣。
              </p>
            )}
            {plan.anyNetwork && (
              <p className="mt-3 rounded-xl border border-warn-400/30 bg-warn-400/5 p-3 text-xs leading-5 text-warn-400">
                当前配置包含联网环节。想做到完全不联网，请选择「完全本地」。
              </p>
            )}
            {plan.totalBytes > 0 && (
              <p className="mt-3 text-xs leading-5 text-slate-400">
                首次需要下载约 <span className="font-medium text-slate-200">{formatBytes(plan.totalBytes)}</span>
                的模型文件，下载完成后不再需要网络。
              </p>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2 className="mb-3 text-sm font-semibold text-slate-100">运行模式</h2>
        <ModeSelector />
        <button
          type="button"
          className="btn-ghost mt-3 w-full"
          disabled={status === 'probing' || status === 'running'}
          onClick={() => void prepare()}
        >
          重新检测
        </button>
      </section>

      {download && <DownloadBar />}

      {error && (
        <div className="card border-danger-600/50 bg-danger-600/10">
          <div className="text-sm font-medium text-danger-400">出了点问题</div>
          <p className="mt-1 text-sm leading-6 text-slate-200">{error}</p>
          <p className="mt-2 text-xs leading-5 text-slate-400">
            建议：确认地址是 https 开头、浏览器是 Chrome / Edge 新版；如果在微信内置浏览器里打开，请点右上角改用系统浏览器。
          </p>
        </div>
      )}

      <button
        type="button"
        className="btn-primary w-full py-3 text-base"
        disabled={!plan || status === 'probing'}
        onClick={() => void start()}
      >
        开始同传
      </button>
      <p className="text-center text-xs leading-5 text-slate-500">
        点击后会申请麦克风权限{plan && plan.totalBytes > 0 ? '并下载模型' : ''}，浏览器要求这一步必须由你亲自点击。
      </p>

      {/* 上传音频文件：给「已经录好了、想补一份纪要」的场景。
          它和「开始同传」共用同一条管线与同一份模型，区别只是音频从哪来，
          所以放在同一层级、同一种视觉重量上，不做成藏在角落的次要入口。 */}
      <div className="grid gap-2 border-t border-ink-700/70 pt-4">
        <label className="text-center text-xs leading-5 text-slate-500">
          已经有一段录音？上传音频文件，同样出字幕、译文和纪要。
        </label>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // 清空 value，否则用户选同一个文件第二次不会触发 change。
            event.target.value = '';
            if (file) void transcribeFile(file);
          }}
        />
        <button
          type="button"
          className="btn-ghost w-full py-2.5"
          disabled={!plan || status === 'probing' || status === 'running'}
          onClick={() => fileInputRef.current?.click()}
        >
          上传音频文件
        </button>
      </div>

      {children}
    </div>
  );
}

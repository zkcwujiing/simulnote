import { useMemo, useState, type ReactNode } from 'react';
import type { ExtractedFact } from '@/types';
import {
  copyText,
  exportMarkdown,
  exportPlainText,
  exportSrt,
  shareText,
  timecode,
  type ExportInput,
} from '@/lib/export';
import { EngineBar } from '@/components/EngineBar';
import { detectTranscriptLoss } from '@/lib/session/quality';
import { useSessionStore } from '@/store/sessionStore';

const KIND_ZH: Record<ExtractedFact['kind'], string> = {
  percent: '比例',
  money: '金额',
  date: '日期',
  duration: '时长',
  quantity: '数量',
  proper: '专名',
};

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
      {hint && <p className="mt-0.5 text-xs leading-5 text-slate-500">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function SummaryView() {
  const summary = useSessionStore((s) => s.summary);
  const stats = useSessionStore((s) => s.stats);
  // 「这一场有没有丢句」要在纪要里留一份，不能只弹一条会消失的提示 ——
  // 用户往往是在回头看纪要时才发现少了内容。
  const loss = detectTranscriptLoss(stats);
  const plan = useSessionStore((s) => s.plan);
  const startedAt = useSessionStore((s) => s.startedAt);
  const reset = useSessionStore((s) => s.reset);

  // 注意：这里必须自己 useMemo 拼 pairs，不能直接
  // `useSessionStore(selectPairs)` —— selectPairs 每次都返回新数组，
  // zustand v5 + useSyncExternalStore 会认为快照一直在变，最终无限重渲染（白屏）。
  // 只订阅两个引用稳定的原始字段，再在本地派生。
  const segments = useSessionStore((s) => s.segments);
  const translations = useSessionStore((s) => s.translations);
  const pairs = useMemo(
    () =>
      [...segments]
        .sort((a, b) => a.startMs - b.startMs)
        .map((segment) => ({ segment, zh: translations[segment.id] })),
    [segments, translations],
  );

  const [toast, setToast] = useState('');

  // 数字回填的现场记录（R4）。空数组时整块不渲染。
  const numberFixes = summary?.numberFixes ?? [];

  const exportInput = useMemo<ExportInput>(
    () => ({
      title: summary?.title || '同传纪要',
      pairs,
      summary,
      stats,
      plan,
      startedAt: startedAt ?? Date.now(),
    }),
    [summary, pairs, stats, plan, startedAt],
  );

  const flash = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(''), 2400);
  };

  if (!summary) {
    return (
      <div className="card">
        <p className="text-sm text-slate-300">纪要没有生成出来。</p>
        <p className="mt-2 text-xs leading-5 text-slate-400">
          转写和译文都还在，可以直接导出或复制原文。如果反复出现，说明这次的讲话内容太短，
          或者识别结果为空。
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <section className="card border-brand-500/30 bg-brand-500/5">
        <div className="text-xs text-brand-400">要点速览</div>
        <p className="mt-2 text-[15px] leading-7 text-slate-50">{summary.tldr}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="chip border-ink-700 text-slate-400">
            {summary.mode === 'extractive' ? '抽取式 · 每条可回溯原文' : '生成式'}
          </span>
          <span className="chip border-ink-700 text-slate-400">
            覆盖 {summary.coverage.segments} 段 / {summary.coverage.chars} 字
          </span>
          {stats && (
            <span className="chip border-ink-700 text-slate-400">
              听到 {(stats.audioDurationMs / 60000).toFixed(1)} 分钟 · 其中说话{' '}
              {(stats.speechDurationMs / 60000).toFixed(1)} 分钟 · {stats.finalCount} 句
            </span>
          )}
        </div>
      </section>

      {/* 纪要里也要留一份本次的档位：用户往往是回头看纪要时才发现某场效果不对，
          而那时开始页早就关掉了。 */}
      <EngineBar />

      {loss && loss.level !== 'ok' && (
        <section
          className={`card border ${
            loss.level === 'lost'
              ? 'border-danger-600/50 bg-danger-600/5'
              : 'border-warn-400/40 bg-warn-600/5'
          }`}
        >
          <h2 className={`text-sm font-semibold ${loss.level === 'lost' ? 'text-danger-400' : 'text-warn-400'}`}>
            {loss.level === 'lost' ? '这一场可能丢了整段内容' : '这一场可能漏了几句话'}
          </h2>
          <p className="mt-2 text-xs leading-5 text-slate-300">{loss.message}</p>
        </section>
      )}

      {summary.keyPoints.length > 0 && (
        <Section title="关键要点" hint="按重要度排序，不是讲话顺序。">
          <ol className="grid gap-2.5">
            {summary.keyPoints.map((point, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ink-800 font-mono text-[11px] text-brand-400">
                  {i + 1}
                </span>
                <span className="text-sm leading-6 text-slate-100">{point}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {summary.numbers.length > 0 && (
        <Section
          title="关键数字"
          hint="从英文原文直接解析，不经过翻译模型 —— 小模型的数字翻译不可靠。"
        >
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="border-b border-ink-700 pb-2 pr-3 font-normal">英文原文</th>
                  <th className="border-b border-ink-700 pb-2 pr-3 font-normal">中文</th>
                  <th className="border-b border-ink-700 pb-2 pr-3 font-normal">类型</th>
                  <th className="border-b border-ink-700 pb-2 font-normal">出处</th>
                </tr>
              </thead>
              <tbody>
                {summary.numbers.map((fact, i) => (
                  <tr key={i}>
                    <td className="border-b border-ink-800 py-2 pr-3 font-mono text-xs text-slate-400">
                      {fact.raw}
                    </td>
                    <td className="border-b border-ink-800 py-2 pr-3 text-slate-100">{fact.zh}</td>
                    <td className="border-b border-ink-800 py-2 pr-3 text-xs text-slate-500">
                      {KIND_ZH[fact.kind] ?? fact.kind}
                    </td>
                    <td className="border-b border-ink-800 py-2 text-xs text-slate-500">
                      {fact.segIndex >= 0 ? `第 ${fact.segIndex + 1} 段` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {numberFixes.length > 0 && (
            <div className="mt-3 rounded-md border border-ink-700 bg-ink-900/60 p-3">
              <p className="text-xs text-slate-400">
                译文里的数字已按上面的原文核对，改动了 {numberFixes.length} 处：
              </p>
              <ul className="mt-2 grid gap-1">
                {numberFixes.map((item, i) => (
                  <li key={i} className="text-xs leading-5 text-slate-300">
                    · {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      {summary.decisions.length > 0 && (
        <Section title="结论与决议">
          <ul className="grid gap-2">
            {summary.decisions.map((item, i) => (
              <li key={i} className="flex gap-2 text-sm leading-6 text-slate-100">
                <span className="text-brand-400">▸</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {summary.actions.length > 0 && (
        <Section title="待办事项">
          <ul className="grid gap-2">
            {summary.actions.map((item, i) => (
              <li key={i} className="flex gap-2 text-sm leading-6 text-slate-100">
                <span className="mt-1.5 h-3.5 w-3.5 shrink-0 rounded border border-ink-500" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {summary.keywords.length > 0 && (
        <Section title="关键词">
          <div className="flex flex-wrap gap-1.5">
            {summary.keywords.map((word, i) => (
              <span key={i} className="chip border-ink-700 text-slate-300">
                {word.zh ? `${word.en} · ${word.zh}` : word.en}
              </span>
            ))}
          </div>
        </Section>
      )}

      <section className="card">
        <h2 className="text-sm font-semibold text-slate-100">导出与分享</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <button type="button" className="btn-primary" onClick={() => exportMarkdown(exportInput)}>
            下载 Markdown
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void exportPlainText(exportInput)}
          >
            下载纯文本
          </button>
          <button type="button" className="btn-ghost" onClick={() => exportSrt(exportInput)}>
            下载 SRT 字幕
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              void (async () => {
                const ok = await copyText(exportInput.title + '\n\n' + summary.tldr);
                flash(ok ? '已复制要点速览' : '复制失败');
              })();
            }}
          >
            复制要点
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              void (async () => {
                const result = await shareText(exportInput.title, exportInput.title + '\n\n' + summary.tldr);
                flash(result === 'shared' ? '已调起分享' : result === 'copied' ? '已复制到剪贴板' : '分享失败');
              })();
            }}
          >
            分享
          </button>
        </div>
        {toast && <p className="mt-2 text-xs text-brand-400">{toast}</p>}
        <p className="mt-2 text-xs leading-5 text-slate-500">
          Markdown 文件里带有完整的中英对照转写、时间码和本次使用的引擎说明，不依赖这个网站也能读懂。
          SRT 是字幕文件，可以直接拖进剪映 / Premiere / VLC —— 正文用中文译文，译不出来的句子退回英文原文。
        </p>
      </section>

      <details className="card">
        <summary className="cursor-pointer text-sm font-semibold text-slate-100">
          完整转写（{pairs.length} 句）
        </summary>
        <div className="mt-3 grid gap-4">
          {pairs.map((pair, i) => (
            <div key={pair.segment.id} className="border-l-2 border-ink-700 pl-3">
              <div className="font-mono text-[11px] text-slate-500">
                {i + 1} · {timecode(pair.segment.startMs)}
              </div>
              <p className="mt-1 text-sm leading-6 text-slate-50">{pair.zh ?? '〔未翻译〕'}</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">{pair.segment.text}</p>
            </div>
          ))}
        </div>
      </details>

      <button type="button" className="btn-ghost w-full py-3" onClick={reset}>
        再录一场
      </button>
    </div>
  );
}

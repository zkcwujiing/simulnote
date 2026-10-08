import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 最后一道防线：渲染期抛异常时的兜底界面。
 *
 * 为什么必须有它：这个应用跑在别人的手机上，而**白屏是没法远程诊断的**。
 * 用户能提供的只有「打开就白了」。有了这块界面，至少能看到错误发生在何时、
 * 是什么错，并且有一个不破坏本机缓存的恢复动作。
 *
 * 两个动作是刻意分开的，因为它们的代价差得很远：
 * - **重新加载**：什么都不动，绝大多数瞬时错误（内存紧张时的一次分配失败）重载就好。
 * - **只清掉会话语义的状态**：清掉留痕草稿这类 localStorage 条目，
 *   **绝不碰 Cache Storage** —— 那 160 MB 模型缓存是用户花时间下下来的，
 *   把它当「恢复出厂设置」清掉，用户下次要再等几分钟，这比白屏更让人恼火。
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** 用户点了「清除会话状态」之后置为 true，用于换一段文案。 */
  cleared: boolean;
}

/** 只清会话语义相关的键，模型缓存（Cache Storage）一律不动。 */
const SESSION_STORAGE_PREFIXES = ['simulnote.draft', 'simulnote.session', 'simulnote.modelSource'];

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, cleared: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 故意用 console.error 而不是只弹界面：真机上报错信息只能靠用户截图控制台，
    // 所以要把组件栈一起打出来。
    console.error('[simulnote] 渲染出错：', error, info.componentStack);
  }

  private reload = (): void => {
    window.location.reload();
  };

  private clearSessionState = (): void => {
    let removed = 0;
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && SESSION_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
          keys.push(key);
        }
      }
      for (const key of keys) {
        localStorage.removeItem(key);
        removed += 1;
      }
    } catch {
      // 隐私模式下 localStorage 可能直接抛错；清不掉不该再炸一次。
    }
    console.info(`[simulnote] 已清除 ${removed} 条会话状态（模型缓存未动）`);
    this.setState({ cleared: true });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 p-5">
        <section className="card border border-danger-600/50 bg-danger-600/5">
          <h1 className="text-base font-semibold text-danger-400">界面遇到了问题</h1>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            这次的错误发生在界面渲染阶段。已经下载到本机的模型和语音数据没有丢，
            重新加载通常就能继续。
          </p>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            如果反复出现，请把下面的错误信息截图反馈 —— 这比「打开是白的」有用得多。
          </p>
        </section>

        <pre className="max-h-64 overflow-auto rounded-xl border border-ink-700 bg-ink-900 p-3 text-[11px] leading-5 text-slate-400">
          {error.name}: {error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
        </pre>

        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" onClick={this.reload}>
            重新加载
          </button>
          <button type="button" className="btn-ghost" onClick={this.clearSessionState}>
            清除未完成会话的留存
          </button>
        </div>

        {this.state.cleared && (
          <p className="text-xs text-brand-400">
            已清除未完成会话的留存（模型缓存保留）。现在点「重新加载」。
          </p>
        )}
      </div>
    );
  }
}

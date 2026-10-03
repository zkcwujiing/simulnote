/**
 * Chrome / Edge 内置翻译（Translator API）适配。
 *
 * 这是桌面端质量最好、成本为零的翻译方案：语言包由浏览器管理，
 * 下载完成后**翻译过程完全不联网**，不向 Google 发送任何文本。
 *
 * 必须小心的坑（全部来自官方文档，已在设计文档 03 里记录）：
 *  1. `window.ai.translator` 已废弃且不可用，只能用全局 `Translator`。
 *  2. 同一个 `{sourceLanguage, targetLanguage}` 必须同时传给 `availability()` 和 `create()`。
 *  3. `availability()` 返回 `downloadable` 时，`create()` **必须由用户手势触发**，
 *     否则抛 `NotAllowedError`。因此本类的 `init()` 只能在按钮回调里调用。
 *  4. 该 API 不支持 Web Worker，只能在主线程用。
 *  5. 桌面 Chrome 138+ / Edge 148+ 才有；Android / iOS / Firefox / Safari 都没有。
 */

import type { EngineAvailability, MtEngine, ProgressFn } from '../types';
import { log } from '@/lib/logger';

type TranslatorAvailabilityStatus =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

interface TranslatorInstance {
  translate(text: string): Promise<string>;
  translateStreaming?(text: string): ReadableStream<string>;
  destroy?(): void;
}

interface TranslatorStatic {
  availability(options: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<TranslatorAvailabilityStatus>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (monitor: EventTarget) => void;
    signal?: AbortSignal;
  }): Promise<TranslatorInstance>;
}

function getTranslatorStatic(): TranslatorStatic | null {
  if (typeof globalThis === 'undefined') return null;
  const holder = globalThis as unknown as { Translator?: TranslatorStatic };
  return holder.Translator ?? null;
}

/** 目标语言候选：优先用简中通用码，新旧版本 Chrome 接受度不同。 */
const TARGET_CANDIDATES = ['zh', 'zh-Hans'];

export class ChromeTranslatorMtEngine implements MtEngine {
  readonly id = 'mt-chrome-builtin';
  readonly label = '浏览器内置翻译';
  readonly stage = 'mt' as const;
  readonly privacy = 'on-device' as const;
  /** 内置翻译是本地小模型，速度可观；这个值只用于 UI 预估 */
  readonly throughputHint = 600;

  private instance: TranslatorInstance | null = null;
  private resolvedTarget: string | null = null;
  private readonly sourceLanguage: string;
  private readonly preferredTarget: string;

  /** 翻译串行化：内置 API 在并发调用下会抛 QuotaExceededError */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(sourceLanguage = 'en', targetLanguage = 'zh') {
    this.sourceLanguage = sourceLanguage;
    this.preferredTarget = targetLanguage;
  }

  private candidateTargets(): string[] {
    const list = [this.preferredTarget, ...TARGET_CANDIDATES];
    return [...new Set(list)];
  }

  async probe(): Promise<EngineAvailability> {
    const api = getTranslatorStatic();
    if (!api) {
      return {
        status: 'unavailable',
        reason: '此浏览器没有内置翻译（需要桌面版 Chrome 138+ 或 Edge 148+）。',
      };
    }

    let last: TranslatorAvailabilityStatus = 'unavailable';
    for (const target of this.candidateTargets()) {
      try {
        const status = await api.availability({
          sourceLanguage: this.sourceLanguage,
          targetLanguage: target,
        });
        if (status === 'available') {
          return { status: 'ready' };
        }
        if (status === 'downloadable' || status === 'downloading') {
          this.resolvedTarget = target;
          return {
            status: status === 'downloading' ? 'downloading' : 'downloadable',
            progress: 0,
            bytes: 0,
            note: `英 → ${target === 'zh' ? '简体中文' : target} 语言包`,
          } as EngineAvailability;
        }
        last = status;
      } catch (err) {
        log.warn('mt', `内置翻译 availability 探测失败 target=${target}`, err);
      }
    }

    return {
      status: 'unavailable',
      reason:
        last === 'unavailable'
          ? '浏览器不支持英译中（可能是语言包缺失或硬件不满足内置翻译的要求）。'
          : '内置翻译当前不可用。',
    };
  }

  /**
   * 触发语言包下载 / 建立翻译器。
   * **必须在用户手势的调用栈里执行**（见类注释第 3 条）。
   */
  async init(onProgress?: ProgressFn): Promise<void> {
    if (this.instance) return;

    const api = getTranslatorStatic();
    if (!api) throw new Error('此浏览器没有内置翻译。');

    const targets = this.resolvedTarget
      ? [this.resolvedTarget, ...this.candidateTargets()]
      : this.candidateTargets();

    const failures: string[] = [];

    for (const target of [...new Set(targets)]) {
      try {
        const options = {
          sourceLanguage: this.sourceLanguage,
          targetLanguage: target,
        };

        const instance = await api.create({
          ...options,
          monitor: (monitor: EventTarget) => {
            monitor.addEventListener('downloadprogress', (event: Event) => {
              const loaded = (event as Event & { loaded?: number }).loaded ?? 0;
              const total = (event as Event & { total?: number }).total ?? 0;
              onProgress?.({
                progress: total > 0 ? loaded / total : null,
                label: `正在下载英译中语言包`,
                loadedBytes: loaded,
                totalBytes: total || null,
              });
            });
          },
        });

        this.instance = instance;
        this.resolvedTarget = target;
        log.info('mt', `内置翻译就绪 ${this.sourceLanguage} → ${target}`);
        return;
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === 'NotAllowedError') {
          throw new Error(
            '浏览器要求由你亲自点击按钮来触发语言包下载。请再点一次「开始」按钮。',
          );
        }
        failures.push(`${target}: ${(err as Error)?.message ?? String(err)}`);
        log.warn('mt', `内置翻译 create 失败 target=${target}`, err);
      }
    }

    throw new Error(`内置翻译初始化失败。\n${failures.join('\n')}`);
  }

  translate(text: string, signal?: AbortSignal): Promise<string> {
    const run = async (): Promise<string> => {
      if (!this.instance) throw new Error('内置翻译尚未就绪。');
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      const trimmed = text.trim();
      if (!trimmed) return '';
      return this.instance.translate(trimmed);
    };

    // 排队但不让上游因为队列而超时：队列本身只是防止并发。
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async translateBatch(texts: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const text of texts) {
      out.push(await this.translate(text));
    }
    return out;
  }

  async dispose(): Promise<void> {
    try {
      this.instance?.destroy?.();
    } catch {
      /* 浏览器自己会回收 */
    }
    this.instance = null;
  }
}

/**
 * 浏览器原生语音识别（Web Speech API）适配。
 *
 * 为什么它是移动端的默认首选：
 *  - 零下载、零等待，点一下就开始出字；
 *  - 原生给逐字草稿（interim results），体验上最接近「同传」；
 *  - Chrome for Android 与 iOS Safari 14.5+ 都支持。
 *
 * 代价（必须诚实告诉用户）：
 *  - 音频会被送到浏览器的语音服务（Chrome/Android 走 Google，Safari 走 Apple），
 *    也就是说这一环**不是** on-device。UI 上必须标「联网」。
 *  - 识别语言由浏览器决定，`lang='en-US'` 是唯一有效的英文档位。
 *  - `continuous` 在移动端常被浏览器单方面中断，必须自己重启。
 */

import type { FinalSegment, PartialSegment } from '@/types';
import type {
  AsrEngine,
  AsrHandlers,
  EngineAvailability,
  ProgressFn,
} from '../types';
import { log } from '@/lib/logger';

// --- 最小化的 Web Speech 类型声明 -----------------------------------------
// TS 的 DOM lib 至今没有收录 SpeechRecognition（它是 W3C 草案），所以自己声明。

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly isFinal: boolean;
  item(index: number): SpeechRecognitionAlternativeLike;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  item(index: number): SpeechRecognitionResultLike;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** 把浏览器的错误码转成中文可操作提示。 */
function explainError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '浏览器拒绝了语音识别权限。请检查地址栏的麦克风图标，允许本站使用麦克风后重试。';
    case 'no-speech':
      return '没有听到说话声。';
    case 'audio-capture':
      return '找不到可用的麦克风设备。';
    case 'network':
      return '语音识别需要联网，但当前网络不可用。可以改用「本地模型」模式。';
    case 'aborted':
      return '语音识别被中断。';
    case 'language-not-supported':
      return '浏览器不支持 en-US 语音识别。请改用「本地模型」模式。';
    default:
      return `语音识别出错（${code}）。`;
  }
}

export interface WebSpeechAsrOptions {
  lang?: string;
  /** 浏览器单方面结束识别后自动重启的间隔 */
  restartDelayMs?: number;
  /** 连续错误到达此数量后放弃，避免无限重启刷屏 */
  maxConsecutiveErrors?: number;
}

export class WebSpeechAsrEngine implements AsrEngine {
  readonly id = 'asr-webspeech';
  readonly label = '浏览器原生识别';
  readonly stage = 'asr' as const;
  readonly privacy = 'network' as const;

  readonly audioSource = 'self' as const;
  readonly supportsPartial = true;
  readonly supportsReplay = false;

  private recognition: SpeechRecognitionLike | null = null;
  private handlers: AsrHandlers | null = null;
  private active = false;
  private restartTimer: number | null = null;
  private consecutiveErrors = 0;
  private seq = 0;
  private finalizedChars = 0;

  private readonly lang: string;
  private readonly restartDelayMs: number;
  private readonly maxConsecutiveErrors: number;

  /** 会话起点（performance.now()），用于给段落打时间戳 */
  private originMs = 0;
  private lastEndMs = 0;

  constructor(options: WebSpeechAsrOptions = {}) {
    this.lang = options.lang ?? 'en-US';
    this.restartDelayMs = options.restartDelayMs ?? 250;
    this.maxConsecutiveErrors = options.maxConsecutiveErrors ?? 5;
  }

  async probe(): Promise<EngineAvailability> {
    const ctor = getCtor();
    if (!ctor) {
      return {
        status: 'unavailable',
        reason: '此浏览器没有内置语音识别（Firefox 与部分国产浏览器内核均不支持）。',
      };
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return { status: 'unavailable', reason: '语音识别需要 HTTPS 或 localhost 环境。' };
    }
    // 探测阶段绝不允许触发麦克风授权，只报告「理论上可用」。
    return { status: 'ready' };
  }

  async init(_onProgress?: ProgressFn): Promise<void> {
    const ctor = getCtor();
    if (!ctor) throw new Error('此浏览器没有内置语音识别。');
    if (!this.recognition) {
      const recognition = new ctor();
      recognition.lang = this.lang;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      this.recognition = recognition;
    }
    log.info('asr', `原生识别就绪 lang=${this.lang}`);
  }

  async start(handlers: AsrHandlers): Promise<void> {
    await this.init();
    this.handlers = handlers;
    this.active = true;
    this.consecutiveErrors = 0;
    this.seq = 0;
    this.finalizedChars = 0;
    this.originMs = performance.now();
    this.lastEndMs = 0;

    const recognition = this.recognition;
    if (!recognition) return;

    recognition.onresult = (event) => this.handleResult(event);
    recognition.onerror = (event) => this.handleError(event);
    recognition.onend = () => {
      // Chrome 在静音一段后会自己 onend；只要用户没喊停，就重启。
      if (this.active) this.scheduleRestart();
    };
    recognition.onstart = () => {
      this.consecutiveErrors = 0;
    };

    this.safeStart();
  }

  private safeStart(): void {
    try {
      this.recognition?.start();
    } catch (err) {
      // 连续 start() 会抛 InvalidStateError；忽略即可，onend 会兜底。
      const name = (err as { name?: string })?.name;
      if (name !== 'InvalidStateError') {
        log.warn('asr', '识别启动失败', err);
        this.handlers?.onError(new Error(explainError('aborted')));
      }
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer !== null) return;
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      if (this.active) this.safeStart();
    }, this.restartDelayMs);
  }

  private handleResult(event: SpeechRecognitionEventLike): void {
    const handlers = this.handlers;
    if (!handlers) return;

    const nowMs = performance.now() - this.originMs;

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const alternative = result[0];
      if (!alternative) continue;
      const text = alternative.transcript.trim();

      if (!result.isFinal) {
        if (!text) continue;
        const partial: PartialSegment = {
          id: `seg_${this.seq + 1}`,
          text,
          startMs: Math.round(this.lastEndMs),
        };
        handlers.onPartial(partial);
        continue;
      }

      if (!text) continue;

      // 有些实现会把已经 final 的结果重复投递，靠长度单调性去重。
      if (text.length <= this.finalizedChars && this.seq === 0) continue;

      this.seq += 1;
      const segment: FinalSegment = {
        id: `seg_${this.seq}`,
        text,
        startMs: Math.round(this.lastEndMs),
        endMs: Math.round(Math.max(nowMs, this.lastEndMs + 200)),
      };
      this.lastEndMs = segment.endMs;
      this.finalizedChars = text.length;

      handlers.onFinal(segment);
    }
  }

  private handleError(event: SpeechRecognitionErrorEventLike): void {
    const code = event.error;

    // no-speech / aborted 是常态（静音、自己调用 stop），不算故障。
    if (code === 'no-speech' || code === 'aborted') {
      log.debug('asr', `原生识别常态事件 ${code}`);
      return;
    }

    this.consecutiveErrors += 1;
    log.warn('asr', `原生识别错误 ${code}（第 ${this.consecutiveErrors} 次）`);

    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      this.active = false;
      this.handlers?.onError(new Error(explainError(code)));
      return;
    }

    this.handlers?.onError(new Error(explainError(code)));
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.restartTimer !== null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const recognition = this.recognition;
    if (recognition) {
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      try {
        recognition.stop();
      } catch {
        /* 已经停了 */
      }
    }
    this.handlers = null;
    log.info('asr', `原生识别已停止，共 ${this.seq} 句`);
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.recognition = null;
  }
}

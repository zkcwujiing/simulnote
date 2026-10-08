/**
 * 音频文件音源 —— 把用户上传的音频文件变成与麦克风路径**同样形状**的语音帧。
 *
 * 目标：上传一个已经录好的讲话（wav / mp3 / m4a / ogg / webm…），走完和实时采集
 * 完全相同的下游管线（VAD 切句 → 识别 → 翻译 → 纪要），最后产出字幕与纪要。
 *
 * ## 为什么必须和麦克风路径「同形状」
 *
 * 实时采集走 `src/lib/audio/capture.ts` + `public/pcm-worklet.js`，契约是
 * **16 kHz 单声道 Float32、每帧 1600 采样（100ms）**。文件路径如果产出别的形状，
 * 下游不会报错，只会**静默地算错**：
 *   - 采样率不对：`src/pipeline/translatorPipeline.ts:227` 的 `feedUtterance`
 *     以及 whisper 引擎都按 `samples.length / 16000` 换算秒数，48kHz 的数据会被
 *     当成 1/3 时长，时间戳全部错位。
 *   - 帧长不对：`src/lib/audio/vad.ts:94-97` 用 `frameMs = frameSize / sampleRate`
 *     把「帧数」当时间单位（`push()` 里 `this.elapsedMs += this.frameMs`，见
 *     `vad.ts:140`、`vad.ts:147`），`startFrames = 3` 和 `endSilenceMs = 700`
 *     （`vad.ts:48-55`）也全是按帧计的。如果一次塞 1 秒的块进去，它会把每秒当成
 *     100ms：时间戳缩小 10 倍，「连续 3 帧算开口」从 300ms 变成 3 秒，
 *     「静音 700ms 收尾」变成静音 7 秒才收尾 —— 不报错，但结果全错。
 *  所以帧长常量 `CHUNK_FRAMES = 1600` 是**照着 worklet 抄的**，不是随便定的。
 *
 * ## 解码与重采样
 * 不自己写解码器：容器（mp3/m4a/ogg）和编码格式太多，浏览器内置的解码器最全也最快。
 * `AudioContext.decodeAudioData` 拿到原始 PCM 后，用 `OfflineAudioContext` 以
 * 16000 Hz 单声道重渲染来完成重采样 + 混声道（stereo→mono 由音频图的
 * channelInterpretation 负责，比自己写平均更不容易错）。
 *
 * ## 分段渲染
 * 整段一次性重渲染（`OfflineAudioContext(1, 时长×16000, 16000)`）在手机上很危险：
 * 一个 2 小时文件的输出是 460MB Float32，而且渲染期间**拿不到任何进度**。
 * 所以按 `RENDER_SEGMENT_SEC` 分段渲染、边渲染边产帧 —— 峰值内存降到「一段」，
 * 进度也是真的在走。代价见 `RENDER_SEGMENT_SEC` 的注释。
 */

import { log } from '../logger';

/**
 * 目标采样率。**必须**与 `src/lib/audio/capture.ts:119` 的默认 `targetRate`、
 * `src/pipeline/translatorPipeline.ts:52` 的 `CAPTURE_SAMPLE_RATE` 相同：
 * 所有 ASR 引擎和 VAD 都把这个数当既定事实，不会去问音频里的真实采样率。
 */
export const FILE_SAMPLE_RATE = 16000;

/**
 * 每块采样数：1600 = 100ms，与 `public/pcm-worklet.js:21` 的 `frameSize` 默认值
 * 逐字一致（原因见文件头部）。调用方可以覆盖它，但**覆盖成 16000（1 秒）之前
 * 请先重读文件头**：那样必须自己再切成 1600 才能喂给 `UtteranceSegmenter`。
 */
export const CHUNK_FRAMES = 1600;

/**
 * 分段重渲染的长度：5 分钟。
 *
 * 为什么不是「整段一次渲染」：峰值内存和单次渲染耗时都和段长成正比；
 * 2 小时整段渲染 = 460MB 外加几十秒没有任何反馈。
 * 为什么不是更短（比如 5 秒）：每段都要新建一个 `OfflineAudioContext` 并重跑
 * 一次重采样器，段太短会让「边界」占比变高、总开销变大。
 *
 * **已知代价**：每段的重采样滤波器都是冷启动，段与段的交界处会丢掉几个采样点
 * （≪ 1ms 的音频），听感与识别都不受影响 —— 但这是取舍，不是没有代价。
 */
export const RENDER_SEGMENT_SEC = 300;

/**
 * 单次处理的时长上限：2 小时。
 *
 * 设立它的理由不是「转写会存下音频」——整段转写**只保留文字、不留音频**，
 * 内存里也不会积累整段音频。但处理时间与峰值内存都和时长成正比，
 * 而且手机上「解码整段」这一步本身就由 `decodeAudioData` 一次性占住
 * 原始采样率的 PCM（2 小时 48kHz 立体声 ≈ 2.7GB），超过这个长度基本必然失败。
 * 与其让它崩在内存不足上，不如在拿到时长时就明确拒绝，并告诉用户剪开再传。
 */
export const MAX_FILE_DURATION_SEC = 7200;

/** 失败原因分类。给 UI 用：不同原因要展示不同的下一步建议。 */
export type AudioFileErrorCode =
  | 'unsupported-format'
  | 'no-audio'
  | 'too-long'
  | 'memory'
  | 'decode-failed'
  | 'cancelled';

/**
 * 音频文件相关的错误。带 `code` 与 `hint`（可执行的中文建议），
 * 绝不让 `decodeAudioData` 的 `DOMException`（英文、面向开发者）冒到界面上。
 *
 * 类字段显式声明 + 构造函数体内赋值：测试跑在 Node 的类型擦除模式下，
 * **构造函数参数属性**（`constructor(private x: T)`）会抛
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，这里刻意不用。
 */
export class AudioFileError extends Error {
  readonly code: AudioFileErrorCode;
  /** 一句可执行的中文建议（换格式 / 剪短 / 重试…），可直接显示在按钮下面。 */
  readonly hint: string;

  constructor(code: AudioFileErrorCode, message: string, hint: string) {
    super(message);
    this.name = 'AudioFileError';
    this.code = code;
    this.hint = hint;
  }
}

/** 解码成功的结果。**保留原始采样率的 AudioBuffer**，重采样在产帧时按段做。 */
export interface AudioFileInfo {
  /** 浏览器解出来的原始 PCM（原始采样率、原始声道数） */
  buffer: AudioBuffer;
  /** 原始声道数（用于提示「这是立体声，已按单声道处理」） */
  channels: number;
  /** 原始采样率 */
  sampleRate: number;
  /** 时长（秒） */
  durationSec: number;
}

/** 一块产出。`samples` 与麦克风路径的帧完全同形：16kHz 单声道 Float32。 */
export interface AudioFileChunk {
  /** 16kHz 单声道，长度 = CHUNK_FRAMES（最后一块可能短） */
  samples: Float32Array;
  /** 第几块，从 0 开始 */
  index: number;
  /** 本块第一个采样在整段里的位置（采样数，按 16kHz 计） */
  offsetFrames: number;
  /** 整段总采样数（16kHz 计），配合 offsetFrames 可算剩余时间 */
  totalFrames: number;
  /** 本块产出之后的进度 0~1，最后一块恰好为 1 */
  progress: number;
}

export interface AudioFileSourceOptions {
  /**
   * 进度回调（0~1）。**必须有这个东西**：手机上处理一个 30 分钟的文件要几十秒，
   * 没有进度用户会以为页面卡死 —— 这和 `README.md` 里记录的
   * 「下载进度条在准备阶段消失」是同一类问题（有进度却没更新，比没有更糟）。
   * 回调按「整数百分比变化」节流，见 `streamDecodedAudio`。
   */
  onProgress?: (ratio: number) => void;
  /**
   * 取消信号。用户完全可能传一个 2 小时的文件然后想停下。
   * 触发后生成器会抛出 `AudioFileError('cancelled')`；用 `break` 跳出
   * `for await` 循环同样是取消（生成器会被 `return()` 掉）。
   */
  signal?: AbortSignal;
  /** 覆盖每块采样数。默认 `CHUNK_FRAMES`；改成非 1600 前请读文件头。 */
  chunkFrames?: number;
  /** 覆盖目标采样率。默认 `FILE_SAMPLE_RATE`；同样不建议改。 */
  targetRate?: number;
  /** 覆盖分段渲染长度（秒）。默认 `RENDER_SEGMENT_SEC`。 */
  segmentSec?: number;
}

// ───────────────────────────── 纯函数（可在 Node 里单测） ─────────────────────────────
// Node 里没有 AudioContext / OfflineAudioContext，所以凡是「能用纯函数表达」的逻辑
// 一律抽出来单独放：分块、进度、时长格式化、上限判定。这样核心逻辑有测试兜底，
// 而真正需要浏览器的解码与重采样只留薄薄一层胶水。

/**
 * 把一整段 Float32 音频切成若干块。
 *
 * 返回的是 `subarray` **视图而不是拷贝**：一个 2 小时的文件是 4.6 亿个采样，
 * 拷贝一遍等于白白多占一倍内存，而下游只读不写。
 *
 * @param samples     原始音频
 * @param chunkFrames 每块采样数，必须 ≥ 1（否则会死循环，所以直接抛错）
 */
export function chunkFrames(samples: Float32Array, chunkFrames: number): Float32Array[] {
  if (!Number.isFinite(chunkFrames) || chunkFrames < 1) {
    throw new RangeError(`chunkFrames 必须是 ≥ 1 的有限数，收到 ${chunkFrames}`);
  }
  const size = Math.floor(chunkFrames);
  const out: Float32Array[] = [];
  for (let start = 0; start < samples.length; start += size) {
    out.push(samples.subarray(start, Math.min(start + size, samples.length)));
  }
  return out;
}

/**
 * 把秒数格式化成中文时长，给 UI 用（「还剩 3 分 20 秒」）。
 *
 * 规则：不满 1 分钟只说秒（「59 秒」比「0 分 59 秒」自然），满 1 分钟说「N 分 SS 秒」。
 * 取整用 `Math.floor`：倒计时/进度上「显示 59 秒但还没结束」比「显示 1 分却停住」好。
 * 负数、NaN、Infinity 一律兜底成「0 秒」—— 上游可能还没算出时长就渲染了。
 */
export function formatDurationZh(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  if (safe < 60) return `${safe} 秒`;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes} 分 ${String(rest).padStart(2, '0')} 秒`;
}

/**
 * 时长是否超过上限（边界：**恰好等于上限算通过**）。
 *
 * 长度未知（NaN / Infinity）一律算超限：这个判断的用途是「要不要放行一段可能
 * 吃掉几百 MB 内存的处理」，拿不准的时候必须拒绝，而不是乐观放行。
 */
export function exceedsMaxDuration(
  durationSec: number,
  maxSec: number = MAX_FILE_DURATION_SEC,
): boolean {
  if (!Number.isFinite(durationSec)) return true;
  return durationSec > maxSec;
}

// ───────────────────────────── 浏览器侧：解码 / 重采样 / 产帧 ─────────────────────────────

/** 取消检查。抽出来是为了在「解码前 / 每段渲染前 / 每块产出前」用同一套语义。 */
function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AudioFileError('cancelled', '已取消处理这个音频文件。', '可以重新选择文件再试。');
  }
}

/**
 * 把解码阶段的各种失败翻译成中文。
 *
 * 至少区分两类（其余归入泛化错误）：
 *   ① 浏览器解不开这个格式 → 让用户换格式（wav / mp3 最稳）；
 *   ② 文件里没有可用的音频（0 时长 / 0 声道）→ 让用户确认文件里真有声音。
 * 另外单独识别内存不足：长文件最常见的真实死因就是它，说「格式不对」会把人带偏。
 * 原始英文信息只进日志，不进 UI（与 `src/lib/errors.ts` 的约定一致）。
 */
function describeDecodeFailure(err: unknown): AudioFileError {
  if (err instanceof AudioFileError) return err;

  const name = err instanceof Error ? err.name : '';
  const text = err instanceof Error ? err.message : String(err);
  log.warn('audio', '音频文件解码失败', err);

  if (err instanceof RangeError || /allocation|out of memory|\boom\b/i.test(text)) {
    return new AudioFileError(
      'memory',
      '音频太大，浏览器内存不够用了。',
      '换一段更短的音频，或者先把它压缩成单声道 mp3 再试。',
    );
  }
  if (name === 'EncodingError' || name === 'NotSupportedError') {
    return new AudioFileError(
      'unsupported-format',
      '浏览器打不开这个音频文件，可能是格式或编码不支持。',
      '换一种格式再试（wav / mp3 兼容性最好），或者先用播放器把它重新导出一次。',
    );
  }
  return new AudioFileError(
    'decode-failed',
    '解码音频时出错了，这个文件可能已经损坏。',
    '换一种格式再试（wav / mp3），或者重新导出这个文件。',
  );
}

/**
 * 建一个只用于解码的 `AudioContext`。
 * 单独抽出来是因为 `new AudioContext()` 本身也会抛（音频设备被占满等），
 * 这个错误同样得变成中文。
 */
function createDecodeContext(): AudioContext {
  try {
    return new AudioContext();
  } catch (err) {
    log.warn('audio', '无法创建 AudioContext', err);
    throw new AudioFileError(
      'decode-failed',
      '无法启动浏览器的音频解码器。',
      '请关掉其它正在播放或录音的标签页后重试。',
    );
  }
}

/**
 * 解码音频文件，拿到原始 PCM。**不重采样**，重采样在产帧时按段做。
 *
 * 解码用的 `AudioContext` 用完必须 `close()`（放在 finally 里）：
 * 手机上不关掉它会一直占着一个音频输出设备，别的页面/通话会变得没声音或者音质降级；
 * 这个上下文只是用来解码，一张图都不用跑，留着没有任何意义。
 *
 * UI 可以先用它拿到时长（显示「共 12 分 30 秒」、判断是否超上限），
 * 再把同一个 `AudioFileInfo` 交给 `streamDecodedAudio` —— **不要**解码两次，
 * 长文件的解码要几十秒。
 */
export async function decodeAudioFile(file: Blob, signal?: AbortSignal): Promise<AudioFileInfo> {
  checkAborted(signal);

  if (file.size === 0) {
    throw new AudioFileError(
      'no-audio',
      '这个文件是空的（0 字节）。',
      '请重新选择文件 —— 看起来它没有上传完整。',
    );
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (err) {
    log.warn('audio', '读取文件内容失败', err);
    throw new AudioFileError(
      'decode-failed',
      '读不出这个文件的内容，它可能已经被移动或删除了。',
      '请重新选择文件再试。',
    );
  }

  checkAborted(signal);
  const context = createDecodeContext();
  try {
    let buffer: AudioBuffer;
    try {
      buffer = await context.decodeAudioData(bytes);
    } catch (err) {
      throw describeDecodeFailure(err);
    }
    return validateDecoded(buffer);
  } finally {
    // 失败路径也必须关：不然每失败一次就泄漏一个音频输出设备。
    await context.close().catch(() => undefined);
  }
}

/** 校验解码结果。分开写是为了让 `decodeAudioFile` 的 try/finally 保持短小。 */
function validateDecoded(buffer: AudioBuffer): AudioFileInfo {
  const durationSec = buffer.duration;
  if (
    buffer.numberOfChannels < 1 ||
    buffer.length < 1 ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0
  ) {
    // 有些「能解码但没有声音」的容器（截断的 webm、纯视频轨）会走到这里。
    throw new AudioFileError(
      'no-audio',
      '这个文件里没有可用的音频（时长是 0）。',
      '确认文件里确实有声音：换一种格式重新导出（wav / mp3），或者先用播放器听一下。',
    );
  }

  if (exceedsMaxDuration(durationSec)) {
    throw new AudioFileError(
      'too-long',
      `这段音频有 ${formatDurationZh(durationSec)}，超过了单次 ${formatDurationZh(MAX_FILE_DURATION_SEC)} 的上限。`,
      '请把它剪成几段分别处理 —— 转写只保留文字不保留音频，但处理时间和内存都和时长成正比。',
    );
  }

  log.info(
    'audio',
    `音频文件已解码 ${durationSec.toFixed(1)}s ${buffer.sampleRate}Hz ${buffer.numberOfChannels}ch`,
  );
  return {
    buffer,
    channels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
    durationSec,
  };
}

/**
 * 只用浏览器音频图做重采样：把 `[startFrame, startFrame + frameCount)` 这段
 * 从原始采样率重渲染成 16kHz 单声道。
 *
 * - 声道合并交给音频图的 channelInterpretation（stereo → mono 是标准下混），
 *   自己写平均容易在 5.1、单声道这些情况上出错。
 * - 用 `OfflineAudioContext` 而不是手写线性插值：手写对 44.1k→16k 这种
 *   非整数比率的做法就是「隔点取样」，会引入明显混叠，识别率会掉。
 * - `source.start(0, offset)` 只给 offset、不给 duration：离线上下文渲染到
 *   指定长度就会停，少一个参数少一处浏览器兼容坑。
 */
async function renderSegmentTo16k(
  source: AudioBuffer,
  startFrame: number,
  frameCount: number,
  targetRate: number,
): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, frameCount, targetRate);
  const node = context.createBufferSource();
  node.buffer = source;
  node.connect(context.destination);
  node.start(0, startFrame / targetRate);
  const rendered = await context.startRendering();
  return rendered.getChannelData(0);
}

/**
 * 把已经解码好的音频按块产出来（异步生成器，逐块 yield）。
 *
 * 与 `readAudioFile` 分开，是为了让「先解码拿时长、再产帧」的 UI 不必解码两次。
 *
 * 取消：传 `options.signal`，或者直接在 `for await` 里 `break`。
 * `break` 会触发生成器的 `return()`，渲染循环当场停住；解码上下文早已关掉，
 * 所以没有需要额外释放的资源（这也是把 `close()` 放进 `decodeAudioFile` 的原因）。
 */
export async function* streamDecodedAudio(
  info: AudioFileInfo,
  options: AudioFileSourceOptions = {},
): AsyncGenerator<AudioFileChunk, void, void> {
  const targetRate = options.targetRate ?? FILE_SAMPLE_RATE;
  const chunkSize = Math.max(1, Math.floor(options.chunkFrames ?? CHUNK_FRAMES));
  const segmentFrames = Math.max(
    chunkSize,
    Math.round((options.segmentSec ?? RENDER_SEGMENT_SEC) * targetRate),
  );
  const totalFrames = Math.max(1, Math.round(info.durationSec * targetRate));

  let sentFrames = 0;
  let index = 0;
  // 进度节流：只在「整数百分比变了」时回调。整段 2 小时有 4500 块，
  // 块块回调等于给 React 灌 4500 次 setState，反而会拖慢处理；
  // 按百分比节流后最多 101 次，进度条照样是连续走的。
  let lastPercent = -1;

  for (let start = 0; start < totalFrames; start += segmentFrames) {
    checkAborted(options.signal);
    const count = Math.min(segmentFrames, totalFrames - start);
    const segment = await renderSegmentTo16k(info.buffer, start, count, targetRate);
    checkAborted(options.signal);

    for (const samples of chunkFrames(segment, chunkSize)) {
      checkAborted(options.signal);
      const offsetFrames = sentFrames;
      sentFrames += samples.length;
      const progress = Math.min(1, sentFrames / totalFrames);

      const percent = Math.floor(progress * 100);
      if (percent !== lastPercent || progress >= 1) {
        lastPercent = percent;
        options.onProgress?.(progress);
      }

      yield { samples, index, offsetFrames, totalFrames, progress };
      index += 1;
    }
  }
}

/**
 * 一步到位：解码一个音频文件，并逐块产出 16kHz 单声道帧。
 *
 * ```ts
 * const controller = new AbortController();
 * for await (const chunk of readAudioFile(file, { signal: controller.signal, onProgress: setRatio })) {
 *   segmenter.push(chunk.samples);   // 与麦克风路径完全同形
 * }
 * ```
 */
export async function* readAudioFile(
  file: Blob,
  options: AudioFileSourceOptions = {},
): AsyncGenerator<AudioFileChunk, void, void> {
  const info = await decodeAudioFile(file, options.signal);
  yield* streamDecodedAudio(info, options);
}

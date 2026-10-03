/**
 * 麦克风采集。
 *
 * 默认走 AudioWorklet（`public/pcm-worklet.js`），产出 16kHz / 100ms 的 Float32 帧。
 * Safari < 14.1 与部分旧 Android WebView 没有 AudioWorklet，降级到
 * ScriptProcessorNode —— 已废弃但在这些浏览器上仍可用，且我们只需要它跑通。
 *
 * 关键约束（与设计文档 03/04 一致）：
 *  - 必须 HTTPS 或 localhost。否则 getUserMedia 直接不存在，由 errors.ts 转成中文提示。
 *  - 不录音、不落盘、不上传：帧在内存里交给 pipeline，用完即弃。
 */

import { log } from '../logger';

export interface CaptureOptions {
  /** 目标采样率，固定 16000 —— 所有 ASR 引擎都按这个假设收音频 */
  targetRate?: number;
  /** 每帧采样数，默认 1600（100ms） */
  frameSize?: number;
  /** 关掉浏览器侧处理会拿到更"原始"的音频，但回声/噪声会更糟；默认全开 */
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  /** 指定输入设备；不传则用系统默认 */
  deviceId?: string;
}

export interface CaptureHandle {
  /** 实际生效的目标采样率 */
  readonly targetRate: number;
  /** 停止采集并释放麦克风 */
  stop(): Promise<void>;
  /** 暂停/恢复向回调投递音频（保持麦克风与音频图存活，避免反复申请权限） */
  setMuted(muted: boolean): void;
  /** 是否正在使用降级的 ScriptProcessor 路径 */
  readonly usingFallback: boolean;
}

export type FrameHandler = (frame: Float32Array) => void;

const WORKLET_URL = `${import.meta.env.BASE_URL}pcm-worklet.js`;

/**
 * 打开麦克风并开始投递音频帧。
 * 抛出的错误保持原始类型（NotAllowedError 等），由调用方统一转中文。
 */
export async function startCapture(
  onFrame: FrameHandler,
  options: CaptureOptions = {},
): Promise<CaptureHandle> {
  const targetRate = options.targetRate ?? 16000;
  const frameSize = options.frameSize ?? 1600;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException('当前环境没有 getUserMedia', 'NotFoundError');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: options.echoCancellation ?? true,
      noiseSuppression: options.noiseSuppression ?? true,
      autoGainControl: options.autoGainControl ?? true,
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
    },
    video: false,
  });

  // 尽量直接要 16kHz 的上下文，这样 worklet 里 ratio=1，没有重采样损耗。
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: targetRate });
  } catch {
    context = new AudioContext();
  }

  if (context.state === 'suspended') {
    await context.resume().catch(() => undefined);
  }

  const source = context.createMediaStreamSource(stream);

  // 无论走哪条路径，最后都接到一个 0 增益节点再进 destination：
  // AudioWorkletNode 若不接下游，Chrome 会认为该分支不需要计算而停止回调。
  const sink = context.createGain();
  sink.gain.value = 0;
  sink.connect(context.destination);

  const cleanup: Array<() => void> = [
    () => stream.getTracks().forEach((t) => t.stop()),
    () => sink.disconnect(),
    () => source.disconnect(),
    () => void context.close().catch(() => undefined),
  ];

  let muted = false;
  let stopped = false;

  const canWorklet = typeof context.audioWorklet !== 'undefined' && typeof AudioWorkletNode !== 'undefined';

  if (canWorklet) {
    try {
      await context.audioWorklet.addModule(WORKLET_URL);
      const node = new AudioWorkletNode(context, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { targetRate, frameSize },
      });

      node.port.onmessage = (event: MessageEvent) => {
        if (muted || stopped) return;
        const frame = event.data as Float32Array;
        if (frame && frame.length) onFrame(frame);
      };

      source.connect(node);
      node.connect(sink);
      cleanup.push(() => {
        node.port.onmessage = null;
        node.disconnect();
      });

      log.info('audio', `采集已启动 worklet rate=${context.sampleRate} target=${targetRate}`);
      return makeHandle(targetRate, false);
    } catch (err) {
      log.warn('audio', 'AudioWorklet 加载失败，降级到 ScriptProcessor', err);
    }
  }

  // ---- 降级路径 ----
  const bufferSize = pickScriptProcessorSize(context.sampleRate, frameSize);
  const processor = context.createScriptProcessor(bufferSize, 1, 1);
  let remaining: number[] = [];

  processor.onaudioprocess = (event) => {
    if (muted || stopped) return;
    const input = event.inputBuffer.getChannelData(0);
    // 这里只做简单的线性重采样；精度要求不高，因为这条路只服务老浏览器。
    const ratio = context.sampleRate / targetRate;
    const outCount = Math.floor((remaining.length + input.length) / ratio);
    if (outCount <= 0) {
      remaining.push(...Array.from(input));
      return;
    }
    const merged = new Float32Array(remaining.length + input.length);
    merged.set(remaining, 0);
    merged.set(input, remaining.length);

    const produced = new Float32Array(outCount);
    for (let i = 0; i < outCount; i++) {
      const pos = i * ratio;
      const base = Math.floor(pos);
      const frac = pos - base;
      const a = merged[base] ?? 0;
      const b = merged[base + 1] ?? a;
      produced[i] = a + (b - a) * frac;
    }
    const consumed = Math.floor(outCount * ratio);
    remaining = Array.from(merged.subarray(consumed));
    onFrame(produced);
  };

  source.connect(processor);
  processor.connect(sink);
  cleanup.push(() => {
    processor.onaudioprocess = null;
    processor.disconnect();
  });

  log.warn('audio', `采集降级到 ScriptProcessor rate=${context.sampleRate} buffer=${bufferSize}`);
  return makeHandle(targetRate, true);

  function makeHandle(rate: number, usingFallback: boolean): CaptureHandle {
    return {
      targetRate: rate,
      usingFallback,
      setMuted(next: boolean) {
        muted = next;
        if (usingFallback) return;
        // mute 只影响是否投递；真正停麦在 stop() 里做。
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        for (const fn of cleanup.reverse()) {
          try {
            fn();
          } catch {
            /* 释放失败不影响主流程 */
          }
        }
        log.info('audio', '采集已停止');
      },
    };
  }
}

/** createScriptProcessor 只接受 256 的倍数，且不能太小否则爆音。 */
function pickScriptProcessorSize(sampleRate: number, frameSize: number): number {
  const ideal = Math.max(256, Math.round((frameSize / 16000) * sampleRate));
  const rounded = Math.ceil(ideal / 256) * 256;
  return Math.min(16384, Math.max(256, rounded));
}

/**
 * 把任意采样率的 Float32 重采样成 16kHz。
 * 主要用于「导入音频文件」和「测试向量」两条路径。
 */
export function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === 16000) return input;
  const ratio = inputRate / 16000;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const base = Math.floor(pos);
    const frac = pos - base;
    const a = input[base] ?? 0;
    const b = input[base + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 采集设备枚举，供设置面板选择。无权限时 label 为空字符串。 */
export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

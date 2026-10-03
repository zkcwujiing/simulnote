/** 把任意抛出物转成可展示的中文错误信息。绝不把原始英文堆栈丢给用户。 */

/**
 * 把任意抛出物转成可展示的中文错误信息。绝不把原始英文堆栈丢给用户。
 *
 * `context` 是可选的前缀（例如「启动失败」）。加上它，用户才知道是**哪一步**出错，
 * 而不是只看到一句孤立的「模型下载失败」。
 */
export function toChineseError(err: unknown, context?: string): string {
  const message = describeError(err);
  return context ? `${context}：${message}` : message;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message || '';
    const name = err.name || '';

    if (name === 'NotAllowedError' || /permission|denied/i.test(msg)) {
      return '没有拿到麦克风权限。请在浏览器地址栏左侧的权限图标里允许「麦克风」，然后重试。';
    }
    if (name === 'NotFoundError' || /no.*device|device.*not.*found/i.test(msg)) {
      return '没有检测到麦克风设备。请确认麦克风已插好并已在系统里启用。';
    }
    if (name === 'NotReadableError') {
      return '麦克风被其他程序占用了。请关掉正在录音的软件（会议软件、录音机等）后重试。';
    }
    if (name === 'AbortError') {
      return '操作被中断了。';
    }
    if (/secure context|https/i.test(msg)) {
      return '当前页面不是 HTTPS。浏览器只允许在 HTTPS 或 localhost 下使用麦克风。';
    }
    if (/out of memory|OOM|Array buffer allocation failed/i.test(msg)) {
      return '设备内存不足。请关掉其他标签页，或改用「轻量模式」后再试。';
    }
    if (/failed to fetch|network|NetworkError|Load model/i.test(msg)) {
      return '模型下载失败。请检查网络后重试 —— 已经下载的部分会保留，不会白下。';
    }
    if (msg) return msg;
  }
  if (typeof err === 'string' && err) return err;
  return '发生了未预期的错误。';
}

/** 把字节数格式化成人类可读 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

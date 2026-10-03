/**
 * 极简日志。刻意不接任何远端上报服务 —— 零成本与隐私都是硬约束。
 * 只在控制台输出，生产构建下 debug 级别会被静默。
 */

const isDev = import.meta.env.DEV;

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export const log = {
  debug(scope: string, ...args: unknown[]): void {
    if (isDev) console.debug(`%c[${ts()}] ${scope}`, 'color:#64748b', ...args);
  },
  info(scope: string, ...args: unknown[]): void {
    console.info(`%c[${ts()}] ${scope}`, 'color:#38bdf8', ...args);
  },
  warn(scope: string, ...args: unknown[]): void {
    console.warn(`[${ts()}] ${scope}`, ...args);
  },
  error(scope: string, ...args: unknown[]): void {
    console.error(`[${ts()}] ${scope}`, ...args);
  },
};

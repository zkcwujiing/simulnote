/**
 * 模型的来源：**本站自己的 `/models/`，运行时不碰任何外部服务。**
 *
 * 背景（2026 实测，本机普通家宽、无代理）：
 *   - `huggingface.co`           0/3 成功（DNS 被污染成 59.188.250.54 这类无效地址）
 *   - `cdn-lfs.huggingface.co`   TCP 443 不通 —— 模型权重正是从这里下
 *   - `hf-mirror.com`            10/10 成功（只在构建机上用，见 scripts/fetch-models.mjs）
 *   - `pages.github.com`         10/10 成功
 *
 * 所以原先「浏览器直接去 Hugging Face 拉模型」的设计在国内等于**打开就是砖**：
 * 站点能部署成功，用户却卡在「正在下载模型」，最后退化成「只转写、不翻译」。
 * 现在改成构建期把模型拉进 `public/models/`，随站点一起发出去。
 *
 * 三条必须同时成立的设置，缺一条就会退回远程下载：
 *   1. `allowLocalModels = true` —— 浏览器里它**默认是 false**
 *      （transformers.web.js:135 `allowLocalModels: !(IS_BROWSER_ENV || ...)`）。
 *   2. `localModelPath` 必须带上 Vite 的 base 前缀。transformers.js 取的是
 *      `pathJoin(env.localModelPath, '<组织>/<模型>/<文件名>')`，然后直接 `fetch()`。
 *      GitHub Pages 项目站部署在 `/<仓库名>/` 下，写死 `/models/` 会全部 404。
 *   3. `allowRemoteModels = false` —— 这是**护栏**：万一清单里少了某个文件，
 *      要立刻报错，而不是悄悄回落到 huggingface.co 然后在用户那儿超时。
 *
 * 模型清单在 `scripts/fetch-models.mjs`，改候选表就要同步改它。
 */

interface TransformersEnvLike {
  allowLocalModels?: boolean;
  allowRemoteModels?: boolean;
  useBrowserCache?: boolean;
  localModelPath?: string;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

/** 站点里存放模型的目录名（相对站点根）。与 scripts/fetch-models.mjs 的输出目录一致。 */
const MODEL_DIR = 'models';

/**
 * 抓取日志 —— 每一条 transformers.js 发出的真实网络请求。
 *
 * 为什么需要它：真机上出现过 `TypeError: Load failed`，而那句话**不告诉你是谁失败了**。
 * 报告里只能看到「模型加载失败」，于是排查方向被误导到模型文件、跨域、路径上去，
 * 实际却是运行时被送到了第三方 CDN。有了这份日志，失败的那一条 URL 会直接印在报告里。
 *
 * 记录上限 200 条，只保留最近 8 条用于展示。
 */
export interface FetchRecord {
  url: string;
  status: number | null;
  ok: boolean;
  bytes: number | null;
  ms: number;
  error: string | null;
}

const FETCH_LOG_LIMIT = 200;
let fetchLog: FetchRecord[] = [];

export function resetFetchLog(): void {
  fetchLog = [];
}

export function fetchLogTail(n = 8): FetchRecord[] {
  return fetchLog.slice(-n);
}

/** 把最近几条请求压成一段可读文本，直接塞进报告。 */
export function fetchLogText(n = 8): string {
  const tail = fetchLogTail(n);
  if (tail.length === 0) return '（这次没有任何网络请求）';
  return tail
    .map((r) => {
      const size = r.bytes === null ? '?' : `${(r.bytes / 1048576).toFixed(1)}MB`;
      const head = r.error ? `✗ ${r.error}` : `${r.status} ${r.ok ? 'ok' : 'bad'} ${size}`;
      return `${head}  ${r.ms}ms  ${r.url}`;
    })
    .join('\n');
}

/** 站点根路径，带结尾斜杠。Vite 注入的 BASE_URL 已经保证了这一点，这里只做兜底。 */
export function siteBase(): string {
  const base = import.meta.env.BASE_URL;
  const value = typeof base === 'string' && base.length > 0 ? base : '/';
  return value.endsWith('/') ? value : `${value}/`;
}

/** 模型的绝对路径（相对站点根），例如 `/` 或 `/simulnote/` + `models/`。 */
export function localModelPath(): string {
  return `${siteBase()}${MODEL_DIR}/`;
}

/**
 * 把「模型只从本站读」写进 transformers.js 的 env。
 * 必须在任何 `pipeline()` 调用**之前**执行。
 */
export function configureModelSource(env: unknown): void {
  const target = env as TransformersEnvLike;
  target.allowLocalModels = true;
  target.allowRemoteModels = false;
  // 仍然走 Cache Storage：本地文件也缓存一份，二次访问少一次网络往返，
  // 而且手机从后台切回来时不会因为重新解析 40MB 的 onnx 而卡住。
  target.useBrowserCache = true;
  target.localModelPath = localModelPath();
  instrumentFetch(target);
}

/** 已经被包过一次的 env 打个标记，避免重复包装（包装层会叠加计时）。 */
const WRAPPED = Symbol.for('simulnote.fetchWrapped');

/**
 * 把 `env.fetch` 换成一个记账版本。
 *
 * 失败时**原样抛出**原来的错误 —— 我们只想记录，不想改变 transformers.js 的错误处理。
 * 这份日志由探针页读出来写进报告。
 */
export function instrumentFetch(env: unknown): void {
  const target = env as TransformersEnvLike & { [WRAPPED]?: boolean };
  if (target[WRAPPED]) return;
  const original =
    target.fetch ??
    (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (!original) return;

  target.fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : String(input);
    const startedAt = Date.now();
    try {
      const response = await original(input, init);
      const declared = Number(response.headers.get('content-length'));
      fetchLog.push({
        url: href,
        status: response.status,
        ok: response.ok,
        bytes: Number.isFinite(declared) ? declared : null,
        ms: Date.now() - startedAt,
        error: null,
      });
      trimLog();
      return response;
    } catch (err) {
      const e = err as { name?: string; message?: string };
      fetchLog.push({
        url: href,
        status: null,
        ok: false,
        bytes: null,
        ms: Date.now() - startedAt,
        error: `${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`,
      });
      trimLog();
      throw err;
    }
  };
  target[WRAPPED] = true;
}

function trimLog(): void {
  if (fetchLog.length > FETCH_LOG_LIMIT) {
    fetchLog = fetchLog.slice(-FETCH_LOG_LIMIT);
  }
}

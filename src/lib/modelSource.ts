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
}

/** 站点里存放模型的目录名（相对站点根）。与 scripts/fetch-models.mjs 的输出目录一致。 */
const MODEL_DIR = 'models';

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
}

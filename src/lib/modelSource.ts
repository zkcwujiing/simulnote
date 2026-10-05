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
  /** 取数方式的一句话说明：走了缓存 / 分块下到几 MB / 为什么重试。 */
  note?: string | null;
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
      // 只留文件名，完整路径太长会把报告撑爆。
      const name = r.url.split('/').pop() ?? r.url;
      const note = r.note ? `\n      ↳ ${r.note}` : '';
      return `${head}  ${r.ms}ms  ${name}${note}`;
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
  // **故意关掉** transformers.js 自带的 Cache Storage。
  //
  // 它读缓存时只做一件事：`caches.match(request)` 命中就**直接返回，不校验长度**。
  // 真机实测（2026/10/5，iPhone Safari）出现 `TypeError: Load failed`，而 opus 的
  // 编码器单文件 50.6 MB，中途断线留下的**半截文件会被永久缓存**，之后每次启动都
  // 直接命中那个坏条目、连网络都不发 —— 表现为「删了缓存就好、不清就永远坏」。
  // 所以缓存改由本文件的 `cachedModelFetch` 自己管：写进去的一定是校验过长度的完整文件，
  // 读出来长度对不上就当场删掉重下。
  target.useBrowserCache = false;
  target.localModelPath = localModelPath();
  instrumentFetch(target);
  // 顺手清掉旧版本留下的、来源不可信的缓存（不影响本次加载，失败也无所谓）。
  void dropLegacyCache();
}

/**
 * 清掉 transformers.js 那份旧缓存里的**模型文件**条目。
 *
 * 它读缓存时不校验长度，一次断线留下的半截 `.onnx` 会被永久命中。
 *
 * **但只删 `/models/` 下的东西**：ORT 运行时的 `.mjs` / `.wasm` 也存在同一个缓存里
 * （`env.useWasmCache` 默认开），把它们一并删掉会害得**每次打开都重下 26.8 MB wasm** ——
 * 那是比原问题更糟的回归。
 */
async function dropLegacyCache(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    if (!(await caches.has(LEGACY_CACHE_NAME))) return;
    const cache = await caches.open(LEGACY_CACHE_NAME);
    const keys = await cache.keys();
    await Promise.all(
      keys.filter((req) => req.url.includes('/models/')).map((req) => cache.delete(req)),
    );
  } catch {
    // 没有 Cache Storage（隐私模式 / 非安全上下文）就不用管
  }
}

/* ------------------------------------------------------------------ *
 * 分块下载 + 自管缓存
 *
 * 为什么不能只写 `fetch(url)` 了事（2026/10/5 真机实测的完整链路）：
 *
 *   GitHub Pages 会对 `.onnx` 做 gzip。opus 编码器真实 52,899,742 字节，
 *   线上 `Content-Length` 只有 37,142,901 且带 `Content-Encoding: gzip`
 *   —— 也就是说浏览器要在**一次**长连接里收完 37 MB 压缩流、再解压成 50 MB。
 *   iPhone Safari 上这条路走不通：裸取探测（绕开 transformers 和 ORT 直取）
 *   只收到 4.5 MB 就断，报的就是 `TypeError: Load failed`。
 *
 *   而 `Range` 请求是另一条路：**服务端一旦看到 Range 就不下发压缩**，
 *   返回的是「未压缩文件的字节区间」，`Content-Range` 里还带着真实总长度。
 *
 * 所以 `.onnx` 一律走 `Range` 分块：每块 2 MB，任何一块断了只重下那一块，
 * 连续失败就把块体积减半 —— 这正是手机弱网下最有效的一招。
 * ------------------------------------------------------------------ */

/** 自己管的模型缓存名字。改内容格式时把这个版本号加一，旧缓存自动作废。 */
const MODEL_CACHE_NAME = 'simulnote-models-v1';
/** transformers.js 自己用的缓存名，v3 起如此；留着它只会占配额，清掉。 */
const LEGACY_CACHE_NAME = 'transformers-cache';
/** 只对 `.onnx`（也就是大权重）走分块；json / spm 这些小文件一次取完更划算。 */
const ONNX_RE = /\.onnx(\?|$)/i;
/** 每块 2 MB。实测 4.5 MB 就会断，留足余量。 */
const CHUNK_BYTES = 2 * 1024 * 1024;
/** 减半的下限，再小就只是白白增加往返。 */
const MIN_CHUNK_BYTES = 512 * 1024;
/** 同一块最多重试几次，超过就把整次下载判失败。 */
const MAX_ATTEMPTS = 5;
/** 我们往缓存条目上贴的「这个文件应该有多少字节」。 */
const BYTES_HEADER = 'x-simulnote-bytes';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function openModelCache(): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null;
    return await caches.open(MODEL_CACHE_NAME);
  } catch {
    return null; // 隐私模式 / 配额被拒：退化成纯网络，不影响正确性
  }
}

/** 供探针页与排障用的「清空模型缓存」。返回删掉的条目数。 */
export async function clearModelCache(): Promise<number> {
  try {
    if (typeof caches === 'undefined') return 0;
    if (!(await caches.has(MODEL_CACHE_NAME))) return 0;
    const cache = await caches.open(MODEL_CACHE_NAME);
    const keys = await cache.keys();
    await caches.delete(MODEL_CACHE_NAME);
    return keys.length;
  } catch {
    return 0;
  }
}

/** 把一段内存里的字节伪装成一个正常的 200 响应，交给 transformers.js。 */
function responseFromBlob(blob: Blob): Response {
  return new Response(blob, {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/octet-stream' },
  });
}

interface RangeChunk {
  blob: Blob;
  /** 文件真实总长度，来自 `Content-Range`。服务端忽略了 Range 时为 null。 */
  total: number | null;
  /** true 表示服务端没理 Range，把整份文件发回来了。 */
  whole: boolean;
}

async function fetchRangeOnce(url: string, start: number, end: number): Promise<RangeChunk> {
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const whole = res.status === 200;
  let total: number | null = null;
  const contentRange = res.headers.get('content-range');
  if (contentRange) {
    const m = /\/(\d+)\s*$/.exec(contentRange);
    if (m) total = Number(m[1]);
  }
  const blob = await res.blob();
  if (total === null) {
    // 206 却没有 Content-Range 时只能按累计字节数收尾；200 时整份就是总数。
    total = whole ? blob.size : null;
  }
  return { blob, total, whole };
}

/**
 * 用 `Range` 把一个大文件分块取回来并拼成一个 Blob。
 * 中途任何一块失败都只重下那一块；连续失败就把块体积减半再试。
 */
async function rangeDownload(url: string, onNote?: (note: string) => void): Promise<Blob> {
  const parts: BlobPart[] = [];
  let chunk = CHUNK_BYTES;
  let offset = 0;
  let total: number | null = null;
  let failures = 0;

  while (total === null || offset < total) {
    try {
      const got = await fetchRangeOnce(url, offset, offset + chunk - 1);
      if (got.blob.size === 0) throw new Error('这一块收到 0 字节');
      parts.push(got.blob);
      offset += got.blob.size;
      if (got.total !== null) total = got.total;
      failures = 0;
      if (got.whole) break;
      const done = (offset / 1048576).toFixed(1);
      const all = total === null ? '?' : (total / 1048576).toFixed(1);
      onNote?.(`分块下载 ${done} / ${all} MB`);
    } catch (err) {
      failures += 1;
      if (failures >= MAX_ATTEMPTS) throw err;
      if (chunk > MIN_CHUNK_BYTES) {
        chunk = Math.max(MIN_CHUNK_BYTES, Math.floor(chunk / 2));
        onNote?.(`分块中断，块大小降到 ${(chunk / 1048576).toFixed(1)} MB 重试`);
      } else {
        onNote?.(`分块中断，第 ${failures + 1} / ${MAX_ATTEMPTS} 次重试`);
      }
      await sleep(300 * failures);
    }
  }

  const blob = new Blob(parts);
  if (total !== null && blob.size !== total) {
    throw new Error(`收到的字节数不对：${blob.size} / ${total}`);
  }
  return blob;
}

/**
 * 模型文件的取数总入口：先看自己管的缓存，没有就下载（大文件分块），校验长度后写回缓存。
 */
async function cachedModelFetch(
  url: string,
  original: (input: string | URL, init?: RequestInit) => Promise<Response>,
  onNote?: (note: string) => void,
): Promise<{ response: Response; bytes: number; note: string | null }> {
  const cache = await openModelCache();

  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const blob = await hit.blob();
      const declared = Number(hit.headers.get(BYTES_HEADER));
      if (!Number.isFinite(declared) || declared === blob.size) {
        return {
          response: responseFromBlob(blob),
          bytes: blob.size,
          note: `本地缓存 ${(blob.size / 1048576).toFixed(1)}MB`,
        };
      }
      // 长度对不上 = 上次断线留下的半截文件。**必须删掉**，否则会永远命中它。
      await cache.delete(url);
      onNote?.('缓存条目长度不对，已删除并重新下载');
    }
  }

  let blob: Blob;
  if (ONNX_RE.test(url)) {
    blob = await rangeDownload(url, onNote);
  } else {
    const res = await original(url, undefined);
    blob = await res.blob();
  }

  if (cache) {
    try {
      const stored = new Response(blob, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', [BYTES_HEADER]: String(blob.size) },
      });
      await cache.put(url, stored);
    } catch {
      // 配额满 / put 被拒：这次照样能用，只是下次还得再下。
    }
  }

  return { response: responseFromBlob(blob), bytes: blob.size, note: null };
}

/** 已经被包过一次的 env 打个标记，避免重复包装（包装层会叠加计时）。 */
const WRAPPED = Symbol.for('simulnote.fetchWrapped');

/** 请求可能是字符串、URL 或 Request，统一取出可比较的地址。 */
function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof (input as Request).url === 'string') return (input as Request).url;
  return String(input);
}

/** 是不是我们自己站点里的模型文件（小文件与 `.onnx` 都算）。 */
function isModelRequest(href: string): boolean {
  return href.includes('/models/');
}

/**
 * 把 `env.fetch` 换成一个记账版本。
 *
 * 对 `/models/` 下的请求，它会**接管取数**：优先用自家缓存，大文件走 Range 分块，
 * 校验长度后才写回缓存（见上面 `cachedModelFetch`）。其余请求原样转发。
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
    const href = requestUrl(input);
    const startedAt = Date.now();
    const method = (init?.method ?? 'GET').toUpperCase();
    const managed = method === 'GET' && isModelRequest(href);
    let note: string | null = null;
    try {
      if (managed) {
        const got = await cachedModelFetch(href, original, (n) => {
          note = n;
        });
        note = got.note ?? note;
        fetchLog.push({
          url: href,
          status: got.response.status,
          ok: got.response.ok,
          bytes: got.bytes,
          ms: Date.now() - startedAt,
          error: null,
          note,
        });
        trimLog();
        return got.response;
      }

      const response = await original(input, init);
      const declared = Number(response.headers.get('content-length'));
      fetchLog.push({
        url: href,
        status: response.status,
        ok: response.ok,
        bytes: Number.isFinite(declared) ? declared : null,
        ms: Date.now() - startedAt,
        error: null,
        note: null,
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
        note,
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

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
 * 模型镜像基址 —— **提速项，不是依赖**。
 *
 * 为什么加它（2026/10/5 实测，本机普通家宽，同一个 opus 编码器、同样是 8 MB 区间）：
 *   - GitHub Pages（自建）  **0.086 MB/s** —— 90 秒只收到 7.7 MB，直接超时；
 *   - hf-mirror.com        **1.638 MB/s** —— 快 19 倍。
 * 小米平板的真机报告印证了同一件事：V4 首访加载 729 秒，按 0.15 MB/s 倒推，
 * 108 MB 的翻译模型正好是 700 多秒。**慢的不是模型、不是分块策略，是源站。**
 *
 * 但镜像随时可能被墙、限速或者停服，所以它**没有取代自建**：
 * 启动时对两个源各测 256 KB，谁快用谁；谁中途连续失败就换另一个。
 * 镜像不通时自动退回自建，站点依旧完全可用（只是慢）。
 */
const MIRROR_BASE = 'https://hf-mirror.com/';

/**
 * ModelScope（阿里，modelscope.cn）—— 同样一份 `Xenova/*` 仓库，国内直连。
 *
 * 2026/10/5 实测（本机普通家宽，同一个 opus 编码器取前 8 MB）：
 *   - 自建 GitHub Pages：**38,915 B/s**  ← 186 MB 的首次访问要一个半小时
 *   - hf-mirror：208,339 B/s
 *   - **ModelScope：9,062,348 B/s**  ← 比自建快 **233 倍**
 * 路径形状与 Hugging Face 完全一致，**唯一的差别是 revision 用 `master` 而不是 `main`**：
 *   https://modelscope.cn/models/Xenova/opus-mt-en-zh/resolve/master/onnx/encoder_model_quantized.onnx
 * 已逐个核对过 24 个文件，字节数与本站托管的**完全一致**，CORS 返回 `*`，
 * 且 `Content-Range` 里的总长度与 HF 一致 —— 是同一份仓库的镜像，不是重新导出的模型。
 */
const MODELSCOPE_BASE = 'https://modelscope.cn/models/';

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

/**
 * 往抓取日志里塞一条。给 `lib/ortEnv.ts` 用 —— ORT 运行时的下载是**我们自己做的**，
 * 不走 `instrumentFetch` 包的那条 `env.fetch`，所以得手动记。
 */
export function pushFetchRecord(record: FetchRecord): void {
  fetchLog.push(record);
  trimLog();
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

/* ------------------------------------------------------------------ *
 * 多源测速：谁快用谁
 *
 * transformers.js 只会朝 `localModelPath`（也就是自建）要文件，
 * 但我们在 `instrumentFetch` 里截住了所有 `/models/` 请求，
 * 所以可以把地址改写到「当前测出来最快的那个源」上去。
 * 缓存键一律用**自建的规范地址**，这样换源之后之前下好的文件照样命中。
 * ------------------------------------------------------------------ */

/** 一个模型来源。 */
export interface ModelSource {
  /** 报告里显示的短名。 */
  label: string;
  /** 基址，末尾必有斜杠。 */
  base: string;
  /**
   * 目录布局。`local` 是本站的 `models/<组织>/<模型>/<文件>`；
   * `hf` 是 Hugging Face 的 `/<组织>/<模型>/resolve/main/<文件>`。
   *
   * **这两个布局不能混用**（2026/10/5 实测，对着 hf-mirror.com 打）：
   *   `.../Xenova/opus-mt-en-zh/onnx/...onnx`            → HTTP 404（curl 连不上时更是直接超时）
   *   `.../Xenova/opus-mt-en-zh/resolve/main/onnx/...`   → 302 → 206 · Content-Range 52899742
   * 第一次上线时就是漏了 `resolve/main`，导致镜像测速永远失败、
   * `chooseSource()` 静默退回自建 —— 功能看起来在跑，其实一次都没生效。
   */
  layout: 'local' | 'hf';
  /** `hf` 布局下的分支名：hf-mirror 用 `main`，ModelScope 用 `master`。 */
  revision: string;
}

/** 测速用的文件与体积：拿 whisper 编码器头 256 KB，够判断量级又不浪费流量。 */
const PROBE_BYTES = 256 * 1024;
const PROBE_REL = 'Xenova/whisper-tiny.en/onnx/encoder_model_quantized.onnx';
/** 单个源测速的超时。自建在弱网下 256 KB 也就 3 秒左右，20 秒足够。 */
const PROBE_TIMEOUT_MS = 20000;
/**
 * 记住上次的选择，1 小时内不重复测速。
 *
 * **改源列表时必须改这个键名。** 老的值里可能存着 `自建` —— 那是上一版
 * 只有两个源时测出来的结论，在新的一版里它依然能按 label 命中，
 * 于是用户在接下来的一小时里会**继续用最慢的那个源**，
 * 看起来就像「修复没生效」。加 `.v2` 就是为了让旧结论自动作废。
 */
const SOURCE_KEY = 'simulnote.modelSource.v2';
const SOURCE_TTL_MS = 60 * 60 * 1000;

/** 本次会话实际选用的源，供探针页展示。 */
export interface SourceChoice {
  label: string;
  /** 探针实测速度，字节/秒；0 表示沿用上次结果、这次没测。 */
  bytesPerSec: number;
  /** 一句话说明，直接进报告。 */
  note: string;
}

let chosen: SourceChoice | null = null;
let sourcePromise: Promise<ModelSource> | null = null;

/** 自行托管的模型目录，永远是兜底。 */
function selfSource(): ModelSource {
  return { label: '自建', base: localModelPath(), layout: 'local', revision: '' };
}

/**
 * 所有候选源，顺序即测速并列时的优先级。
 *
 * 自建**放在最后**：它现在是最慢的一个（38 KB/s），只作为「镜像全挂」时的兜底。
 * 但它必须一直在列表里 —— 它是唯一一个不依赖第三方、我们说了算的源。
 */
function allSources(): ModelSource[] {
  return [
    { label: 'ModelScope', base: MODELSCOPE_BASE, layout: 'hf', revision: 'master' },
    { label: 'hf-mirror', base: MIRROR_BASE, layout: 'hf', revision: 'main' },
    selfSource(),
  ];
}

/** 模型在站点里的相对路径，例如 `Xenova/opus-mt-en-zh/onnx/encoder_model_quantized.onnx`。 */
function relPath(canonical: string): string {
  const prefix = localModelPath();
  if (canonical.startsWith(prefix)) return canonical.slice(prefix.length);
  const i = canonical.indexOf('/models/');
  return i >= 0 ? canonical.slice(i + '/models/'.length) : canonical;
}

/**
 * 把本站的相对路径翻成 Hugging Face 的地址路径。
 * `Xenova/opus-mt-en-zh/onnx/x.onnx` → `Xenova/opus-mt-en-zh/resolve/main/onnx/x.onnx`
 */
function hfPath(rel: string, revision: string): string {
  const parts = rel.split('/');
  if (parts.length < 3) return rel;
  // 站点路径没有 revision 这一层；hf-mirror 是 main，ModelScope 是 master。
  return `${parts[0]}/${parts[1]}/resolve/${revision}/${parts.slice(2).join('/')}`;
}

/** 把相对路径拼到某个源的基址上，注意两个源的目录布局不同。 */
function sourceUrl(source: ModelSource, rel: string): string {
  return `${source.base}${source.layout === 'hf' ? hfPath(rel, source.revision) : rel}`;
}

/** 单源测速：取 PROBE_BYTES 字节，返回字节/秒。 */
async function probeSource(source: ModelSource): Promise<number> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  const url = sourceUrl(source, PROBE_REL);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
      cache: 'no-store',
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const ms = Math.max(1, Date.now() - startedAt);
    if (buf.byteLength === 0) throw new Error('收到 0 字节');
    fetchLog.push({
      url: `${source.label}（测速）`,
      status: res.status,
      ok: true,
      bytes: buf.byteLength,
      ms,
      error: null,
      note: `${(buf.byteLength / 1048576 / (ms / 1000)).toFixed(2)} MB/s`,
    });
    trimLog();
    return buf.byteLength / (ms / 1000);
  } catch (err) {
    // **失败也必须进日志。** 上一次漏掉 `resolve/main` 时，镜像每次都 404，
    // 但失败被这里静默吞掉，报告上只看到「测速 → 选 自建」，谁也想不到是地址拼错。
    fetchLog.push({
      url: `${source.label}（测速）`,
      status: null,
      ok: false,
      bytes: null,
      ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
      note: url,
    });
    trimLog();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 排障用：把某个模型文件在两个源上的**确切地址**列出来，给探针页显示。
 * 加它的原因就是上面那次 404 —— 报告上只有一个「选 自建」的结论，
 * 看不出镜像到底是连不上、404 了、还是慢，只能靠猜。
 */
export function sourceUrlsForTest(): string[] {
  const rel = PROBE_REL;
  return allSources().map((s) => `${s.label}: ${sourceUrl(s, rel)}`);
}

/** 读上一次的选择（1 小时内有效），避免每次打开都重测、白花 512 KB 流量。 */
function rememberedSource(): ModelSource | null {
  try {
    const raw = localStorage.getItem(SOURCE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { label?: string; at?: number };
    if (!saved.label || typeof saved.at !== 'number') return null;
    if (Date.now() - saved.at > SOURCE_TTL_MS) return null;
    return allSources().find((s) => s.label === saved.label) ?? null;
  } catch {
    return null;
  }
}

function rememberSource(source: ModelSource): void {
  try {
    localStorage.setItem(SOURCE_KEY, JSON.stringify({ label: source.label, at: Date.now() }));
  } catch {
    // 隐私模式下写不了，无所谓：本次会话内照样有效
  }
}

/**
 * 三个源各测 256 KB，取快的那个；全失败就退回自建 —— 宁可慢，不能不能用。
 *
 * 自建是**最后才测**的：它现在只有 38 KB/s，测它一次要 6 秒多，
 * 而它永远赢不了。只有镜像全挂了才值得花这 6 秒去确认兜底还活着。
 */
async function chooseSource(): Promise<ModelSource> {
  const remembered = rememberedSource();
  if (remembered) {
    chosen = { label: remembered.label, bytesPerSec: 0, note: `${remembered.label}（1 小时内沿用上次的测速结果）` };
    return remembered;
  }
  const list = allSources();
  const mirrors = list.filter((s) => s.layout === 'hf');
  const self = list[list.length - 1];
  const mirrorSpeeds = await Promise.all(
    mirrors.map(async (s) => {
      try {
        return await probeSource(s);
      } catch {
        return -1;
      }
    }),
  );
  let best = 0;
  for (let i = 1; i < mirrors.length; i++) if (mirrorSpeeds[i] > mirrorSpeeds[best]) best = i;

  let picked = mirrors[best];
  let speeds = mirrorSpeeds;
  if (mirrorSpeeds[best] <= 0) {
    // 镜像全灭：这时才去测自建，确认兜底可用。
    let selfSpeed = -1;
    try {
      selfSpeed = await probeSource(self);
    } catch {
      selfSpeed = -1;
    }
    picked = self;
    speeds = [selfSpeed];
  }
  const labels = mirrorSpeeds[best] <= 0 ? [self.label] : mirrors.map((s) => s.label);
  const detail = labels
    .map((label, i) => `${label} ${speeds[i] < 0 ? '不可用' : `${(speeds[i] / 1048576).toFixed(2)} MB/s`}`)
    .join(' · ');
  chosen = {
    label: picked.label,
    bytesPerSec: Math.max(0, speeds[mirrorSpeeds[best] <= 0 ? 0 : best]),
    note: `测速 ${detail} → 选 ${picked.label}`,
  };
  if (chosen.bytesPerSec > 0) rememberSource(picked);
  return picked;
}

/** 取当前源，必要时先测速。 */
function ensureSource(): Promise<ModelSource> {
  if (!sourcePromise) sourcePromise = chooseSource();
  return sourcePromise;
}

/**
 * 换到下一个源（当前源连续失败时用）。
 *
 * 候选有三个，所以不能只找「另一个」：按列表顺序**环形**往后走，
 * 走到自建（列表末尾、也是唯一不依赖第三方的那个）就停下来 —— 那里没法再退。
 */
function switchSource(used: ModelSource): ModelSource {
  const list = allSources();
  const at = list.findIndex((s) => s.label === used.label);
  const alt = list[at < 0 || at === list.length - 1 ? list.length - 1 : at + 1] ?? used;
  chosen = { label: alt.label, bytesPerSec: 0, note: `${used.label} 不可用，改用 ${alt.label}` };
  sourcePromise = Promise.resolve(alt);
  return alt;
}

/** 本次会话选用的源，给探针页用。还没选时为 null。 */
export function activeSource(): SourceChoice | null {
  return chosen;
}

/** 供排障用：忘掉上次的测速结论，下次强制重新测。 */
export function forgetSource(): void {
  try {
    localStorage.removeItem(SOURCE_KEY);
  } catch {
    // 忽略
  }
  sourcePromise = null;
  chosen = null;
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
/**
 * 同一个文件同时开几路。
 *
 * 实测（2026/10/5，ModelScope，同一台机器同一分钟）：串行 8 MB = 7.37 MB/s，
 * 4 路并发 = 16.13 MB/s，8 路并发 = 27.92 MB/s。**CDN 是按连接限速的**，
 * 并发是这里最有效的一招。浏览器对同域默认最多开 6 条连接，取 4 既不撞上限、
 * 又能拿到两倍带宽；手机上再保守一点也是稳赚。
 */
const LANES = 4;
/** 同一块最多重试几次，超过才认为这个源这一块拿不到（然后换源续传）。 */
const MAX_ATTEMPTS = 5;
/**
 * 单块请求的超时基准，实际值按块大小折算。
 *
 * **不能是固定值**：自建源只有 27~39 KB/s，2 MB 要 60 秒以上，固定 30 秒
 * 会把「慢但能用」的最后一个兜底源直接判死（R20 的教训）。
 */
const CHUNK_TIMEOUT_MS = 30000;
/** 我们往缓存条目上贴的「这个文件应该有多少字节」。 */
const BYTES_HEADER = 'x-simulnote-bytes';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 构建时注入的模型清单：相对路径 → 字节数（见 vite.config.ts 的 `modelSizes()`）。 */
declare const __MODEL_SIZES__: Record<string, number>;

/**
 * 这个文件应该有多少字节；清单里没有就返回 null。
 *
 * **不再读 `Content-Range` 了。** 自建源同域、什么头都读得到，hf-mirror 也老实发了
 * `Access-Control-Expose-Headers: Content-Range`，但 **ModelScope 不发**
 * （2026/10/5 实测 `access-control-expose-headers: （没有）`）—— 跨域下浏览器里
 * `res.headers.get('content-range')` 恒为 `null`，分块循环因此**失去终点**：
 * 它会一直往文件末尾之外要数据，直到服务端回 416 才失败，然后换源从头再下一遍。
 * 这就是「V2 能过但很慢」「V4 跑了很久还没有报告」的真正原因。
 *
 * 长度本来就是已知的 —— 这些文件是我们自己随站点发的。构建时扫一遍写进包，
 * 下载器就有了一份不依赖任何响应头的真值，顺带还能算出进度。
 */
export function expectedModelBytes(rel: string): number | null {
  const n = __MODEL_SIZES__?.[rel];
  return typeof n === 'number' && n > 0 ? n : null;
}

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

/**
 * 把一段内存里的字节伪装成一个正常的 200 响应，交给 transformers.js。
 *
 * `content-length` 是**必填的**：transformers.js 的进度回调靠它算百分比，
 * 缺了它整段下载在界面上会显示成「卡住不动」，报告里的「下载耗时」也会变成 0。
 */
function responseFromBlob(blob: Blob): Response {
  return new Response(blob, {
    status: 200,
    statusText: 'OK',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(blob.size),
    },
  });
}

interface RangeChunk {
  blob: Blob;
  /** true 表示服务端没理 Range，把整份文件发回来了。 */
  whole: boolean;
}

/**
 * 取一个字节区间。**一次请求，不重试** —— 重试的逻辑在 `fetchChunk()` 里。
 *
 * `whole: true` 表示服务端没理 `Range`，把整份文件发回来了（200）。
 */
async function fetchChunkOnce(url: string, start: number, end: number): Promise<RangeChunk> {
  const ctl = new AbortController();
  const want = end - start + 1;
  // 超时按块大小折算（见 CHUNK_TIMEOUT_MS 的注释），别用固定值。
  const timer = setTimeout(() => ctl.abort(), CHUNK_TIMEOUT_MS + Math.round(want / 40));
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
      cache: 'no-store',
      signal: ctl.signal,
    });
    if (res.status !== 206 && res.status !== 200) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return { blob: await res.blob(), whole: res.status === 200 };
  } finally {
    clearTimeout(timer);
  }
}

/** 同一块重试若干次；这一块在当前源上反复失败就抛出去，交给上层换源续传。 */
async function fetchChunk(url: string, start: number, end: number): Promise<RangeChunk> {
  const want = end - start + 1;
  let last: unknown = new Error('未开始');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const got = await fetchChunkOnce(url, start, end);
      if (got.whole) return got; // 服务端整份发回，长度由调用方核对
      if (got.blob.size !== want) {
        throw new Error(`这一块收到 ${got.blob.size} 字节，应为 ${want}`);
      }
      return got;
    } catch (err) {
      last = err;
      if (attempt < MAX_ATTEMPTS) await sleep(250 * attempt);
    }
  }
  throw last;
}

/** 首选源排第一，其余按固有优先级跟在后面（分块下载按这个顺序换源续传）。 */
function sourceOrder(first: ModelSource): ModelSource[] {
  return [first, ...allSources().filter((s) => s.label !== first.label)];
}

/**
 * 把一个大文件分块取回来并拼成 Blob。**多路并发 + 换源续传**。
 *
 * 三条设计，每一条都对应一次真机翻车：
 *
 * 1. **总长度问自己，不问服务端。** 来自构建时的模型清单（`expectedModelBytes`）。
 *    ModelScope 不发 `Access-Control-Expose-Headers`，跨域下读不到 `Content-Range`，
 *    老代码的 `while (total === null || offset < total)` 因此**没有出口**：
 *    它会一直往文件末尾之外要数据，直到 416 失败，再换源整份重下。
 * 2. **4 路并发。** CDN 按连接限速，实测串行 7.37 MB/s / 4 路 16.13 / 8 路 27.92。
 * 3. **换源续传。** 一块反复失败只说明**这个源**这一块拿不到，已经下好的块留在
 *    `parts` 里，换个源只补缺的那些。原先是整份重来 —— 117 MB 的 V4 拖到几十分钟
 *    就是这么来的。
 */
async function rangeDownload(
  sources: ModelSource[],
  rel: string,
  totalBytes: number,
  onNote?: (note: string) => void,
): Promise<{ blob: Blob; source: ModelSource; ms: number }> {
  const startedAt = Date.now();
  const count = Math.max(1, Math.ceil(totalBytes / CHUNK_BYTES));
  const parts: (Blob | null)[] = new Array<Blob | null>(count).fill(null);
  let doneBytes = 0;
  let lastError: unknown = new Error('没有可用的源');
  const report = (): void =>
    onNote?.(
      `已下载 ${(doneBytes / 1048576).toFixed(1)} / ${(totalBytes / 1048576).toFixed(1)} MB`,
    );

  for (const src of sources) {
    const url = sourceUrl(src, rel);
    let next = 0;
    let stop = false;
    let wholeFile: Blob | null = null;

    /** 原子地认领下一块。JS 单线程，`next += 1` 不会被两个 lane 撞上。 */
    const claim = (): number | null => {
      while (next < count && parts[next] !== null) next += 1;
      if (next >= count) return null;
      const i = next;
      next += 1;
      return i;
    };

    const lane = async (): Promise<void> => {
      for (;;) {
        if (stop) return;
        const i = claim();
        if (i === null) return;
        const start = i * CHUNK_BYTES;
        const end = Math.min(start + CHUNK_BYTES, totalBytes) - 1;
        try {
          const got = await fetchChunk(url, start, end);
          if (got.whole) {
            wholeFile = got.blob;
            stop = true;
            return;
          }
          parts[i] = got.blob;
          doneBytes += got.blob.size;
          report();
        } catch (err) {
          // 这一块在这个源上真的拿不到：停掉其它 lane，换源续传。
          lastError = err;
          stop = true;
          return;
        }
      }
    };

    await Promise.all(Array.from({ length: LANES }, lane));

    if (wholeFile !== null) {
      const whole: Blob = wholeFile;
      if (whole.size !== totalBytes) {
        throw new Error(`整取长度不对：${whole.size} / ${totalBytes}`);
      }
      return { blob: whole, source: src, ms: Date.now() - startedAt };
    }
    if (parts.every((p) => p !== null)) {
      return { blob: new Blob(parts as BlobPart[]), source: src, ms: Date.now() - startedAt };
    }

    const left = parts.reduce((n, p) => (p === null ? n + 1 : n), 0);
    onNote?.(`${src.label} 中断（${describeError(lastError)}），还剩 ${left} 块，换源续传`);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 把任意抛出来的东西变成一句话，用于提示与日志。 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 模型文件的取数总入口：先看自己管的缓存，没有就下载（大文件分块），校验长度后写回缓存。
 *
 * `canonical` 是**自建的规范地址**（transformers.js 要的那个）。真正去哪儿取由测速决定，
 * 但**缓存键永远用规范地址** —— 换源之后之前下好的文件照样命中，不会白下第二遍。
 */
async function cachedModelFetch(
  canonical: string,
  original: (input: string | URL, init?: RequestInit) => Promise<Response>,
  onNote?: (note: string) => void,
): Promise<{ response: Response; bytes: number; note: string | null }> {
  const cache = await openModelCache();

  if (cache) {
    const hit = await cache.match(canonical);
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
      await cache.delete(canonical);
      onNote?.('缓存条目长度不对，已删除并重新下载');
    }
  }

  const rel = relPath(canonical);
  const source = await ensureSource();
  // 清单里查得到长度的才走分块；查不到就退化成一次性整取（正常永远走不到，
  // 因为 `public/models` 下每一个文件都在清单里）。
  const wanted = ONNX_RE.test(canonical) ? expectedModelBytes(rel) : null;

  const pull = async (src: ModelSource): Promise<Blob> => {
    const url = sourceUrl(src, rel);
    const res = await original(url, undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res.blob();
  };

  let blob: Blob;
  let usedLabel = source.label;
  let speedNote = '';
  if (wanted !== null) {
    // 大权重：并发分块 + 换源续传，全在 rangeDownload 里。
    const got = await rangeDownload(sourceOrder(source), rel, wanted, onNote);
    blob = got.blob;
    usedLabel = got.source.label;
    // **用实测速度，不用测速阶段那个 256 KB 的数字** —— 后者是突发值，
    // 报告上写着 9 MB/s、实际跑 0.3 MB/s，正是 R18 那次误判的翻版。
    const secs = Math.max(0.001, got.ms / 1000);
    speedNote = ` · ${(blob.size / 1048576 / secs).toFixed(2)} MB/s · ${LANES} 路`;
  } else {
    try {
      blob = await pull(source);
    } catch (err) {
      // 小文件（json / spm / txt）一次取完，主源挂了就换另一个再试一次。
      // 缓存里已经有完整文件的情况上面就返回了，走到这里说明确实得重下。
      const alt = switchSource(source);
      onNote?.(`${source.label} 取数失败（${describeError(err)}），改用 ${alt.label} 重试`);
      blob = await pull(alt);
      usedLabel = alt.label;
    }
  }

  if (cache) {
    try {
      const stored = new Response(blob, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', [BYTES_HEADER]: String(blob.size) },
      });
      await cache.put(canonical, stored);
    } catch {
      // 配额满 / put 被拒：这次照样能用，只是下次还得再下。
    }
  }

  const speed = chosen && chosen.bytesPerSec > 0 ? ` · ${(chosen.bytesPerSec / 1048576).toFixed(2)} MB/s` : '';
  return { response: responseFromBlob(blob), bytes: blob.size, note: `来自 ${usedLabel}${speedNote || speed}` };
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

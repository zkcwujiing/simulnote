/*
 * SimulNote 的 Service Worker —— 只负责「让应用外壳能离线打开」。
 *
 * ## 它**刻意不做**的三件事
 *
 * 1. **不碰模型与运行时文件**（`/models/`、`/ort/`）。
 *    那些文件由 `src/lib/modelSource.ts` / `src/lib/ortEnv.ts` 自己用
 *    Cache Storage（`simulnote-models-v1`、`simulnote-ort-v1`）管理，
 *    并且大量使用 HTTP Range 分块下载。Service Worker 如果插手这些请求，
 *    会破坏 Range 语义（`fetch` 事件里重新发起的请求默认不带 Range 语义保证），
 *    结果是「缓存看起来有、实际每次都在重下」甚至下载校验失败。
 *    所以这里直接 `return;` 放行，让页面自己处理。
 *
 * 2. **不做「离线优先」**。首次访问必须联网（模型、运行时、应用代码都要下），
 *    这一点没有商量余地。这里的策略是**网络优先、失败才回缓存**：
 *    能联网时用户永远拿到最新版本，断网时才退到上一次成功打开的样子。
 *
 * 3. **不调用 `skipWaiting`**。新版 SW 装好后先等着，等所有旧页面关掉才接管。
 *    强行接管会让正在进行的**会话**（正在录音、正在识别）在页面底下换掉资源，
 *    而那种 bug 表现为「莫名其妙的中断」，极难排查。
 */

const CACHE = 'simulnote-shell-v1';

/**
 * 预缓存的最小集合。这里**不能**写 `index.html` 里那些带哈希的 `assets/*.js` ——
 * 哈希每次构建都变，写死的名字会让安装直接失败。带哈希的资源靠下面
 * 「同源 GET 资源缓存优先」那条策略在实际用到时自然进缓存。
 */
const PRECACHE = ['./', './manifest.webmanifest', './favicon.svg', './pcm-worklet.js'];

/** 明确放行、绝不插手的路径前缀。 */
const PASSTHROUGH = ['/models/', '/ort/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // 逐个 add，单个失败不影响整体安装 —— 预缓存的作用是「导航时至少有个兜底」，
      // 为了它让整个 SW 装不上是本末倒置。
      Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined),
        ),
      ),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 跨域（ModelScope / npmmirror / hf-mirror）一律放行：
  // 那些下载有自己的续传与校验逻辑，被 SW 拦一层只会让「从哪来、下了多少」失真。
  if (url.origin !== self.location.origin) return;
  if (PASSTHROUGH.some((prefix) => url.pathname.includes(prefix))) return;

  // 导航请求（打开页面）：网络优先，断网时回缓存里那份外壳。
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./', copy)).catch(() => undefined);
          return response;
        })
        .catch(() =>
          caches.match('./').then(
            (cached) =>
              cached ??
              new Response('离线，且本机还没有缓存过这个页面。请联网打开一次 SimulNote。', {
                status: 503,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
              }),
          ),
        ),
    );
    return;
  }

  // 同源的静态资源（`.js` / `.css` / 图标 / worklet）：缓存优先。
  // 它们都带内容哈希，URL 变了内容就变，所以「缓存优先」不会拿到旧代码。
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      });
    }),
  );
});

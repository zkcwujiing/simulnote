# SimulNote（同传笔记）· 项目框架

> **一句话定位**：打开一个网页链接，对着麦克风说英文，屏幕上实时滚动中文翻译；说完之后，自动生成这段内容的中文要点纪要。
> **零成本承诺**：不依赖任何付费 API，所有 AI 计算跑在使用者自己的浏览器里，托管在免费静态托管平台。

**🔗 已经在线的站点**：<https://zkcwujiing.github.io/simulnote/> ｜ 可行性探针页 <https://zkcwujiing.github.io/simulnote/probe.html>
（部署与换机器重走的完整步骤见 [`docs/10-上线清单.md`](docs/10-上线清单.md)）

---

## 1. 项目是什么

| 维度 | 说明 |
|---|---|
| 输入 | 英文语音（麦克风实时拾音 / 上传音频文件） |
| 过程 | 实时语音识别 → 实时英译中 → 双语字幕滚动 |
| 输出 | 结束后的中文**结构化要点纪要**（主题 / 要点 / 关键数字 / 待办） |
| 形态 | 一个静态网站，发链接或二维码即可给朋友用 |
| 成本 | ¥0（使用者零安装、零注册、零付费） |
| 隐私 | 默认全部在浏览器本地计算，音频不出设备 |

## 2. 核心差异化

调研了 GitHub 上 6 个同类项目（详见 [`docs/02-同类项目调研与优劣分析.md`](docs/02-同类项目调研与优劣分析.md)），发现一个共同空白：

> **它们都只做到「实时字幕/翻译」就结束了，没有任何一个提供「结束后自动总结要点」。**

这正是本项目的增量价值：**同传 + 纪要一体**。

## 3. 关键设计决策（摘要）

| 决策点 | 选择 | 一句话理由 |
|---|---|---|
| 部署形态 | 纯浏览器端静态站（**无服务端**） | 唯一能同时满足「免费」「发链接就能用」「无服务器成本」的形态 |
| 模型来源 | **自托管**：构建期下进 `public/models/`，随站点发布 | Hugging Face CDN 在国内实测 **0/3 不通**，直下模型会让站点变成砖（[`docs/07`](docs/07-风险与对策.md) R15） |
| 识别引擎 | 分层渐进增强（浏览器原生 API → 本地 ONNX/WASM 模型） | 不同设备能力差巨大，必须降级而不是二选一 |
| 翻译引擎 | 桌面走 Chrome 内置 Translator API，移动端走本地 opus-mt | 内置 API 快且免费但**不支持手机**，必须有兜底 |
| 摘要引擎 | 本地小模型生成式摘要 + **TextRank 抽取式兜底** | 保证任何设备都能出纪要，永不失败 |
| 数字处理 | **从英文原文抽取，不走翻译链路** | 小模型翻译数字不可靠（hayamimi 官方 Limitations 明说），错数字比没数字更糟 |
| 工程原则 | 任何一环都可降级、绝不白屏 | 朋友的设备五花八门 |

> 完整决策依据见 [`docs/03-技术选型与可行性验证.md`](docs/03-技术选型与可行性验证.md)，架构细节见 [`docs/04-系统架构设计.md`](docs/04-系统架构设计.md)。

## 4. 文档导航

| 文档 | 内容 |
|---|---|
| [`docs/01-需求与目标.md`](docs/01-需求与目标.md) | 需求拆解、约束、验收标准、待确认项 |
| [`docs/02-同类项目调研与优劣分析.md`](docs/02-同类项目调研与优劣分析.md) | 6 个 GitHub 同类项目的深度分析、横向对比、借鉴清单 |
| [`docs/03-技术选型与可行性验证.md`](docs/03-技术选型与可行性验证.md) | 三条技术路线对比、逐环节选型、硬性限制、零成本清单 |
| [`docs/04-系统架构设计.md`](docs/04-系统架构设计.md) | 分层架构、数据流、模块接口、性能预算 |
| [`docs/05-项目目录结构与模块划分.md`](docs/05-项目目录结构与模块划分.md) | 完整目录树与每个模块的职责 |
| [`docs/06-开发路线图与里程碑.md`](docs/06-开发路线图与里程碑.md) | M0–M6 里程碑、交付物、验收标准 |
| [`docs/07-风险与对策.md`](docs/07-风险与对策.md) | 风险登记表与缓解方案 |
| [`docs/08-零成本方案与分享方式.md`](docs/08-零成本方案与分享方式.md) | 免费托管对比、分享方式、额度边界 |
| [`docs/09-本地运行与部署.md`](docs/09-本地运行与部署.md) | 怎么跑起来、怎么构建、怎么发布给朋友（含实测踩坑记录） |
| [`docs/10-上线清单.md`](docs/10-上线清单.md) | **照着做就能上线**：从建仓库到手机上打开链接的 6 步 |

## 5. 快速开始

```bash
pnpm install
pnpm fetch-models  # 把 24 个模型文件（159.6 MB）下到 public/models/；只需一次
pnpm dev          # 主应用：http://localhost:5173
                  # M0 探针：http://localhost:5173/probe.html
```

> **`pnpm fetch-models` 不能省。** 模型是**自托管**的（原因见 [`docs/07`](docs/07-风险与对策.md) R15：
> Hugging Face 在国内实测 0/3 不通），运行时只从本站的 `/models/...` 取，不访问任何外部服务。
> 模型不进 git（仓库保持几百 KB），所以换一台机器就得重跑一次。
> `pnpm fetch-models --check` 是**离线**体检，只查文件在不在，不联网。

麦克风需要「安全上下文」：`localhost` 可以，`file://` 打开**不行**。

**M0 可行性探针**（`probe.html`）是给开发/验证用的诊断页：在**当前这台设备**上实测 WebGPU 能力、
内存上限、存储配额、本地 Whisper / 翻译模型的速度（RTF）与摘要质量，最后生成一份可复制的
Markdown 报告。它不碰主应用状态，也不会把数据发出去。手机验证的做法是：部署后在同一条链接后面
加 `/probe.html`，用手机打开、跑完、把报告发回来。

```bash
pnpm build        # 模型体检 + 类型检查 + 生产构建，产物在 dist/（约 186 MB）
pnpm preview      # 本地预览构建产物
pnpm lint:cost    # 零成本护栏：扫描源码里有没有偷偷引入付费 API / 密钥
pnpm lint:size    # 上传体积闸门：Cloudflare Pages 单文件上限 25 MiB
pnpm verify       # 上面三件事一起跑
```

**想让手机用上它**，直接看 [`docs/10-上线清单.md`](docs/10-上线清单.md) —— 从建仓库到手机上打开链接，6 步。
原理与踩坑记录在 [`docs/09-本地运行与部署.md`](docs/09-本地运行与部署.md)。

## 6. 当前状态

**阶段：M1 最小闭环、M3 纪要质量、M4 体验打磨 —— 代码可以构建、可以本地运行、模型能从本站加载；M2（手机可用）与 M4 的代码侧都已完成并自检通过，等真机验收。**

已完成：

| 层 | 内容 |
|---|---|
| 采集 | `src/lib/audio/capture.ts`（AudioWorklet 重采样到 16 kHz 单声道，带 ScriptProcessor 降级）、`public/pcm-worklet.js` |
| 断句 | `src/lib/audio/vad.ts`（能量法 VAD，自适应噪声底，零下载零依赖） |
| 识别 | 浏览器原生识别 `asr-webSpeech`（`privacy: network`）、本地 Whisper `asr-whisper-local`（`privacy: on-device`，模型 `Xenova/whisper-tiny.en`，42 MB） |
| 翻译 | 浏览器内置翻译 `mt-chrome-builtin`、本地 opus-mt `mt-local-transformer`（模型 `Xenova/opus-mt-en-zh`，117 MB） |
| 纪要 | `sum-extractive-textrank`：TextRank + MMR 抽取式摘要，外加 `sentenceWeight()` 给串场/客套降权、给含数字与线索词的句子升权；**关键数字由 `sum/facts.ts` 从英文原文按规则抽取**，不经过翻译模型；**质量基准 `pnpm bench:summary` → [`docs/results/V6.md`](docs/results/V6.md)**（数字保留 100%、幻觉 0、precision@5 **100%**、决策/待办 **4/4**） |
| 决策 | `src/engines/registry.ts`：三档模式（自动 / 完全本地 / 最快启动），探测顺序即优先级，**任何一环都允许降级，绝不白屏** |
| 模型 | `src/lib/modelSource.ts` 统一配置模型来源（`allowRemoteModels=false` 是护栏）、`scripts/fetch-models.mjs` 负责构建期下载 |
| 界面 | 环境探测面板、实时双语滚动（虚拟列表）、**字幕字号三档切换并记住**、**引擎状态条**（会话中显示每一环实际用的哪一档，降级时轻提示）、纪要视图、**Markdown / 纯文本 / SRT 字幕三种导出**、分享二维码 |
| 输入 | 麦克风实时同传，或**上传一段音频文件**（`src/lib/audio/fileSource.ts` + `transcribeFile()`）走同一条管线，出字幕、译文、纪要 |
| 离线 | **PWA**：`manifest.webmanifest` + `public/sw.js`（模型与 ORT 运行时都已在 Cache Storage 里，断网可继续用） |
| 会话安全 | **锁屏/切后台中断恢复 + 会话留痕**（`src/lib/session/lifecycle.ts` 订阅 `visibilitychange`/`freeze`/`resume`/`pagehide`/`pageshow`，`draft.ts` 12 小时 TTL / 400 句上限 / 残缺整体作废）、**长会话内存守卫**（`src/lib/session/memory.ts`，只分级与提醒、**刻意不自动降档**）、**下载进度条同时出现在开始页与「准备中」**、**丢句告警**（`src/lib/session/quality.ts`，看的是「识别交回 ÷ 送进识别」而不是「转写 ÷ 音频」）、**错误兜底边界** |
| 会话安全 | **锁屏/切后台中断恢复 + 会话留痕**（`src/lib/session/lifecycle.ts` 订阅 `visibilitychange`/`freeze`/`resume`/`pagehide`/`pageshow`，`draft.ts` 12 小时 TTL / 400 句上限 / 残缺整体作废）、**长会话内存守卫**（`src/lib/session/memory.ts`，只分级与提醒、**刻意不自动降档**）、**下载进度条同时出现在开始页与「准备中」** |
| 护栏 | `scripts/check-zero-cost.mjs`（零成本）、`scripts/check-upload-size.mjs`（部署体积） |
| 验证 | `probe.html` + `src/probe/`：M0 探针页，**已就绪、待真机运行** |

构建实测：`pnpm build` 通过（`tsc -b` 无错误，两个入口 `index.html` + `probe.html`）；
完整产物 **46 个文件 / 199.96 MB**，其中 24 个是自托管模型（159.6 MB），
另加 4 个自托管的 ONNX Runtime 运行时文件（`dist/ort/`，两对变体共 41 MB）。

### 还没做的（也是接下来最该做的）

1. **真机验证 —— M0 三项核心风险的桌面 / 平板侧已全部解除** ✅：2026/10/6 的报告里 **V9（ORT 运行时）/ V2（Whisper）/ V4（opus-mt）在同一个会话里一次全通过** —— V2 RTF 0.236（比实时快 4.2 倍），V4 平均 328 ms/句，**V4 那 117.2 MB 的加载只用 9.1 秒**（此前它在真机上从来没出过结果，见 [`docs/07`](docs/07-风险与对策.md) R21）。报告归档在 [`docs/results/V2V4V9-2026-10-06-全通.md`](docs/results/V2V4V9-2026-10-06-全通.md)。**还差 V1 / V5 / V7，以及真手机档的 V8** —— **2026/10/7 用户确认第三份 V8 报告跑在「小米平板」上**（`m04510` 逐字），那台设备两段都撞在探针自己抬到 5120 MB 的上限上，即**两模型同时驻留后余量 ≥ 5120 MB —— 平板侧的 R1 证否**。但平板内存普遍大于手机，**这份报告不能顶替真手机档**，而手机才是用户最可能拿在手上的设备。这一轮还顺带暴露一个真缺陷：一台小米平板被老判定写成 `是否移动端: false`（桌面版网站模式下 UA 不含 `Mobile` / `Android` 等词），修复已随 `d879e7b` 上线，**现在每份探针报告都自带设备指纹**。**V6（抽取式纪要质量）已在 2026/10/7 重做语料后全部达标**：precision@5 **100%**、决策/待办 **4/4**、数字保留 100%（11/11）、幻觉 0，见 [`docs/results/V6.md`](docs/results/V6.md)，`pnpm bench:summary` 可复现。报告归档在 [`docs/results/V8-内存探针.md`](docs/results/V8-内存探针.md)（含探针自身两个缺陷的修正）。探针页在线：<https://zkcwujiing.github.io/simulnote/probe.html>，跑完把报告发回来即可。已有报告见 [`docs/results/`](docs/results/)。
2. **部署 —— 已完成** ✅：`main` 分支已推到 <https://github.com/zkcwujiing/simulnote>，GitHub Actions 的 `Deploy to GitHub Pages` 跑绿，站点上线于 <https://zkcwujiing.github.io/simulnote/>。
   > 唯一一个必须**手动做一次**的动作：仓库 **Settings → Pages → Source 选 "GitHub Actions"**。
   > 这一步没做的话，流水线的 Install / Fetch models / Build 全绿，只在最后的 `configure-pages` 红掉，
   > 报 `Create Pages site failed. Error: Resource not accessible by integration` ——
   > 因为创建 Pages 站点需要管理员权限，CI 的 `GITHUB_TOKEN` 永远没有（`enablement: true` 也救不了）。详见 [`docs/10-上线清单.md`](docs/10-上线清单.md) 第 3 步。
   > Cloudflare Pages 那份 workflow 仍然保留但改成手动触发，理由见 [`docs/08-零成本方案与分享方式.md`](docs/08-零成本方案与分享方式.md)。
3. **手机端体验打磨 —— 代码侧已完成，等真机验收** ✅（2026/10/8）：锁屏中断恢复（`lib/session/lifecycle.ts` + `draft.ts`，离开页面先落盘再报状态）、会话留痕（重进页面问「要不要恢复上次没做完的」）、长时间会话的内存守卫、字幕字号三档自适应、下载进度条在「准备中」也不再消失。**M2 的验收条件本身就是「iPhone Safari + Android Chrome 各完成一次完整会话」，这一条只能在真机上做。** 两项**有意没做**：① `sherpa-onnx` 流式 ASR —— V1 从未真机跑过，而现有 whisper 已在真 iPhone 上 RTF 0.25，换它是买更低延迟、不是买可用性；② Playwright 移动端 E2E —— 本仓库没有任何浏览器自动化依赖，而它恰好模拟不出真机的内存压力、锁屏与 Safari 音频中断。理由见 [`docs/06`](docs/06-开发路线图与里程碑.md) §6.4。
4. **M4 体验打磨 —— 代码侧已完成并自检通过** ✅（2026/10/8）：SRT 字幕导出（正文用中文译文，译不出来时退回英文原文；时间轴强制单调不重叠）、PWA Service Worker（模型与 ORT 运行时都已在 Cache Storage 里，断网可继续用）、会话中的引擎状态条、**上传音频文件**走同一条管线（`lib/audio/fileSource.ts` + `transcribeFile()`）、错误兜底边界。两项需要说明的：① **丢句告警的指标被重新设计** —— 借鉴来的「转写时长 << 音频时长」在旧代码里**永远不会触发**（那字段量的是 VAD 语音时长，比值恒在 1 附近），改成真实音频时长又会每次开会都误报；现在看的是「识别交回 ÷ 送进识别」；② **二次精修有意未做** —— 它要留住音频再解一遍，手机上排不进实时预算，而「高质量配置」在只自托管了一个 ASR 模型的前提下没有对象。两项理由都写在 [`docs/06`](docs/06-开发路线图与里程碑.md) §6.6 与 [`docs/07`](docs/07-风险与对策.md) R24。

**M4 有一处实现细节值得单独记一笔**：上传的音频喂进管线前必须切成 **1600 采样（100 ms）** 的块，不能按秒喂。因为 `lib/audio/vad.ts` 把「帧数」当时间单位（`elapsedMs += frameSize / sampleRate`），喂 1 秒的块会让它把每秒当 100 ms —— 时间戳缩小 10 倍、「连续 3 帧算开口」从 300 ms 变成 3 秒、「静音 700 ms 收尾」变成 7 秒。**不报错，结果全错。**

### 几个必须知道的事实

1. **模型自己托管，首访要下 160 MB；但真正取文件时会自动挑最快的源。** Hugging Face CDN 在国内实测 0/3 不通（DNS 污染 + SNI 阻断），所以 `scripts/fetch-models.mjs` 在**构建期**把 24 个文件拉到 `public/models/` 随站点发布，运行时 `allowRemoteModels=false`。好处是「朋友能不能用」不再取决于他能否连上 HF；代价是站点变成 200 MB，GitHub Pages 的 100 GB/月带宽 ≈ **500 次完整首访/月**，这是现在要盯的指标。复访走 Cache Storage，不再花流量。**另有实测发现：自建源只有 0.06 MB/s（见第 7 条），所以运行时会在自建与 `hf-mirror.com` 之间测速选快的那个，自建永远是兜底。**
2. **ONNX Runtime 的运行时也必须自托管 —— 这一条是真机实测才发现的（提交 `3d40184`）。** transformers.js 的产物里写着：只要 `env.backends.onnx.wasm.wasmPaths` 为空，它就把 ORT 的 `.mjs` 胶水和 26.8 MB 的 wasm 指向一个**第三方静态资源 CDN**。国内手机上那个 CDN 连不上，`pipeline()` 抛 `TypeError: Load failed` —— 看起来像「模型加载失败」，实际是 CDN 不通。现在 `src/lib/ortEnv.ts` 的 `configureOrtWasm()` **无条件**把它指到本站 `/<base>/ort/`，`vite.config.ts` 的 `ortRuntime()` 插件负责把那两对文件拷进产物。**`pnpm lint:cost` 现在会扫产物和调用点，防止这个回归再次发生。**
3. **GitHub Pages 会给 `.onnx` 加 gzip，而手机上单个大响应取不完 —— 所以 `.onnx` 一律走 `Range` 分块。** 50.45 MB 的 opus 编码器线上 `Content-Length` 只有 37,142,901 且带 `Content-Encoding: gzip`，浏览器要在一次长连接里收完再解压；裸取探测**只收到 4.5 MB 就断**。而**带 `Range` 的请求服务端不压缩**，返回未压缩的字节区间和真实总长度。现在 `src/lib/modelSource.ts` 把 `.onnx` 按 2 MB 分块取回、拼成 Blob、**核对总长度**后自己写入 Cache Storage（`simulnote-models-v1`）。同时 `env.useBrowserCache` 被**关掉**——库自带的缓存命中时不校验长度，一次断线留下的半截文件会被永久命中，症状是「清了缓存就好、不清就永远坏」。详见 [`docs/07-风险与对策.md`](docs/07-风险与对策.md) 的 R17。
4. **Cloudflare Pages 有 25 MiB 单文件上限，而且现在有 4 个文件超限。** 除了 26.8 MB 的 `ort-wasm-simd-threaded.asyncify.wasm`（这个能外置成本仓库的 Release 资产），还有 3 个模型 `.onnx`（29 / 50 / 57 MB）——**它们没有外置方案**，因为外置就等于回到「运行时从第三方 CDN 取权重」。**所以 GitHub Pages 是唯一无损路线。**
5. **Chrome 内置翻译 API 不支持手机**（只支持桌面 Chrome 138+ / Edge 148+，且要求 16GB 内存）。所以手机上只能走本地模型或浏览器原生识别 —— 这正是 `docs/03` 设计四层降级链的原因。另外 Chrome 的原生识别在**国内同样不通**（音频要发往 Google 服务器）。经真机实测，**手机浏览器一律没有原生识别**，所以这一层在移动端实际上不存在。
6. **小模型翻译数字不可靠**（hayamimi 官方 Limitations 原文："numeric values are not reliably preserved"）。本项目的对策是**数字完全绕开翻译模型**，从英文原文按规则抽取并生成对照表。真机实测（小米平板，10 句）也印证了：数字类 5 处对 1 错 4 —— 23% 消失、4.8 变成 480、日期重复一遍。这条已从「M3 可选」升为**必需**，并且在 2026/10/6 走完了整条链路：
**原文抽取 → 关键数字表（带「第 N 段」出处）→ 占位符回填 → 改动清单**。
抽取侧修掉一个真缺陷 —— 老实现只认「连续 ≥2 个首字母大写词」，`PostgreSQL` / `Kubernetes` / `Kafka`
**一条都抽不出来**，而这正是技术会议最需要保真的东西；进位侧修掉 `SCALE_ZH` 把
`4.8 million dollars` 算成 `4.8万美元`（**差 100 倍**）的错误，现在是 `480万美元`；
回填侧 `src/engines/sum/backfill.ts` 是全项目唯一会改写译文的地方，原则是**宁可不改，不可改错** ——
只填模型自己留的占位符、只折叠重复日期，每一处改写都列进纪要的改动清单。
26 条零依赖单测（`pnpm test`）。**残留**：译文写错但形状正常的数字仍不自动改，只交给关键数字表核对。2026/10/6 的报告里又抓到一个更直白的：**「About 60% of the test group」被译成「大约 `__` 个测试组」—— 模型自己吐了个占位符出来**，恰好说明「抽取 + 回填」该接在哪个位置；同一次报告里还有 `PostgreSQL` → 「邮局」、`March 15, 2026` → 「3月15日,2026年3月15日」。
7. **首访慢的真凶是源站吞吐，不是模型也不是分块。** 小米平板报告显示 V4 首访加载 **729 秒**。逐条证伪之后（模型不缺件 / 不是 ORT / 块越大反而越慢 0.14→0.08 MB/s / 4 块并发比串行还慢，说明是总量限速），实测定论：同一个 opus 编码器连取 4 个 8 MB 区间，**自建 GitHub Pages 稳定 0.05–0.06 MB/s，hf-mirror.com 是 0.44–1.23 MB/s（约 12 倍）**。所以引入了**多源自动测速**：各测 256 KB，谁快用谁，缓存键仍用自建规范地址（换源不重下），主源失败自动换下一个，全失败才报错。详见 [`docs/07-风险与对策.md`](docs/07-风险与对策.md) 的 R18。

8. **但 R18 只做对了一半 —— 真正把它修好的是 ModelScope，不是 hf-mirror。** 用户追问「为什么下载到现在还没好」，再测一次才发现两个漏洞：① 双源测速只认路径里有 `/models/` 的请求，**26.8 MB 的 ORT 运行时完全不在覆盖范围内**，只能走自建，实测 27,589 B/s，**单独一个文件就要 16 分钟**；② hf-mirror 也不是答案 —— 同一个编码器取前 8 MB：自建 **38,915 B/s**（159.6 MB 要 71 分钟）、hf-mirror 208,339 B/s、**ModelScope（modelscope.cn）9,062,348 B/s（54 秒）**。而且自建这次比 R18 记的还要慢一倍 —— **它随链路漂移，任何一次实测都只是快照**。现在的取法：模型走 ModelScope（路径与 HF 一致，只有分支名是 `master`），ORT 运行时走 `registry.npmmirror.com`（版本号构建期注入），**两处都以自建兜底**。验证不再只比长度而是比 **SHA-256**：24 个模型文件 **24/24 一致**（159.6 MB / 53.8 s），4 个 ORT 文件 **4/4 一致**（asyncify wasm 20.12 MB/s）。首访从约一个半小时降到**约 1 分钟**。详见 R19。

9. **换成 ModelScope 之后 V4 仍然出不了报告，因为分块下载在等一个永远不会来的响应头。** 用户再问「为什么v2通过很慢，v9通过很快但是v4已经运行很久了，还是没有报告」。实测 ModelScope 的响应里**没有 `Access-Control-Expose-Headers`** —— 于是 `Content-Range` 在 `curl` 里看得见、**在浏览器里恒为 `null`**，而 `rangeDownload()` 的循环条件是 `while (total === null || offset < total)`：总长度读不到，循环就没有终点，一路把 `Range` 要过文件末尾撞上 `416`，然后被当成「这个源坏了」→ **换源从第 0 字节整份重下**。V2 只有 42.4 MB，重下一次还能熬过去（「能过但很慢」）；V4 有 117.2 MB，换源再换源，永远轮不到报告。**教训：`curl` 与 Node 都不受 CORS 约束，离线验证通过 ≠ 浏览器里能跑。** 现在总长度改由**构建时注入的模型清单**提供（`vite.config.ts` 扫 `public/models/` 生成 `__MODEL_SIZES__`），`rangeDownload()` 重写成 **4 条 lane 并发 + 原子认领 + 换源续传**（已下好的块留着，下一个源只补缺口）。并发这一项单独就有 **2~4 倍**：同一个文件的 8 MB，串行 7.37 MB/s、并发 4 路 16.13 MB/s、并发 8 路 27.92 MB/s —— **CDN 是按连接限速的**。离线端到端复刻取完 V4 的 117.2 MB 只要 **6.2 秒（18.81 MB/s）**。详见 R21。

10. **「要点覆盖率 ≥ 70%」这条验收标准按字面永远达不到，而且 TextRank 的中心度 ≠ 信息量；更要紧的是，第一版语料本身在骗人。** 建了基准（`pnpm bench:summary` → [`docs/results/V6.md`](docs/results/V6.md)）才发现覆盖率的问题：语料有 23 条要点句，而一页纸纪要只输出 `K = 5` 条，覆盖率的**数学上限**就是 5/23 = 21.7% —— 引擎再准也过不了 70%。这是指标写错了，不是引擎不行。同一个基准还暴露了一个真缺陷：`Let me walk through where we are on the quarter…`（主持人串场）和 `Also please read the incident review before the meeting…`（客套）**霸占了要点榜的第一名和第五名**，因为它们满是 meeting / review / quarter 这类高频词，句图连接数最高 —— 但它们一个字都不该进纪要。`sentenceWeight()` 给串场/客套降权、给含数字与线索词的句子升权之后，这两条被挤了出去。**但真正的大头是语料：第一版把行分成「人工标注」和「讲话原文」两类，而标注是改写、还含原文根本没有的数字** —— `@ The board rejected the Northwind acquisition…` 对应的原句只说了「62 要 95，董事会觉得站不住」；`churn` 的 `2.1 / 3.4` 原文里压根没出现。这等于用一个引擎够不着的标准去扣它的分。2026/10/7 把语料重做成「一句话一行、逐句标是不是要点」，并把原先只存在于标注里的三条事实补回原文，**复测：precision@5 100%（5/5）、决策/待办 4/4、数字保留 100%（11/11）、幻觉 0**。硬不变量「数字表里每条事实必须能在英文原文里逐字找到」已进 `--check`。**注意新旧数字不可直接比**（60% → 100% 里既有算法也有语料的功劳，基准本身分不开）；语料仍只有 1 份 5.4 KB 的合成会议，够回答「有没有在乱挑」，不够证明「摘要好」。详见 R22。

11. **手机上最危险的不是崩溃，是「看起来还在跑」。** M2 自检时发现两类**沉默失败**，共同点是界面一切正常、实际已经坏掉，而且都只在手机上出现。① **锁屏 / 切到别的 App 时系统会把 `AudioContext` 挂起或让音轨结束，而页面收不到任何回调** —— `LiveView` 里那颗红点照常在闪、照常写「识别中」，用户会以为还在录，讲完整场才发现后半段全没了。② **下载进度条原先只挂在开始页，点「开始」后界面切到 `LiveView`，进度条随之消失**，手机首访要下 ~150 MB，用户盯着那句不动的「正在准备模型与麦克风…」等几分钟，和卡死无法区分。对策：`src/lib/session/lifecycle.ts` 同时订阅 `visibilitychange`/`freeze`/`resume`/`pagehide`/`pageshow`（iOS Safari 走 bfcache 那条路，`pagehide` 不一定触发，所以两套都接），按离开时长与音轨状态分成 `audio-lost`/`needs-resume`/`paused`/`none` 四级；`src/lib/session/draft.ts` 在离开时**先把留痕写进盘再报状态**（标签页可能永远不再醒），12 小时 TTL、400 句上限、**任何一处残缺就整体作废 —— 半截恢复出来的纪要比没有更糟**；`DownloadBar` 抽成独立组件同时挂在两处。**已知代价**：真机行为无证据（`pagehide`/`freeze` 各厂商触发时机不一致，这正是 M2 真机验收要盯的第一件事）；恢复出来的是「留痕」不是「续录」，时间轴断了一截，UI 上不假装连续；**不自动重开麦克风**，因为浏览器要求音频必须由用户手势启动（硬限制，不是没做）。详见 R23。

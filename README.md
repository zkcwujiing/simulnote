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

**阶段：M1 最小闭环已跑通 —— 代码可以构建、可以本地运行、模型能从本站加载，尚未在真机上验证过识别质量。**

已完成：

| 层 | 内容 |
|---|---|
| 采集 | `src/lib/audio/capture.ts`（AudioWorklet 重采样到 16 kHz 单声道，带 ScriptProcessor 降级）、`public/pcm-worklet.js` |
| 断句 | `src/lib/audio/vad.ts`（能量法 VAD，自适应噪声底，零下载零依赖） |
| 识别 | 浏览器原生识别 `asr-webSpeech`（`privacy: network`）、本地 Whisper `asr-whisper-local`（`privacy: on-device`，模型 `Xenova/whisper-tiny.en`，42 MB） |
| 翻译 | 浏览器内置翻译 `mt-chrome-builtin`、本地 opus-mt `mt-local-transformer`（模型 `Xenova/opus-mt-en-zh`，117 MB） |
| 纪要 | `sum-extractive-textrank`：TextRank + MMR 抽取式摘要；**关键数字由 `sum/facts.ts` 从英文原文按规则抽取**，不经过翻译模型 |
| 决策 | `src/engines/registry.ts`：三档模式（自动 / 完全本地 / 最快启动），探测顺序即优先级，**任何一环都允许降级，绝不白屏** |
| 模型 | `src/lib/modelSource.ts` 统一配置模型来源（`allowRemoteModels=false` 是护栏）、`scripts/fetch-models.mjs` 负责构建期下载 |
| 界面 | 环境探测面板、实时双语滚动（虚拟列表）、纪要视图、Markdown/纯文本导出、分享二维码 |
| 护栏 | `scripts/check-zero-cost.mjs`（零成本）、`scripts/check-upload-size.mjs`（部署体积） |
| 验证 | `probe.html` + `src/probe/`：M0 探针页，**已就绪、待真机运行** |

构建实测：`pnpm build` 通过（`tsc -b` 无错误，两个入口 `index.html` + `probe.html`）；
完整产物 **46 个文件 / 199.96 MB**，其中 24 个是自托管模型（159.6 MB），
另加 4 个自托管的 ONNX Runtime 运行时文件（`dist/ort/`，两对变体共 41 MB）。

### 还没做的（也是接下来最该做的）

1. **真机验证（最重要）**：`docs/06` 里的 M0 探针 V1–V8 一个都还没跑。**手机能不能跑得动本地模型，目前只有推断，没有数据。** 这是最大的未知。探针页已经写好并且**已经在线**——手机直接打开 <https://zkcwujiing.github.io/simulnote/probe.html>，跑完把报告发回来即可。
2. **部署 —— 已完成** ✅：`main` 分支已推到 <https://github.com/zkcwujiing/simulnote>，GitHub Actions 的 `Deploy to GitHub Pages` 跑绿，站点上线于 <https://zkcwujiing.github.io/simulnote/>。
   > 唯一一个必须**手动做一次**的动作：仓库 **Settings → Pages → Source 选 "GitHub Actions"**。
   > 这一步没做的话，流水线的 Install / Fetch models / Build 全绿，只在最后的 `configure-pages` 红掉，
   > 报 `Create Pages site failed. Error: Resource not accessible by integration` ——
   > 因为创建 Pages 站点需要管理员权限，CI 的 `GITHUB_TOKEN` 永远没有（`enablement: true` 也救不了）。详见 [`docs/10-上线清单.md`](docs/10-上线清单.md) 第 3 步。
   > Cloudflare Pages 那份 workflow 仍然保留但改成手动触发，理由见 [`docs/08-零成本方案与分享方式.md`](docs/08-零成本方案与分享方式.md)。
3. **手机端体验打磨**：横竖屏、锁屏中断恢复、长时间会话的内存回收。

### 四个必须知道的事实

1. **模型自己托管，首访要下 160 MB。** Hugging Face CDN 在国内实测 0/3 不通（DNS 污染 + SNI 阻断），所以 `scripts/fetch-models.mjs` 在**构建期**把 24 个文件拉到 `public/models/` 随站点发布，运行时 `allowRemoteModels=false`，**不访问任何外部服务**。好处是「朋友能不能用」不再取决于他能否连上 HF；代价是站点变成 200 MB，GitHub Pages 的 100 GB/月带宽 ≈ **500 次完整首访/月**，这是现在要盯的指标。复访走 Cache Storage，不再花流量。
2. **ONNX Runtime 的运行时也必须自托管 —— 这一条是真机实测才发现的（提交 `3d40184`）。** transformers.js 的产物里写着：只要 `env.backends.onnx.wasm.wasmPaths` 为空，它就把 ORT 的 `.mjs` 胶水和 26.8 MB 的 wasm 指向一个**第三方静态资源 CDN**。国内手机上那个 CDN 连不上，`pipeline()` 抛 `TypeError: Load failed` —— 看起来像「模型加载失败」，实际是 CDN 不通。现在 `src/lib/ortEnv.ts` 的 `configureOrtWasm()` **无条件**把它指到本站 `/<base>/ort/`，`vite.config.ts` 的 `ortRuntime()` 插件负责把那两对文件拷进产物。**`pnpm lint:cost` 现在会扫产物和调用点，防止这个回归再次发生。**
3. **Cloudflare Pages 有 25 MiB 单文件上限，而且现在有 4 个文件超限。** 除了 26.8 MB 的 `ort-wasm-simd-threaded.asyncify.wasm`（这个能外置成本仓库的 Release 资产），还有 3 个模型 `.onnx`（29 / 50 / 57 MB）——**它们没有外置方案**，因为外置就等于回到「运行时从第三方 CDN 取权重」。**所以 GitHub Pages 是唯一无损路线。**
4. **Chrome 内置翻译 API 不支持手机**（只支持桌面 Chrome 138+ / Edge 148+，且要求 16GB 内存）。所以手机上只能走本地模型或浏览器原生识别 —— 这正是 `docs/03` 设计四层降级链的原因。另外 Chrome 的原生识别在**国内同样不通**（音频要发往 Google 服务器）。经真机实测，**手机浏览器一律没有原生识别**，所以这一层在移动端实际上不存在。
5. **小模型翻译数字不可靠**（hayamimi 官方 Limitations 原文："numeric values are not reliably preserved"）。本项目的对策是**数字完全绕开翻译模型**，从英文原文按规则抽取并生成对照表。

# V0 · 设备画像（P0 探针）—— iPhone（朋友的手机）

- **测试设备**：iPhone，屏幕 `430×932` CSS px / DPR 3，**4 个逻辑核心**，系统 **iOS 26.6**（UA 里的 `iPhone OS 26_6`）
- **测试浏览器**：① 微信内置浏览器 ② Chrome for iOS（`CriOS/155.0.8059.24`）
- **测试时间**：2026-（两次间隔约 11 分钟）
- **方法**：手机打开 <https://zkcwujiing.github.io/simulnote/probe.html> → ① 「跑全部零下载项」（**不下载任何模型**）
- **判定**：两者**都是**「及格但有隐患」，且**发现 3 个需要注意的点**（比 Android 那台多一个）

> ⚠️ **在 iOS 上「Chrome 和 Safari 选哪个」这个问题基本不成立。**
> Apple 强制所有 iOS 浏览器使用 **WebKit**，`CriOS` 只是套在同一个 `AppleWebKit/605.1.15` 引擎外面的
> 一层壳。两份报告逐行比对下来，**只有两行不同，而且两行都不重要**（见下方对照表）。

## 两浏览器对照表

| 项目 | ① 微信内置 | ② Chrome for iOS | 差异有意义吗 |
|---|---|---|---|
| 浏览器标识 | `MicroMessenger/8.0.78`<br>`NetType/4G` | `CriOS/155.0.8059.24` | — |
| **渲染引擎** | `AppleWebKit/605.1.15` | `AppleWebKit/605.1.15` | ❌ **同一个引擎** |
| 机型 | `iPhone` · `430×932` · DPR 3 | 同左 | — |
| 逻辑核心数 | **4** | **4** | — |
| `deviceMemory` | 浏览器未暴露 | 浏览器未暴露 | ⚠️ 见「盲区」 |
| JS 堆上限 | 非 Chromium 内核 | 非 Chromium 内核 | ⚠️ 见「盲区」 |
| 电池 | 未暴露 | 未暴露 | ⚠️ 见「盲区」 |
| 在线 / 网络 | 在线 · 未知 | 在线 · 未知 | ⚠️ 见「盲区」 |
| **WebGPU** | `apple` · 1024 / **1024** MB | `apple` · 1024 / **1024** MB | ✅ 比高通那台好 8× |
| WASM SIMD | true | true | — |
| WASM 多线程 | **false** | **false** | — |
| `SharedArrayBuffer` | **false** | **false** | — |
| `crossOriginIsolated` | **false** | **false** | — |
| **存储配额** | **9830.4 MB** | **39321.6 MB** | ❌ 无意义（见注①） |
| 已用 | 8 MB | 0 MB | ❌ 噪声 |
| Cache Storage | 可用，写读 4 MB 成功 | 同左 | ✅ |
| IndexedDB | true | true | ✅ |
| `AudioContext` 采样率 | **16000** | **16000** | ✅ |
| 能强制 16 kHz | true | true | ✅ |
| AudioWorklet | true | true | ✅ |
| ScriptProcessor | true | true | ✅ |
| 浏览器原生识别 | **没有** | **没有** | ⚠️ |

**注①**：存储配额 9.8 GB vs 39 GB —— 我们要缓存的是 **~160 MB**，两个数字都远超需求，**这一列的差别不构成选择理由**（同 Android 报告里的「284 GB 虚数」）。

## UA 原文

**① 微信内置浏览器（iPhone）**

```
Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X)
AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148
MicroMessenger/8.0.78(0x18004e33) NetType/4G Language/zh_CN
```

**② Chrome for iOS**

```
Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_0 like Mac OS X)
AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.8059.24
Mobile/15E148 Safari/604.1
```

> 注意 ② 里那串 `Safari/604.1` —— iOS 版 Chrome 在 UA 里**自报 Safari**。这是 Apple 强制的引擎约束留下的痕迹。

## 结论

### 1. 🟢 「Chrome 还是 Safari」—— 引擎一样，选 Safari

因为两者跑的是**同一个 WebKit**，能力完全相同，所以这个问题不应该按「能力」来回答，而应该按下面这些来回答：

- **Safari 是 WebKit 的参照实现**，WebKit 的修复先到 Safari，再到 `CriOS`。
- **iOS 上只有 Safari 能真正「添加到主屏幕」**，而 Chrome for iOS 装不出真正的 PWA —— 这件事在下面第 4 条里会变得重要。
- **少一层壳 = 少一处出问题的地方。**

**所以：iPhone 上推荐用 Safari（系统自带），并建议「添加到主屏幕」后使用。**

### 2. 🟡 iOS 上有一片**测不到的盲区** —— 这是本次最大的坏消息

`deviceMemory`、JS 堆上限、电池、网络类型 —— **四项全部「未暴露」**。

这四项在 Android 上之所以能读到，是因为 Chrome 提供了 `navigator.deviceMemory`、`performance.memory`、`navigator.getBattery()`、`navigator.connection`。**Safari 一个都没实现。**

后果很直接：**「这台 iPhone 能撑多久」这个问题，我们连一个数字都拿不到。**

- 探针的 **V8 内存压力测试仍然能跑**（它靠分配并写入 `ArrayBuffer`，不依赖 `performance.memory`），
  但它只能给出「**崩在多少 MB**」这个二值结论 —— 而且是在**进程被杀掉**时才得到，不是抛异常。
- `deviceMemory` 显示为「浏览器未暴露」而不是 8 GB，也说明**不能把 Android 那台的 8 GB 当成通用假设**。

### 3. 🔴 在 iOS 上 OOM 的表现形式是「**页面被系统杀掉**」，不是报错

WebKit 有一个公开的 bug 记录（[bug 291677](https://bugs.webkit.org/show_bug.cgi?id=291677)，2025-04-17 报告，标为 WebAssembly 组件 / Critical / iOS 18）：Unity 导出的 WebGL 游戏在 **iOS 18.4 上启动阶段内存飙升**，系统日志原文是

```
memorystatus: killing_highwater_process pid 4738 [com.apple.WebKit.WebContent]
  (highwater 100 3s rf:-) 2025555KB
```

即 **WebContent 进程被内存看门狗杀掉**，现象是**页面重新加载**，而不是弹一个错误。报告的机型包括 iPhone 11 / 13 / SE3，且**在 iOS 18.3 及更早版本上不发生**。根因是 `LLIntGenerator` / `IPIntGenerator` 里 `FixedBitVector(m_info.internalFunctionCount())` 按 wasm **函数数量**分配内存（复现样本用了 200,000 个空函数）。该 bug 被标为 [bug 291699](https://bugs.webkit.org/show_bug.cgi?id=291699) 的重复并 **RESOLVED FIXED**。

**对本案的判断**：朋友的机器是 **iOS 26.6**，远在这个修复之后，**大概率不受这个具体 bug 影响**。但它揭示了一类真实失败模式，对本项目的处置是：

- **错误处理必须能识别「页面莫名刷新/白屏」**，而不能只等 `try/catch` ——
  因为进程被杀时**没有任何 JS 代码有机会执行**。可行的做法是在 `sessionStorage` 里留一个「我正在加载模型」的标记，
  下次启动时如果看到这个标记又没看到成功标记，就提示「上次加载可能是内存不足被杀掉了，建议换用更小的模型/关掉其他标签页」。
- **模型加载要按「函数数量 × 内存」而不是「文件大小」来评估风险。** ORT 的 wasm 有多少函数我们还没数过。

### 4. 🟡 iPhone 只有 4 个逻辑核心，且 iOS 会驱逐分区存储

- **4 核**（华为那台是 8 核）—— 即使将来拿到多线程，iPhone 这边的并行度也只有一半。
- Apple 有一条文档化的策略（ITP）：**脚本可写存储（Cache Storage、IndexedDB、Service Worker 注册）在 7 天无交互后被清除**。
  我们那 **160 MB 的模型缓存正好落在范围内** —— 朋友一周不打开，模型就要重下。
  缓解方向（**尚未实施**）：把「添加到主屏幕」作为推荐路径（主屏 Web App 的存储待遇更好）、
  做下载进度与断点续传、以及**明确告诉用户「第一次打开会慢，之后会快」**。
  ⚠️ 这是 Apple 的公开策略，**不是本报告从截图里测到的**；它在 iOS 26.6 上的具体行为需要单独验证。

### 5. 🟢 三者一致通过的部分（和 Android 相同的结论）

`AudioContext` 直接 16000 Hz、能强制 16 kHz、AudioWorklet、ScriptProcessor、Cache Storage 写读 4 MB、
IndexedDB、WASM SIMD —— **全部通过，和 Android 那台一致**。采集层与缓存层的设计在 iPhone 上同样成立。

### 6. 🟢 WebGPU 的一项反而更好

| | 高通（Android） | Apple（iPhone） |
|---|---|---|
| `maxBufferSize` | 1024 MB | 1024 MB |
| `maxStorageBufferBindingSize` | **128 MB** | **1024 MB** |

iPhone 的 storage binding 上限是安卓那台的 **8 倍**。如果将来走 WebGPU 后端，**iPhone 可能是更好的目标设备**。

## 对架构的影响

1. **设备判定不能只信 `userAgentData`**：报告里明写「看起来是手机但 `userAgentData.mobile` 不可用（已用 UA 正则兜住）」。
   探针已经兜住了，主应用也必须一样兜 —— **两条腿走路，缺一条就误判成桌面**。
2. **「内存够不够」在 iOS 上无法通过 API 预判**，只能靠压力测试拿到「崩点」。
   架构上要假设「**iOS 侧可能在任何时候被杀**」，因此**会话状态必须持续落盘**（这不只是体验问题，是可用性问题）。
3. **多线程在 iOS 上同样没有**（`SharedArrayBuffer=false`、`crossOriginIsolated=false`），
   且根因同样是 GitHub Pages 不给自定义响应头 —— **和 Android 的报告结论完全一致**。
4. **推荐路径要按平台分化**：Android 建议 Chrome；iOS 建议 Safari + 添加到主屏幕。
   这条要写进分享引导 UI，不能只写一句笼统的「建议用系统浏览器打开」。
5. **模型缓存要有「可能消失」的心理准备**：iOS 的 7 天驱逐策略意味着缓存不是永久的。
   下载流程要能优雅地重新下载，而不是假定文件一定在。

## 下一步（按优先级）

1. **⑤ 本地模型实测**（探针页）：Whisper 单跑、合成音频 10 秒、WASM q8 —— **先在 Android 的 Chrome 上跑**，
   拿到基线 RTF；再在 iPhone 的 Safari 上跑同一个配置做对照。
2. 同一节换 **WebGPU fp32**（iPhone 的 1024 MB binding 上限值得一试）。
3. **② V8 内存压力**（**放最后跑**）—— 在 iPhone 上这项尤其重要，因为它是**唯一**能拿到内存数据的途径。
4. 单独验证 **iOS 的 7 天存储驱逐**是否真的会清掉我们的模型缓存。

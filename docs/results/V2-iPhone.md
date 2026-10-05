# V2 / V4 · iPhone Safari 实测（真机报告）

- **采集时间**：2026/10/5 11:09:52
- **页面**：<https://zkcwujiing.github.io/simulnote/probe.html>
- **浏览器**：Safari（iPhone）
- **构建立即包含的修复**：提交 `3d40184`（把 ONNX Runtime 运行时收归本站自托管）之后的版本
  —— 判据是报告里出现了「ORT 运行时来源」这一行，该字段是那次修复才加的。

UA 原文：

```
Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15
(KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1
```

> ⚠️ **易误读**：UA 里写的是 `iPhone OS 18_7`，但这个字段**不是真实系统版本** ——
> Apple 把 iOS 的 UA 版本号冻结在了 18_7（隐私原因）。真实版本看 `Version/26.6`。
> 同一台手机在微信和 Chrome 里报的是 `26_6_0`，在 Safari 里报 `18_7`，
> 同一个系统出现两种写法是正常的，**不要据此判断「是不是同一台机器」**。

---

## 一、结论：V2 通过了，而且是这次最重要的一次通过

| 项目 | 数值 |
|---|---|
| 模型 | `Xenova/whisper-tiny.en` |
| 后端 | **wasm / q8**（没用 WebGPU） |
| 音频时长 | 10 秒（合成音频） |
| 下载 + 加载 | 54,810 ms |
| 其中下载 | 52,518 ms |
| 下载体积 | 29.3 MB |
| 推理耗时 | **2,504 ms** |
| **RTF** | **0.25（比实时快 4.0 倍）** |
| ORT 运行时来源 | （相对路径）→ `ort-wasm-simd-threaded.asyncify.mjs` + `ort-wasm-simd-threaded.asyncify.wasm` |
| 识别输出 | `you`（合成音频，只证明链路通，不代表质量） |

**这条数据回答了我们等了很久的那个问题：手机能不能跑本地 Whisper。**

- **RTF 0.25 意味着**：10 秒的讲话，识别只要 2.5 秒。即使按「最坏情况全部排队」算，
  也远比实时快 —— 这一档在手机上是**可行**的。
- 它同时**证伪了「缺多线程 WASM 就跑不动」的担心**：这台机器的
  `crossOriginIsolated=false`、`SharedArrayBuffer=false`、`WASM 多线程=false`，
  用的是**单线程 ORT + q8**，照样跑到 0.25。**COOP/COEP 是优化，不是前提。**
- 它也是**整个项目第一次真正意义上「跑通了端到端推理」**。

### V2 通过同时确认了 `3d40184` 那次修复是对的

同一位用户、同一台 iPhone，修复前 V2 的完整报错是：

```
TypeError: Load failed
```

修复后同一条链路直接跑完并给出 RTF。两件事只在「ORT 运行时从 jsDelivr 改成本站
`/ort/`」这一点上不同 —— **`Load failed` 的根因判定成立**（详见 `docs/07-风险与对策.md` R16）。

---

## 二、V4 仍然不通过，但**现在它不再是「同一个问题」**

| 项目 | 数值 |
|---|---|
| 模型 | `Xenova/opus-mt-en-zh` |
| 错误 | `TypeError: Load failed` |
| 加载、平均耗时/句、吞吐 | 全部 `—` |
| ORT 运行时来源 | 与 V2 相同（**说明 ORT 这份没问题**） |
| 10 句译文 | 全部「（空）」 |

**关键观察：V2 和 V4 现在用的是同一份 ORT 运行时，V2 能跑、V4 不能。**
所以 V4 的问题**不在 ORT 运行时**，而在别处。两个模型最显著的区别是**单文件体积**：

| | 最大单文件 | 结果 |
|---|---|---|
| whisper-tiny.en（q8） | `decoder_model_merged_quantized.onnx` ≈ **30.7 MB** | ✅ 跑通 |
| opus-mt-en-zh（q8） | `decoder_model_merged_quantized.onnx` = **60,212,804 B ≈ 57.4 MiB** | ❌ `Load failed` |

下载速度可以从 V2 反推：29.3 MB / 52.5 s ≈ **0.56 MB/s**。按这个速度，opus-mt 的
113 MB 需要约 200 秒 —— 这让「**某个体积或时长阈值**」成为首要嫌疑，
而不是「文件缺失」（`scripts/fetch-models.mjs` 的 24 个文件已逐条对照 Hugging Face
的文件清单，**一条不缺**，`source.spm` / `target.spm` / `vocab.json` 都在）。

**下一个探针版本会直接把这件事测出来**（已在代码里，尚未发版）：
V4 失败时会自动做一次**裸取诊断** —— 绕开 transformers.js 和 ORT，用浏览器原生 `fetch`
直接拉 `encoder_model_quantized.onnx`，并报告**断掉之前已经收到多少字节**。
判读方式：

- 裸取成功 → 网络没问题，锅在 transformers.js / ORT；
- 裸取在某个体积附近断掉 → 是体积/时长阈值，那就得**把大模型切片**或**换更小的模型**。

同时新增了「库发出的网络请求（最近 8 条）」一栏，把 transformers.js 真正发过的每一条
请求连同状态码、字节数、耗时都印进报告 —— 以后不用再靠猜是哪一条 URL 失败了。

---

## 三、P0 复用数据（iPhone / Safari）

| 项目 | 数值 | 备注 |
|---|---|---|
| 机型 | iPhone · 430×932 · DPR 3 | 与微信 / Chrome 一致 |
| 逻辑核心数 | 4 | |
| `deviceMemory` | 浏览器未暴露 | iOS 盲区 |
| JS 堆上限 | 非 Chromium 内核 | iOS 盲区 |
| 网络 / 电池 | 未知 / 未暴露 | iOS 盲区 |
| WebGPU | `apple` · maxBuffer 1024 MB · **maxStorageBinding 1024 MB** | 高通那台只有 128 MB |
| WASM SIMD | true | |
| WASM 多线程 / SAB / COI | false / false / false | 见 `V0-设备画像.md`：GitHub Pages 不下发 COOP/COEP |
| 存储配额 / 已用 | 39,321.6 MB / 0.01 MB | |
| Cache Storage / IndexedDB | 可用（写读 4 MB 成功）/ true | |
| AudioContext 实际采样率 | **16000** | 能直接开在 16 kHz，重采样可省 |
| 能强制 16kHz / AudioWorklet / ScriptProcessor | true / true / true | 采集层三种路子全通 |
| 浏览器原生识别 | 没有 | 与 Android 一致 |

---

## 四、对项目的影响

1. **「手机能不能跑」这个问题，答案是能。** 至少 iPhone Safari + 单线程 wasm + q8 是能的，
   RTF 0.25 有一倍以上的余量。
2. **`docs/03` 里对手机的悲观预设可以放宽**：不必把 COOP/COEP 当成必需项。
3. **翻译模型是现在唯一挡在路上的东西。** 转写能跑、摘要不依赖模型，
   只有英中翻译还没在真机上跑起来 —— 它也是「英语转中文」这个需求的核心。
4. **候选对策（按代价从低到高）**：
   - 换一个更小的英中模型（单文件 < 30 MB）；
   - 把 opus-mt 的编码器/解码器改成按需分片下载，避免单次 60 MB；
   - 检查 iOS Safari 对单次 `fetch` 响应体积是否真有限制，若是则改用 `Range` 分块取。

---

## 五、下一步

1. 发出带**裸取诊断**的探针版本，请用户**只重跑 ⑤ V2/V4**（V2 会走缓存，几乎不花流量）。
2. 拿到「断在多少 MB」这个数字后，再决定是换模型还是改下载方式。
3. V2 的识别输出是合成音频，**不代表真实讲话的准确率** —— 那要等主应用能用真麦克风跑再说。

/**
 * 设备画像。
 *
 * 只做**能力判断**，不做用户画像，不读取任何可识别信息，不发起任何请求。
 * 这里所有的判断都只影响「本机模型用哪个精度跑」这类工程决策。
 *
 * 为什么需要它：同一套 `webgpu + fp32` 的配置在桌面很爽，在手机上会直接把
 * 标签页撑爆（Whisper base fp32 的显存/内存占用是 GB 级）。docs/07 的 R1
 * 就是这条。宁可手机上慢一点用 q8 + WASM，也不能白屏。
 */

/**
 * 判断依据的逐条展开。**探针页要把这个打出来** —— 2026/10/6~10/7 连收三份 V8 报告，
 * 每份都写 `是否移动端: false`，而用户坚持是在手机上跑的；三份报告又都没有「运行环境」段，
 * 于是谁也说不清跑的是哪台机器。教训：判定结论必须自带证据，不能只给一个布尔值，
 * 否则一旦结论和当事人的认知冲突，整份报告的可信度都会赔进去。
 */
export interface MobileEvidence {
  verdict: boolean;
  signals: string[];
}

export function mobileEvidence(): MobileEvidence {
  if (typeof navigator === 'undefined') {
    return { verdict: false, signals: ['没有 navigator（不是浏览器环境）'] };
  }
  const signals: string[] = [];
  const ua = navigator.userAgent || '';

  // Chromium 的 UA-CH，最可靠，但只有 Chromium 才有
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData && typeof uaData.mobile === 'boolean') {
    signals.push(`userAgentData.mobile = ${uaData.mobile}`);
    if (uaData.mobile) return { verdict: true, signals };
  }

  const hit = /Android|iPhone|iPad|iPod|Mobile|Windows Phone|HarmonyOS|OpenHarmony|ArkWeb/i.exec(ua);
  if (hit) {
    signals.push(`UA 命中「${hit[0]}」`);
    return { verdict: true, signals };
  }

  const touch = typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0;
  // iPadOS 13+ 装成 macOS，用触点数兜底
  if (/Macintosh/.test(ua) && touch > 2) {
    signals.push(`UA 是 Macintosh，但触点数 ${touch}（iPadOS 13+ 装成 macOS）`);
    return { verdict: true, signals };
  }
  // 最后一道兜底：屏幕短边很小的触摸设备（HarmonyOS NEXT 的 ArkWeb 就是一个例子，
  // 它的 UA 是 `Mozilla/5.0 (Phone; OpenHarmony 5.0) …`，Android / Mobile 一个都没有）
  if (touch > 2 && typeof screen !== 'undefined' && Math.min(screen.width, screen.height) <= 900) {
    signals.push(`触点数 ${touch}，屏幕短边 ${Math.min(screen.width, screen.height)} ≤ 900`);
    return { verdict: true, signals };
  }

  signals.push(`UA 里没有任何移动端关键字，触点数 ${touch}`);
  return { verdict: false, signals };
}

/** 粗略判断是否为手机/平板。宁可误判成移动端（更保守的配置）。 */
export function isLikelyMobile(): boolean {
  return mobileEvidence().verdict;
}

/**
 * 设备内存（GB），Chrome/Edge 提供 `navigator.deviceMemory`（最接近的 2 的幂，上限 8）。
 * Safari/Firefox 没有，返回 null 表示「不知道」，调用方按保守处理。
 */
export function deviceMemoryGb(): number | null {
  if (typeof navigator === 'undefined') return null;
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof value === 'number' && value > 0 ? value : null;
}

/**
 * 是否该走「轻量档」：更小的模型、更低的精度。
 * 判据是「移动端」或「明确知道内存很小」，两者满足其一。
 */
export function shouldUseLightweightModels(): boolean {
  if (isLikelyMobile()) return true;
  const memory = deviceMemoryGb();
  return memory !== null && memory <= 4;
}

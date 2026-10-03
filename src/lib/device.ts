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

/** 粗略判断是否为手机/平板。宁可误判成移动端（更保守的配置）。 */
export function isLikelyMobile(): boolean {
  if (typeof navigator === 'undefined') return false;

  // Chromium 的 UA-CH，最可靠，但只有 Chromium 才有
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile;

  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone|HarmonyOS/i.test(ua)) return true;
  // iPadOS 13+ 装成 macOS，用触点数兜底
  if (/Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 2) {
    return true;
  }
  return false;
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

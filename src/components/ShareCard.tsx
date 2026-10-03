import { useEffect, useState } from 'react';
import { copyText } from '@/lib/export';

/**
 * 分享卡片：把当前网址变成一个二维码。
 *
 * 为什么需要它：这个项目的分发方式就是「把链接发给朋友」。在手机上，
 * 复制链接再粘贴到微信比想象中麻烦得多 —— 让对方直接扫码是最省事的路径。
 * 二维码在本地生成（qrcode 包），**不调用任何在线二维码服务**，否则就违背
 * 「零依赖外部服务」这条原则，也会把网址泄露给第三方。
 */
export function ShareCard() {
  const [url] = useState(() =>
    typeof location === 'undefined' ? '' : location.href.split('#')[0],
  );
  const [png, setPng] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!url) return;

    void (async () => {
      try {
        // 动态导入：二维码只在这个卡片真正出现时才需要，不该拖累首屏
        const mod = await import('qrcode');
        const dataUrl = await mod.toDataURL(url, {
          width: 360,
          margin: 1,
          errorCorrectionLevel: 'M',
          color: { dark: '#0b1220ff', light: '#ffffffff' },
        });
        if (alive) setPng(dataUrl);
      } catch {
        if (alive) setFailed(true);
      }
    })();

    return () => {
      alive = false;
    };
  }, [url]);

  const onCopy = async () => {
    const ok = await copyText(url);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="card">
      <h2 className="text-sm font-semibold text-slate-100">分享给朋友</h2>
      <p className="mt-1 text-xs leading-5 text-slate-400">
        让朋友扫这个码或点链接就能打开。对方不需要注册、不需要装 App，也不用付任何费用。
      </p>

      <div className="mt-3 flex items-center gap-4">
        <div className="grid h-32 w-32 shrink-0 place-items-center overflow-hidden rounded-xl bg-white">
          {png ? (
            <img src={png} alt="打开本页面的二维码" className="h-32 w-32" />
          ) : (
            <span className="px-2 text-center text-[11px] leading-4 text-slate-500">
              {failed ? '二维码生成失败，请直接复制链接' : '二维码生成中…'}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate rounded-lg border border-ink-700 bg-ink-950/60 px-3 py-2 font-mono text-xs text-slate-400">
            {url || '（无法获取当前网址）'}
          </div>
          <button type="button" className="btn-ghost mt-2 w-full" onClick={() => void onCopy()}>
            {copied ? '已复制' : '复制链接'}
          </button>
        </div>
      </div>
    </section>
  );
}

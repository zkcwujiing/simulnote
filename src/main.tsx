import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载点，index.html 可能被改动过。');
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

/**
 * 注册 Service Worker（PWA：可添加到主屏幕 + 断网时还能打开外壳）。
 *
 * 三个约束都是有原因的：
 * - **只在生产注册**。开发时 SW 会缓存住 `index.html` 与已经改过的模块，
 *   于是「改了代码刷新没变化」，排查这个问题花的时间远超它省下的。
 * - **`BASE_URL` 拼路径**。站点部署在 `/simulnote/` 子路径下，
 *   写死 `'/sw.js'` 会去站根找，404 之后静默失败。
 * - **失败只记日志，绝不冒泡**。SW 是锦上添花；它注册不上（隐私模式、
 *   非 HTTPS、浏览器不支持）不该影响这个应用能不能用。
 */
function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const viteEnv = (import.meta as { env?: { PROD?: boolean; BASE_URL?: string } }).env;
  if (!viteEnv?.PROD) return;

  const url = `${viteEnv.BASE_URL ?? '/'}sw.js`;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(url).catch((error: unknown) => {
      console.info('[simulnote] Service Worker 未注册（不影响使用）：', error);
    });
  });
}

registerServiceWorker();

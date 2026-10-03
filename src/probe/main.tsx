import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ProbeApp from './ProbeApp';
import '../index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载点，probe.html 可能被改动过。');
}

createRoot(container).render(
  <StrictMode>
    <ProbeApp />
  </StrictMode>,
);

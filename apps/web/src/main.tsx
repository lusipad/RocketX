import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installLinkInterceptor } from './lib/client';
import './styles.css';

// 桌面端：所有外链点击交给系统浏览器（webview 内 target="_blank" 无效）
installLinkInterceptor();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

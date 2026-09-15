import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

// 字体自托管：PWA 要能离线打开，依赖 Google Fonts 的在线加载会让离线态"字体突变"。
// 中文部分交给系统字体（PingFang SC / 微软雅黑 / 思源），既省体积又更贴平台观感。
import '@fontsource-variable/fraunces';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';

// ink-design 的组件样式（与本项目同一套设计令牌，先于我们的层引入）
import 'ink-design/styles.css';
import './styles/tokens.css';
import './styles/base.css';

import { router } from './router';

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

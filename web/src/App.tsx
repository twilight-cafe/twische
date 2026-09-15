import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Button, ConfigProvider } from 'ink-design';
import { useSessionStore } from '@/stores/session';
import { uiMode, useUiStore } from '@/stores/ui';
import { useEditorStore } from '@/stores/editor';
import { ROUTE_TITLES } from './router';
import AppShell from '@/components/AppShell';
import ToastHost from '@/components/ToastHost';
import TaskEditor from '@/components/TaskEditor';
import LoginView from '@/views/LoginView';
import NotInitializedView from '@/views/NotInitializedView';
import Icon from '@/components/Icon';
import './App.css';

/**
 * 应用根组件。
 *
 * 先根据会话状态决定渲染什么，再套上外壳。这个顺序很重要：
 * 未初始化 / 未登录时不应该看到任何导航外壳 —— 那会让用户以为已经"进去了"，
 * 却怎么点都没有数据。
 */
export default function App() {
  const location = useLocation();
  const status = useSessionStore((s) => s.status);
  const bootError = useSessionStore((s) => s.bootError);
  const serverVersion = useSessionStore((s) => s.serverVersion);
  const bootstrap = useSessionStore((s) => s.bootstrap);

  const themePref = useUiStore((s) => s.themePref);
  const systemDark = useUiStore((s) => s.systemDark);
  const swUpdateReady = useUiStore((s) => s.swUpdateReady);
  const bindServiceWorker = useUiStore((s) => s.bindServiceWorker);
  const applyUpdate = useUiStore((s) => s.applyUpdate);
  const openCreate = useEditorStore((s) => s.openCreate);

  const mode = uiMode({ themePref, systemDark });

  useEffect(() => {
    bindServiceWorker();
    void bootstrap();
    // 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 直接写 data-mode，与首屏引导脚本用的是同一个属性
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-mode', mode);
  }, [mode]);

  const pageTitle = ROUTE_TITLES[location.pathname] || 'Twische';
  const booting = status === 'checking';

  return (
    <ConfigProvider theme={{ radius: 4, dark: mode === 'dark' }}>
      <div className="app">
        {/* ── 启动中 ── */}
        {booting && (
          <div className="boot">
            <div className="boot__mark">
              <span className="boot__t">T</span>
              <span className="boot__dot" />
            </div>
            <p className="boot__text">正在连接 Twische…</p>
          </div>
        )}

        {/* ── 服务端未初始化：前端无能为力，给准确的命令行指引 ── */}
        {!booting && status === 'need-init' && <NotInitializedView version={serverVersion} />}

        {/* ── 未登录 ── */}
        {!booting && status === 'need-login' && <LoginView />}

        {/* ── 连接异常 ── */}
        {!booting && status === 'error' && (
          <div className="fatal">
            <div className="fatal__box">
              <span className="fatal__icon">
                <Icon name="wifi-off" size={26} />
              </span>
              <h1 className="fatal__title">无法连接到 Twische 服务</h1>
              <p className="fatal__msg">{bootError || '请确认后端服务正在运行。'}</p>
              <div className="fatal__actions">
                <Button primary icon={<Icon name="refresh" size={16} />} onClick={() => void bootstrap()}>
                  重试连接
                </Button>
              </div>
              <p className="fatal__hint">
                后端未启动？在项目目录执行 <code className="mono">twische serve</code>
              </p>
            </div>
          </div>
        )}

        {/* ── 就绪 ── */}
        {!booting && status === 'ready' && (
          <>
            <AppShell title={pageTitle} onNewTask={() => openCreate()}>
              <Outlet />
            </AppShell>
            <TaskEditor />
          </>
        )}

        {/* 更新提示：常驻在所有状态之上 */}
        {swUpdateReady && (
          <div className="update-bar">
            <span>Twische 有新版本</span>
            <Button small onClick={applyUpdate}>
              立即更新
            </Button>
          </div>
        )}

        <ToastHost />
      </div>
    </ConfigProvider>
  );
}

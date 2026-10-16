import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Button, ConfigProvider } from 'ink-design';
import { useSessionStore } from '@/stores/session';
import { uiMode, useUiStore } from '@/stores/ui';
import { useEditorStore } from '@/stores/editor';
import { ROUTE_TITLES } from './router';
import AppShell from '@/components/AppShell';
import ToastHost from '@/components/ToastHost';
import NotifyHost from '@/components/NotifyHost';
import TaskEditor from '@/components/TaskEditor';
import ConnectView from '@/views/ConnectView';
import Icon from '@/components/Icon';
import './App.css';

/**
 * 应用根组件。
 *
 * 渲染顺序遵循"先给界面，再对答案"：只要连接状态允许，就立刻把外壳和内容交出去，
 * 远端校验在后台进行。未配置 / 未连接时不显示任何导航外壳 —— 那会让用户以为
 * 已经"进去了"，却怎么点都没有数据。
 *
 * `status === 'checking'` 只在**本机没有可信连接**时才会持续（首次访问），
 * 此时确实没有任何数据可渲染，boot 占位是诚实的。连过的设备会跳过它。
 */
export default function App() {
  const location = useLocation();
  const status = useSessionStore((s) => s.status);
  const bootError = useSessionStore((s) => s.bootError);
  const bootstrap = useSessionStore((s) => s.bootstrap);

  const themePref = useUiStore((s) => s.themePref);
  const systemDark = useUiStore((s) => s.systemDark);
  const swUpdateReady = useUiStore((s) => s.swUpdateReady);
  const bindServiceWorker = useUiStore((s) => s.bindServiceWorker);
  const applyUpdate = useUiStore((s) => s.applyUpdate);
  const openCreate = useEditorStore((s) => s.openCreate);
  const sessionVerified = useSessionStore((s) => s.sessionVerified);

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

  // 后台校验通常几十毫秒就结束，立刻显示提示会变成一次刺眼的闪烁。
  // 延迟一小段再做判断：快网络下用户根本不会看到它。
  const [showConnecting, setShowConnecting] = useState(false);
  const connectingNow = status === 'ready' && !sessionVerified;
  useEffect(() => {
    if (!connectingNow) {
      setShowConnecting(false);
      return;
    }
    const t = setTimeout(() => setShowConnecting(true), 700);
    return () => clearTimeout(t);
  }, [connectingNow]);

  const pageTitle = ROUTE_TITLES[location.pathname] || 'Twische';
  // 仅"本机没有任何可信连接"时才是真正的启动等待
  const booting = status === 'checking';
  // 已进入主界面但服务端尚未确认：给一个不打扰的弱提示，绝不挡住操作
  const connecting = connectingNow && showConnecting;

  return (
    <ConfigProvider theme={{ radius: 4, dark: mode === 'dark' }}>
      <div className="app">
        {/* ── 首次启动：本机没有可信会话，确实无数据可渲染 ── */}
        {booting && (
          <div className="boot">
            <div className="boot__mark">
              <span className="boot__t">T</span>
              <span className="boot__dot" />
            </div>
            <p className="boot__text">正在连接 Twische…</p>
          </div>
        )}

        {/* ── 从未配置过：连接向导 ── */}
        {!booting && status === 'need-setup' && <ConnectView mode="setup" />}

        {/* ── 配过地址但需要密码 ── */}
        {!booting && status === 'need-login' && <ConnectView mode="password" />}

        {/* ── 连接异常 ── */}
        {!booting && status === 'error' && (
          <div className="fatal">
            <div className="fatal__box">
              <span className="fatal__icon">
                <Icon name="wifi-off" size={26} />
              </span>
              <h1 className="fatal__title">无法连接到 WebDAV 服务器</h1>
              <p className="fatal__msg">{bootError || '请检查地址、网络与服务器状态。'}</p>
              <div className="fatal__actions">
                <Button primary icon={<Icon name="refresh" size={16} />} onClick={() => void bootstrap()}>
                  重试连接
                </Button>
              </div>
              <p className="fatal__hint">
                地址或凭据需要修改？在设置 → 连接里调整。
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

        {/*
          后台校验中：界面已经完全可用，这里只是一个不拦截点击的弱提示。
          它不能做成遮罩 —— 那等于把刚省下的等待时间又还回去。
        */}
        {connecting && (
          <div className="connecting" role="status" aria-live="polite">
            <span className="connecting__spin" />
            <span>正在同步…</span>
          </div>
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
        {/* 状态栏常驻通知：与界面状态无关，连接与否都要维护 */}
        <NotifyHost />
      </div>
    </ConfigProvider>
  );
}

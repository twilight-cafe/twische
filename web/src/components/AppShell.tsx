/**
 * 应用外壳与响应式导航。
 *
 * 三档断点，各自解决不同的问题：
 *   ≥1024px  侧栏 232px —— 标签 + 图标，信息密度优先
 *   768–1023 图标轨 68px —— 平板上给内容让路，靠 title 提示
 *   <768px   顶部栏 + 底部标签栏 —— 底部才是拇指可达区
 */
import { NavLink, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useUiStore } from '@/stores/ui';
import Icon from './Icon';
import SyncBadge from './SyncBadge';
import './AppShell.css';

const NAV = [
  { to: '/today', label: '今日', icon: 'calendar-check' },
  { to: '/week', label: '本周', icon: 'columns' },
  { to: '/month', label: '月历', icon: 'grid' },
  { to: '/tasks', label: '任务', icon: 'list' },
  { to: '/stats', label: '统计', icon: 'chart' },
  { to: '/settings', label: '设置', icon: 'sliders' },
];

export interface AppShellProps {
  title?: string;
  onNewTask: () => void;
  children?: ReactNode;
}

export default function AppShell({ title, onNewTask, children }: AppShellProps) {
  const location = useLocation();
  const themePref = useUiStore((s) => s.themePref);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const isStandalone = useUiStore((s) => s.isStandalone);
  const cycleTheme = useUiStore((s) => s.cycleTheme);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);

  const activePath = location.pathname;

  const themeIcon = themePref === 'auto' ? 'sparkle' : themePref === 'light' ? 'sun' : 'moon';
  const themeLabel = themePref === 'auto' ? '跟随系统' : themePref === 'light' ? '浅色' : '深色';

  return (
    <div className="shell">
      {/* ── 侧栏 / 图标轨 ── */}
      <aside className="shell__nav" data-collapsed={sidebarCollapsed}>
        <NavLink to="/today" className="brand" title="Twische">
          <span className="brand__mark">
            <span className="brand__t">T</span>
            <span className="brand__dot" />
          </span>
          <span className="brand__text">
            <span className="brand__name">Twische</span>
            <span className="brand__sub">以时间为墨</span>
          </span>
        </NavLink>

        <button className="btn btn--primary new-btn" type="button" onClick={onNewTask}>
          <Icon name="plus" size={16} />
          <span className="new-btn__label">新建任务</span>
        </button>

        <nav className="nav" aria-label="主导航">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={`nav__item${activePath === item.to ? ' is-active' : ''}`}
              title={item.label}
            >
              <Icon name={item.icon} size={18} />
              <span className="nav__label">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="shell__nav-foot">
          <SyncBadge />
          <button
            className="foot-btn"
            type="button"
            title={`外观：${themeLabel}`}
            onClick={cycleTheme}
          >
            <Icon name={themeIcon} size={16} />
            <span className="foot-btn__label">{themeLabel}</span>
          </button>
          {!isStandalone && (
            <button
              className="foot-btn"
              type="button"
              title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            >
              <Icon name="panel-left" size={16} />
              <span className="foot-btn__label">{sidebarCollapsed ? '展开' : '收起'}</span>
            </button>
          )}
        </div>
      </aside>

      {/* ── 手机顶部栏 ── */}
      <header className="shell__top">
        <div className="top-brand">
          <span className="brand__mark brand__mark--sm">
            <span className="brand__t">T</span>
            <span className="brand__dot" />
          </span>
          <h1 className="top-title">{title || 'Twische'}</h1>
        </div>
        <div className="top-actions">
          <SyncBadge compact />
          <button
            className="icon-btn"
            type="button"
            title={`外观：${themeLabel}`}
            onClick={cycleTheme}
          >
            <Icon name={themeIcon} size={17} />
          </button>
        </div>
      </header>

      {/* ── 内容 ── */}
      <main className="shell__main scroll">
        <div className="shell__content">{children}</div>
      </main>

      {/* ── 手机底部标签栏 ── */}
      <nav className="shell__tabs" aria-label="主导航">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={`tab${activePath === item.to ? ' is-active' : ''}`}
          >
            <Icon name={item.icon} size={20} />
            <span className="tab__label">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* 手机端的新建按钮：拇指最容易够到的右下角 */}
      <button className="fab" type="button" aria-label="新建任务" onClick={onNewTask}>
        <Icon name="plus" size={22} />
      </button>
    </div>
  );
}

import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import App from './App';

/**
 * 路由。全部懒加载 —— 首屏只需要"今日"，统计与设置这类页面按需下载，
 * 对手机端的首屏时间影响很明显。
 */
const TodayView = lazy(() => import('@/views/TodayView'));
const WeekView = lazy(() => import('@/views/WeekView'));
const MonthView = lazy(() => import('@/views/MonthView'));
const TasksView = lazy(() => import('@/views/TasksView'));
const StatsView = lazy(() => import('@/views/StatsView'));
const SettingsView = lazy(() => import('@/views/SettingsView'));

/** 路径 → 页面标题（App 顶栏与移动端标题用）。 */
export const ROUTE_TITLES: Record<string, string> = {
  '/today': '今日',
  '/week': '本周',
  '/month': '月历',
  '/tasks': '任务',
  '/stats': '统计',
  '/settings': '设置',
};

function lazyEl(node: React.ReactNode) {
  return <Suspense fallback={null}>{node}</Suspense>;
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to="/today" replace /> },
      { path: 'today', element: lazyEl(<TodayView />) },
      { path: 'week', element: lazyEl(<WeekView />) },
      { path: 'month', element: lazyEl(<MonthView />) },
      { path: 'tasks', element: lazyEl(<TasksView />) },
      { path: 'stats', element: lazyEl(<StatsView />) },
      { path: 'settings', element: lazyEl(<SettingsView />) },
      // 兜底：未知路径回今日，而不是停在空白页
      { path: '*', element: <Navigate to="/today" replace /> },
    ],
  },
]);

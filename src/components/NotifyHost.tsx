/**
 * 通知运行时的挂载点。
 *
 * 与 ToastHost 同形：一个不渲染任何东西的组件，
 * 唯一职责是把通知调度绑到应用生命周期上。
 */
import { useEffect } from 'react';
import { startNotifyRuntime, stopNotifyRuntime } from '@/lib/notifyRuntime';

export default function NotifyHost() {
  useEffect(() => {
    startNotifyRuntime();
    return () => stopNotifyRuntime();
  }, []);

  return null;
}

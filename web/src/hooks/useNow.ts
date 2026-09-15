import { useEffect, useSyncExternalStore } from 'react';
import { nowMinutes, todayKey } from '@/lib/datetime';

/**
 * 共享的"当前时刻"。
 *
 * 多个视图都要画当前时刻线、都要判断"今天"，如果各自起一个定时器，
 * 页面一多就是十几个 timer。这里用一个模块级单例，引用计数归零时停掉。
 */
let minutes = nowMinutes();
let today = todayKey();
let timer: ReturnType<typeof setInterval> | null = null;
let subscribers = 0;

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function start(): void {
  if (timer) return;
  // 每 20 秒够用了：时刻线在 60px 高的行里移动 1 分钟也就 1px
  timer = setInterval(() => {
    minutes = nowMinutes();
    const t = todayKey();
    // 跨午夜时"今天"会变，视图需要重新取数
    if (t !== today) today = t;
    emit();
  }, 20_000);
}

function stop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function useNow(): { minutes: number; today: string } {
  useEffect(() => {
    subscribers += 1;
    start();
    // 立即刷新一次：从后台切回来时可能已经过了很久
    minutes = nowMinutes();
    today = todayKey();
    emit();
    return () => {
      subscribers -= 1;
      if (subscribers <= 0) stop();
    };
  }, []);

  const m = useSyncExternalStore(subscribe, () => minutes);
  const t = useSyncExternalStore(subscribe, () => today);
  return { minutes: m, today: t };
}

/** 不参与引用计数的一次性读取（例如在事件回调里用）。 */
export function currentMinutes(): number {
  return nowMinutes();
}

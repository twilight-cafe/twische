import { useSyncExternalStore } from 'react';
import { getRev, subscribe } from '@/lib/localrepo';
import { subscribeSync } from '@/lib/sync';

/**
 * 订阅本地仓库：任何写入（rev 变化）都会让组件重算。
 * 视图先调用它，再从 store 里读数据 —— 等价于 Vue 版里对 reactive 的隐式依赖。
 */
export function useRepoRev(): number {
  return useSyncExternalStore(subscribe, getRev, getRev);
}

// ── 同步引擎状态订阅 ──
// syncState 是 plain 对象，这里用"通知即自增"的版本号把它接进 useSyncExternalStore。

let version = 0;

function subscribeWrapped(fn: () => void): () => void {
  return subscribeSync(() => {
    version += 1;
    fn();
  });
}

/**
 * 订阅同步引擎状态。返回值是内部版本计数器，仅用于触发重渲染；
 * 读取具体状态请直接访问 syncState。
 */
export function useSyncTick(): number {
  return useSyncExternalStore(subscribeWrapped, () => version, () => version);
}

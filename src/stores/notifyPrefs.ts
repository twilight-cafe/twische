/**
 * 通知偏好与权限状态。
 *
 * 与主题、周起始日一样只存本机（localStorage）——"这台设备要不要在状态栏提醒我"
 * 是设备属性，不是数据属性，同步到另一台设备只会让那边莫名其妙地弹通知。
 *
 * 存储只有一个键 `twische.pref.notify`，整体读写：拆成多个键以后，
 * 新增字段就要在各个读取点写兜底，而整体读一次只需要一个归一化函数。
 */
import { create } from 'zustand';
import { localPrefs } from '@/repo/localrepo';
import { detectNativePlatform } from '@/lib/notifyChannel';

export type NotifyPermission = 'default' | 'granted' | 'denied' | 'unsupported';

export interface NotifyPrefs {
  /** 总开关。关掉以后不再产生任何通知，也不申请权限。 */
  enabled: boolean;
  /** 浏览器里页面可见时是否也发。壳内不使用这一项（常驻通知必须一直在）。 */
  showWhileVisible: boolean;
  /** 状态栏里最多列几行事项，3–12。 */
  maxLines: number;
}

export const NOTIFY_DEFAULTS: NotifyPrefs = {
  enabled: false,
  showWhileVisible: false,
  maxLines: 8,
};

export const NOTIFY_MAX_LINES_RANGE = { min: 3, max: 12 } as const;

const STORE_KEY = 'notify';

function clampLines(v: number): number {
  if (!Number.isFinite(v)) return NOTIFY_DEFAULTS.maxLines;
  const n = Math.round(v);
  return Math.min(NOTIFY_MAX_LINES_RANGE.max, Math.max(NOTIFY_MAX_LINES_RANGE.min, n));
}

/**
 * 把任意来源的值归一化成合法且完整的偏好。
 *
 * 读到的东西可能来自旧版本、被手工改过的 localStorage，甚至是 `null`；
 * 一律在这里收敛成确定的形状，下游就不必再写 `??`。
 */
export function normalizePrefs(raw: unknown): NotifyPrefs {
  const d = (raw ?? {}) as Partial<NotifyPrefs>;
  return {
    enabled: d.enabled === true,
    showWhileVisible: d.showWhileVisible === true,
    maxLines: clampLines(typeof d.maxLines === 'number' ? d.maxLines : NOTIFY_DEFAULTS.maxLines),
  };
}

/**
 * 当前环境能给出的通知权限判断，供 UI 决定"要不要渲染通知卡片"。
 *
 * 壳内**必须**先看平台：安卓 WebView 至今没有实现 Notifications API
 * （Chromium 的 "Implement support for Notifications API in WebView" 仍未落地），
 * 所以 `typeof Notification === 'undefined'` 在壳里恒成立。
 * 若据此判成 unsupported，整张通知卡片连开关都不会渲染 ——
 * 壳内用户将没有任何入口打开通知。壳里的真实权限由原生通道给出。
 */
export function notificationEnv(): NotifyPermission {
  if (detectNativePlatform()) return 'default';
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

interface NotifyState extends NotifyPrefs {
  permission: NotifyPermission;
  setPrefs(patch: Partial<NotifyPrefs>): void;
  setPermission(p: NotifyPermission): void;
}

export const useNotifyStore = create<NotifyState>((set, get) => ({
  ...normalizePrefs(localPrefs.get<unknown>(STORE_KEY, null)),
  permission: notificationEnv(),

  setPrefs(patch) {
    const next = normalizePrefs({ ...get(), ...patch });
    set(next);
    localPrefs.set(STORE_KEY, next);
  },

  setPermission(p) {
    set({ permission: p });
  },
}));

export function notifyPrefs(): NotifyPrefs {
  const { enabled, showWhileVisible, maxLines } = useNotifyStore.getState();
  return { enabled, showWhileVisible, maxLines };
}

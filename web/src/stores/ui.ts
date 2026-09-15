/**
 * 界面状态：主题、周起始日、提示消息、PWA 安装与更新。
 *
 * 全部只存在本地（localStorage），不参与同步 —— 每台设备的屏幕、习惯、
 * 是否装成 App 都不同，把这些同步过去只会让另一台设备变得别扭。
 */
import { create } from 'zustand';
import { localPrefs } from '@/lib/localrepo';

export type ThemePref = 'auto' | 'light' | 'dark';
export type ToastKind = 'info' | 'ok' | 'warn' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
  /** 可选的操作按钮，例如"重试" */
  action?: { label: string; run: () => void };
  /** 毫秒；0 表示不自动消失 */
  ttl: number;
}

export interface ToastOptions {
  kind?: ToastKind;
  detail?: string;
  action?: { label: string; run: () => void };
  ttl?: number;
}

let toastSeq = 0;

interface UiState {
  themePref: ThemePref;
  systemDark: boolean;
  weekStart: number;
  compactHours: boolean;
  sidebarCollapsed: boolean;
  toasts: Toast[];
  canInstall: boolean;
  isStandalone: boolean;
  swUpdateReady: boolean;
  online: boolean;
}

interface UiActions {
  setThemePref(p: ThemePref): void;
  cycleTheme(): void;
  setWeekStart(v: number): void;
  setCompactHours(v: boolean): void;
  setSidebarCollapsed(v: boolean): void;
  toast(message: string, opts?: ToastOptions): number;
  dismiss(id: number): void;
  promptInstall(): Promise<void>;
  bindServiceWorker(): void;
  applyUpdate(): void;
}

export type UiStore = UiState & UiActions;

/** 由主题偏好与系统偏好推导当前生效的模式。 */
export function uiMode(s: Pick<UiState, 'themePref' | 'systemDark'>): 'light' | 'dark' {
  return s.themePref === 'auto' ? (s.systemDark ? 'dark' : 'light') : s.themePref;
}

/** 周视图小时行高。 */
export function uiHourHeight(compactHours: boolean): number {
  return compactHours ? 44 : 60;
}

function detectStandalone(): boolean {
  // SSR 防御：浏览器包里 window 恒定义
  /* v8 ignore next */
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

let waitingWorker: ServiceWorker | null = null;

export const useUiStore = create<UiStore>((set, get) => ({
  themePref: localPrefs.get<ThemePref>('theme', 'auto'),
  // SSR 防御：浏览器包里 window 恒定义
  /* v8 ignore next 3 */
  systemDark: typeof window !== 'undefined' && !!window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false,
  weekStart: localPrefs.get('weekStart', 1),
  compactHours: localPrefs.get('compactHours', false),
  sidebarCollapsed: localPrefs.get('sidebarCollapsed', false),
  toasts: [],
  canInstall: false,
  isStandalone: detectStandalone(),
  swUpdateReady: false,
  /* v8 ignore next */
  online: typeof navigator === 'undefined' ? true : navigator.onLine,

  // ── 主题 ──
  setThemePref(p) {
    set({ themePref: p });
    localPrefs.set('theme', p);
  },

  cycleTheme() {
    const cur = get().themePref;
    const next: ThemePref = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
    get().setThemePref(next);
  },

  setWeekStart(v) {
    set({ weekStart: v });
    localPrefs.set('weekStart', v);
  },

  setCompactHours(v) {
    set({ compactHours: v });
    localPrefs.set('compactHours', v);
  },

  setSidebarCollapsed(v) {
    set({ sidebarCollapsed: v });
    localPrefs.set('sidebarCollapsed', v);
  },

  // ── 提示消息 ──
  toast(message, opts = {}) {
    const id = ++toastSeq;
    const item: Toast = {
      id,
      kind: opts.kind ?? 'info',
      message,
      detail: opts.detail,
      action: opts.action,
      ttl: opts.ttl ?? (opts.action ? 8000 : 3600),
    };
    set((s) => ({ toasts: [...s.toasts, item] }));
    if (item.ttl > 0) {
      setTimeout(() => get().dismiss(id), item.ttl);
    }
    return id;
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  // ── PWA：安装提示 ──
  async promptInstall() {
    const ev = installEvent;
    if (!ev) return;
    ev.prompt();
    try {
      const choice = await ev.userChoice;
      if (choice?.outcome === 'accepted') {
        get().toast('正在安装…', { kind: 'ok' });
      }
      installEvent = null;
      set({ canInstall: false });
    } catch {
      /* 用户直接关掉了，不算错误 */
    }
  },

  // ── PWA：Service Worker 更新 ──
  bindServiceWorker() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    if (import.meta.env.DEV) return; // 开发时 SW 会干扰热更新

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        // 注册被浏览器策略拦下时（无痕、企业策略、自动化环境）可能拿到 undefined，
        // 这里必须挡住，否则一个未处理的 TypeError 会污染控制台
        if (!reg) return;
        if (reg.waiting) {
          waitingWorker = reg.waiting;
          set({ swUpdateReady: true });
        }
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            // 有旧版本在控制页面时，新的才叫"更新"；否则是首次安装
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              waitingWorker = installing;
              set({ swUpdateReady: true });
            }
          });
        });
      })
      .catch((err) => {
        console.warn('[twische] Service Worker 注册失败', err);
      });

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  },

  applyUpdate() {
    if (!waitingWorker) {
      window.location.reload();
      return;
    }
    // 通知新 SW 接管，controllerchange 会触发一次刷新
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    set({ swUpdateReady: false });
  },
}));

/** 语义化提示入口，与 Vue 版的 notify 同形。 */
export const notify = {
  info: (m: string, d?: string) => useUiStore.getState().toast(m, { kind: 'info', detail: d }),
  ok: (m: string, d?: string) => useUiStore.getState().toast(m, { kind: 'ok', detail: d }),
  warn: (m: string, d?: string) => useUiStore.getState().toast(m, { kind: 'warn', detail: d }),
  error: (m: string, d?: string) =>
    useUiStore.getState().toast(m, { kind: 'error', detail: d, ttl: 7000 }),
};

// ── 模块级事件绑定（与 App 同生命周期，绑一次即可） ──

interface InstallPromptEvent extends Event {
  prompt(): void;
  userChoice: Promise<{ outcome: string }>;
}

let installEvent: InstallPromptEvent | null = null;

if (typeof window !== 'undefined') {
  // 系统深色偏好变化
  if (window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener?.('change', (e) => {
      useUiStore.setState({ systemDark: e.matches });
    });
  }

  // 网络状态
  window.addEventListener('online', () => useUiStore.setState({ online: true }));
  window.addEventListener('offline', () => useUiStore.setState({ online: false }));

  window.addEventListener('beforeinstallprompt', (e: Event) => {
    // 拦下浏览器自带的横幅，改由我们在设置页里给一个更合适的入口
    e.preventDefault();
    installEvent = e as InstallPromptEvent;
    useUiStore.setState({ canInstall: true });
  });

  window.addEventListener('appinstalled', () => {
    installEvent = null;
    useUiStore.setState({ canInstall: false, isStandalone: true });
    notify.ok('已安装到桌面', '下次可以从图标直接打开 Twische');
  });
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useUiStore, notify, uiMode, uiHourHeight, type ThemePref } from './ui';
import { localPrefs } from '@/lib/localrepo';

/**
 * ui store 测试：主题、toast、PWA 安装与 SW 更新。
 * store 是模块级单例：每个用例前把状态复位到初始形状。
 */

function resetStore(): void {
  useUiStore.setState({
    themePref: 'auto',
    systemDark: false,
    weekStart: 1,
    compactHours: false,
    sidebarCollapsed: false,
    toasts: [],
    canInstall: false,
    isStandalone: false,
    swUpdateReady: false,
    online: true,
  });
}

beforeEach(() => {
  localStorage.clear();
  resetStore();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('纯函数', () => {
  it('uiMode 由偏好与系统深色推导', () => {
    expect(uiMode({ themePref: 'auto', systemDark: false })).toBe('light');
    expect(uiMode({ themePref: 'auto', systemDark: true })).toBe('dark');
    expect(uiMode({ themePref: 'light', systemDark: true })).toBe('light');
    expect(uiMode({ themePref: 'dark', systemDark: false })).toBe('dark');
  });

  it('uiHourHeight', () => {
    expect(uiHourHeight(false)).toBe(60);
    expect(uiHourHeight(true)).toBe(44);
  });
});

describe('主题', () => {
  it('setThemePref 更新状态并持久化', () => {
    useUiStore.getState().setThemePref('dark');
    expect(useUiStore.getState().themePref).toBe('dark');
    expect(localPrefs.get<ThemePref>('theme', 'auto')).toBe('dark');
  });

  it('cycleTheme 循环 auto → light → dark → auto', () => {
    const s = useUiStore.getState();
    s.cycleTheme();
    expect(useUiStore.getState().themePref).toBe('light');
    s.cycleTheme();
    expect(useUiStore.getState().themePref).toBe('dark');
    s.cycleTheme();
    expect(useUiStore.getState().themePref).toBe('auto');
  });

  it('周起始 / 紧凑小时 / 侧栏折叠 持久化', () => {
    const s = useUiStore.getState();
    s.setWeekStart(0);
    s.setCompactHours(true);
    s.setSidebarCollapsed(true);
    expect(localPrefs.get('weekStart', 1)).toBe(0);
    expect(localPrefs.get('compactHours', false)).toBe(true);
    expect(localPrefs.get('sidebarCollapsed', false)).toBe(true);
  });
});

describe('toast', () => {
  it('toast 入队、带 action 时 ttl 更长', () => {
    const id = useUiStore.getState().toast('hello');
    const id2 = useUiStore.getState().toast('with action', { action: { label: '重试', run: () => {} } });
    const toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts.find((t) => t.id === id)!.ttl).toBe(3600);
    expect(toasts.find((t) => t.id === id2)!.ttl).toBe(8000);
  });

  it('notify 语义化入口映射正确的 kind', () => {
    notify.info('i');
    notify.ok('o');
    notify.warn('w');
    notify.error('e');
    const kinds = useUiStore.getState().toasts.map((t) => t.kind);
    expect(kinds).toEqual(['info', 'ok', 'warn', 'error']);
    expect(useUiStore.getState().toasts[3].ttl).toBe(7000);
  });

  it('ttl 到期自动消失（fake timers）', async () => {
    vi.useFakeTimers();
    const id = useUiStore.getState().toast('gone', { ttl: 1000 });
    expect(useUiStore.getState().toasts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1001);
    expect(useUiStore.getState().toasts.find((t) => t.id === id)).toBeUndefined();
  });

  it('dismiss 移除指定 id；不存在的 id 是空操作', () => {
    const id = useUiStore.getState().toast('x');
    useUiStore.getState().dismiss(999);
    expect(useUiStore.getState().toasts).toHaveLength(1);
    useUiStore.getState().dismiss(id);
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });
});

describe('PWA 安装', () => {
  function fireInstallPrompt(opts: { userChoice: Promise<{ outcome: string }> }): void {
    const ev = Object.assign(new Event('beforeinstallprompt'), {
      prompt: vi.fn(),
      userChoice: opts.userChoice,
    });
    window.dispatchEvent(ev);
  }

  it('beforeinstallprompt 事件后 canInstall 变为 true', () => {
    fireInstallPrompt({ userChoice: Promise.resolve({ outcome: 'dismissed' }) });
    expect(useUiStore.getState().canInstall).toBe(true);
  });

  it('promptInstall 用户接受 → 提示 + 清除状态', async () => {
    fireInstallPrompt({ userChoice: Promise.resolve({ outcome: 'accepted' }) });
    await useUiStore.getState().promptInstall();
    expect(useUiStore.getState().canInstall).toBe(false);
    expect(useUiStore.getState().toasts.some((t) => t.message === '正在安装…')).toBe(true);
  });

  it('promptInstall 用户拒绝 → 安静收场', async () => {
    fireInstallPrompt({ userChoice: Promise.resolve({ outcome: 'dismissed' }) });
    await useUiStore.getState().promptInstall();
    expect(useUiStore.getState().canInstall).toBe(false);
  });

  it('userChoice 拒绝（reject）不算错误', async () => {
    fireInstallPrompt({ userChoice: Promise.reject(new Error('gone')) });
    await expect(useUiStore.getState().promptInstall()).resolves.toBeUndefined();
  });

  it('没有安装事件时 promptInstall 直接返回', async () => {
    // appinstalled 处理器会清掉模块级 installEvent
    window.dispatchEvent(new Event('appinstalled'));
    await expect(useUiStore.getState().promptInstall()).resolves.toBeUndefined();
  });

  it('appinstalled 事件更新状态并提示', () => {
    fireInstallPrompt({ userChoice: Promise.resolve({ outcome: 'accepted' }) });
    window.dispatchEvent(new Event('appinstalled'));
    const s = useUiStore.getState();
    expect(s.canInstall).toBe(false);
    expect(s.isStandalone).toBe(true);
  });
});

describe('Service Worker 更新', () => {
  function stubServiceWorker(registerImpl: () => unknown): void {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: vi.fn(() => Promise.resolve().then(registerImpl)),
        addEventListener: vi.fn(),
        controller: {},
      },
    });
  }

  /** jsdom 的 location.reload 不可 redefine，整体替换 window.location。 */
  function stubReload(): ReturnType<typeof vi.fn> {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { reload } as unknown as Location,
    });
    return reload;
  }

  it('DEV 环境直接跳过注册', () => {
    const reg = vi.fn();
    stubServiceWorker(reg);
    useUiStore.getState().bindServiceWorker();
    expect(reg).not.toHaveBeenCalled();
  });

  it('applyUpdate：无 waiting worker 时直接刷新', () => {
    // 必须放在所有会把 waitingWorker 置位的用例之前（模块级单例，置位后不回落）
    const reload = stubReload();
    useUiStore.getState().applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('环境不支持 SW 时直接返回', () => {
    vi.stubEnv('DEV', false);
    // 前面的用例用 defineProperty 塞过 serviceWorker：删掉它模拟不支持的浏览器
    Reflect.deleteProperty(navigator, 'serviceWorker');
    expect(() => useUiStore.getState().bindServiceWorker()).not.toThrow();
  });

  it('注册成功：waiting 存在时提示可更新', async () => {
    vi.stubEnv('DEV', false);
    const reg = { waiting: { postMessage: vi.fn() }, installing: null, addEventListener: vi.fn() };
    stubServiceWorker(() => reg);
    useUiStore.getState().bindServiceWorker();
    await vi.waitFor(() => expect(useUiStore.getState().swUpdateReady).toBe(true));
  });

  it('注册成功：新 SW 安装完成且已有旧控制器 → 提示可更新', async () => {
    vi.stubEnv('DEV', false);
    const listeners: Record<string, Array<() => void>> = {};
    const installing = {
      state: 'installing',
      addEventListener: vi.fn((_t: string, fn: () => void) => {
        (listeners.statechange ??= []).push(fn);
      }),
    };
    const reg = {
      waiting: null,
      installing,
      addEventListener: vi.fn((_t: string, fn: () => void) => {
        (listeners.updatefound ??= []).push(fn);
      }),
    };
    stubServiceWorker(() => reg);
    useUiStore.getState().bindServiceWorker();
    await vi.waitFor(() => expect(reg.addEventListener).toHaveBeenCalled());

    for (const fn of listeners.updatefound ?? []) fn();
    expect(useUiStore.getState().swUpdateReady).toBe(false); // state 还是 installing
    installing.state = 'installed';
    for (const fn of listeners.statechange ?? []) fn();
    expect(useUiStore.getState().swUpdateReady).toBe(true);
  });

  it('installing 为空时 updatefound 是空操作', async () => {
    vi.stubEnv('DEV', false);
    const listeners: Array<() => void> = [];
    const reg = { waiting: null, installing: null, addEventListener: vi.fn((_t: string, fn: () => void) => listeners.push(fn)) };
    stubServiceWorker(() => reg);
    useUiStore.getState().bindServiceWorker();
    await vi.waitFor(() => expect(reg.addEventListener).toHaveBeenCalled());
    for (const fn of listeners) fn();
    expect(useUiStore.getState().swUpdateReady).toBe(false);
  });

  it('注册被拒（返回 undefined）不崩溃', async () => {
    vi.stubEnv('DEV', false);
    stubServiceWorker(() => undefined);
    expect(() => useUiStore.getState().bindServiceWorker()).not.toThrow();
  });

  it('注册失败只警告', async () => {
    vi.stubEnv('DEV', false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubServiceWorker(() => Promise.reject(new Error('denied')));
    useUiStore.getState().bindServiceWorker();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });

  it('controllerchange 触发一次页面刷新', () => {
    vi.stubEnv('DEV', false);
    const listeners: Array<() => void> = [];
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: vi.fn(() => Promise.resolve(undefined)),
        addEventListener: vi.fn((_t: string, fn: () => void) => listeners.push(fn)),
      },
    });
    const reload = stubReload();
    useUiStore.getState().bindServiceWorker();
    for (const fn of listeners) fn();
    for (const fn of listeners) fn(); // 第二次不应重复刷新
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('applyUpdate：有 waiting worker 时通知接管', async () => {
    vi.stubEnv('DEV', false);
    const postMessage = vi.fn();
    const reg = { waiting: { postMessage }, installing: null, addEventListener: vi.fn() };
    stubServiceWorker(() => reg);
    useUiStore.getState().bindServiceWorker();
    await vi.waitFor(() => expect(useUiStore.getState().swUpdateReady).toBe(true));
    useUiStore.getState().applyUpdate();
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(useUiStore.getState().swUpdateReady).toBe(false);
  });
});

describe('网络状态', () => {
  it('online / offline 事件更新 online', () => {
    window.dispatchEvent(new Event('offline'));
    expect(useUiStore.getState().online).toBe(false);
    window.dispatchEvent(new Event('online'));
    expect(useUiStore.getState().online).toBe(true);
  });
});

describe('系统深色偏好联动', () => {
  it('prefers-color-scheme 变化更新 systemDark', async () => {
    let changeListener: ((e: { matches: boolean }) => void) | null = null;
    const media = {
      matches: false,
      addEventListener: vi.fn((_t: string, fn: (e: { matches: boolean }) => void) => {
        changeListener = fn;
      }),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => media));
    // 模块级监听在 import 时绑定：重载模块才能挂上我们的假 media
    vi.resetModules();
    const mod = await import('./ui');
    expect(changeListener).not.toBeNull();
    mod.useUiStore.setState({ systemDark: false });
    changeListener!({ matches: true });
    expect(mod.useUiStore.getState().systemDark).toBe(true);
  });
});

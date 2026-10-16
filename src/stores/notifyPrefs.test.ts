import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Prefs = typeof import('./notifyPrefs');

async function load(): Promise<Prefs> {
  return await import('./notifyPrefs');
}

function stubNotification(permission: NotificationPermission | 'absent'): void {
  if (permission === 'absent') {
    vi.stubGlobal('Notification', undefined);
    return;
  }
  vi.stubGlobal('Notification', { permission, requestPermission: vi.fn() });
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  stubNotification('granted');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizePrefs', () => {
  it('空值、非对象一律收敛成默认值', async () => {
    const { normalizePrefs, NOTIFY_DEFAULTS } = await load();
    expect(normalizePrefs(null)).toEqual(NOTIFY_DEFAULTS);
    expect(normalizePrefs(undefined)).toEqual(NOTIFY_DEFAULTS);
    expect(normalizePrefs('garbage')).toEqual(NOTIFY_DEFAULTS);
    expect(normalizePrefs(42)).toEqual(NOTIFY_DEFAULTS);
  });

  it('只认真正的 true，字符串 "true" 不算开启', async () => {
    const { normalizePrefs } = await load();
    expect(normalizePrefs({ enabled: true }).enabled).toBe(true);
    expect(normalizePrefs({ enabled: 'true' }).enabled).toBe(false);
    expect(normalizePrefs({ showWhileVisible: 1 }).showWhileVisible).toBe(false);
  });

  it('maxLines 被夹在 3–12 且取整', async () => {
    const { normalizePrefs } = await load();
    expect(normalizePrefs({ maxLines: 1 }).maxLines).toBe(3);
    expect(normalizePrefs({ maxLines: 99 }).maxLines).toBe(12);
    expect(normalizePrefs({ maxLines: 7.6 }).maxLines).toBe(8);
    expect(normalizePrefs({ maxLines: Number.NaN }).maxLines).toBe(8);
    expect(normalizePrefs({ maxLines: 'many' }).maxLines).toBe(8);
  });
});

describe('notificationEnv', () => {
  it('没有 Notification 时是 unsupported', async () => {
    stubNotification('absent');
    const { notificationEnv } = await load();
    expect(notificationEnv()).toBe('unsupported');
  });

  it('壳内不下"不支持"的结论 —— 安卓 WebView 没有 Notifications API', async () => {
    // 壳内 Notification 一定不存在；若据此判成 unsupported，
    // 整张通知卡片连开关都不会渲染，用户没有任何入口打开通知。
    stubNotification('absent');
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    const { notificationEnv, useNotifyStore } = await load();

    expect(notificationEnv()).toBe('default');
    expect(useNotifyStore.getState().permission).toBe('default');
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it('有 Notification 时透传浏览器权限', async () => {
    stubNotification('denied');
    const { notificationEnv } = await load();
    expect(notificationEnv()).toBe('denied');
  });
});

describe('useNotifyStore', () => {
  it('初始值来自 localStorage，损坏的内容不会让它抛错', async () => {
    localStorage.setItem('twische.pref.notify', '{ 这不是 JSON');
    const { useNotifyStore, NOTIFY_DEFAULTS } = await load();
    expect(useNotifyStore.getState().enabled).toBe(NOTIFY_DEFAULTS.enabled);

    vi.resetModules();
    localStorage.setItem('twische.pref.notify', JSON.stringify({ enabled: true, maxLines: 5 }));
    const again = await load();
    expect(again.useNotifyStore.getState().enabled).toBe(true);
    expect(again.useNotifyStore.getState().maxLines).toBe(5);
  });

  it('setPrefs 合并且落盘', async () => {
    const { useNotifyStore, notifyPrefs } = await load();
    useNotifyStore.getState().setPrefs({ enabled: true });
    useNotifyStore.getState().setPrefs({ maxLines: 4 });

    expect(notifyPrefs()).toEqual({ enabled: true, showWhileVisible: false, maxLines: 4 });
    expect(JSON.parse(localStorage.getItem('twische.pref.notify')!)).toEqual({
      enabled: true,
      showWhileVisible: false,
      maxLines: 4,
    });
  });

  it('setPrefs 也会夹紧越界值', async () => {
    const { useNotifyStore } = await load();
    useNotifyStore.getState().setPrefs({ maxLines: 999 });
    expect(useNotifyStore.getState().maxLines).toBe(12);
  });

  it('setPermission 更新权限状态', async () => {
    const { useNotifyStore } = await load();
    expect(useNotifyStore.getState().permission).toBe('granted');
    useNotifyStore.getState().setPermission('denied');
    expect(useNotifyStore.getState().permission).toBe('denied');
  });

  it('权限不支持时初始为 unsupported', async () => {
    stubNotification('absent');
    const { useNotifyStore } = await load();
    expect(useNotifyStore.getState().permission).toBe('unsupported');
  });
});

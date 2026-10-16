import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NOTIFY_TAG, type NotifyPlan } from '@/domain/notifyPlan';

type ChannelMod = typeof import('./notifyChannel');

interface Call {
  title: string;
  options?: unknown;
}

function fakeHost() {
  const calls: Call[] = [];
  const closed: string[] = [];
  const host = {
    showNotification: vi.fn(async (title: string, options?: unknown) => {
      calls.push({ title, options });
    }),
    getNotifications: vi.fn(async (filter?: { tag?: string }) => {
      closed.push(filter?.tag ?? '');
      return [{ close: vi.fn() }];
    }),
  };
  return { host, calls, closed };
}

function plan(over: Partial<NotifyPlan> = {}): NotifyPlan {
  return {
    key: NOTIFY_TAG,
    active: true,
    title: '今日还剩 2 项',
    body: '09:00  晨会\n21:00  写周报',
    more: 0,
    count: 2,
    stamp: 1,
    ...over,
  };
}

/** 等待通道内部那条"发射后不管"的异步链收敛。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function stubNotification(permission: NotificationPermission | 'absent', requestResult?: NotificationPermission): void {
  if (permission === 'absent') {
    vi.stubGlobal('Notification', undefined);
    return;
  }
  vi.stubGlobal('Notification', {
    permission,
    requestPermission: vi.fn(async () => requestResult ?? permission),
  });
}

async function load(): Promise<ChannelMod> {
  return await import('./notifyChannel');
}

beforeEach(() => {
  // 原生权限缓存是模块级的：resetModules 会给出全新实例，
  // 各用例仍显式调用 resetNativePermissionCache() 把缓存清成初始态。
  vi.resetModules();
  stubNotification('granted');
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe('toNativePlan', () => {
  it('字段扁平，id 固定为 1 以便原生侧更新同一条通知', async () => {
    const { toNativePlan } = await load();
    expect(toNativePlan(plan({ count: 7 }))).toEqual({
      id: 1,
      tag: NOTIFY_TAG,
      title: '今日还剩 2 项',
      body: '09:00  晨会\n21:00  写周报',
      count: 7,
      active: true,
    });
  });
});

describe('toWebOptions', () => {
  it('带上 tag / icon / silent，正文原样', async () => {
    const { toWebOptions } = await load();
    const opts = toWebOptions(plan()) as Record<string, unknown>;
    expect(opts.tag).toBe(NOTIFY_TAG);
    expect(opts.body).toBe('09:00  晨会\n21:00  写周报');
    expect(opts.icon).toBe('./icons/icon-192.png');
    expect(opts.silent).toBe(true);
  });
});

describe('平台检测', () => {
  it('没有 Capacitor 全局时不是原生平台，也没有插件', async () => {
    const { detectNativePlatform, nativePlugin, currentChannel } = await load();
    expect(detectNativePlatform()).toBe(false);
    expect(nativePlugin()).toBeNull();
    expect(currentChannel().name).toBe('service-worker');
  });

  it('isNativePlatform 缺失时按非原生处理', async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {};
    const { detectNativePlatform, currentChannel } = await load();
    expect(detectNativePlatform()).toBe(false);
    expect(currentChannel().name).toBe('service-worker');
  });

  it('壳里但插件尚未注入时回退到 Web 通道', async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    const { detectNativePlatform, currentChannel } = await load();
    expect(detectNativePlatform()).toBe(true);
    expect(currentChannel().name).toBe('service-worker');
  });
});

describe('Web 通道', () => {
  it('把计划交给 Service Worker 显示', async () => {
    const { host, calls } = fakeHost();
    const mod = await load();
    mod.setNotificationHost(host as never);

    mod.currentChannel().deliver(plan());
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe('今日还剩 2 项');
  });

  it('计划 inactive 时什么都不做', async () => {
    const { host, calls } = fakeHost();
    const mod = await load();
    mod.setNotificationHost(host as never);

    mod.currentChannel().deliver(plan({ active: false }));
    await settle();

    expect(calls).toHaveLength(0);
  });

  it('没有宿主时静默跳过，不抛错', async () => {
    const mod = await load();
    mod.setNotificationHost(null);
    expect(() => mod.currentChannel().deliver(plan())).not.toThrow();
    await settle();
  });

  it('showNotification 失败只记日志', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await load();
    mod.setNotificationHost({
      showNotification: async () => {
        throw new Error('boom');
      },
    });

    mod.currentChannel().deliver(plan());
    await settle();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('先 clear 后 deliver 时，通知不会被迟到的 close 关掉', async () => {
    const events: string[] = [];
    const mod = await load();
    mod.setNotificationHost({
      showNotification: async (title) => {
        // 显示本身也是异步的：让"迟到的 close"有机会插进来
        await Promise.resolve();
        events.push(`show:${title}`);
      },
      getNotifications: async () => {
        events.push('get');
        return [
          {
            close: () => {
              events.push('close');
            },
          },
        ];
      },
    });

    // 同一个同步块里先撤销、后投递（运行时完全可能这样调用）
    mod.currentChannel().clear();
    mod.currentChannel().deliver(plan({ title: '刚发的' }));

    await vi.waitFor(() => {
      expect(events).toContain('show:刚发的');
    });
    // 串行化的意义就在这里：close 必须落在 show 之前，不能把它关掉
    expect(events).toEqual(['get', 'close', 'show:刚发的']);
  });

  it('clear 按 tag 找到自己那条并关掉', async () => {
    const { host, closed } = fakeHost();
    const mod = await load();
    mod.setNotificationHost(host as never);

    mod.currentChannel().clear();
    await settle();

    expect(closed).toEqual([NOTIFY_TAG]);
  });

  it('宿主没有 getNotifications 时 clear 安全返回', async () => {
    const mod = await load();
    mod.setNotificationHost({ showNotification: async () => {} });
    expect(() => mod.currentChannel().clear()).not.toThrow();
    await settle();
  });
});

describe('Web 通道权限', () => {
  it('透传浏览器权限', async () => {
    stubNotification('denied');
    const mod = await load();
    expect(mod.currentChannel().permission()).toBe('denied');
  });

  it('没有 Notification 时报告 unsupported', async () => {
    stubNotification('absent');
    const mod = await load();
    expect(mod.currentChannel().permission()).toBe('unsupported');
  });

  it('default 时发起申请', async () => {
    stubNotification('default', 'granted');
    const mod = await load();
    expect(await mod.currentChannel().request()).toBe('granted');
  });

  it('已经授予就不重复申请', async () => {
    const requestPermission = vi.fn(async () => 'denied' as NotificationPermission);
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
    const mod = await load();

    expect(await mod.currentChannel().request()).toBe('granted');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('没有 Notification 时申请直接返回 unsupported', async () => {
    stubNotification('absent');
    const mod = await load();
    expect(await mod.currentChannel().request()).toBe('unsupported');
  });
});

describe('Service Worker 注册获取', () => {
  it('navigator 上没有 serviceWorker 时视为没有宿主', async () => {
    const mod = await load();
    mod.setNotificationHost(null);
    // jsdom 的 navigator 默认没有 serviceWorker
    const calls: string[] = [];
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'serviceWorker');
    expect(original).toBeUndefined();

    mod.currentChannel().deliver(plan());
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('有 serviceWorker.ready 时交给它显示，并复用已解析的注册', async () => {
    const { host, calls } = fakeHost();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve(host) },
    });
    const mod = await load();
    mod.setNotificationHost(null);

    // 第一次走注册解析，第二次命中缓存（两条路径都要走到）
    mod.currentChannel().deliver(plan());
    mod.currentChannel().deliver(plan({ title: '第二次' }));
    await vi.waitFor(() => {
      expect(calls.map((c) => c.title)).toEqual(['今日还剩 2 项', '第二次']);
    });
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });
});

describe('serviceWorker.ready 永不 resolve 时', () => {
  /**
   * `ready` 在"当前作用域没有任何注册"时会永远不 resolve（开发模式下 SW 刻意不注册）。
   * 这里断言的是**不会永久挂起**：内部那条链必须在上限内落空返回，
   * 否则每次 deliver/clear 都会积一个永不落地的 Promise。
   */
  it('到点放弃，且不把这次超时缓存下来（下次会重试）', async () => {
    vi.useFakeTimers();
    let readyCalls = 0;
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        get ready() {
          readyCalls += 1;
          return new Promise(() => {}); // 永不 resolve
        },
      },
    });
    const mod = await load();
    mod.setNotificationHost(null);

    // 第一次：等到超时
    mod.currentChannel().deliver(plan());
    await vi.advanceTimersByTimeAsync(mod.REGISTRATION_TIMEOUT_MS + 50);
    expect(readyCalls).toBe(1);

    // 关键：超时结果**没有**被缓存，所以下一次还会再试（这里会挂到新的 ready 上）
    mod.currentChannel().deliver(plan());
    await vi.advanceTimersByTimeAsync(10);
    expect(readyCalls).toBe(2);

    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    vi.useRealTimers();
  });

  it('ready 先赢时把超时定时器收掉，不留待触发的宏任务', async () => {
    const { host, calls } = fakeHost();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve(host) },
    });
    const mod = await load();
    mod.setNotificationHost(null);

    mod.currentChannel().deliver(plan());
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });
});

describe('非安全上下文', () => {
  it('读 navigator.serviceWorker 抛 SecurityError 时安全跳过', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      get() {
        throw new Error('SecurityError: 非安全上下文');
      },
    });
    const mod = await load();
    mod.setNotificationHost(null);

    expect(() => {
      mod.currentChannel().deliver(plan());
      mod.currentChannel().clear();
    }).not.toThrow();
    // 让内部那条异步链跑完，确认没有未处理的拒绝
    await settle();
    const reg = await mod.currentChannel().permission();
    expect(typeof reg).toBe('string');

    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });
});

describe('没有 navigator 的极端环境', () => {
  it('navigator 整体缺失时视为没有宿主', async () => {
    const mod = await load();
    mod.setNotificationHost(null);
    vi.stubGlobal('navigator', undefined);

    mod.currentChannel().deliver(plan());
    await settle();
    // 走到这里没有抛错即达标：registration() 在缺 navigator 时返回 null
    expect(true).toBe(true);
  });
});

describe('原生通道', () => {
  function stubPlugin(over: Record<string, unknown> = {}) {
    const plugin = {
      setNotification: vi.fn(),
      clear: vi.fn(),
      getPermission: vi.fn(async () => ({ permission: 'granted' })),
      requestPermission: vi.fn(async () => ({ permission: 'granted' })),
      ...over,
    };
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { TwischeNotify: plugin },
    };
    return plugin;
  }

  it('壳内且插件就绪时走原生通道', async () => {
    stubPlugin();
    const mod = await load();
    expect(mod.currentChannel().name).toBe('native');
  });

  it('deliver 把扁平负载交给插件', async () => {
    const plugin = stubPlugin();
    const mod = await load();
    mod.currentChannel().deliver(plan({ count: 3 }));

    expect(plugin.setNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, tag: NOTIFY_TAG, count: 3, active: true }),
    );
  });

  it('clear 调插件的 clear', async () => {
    const plugin = stubPlugin();
    const mod = await load();
    mod.currentChannel().clear();
    expect(plugin.clear).toHaveBeenCalled();
  });

  it('首次读取权限时先返回 default，异步刷新后即为真值', async () => {
    stubPlugin({ getPermission: async () => ({ permission: 'granted' }) });
    const mod = await load();
    mod.resetNativePermissionCache();

    const channel = mod.currentChannel();
    expect(channel.permission()).toBe('default');
    await settle();
    expect(channel.permission()).toBe('granted');
  });

  it('异步刷新拿到权限变化时回调通知调度器', async () => {
    stubPlugin({ getPermission: async () => ({ permission: 'denied' }) });
    const mod = await load();
    mod.resetNativePermissionCache();

    const seen: string[] = [];
    const channel = mod.currentChannel((p) => void seen.push(p));
    expect(channel.permission()).toBe('default');
    await settle();

    expect(seen).toEqual(['denied']);
    expect(channel.permission()).toBe('denied');
  });

  it('异步读到权限后回调一次，让调度器立刻重算（不等下一次脉冲）', async () => {
    // 用一个可控的 deferred：async 函数体会同步执行到第一个 await，
    // 所以必须让这一步悬停，才能在"读回来"的那一刻再决定读到什么。
    let resolvePermission!: (v: { permission: string }) => void;
    const pending = new Promise<{ permission: string }>((r) => {
      resolvePermission = r;
    });
    stubPlugin({ getPermission: () => pending });

    const mod = await load();
    mod.resetNativePermissionCache();

    const seen: string[] = [];
    const channel = mod.currentChannel((p) => void seen.push(p));
    expect(channel.permission()).toBe('default');
    expect(seen).toEqual([]);

    resolvePermission({ permission: 'granted' });
    await settle();

    expect(seen).toEqual(['granted']);
    expect(channel.permission()).toBe('granted');
  });

  it('过桥失败时维持原判断，不把通知关掉', async () => {
    stubPlugin({
      getPermission: async () => {
        throw new Error('bridge down');
      },
    });
    const mod = await load();
    mod.resetNativePermissionCache();

    const channel = mod.currentChannel();
    expect(channel.permission()).toBe('default');
    await settle();
    expect(channel.permission()).toBe('default');
  });

  it('并发读取只过一次桥', async () => {
    const getPermission = vi.fn(async () => ({ permission: 'granted' }));
    stubPlugin({ getPermission });
    const mod = await load();
    mod.resetNativePermissionCache();

    const channel = mod.currentChannel();
    channel.permission();
    channel.permission();
    await settle();
    expect(getPermission).toHaveBeenCalledTimes(1);
  });

  it('权限值不合规时当 default', async () => {
    stubPlugin({ getPermission: async () => ({ permission: 'weird' }) });
    const mod = await load();
    mod.resetNativePermissionCache();
    const channel = mod.currentChannel();
    channel.permission();
    await settle();
    expect(channel.permission()).toBe('default');
  });

  it('权限字段缺失时当 default', async () => {
    stubPlugin({ getPermission: async () => ({}) });
    const mod = await load();
    mod.resetNativePermissionCache();
    const channel = mod.currentChannel();
    channel.permission();
    await settle();
    expect(channel.permission()).toBe('default');
  });

  it('reconcile 会重读原生权限并回调（用户去系统设置授权后必须能捡回来）', async () => {
    let permission = 'denied';
    stubPlugin({ getPermission: async () => ({ permission }) });
    const mod = await load();
    mod.resetNativePermissionCache();

    const seen: string[] = [];
    const channel = mod.currentChannel();
    // 先让缓存落到 denied
    channel.reconcile((p) => void seen.push(p));
    await vi.waitFor(() => {
      expect(seen).toEqual(['denied']);
    });

    // 用户去系统设置里授予了
    permission = 'granted';
    channel.reconcile((p) => void seen.push(p));
    await vi.waitFor(() => {
      expect(seen).toEqual(['denied', 'granted']);
    });
    expect(channel.permission()).toBe('granted');
  });

  it('request 归一化插件返回的对象', async () => {
    stubPlugin({ requestPermission: async () => ({ permission: 'denied' }) });
    const mod = await load();
    mod.resetNativePermissionCache();
    const seen: string[] = [];
    const channel = mod.currentChannel((p) => void seen.push(p));

    expect(await channel.request()).toBe('denied');
    expect(seen).toEqual(['denied']);
    // 结果会被记下来，后续同步读取不再回到 default
    expect(channel.permission()).toBe('denied');
  });

  it('request 也接受裸字符串', async () => {
    stubPlugin({ requestPermission: () => 'granted' });
    const mod = await load();
    mod.resetNativePermissionCache();
    expect(await mod.currentChannel().request()).toBe('granted');
  });

  it('request 返回意外值时当 default', async () => {
    stubPlugin({ requestPermission: () => 'huh' });
    const mod = await load();
    mod.resetNativePermissionCache();
    expect(await mod.currentChannel().request()).toBe('default');
  });

  it('插件 reject 时收掉拒绝，不让它冒到控制台', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubPlugin({
      setNotification: async () => {
        throw new Error('没有通知权限');
      },
      clear: async () => {
        throw new Error('服务没在跑');
      },
    });
    const mod = await load();
    mod.resetNativePermissionCache();

    mod.currentChannel().deliver(plan());
    mod.currentChannel().clear();
    await settle();
    await settle();

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('插件方法返回 void 也不会炸', async () => {
    stubPlugin({
      setNotification: () => undefined,
      clear: () => undefined,
    });
    const mod = await load();
    expect(() => {
      mod.currentChannel().deliver(plan());
      mod.currentChannel().clear();
    }).not.toThrow();
  });
});

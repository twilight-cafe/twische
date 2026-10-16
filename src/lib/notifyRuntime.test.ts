import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NotifyPlan, NotifySource } from '@/domain/notifyPlan';
import type { ChannelPermission, NotifyChannel } from './notifyChannel';

type RuntimeMod = typeof import('./notifyRuntime');

/** 可控时钟。 */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

interface TimerRec {
  fn: () => void;
  ms: number;
  id: number;
  /** 入队顺序。id 是句柄、created 才是先后。 */
  created: number;
}

function fakeTimers() {
  const timers = new Map<number, TimerRec>();
  let seq = 0;
  let created = 0;
  return {
    timers,
    set(fn: () => void, ms: number) {
      const id = ++seq;
      timers.set(id, { fn, ms, id, created: ++created });
      return id;
    },
    clear(h: unknown) {
      timers.delete(h as number);
    },
    /** 当前排着的防抖定时器（每 60 秒的脉冲不算在内）。 */
    debounces(): TimerRec[] {
      return [...timers.values()].filter((t) => t.ms === 800);
    },
    /**
     * 跑**一个**指定间隔的定时器。
     *
     * - 按 ms 精确匹配：防抖（800ms）与脉冲（60s）混在同一个 Map 里，
     *   不按间隔筛就会抓到错的那个。
     * - 每次只跑一个：真实定时器到点即从队列里消失，回调若又排了同间隔的，
     *   那是下一代；一次跑掉全部会把这个区别抹平。
     */
    fireEvery(ms: number) {
      const hit = [...timers.values()].filter((t) => t.ms === ms).sort((a, b) => a.created - b.created)[0];
      if (!hit) return 0;
      timers.delete(hit.id);
      hit.fn();
      return 1;
    },
  };
}

function sourceWith(count: number): NotifySource {
  const at = new Date(2026, 9, 15, 10, 0);
  return {
    overdue: [],
    today: Array.from({ length: count }, (_, i) => ({
      title: `事项 ${i + 1}`,
      startAt: at,
      endAt: at,
      done: false,
    })),
  };
}

function fakeChannel(permission: ChannelPermission = 'granted') {
  const delivered: NotifyPlan[] = [];
  let cleared = 0;
  const channel: NotifyChannel = {
    name: 'service-worker',
    deliver: (p) => void delivered.push(p),
    clear: () => void cleared++,
    permission: () => permission,
    request: vi.fn(async () => permission),
  };
  return {
    channel,
    delivered,
    clears: () => cleared,
    setPermission(p: ChannelPermission) {
      permission = p;
    },
  };
}

interface SetupOptions {
  permission?: ChannelPermission;
  enabled?: boolean;
  showWhileVisible?: boolean;
  visible?: boolean;
  native?: boolean;
  items?: number;
  maxLines?: number;
  onPermission?: (p: ChannelPermission) => void;
}

function setup(opts: SetupOptions = {}) {
  const t = clock();
  const timers = fakeTimers();
  const ch = fakeChannel(opts.permission ?? 'granted');
  const unwatch = vi.fn();
  const watch = vi.fn(() => unwatch);
  let prefs = {
    enabled: opts.enabled ?? true,
    showWhileVisible: opts.showWhileVisible ?? false,
    maxLines: opts.maxLines ?? 8,
  };

  const mod = cached!;
  const deps: Parameters<RuntimeMod['createNotifyRuntime']>[0] = {
    now: t.now,
    collect: () => sourceWith(opts.items ?? 1),
    channel: () => ch.channel,
    prefs: () => prefs,
    visible: () => opts.visible ?? false,
    watch,
    isNative: () => opts.native ?? false,
    setTimer: timers.set,
    clearTimer: timers.clear,
    onPermission: opts.onPermission,
  };

  return {
    runtime: mod.createNotifyRuntime(deps),
    runtimeDeps: () => deps,
    timers,
    clock: t,
    ch,
    watch,
    unwatch,
    setPrefs(next: Partial<typeof prefs>) {
      prefs = { ...prefs, ...next };
    },
  };
}

/** createNotifyRuntime 从当前用例的模块实例里拿。 */
let cached: RuntimeMod | null = null;

beforeEach(async () => {
  vi.resetModules();
  cached = await import('./notifyRuntime');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // 壳内插件的替身必须清掉，否则后面的用例会以为自己跑在原生壳里
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe('createNotifyRuntime', () => {
  it('首次 schedule 立即重算，不等防抖', () => {
    const s = setup({ items: 2 });
    s.runtime.schedule();
    expect(s.ch.delivered).toHaveLength(1);
    expect(s.ch.delivered[0].title).toBe('今日还剩 2 项');
  });

  it('紧接着的第二次变更走防抖，攒到 800ms 才重算', () => {
    const s = setup();
    s.runtime.schedule();
    expect(s.ch.delivered).toHaveLength(1);

    // 时钟没动 → 距离上次不足 200ms，改为排一个防抖定时器
    s.runtime.schedule();
    expect(s.ch.delivered).toHaveLength(1);
    expect(s.timers.debounces()).toHaveLength(1);

    // 观察者已经注册过，真正的写入会再触发一次 schedule
    expect(s.watch).toHaveBeenCalledTimes(1);
  });

  it('防抖期间连续触发只会排一个定时器，并覆盖旧的', () => {
    const s = setup();
    s.runtime.schedule();
    s.clock.advance(10);
    s.runtime.schedule();
    const first = s.timers.debounces()[0];
    s.runtime.schedule();
    const second = s.timers.debounces()[0];

    expect(s.timers.debounces()).toHaveLength(1);
    expect(second.id).not.toBe(first.id);
    expect(second.ms).toBe(800);
  });

  it('防抖定时器到点后按最新数据重算', () => {
    const s = setup({ items: 1 });
    s.runtime.schedule();
    s.clock.advance(10);
    s.runtime.schedule();

    expect(s.timers.fireEvery(800)).toBe(1);
    expect(s.ch.delivered).toHaveLength(2);
  });

  it('相隔足够久时直接重算，不排定时器', () => {
    const s = setup();
    s.runtime.schedule();
    s.clock.advance(5_000);
    s.runtime.schedule();
    expect(s.ch.delivered).toHaveLength(2);
    expect(s.timers.debounces()).toHaveLength(0);
  });

  it('每分钟脉冲持续重算', () => {
    const s = setup();
    expect(s.timers.fireEvery(60_000)).toBe(1);
    expect(s.ch.delivered).toHaveLength(1);
    // 脉冲会重新排下一个，且不会重复排
    expect(s.timers.fireEvery(60_000)).toBe(1);
    expect(s.ch.delivered).toHaveLength(2);
  });

  it('无事可做时撤销通知，即使权限不足', () => {
    const s = setup({ items: 0, permission: 'denied' });
    s.runtime.schedule();
    expect(s.ch.clears()).toBe(1);
    expect(s.ch.delivered).toHaveLength(0);
  });

  it('开关关掉时不投递', () => {
    const s = setup({ enabled: false, items: 3 });
    s.runtime.schedule();
    expect(s.ch.delivered).toHaveLength(0);
  });

  it('reconcile：关掉开关要立刻撤销（不能把常驻通知留在状态栏）', () => {
    const s = setup({ enabled: false, items: 3 });
    s.runtime.reconcile();
    expect(s.ch.clears()).toBe(1);
    expect(s.ch.delivered).toHaveLength(0);
  });

  it('reconcile：打开开关要立刻投递，不等下一次脉冲', () => {
    const s = setup({ enabled: true, items: 2, native: true, visible: true });
    s.runtime.reconcile();
    expect(s.ch.delivered.map((p) => p.title)).toEqual(['今日还剩 2 项']);
  });

  it('reconcile：关掉时也要取消防抖中的重算', () => {
    const s = setup({ enabled: true });
    s.runtime.schedule();
    s.clock.advance(10);
    s.runtime.schedule();
    expect(s.timers.debounces()).toHaveLength(1);

    s.setPrefs({ enabled: false });
    s.runtime.reconcile();
    expect(s.timers.debounces()).toHaveLength(0);
  });

  it('deliver 抛错不会打断分钟脉冲', () => {
    // 用一张干净的定时器表：setup() 里已经建了一个运行时，
    // 共用同一张表会让"哪个定时器属于谁"变得含糊。
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let seq = 0;
    const ch = fakeChannel();
    const deps = {
      ...setup().runtimeDeps(),
      collect: () => {
        throw new Error('数据坏了');
      },
      channel: () => ch.channel,
      setTimer: (fn: () => void, ms: number) => {
        const id = ++seq;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: (h: unknown) => void timers.delete(h as number),
    };
    cached!.createNotifyRuntime(deps);

    const pulse = () => [...timers.values()].find((t) => t.ms === 60_000)!;
    expect(pulse()).toBeTruthy();

    // 脉冲抛错会冒给宿主（真实环境里是未捕获异常），但下一次必须已经排上 ——
    // 否则这一会话的分钟级重算就永久停了。
    expect(pulse().fn).toThrow('数据坏了');
    expect(pulse()).toBeTruthy();
  });

  it('订阅回调抛错不会冒进仓库写路径', () => {
    const s = setup({ items: 1 });
    let boom = true;
    const collect = () => {
      if (boom) throw new Error('数据坏了');
      return sourceWith(1);
    };
    let watched: (() => void) | null = null;
    const deps = {
      ...s.runtimeDeps(),
      collect,
      watch: (fn: () => void) => {
        watched = fn;
        return () => {};
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cached!.createNotifyRuntime(deps);

    // 通知算不出来，绝不该让 upsertRecord 的调用方拿到异常
    expect(() => watched!()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('权限不支持时不发', () => {
    const s = setup({ permission: 'unsupported' });
    s.runtime.schedule();
    expect(s.ch.delivered).toHaveLength(0);
  });

  it('权限未决定时不发', () => {
    const s = setup({ permission: 'default' });
    s.runtime.schedule();
    expect(s.ch.delivered).toHaveLength(0);
  });

  it('浏览器里页面可见时默认不发', () => {
    const s = setup({ visible: true });
    s.runtime.schedule();
    expect(s.ch.delivered).toHaveLength(0);
  });

  it('浏览器里勾了"可见时也发"就发', () => {
    const s = setup({ visible: true, showWhileVisible: true });
    s.runtime.schedule();
    expect(s.ch.delivered).toHaveLength(1);
  });

  it('浏览器里页面不可见时发', () => {
    const s = setup({ visible: false });
    s.runtime.schedule();
    expect(s.ch.delivered).toHaveLength(1);
  });

  it('壳内即使页面可见也发 —— 常驻通知必须一直在', () => {
    const s = setup({ native: true, visible: true });
    s.runtime.schedule();
    expect(s.ch.delivered).toHaveLength(1);
  });

  it('行数上限被传给计划计算', () => {
    const s = setup({ items: 3, maxLines: 3 });
    s.runtime.schedule();
    expect(s.ch.delivered[0].body.split('\n')).toHaveLength(3);
  });

  it('clear 会退订、停掉脉冲并撤掉通知', () => {
    const s = setup();
    s.runtime.clear();
    expect(s.unwatch).toHaveBeenCalledTimes(1);
    expect(s.ch.clears()).toBe(1);
    // 脉冲已经被取消（此时已经跑过一次，重新排了一个；clear 把它清掉了）
    expect(s.timers.fireEvery(60_000)).toBe(0);
  });

  it('clear 时没有待触发的防抖也安全', () => {
    const s = setup();
    expect(() => s.runtime.clear()).not.toThrow();
  });

  it('clear 会取消还没触发的防抖重算', () => {
    const s = setup();
    s.runtime.schedule();
    s.clock.advance(10);
    s.runtime.schedule();
    expect(s.timers.debounces()).toHaveLength(1);

    s.runtime.clear();
    expect(s.timers.fireEvery(800)).toBe(0);
  });

  it('requestPermission 转发给通道并回报结果', async () => {
    const seen: ChannelPermission[] = [];
    const s = setup({ permission: 'default', onPermission: (p) => void seen.push(p) });
    expect(await s.runtime.requestPermission()).toBe('default');
    expect(seen).toEqual(['default']);
  });

  it('没有 onPermission 回调时也不炸', async () => {
    const s = setup({ permission: 'granted' });
    expect(await s.runtime.requestPermission()).toBe('granted');
  });
});

describe('defaultDeps', () => {
  it('未注入时收集到的是空数据源（不会误报）', async () => {
    const mod = await import('./notifyRuntime');
    expect(mod.defaultDeps.collect()).toEqual({ overdue: [], today: [] });
  });

  it('now 返回真实时钟', async () => {
    const mod = await import('./notifyRuntime');
    expect(Math.abs(mod.defaultDeps.now() - Date.now())).toBeLessThan(1000);
  });

  it('visible 跟随 document.visibilityState', async () => {
    const mod = await import('./notifyRuntime');
    expect(mod.defaultDeps.visible()).toBe(document.visibilityState === 'visible');
  });

  it('channel 返回当前通道', async () => {
    const mod = await import('./notifyRuntime');
    expect(['service-worker', 'native']).toContain(mod.defaultDeps.channel().name);
  });

  it('壳内权限变化会写回通知偏好，并转给调用方', async () => {
    const mod = await import('./notifyRuntime');
    const store = await import('@/stores/notifyPrefs');
    const channelMod = await import('./notifyChannel');
    channelMod.resetNativePermissionCache();
    store.useNotifyStore.getState().setPermission('granted');

    // 装一个壳内插件：权限读出来是 denied
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        TwischeNotify: {
          setNotification: () => undefined,
          clear: () => undefined,
          getPermission: async () => ({ permission: 'denied' }),
          requestPermission: async () => ({ permission: 'denied' }),
        },
      },
    };

    const seen: string[] = [];
    const ch = mod.defaultDeps.channel((p) => void seen.push(p));
    expect(ch.name).toBe('native');

    // 原生权限是异步读到的，同步读取先给缓存值
    expect(ch.permission()).toBe('default');
    await new Promise((r) => setTimeout(r, 0));

    expect(store.useNotifyStore.getState().permission).toBe('denied');
    expect(seen).toEqual(['denied']);
  });

  it('prefs 反映通知偏好', async () => {
    const mod = await import('./notifyRuntime');
    expect(mod.defaultDeps.prefs().maxLines).toBeGreaterThan(0);
  });

  it('isNative 默认按平台判断', async () => {
    const mod = await import('./notifyRuntime');
    expect(mod.defaultDeps.isNative()).toBe(false);
  });

  it('watch 能订阅仓库并取消订阅', async () => {
    const mod = await import('./notifyRuntime');
    const off = mod.defaultDeps.watch(() => {});
    expect(typeof off).toBe('function');
    off();
  });

  it('setTimer / clearTimer 走真实定时器', async () => {
    vi.useFakeTimers();
    const mod = await import('./notifyRuntime');
    const fn = vi.fn();
    const h = mod.defaultDeps.setTimer(fn, 100);
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);
    mod.defaultDeps.clearTimer(h);
  });
});

describe('运行时单例与事件绑定', () => {
  it('start 会立刻投递一次，stop 会撤掉通知', async () => {
    const mod = await import('./notifyRuntime');
    const s = setup();
    mod.configureNotify({ ...s.runtimeDeps() });

    mod.startNotifyRuntime();
    mod.startNotifyRuntime(); // 重复调用应当是幂等的
    expect(s.ch.delivered).toHaveLength(1);

    mod.stopNotifyRuntime();
    expect(s.ch.clears()).toBe(1);
    expect(mod.notifyRuntime()).toBeNull();
  });

  it('configureNotifyWith 只替换指定依赖', async () => {
    const mod = await import('./notifyRuntime');
    const collect = () => sourceWith(4);
    mod.configureNotifyWith({ collect });

    const plan = mod.planFor({ ...mod.defaultDeps, collect, prefs: () => ({
      enabled: true,
      showWhileVisible: false,
      maxLines: 8,
    }) });
    expect(plan.count).toBe(4);
  });

  it('页面重新可见时重算', async () => {
    const mod = await import('./notifyRuntime');
    const s = setup();
    mod.configureNotify(s.runtimeDeps());
    mod.startNotifyRuntime();

    // 覆盖"可见"这一支，确保可见性回调真的走到了 schedule
    const visibleSpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const before = s.ch.delivered.length;
    s.clock.advance(5_000);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(s.ch.delivered.length).toBeGreaterThan(before);
    visibleSpy.mockRestore();

    mod.stopNotifyRuntime();
  });

  it('页面变得不可见时不重算', async () => {
    const mod = await import('./notifyRuntime');
    const s = setup();
    mod.configureNotify(s.runtimeDeps());
    mod.startNotifyRuntime();

    const hiddenSpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const before = s.ch.delivered.length;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(s.ch.delivered).toHaveLength(before);
    hiddenSpy.mockRestore();

    mod.stopNotifyRuntime();
  });

  it('pageshow 时重算', async () => {
    const mod = await import('./notifyRuntime');
    const s = setup();
    mod.configureNotify(s.runtimeDeps());
    mod.startNotifyRuntime();

    const before = s.ch.delivered.length;
    s.clock.advance(5_000);
    window.dispatchEvent(new Event('pageshow'));
    expect(s.ch.delivered.length).toBeGreaterThan(before);

    mod.stopNotifyRuntime();
  });

  it('stop 之后事件监听器被摘掉', async () => {
    const mod = await import('./notifyRuntime');
    const s = setup();
    mod.configureNotify(s.runtimeDeps());
    mod.startNotifyRuntime();
    mod.stopNotifyRuntime();

    const after = s.ch.delivered.length;
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(s.ch.delivered).toHaveLength(after);
  });

  it('planFor 用注入的依赖算内容', async () => {
    const mod = await import('./notifyRuntime');
    const s = setup({ items: 2 });
    const deps = s.runtimeDeps();
    expect(mod.planFor(deps).count).toBe(2);
  });
});

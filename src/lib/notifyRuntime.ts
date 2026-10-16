/**
 * 通知调度。
 *
 * 决定"什么时候重算、要不要真的发出去"。三个触发源：
 * - 本地仓库变更（勾选、编辑、同步拉取）→ 防抖后重算
 * - 每分钟对齐一次时钟 → 让"进行中/还没到"随时间推移自己变化
 * - 页面重新可见 / 从返回缓存恢复 → 立刻重算
 *
 * 依赖全部可注入，因此这个文件在单测里是确定性的：没有真实订阅、没有真实定时器、
 * 也没有真实通知。
 */
import { subscribe } from '@/repo/localrepo';
import { buildNotificationPlan, type NotifyCollector, type NotifyPlan } from '@/domain/notifyPlan';
import { currentChannel, detectNativePlatform, type NotifyChannel, type ChannelPermission } from './notifyChannel';
import { notifyPrefs, useNotifyStore } from '@/stores/notifyPrefs';

/** 连续编辑（每敲一个字都写库）不该每字一条通知，攒一小段再算。 */
export const NOTIFY_DEBOUNCE_MS = 800;
/** 时钟对齐间隔。时刻线 60 秒走一格，通知里的"进行中"跟着它变就够。 */
export const NOTIFY_TICK_MS = 60_000;
/** 防抖下限：立即重算时至少等这么久，避免一屏操作打出几十次计算。 */
const MIN_GAP_MS = 200;

export interface NotifyDeps {
  now: () => number;
  collect: NotifyCollector;
  /** 取当前通道。可选回调用于把原生侧异步读到的权限变化回报给界面。 */
  channel: (onPermissionChange?: (p: ChannelPermission) => void) => NotifyChannel;
  prefs: () => { enabled: boolean; showWhileVisible: boolean; maxLines: number };
  visible: () => boolean;
  /** 订阅本地仓库，返回取消订阅函数。 */
  watch: (fn: () => void) => () => void;
  isNative: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  /** 权限变化时回调，供 UI 更新提示。 */
  onPermission?: (p: ChannelPermission) => void;
}

export interface NotifyRuntime {
  /** 重算并投递（若条件满足）。 */
  deliver(): void;
  /** 安排一次重算（防抖）。 */
  schedule(): void;
  /** 撤回通知。 */
  clear(): void;
  /** 用户点击开关后的立即生效路径；返回最终权限。 */
  requestPermission(): Promise<ChannelPermission>;
  /** 开关刚被改动后调用：开 → 立刻投递，关 → 立刻撤销。 */
  reconcile(): void;
}

function defaultVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

export const defaultDeps: NotifyDeps = {
  now: () => Date.now(),
  collect: () => ({ overdue: [], today: [] }),
  // 原生侧权限是异步读到的；变化时把设置页的状态一起刷新，
  // 否则用户刚在系统里允许了通知，回到应用看到的还是"已拒绝"。
  channel: (onPermissionChange) => {
    const ch = currentChannel((p) => {
      useNotifyStore.getState().setPermission(p);
      onPermissionChange?.(p);
    });
    // 预热：壳内权限是异步读的，启动时先对一次表，
    // 免得"首次投递因为权限还没读回来而被跳过"。
    ch.reconcile?.();
    return ch;
  },
  prefs: notifyPrefs,
  visible: defaultVisible,
  watch: subscribe,
  isNative: detectNativePlatform,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * 是否应该产生通知。
 *
 * 壳内不看可见性：常驻通知本来就该一直挂在状态栏，
 * 否则用户切回 App 它就消失，反而像是被关掉了。
 */
function shouldDeliver(deps: NotifyDeps, enabled: boolean, permission: ChannelPermission): boolean {
  if (!enabled) return false;
  if (permission === 'unsupported') return false;
  if (permission !== 'granted') return false;
  if (deps.isNative()) return true;
  return !deps.visible() || deps.prefs().showWhileVisible;
}

/** 纯计算：当前该显示什么。导出是为了让测试直接断言内容。 */
export function planFor(deps: NotifyDeps): NotifyPlan {
  return buildNotificationPlan(deps.collect(), deps.now(), deps.prefs().maxLines);
}

export function createNotifyRuntime(deps: NotifyDeps): NotifyRuntime {
  let debounce: unknown = null;
  let tick: unknown = null;
  // 首次调用永远立即执行：不能依赖"时钟已经走过 0"，
  // 测试里的假时钟就是从一开始的。
  let lastStamp = Number.NEGATIVE_INFINITY;

  function clearTimerIfAny(): void {
    if (debounce === null) return;
    deps.clearTimer(debounce);
    debounce = null;
  }

  function clear(): void {
    clearTimerIfAny();
    deps.channel().clear();
  }

  function deliver(): void {
    clearTimerIfAny();
    lastStamp = deps.now();

    const { enabled } = deps.prefs();
    // 壳内权限是异步读到的：读回来的那一刻要立刻重算一次，
    // 否则用户刚打开开关，通知要等到下一次分钟脉冲（最多 60 秒后）才出现。
    const channel = deps.channel(deliver);
    const plan = planFor(deps);

    // 权限不足也要处理"无事可做"：否则用户勾完最后一项，
    // 旧的常驻通知会一直留在状态栏里说"还剩 1 项"。
    if (!plan.active) {
      channel.clear();
      return;
    }
    if (!shouldDeliver(deps, enabled, channel.permission())) return;
    channel.deliver(plan);
  }

  function schedule(): void {
    const gap = deps.now() - lastStamp;
    if (gap >= MIN_GAP_MS) {
      deliver();
      return;
    }
    clearTimerIfAny();
    debounce = deps.setTimer(() => {
      debounce = null;
      deliver();
    }, NOTIFY_DEBOUNCE_MS);
  }

  function startPulse(): void {
    // startPulse 每个实例只调用一次，这里是纯防御。
    // 加 ignore 而不是删掉：将来若有人在别处再调一次，也不该排出第二条脉冲。
    /* v8 ignore next */
    if (tick !== null) return;
    tick = deps.setTimer(function pulse() {
      // deliver 抛错也必须把下一次排上：否则这一会话的分钟级重算就永久停了。
      try {
        deliver();
      } finally {
        tick = deps.setTimer(pulse, NOTIFY_TICK_MS);
      }
    }, NOTIFY_TICK_MS);
  }

  // 订阅回调里抛错会顺着 localrepo 的 bump() 冒进写路径 ——
  // 那会让"状态已改、调用方却拿到异常"。通知出问题绝不该影响数据写入。
  const unwatch = deps.watch(() => {
    try {
      schedule();
    } catch (err) {
      console.warn('[twische] 通知重算失败', err);
    }
  });
  startPulse();

  return {
    deliver,
    schedule,
    clear() {
      unwatch();
      if (tick !== null) deps.clearTimer(tick);
      tick = null;
      clear();
    },
    async requestPermission() {
      const p = await deps.channel().request();
      deps.onPermission?.(p);
      return p;
    },

    reconcile() {
      // 关掉开关时用户期望立刻看不到那条常驻通知 ——
      // 只写偏好是不够的，`deliver()` 在 enabled=false 时会直接返回。
      if (!deps.prefs().enabled) {
        clearTimerIfAny();
        deps.channel().clear();
        return;
      }
      deliver();
    },
  };
}

// ───────────────────────── 单例与事件绑定 ─────────────────────────

let runtime: NotifyRuntime | null = null;
let bindings: Array<() => void> = [];
/** 当前依赖。测试会替换它，生产环境恒为 defaultDeps。 */
let deps: NotifyDeps = defaultDeps;

/**
 * 测试与启动时注入点。
 *
 * 先拆掉正在跑的运行时（它会撤掉自己发出的通知），再换上新依赖；
 * 依赖本身**不会**在 stop 时被重置 —— 否则应用启动时注入的收集器会在
 * 组件卸载后悄悄失效。
 */
export function configureNotify(next: NotifyDeps): void {
  stopNotifyRuntime();
  deps = next;
}

/** 在默认依赖之上只替换几项，用于应用启动时接上真实数据源。 */
export function configureNotifyWith(patch: Partial<NotifyDeps>): void {
  configureNotify({ ...defaultDeps, ...patch });
}

export function startNotifyRuntime(): void {
  if (runtime) return;
  runtime = createNotifyRuntime(deps);

  if (typeof document !== 'undefined') {
    const onVisible = () => {
      if (document.visibilityState === 'visible') runtime?.schedule();
    };
    document.addEventListener('visibilitychange', onVisible);
    bindings.push(() => document.removeEventListener('visibilitychange', onVisible));
  }
  if (typeof window !== 'undefined') {
    // 从返回缓存恢复时，页面在后台期间的定时器可能整段没跑，必须补算一次。
    const onShow = () => runtime?.schedule();
    window.addEventListener('pageshow', onShow);
    bindings.push(() => window.removeEventListener('pageshow', onShow));
  }

  runtime.deliver();
}

export function stopNotifyRuntime(): void {
  for (const off of bindings) off();
  bindings = [];
  runtime?.clear();
  runtime = null;
}

export function notifyRuntime(): NotifyRuntime | null {
  return runtime;
}

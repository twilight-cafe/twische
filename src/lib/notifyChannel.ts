/**
 * 通知投递层。
 *
 * 同一份内容有两个去处，取决于运行环境：
 * - **浏览器**：交给 Service Worker 的 `registration.showNotification()`。
 *   页面里的 `new Notification()` 在 Android Chrome 上会直接抛错，必须走 SW。
 * - **安卓壳**：交给原生插件，由前台服务显示成状态栏常驻通知。
 *   壳里 Service Worker 依然存在，但它发的通知是可划掉的，撑不住"常驻"。
 *
 * 这一层只负责"送到"，不决定"送什么"（见 domain/notifyPlan）和"什么时候送"
 * （见 lib/notifyRuntime）。
 */
import { NOTIFY_TAG, type NotifyPlan } from '@/domain/notifyPlan';

/** 原生插件的消息形状，与 app/ 里的 NotifyPlugin.java 一一对应。 */
export interface NativeNotifyPlan {
  /** 通知 id：原生侧按它更新同一条通知，而不是叠加。 */
  id: number;
  tag: string;
  title: string;
  body: string;
  count: number;
  active: boolean;
}

/** 能显示通知的东西。浏览器里是 ServiceWorkerRegistration，测试里是替身。 */
export interface NotificationHost {
  showNotification(title: string, options?: unknown): Promise<void>;
  getNotifications?(filter?: { tag?: string }): Promise<Array<{ close(): void }>>;
}

export type ChannelPermission = NotificationPermission | 'unsupported';

export interface NotifyChannel {
  /** 平台名，用于日志与测试断言。 */
  readonly name: 'service-worker' | 'native';
  deliver(plan: NotifyPlan): void;
  clear(): void;
  /** 当前权限；不发起申请。 */
  permission(): ChannelPermission;
  /** 申请权限，返回结果。 */
  request(): Promise<ChannelPermission>;
  /**
   * 主动核对一次权限（用于启动时预热、以及从系统设置切回来时重新对表）。
   * 回调在核对完成后触发；浏览器侧权限是同步读的，所以是空实现。
   */
  reconcile?(onPermissionChange?: (p: ChannelPermission) => void): void;
}

export const NOTIFY_PLUGIN_NAME = 'TwischeNotify';

// ───────────────────────── 原生壳检测 ─────────────────────────

/** Capacitor 的运行时全局。用最小接口声明，避免为了两个方法引入整个 @capacitor/core。 */
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
}

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** 是否跑在原生壳里。 */
export function detectNativePlatform(): boolean {
  return capacitor()?.isNativePlatform?.() === true;
}

/** 已注册的原生插件；不在壳里或插件没加载时为 null。 */
export function nativePlugin(): NativeNotifyPlugin | null {
  const p = capacitor()?.Plugins?.[NOTIFY_PLUGIN_NAME];
  return p ? (p as NativeNotifyPlugin) : null;
}

export interface NativeNotifyPlugin {
  setNotification(plan: NativeNotifyPlan): Promise<void> | void;
  clear(): Promise<void> | void;
  /** 原生侧当前的权限。异步是因为它要过一次桥。 */
  getPermission(): Promise<{ permission?: string }> | { permission?: string };
  requestPermission(): Promise<{ permission?: string } | string> | { permission?: string } | string;
}

// ───────────────────────── 计划 → 负载 ─────────────────────────

/** 计划 → 原生负载。字段扁平，Java 侧不需要嵌套解析。 */
export function toNativePlan(plan: NotifyPlan): NativeNotifyPlan {
  return {
    id: 1,
    tag: plan.key,
    title: plan.title,
    body: plan.body,
    count: plan.count,
    active: plan.active,
  };
}

/** 计划 → `showNotification` 的选项。 */
export function toWebOptions(plan: NotifyPlan): Record<string, unknown> {
  return {
    tag: plan.key,
    body: plan.body,
    data: { plan },
    icon: './icons/icon-192.png',
    badge: './icons/favicon-32.png',
    // 内容会随勾选不断更新，每更新一次都响一声是骚扰；靠状态栏的持续存在提醒。
    silent: true,
  };
}

// ───────────────────────── 浏览器通道 ─────────────────────────

let cachedRegistration: Promise<NotificationHost | null> | null = null;

/** 只给测试用：清掉原生权限缓存，让每个用例从干净状态开始。 */
export function resetNativePermissionCache(): void {
  nativePermission = 'default';
  nativePermissionKnown = false;
  nativeRefresh = null;
}

/** `serviceWorker.ready` 的等待上限。见下方 registration() 的说明。 */
export const REGISTRATION_TIMEOUT_MS = 3_000;

/** 区分"超时"与"确实没有注册"，两者的缓存策略不同。 */
const REGISTRATION_TIMEOUT = Symbol('registration-timeout');

function registration(): Promise<NotificationHost | null> {
  if (cachedRegistration) return cachedRegistration;
  cachedRegistration = (async () => {
    // 在**非安全上下文**（http:// 的普通域名）里读 navigator.serviceWorker 会直接抛
    // SecurityError，而 SecureContext 检查在 `in` 运算符上是不生效的。
    // 这里必须整个包起来：放它冒出去会让 clear() 产生未处理的 Promise 拒绝，
    // 而 clear() 在组件卸载、任务清空时都会走。
    try {
      /* v8 ignore next */
      if (typeof navigator === 'undefined' || !navigator.serviceWorker) return null;

      // `ready` 在"当前作用域没有任何注册"时会**永远不 resolve**（开发模式下
      // Service Worker 刻意不注册，就是这个情形）。不加上限，每次 deliver/clear
      // 都会挂起一个永不落地的 Promise。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof REGISTRATION_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(REGISTRATION_TIMEOUT), REGISTRATION_TIMEOUT_MS);
      });

      let winner: ServiceWorkerRegistration | typeof REGISTRATION_TIMEOUT;
      try {
        winner = await Promise.race([navigator.serviceWorker.ready, timeout]);
      } finally {
        // ready 先赢时把定时器收掉，别让它白占一个待触发的宏任务
        if (timer !== undefined) clearTimeout(timer);
      }

      if (winner === REGISTRATION_TIMEOUT) {
        // **超时结果绝不能缓存**：首次访问时 SW 要下载 + 预缓存 + 激活，
        // 超过 3 秒很常见；一旦把"超时"当成"没有"缓存下来，
        // 这个标签页会话里所有通知都会失效，直到刷新页面。让它下次重试。
        cachedRegistration = null;
        return null;
      }
      return winner as unknown as NotificationHost;
    } catch {
      return null;
    }
  })();
  return cachedRegistration;
}

let overrideHost: NotificationHost | null = null;

/** 测试注入点：jsdom 没有 ServiceWorkerRegistration。 */
export function setNotificationHost(host: NotificationHost | null): void {
  overrideHost = host;
  cachedRegistration = null;
}

async function browserHost(): Promise<NotificationHost | null> {
  if (overrideHost) return overrideHost;
  return await registration();
}

function browserPermission(): ChannelPermission {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/**
 * 把显示与撤销排成一条串行链。
 *
 * 两者操作的是**同一个 tag 的同一条通知**，而它们各自是"发射后不管"的异步链；
 * 不排队的话，"先撤销、后显示"这种调用顺序完全可能以"先显示、后关闭"落地，
 * 结果就是刚发出去的通知被一个迟到的 close 关掉，状态栏空着直到下一次脉冲。
 * 这条路径在开发模式的 StrictMode（effect 双跑）下必现。
 */
let webQueue: Promise<unknown> | null = null;

function enqueueWeb(work: () => Promise<void>): void {
  const task = (webQueue ?? Promise.resolve()).catch(() => {}).then(work);
  const settled = task.catch(() => {});
  webQueue = settled;
  // 排空后归还 null，避免长会话里链无限增长。
  // 若期间又排了新任务，webQueue 会被换成新的那条，这里清掉也无妨 ——
  // 新任务已经接在这条链上了。
  void settled.then(() => {
    webQueue = null;
  });
}

const webChannel: NotifyChannel = {
  name: 'service-worker',

  deliver(plan) {
    if (!plan.active) return;
    enqueueWeb(async () => {
      const host = await browserHost();
      if (!host) return;
      try {
        await host.showNotification(plan.title, toWebOptions(plan));
      } catch (err) {
        console.warn('[twische] 通知发送失败', err);
      }
    });
  },

  clear() {
    enqueueWeb(async () => {
      const host = await browserHost();
      // 没有"删除通知"的 API：只能把自己 tag 的那条找出来关掉。
      const list = await host?.getNotifications?.({ tag: NOTIFY_TAG });
      for (const n of list ?? []) n.close();
    });
  },

  permission: browserPermission,

  async request() {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission !== 'default') return Notification.permission;
    return await Notification.requestPermission();
  },
};

// ───────────────────────── 原生通道 ─────────────────────────

function asPermission(v: unknown): ChannelPermission {
  return v === 'granted' || v === 'denied' || v === 'default' ? v : 'default';
}

/** 插件的返回值既可能是 `{permission}` 也可能是裸字符串，统一取出来。 */
function permissionOf(result: unknown): ChannelPermission {
  if (result && typeof result === 'object' && 'permission' in result) {
    return asPermission((result as { permission: unknown }).permission);
  }
  return asPermission(result);
}

/**
 * 原生权限的本地缓存。
 *
 * 权限存在系统里，过桥读一次是异步的，而 `NotifyChannel.permission()` 必须是同步的
 * （调度器随时要判断"现在能不能发"）。折中：先用上一次的结果，同时异步刷新；
 * 刷新结果变化时通知调度器重算一次。
 */
let nativePermission: ChannelPermission = 'default';
let nativePermissionKnown = false;
let nativeRefresh: Promise<ChannelPermission> | null = null;

function refreshNativePermission(
  plugin: NativeNotifyPlugin,
  onSettled?: (p: ChannelPermission) => void,
): Promise<ChannelPermission> {
  if (nativeRefresh) return nativeRefresh;
  nativeRefresh = (async () => {
    try {
      nativePermission = permissionOf(await plugin.getPermission());
      nativePermissionKnown = true;
    } catch {
      // 过桥失败：维持上一次的判断，**但不置 known**。
      // 置了 known 就等于把这次失败当成结论，桥恢复后也不会再读，
      // 用户本会话里再也等不到通知。
    } finally {
      nativeRefresh = null;
    }
    onSettled?.(nativePermission);
    return nativePermission;
  })();
  return nativeRefresh;
}

function nativeChannel(
  plugin: NativeNotifyPlugin,
  onPermissionChange?: (p: ChannelPermission) => void,
): NotifyChannel {
  return {
    name: 'native',

    deliver(plan) {
      // 原生侧在没有通知权限时会 reject。这里必须收掉，否则控制台会出现未处理的拒绝。
      Promise.resolve(plugin.setNotification(toNativePlan(plan))).catch((err) => {
        console.warn('[twische] 原生通知发送失败', err);
      });
    },

    clear() {
      Promise.resolve(plugin.clear()).catch((err) => {
        console.warn('[twische] 原生通知撤销失败', err);
      });
    },

    permission() {
      // 还没读到过就踢一次异步刷新。
      // 已经读到过的不再重复读 —— 重读挂在 reconcile() 上，
      // 由"启动时"和"从系统设置切回来"这两个时机驱动。
      if (!nativePermissionKnown) void refreshNativePermission(plugin, onPermissionChange);
      return nativePermission;
    },

    async request() {
      const result = await plugin.requestPermission();
      nativePermission = permissionOf(result);
      nativePermissionKnown = true;
      onPermissionChange?.(nativePermission);
      return nativePermission;
    },

    reconcile(onChange) {
      // 强制重读：用户在系统设置里改过权限、或首次进入设置页时都要对一次
      void refreshNativePermission(plugin, (p) => {
        onPermissionChange?.(p);
        onChange?.(p);
      });
    },
  };
}

/**
 * 当前生效的通道。
 *
 * 每次调用都重新判断：壳内插件是异步注入的，模块加载时可能还没就绪。
 */
export function currentChannel(onPermissionChange?: (p: ChannelPermission) => void): NotifyChannel {
  if (detectNativePlatform()) {
    const plugin = nativePlugin();
    if (plugin) return nativeChannel(plugin, onPermissionChange);
  }
  return webChannel;
}

/**
 * 会话与账户状态。
 *
 * 界面有四个互斥的状态，必须严格区分，否则用户会看到错误的指引：
 *   checking      —— 还不知道该显示什么，只显示骨架
 *   need-init     —— 服务端没跑过 `twische init`，前端无能为力，只能给命令行指引
 *   need-login    —— 已初始化但未登录
 *   ready         —— 可用
 *   error         —— 连不上且本地无可用数据
 *
 * 「先给界面，再对答案」：本机登录过的设备启动时不必等网络。
 * 本地仓库（IndexedDB）是唯一数据源，界面完全可以离线渲染；
 * 服务端探测只是「校验 + 补齐」，是后台动作，绝不能挡住首屏。
 * 这一点在弱网下尤其关键 —— 能连上但很慢的服务端会让串行等待变成十几秒白屏。
 */
import { create } from 'zustand';
import { api, ApiError, type AccountInfo, type DeviceInfo, type StatsInfo } from '@/lib/api';
import { initRepo, wipeLocal, setDeviceName, state as repo } from '@/lib/localrepo';
import { stopSync, syncState, bindOnlineListeners, syncNow, subscribeSync } from '@/lib/sync';
import { notify } from './ui';

export type SessionStatus = 'checking' | 'need-init' | 'need-login' | 'ready' | 'error';

/** 本机曾经成功登录过的标记。离线启动时靠它区分"值得进入离线模式"与"真的没数据"。 */
const AUTHED_FLAG = 'twische.authed';

function wasAuthed(): boolean {
  try {
    return localStorage.getItem(AUTHED_FLAG) === '1';
  } catch {
    return false;
  }
}

function markAuthed(): void {
  try {
    localStorage.setItem(AUTHED_FLAG, '1');
  } catch {
    /* 隐私模式下存不进去就算了，离线模式只是退化不是崩溃 */
  }
}

function clearAuthed(): void {
  try {
    localStorage.removeItem(AUTHED_FLAG);
  } catch {
    /* ignore */
  }
}

interface SessionState {
  status: SessionStatus;
  serverVersion: string;
  initializedAt: number | null;
  bootError: string;
  offlineMode: boolean;
  /**
   * 本轮的会话是否已被服务端确认过。
   *
   * false 有两种可能：一是还在后台校验中（`status` 已是 ready，界面照常用），
   * 二是校验失败但本机有已认证过的数据，于是降级为离线继续用。
   * 界面据此显示一个"连接中"的弱提示，而不是把用户挡在启动页外面。
   */
  sessionVerified: boolean;
  devices: DeviceInfo[];
  account: AccountInfo | null;
  stats: StatsInfo | null;
  environment: { app: string; runtime: string; platform: string } | null;
  /** 被锁定或被限流时，服务端要求的等待秒数；登录页据此倒计时 */
  retryAfterSec: number;
  /** 会话提权状态：管理其它设备需要一段由重新输入密码换来的有效期 */
  elevated: boolean;
  elevatedUntil: number;
  passwordPromptOpen: boolean;
  passwordPromptReason: string;
}

interface SessionActions {
  bootstrap(): Promise<void>;
  /** 首次启动的完整探测（无本地可信会话时） */
  probeSession(): Promise<void>;
  /** 后台会话校验（已有本地可信会话时，界面已可用） */
  verifySession(): Promise<void>;
  retrySession(): Promise<boolean>;
  login(password: string): Promise<boolean>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<boolean>;
  refreshDevices(): Promise<void>;
  refreshAccount(): Promise<void>;
  refreshSessionElevation(): Promise<void>;
  renameDevice(id: string, name: string): Promise<void>;
  revokeDevice(id: string): Promise<void>;
  forgetDevice(id: string): Promise<void>;
  requestPassword(reason: string): Promise<string>;
  submitPassword(password: string): void;
  cancelPassword(): void;
  countDirty(): number;
}

export type SessionStore = SessionState & SessionActions;

let passwordWaiters: Array<{
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
}> = [];

export const useSessionStore = create<SessionStore>((set, get) => {
  // ── 提权密码弹窗 ────────────────────────────────────────────
  // 同一时刻只允许一个弹窗：并发的设备操作共用一个 Promise，
  // 否则用户会连点出好几个密码框。
  function settlePasswordQueue(password: string | null): void {
    // 先复位状态再放行等待者：重试会立刻发起请求，此时弹窗必须已经关掉，
    // 否则新请求又被判定为"正在等待密码"而再次排队，形成死锁。
    set({ passwordPromptOpen: false, passwordPromptReason: '' });
    const waiters = passwordWaiters;
    passwordWaiters = [];
    for (const w of waiters) {
      if (password === null) w.reject(new ApiError('elevation_cancelled', '已取消', 0));
      else w.resolve(password);
    }
  }

  /** 退出登录 / 切换账户时清掉提权状态，并拒绝悬空的密码请求。 */
  function resetElevation(): void {
    set({ elevated: false, elevatedUntil: 0 });
    if (passwordWaiters.length > 0) settlePasswordQueue(null);
  }

  /**
   * 把 API 的 password_required 变成"问一次密码再重试"。
   * action 接收密码（首次尝试传 undefined），由调用方决定怎么带上它。
   */
  async function withElevation<T>(
    action: (password?: string) => Promise<T>,
    reason: string,
  ): Promise<T> {
    try {
      return await action();
    } catch (err) {
      if (!(err instanceof ApiError) || !err.needsPassword) throw err;
      const password = await get().requestPassword(reason);
      const result = await action(password);
      // 换取提权成功：服务端已延长有效期，同步一下本地认知
      void get().refreshSessionElevation();
      return result;
    }
  }

  /** 用户在密码框点了取消不是错误，安静收场即可。 */
  function notifyActionError(err: unknown, fallback: string): void {
    if (err instanceof ApiError) {
      if (err.code === 'elevation_cancelled') return;
      if (err.code === 'password_mismatch') {
        notify.error('密码不正确', '该操作已取消');
        return;
      }
      notify.error(fallback, err.message);
      return;
    }
    notify.error(fallback, err instanceof Error ? err.message : undefined);
  }

  function countDirty(): number {
    let n = 0;
    for (const r of repo.records.values()) if (r.dirty) n++;
    return n;
  }

  const store: SessionStore = {
    status: 'checking',
    serverVersion: '',
    initializedAt: null,
    bootError: '',
    offlineMode: false,
    sessionVerified: false,
    devices: [],
    account: null,
    stats: null,
    environment: null,
    retryAfterSec: 0,
    elevated: false,
    elevatedUntil: 0,
    passwordPromptOpen: false,
    passwordPromptReason: '',

    requestPassword(reason: string): Promise<string> {
      if (!get().passwordPromptOpen) {
        set({ passwordPromptOpen: true, passwordPromptReason: reason });
      }
      return new Promise<string>((resolve, reject) => {
        passwordWaiters.push({ resolve, reject });
      });
    },

    submitPassword(password: string): void {
      settlePasswordQueue(password);
    },

    cancelPassword(): void {
      settlePasswordQueue(null);
    },

    /**
     * 启动流程。
     *
     * 关键顺序（决定了弱网下的体感）：**先把本地界面立起来，再去问服务端**。
     * 本机登录过的设备（`wasAuthed()`）不需要等 `api.status()` 往返就能进主界面 ——
     * IndexedDB 里已经有全部数据，服务端只负责"校验身份 + 补齐增量"。
     * 因此这里先 `initRepo()` 并直接置 ready，随后把探测丢进后台；
     * 只有探测结果**否定**本地状态时（未初始化 / 登录失效）才回退界面。
     *
     * 旧实现是串行 `await status → initRepo → await session`，在"能连上但很慢"
     * 的服务端上会白屏到 16s（两个 8s 超时），而断网时 fetch 立刻失败反而秒开 ——
     * 这正是"联网卡、断网不卡"这个反直觉现象的来源。
     */
    async bootstrap() {
      const trusted = wasAuthed();
      set({ status: 'checking', bootError: '', sessionVerified: false });

      // ── 快路径：曾登录过 → 立刻用本地数据进主界面，网络探测转后台 ──
      if (trusted) {
        try {
          await initRepo();
          set({ status: 'ready', sessionVerified: false });
          bindOnlineListeners();

          // 校验与补齐全部在后台跑；期间界面已经可用，用户不必等
          void get().verifySession();
          return;
        } catch {
          // 本地仓库都起不来，退回慢路径，让它去决定是登录页还是错误页
        }
      }

      // ── 慢路径：首次使用或本地仓库不可用，只能等服务端给答案 ──
      await get().probeSession();
    },

    /**
     * 首次启动的完整探测：必须知道"服务端初始化了吗 / 我是谁"才能决定渲染什么。
     * 只在本机没有可信会话时走这条路。
     *
     * 三个动作里，只有"读取本地库"不依赖网络，所以让它与 `api.status()` 并行跑，
     * 首次访问的等待时间就从"两段相加"降为"取较慢的一段"。
     * 本地库必须先就绪才能置 ready —— 界面渲染出来却没有数据源是更糟的体验。
     */
    async probeSession() {
      set({ status: 'checking', bootError: '' });

      // 本地库读取不依赖网络，先并行起来；失败也先记着，等确定了服务端状态再决定怎么办
      const repoPromise = initRepo().then(
        () => null,
        (err: unknown) => err,
      );

      try {
        const health = await api.status();
        set({ serverVersion: health.version, initializedAt: health.initializedAt });

        const repoErr = await repoPromise;

        if (!health.initialized) {
          // 未初始化优先于本地库故障：用户要看到的是"去跑 twische init"这条指引
          set({ status: 'need-init' });
          return;
        }

        // 本地仓库起不来就没有数据源，界面渲染出来也是空的，直接给错误指引
        if (repoErr) throw repoErr;

        try {
          const sess = await api.session();
          set({
            elevated: !!sess.session.elevated,
            elevatedUntil: sess.session.elevatedUntil ?? 0,
            status: 'ready',
            sessionVerified: true,
            offlineMode: false,
          });
          markAuthed();
          bindOnlineListeners();
          void get().refreshDevices();
          void syncNow({ silent: true });
        } catch (err) {
          if (err instanceof ApiError && err.isAuth) {
            set({ status: 'need-login' });
          } else {
            throw err;
          }
        }
      } catch (err) {
        // 网络不通 ≠ 一切失败：本机若有已认证过的数据，就进入离线模式继续用。
        // 第一次使用（本地什么都没有）才真正无路可走，落到错误指引。
        // 注意本地库此时已经就绪（否则上面已经抛出了），无需再 await。
        if (err instanceof ApiError && err.isNetwork && wasAuthed() && !(await repoPromise)) {
          set({ status: 'ready', sessionVerified: false, offlineMode: true });
          bindOnlineListeners();
          // 试一次同步：失败会置 syncState.online=false 并按退避重试，
          // 恢复联网后由 online 侦听自动收尾。
          void syncNow({ silent: true });
          return;
        }
        set({
          bootError: err instanceof Error ? err.message : String(err),
          status: 'error',
        });
      }
    },

    /**
     * 后台会话校验（快路径专用）。
     *
     * 界面此刻已经是 ready 并渲染着本地数据，这个函数只做两件事：
     *   - 确认成功 → 补上版本号、设备列表，并触发一次同步
     *   - 确认失败 → 把界面**降级**到正确的状态（未初始化 / 登录失效 / 离线）
     *
     * 失败一律安静处理，绝不打断用户正在做的事。网络类失败尤其不重要 ——
     * 本地优先架构下它只是"暂时没对齐"，恢复联网后 sync 层会自己收尾。
     */
    async verifySession() {
      const toOffline = (err: unknown): void => {
        // 网络类失败：保持 ready，转为离线模式继续用本地数据。
        // 非网络类失败同样不该把用户踢出界面 —— 本地数据是有效的。
        const offline = err instanceof ApiError && err.isNetwork;
        set({ sessionVerified: false, offlineMode: offline });
        if (offline) {
          bindOnlineListeners();
          void syncNow({ silent: true });
        }
      };

      try {
        const health = await api.status();
        if (!health.initialized) {
          // 服务端被重置过：本地那份数据已经没有归宿，必须说清楚
          set({ serverVersion: health.version, initializedAt: health.initializedAt, status: 'need-init' });
          return;
        }
        set({ serverVersion: health.version, initializedAt: health.initializedAt });

        let sess;
        try {
          sess = await api.session();
        } catch (err) {
          if (err instanceof ApiError && err.isAuth) {
            // 会话确实失效了才回登录页；这时的回退是有意义的，不是误伤
            clearAuthed();
            set({ status: 'need-login', sessionVerified: false });
            resetElevation();
            return;
          }
          toOffline(err);
          return;
        }

        // 探测期间用户可能已经手动登出或登录，别把状态覆盖回去。
        // 这里只落"会话确认"这一件事，设备列表与同步一并收尾即可，
        // 避免同一轮启动把 session/sync/devices 各打两遍。
        if (get().status !== 'ready') return;
        set({
          elevated: !!sess.session.elevated,
          elevatedUntil: sess.session.elevatedUntil ?? 0,
          sessionVerified: true,
          offlineMode: false,
        });
        markAuthed();
        void get().refreshDevices();
        void syncNow({ silent: true });
      } catch (err) {
        toOffline(err);
      }
    },

    /** 只重试会话探测，不重跑整个启动流程（用于"重试"按钮）。 */
    async retrySession() {
      try {
        const health = await api.status();
        if (!health.initialized) {
          set({ status: 'need-init' });
          return false;
        }
        const sess = await api.session();
        set({
          elevated: !!sess.session.elevated,
          elevatedUntil: sess.session.elevatedUntil ?? 0,
        });
        await initRepo();
        set({ status: 'ready', sessionVerified: true, offlineMode: false });
        markAuthed();
        bindOnlineListeners();
        void get().refreshDevices();
        void syncNow({ silent: true });
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.isAuth) {
          set({ status: 'need-login' });
        } else {
          notify.error('仍然无法连接', err instanceof Error ? err.message : undefined);
        }
        return false;
      }
    },

    async login(password: string) {
      set({ retryAfterSec: 0 });
      try {
        await initRepo();
        await api.login(password, repo.deviceId, repo.deviceName);
        set({ status: 'ready', sessionVerified: true, offlineMode: false });
        markAuthed();
        syncState.unauthorized = false;
        bindOnlineListeners();
        void get().refreshSessionElevation();

        // 登录后立刻对齐一次：换设备登录时本地可能是空的
        const ok = await syncNow({ silent: false });
        if (!ok && syncState.lastError) {
          notify.warn('已登录，但首次同步未完成', syncState.lastError);
        }
        void get().refreshDevices();
        return true;
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.code === 'locked' || err.code === 'too_many_requests') {
            const sec = Number(err.extra.retryAfterSec ?? 0);
            set({ retryAfterSec: sec });
            notify.error(err.message, sec > 0 ? `请等待 ${sec} 秒后重试` : undefined);
          } else if (err.code === 'bad_credentials') {
            notify.error('密码不正确');
          } else if (err.code === 'not_initialized') {
            set({ status: 'need-init' });
          } else if (err.isNetwork) {
            notify.error('无法连接到服务器', err.message);
          } else {
            notify.error(err.message);
          }
        } else {
          notify.error('登录失败', err instanceof Error ? err.message : undefined);
        }
        return false;
      }
    },

    async logout() {
      try {
        // 先把本地未推送的改动尽力推上去，避免退出登录丢数据
        if (syncState.online && !syncState.unauthorized) {
          await syncNow({ silent: true });
        }
      } catch {
        /* 推不上去也要允许退出 */
      }

      const pending = countDirty();
      try {
        await api.logout();
      } catch {
        /* 服务端可能已经失效，本地照样清干净 */
      }

      stopSync();
      // 保留未推送的改动，但它们已经不属于任何人；这里清空以免下次登录错乱
      await wipeLocal(false);
      set({
        devices: [],
        account: null,
        stats: null,
        offlineMode: false,
        sessionVerified: false,
        status: 'need-login',
      });
      clearAuthed();
      resetElevation();

      if (pending > 0) {
        notify.warn('已退出登录', `有 ${pending} 条未同步的改动未能上传，已随本地数据一起清除`);
      } else {
        notify.ok('已退出登录');
      }
    },

    async logoutAll() {
      try {
        const res = await api.logoutAll();
        stopSync();
        await wipeLocal(false);
        set({ devices: [], offlineMode: false, sessionVerified: false, status: 'need-login' });
        clearAuthed();
        resetElevation();
        notify.ok('已在所有设备上退出', `共吊销 ${res.revokedSessions} 个会话`);
      } catch (err) {
        notify.error('操作失败', err instanceof Error ? err.message : undefined);
      }
    },

    async changePassword(currentPassword: string, newPassword: string) {
      try {
        const res = await api.changePassword(currentPassword, newPassword);
        notify.ok(
          '密码已更新',
          res.revokedSessions > 0
            ? `其它 ${res.revokedSessions} 个登录会话已被吊销`
            : '当前设备会继续保持登录',
        );
        void get().refreshDevices();
        return true;
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.code === 'weak_password') {
            const problems = (err.extra.problems as string[]) || [];
            notify.error('新密码强度不足', problems.join('；'));
          } else if (err.code === 'password_mismatch') {
            notify.error('当前密码不正确');
          } else {
            notify.error(err.message);
          }
        } else {
          notify.error('修改失败', err instanceof Error ? err.message : undefined);
        }
        return false;
      }
    },

    async refreshDevices() {
      try {
        const res = await api.devices();
        set({ devices: res.devices });
      } catch {
        /* 静默：设备列表不是关键路径 */
      }
    },

    async refreshAccount() {
      try {
        const res = await api.account();
        set({ account: res.account, stats: res.stats, environment: res.environment });
      } catch (err) {
        notify.error('无法读取账户信息', err instanceof Error ? err.message : undefined);
      }
    },

    async refreshSessionElevation() {
      try {
        const res = await api.session();
        set({ elevated: !!res.session.elevated, elevatedUntil: res.session.elevatedUntil ?? 0 });
      } catch {
        /* 静默：提权状态只影响按钮提示 */
      }
    },

    async renameDevice(id: string, name: string) {
      try {
        const res = await withElevation(
          (password) => api.renameDevice(id, name, password),
          '重命名别的设备需要确认密码',
        );
        set({ devices: res.devices });
        if (id === repo.deviceId) setDeviceName(name);
        notify.ok('设备已重命名');
      } catch (err) {
        notifyActionError(err, '重命名失败');
      }
    },

    async revokeDevice(id: string) {
      try {
        const res = await withElevation(
          (password) => api.revokeDevice(id, password),
          '让别的设备退出登录需要确认密码',
        );
        set({ devices: res.devices });
        notify.ok('已让该设备退出登录', `吊销 ${res.revokedSessions} 个会话`);
      } catch (err) {
        notifyActionError(err, '操作失败');
      }
    },

    async forgetDevice(id: string) {
      try {
        const res = await withElevation(
          (password) => api.forgetDevice(id, password),
          '移除设备需要确认密码',
        );
        set({ devices: res.devices });
        notify.ok('设备已移除');
      } catch (err) {
        notifyActionError(err, '操作失败');
      }
    },

    countDirty,
  };

  // 同步层发现登录失效 → 立刻把界面切回登录页，不要让它继续转圈。
  // 离线模式下同步引擎恢复联网 → 回到完全在线状态。
  // （store 创建时绑定一次；handlers 读 getState 拿最新状态。）
  subscribeSync(() => {
    const s = useSessionStore.getState();
    if (syncState.unauthorized && s.status === 'ready') {
      clearAuthed();
      useSessionStore.setState({ status: 'need-login', sessionVerified: false });
      notify.warn('登录状态已失效', '请重新输入密码');
    }
    if (syncState.online && s.offlineMode) {
      useSessionStore.setState({ offlineMode: false });
      void s.refreshDevices();
      notify.ok('已恢复连接', '离线期间的改动正在同步');
    }
  });

  return store;
});

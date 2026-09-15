/**
 * 会话与账户状态。
 *
 * 界面有四个互斥的状态，必须严格区分，否则用户会看到错误的指引：
 *   checking      —— 还不知道该显示什么，只显示骨架
 *   need-init     —— 服务端没跑过 `twische init`，前端无能为力，只能给命令行指引
 *   need-login    —— 已初始化但未登录
 *   ready         —— 可用
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

    /** 启动流程：先问服务端"你初始化了吗"，再问"我是谁"。 */
    async bootstrap() {
      set({ status: 'checking', bootError: '' });

      try {
        const health = await api.status();
        set({ serverVersion: health.version, initializedAt: health.initializedAt });

        if (!health.initialized) {
          set({ status: 'need-init' });
          return;
        }

        // 本地仓库先就绪，后面无论在线与否界面都有数据可渲染
        await initRepo();

        try {
          const sess = await api.session();
          set({
            elevated: !!sess.session.elevated,
            elevatedUntil: sess.session.elevatedUntil ?? 0,
            status: 'ready',
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
        if (err instanceof ApiError && err.isNetwork && wasAuthed()) {
          try {
            await initRepo();
            set({ status: 'ready', offlineMode: true });
            bindOnlineListeners();
            // 试一次同步：失败会置 syncState.online=false 并按退避重试，
            // 恢复联网后由 online 侦听自动收尾。
            void syncNow({ silent: true });
            return;
          } catch {
            /* 本地仓库也起不来，只能走错误指引 */
          }
        }
        set({
          bootError: err instanceof Error ? err.message : String(err),
          status: 'error',
        });
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
        set({ status: 'ready', offlineMode: false });
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
        set({ status: 'ready', offlineMode: false });
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
        set({ devices: [], offlineMode: false, status: 'need-login' });
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
      useSessionStore.setState({ status: 'need-login' });
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

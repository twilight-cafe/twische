/**
 * 连接状态（原「会话与账户状态」）。
 *
 * 无后端架构下没有「登录会话」这回事，只有「有没有一个可用的 WebDAV 连接」。
 * 界面有四个互斥状态，必须严格区分，否则用户会看到错误的指引：
 *   checking    —— 还不知道该显示什么，只显示骨架
 *   need-setup  —— 从未配置过 WebDAV 地址，去连接向导
 *   need-login  —— 配过地址，但密码没记住（或认证失败），补一个密码
 *   ready       —— 可用
 *   error       —— 连不上且本地无可用数据
 *
 * 「先给界面，再对答案」：配置过的设备启动时不必等网络。
 * 本地仓库（IndexedDB）是唯一数据源，界面完全可以离线渲染；
 * 远端探测只是「校验 + 补齐」，是后台动作，绝不能挡住首屏。
 * 这一点在弱网下尤其关键 —— 能连上但很慢的服务器会让串行等待变成十几秒白屏。
 */
import { create } from 'zustand';
import { initRepo, markAllDirty, setDeviceName, state as repo, wipeLocal, dirtyCount } from '@/repo/localrepo';
import { stopSync, syncState, bindOnlineListeners, syncNow, subscribeSync, setBackend } from '@/repo/sync';
import {
  clearPassword,
  clearProfile,
  loadPassword,
  loadProfile,
  savePassword,
  saveProfile,
  type DavProfile,
} from '@/storage/credentials';
import { friendlyError, openDavConnection, type FriendlyError, type ProbeSummary } from '@/storage/connect';
import { isDavError } from '@/storage/webdav/client';
import { notify } from './ui';

export type SessionStatus = 'checking' | 'need-setup' | 'need-login' | 'ready' | 'error';

/** 本机曾经成功连上过的标记。离线启动时靠它区分「值得进入离线模式」与「真的没数据」。 */
const CONNECTED_FLAG = 'twische.connected';

function wasConnected(): boolean {
  try {
    return localStorage.getItem(CONNECTED_FLAG) === '1';
  } catch {
    return false;
  }
}

function markConnected(): void {
  try {
    localStorage.setItem(CONNECTED_FLAG, '1');
  } catch {
    /* 隐私模式下存不进去就算了，离线模式只是退化不是崩溃 */
  }
}

function clearConnected(): void {
  try {
    localStorage.removeItem(CONNECTED_FLAG);
  } catch {
    /* ignore */
  }
}

export interface ConnectInput {
  url: string;
  username: string;
  password: string;
  remember: boolean;
}

interface SessionState {
  status: SessionStatus;
  /** 启动阶段的致命错误（连不上且本地无数据） */
  bootError: string;
  offlineMode: boolean;
  /** 本轮的连接是否已被远端确认过 */
  sessionVerified: boolean;
  /** 当前配置 */
  profile: DavProfile;
  /** 最近一次成功的探测结果 */
  probe: ProbeSummary | null;
  /** 最近一次连接失败的结构化文案 */
  connectError: FriendlyError | null;
  /** 正在连接（向导按钮的 loading 态） */
  connecting: boolean;
}

interface SessionActions {
  bootstrap(): Promise<void>;
  /** 用向导里填的信息建立连接；成功返回 true */
  connect(input: ConnectInput): Promise<boolean>;
  /** 后台校验已有连接 */
  verify(): Promise<void>;
  /** 重试用已保存的配置连接一次 */
  retry(): Promise<boolean>;
  /** 补一个密码后继续（need-login 状态用） */
  submitPassword(password: string): Promise<boolean>;
  /** 断开连接（保留本地数据） */
  disconnect(): Promise<void>;
  /** 断开并清空本机数据 */
  disconnectAndWipe(): Promise<void>;
  renameDevice(name: string): void;
  refreshProbe(): Promise<void>;
  countDirty(): number;
}

/** 连接尝试的结果：失败时把可读原因一并带回来，调用方不必再去猜状态。 */
type ConnectOutcome =
  | { ok: true }
  | { ok: false; kind: 'auth' | 'network' | 'error'; error: FriendlyError };

export type SessionStore = SessionState & SessionActions;

export const useSessionStore = create<SessionStore>((set, get) => {
  /**
   * 用给定配置连一次；成功则接上后端并同步。
   *
   * 失败时返回原因而不是布尔值：调用方对「密码不对」和「网络不通」的处理完全相反
   * （前者回登录页、后者降级为离线继续用），把判定塞在布尔值里必然会丢信息。
   */
  async function tryConnect(profile: DavProfile, password: string): Promise<ConnectOutcome> {
    const previousUrl = get().profile.url;
    set({ connecting: true });
    try {
      const conn = await openDavConnection(profile, password);
      setBackend(conn.store);

      const urlChanged = previousUrl !== '' && previousUrl !== profile.url;
      saveProfile(profile);
      await savePassword(password, profile.remember);
      if (urlChanged) {
        // 换了服务器：新服务器上当然没有这些文件，若照常走「远端没有 = 被删了」
        // 的规则，本地数据会被成批抹掉。标脏之后它们会被推到新服务器。
        const n = await markAllDirty();
        if (n > 0) notify.info('已切换 WebDAV 服务器', `${n} 条本地记录将同步到新服务器`);
      }

      markConnected();
      set({
        status: 'ready',
        sessionVerified: true,
        offlineMode: false,
        probe: conn.probe,
        connectError: null,
        profile,
        connecting: false,
        bootError: '',
      });
      syncState.unauthorized = false;
      bindOnlineListeners();
      void syncNow({ silent: false });
      return { ok: true };
    } catch (err) {
      const error = friendlyError(err);
      set({ connecting: false, connectError: error });

      if (isDavError(err) && err.isAuth) {
        // 认证失败：把记住的密码清掉，避免每次启动都用一个错的密码重试
        await clearPassword();
        set({ status: 'need-login', sessionVerified: false });
        return { ok: false, kind: 'auth', error };
      }
      return { ok: false, kind: isDavError(err) && err.isNetwork ? 'network' : 'error', error };
    }
  }

  /**
   * 网络类失败时降级为离线继续用。
   *
   * 前提是「本机确实有过数据」：本地有记录，或这台设备曾经成功连上过。
   * 两者皆无说明是首次使用，此时安静地进主界面只会让用户面对一个空应用
   * 却不知道发生了什么，不如老实报错。
   */
  function degradeToOffline(): boolean {
    if (repo.records.size === 0 && !wasConnected()) return false;
    set({ status: 'ready', sessionVerified: false, offlineMode: true, bootError: '' });
    bindOnlineListeners();
    void syncNow({ silent: true });
    return true;
  }

  const store: SessionStore = {
    status: 'checking',
    bootError: '',
    offlineMode: false,
    sessionVerified: false,
    profile: loadProfile(),
    probe: null,
    connectError: null,
    connecting: false,

    /**
     * 启动流程。
     *
     * 关键顺序（决定了弱网下的体感）：**先把本地界面立起来，再问远端**。
     * 配置过的设备不需要等一次 PROPFIND 往返就能进主界面 ——
     * IndexedDB 里已经有全部数据，远端只负责「校验 + 补齐」。
     */
    async bootstrap() {
      set({ status: 'checking', bootError: '', connectError: null });

      try {
        await initRepo();
      } catch (err) {
        set({ bootError: err instanceof Error ? err.message : String(err), status: 'error' });
        return;
      }

      const profile = loadProfile();
      set({ profile });
      if (!profile.url) {
        set({ status: 'need-setup' });
        return;
      }

      const password = await loadPassword();
      if (!password) {
        // 地址还在但密码没记住：本地有数据就先让界面可用，用户在设置里补密码即可
        if (repo.records.size > 0) {
          set({ status: 'ready', sessionVerified: false, offlineMode: true });
          bindOnlineListeners();
        } else {
          set({ status: 'need-login' });
        }
        return;
      }

      if (repo.records.size > 0) {
        // 快路径：立刻进主界面，探测丢后台
        set({ status: 'ready', sessionVerified: false });
        bindOnlineListeners();
        void get().verify();
        return;
      }

      // 首次使用或本地为空：必须等一次探测才知道有没有数据
      const result = await tryConnect(profile, password);
      if (result.ok || result.kind === 'auth') return;
      if (result.kind === 'network' && degradeToOffline()) return;
      set({ status: 'error', bootError: result.error.detail });
    },

    async verify() {
      const { profile } = get();
      const password = await loadPassword();
      if (!profile.url || !password) return;

      const result = await tryConnect(profile, password);
      if (result.ok || result.kind === 'auth') return;
      // 网络类失败：界面已经可用，降级为离线而不是把用户挡在外面
      if (result.kind === 'network' && degradeToOffline()) return;
      // 探测期间用户可能已经手动登录/登出，别把状态覆盖回去；
      // 只有在「界面确实处在 ready」时才把它降级为错误
      if (get().status === 'ready') set({ status: 'error', bootError: result.error.detail });
    },

    async connect(input: ConnectInput) {
      const profile: DavProfile = {
        url: input.url.trim(),
        username: input.username.trim(),
        remember: input.remember,
      };
      const result = await tryConnect(profile, input.password);
      if (result.ok) return true;
      notify.error(result.error.title, result.error.hint || result.error.detail);
      return false;
    },

    async retry() {
      const { profile } = get();
      const password = await loadPassword();
      if (!profile.url || !password) {
        set({ status: 'need-setup' });
        return false;
      }
      const result = await tryConnect(profile, password);
      if (!result.ok) {
        notify.error('仍然无法连接', result.error.hint || result.error.detail);
        return false;
      }
      return true;
    },

    async submitPassword(password: string) {
      const { profile } = get();
      const result = await tryConnect({ ...profile, remember: true }, password);
      if (!result.ok) {
        notify.error('连接失败', result.error.hint || result.error.detail);
        return false;
      }
      return true;
    },

    async disconnect() {
      stopSync();
      setBackend(null);
      await clearPassword();
      clearConnected();
      set({ status: 'need-login', sessionVerified: false, offlineMode: false, connectError: null });
      notify.ok('已断开连接', '本地数据仍然保留在本机');
    },

    async disconnectAndWipe() {
      stopSync();
      setBackend(null);
      await clearPassword();
      clearProfile();
      await wipeLocal(false);
      clearConnected();
      set({
        status: 'need-setup',
        sessionVerified: false,
        offlineMode: false,
        probe: null,
        connectError: null,
        profile: { url: '', username: '', remember: true },
      });
      notify.ok('已清除本机数据');
    },

    renameDevice(name: string) {
      setDeviceName(name);
    },

    async refreshProbe() {
      const { profile } = get();
      const password = await loadPassword();
      if (!profile.url || !password) return;
      try {
        const conn = await openDavConnection(profile, password);
        setBackend(conn.store);
        set({ probe: conn.probe });
      } catch (err) {
        notify.error('无法读取远端状态', friendlyError(err).detail);
      }
    },

    countDirty: () => dirtyCount(),
  };

  // 同步层发现凭据失效 → 立刻把界面切回补密码状态，不要让它继续转圈。
  // 离线模式下同步引擎恢复联网 → 回到完全在线状态。
  // （store 创建时绑定一次；handlers 读 getState 拿最新状态。）
  subscribeSync(() => {
    const s = useSessionStore.getState();
    if (syncState.unauthorized && s.status === 'ready') {
      clearConnected();
      void clearPassword();
      useSessionStore.setState({ status: 'need-login', sessionVerified: false });
      notify.warn('凭据已失效', '请重新输入 WebDAV 密码');
    }
    if (syncState.online && s.offlineMode) {
      useSessionStore.setState({ offlineMode: false });
      notify.ok('已恢复连接', '离线期间的改动正在同步');
    }
  });

  return store;
});

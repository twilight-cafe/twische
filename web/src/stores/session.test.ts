/**
 * session store 测试：四个启动状态、登录错误矩阵、提权密码队列、
 * 退出清理与 sync 订阅联动。api/sync/ui 全部 mock，ApiError 保留真实实现
 * （isAuth/isNetwork/needsPassword 的 instanceof 分支必须走真类）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiMock, syncMocks, notifyMock } = vi.hoisted(() => {
  const syncState = {
    online: true,
    unauthorized: false,
    lastError: '' as string,
    lastPushedCount: 0,
    lastPulledCount: 0,
  };
  let syncCb: (() => void) | null = null;
  return {
    apiMock: {
      status: vi.fn(),
      session: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      logoutAll: vi.fn(),
      changePassword: vi.fn(),
      devices: vi.fn(),
      account: vi.fn(),
      renameDevice: vi.fn(),
      revokeDevice: vi.fn(),
      forgetDevice: vi.fn(),
    },
    syncMocks: {
      syncState,
      syncNow: vi.fn(async () => true),
      stopSync: vi.fn(),
      bindOnlineListeners: vi.fn(),
      subscribeSync: vi.fn((cb: () => void) => {
        syncCb = cb;
      }),
      /** 触发模块加载时注册的订阅回调（模拟同步层事件）。 */
      emitSync(): void {
        syncCb?.();
      },
    },
    notifyMock: {
      ok: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
  };
});

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

vi.mock('@/lib/sync', () => syncMocks);

vi.mock('./ui', () => ({ notify: notifyMock }));

vi.mock('@/lib/localrepo', () => {
  const state = {
    records: new Map<string, { dirty: boolean }>(),
    deviceId: 'dev-self',
    deviceName: '测试机',
  };
  return {
    initRepo: vi.fn(async () => undefined),
    wipeLocal: vi.fn(async () => undefined),
    setDeviceName: vi.fn(),
    state,
  };
});

import { useSessionStore, type SessionStatus } from './session';
import { ApiError } from '@/lib/api';
import { initRepo, wipeLocal, setDeviceName, state as repo } from '@/lib/localrepo';
import { syncState, syncNow, stopSync, bindOnlineListeners, emitSync } from '@/lib/sync';

/** 取一个干净的 store 状态（zustand store 是单例，用 setState 复位）。 */
function resetStore(): void {
  useSessionStore.setState({
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
  });
}

const health = (initialized: boolean) => ({
  version: '1.0.0',
  initialized,
  initializedAt: initialized ? 123 : null,
});

const sessionOk = (elevated = false) => ({
  session: { elevated, elevatedUntil: elevated ? 999 : 0 },
});

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  localStorage.clear();
  syncState.online = true;
  syncState.unauthorized = false;
  syncState.lastError = '';
  repo.records.clear();
});

afterEach(() => {
  // Storage spy 会跨用例泄漏，必须逐用例还原
  vi.restoreAllMocks();
});

describe('提权密码队列', () => {
  it('requestPassword 打开弹窗；并发请求复用同一弹窗', () => {
    const s = useSessionStore.getState();
    const p1 = s.requestPassword('操作 A');
    const p2 = s.requestPassword('操作 B');
    const st = useSessionStore.getState();
    expect(st.passwordPromptOpen).toBe(true);
    expect(st.passwordPromptReason).toBe('操作 A'); // 第二次不覆盖第一次的文案
    st.submitPassword('pw');
    st.submitPassword('pw2'); // 队列已清空，重复提交是空操作
    return Promise.all([
      p1.then((v) => expect(v).toBe('pw')),
      // 并发请求共享同一弹窗，一次提交放行所有等待者
      p2.then((v) => expect(v).toBe('pw')),
    ]);
  });

  it('cancelPassword 以 elevation_cancelled 拒绝所有等待者并关弹窗', async () => {
    const s = useSessionStore.getState();
    const p = s.requestPassword('x');
    useSessionStore.getState().cancelPassword();
    await expect(p).rejects.toMatchObject({ code: 'elevation_cancelled' });
    expect(useSessionStore.getState().passwordPromptOpen).toBe(false);
  });

  it('submitPassword 时弹窗已先复位（防死锁约定）', () => {
    const s = useSessionStore.getState();
    s.requestPassword('x');
    useSessionStore.getState().submitPassword('pw');
    expect(useSessionStore.getState().passwordPromptOpen).toBe(false);
  });
});

describe('bootstrap 启动流程', () => {
  it('未初始化 + 无本地会话 → need-init，走慢路径探测', async () => {
    apiMock.status.mockResolvedValue(health(false));
    await useSessionStore.getState().bootstrap();
    const st = useSessionStore.getState();
    expect(st.status).toBe<SessionStatus>('need-init');
    // 未初始化时不该再问"我是谁"
    expect(apiMock.session).not.toHaveBeenCalled();
    expect(st.sessionVerified).toBe(false);
  });

  it('已登录 → ready，并触发设备刷新与静默同步', async () => {
    apiMock.status.mockResolvedValue(health(true));
    apiMock.session.mockResolvedValue(sessionOk(true));
    await useSessionStore.getState().bootstrap();
    const st = useSessionStore.getState();
    expect(st.status).toBe<SessionStatus>('ready');
    expect(st.elevated).toBe(true);
    expect(st.elevatedUntil).toBe(999);
    expect(st.serverVersion).toBe('1.0.0');
    expect(st.sessionVerified).toBe(true);
    expect(syncNow).toHaveBeenCalledWith({ silent: true });
    expect(bindOnlineListeners).toHaveBeenCalled();
  });

  it('会话 401 → need-login', async () => {
    apiMock.status.mockResolvedValue(health(true));
    apiMock.session.mockRejectedValue(new ApiError('unauthorized', '未登录', 401));
    await useSessionStore.getState().bootstrap();
    expect(useSessionStore.getState().status).toBe<SessionStatus>('need-login');
  });

  it('网络不通 + 本机登录过 → 离线模式继续用', async () => {
    localStorage.setItem('twische.authed', '1');
    apiMock.status.mockRejectedValue(new ApiError('network_error', '断网'));
    await useSessionStore.getState().bootstrap();
    const st = useSessionStore.getState();
    expect(st.status).toBe<SessionStatus>('ready');
    expect(st.offlineMode).toBe(true);
  });

  it('网络不通 + 首次使用 → 错误指引', async () => {
    apiMock.status.mockRejectedValue(new ApiError('network_error', '断网'));
    await useSessionStore.getState().bootstrap();
    const st = useSessionStore.getState();
    expect(st.status).toBe<SessionStatus>('error');
    expect(st.bootError).toBe('断网');
  });

  it('其它错误（如 500）→ 错误指引', async () => {
    apiMock.status.mockRejectedValue(new ApiError('server_error', '服务端炸了', 500));
    await useSessionStore.getState().bootstrap();
    expect(useSessionStore.getState().status).toBe<SessionStatus>('error');
  });
});

/**
 * 快路径是"联网卡顿"修复的核心：本机登录过的设备必须立刻拿到界面，
 * 网络校验降级为后台动作。这一组用例锁住该契约。
 */
describe('bootstrap 快路径（乐观首屏）', () => {
  it('本机登录过 → 不起 boot，立即 ready 且未验证，随后后台校验', async () => {
    localStorage.setItem('twische.authed', '1');
    let releaseStatus: ((v: unknown) => void) | null = null;
    // status 挂住不返回，模拟"服务端很慢"：界面不该被它挡住
    apiMock.status.mockImplementation(
      () =>
        new Promise((res) => {
          releaseStatus = res;
        }),
    );

    await useSessionStore.getState().bootstrap();

    // 关键断言：网络还没答话，界面已经 ready 了
    const st = useSessionStore.getState();
    expect(st.status).toBe<SessionStatus>('ready');
    expect(st.sessionVerified).toBe(false);
    expect(initRepo).toHaveBeenCalled();

    // 放行后台探测，确认它能正常收尾
    releaseStatus?.(health(true));
    apiMock.session.mockResolvedValue(sessionOk(false));
    await vi.waitFor(() => {
      expect(useSessionStore.getState().sessionVerified).toBe(true);
    });
  });

  it('后台校验成功 → 补上版本号与设备刷新', async () => {
    localStorage.setItem('twische.authed', '1');
    apiMock.status.mockResolvedValue(health(true));
    apiMock.session.mockResolvedValue(sessionOk(true));

    await useSessionStore.getState().bootstrap();
    expect(useSessionStore.getState().serverVersion).toBe('1.0.0');

    await vi.waitFor(() => {
      const st = useSessionStore.getState();
      expect(st.sessionVerified).toBe(true);
      expect(st.elevated).toBe(true);
    });
    expect(apiMock.devices).toHaveBeenCalled();
  });

  it('后台校验：session 缺 elevatedUntil → 按 0 处理', async () => {
    localStorage.setItem('twische.authed', '1');
    apiMock.status.mockResolvedValue(health(true));
    apiMock.session.mockResolvedValue({ session: { elevated: true } });

    await useSessionStore.getState().bootstrap();
    await vi.waitFor(() => {
      expect(useSessionStore.getState().sessionVerified).toBe(true);
    });
    const st = useSessionStore.getState();
    expect(st.elevated).toBe(true);
    expect(st.elevatedUntil).toBe(0);
  });

  it('后台校验发现服务端未初始化 → 回退 need-init', async () => {
    localStorage.setItem('twische.authed', '1');
    apiMock.status.mockResolvedValue(health(false));

    await useSessionStore.getState().bootstrap();
    // 后台探测用 mockResolvedValue 会极快返回，可能在 bootstrap 内就跑完了；
    // 断言最终态即可（无论在这轮 await 之前还是之后收敛，结论都应一致）
    await vi.waitFor(() => {
      expect(useSessionStore.getState().status).toBe<SessionStatus>('need-init');
    });
    expect(useSessionStore.getState().sessionVerified).toBe(false);
  });

  it('后台校验发现登录失效 → 回登录页并清掉可信标记', async () => {
    localStorage.setItem('twische.authed', '1');
    apiMock.status.mockResolvedValue(health(true));
    apiMock.session.mockRejectedValue(new ApiError('unauthorized', '未登录', 401));

    await useSessionStore.getState().bootstrap();
    await vi.waitFor(() => {
      expect(useSessionStore.getState().status).toBe<SessionStatus>('need-login');
    });
    expect(localStorage.getItem('twische.authed')).toBeNull();
    expect(useSessionStore.getState().sessionVerified).toBe(false);
  });

  it('后台校验网络失败 → 保持 ready 并转为离线', async () => {
    localStorage.setItem('twische.authed', '1');
    apiMock.status.mockRejectedValue(new ApiError('network_error', '断网'));

    await useSessionStore.getState().bootstrap();
    await vi.waitFor(() => {
      const st = useSessionStore.getState();
      expect(st.status).toBe<SessionStatus>('ready');
      expect(st.offlineMode).toBe(true);
      expect(st.sessionVerified).toBe(false);
    });
    expect(syncNow).toHaveBeenCalledWith({ silent: true });
  });

  it('后台校验遇到非网络错误 → 仍不把用户踢出界面', async () => {
    localStorage.setItem('twische.authed', '1');
    apiMock.status.mockRejectedValue(new ApiError('server_error', '500', 500));

    await useSessionStore.getState().bootstrap();
    // 非网络错误也不该打断用户：界面留在一开始就绪的状态，只是标记为未验证
    await vi.waitFor(() => {
      expect(apiMock.status).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 10));
    const st = useSessionStore.getState();
    expect(st.status).toBe<SessionStatus>('ready');
    expect(st.sessionVerified).toBe(false);
    // 非网络失败不进离线模式（离线专指"连不上"），也不弹错误打断
    expect(st.offlineMode).toBe(false);
    expect(st.bootError).toBe('');
  });

  it('后台校验：session 抛非认证类错误 → 同样留在界面（非离线）', async () => {
    localStorage.setItem('twische.authed', '1');
    apiMock.status.mockResolvedValue(health(true));
    // health 正常、session 报 500：不是登录失效，不该回登录页
    apiMock.session.mockRejectedValue(new ApiError('server_error', 'session 500', 500));

    await useSessionStore.getState().bootstrap();
    await vi.waitFor(() => {
      expect(apiMock.session).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 10));
    const st = useSessionStore.getState();
    expect(st.status).toBe<SessionStatus>('ready');
    expect(st.sessionVerified).toBe(false);
    expect(st.offlineMode).toBe(false);
    // 认证标记要保留：这只是服务端抽风，不是会话失效
    expect(localStorage.getItem('twische.authed')).toBe('1');
  });

  it('后台校验：session 网络错误 → 转为离线模式', async () => {
    localStorage.setItem('twische.authed', '1');
    apiMock.status.mockResolvedValue(health(true));
    apiMock.session.mockRejectedValue(new ApiError('network_error', '断网'));

    await useSessionStore.getState().bootstrap();
    await vi.waitFor(() => {
      const st = useSessionStore.getState();
      expect(st.offlineMode).toBe(true);
    });
    const st = useSessionStore.getState();
    expect(st.status).toBe<SessionStatus>('ready');
    expect(st.sessionVerified).toBe(false);
  });

  it('后台校验期间用户已登出 → 不把状态覆盖回 ready', async () => {
    localStorage.setItem('twische.authed', '1');
    let releaseSession: ((v: unknown) => void) | null = null;
    apiMock.status.mockResolvedValue(health(true));
    apiMock.session.mockImplementation(
      () =>
        new Promise((res) => {
          releaseSession = res;
        }),
    );

    await useSessionStore.getState().bootstrap();
    // 模拟用户在后台探测还没回来时点了退出
    useSessionStore.setState({ status: 'need-login' });
    releaseSession?.(sessionOk(false));

    await new Promise((r) => setTimeout(r, 20));
    expect(useSessionStore.getState().status).toBe<SessionStatus>('need-login');
  });

  it('快路径本地仓库起不来 → 回落到慢路径探测', async () => {
    localStorage.setItem('twische.authed', '1');
    vi.mocked(initRepo).mockRejectedValueOnce(new Error('idb 炸了'));
    apiMock.status.mockResolvedValue(health(true));
    apiMock.session.mockResolvedValue(sessionOk(false));

    await useSessionStore.getState().bootstrap();
    expect(useSessionStore.getState().status).toBe<SessionStatus>('ready');
    // 第二次 initRepo 成功，说明确实回落并完成了完整探测
    expect(useSessionStore.getState().sessionVerified).toBe(true);
  });
});

describe('retrySession', () => {
  it('恢复成功返回 true 并进入 ready', async () => {
    apiMock.status.mockResolvedValue(health(true));
    apiMock.session.mockResolvedValue(sessionOk());
    await expect(useSessionStore.getState().retrySession()).resolves.toBe(true);
    expect(useSessionStore.getState().status).toBe<SessionStatus>('ready');
  });

  it('仍未初始化返回 false', async () => {
    apiMock.status.mockResolvedValue(health(false));
    await expect(useSessionStore.getState().retrySession()).resolves.toBe(false);
    expect(useSessionStore.getState().status).toBe<SessionStatus>('need-init');
  });

  it('仍 401 → need-login', async () => {
    apiMock.status.mockResolvedValue(health(true));
    apiMock.session.mockRejectedValue(new ApiError('unauthorized', '未登录', 401));
    await expect(useSessionStore.getState().retrySession()).resolves.toBe(false);
    expect(useSessionStore.getState().status).toBe<SessionStatus>('need-login');
  });

  it('其它错误弹提示并返回 false', async () => {
    apiMock.status.mockRejectedValue(new ApiError('network_error', '还是断网'));
    await expect(useSessionStore.getState().retrySession()).resolves.toBe(false);
    expect(notifyMock.error).toHaveBeenCalledWith('仍然无法连接', '还是断网');
  });
});

describe('login 错误矩阵', () => {
  const loginAs = (impl: () => Promise<unknown>) => {
    apiMock.login.mockImplementation(impl);
    return useSessionStore.getState().login('pw');
  };

  it('成功 → ready + 同步成功', async () => {
    syncNow.mockResolvedValueOnce(true);
    apiMock.session.mockResolvedValue(sessionOk());
    await expect(loginAs(async () => undefined)).resolves.toBe(true);
    const st = useSessionStore.getState();
    expect(st.status).toBe<SessionStatus>('ready');
    expect(notifyMock.warn).not.toHaveBeenCalled();
  });

  it('登录成功但首次同步失败 → 警告', async () => {
    syncNow.mockResolvedValueOnce(false);
    syncState.lastError = '超时';
    apiMock.session.mockResolvedValue(sessionOk());
    await expect(loginAs(async () => undefined)).resolves.toBe(true);
    expect(notifyMock.warn).toHaveBeenCalledWith('已登录，但首次同步未完成', '超时');
  });

  it('locked → 记录等待秒数', async () => {
    await expect(
      loginAs(() => Promise.reject(new ApiError('locked', '已锁定', 423, { retryAfterSec: 30 }))),
    ).resolves.toBe(false);
    expect(useSessionStore.getState().retryAfterSec).toBe(30);
    expect(notifyMock.error).toHaveBeenCalledWith('已锁定', '请等待 30 秒后重试');
  });

  it('too_many_requests → 同样记录等待秒数', async () => {
    await expect(
      loginAs(() => Promise.reject(new ApiError('too_many_requests', '太频繁', 429))),
    ).resolves.toBe(false);
    expect(useSessionStore.getState().retryAfterSec).toBe(0);
    expect(notifyMock.error).toHaveBeenCalledWith('太频繁', undefined);
  });

  it('bad_credentials → 密码不正确', async () => {
    await expect(
      loginAs(() => Promise.reject(new ApiError('bad_credentials', 'x', 401))),
    ).resolves.toBe(false);
    expect(notifyMock.error).toHaveBeenCalledWith('密码不正确');
  });

  it('not_initialized → 切到 need-init', async () => {
    await expect(
      loginAs(() => Promise.reject(new ApiError('not_initialized', 'x', 409))),
    ).resolves.toBe(false);
    expect(useSessionStore.getState().status).toBe<SessionStatus>('need-init');
  });

  it('网络错误 → 连接提示', async () => {
    await expect(
      loginAs(() => Promise.reject(new ApiError('network_error', 'DNS 挂了'))),
    ).resolves.toBe(false);
    expect(notifyMock.error).toHaveBeenCalledWith('无法连接到服务器', 'DNS 挂了');
  });

  it('未知 ApiError / 非 ApiError → 兜底提示', async () => {
    await expect(
      loginAs(() => Promise.reject(new ApiError('weird', '怪错误', 500))),
    ).resolves.toBe(false);
    expect(notifyMock.error).toHaveBeenCalledWith('怪错误');
    await expect(
      loginAs(() => Promise.reject(new Error('boom'))),
    ).resolves.toBe(false);
    expect(notifyMock.error).toHaveBeenCalledWith('登录失败', 'boom');
  });
});

describe('logout', () => {
  it('在线且未失效：先同步再退出，无脏数据提示 ok', async () => {
    syncNow.mockResolvedValueOnce(true);
    await useSessionStore.getState().logout();
    expect(syncNow).toHaveBeenCalledWith({ silent: true });
    expect(wipeLocal).toHaveBeenCalledWith(false);
    expect(stopSync).toHaveBeenCalled();
    expect(useSessionStore.getState().status).toBe<SessionStatus>('need-login');
    expect(notifyMock.ok).toHaveBeenCalledWith('已退出登录');
    expect(localStorage.getItem('twische.authed')).toBeNull();
  });

  it('有脏数据：退出时警告条数', async () => {
    syncNow.mockResolvedValueOnce(true);
    repo.records.set('r1', { dirty: true });
    repo.records.set('r2', { dirty: false });
    await useSessionStore.getState().logout();
    expect(notifyMock.warn).toHaveBeenCalledWith(
      '已退出登录',
      expect.stringContaining('1 条未同步'),
    );
  });

  it('同步抛错不阻断退出', async () => {
    syncNow.mockRejectedValueOnce(new Error('x'));
    await useSessionStore.getState().logout();
    expect(useSessionStore.getState().status).toBe<SessionStatus>('need-login');
  });

  it('离线或已失效：跳过同步直接退出', async () => {
    syncState.online = false;
    await useSessionStore.getState().logout();
    expect(syncNow).not.toHaveBeenCalled();
  });

  it('api.logout 失败也照样清本地', async () => {
    apiMock.logout.mockRejectedValueOnce(new ApiError('network_error', '断'));
    await useSessionStore.getState().logout();
    expect(wipeLocal).toHaveBeenCalled();
  });

  it('退出时悬空的密码请求被取消、提权复位', async () => {
    const pending = useSessionStore.getState().requestPassword('x');
    useSessionStore.setState({ elevated: true, elevatedUntil: 5 });
    syncNow.mockResolvedValueOnce(true);
    await useSessionStore.getState().logout();
    await expect(pending).rejects.toMatchObject({ code: 'elevation_cancelled' });
    expect(useSessionStore.getState().elevated).toBe(false);
  });
});

describe('logoutAll / changePassword', () => {
  it('logoutAll 成功', async () => {
    apiMock.logoutAll.mockResolvedValueOnce({ revokedSessions: 3 });
    await useSessionStore.getState().logoutAll();
    expect(notifyMock.ok).toHaveBeenCalledWith('已在所有设备上退出', expect.stringContaining('3'));
  });

  it('logoutAll 失败弹错误', async () => {
    apiMock.logoutAll.mockRejectedValueOnce(new ApiError('network_error', '断'));
    await useSessionStore.getState().logoutAll();
    expect(notifyMock.error).toHaveBeenCalled();
  });

  it('changePassword：成功且吊销了其它会话', async () => {
    apiMock.changePassword.mockResolvedValueOnce({ revokedSessions: 2 });
    await expect(useSessionStore.getState().changePassword('a', 'b')).resolves.toBe(true);
    expect(notifyMock.ok).toHaveBeenCalledWith('密码已更新', expect.stringContaining('2'));
  });

  it('changePassword：没有其它会话', async () => {
    apiMock.changePassword.mockResolvedValueOnce({ revokedSessions: 0 });
    await expect(useSessionStore.getState().changePassword('a', 'b')).resolves.toBe(true);
    expect(notifyMock.ok).toHaveBeenCalledWith('密码已更新', '当前设备会继续保持登录');
  });

  it('changePassword：弱密码列出问题', async () => {
    apiMock.changePassword.mockRejectedValueOnce(
      new ApiError('weak_password', '弱', 400, { problems: ['太短', '太简单'] }),
    );
    await expect(useSessionStore.getState().changePassword('a', 'b')).resolves.toBe(false);
    expect(notifyMock.error).toHaveBeenCalledWith('新密码强度不足', '太短；太简单');
  });

  it('changePassword：当前密码错误', async () => {
    apiMock.changePassword.mockRejectedValueOnce(
      new ApiError('password_mismatch', 'x', 400),
    );
    await expect(useSessionStore.getState().changePassword('a', 'b')).resolves.toBe(false);
    expect(notifyMock.error).toHaveBeenCalledWith('当前密码不正确');
  });

  it('changePassword：其它错误与非 ApiError 兜底', async () => {
    apiMock.changePassword.mockRejectedValueOnce(new ApiError('weird', '怪', 500));
    await expect(useSessionStore.getState().changePassword('a', 'b')).resolves.toBe(false);
    expect(notifyMock.error).toHaveBeenCalledWith('怪');
    apiMock.changePassword.mockRejectedValueOnce(new Error('boom'));
    await expect(useSessionStore.getState().changePassword('a', 'b')).resolves.toBe(false);
    expect(notifyMock.error).toHaveBeenCalledWith('修改失败', 'boom');
  });
});

describe('账户与设备刷新', () => {
  it('refreshAccount 成功写入 account/stats/environment', async () => {
    apiMock.account.mockResolvedValueOnce({
      account: { createdAt: 1 },
      stats: { tasks: 2 },
      environment: { app: 'twische', runtime: 'go', platform: 'windows' },
    });
    await useSessionStore.getState().refreshAccount();
    const st = useSessionStore.getState();
    expect(st.stats).toEqual({ tasks: 2 });
    expect(st.environment).toEqual({ app: 'twische', runtime: 'go', platform: 'windows' });
  });

  it('refreshAccount 失败弹提示', async () => {
    apiMock.account.mockRejectedValueOnce(new Error('x'));
    await useSessionStore.getState().refreshAccount();
    expect(notifyMock.error).toHaveBeenCalledWith('无法读取账户信息', 'x');
  });

  it('refreshDevices 失败静默', async () => {
    apiMock.devices.mockRejectedValueOnce(new Error('x'));
    await expect(useSessionStore.getState().refreshDevices()).resolves.toBeUndefined();
    expect(notifyMock.error).not.toHaveBeenCalled();
  });

  it('refreshSessionElevation 成功/失败', async () => {
    apiMock.session.mockResolvedValueOnce(sessionOk(true));
    await useSessionStore.getState().refreshSessionElevation();
    expect(useSessionStore.getState().elevated).toBe(true);
    // 响应缺 elevatedUntil 字段 → 按 0 处理
    apiMock.session.mockResolvedValueOnce({ session: { elevated: true } });
    await useSessionStore.getState().refreshSessionElevation();
    expect(useSessionStore.getState().elevatedUntil).toBe(0);
    apiMock.session.mockRejectedValueOnce(new Error('x'));
    await expect(useSessionStore.getState().refreshSessionElevation()).resolves.toBeUndefined();
  });
});

describe('设备管理（提权流程）', () => {
  it('无提权要求时直接成功', async () => {
    apiMock.renameDevice.mockResolvedValueOnce({ devices: [{ id: 'd1', name: 'n' }] });
    await useSessionStore.getState().renameDevice('d1', '新名');
    expect(notifyMock.ok).toHaveBeenCalledWith('设备已重命名');
    expect(useSessionStore.getState().devices).toEqual([{ id: 'd1', name: 'n' }]);
  });

  it('重命名本机时同步更新本地设备名', async () => {
    apiMock.renameDevice.mockResolvedValueOnce({ devices: [] });
    await useSessionStore.getState().renameDevice('dev-self', '本机新名');
    expect(setDeviceName).toHaveBeenCalledWith('本机新名');
  });

  it('password_required → 弹密码 → 带密码重试成功', async () => {
    apiMock.revokeDevice
      .mockRejectedValueOnce(new ApiError('password_required', '需要密码', 403))
      .mockResolvedValueOnce({ devices: [{ id: 'd2', name: 'x' }], revokedSessions: 1 });
    apiMock.session.mockResolvedValue(sessionOk(true));

    const p = useSessionStore.getState().revokeDevice('d2');
    await vi.waitFor(() => expect(useSessionStore.getState().passwordPromptOpen).toBe(true));
    useSessionStore.getState().submitPassword('确认密码');
    await p;

    expect(apiMock.revokeDevice).toHaveBeenNthCalledWith(2, 'd2', '确认密码');
    expect(notifyMock.ok).toHaveBeenCalledWith('已让该设备退出登录', expect.anything());
    expect(useSessionStore.getState().elevated).toBe(true); // 重试成功后刷新了提权状态
  });

  it('提权密码被取消 → 安静收场', async () => {
    apiMock.forgetDevice.mockRejectedValueOnce(
      new ApiError('password_required', '需要密码', 403),
    );
    const p = useSessionStore.getState().forgetDevice('d3');
    await vi.waitFor(() => expect(useSessionStore.getState().passwordPromptOpen).toBe(true));
    useSessionStore.getState().cancelPassword();
    await p;
    expect(notifyMock.error).not.toHaveBeenCalled();
  });

  it('提权密码错误 → 提示并取消', async () => {
    apiMock.forgetDevice
      .mockRejectedValueOnce(new ApiError('password_required', '需要密码', 403))
      .mockRejectedValueOnce(new ApiError('password_mismatch', '不对', 400));
    const p = useSessionStore.getState().forgetDevice('d3');
    await vi.waitFor(() => expect(useSessionStore.getState().passwordPromptOpen).toBe(true));
    useSessionStore.getState().submitPassword('错的');
    await p;
    expect(notifyMock.error).toHaveBeenCalledWith('密码不正确', '该操作已取消');
  });

  it('非密码类错误 → 兜底提示', async () => {
    apiMock.renameDevice.mockRejectedValueOnce(new ApiError('weird', '怪', 500));
    await useSessionStore.getState().renameDevice('d4', 'x');
    expect(notifyMock.error).toHaveBeenCalledWith('重命名失败', '怪');
  });
});

describe('与同步层的订阅联动', () => {
  it('同步层报 unauthorized → 切回登录页', () => {
    syncState.unauthorized = true;
    useSessionStore.setState({ status: 'ready' });
    emitSync();
    expect(useSessionStore.getState().status).toBe<SessionStatus>('need-login');
    expect(notifyMock.warn).toHaveBeenCalledWith('登录状态已失效', '请重新输入密码');
  });

  it('已不是 ready 状态时不重复切换', () => {
    syncState.unauthorized = true;
    useSessionStore.setState({ status: 'need-login' });
    emitSync();
    expect(notifyMock.warn).not.toHaveBeenCalled();
  });

  it('离线模式恢复联网 → 回到在线并刷新设备', () => {
    syncState.online = true;
    useSessionStore.setState({ offlineMode: true, status: 'ready' });
    apiMock.devices.mockResolvedValueOnce({ devices: [] });
    emitSync();
    expect(useSessionStore.getState().offlineMode).toBe(false);
    expect(notifyMock.ok).toHaveBeenCalledWith('已恢复连接', '离线期间的改动正在同步');
  });

  it('在线状态下 online 事件不触发恢复提示', () => {
    useSessionStore.setState({ offlineMode: false, status: 'ready' });
    emitSync();
    expect(notifyMock.ok).not.toHaveBeenCalled();
  });
});

describe('countDirty', () => {
  it('统计脏记录数', () => {
    repo.records.set('a', { dirty: true });
    repo.records.set('b', { dirty: false });
    repo.records.set('c', { dirty: true });
    expect(useSessionStore.getState().countDirty()).toBe(2);
  });
});

describe('localStorage 异常容错', () => {
  it('wasAuthed 读失败按未登录处理 → 落到错误指引', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((k) => {
      if (k === 'twische.authed') throw new Error('blocked');
      return null;
    });
    apiMock.status.mockRejectedValue(new ApiError('network_error', '断网'));
    await useSessionStore.getState().bootstrap();
    expect(useSessionStore.getState().status).toBe<SessionStatus>('error');
  });

  it('markAuthed 写失败不阻断正常启动', async () => {
    // 只对 authed 标记抛错，避免影响其它 localStorage 调用
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k) => {
      if (k === 'twische.authed') throw new Error('blocked');
    });
    apiMock.status.mockResolvedValue(health(true));
    apiMock.session.mockResolvedValue(sessionOk());
    await useSessionStore.getState().bootstrap();
    expect(useSessionStore.getState().status).toBe<SessionStatus>('ready');
  });

  it('clearAuthed 删失败不阻断退出', async () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    syncNow.mockResolvedValueOnce(true);
    await useSessionStore.getState().logout();
    expect(useSessionStore.getState().status).toBe<SessionStatus>('need-login');
  });
});

describe('bootstrap 补充分支', () => {
  it('会话探测抛非 ApiError → 错误指引', async () => {
    apiMock.status.mockResolvedValue(health(true));
    apiMock.session.mockRejectedValue(new Error('session 炸了'));
    await useSessionStore.getState().bootstrap();
    const st = useSessionStore.getState();
    expect(st.status).toBe<SessionStatus>('error');
    expect(st.bootError).toBe('session 炸了');
  });

  it('status 抛非 Error 值 → bootError 用 String 转换', async () => {
    apiMock.status.mockRejectedValue('boom-string');
    await useSessionStore.getState().bootstrap();
    expect(useSessionStore.getState().bootError).toBe('boom-string');
  });

  it('本地仓库起不来 + 服务端正常 → 错误指引（没有数据源就不能进界面）', async () => {
    apiMock.status.mockResolvedValue(health(true));
    vi.mocked(initRepo).mockRejectedValueOnce(new Error('idb 炸了'));
    await useSessionStore.getState().bootstrap();
    const st = useSessionStore.getState();
    expect(st.status).toBe<SessionStatus>('error');
    expect(st.bootError).toBe('idb 炸了');
  });

  it('离线模式但本地仓库也起不来 → 错误指引', async () => {
    localStorage.setItem('twische.authed', '1');
    apiMock.status.mockRejectedValue(new ApiError('network_error', '断网'));
    // 快路径与慢路径各会 initRepo 一次，两次都失败才真的无路可走
    vi.mocked(initRepo).mockRejectedValue(new Error('idb 炸了'));
    await useSessionStore.getState().bootstrap();
    expect(useSessionStore.getState().status).toBe<SessionStatus>('error');
  });

  it('快路径仓库失败但慢路径恢复 → 仍能进离线模式', async () => {
    localStorage.setItem('twische.authed', '1');
    apiMock.status.mockRejectedValue(new ApiError('network_error', '断网'));
    // 快路径那次失败（回落慢路径），慢路径那次成功 → 走离线兜底
    vi.mocked(initRepo).mockRejectedValueOnce(new Error('idb 抖了一下')).mockResolvedValue(undefined);

    await useSessionStore.getState().bootstrap();
    const st = useSessionStore.getState();
    expect(st.status).toBe<SessionStatus>('ready');
    expect(st.offlineMode).toBe(true);
    expect(st.sessionVerified).toBe(false);
    expect(bindOnlineListeners).toHaveBeenCalled();
    expect(syncNow).toHaveBeenCalledWith({ silent: true });
  });

  it('session 缺 elevatedUntil 字段 → 按 0 处理', async () => {
    apiMock.status.mockResolvedValue(health(true));
    apiMock.session.mockResolvedValue({ session: { elevated: false } });
    await useSessionStore.getState().bootstrap();
    expect(useSessionStore.getState().elevatedUntil).toBe(0);
  });
});

describe('retrySession 补充分支', () => {
  it('session 缺 elevatedUntil 字段 → 按 0 处理', async () => {
    apiMock.status.mockResolvedValue(health(true));
    apiMock.session.mockResolvedValue({ session: { elevated: true } });
    await useSessionStore.getState().retrySession();
    expect(useSessionStore.getState().elevatedUntil).toBe(0);
  });

  it('status 抛非 Error 值 → 提示不带详情', async () => {
    apiMock.status.mockRejectedValue('boom-string');
    await expect(useSessionStore.getState().retrySession()).resolves.toBe(false);
    expect(notifyMock.error).toHaveBeenCalledWith('仍然无法连接', undefined);
  });
});

describe('错误提示的兜底文案', () => {
  it('login 抛非 Error 值', async () => {
    apiMock.login.mockRejectedValue('boom-string');
    await expect(useSessionStore.getState().login('pw')).resolves.toBe(false);
    expect(notifyMock.error).toHaveBeenCalledWith('登录失败', undefined);
  });

  it('logoutAll 抛非 Error 值', async () => {
    apiMock.logoutAll.mockRejectedValue('boom-string');
    await useSessionStore.getState().logoutAll();
    expect(notifyMock.error).toHaveBeenCalledWith('操作失败', undefined);
  });

  it('changePassword 弱密码缺 problems 字段 → 空文案', async () => {
    apiMock.changePassword.mockRejectedValueOnce(new ApiError('weak_password', '弱', 400));
    await expect(useSessionStore.getState().changePassword('a', 'b')).resolves.toBe(false);
    expect(notifyMock.error).toHaveBeenCalledWith('新密码强度不足', '');
  });

  it('changePassword 抛非 Error 值', async () => {
    apiMock.changePassword.mockRejectedValueOnce('boom-string');
    await expect(useSessionStore.getState().changePassword('a', 'b')).resolves.toBe(false);
    expect(notifyMock.error).toHaveBeenCalledWith('修改失败', undefined);
  });

  it('refreshAccount 抛非 Error 值', async () => {
    apiMock.account.mockRejectedValueOnce('boom-string');
    await useSessionStore.getState().refreshAccount();
    expect(notifyMock.error).toHaveBeenCalledWith('无法读取账户信息', undefined);
  });
});

describe('提权重试的再失败路径', () => {
  it('重命名设备：非 ApiError 直接重抛并提示', async () => {
    apiMock.renameDevice.mockRejectedValueOnce(new Error('boom'));
    await useSessionStore.getState().renameDevice('d1', 'x');
    expect(notifyMock.error).toHaveBeenCalledWith('重命名失败', 'boom');
    expect(useSessionStore.getState().passwordPromptOpen).toBe(false);
  });

  it('重命名设备：抛非 Error 值 → 详情为 undefined', async () => {
    apiMock.renameDevice.mockRejectedValueOnce('boom-string');
    await useSessionStore.getState().renameDevice('d1', 'x');
    expect(notifyMock.error).toHaveBeenCalledWith('重命名失败', undefined);
  });

  it('重命名设备：非密码类 ApiError 同样直接提示', async () => {
    apiMock.renameDevice.mockRejectedValueOnce(new ApiError('weird', '怪', 500));
    await useSessionStore.getState().renameDevice('d1', 'x');
    expect(notifyMock.error).toHaveBeenCalledWith('重命名失败', '怪');
  });

  it('吊销设备：非密码类 ApiError → 操作失败', async () => {
    apiMock.revokeDevice.mockRejectedValueOnce(new ApiError('weird', '怪', 500));
    await useSessionStore.getState().revokeDevice('d2');
    expect(notifyMock.error).toHaveBeenCalledWith('操作失败', '怪');
  });

  it('移除设备：直接成功（无需提权）', async () => {
    apiMock.forgetDevice.mockResolvedValueOnce({ devices: [{ id: 'd3', name: 'n' }] });
    await useSessionStore.getState().forgetDevice('d3');
    expect(notifyMock.ok).toHaveBeenCalledWith('设备已移除');
    expect(useSessionStore.getState().devices).toEqual([{ id: 'd3', name: 'n' }]);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { FakeDavServer } from '@/test/dav-fake';
import { DavClient } from '@/storage/webdav/client';
import { WebDavStore } from '@/storage/webdav/store';
import type { DavProfile } from '@/storage/credentials';

/**
 * 连接状态测试。
 *
 * 网络与凭据都打桩，本地仓库用真的（fake-indexeddb）——
 * 「先给界面，再对答案」这条体验规则正是靠这些分支实现的，
 * 而它最容易在改动中被无声破坏。
 */

vi.mock('@/storage/connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage/connect')>();
  return { ...actual, openDavConnection: vi.fn() };
});

vi.mock('@/storage/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage/credentials')>();
  return {
    ...actual,
    loadProfile: vi.fn(),
    saveProfile: vi.fn(),
    clearProfile: vi.fn(),
    loadPassword: vi.fn(),
    savePassword: vi.fn(),
    clearPassword: vi.fn(),
  };
});

let store: typeof import('./session');
let creds: typeof import('@/storage/credentials');
let connect: typeof import('@/storage/connect');
let sync: typeof import('@/repo/sync');
let repo: typeof import('@/repo/localrepo');

const flush = () => new Promise<void>((r) => setTimeout(r, 30));

/** 轮询等待条件成立（后台同步是 fire-and-forget，没法直接 await）。 */
async function waitFor(cond: () => boolean, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await flush();
  }
  throw new Error('等待超时');
}

const profile = (over: Partial<DavProfile> = {}): DavProfile => ({
  url: 'https://dav.test/dav',
  username: 'alice',
  remember: true,
  ...over,
});

/** 用假服务器造一个真实可用的连接结果。 */
function connection(server: FakeDavServer) {
  const client = new DavClient({
    url: server.url,
    username: 'alice',
    password: 'secret',
    fetchImpl: server.fetch,
  });
  return {
    client,
    store: new WebDavStore(client),
    probe: { recordCount: 0, created: true, etagReadable: true, davClasses: ['1'] },
  };
}

const session = () => store.useSessionStore.getState();

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('twische.deviceId', 'devA');
  localStorage.setItem('twische.deviceName', '测试机');
  // resetAllMocks（而不是 clearAllMocks）：后者不清实现，
  // 上一个用例设的 mockRejectedValue 会泄漏到下一个用例里
  vi.resetAllMocks();

  creds = await import('@/storage/credentials');
  connect = await import('@/storage/connect');
  repo = await import('@/repo/localrepo');
  sync = await import('@/repo/sync');

  const idb = await import('@/repo/idb');
  await idb.clearAll();

  // 默认：配过一个地址、密码也记着、连得上。各用例按需覆盖。
  // 必须在导入 store 之前设好：store 在模块初始化时就会读一次 loadProfile()。
  (creds.loadProfile as Mock).mockReturnValue(profile());
  (creds.loadPassword as Mock).mockResolvedValue('secret');
  (connect.openDavConnection as Mock).mockResolvedValue(connection(new FakeDavServer()));

  store = await import('./session');
});

/** 往本地库里塞一条记录（必须落 IndexedDB，bootstrap 会重新从库里加载）。 */
async function seedLocalRecord(id = 'a'): Promise<void> {
  const idb = await import('@/repo/idb');
  await idb.putMany(idb.STORE_RECORDS, [
    { id, kind: 'task', data: { title: '本地任务' }, vc: { devA: 1 }, updatedAt: 1, dirty: false },
  ]);
}

afterEach(() => {
  sync.__resetSyncForTest();
  vi.restoreAllMocks();
});

describe('启动流程', () => {
  it('从未配置过 → need-setup', async () => {
    (creds.loadProfile as Mock).mockReturnValue(profile({ url: '' }));
    await session().bootstrap();
    expect(session().status).toBe('need-setup');
  });

  it('本地库起不来 → 降级为内存模式继续走连接流程', async () => {
    const idb = await import('@/repo/idb');
    vi.spyOn(idb, 'getAll').mockRejectedValue(new Error('indexeddb 坏了'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await session().bootstrap();
    // initRepo 内部会降级为内存模式，因此这里应当继续走连接流程
    expect(['need-login', 'ready', 'error']).toContain(session().status);
  });

  it('配过地址但没有密码、本地也没数据 → need-login', async () => {
    (creds.loadPassword as Mock).mockResolvedValue(null);

    await session().bootstrap();
    expect(session().status).toBe('need-login');
  });

  it('配过地址但没有密码、本地有数据 → 直接可用（离线）', async () => {
    await seedLocalRecord();
    (creds.loadPassword as Mock).mockResolvedValue(null);

    await session().bootstrap();
    expect(session().status).toBe('ready');
    expect(session().offlineMode).toBe(true);
  });

  it('本地有数据时先给界面，探测丢后台', async () => {
    await seedLocalRecord();
    (connect.openDavConnection as Mock).mockResolvedValue(connection(new FakeDavServer()));

    await session().bootstrap();
    expect(session().status).toBe('ready');
    expect(session().sessionVerified).toBe(false);

    await flush();
    expect(session().sessionVerified).toBe(true);
    expect(session().probe?.davClasses).toEqual(['1']);
  });

  it('本地为空时首次连接必须等结果', async () => {
    (connect.openDavConnection as Mock).mockResolvedValue(connection(new FakeDavServer()));

    await session().bootstrap();
    expect(session().status).toBe('ready');
    expect(session().sessionVerified).toBe(true);
  });

  it('首次连接认证失败 → need-login（并清掉存错的密码）', async () => {
    (connect.openDavConnection as Mock).mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('unauthorized', '401'),
    );

    await session().bootstrap();
    expect(session().status).toBe('need-login');
    expect(creds.clearPassword).toHaveBeenCalled();
  });

  it('首次连接网络失败且本地无数据 → error', async () => {
    (connect.openDavConnection as Mock).mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('cors', 'Failed to fetch'),
    );

    await session().bootstrap();
    expect(session().status).toBe('error');
    expect(session().bootError).toBeTruthy();
  });

  it('网络失败但本机连过 → 进入离线模式继续用', async () => {
    localStorage.setItem('twische.connected', '1');
    (connect.openDavConnection as Mock).mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('network', '断网'),
    );

    await session().bootstrap();
    expect(session().status).toBe('ready');
    expect(session().offlineMode).toBe(true);
  });
});

describe('连接与断开', () => {
  it('connect 成功后保存配置与密码并进入 ready', async () => {
    const server = new FakeDavServer();
    (connect.openDavConnection as Mock).mockResolvedValue(connection(server));

    const ok = await session().connect({
      url: server.url,
      username: 'alice',
      password: 'secret',
      remember: true,
    });

    expect(ok).toBe(true);
    expect(session().status).toBe('ready');
    expect(creds.saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ url: server.url, username: 'alice', remember: true }),
    );
    expect(creds.savePassword).toHaveBeenCalledWith('secret', true);
    expect(sync.getBackend()).not.toBeNull();
  });

  it('connect 失败时返回 false 并给出可读原因', async () => {
    (connect.openDavConnection as Mock).mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('not-dav', '不是 WebDAV'),
    );

    const ok = await session().connect({
      url: 'https://example.com',
      username: 'a',
      password: 'b',
      remember: true,
    });

    expect(ok).toBe(false);
    expect(session().connectError?.title).toContain('WebDAV');
    // 认证以外的失败不应该清掉已保存的密码
    expect(creds.clearPassword).not.toHaveBeenCalled();
  });

  it('换服务器时把本地记录标脏，避免被当成"远端已删除"清掉', async () => {
    const server = new FakeDavServer();
    // 先连一次 A
    (connect.openDavConnection as Mock).mockResolvedValue(connection(server));
    await session().connect({ url: server.url, username: 'alice', password: 'secret', remember: true });
    await flush(); // 等第一次同步跑完，避免它把下面手动插入的记录当成"远端已删除"清掉

    // 本地有一条"干净"记录（已同步到 A）
    repo.state.records.set('a', {
      id: 'a',
      kind: 'task',
      data: { title: 'x' },
      vc: { devA: 1 },
      updatedAt: 1,
      dirty: false,
    });

    // 换成 B（地址必须真的不同，否则不会走"换服务器"分支）
    const other = new FakeDavServer({ basePath: '/dav2' });
    (connect.openDavConnection as Mock).mockResolvedValue(connection(other));
    const ok = await session().connect({
      url: other.url,
      username: 'alice',
      password: 'secret',
      remember: true,
    });

    expect(ok).toBe(true);
    // 本地记录被推到新服务器（而不是因为"远端没有"被清掉）
    await waitFor(() => other.files.has('/dav2/twische/records/a.json'));
    expect(repo.getRecord('a')).toBeTruthy();
  });

  it('未连接时 countDirty 也能用', () => {
    repo.state.records.set('a', { id: 'a', kind: 'task', data: {}, vc: {}, updatedAt: 1, dirty: true });
    expect(session().countDirty()).toBe(1);
  });

  it('disconnect 保留本地数据，只断开连接与凭据', async () => {
    const server = new FakeDavServer();
    (connect.openDavConnection as Mock).mockResolvedValue(connection(server));
    await session().connect({ url: server.url, username: 'alice', password: 'secret', remember: true });
    repo.state.records.set('a', { id: 'a', kind: 'task', data: {}, vc: {}, updatedAt: 1 });

    await session().disconnect();
    expect(session().status).toBe('need-login');
    expect(creds.clearPassword).toHaveBeenCalled();
    expect(sync.getBackend()).toBeNull();
    expect(repo.getRecord('a')).toBeTruthy();
  });

  it('disconnectAndWipe 清空本地数据与配置', async () => {
    const server = new FakeDavServer();
    (connect.openDavConnection as Mock).mockResolvedValue(connection(server));
    await session().connect({ url: server.url, username: 'alice', password: 'secret', remember: true });
    repo.state.records.set('a', { id: 'a', kind: 'task', data: {}, vc: {}, updatedAt: 1 });

    await session().disconnectAndWipe();
    expect(session().status).toBe('need-setup');
    expect(session().profile.url).toBe('');
    expect(repo.getRecord('a')).toBeUndefined();
    expect(creds.clearProfile).toHaveBeenCalled();
  });

  it('localStorage 不可用时：连接标记的读写都不炸', async () => {
    // getItem（wasConnected）、setItem（markConnected）、removeItem（clearConnected）全部抛错
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
      clear: () => undefined,
    });
    const server = new FakeDavServer();
    (connect.openDavConnection as Mock).mockResolvedValue(connection(server));
    expect(
      await session().connect({ url: server.url, username: 'alice', password: 'secret', remember: true }),
    ).toBe(true);
    await expect(session().disconnect()).resolves.toBeUndefined();

    // wasConnected（getItem）也要走一遍：网络失败 + 本地无数据 → 不降级
    (connect.openDavConnection as Mock).mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('network', '断网'),
    );
    store.useSessionStore.setState({ status: 'ready', sessionVerified: false });
    await session().verify();
    expect(session().status).toBe('error');

    vi.unstubAllGlobals();
  });

  it('本地仓库初始化抛异常时落到 error，而不是一直卡在启动态', async () => {
    vi.spyOn(repo, 'initRepo').mockRejectedValue(new Error('仓库炸了'));
    await session().bootstrap();
    expect(session().status).toBe('error');
    expect(session().bootError).toBe('仓库炸了');
  });

  it('初始化抛出非 Error 时也能转成字符串', async () => {
    vi.spyOn(repo, 'initRepo').mockRejectedValue('字符串异常');
    await session().bootstrap();
    expect(session().bootError).toBe('字符串异常');
  });

  it('连接抛出非 DavError 时走兜底文案（没有可操作提示就用原始信息）', async () => {
    (connect.openDavConnection as Mock).mockRejectedValue(new Error('意料之外'));
    const ok = await session().connect({
      url: 'https://dav.test/dav',
      username: 'a',
      password: 'b',
      remember: true,
    });
    expect(ok).toBe(false);
    expect(session().connectError?.title).toBe('连接失败');
    expect(session().connectError?.hint).toBe('');
  });

  it('renameDevice 写到本地仓库', async () => {
    session().renameDevice('新设备名');
    expect(repo.state.deviceName).toBe('新设备名');
  });
});

describe('重试与补密码', () => {
  it('retry 在没有配置时回到 need-setup', async () => {
    store.useSessionStore.setState({ profile: profile({ url: '' }) });
    expect(await session().retry()).toBe(false);
    expect(session().status).toBe('need-setup');
  });

  it('retry 成功 → ready；失败 → 保持原状并提示', async () => {
    expect(await session().retry()).toBe(true);
    expect(session().status).toBe('ready');

    (connect.openDavConnection as Mock).mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('server', '500'),
    );
    expect(await session().retry()).toBe(false);

    // 非 DavError：没有可操作提示，退回原始信息
    (connect.openDavConnection as Mock).mockRejectedValue(new Error('莫名其妙'));
    expect(await session().retry()).toBe(false);
  });

  it('submitPassword 用新密码重连', async () => {
    const server = new FakeDavServer();
    (connect.openDavConnection as Mock).mockResolvedValueOnce(connection(server));
    expect(await session().submitPassword('secret')).toBe(true);
    expect(creds.savePassword).toHaveBeenCalledWith('secret', true);

    (connect.openDavConnection as Mock).mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('unauthorized', '401'),
    );
    expect(await session().submitPassword('bad')).toBe(false);

    (connect.openDavConnection as Mock).mockRejectedValue(new Error('莫名其妙'));
    expect(await session().submitPassword('bad')).toBe(false);
  });

  it('verify 在凭据失效时回到 need-login，在网络失败时保持可用', async () => {
    await seedLocalRecord();
    await repo.initRepo();
    store.useSessionStore.setState({ status: 'ready', sessionVerified: false });

    (connect.openDavConnection as Mock).mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('unauthorized', '401'),
    );
    await session().verify();
    expect(session().status).toBe('need-login');

    store.useSessionStore.setState({ status: 'ready', sessionVerified: false });
    (connect.openDavConnection as Mock).mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('network', '断网'),
    );
    await session().verify();
    expect(session().status).toBe('ready');
    expect(session().offlineMode).toBe(true);
  });

  it('verify 在非 ready 状态下不会覆盖界面', async () => {
    store.useSessionStore.setState({ status: 'need-setup' });
    (connect.openDavConnection as Mock).mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('server', '500'),
    );
    await session().verify();
    expect(session().status).toBe('need-setup');
    expect(session().sessionVerified).toBe(false);
  });

  it('refreshProbe 更新探测结果；失败时只提示不改变状态', async () => {
    const server = new FakeDavServer();
    server.seedRecord('task-1', { id: 'task-1', kind: 'task', data: {}, vc: { d: 1 }, updatedAt: 1 });
    (connect.openDavConnection as Mock).mockResolvedValue({
      ...connection(server),
      probe: { recordCount: 1, created: false, etagReadable: true, davClasses: ['1', '2'] },
    });

    await session().refreshProbe();
    expect(session().probe?.recordCount).toBe(1);

    (connect.openDavConnection as Mock).mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('server', '500'),
    );
    await expect(session().refreshProbe()).resolves.toBeUndefined();
  });

  it('verify 在缺地址或缺密码时直接返回，不做任何请求', async () => {
    store.useSessionStore.setState({ profile: profile({ url: '' }) });
    await session().verify();
    expect(connect.openDavConnection).not.toHaveBeenCalled();

    store.useSessionStore.setState({ profile: profile() });
    (creds.loadPassword as Mock).mockResolvedValue(null);
    await session().verify();
    expect(connect.openDavConnection).not.toHaveBeenCalled();
  });

  it('没有配置或密码时 refreshProbe 是空操作', async () => {
    (creds.loadProfile as Mock).mockReturnValue(profile({ url: '' }));
    (creds.loadPassword as Mock).mockResolvedValue(null);
    await expect(session().refreshProbe()).resolves.toBeUndefined();
    expect(connect.openDavConnection).not.toHaveBeenCalled();
  });
});

describe('同步状态联动', () => {
  it('同步层报告凭据失效 → 回到 need-login 并清掉密码', async () => {
    const server = new FakeDavServer();
    (connect.openDavConnection as Mock).mockResolvedValue(connection(server));
    await session().connect({ url: server.url, username: 'alice', password: 'secret', remember: true });
    expect(session().status).toBe('ready');

    sync.syncState.unauthorized = true;
    sync.syncState.running = false;
    // 触发一次订阅通知
    sync.setBackend(sync.getBackend());
    await flush();

    expect(session().status).toBe('need-login');
    expect(creds.clearPassword).toHaveBeenCalled();
  });

  it('恢复联网后清掉离线标记', async () => {
    store.useSessionStore.setState({ status: 'ready', offlineMode: true, sessionVerified: false });
    sync.syncState.online = true;
    sync.setBackend(sync.getBackend());
    await flush();
    expect(session().offlineMode).toBe(false);
  });
});

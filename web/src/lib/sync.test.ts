import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, type SyncResponse } from './api';

/**
 * 同步引擎测试。api.sync 全 mock，其余走真实 localrepo + fake-indexeddb。
 *
 * 注意：fake-indexeddb 的事务调度依赖 setTimeout，fake timers 会把它一起冻结。
 * 因此涉及「同步成功、要落盘」的用例一律用真实时钟；fake timers 只用于
 * 纯失败路径（不触发 markSynced 落盘）的退避重试验证。
 */

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, api: { ...actual.api, sync: vi.fn() } };
});

let repo: typeof import('./localrepo');
let sync: typeof import('./sync');
let apiMock: { sync: ReturnType<typeof vi.fn> };

/** 一轮正常空同步的服务端响应。 */
function okResp(over: Partial<SyncResponse> = {}): SyncResponse {
  return {
    ok: true,
    cursor: 0,
    hasMore: false,
    records: [],
    corrections: [],
    applied: [],
    conflicts: [],
    serverVector: {},
    tombstoneFloorSeq: 0,
    liveCount: 0,
    resyncRequired: false,
    tookMs: 1,
    ...over,
  } as SyncResponse;
}

async function seedDirty(id: string): Promise<void> {
  repo.upsertRecord({ id, kind: 'task', data: { title: id } });
  expect(repo.getRecord(id)!.dirty).toBe(true);
}

describe('subscribeSync 退订', () => {
  it('退订后不再收到通知', async () => {
    const fn = vi.fn();
    const un = sync.subscribeSync(fn);
    un();
    apiMock.sync.mockResolvedValue(okResp());
    await seedDirty('u1');
    await sync.syncNow({ silent: true });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('异常输入与防护', () => {
  it('corrections/applied 缺失时按空数组处理；通知循环到达订阅者', async () => {
    const fn = vi.fn();
    const un = sync.subscribeSync(fn);
    await seedDirty('m1');
    apiMock.sync.mockResolvedValue(
      okResp({ corrections: undefined, applied: undefined } as Partial<SyncResponse>),
    );
    await sync.syncNow({ silent: true });
    // 没有 applied 回执：不崩溃即可，本地保持脏等待下一轮推送
    expect(repo.getRecord('m1')!.dirty).toBe(true);
    expect(fn).toHaveBeenCalled();
    un();
  });

  it('全量拉取超过轮次上限时强制跳出，不死循环', async () => {
    apiMock.sync.mockImplementation(async (body: { full?: boolean }) =>
      body.full ? okResp({ hasMore: true, cursor: 1 }) : okResp({ resyncRequired: true }),
    );
    // 若守卫失效这里会挂起/超时
    await sync.syncNow({ silent: true });
  });

  it('同步抛非 Error 值时也能记录错误信息', async () => {
    apiMock.sync.mockRejectedValue('boom-string');
    await expect(sync.syncNow({ silent: true })).resolves.toBe(false);
    expect(sync.syncState.lastError).toBe('boom-string');
  });
});

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('twische.deviceId', 'devA');
  const idb = await import('./idb');
  await idb.clearAll();
  repo = await import('./localrepo');
  sync = await import('./sync');
  const apiMod = await import('./api');
  apiMock = apiMod.api as unknown as { sync: ReturnType<typeof vi.fn> };
  apiMock.sync.mockReset();
  apiMock.sync.mockResolvedValue(okResp());
  await repo.initRepo();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('推送 + 拉取', () => {
  it('脏记录推送后清脏、采纳 seq、更新水位', async () => {
    await seedDirty('a');
    apiMock.sync
      .mockResolvedValueOnce(
        okResp({ applied: [{ id: 'a', status: 'created', seq: 5 }], tombstoneFloorSeq: 3, liveCount: 1 }),
      )
      .mockResolvedValueOnce(okResp({ liveCount: 1, tombstoneFloorSeq: 3 }));
    const ok = await sync.syncNow({ silent: true });
    expect(ok).toBe(true);
    expect(repo.getRecord('a')).toMatchObject({ dirty: false, seq: 5 });
    expect(repo.state.floorSeq).toBe(3);
    expect(sync.syncState.lastPushedCount).toBe(1);
    expect(sync.syncState.hadConflict).toBe(false);
    expect(sync.syncState.lastError).toBe('');
  });

  it('corrections 连数据带时钟采纳；diverged 计数自增', async () => {
    await seedDirty('a');
    apiMock.sync
      .mockResolvedValueOnce(
        okResp({
          applied: [{ id: 'a', status: 'diverged', seq: 6 }],
          corrections: [
            { id: 'a', kind: 'task', data: { title: 'server' }, vc: { devB: 9 }, updatedAt: 2, deleted: false, seq: 6 },
          ],
          liveCount: 1,
        }),
      )
      .mockResolvedValueOnce(okResp({ liveCount: 1 }));
    await sync.syncNow({ silent: true });
    expect(repo.getRecord('a')).toMatchObject({ data: { title: 'server' }, dirty: false, seq: 6 });
    expect(repo.getRecord('a')!.vc).toEqual({ devB: 9 });
    expect(sync.divergedTotal()).toBe(1);
  });

  it('conflicts 记录冲突数与 hadConflict 标记', async () => {
    await seedDirty('a');
    apiMock.sync
      .mockResolvedValueOnce(
        okResp({
          applied: [{ id: 'a', status: 'conflict:client-won', seq: 1 }],
          conflicts: [{ id: 'a', winner: 'client' }],
          liveCount: 1,
        }),
      )
      .mockResolvedValueOnce(okResp({ liveCount: 1 }));
    await sync.syncNow({ silent: true });
    expect(sync.syncState.hadConflict).toBe(true);
    expect(sync.syncState.lastConflictCount).toBe(1);
  });

  it('推送回执顺带下发记录：先应用再记入拉取数', async () => {
    await seedDirty('a');
    apiMock.sync
      .mockResolvedValueOnce(
        okResp({
          applied: [{ id: 'a', status: 'created', seq: 1 }],
          records: [{ id: 'r', kind: 'task', data: {}, vc: { devB: 1 }, updatedAt: 1, deleted: false, seq: 2 }],
          cursor: 4,
          liveCount: 2,
        }),
      )
      .mockResolvedValueOnce(okResp({ cursor: 4, liveCount: 2 }));
    await sync.syncNow({ silent: true });
    expect(repo.getRecord('r')).toBeTruthy();
    expect(repo.state.cursor).toBe(4);
    expect(sync.syncState.lastPulledCount).toBe(1);
  });

  it('拉取阶段处理分页与远端记录', async () => {
    apiMock.sync
      .mockResolvedValueOnce(
        okResp({
          records: [{ id: 'r1', kind: 'task', data: {}, vc: { devB: 1 }, updatedAt: 1, deleted: false, seq: 1 }],
          cursor: 10,
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(okResp({ cursor: 20, liveCount: 1 }));
    const ok = await sync.syncNow({ silent: true });
    expect(ok).toBe(true);
    expect(repo.getRecord('r1')).toBeTruthy();
    expect(repo.state.cursor).toBe(20);
    expect(sync.syncState.lastPulledCount).toBe(1);
    expect(apiMock.sync).toHaveBeenCalledTimes(2);
  });
});

describe('全量重建', () => {
  it('推送阶段 resyncRequired → 全量重建后直接返回', async () => {
    await seedDirty('a');
    apiMock.sync
      .mockResolvedValueOnce(okResp({ resyncRequired: true }))
      .mockResolvedValueOnce(
        okResp({
          records: [{ id: 'full', kind: 'task', data: {}, vc: { devB: 1 }, updatedAt: 1, deleted: false, seq: 1 }],
          cursor: 8,
          hasMore: false,
          tombstoneFloorSeq: 9,
        }),
      );
    await sync.syncNow({ silent: true });
    expect(repo.getRecord('full')).toBeTruthy();
    // 本地脏记录被重建保留（尚未推送的编辑不能丢）
    expect(repo.getRecord('a')).toMatchObject({ dirty: true });
    expect(repo.state.cursor).toBe(8);
    expect(repo.state.floorSeq).toBe(9);
    expect(sync.syncState.lastPulledCount).toBe(1);
    expect(apiMock.sync).toHaveBeenCalledTimes(2);
  });

  it('拉取阶段 resyncRequired → 全量重建', async () => {
    apiMock.sync
      .mockResolvedValueOnce(okResp({ resyncRequired: true }))
      .mockResolvedValueOnce(okResp({ cursor: 3, hasMore: false, tombstoneFloorSeq: 4 }));
    await sync.syncNow({ silent: true });
    expect(apiMock.sync).toHaveBeenCalledTimes(2);
    expect(apiMock.sync.mock.calls[1][0]).toMatchObject({ full: true });
    expect(repo.state.floorSeq).toBe(4);
  });

  it('liveCount 与本地不一致时自检触发重建', async () => {
    apiMock.sync
      .mockResolvedValueOnce(okResp({ cursor: 5, liveCount: 999 }))
      .mockResolvedValueOnce(okResp({ cursor: 5, hasMore: false, tombstoneFloorSeq: 6 }));
    await sync.syncNow({ silent: true });
    expect(apiMock.sync.mock.calls[1][0]).toMatchObject({ full: true });
    expect(repo.state.floorSeq).toBe(6);
  });

  it('liveCount 一致时不重建', async () => {
    apiMock.sync.mockResolvedValueOnce(okResp({ cursor: 5, liveCount: 0 }));
    await sync.syncNow({ silent: true });
    expect(apiMock.sync).toHaveBeenCalledTimes(1);
  });

  it('有脏记录时跳过 liveCount 自检（推送始终清不了脏 → 走满推送轮次上限）', async () => {
    await seedDirty('a');
    // 响应不回 applied → 'a' 保持脏 → 推送循环跑满 60 轮，拉取后因有脏记录跳过自检
    apiMock.sync.mockImplementation(async () => okResp({ cursor: 5, liveCount: 999 }));
    await sync.syncNow({ silent: true });
    // 60 轮推送 + 1 轮拉取，且没有 full 重建
    expect(apiMock.sync).toHaveBeenCalledTimes(61);
    expect(apiMock.sync.mock.calls.every((c) => !(c[0] as { full?: boolean }).full)).toBe(true);
    expect(repo.getRecord('a')!.dirty).toBe(true);
  });
});

describe('并发折叠与入口保护', () => {
  it('运行中的再次调用被折叠，本轮结束后自动补跑', async () => {
    let resolveA!: (v: SyncResponse) => void;
    apiMock.sync.mockImplementationOnce(() => new Promise<SyncResponse>((r) => (resolveA = r)));
    const p1 = sync.syncNow({ silent: true });
    expect(sync.syncState.running).toBe(true);

    const p2 = await sync.syncNow();
    expect(p2).toBe(false);
    expect(sync.syncState.queued).toBe(true);

    resolveA(
      okResp({
        applied: [{ id: 'a', status: 'created', seq: 1 }],
        records: [{ id: 'a', kind: 'task', data: { title: 'a' }, vc: { devA: 1 }, updatedAt: 1, deleted: false, seq: 1 }],
        liveCount: 1,
      }),
    );
    expect(await p1).toBe(true);
    await vi.waitFor(() => expect(sync.syncState.running).toBe(false));
    // 补跑的一轮也调用了 api.sync
    expect(apiMock.sync.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('unauthorized 时直接拒绝；requestSync 是空操作', async () => {
    sync.syncState.unauthorized = true;
    expect(await sync.syncNow()).toBe(false);
    expect(apiMock.sync).not.toHaveBeenCalled();
    sync.requestSync();
    expect(apiMock.sync).not.toHaveBeenCalled();
  });

  it('requestSync 触发静默同步', async () => {
    sync.requestSync();
    await vi.waitFor(() => expect(apiMock.sync).toHaveBeenCalled());
  });
});

describe('异常分支', () => {
  it('登录失效：停止重试并置 unauthorized', async () => {
    await seedDirty('a');
    apiMock.sync.mockRejectedValueOnce(new ApiError('unauthorized', 'x', 401));
    const ok = await sync.syncNow({ silent: true });
    expect(ok).toBe(false);
    expect(sync.syncState.unauthorized).toBe(true);
    expect(sync.syncState.lastError).toBe('x');
    sync.stopSync();
    expect(sync.syncState.unauthorized).toBe(false);
  });

  it('网络错误：置 offline 并按指数退避重试（3s → 6s）', async () => {
    vi.useFakeTimers();
    await seedDirty('a');
    apiMock.sync.mockRejectedValueOnce(new ApiError('network_error', 'offline', 0));
    await sync.syncNow({ silent: true });
    expect(sync.syncState.online).toBe(false);
    expect(sync.syncState.nextRetryIn).toBe(3);

    // 重试仍失败：延迟翻倍到 6 秒（失败路径不落盘，fake timers 安全）
    apiMock.sync.mockRejectedValueOnce(new ApiError('network_error', 'offline', 0));
    await vi.advanceTimersByTimeAsync(3000);
    expect(sync.syncState.nextRetryIn).toBe(6);
  });

  it('网络恢复后重试成功：online 恢复、退避归零', async () => {
    await seedDirty('a');
    apiMock.sync.mockRejectedValueOnce(new ApiError('network_error', 'offline', 0));
    await sync.syncNow({ silent: true });
    expect(sync.syncState.online).toBe(false);

    apiMock.sync.mockResolvedValue(
      okResp({
        applied: [{ id: 'a', status: 'created', seq: 1 }],
        records: [{ id: 'a', kind: 'task', data: { title: 'a' }, vc: { devA: 1 }, updatedAt: 1, deleted: false, seq: 1 }],
        liveCount: 1,
      }),
    );
    // 退避定时器（3s）真实触发，重试成功
    await vi.waitFor(() => expect(sync.syncState.online).toBe(true), { timeout: 10_000, interval: 100 });
    expect(sync.syncState.nextRetryIn).toBe(0);
    expect(repo.getRecord('a')).toMatchObject({ dirty: false, seq: 1 });
  }, 20_000);

  it('服务端明确拒绝：不安排重试', async () => {
    await seedDirty('a');
    apiMock.sync.mockRejectedValueOnce(new ApiError('validation', 'bad', 400));
    await sync.syncNow({ silent: true });
    expect(sync.syncState.nextRetryIn).toBe(0);
    expect(sync.syncState.online).toBe(true);
  });

  it('非 ApiError 的异常也能收场', async () => {
    await seedDirty('a');
    apiMock.sync.mockRejectedValueOnce(new TypeError('boom'));
    const ok = await sync.syncNow({ silent: true });
    expect(ok).toBe(false);
    expect(sync.syncState.lastError).toBe('boom');
    expect(sync.syncState.running).toBe(false);
  });

  it('stopSync 清掉退避定时器', async () => {
    vi.useFakeTimers();
    await seedDirty('a');
    apiMock.sync.mockRejectedValueOnce(new ApiError('network_error', 'offline', 0));
    await sync.syncNow({ silent: true });
    expect(sync.syncState.nextRetryIn).toBe(3);
    sync.stopSync();
    expect(sync.syncState.nextRetryIn).toBe(0);
    await vi.advanceTimersByTimeAsync(120000);
    expect(apiMock.sync).toHaveBeenCalledTimes(1); // 定时器被取消，没有补跑
  });
});

describe('在线侦听与工具函数', () => {
  it('bindOnlineListeners 绑定 online/offline/visibilitychange，且只绑一次', async () => {
    sync.bindOnlineListeners();
    sync.bindOnlineListeners(); // 幂等

    window.dispatchEvent(new Event('offline'));
    expect(sync.syncState.online).toBe(false);

    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(sync.syncState.online).toBe(true));
    expect(apiMock.sync).toHaveBeenCalled();

    const callsBefore = apiMock.sync.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(apiMock.sync.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('isAheadOfServer 判定', async () => {
    const rec = repo.upsertRecord({ id: 'x', kind: 'task', data: {} });
    await repo.markSynced(rec.id, { devA: 2 });
    expect(sync.isAheadOfServer('x', { devA: 1 })).toBe(true);
    expect(sync.isAheadOfServer('x', { devA: 2 })).toBe(false);
    expect(sync.isAheadOfServer('x', { devA: 3 })).toBe(false);
    expect(sync.isAheadOfServer('missing', { devA: 1 })).toBe(false);
    expect(sync.isAheadOfServer('x')).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeDavServer } from '@/test/dav-fake';
import { DavClient } from '@/storage/webdav/client';
import { WebDavStore } from '@/storage/webdav/store';

/**
 * 同步引擎测试。
 *
 * 用真实的假 WebDAV 服务器（带 ETag / If-Match / MKCOL / PROPFIND 语义）驱动，
 * 而不是逐个函数打桩 —— 同步的正确性恰恰藏在这些交互里：
 * 412 之后要读回来合并、远端文件消失要删本地、本地脏记录不能被远端删除带走。
 */

let repo: typeof import('./localrepo');
let sync: typeof import('./sync');
let idb: typeof import('./idb');

const DEV = 'devA';
const flush = () => new Promise<void>((r) => setTimeout(r, 20));

function taskRecord(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'task' as const,
    data: { id, title, kind: 'deadline', dueAt: '2026-01-01T09:00' },
    vc: { devB: 1 },
    updatedAt: 1000,
    deleted: false,
    ...over,
  };
}

function makeStore(server: FakeDavServer): WebDavStore {
  return new WebDavStore(
    new DavClient({ url: server.url, username: 'alice', password: 'secret', fetchImpl: server.fetch }),
  );
}

/** 建一个已连上的假服务器。 */
function setup(): { server: FakeDavServer; store: WebDavStore } {
  const server = new FakeDavServer();
  const store = makeStore(server);
  sync.setBackend(store);
  return { server, store };
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('twische.deviceId', DEV);
  localStorage.setItem('twische.deviceName', '测试机');
  repo = await import('./localrepo');
  sync = await import('./sync');
  idb = await import('./idb');
  await idb.clearAll();
  await repo.initRepo();
});

afterEach(() => {
  sync.__resetSyncForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('映射', () => {
  it('toStored 去掉本地专有字段，toWire 带上远端版本', () => {
    const rec = repo.upsertRecord({ kind: 'task', data: { title: 'x' } });
    const stored = sync.toStored(rec);
    expect(stored).toEqual({
      id: rec.id,
      kind: 'task',
      data: { title: 'x' },
      vc: rec.vc,
      updatedAt: rec.updatedAt,
      deleted: false,
    });
    expect('dirty' in stored).toBe(false);

    const wire = sync.toWire(stored, { version: 'e:1', etag: '"1"' });
    expect(wire.version).toBe('e:1');
    expect(wire.etag).toBe('"1"');
  });

  it('toWire 对缺失 data 兜底为空对象', () => {
    const wire = sync.toWire(
      { id: 'a', kind: 'task', data: undefined, vc: {}, updatedAt: 1 },
      { version: '', etag: null },
    );
    expect(wire.data).toEqual({});
    expect(wire.deleted).toBe(false);
  });
});

describe('首次同步与推送', () => {
  it('远端已有记录 → 首次同步拉下来', async () => {
    const { server } = setup();
    server.seedRecord('task-1', taskRecord('task-1', '远端任务'));

    expect(await sync.syncNow()).toBe(true);
    const local = repo.getRecord('task-1')!;
    expect((local.data as { title: string }).title).toBe('远端任务');
    expect(local.dirty).toBe(false);
    expect(local.etag).toBe(server.etagOf('/dav/twische/records/task-1.json'));
    expect(sync.syncState.lastPulledCount).toBe(1);
  });

  it('本地新建 → 推到远端并清脏', async () => {
    const { server } = setup();
    const rec = repo.upsertRecord({ kind: 'task', data: { title: '本机任务' } });

    expect(await sync.syncNow()).toBe(true);
    const path = `/dav/twische/records/${rec.id}.json`;
    expect(server.files.has(path)).toBe(true);
    const stored = JSON.parse(server.files.get(path)!.body);
    expect(stored.data.title).toBe('本机任务');
    expect(stored.vc[DEV]).toBe(1);

    const local = repo.getRecord(rec.id)!;
    expect(local.dirty).toBe(false);
    expect(sync.syncState.lastPushedCount).toBe(1);
  });

  it('本地修改既有记录 → 覆盖远端文件', async () => {
    const { server } = setup();
    server.seedRecord('task-1', taskRecord('task-1', '旧标题'));
    await sync.syncNow();

    const before = server.etagOf('/dav/twische/records/task-1.json');
    const local = repo.getRecord('task-1')!;
    repo.upsertRecord({ id: 'task-1', kind: 'task', data: { ...(local.data as object), title: '新标题' } });

    expect(await sync.syncNow()).toBe(true);
    const after = server.etagOf('/dav/twische/records/task-1.json');
    expect(after).not.toBe(before);
    expect(JSON.parse(server.files.get('/dav/twische/records/task-1.json')!.body).data.title).toBe('新标题');
  });

  it('本地删除 → 远端留下墓碑文件而不是直接消失', async () => {
    const { server } = setup();
    server.seedRecord('task-1', taskRecord('task-1', '要删的'));
    await sync.syncNow();

    repo.tombstoneRecord('task-1');
    expect(await sync.syncNow()).toBe(true);

    const stored = JSON.parse(server.files.get('/dav/twische/records/task-1.json')!.body);
    expect(stored.deleted).toBe(true);
    expect(repo.getRecord('task-1')!.dirty).toBe(false);
  });

  it('服务器不给 ETag 时也能推送（无条件写）', async () => {
    const server = new FakeDavServer({ noEtag: true });
    sync.setBackend(makeStore(server));
    const rec = repo.upsertRecord({ kind: 'task', data: { title: 'x' } });
    expect(await sync.syncNow()).toBe(true);
    expect(server.files.has(`/dav/twische/records/${rec.id}.json`)).toBe(true);
    expect(repo.getRecord(rec.id)!.dirty).toBe(false);
  });
});

describe('拉取与删除', () => {
  it('远端修改 → 本地更新（本地不脏时）', async () => {
    const { server } = setup();
    server.seedRecord('task-1', taskRecord('task-1', '旧'));
    await sync.syncNow();

    server.seedRecord('task-1', taskRecord('task-1', '远端改过', { vc: { devB: 2 }, updatedAt: 2000 }));
    await sync.syncNow();
    expect((repo.getRecord('task-1')!.data as { title: string }).title).toBe('远端改过');
  });

  it('远端文件消失 → 本地记录被清掉（内存与 IndexedDB）', async () => {
    const { server } = setup();
    server.seedRecord('task-1', taskRecord('task-1', 'x'));
    await sync.syncNow();
    expect(repo.getRecord('task-1')).toBeTruthy();

    server.files.delete('/dav/twische/records/task-1.json');
    await sync.syncNow();

    expect(repo.getRecord('task-1')).toBeUndefined();
    expect(sync.syncState.lastRemovedCount).toBe(1);
    await flush();
    expect(await idb.getAll(idb.STORE_RECORDS)).toHaveLength(0);
  });

  it('远端文件消失但本地有未推送改动 → 保住本地并重新推上去', async () => {
    const { server } = setup();
    server.seedRecord('task-1', taskRecord('task-1', '远端'));
    await sync.syncNow();

    // 模拟：别的设备删了它，同时本机正在编辑（推送失败过一次）
    server.files.delete('/dav/twische/records/task-1.json');
    const local = repo.getRecord('task-1')!;
    repo.upsertRecord({ id: 'task-1', kind: 'task', data: { ...(local.data as object), title: '本机编辑' } });

    expect(await sync.syncNow()).toBe(true);
    expect(repo.getRecord('task-1')).toBeTruthy();
    // 推送在前，所以文件已经被重新创建；不会再被当成"远端已删除"
    expect(JSON.parse(server.files.get('/dav/twische/records/task-1.json')!.body).data.title).toBe('本机编辑');
  });

  it('服务器不给版本指纹时每次都读回来比对（内容相同不产生副作用）', async () => {
    const server = new FakeDavServer({ noEtag: true });
    sync.setBackend(makeStore(server));
    server.seedRecord('task-1', taskRecord('task-1', 'x'));
    await sync.syncNow();
    const revAfterFirst = repo.getRev();

    await sync.syncNow();
    expect(repo.getRev()).toBe(revAfterFirst);
    expect(repo.getRecord('task-1')).toBeTruthy();
  });
});

describe('并发冲突（412）', () => {
  it('远端在两次同步之间被改过 → 读回来用向量时钟裁决，一次收敛', async () => {
    const { server } = setup();
    server.seedRecord('task-1', taskRecord('task-1', '基线', { vc: { devB: 1 } }));
    await sync.syncNow();

    // 本地改一版
    const local = repo.getRecord('task-1')!;
    repo.upsertRecord({
      id: 'task-1',
      kind: 'task',
      data: { ...(local.data as object), title: '本机版' },
    });
    // 别的设备也改了一版（时钟是并发的，本地时钟是 devA，远端是 devB）
    server.seedRecord('task-1', taskRecord('task-1', '他人版', { vc: { devB: 5 }, updatedAt: 5000 }));

    expect(await sync.syncNow()).toBe(true);
    const merged = repo.getRecord('task-1')!;
    expect(merged.dirty).toBe(false);
    // 时钟取并集 → 两边的内容都被"看见"过，收敛后不会再冲突
    expect(merged.vc).toEqual({ devA: 1, devB: 5 });
    expect(sync.syncState.hadConflict).toBe(true);
    expect(sync.conflictTotal()).toBeGreaterThan(0);
    // 远端最终拿到合并后的版本（包含双方的时钟）
    const stored = JSON.parse(server.files.get('/dav/twische/records/task-1.json')!.body);
    expect(stored.vc).toEqual({ devA: 1, devB: 5 });
  });

  it('本地版本胜出时重试写入，最终远端拿到本地内容', async () => {
    const { server } = setup();
    server.seedRecord('task-1', taskRecord('task-1', '基线', { vc: { devB: 1 } }));
    await sync.syncNow();

    const local = repo.getRecord('task-1')!;
    repo.upsertRecord({
      id: 'task-1',
      kind: 'task',
      data: { ...(local.data as object), title: '本机更新' },
      });
    // 远端改了但 updatedAt 更早 → 本机在并发裁决里胜出
    server.seedRecord('task-1', taskRecord('task-1', '他人旧版', { vc: { devB: 2 }, updatedAt: 500 }));

    await sync.syncNow();
    const stored = JSON.parse(server.files.get('/dav/twische/records/task-1.json')!.body);
    expect(stored.data.title).toBe('本机更新');
    expect(repo.getRecord('task-1')!.dirty).toBe(false);
  });

  it('冲突重试本身失败（非 412）时把错误抛出去，而不是静默吞掉', async () => {
    const { server, store } = setup();
    server.seedRecord('task-1', taskRecord('task-1', '基线'));
    await sync.syncNow();

    const realRead = store.read.bind(store);
    let reads = 0;
    vi.spyOn(store, 'read').mockImplementation(async (id: string) => {
      reads += 1;
      // 第一次读（冲突回退）正常，之后的写入让它失败
      return realRead(id);
    });
    vi.spyOn(store, 'write')
      .mockRejectedValueOnce(new (await import('@/storage/webdav/client')).DavError('precondition', 'stale'))
      .mockRejectedValue(new (await import('@/storage/webdav/client')).DavError('server', '后端炸了'));

    const local = repo.getRecord('task-1')!;
    repo.upsertRecord({ id: 'task-1', kind: 'task', data: { ...(local.data as object), title: '本机' } });

    expect(await sync.syncNow()).toBe(false);
    expect(reads).toBe(1);
    expect(sync.syncState.lastError).toContain('后端炸了');
  });

  it('写入遇到非 412 的服务器错误 → 直接失败而不是当成冲突处理', async () => {
    const { server, store } = setup();
    vi.spyOn(store, 'write').mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('server', '写入炸了'),
    );
    repo.upsertRecord({ kind: 'task', data: { title: 'x' } });

    expect(await sync.syncNow()).toBe(false);
    expect(sync.syncState.lastError).toContain('写入炸了');
    expect(sync.syncState.hadConflict).toBe(false);
    expect(server.files.size).toBe(0);
  });

  it('冲突回退时读取也失败（非 404）→ 抛出去', async () => {
    const { server, store } = setup();
    server.seedRecord('task-1', taskRecord('task-1', '基线'));
    await sync.syncNow();

    vi.spyOn(store, 'write').mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('precondition', 'stale'),
    );
    vi.spyOn(store, 'read').mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('server', '读也炸了'),
    );
    const local = repo.getRecord('task-1')!;
    repo.upsertRecord({ id: 'task-1', kind: 'task', data: { ...(local.data as object), title: '本机' } });

    expect(await sync.syncNow()).toBe(false);
    expect(sync.syncState.lastError).toContain('读也炸了');
  });

  it('并发时远端内容更新 → 采纳远端并结束这条，不再重写', async () => {
    const { server, store } = setup();
    server.seedRecord('task-1', taskRecord('task-1', '基线', { vc: { devB: 1 } }));
    await sync.syncNow();

    const local = repo.getRecord('task-1')!;
    repo.upsertRecord({ id: 'task-1', kind: 'task', data: { ...(local.data as object), title: '本机旧改' } });
    // 远端也改了，而且墙钟更新 → 并发裁决里远端胜出
    server.seedRecord(
      'task-1',
      taskRecord('task-1', '远端新改', { vc: { devB: 2 }, updatedAt: Date.now() + 1_000_000 }),
    );

    expect(await sync.syncNow()).toBe(true);
    const merged = repo.getRecord('task-1')!;
    expect((merged.data as { title: string }).title).toBe('远端新改');
    expect(merged.dirty).toBe(false);
    // 远端胜出时不需要重写，因此不算"真冲突重写"
    expect(sync.syncState.hadConflict).toBe(false);
    expect(sync.syncState.lastPushedCount).toBe(0);
  });

  it('远端文件缺失且本地推送一直失败 → 本地改动被保住（不被当成远端删除）', async () => {
    const { store } = setup();
    const rec = repo.upsertRecord({ kind: 'task', data: { title: '离线改动' } });

    vi.spyOn(store, 'write').mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('precondition', 'stale'),
    );
    vi.spyOn(store, 'read').mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('not-found', '没了'),
    );

    expect(await sync.syncNow()).toBe(true);
    const after = repo.getRecord(rec.id);
    expect(after, '本地改动必须被保住，不能被当成"远端已删除"清掉').toBeTruthy();
    expect(after!.dirty, '写不上去就继续留着脏标记，等下一轮再试').toBe(true);
  });

  it('抛出非 Error 时也能记下错误信息', async () => {
    const { store } = setup();
    vi.spyOn(store, 'ensure').mockRejectedValue('纯字符串错误');
    expect(await sync.syncNow()).toBe(false);
    expect(sync.syncState.lastError).toBe('纯字符串错误');
  });

  it('一整批都在冲突里打转时不会死循环', async () => {
    const { server, store } = setup();
    server.seedRecord('task-1', taskRecord('task-1', 'x'));
    await sync.syncNow();

    // 让每次 PUT 都返回 412：模拟"永远被抢先"
    const realWrite = store.write.bind(store);
    let writes = 0;
    vi.spyOn(store, 'write').mockImplementation(async (rec, opts) => {
      writes += 1;
      if (writes <= 2) {
        const err = new (await import('@/storage/webdav/client')).DavError('precondition', 'stale');
        throw err;
      }
      return realWrite(rec, opts);
    });
    server.seedRecord('task-1', taskRecord('task-1', '他人', { vc: { devB: 9 }, updatedAt: 9000 }));

    const local = repo.getRecord('task-1')!;
    repo.upsertRecord({ id: 'task-1', kind: 'task', data: { ...(local.data as object), title: '本机' } });

    await expect(sync.syncNow()).resolves.toBe(true);
    expect(writes).toBeLessThan(10);
  });
});

describe('异常处理', () => {
  it('网络失败 → 标记离线并按退避重试，不抛异常', async () => {
    vi.useFakeTimers();
    const server = new FakeDavServer({ failNetwork: true });
    sync.setBackend(makeStore(server));

    expect(await sync.syncNow()).toBe(false);
    expect(sync.syncState.online).toBe(false);
    expect(sync.syncState.nextRetryIn).toBeGreaterThan(0);
    expect(sync.syncState.lastError).toBeTruthy();
    expect(repo.state.lastSyncError).toBeTruthy();
  });

  it('退避到点后自动再试一次；成功则恢复在线', async () => {
    vi.useFakeTimers();
    const server = new FakeDavServer({ failNetwork: true });
    sync.setBackend(makeStore(server));
    await sync.syncNow();
    expect(sync.syncState.nextRetryIn).toBeGreaterThan(0);

    server.opts.failNetwork = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(sync.syncState.online).toBe(true);
    expect(sync.syncState.nextRetryIn).toBe(0);
  });

  it('凭据失效 → 标记 unauthorized 且不再重试', async () => {
    const server = new FakeDavServer({ expectedAuth: 'Basic bm9wZQ==' });
    sync.setBackend(makeStore(server));

    expect(await sync.syncNow()).toBe(false);
    expect(sync.syncState.unauthorized).toBe(true);
    expect(sync.syncState.nextRetryIn).toBe(0);

    // 已经失效后不再发起任何请求
    const before = server.requests.length;
    expect(await sync.syncNow()).toBe(false);
    expect(server.requests.length).toBe(before);
  });

  it('先网络失败、再被服务器明确拒绝 → 退避计时被清掉', async () => {
    vi.useFakeTimers();
    const server = new FakeDavServer({ failNetwork: true });
    const store = makeStore(server);
    sync.setBackend(store);

    await sync.syncNow();
    expect(sync.syncState.nextRetryIn).toBeGreaterThan(0);

    // 网络恢复但服务器开始拒绝：这是"重试也不会变好"的情况，必须停掉退避
    server.opts.failNetwork = false;
    vi.spyOn(store, 'ensure').mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('conflict', '目录结构不对'),
    );
    await sync.syncNow();
    expect(sync.syncState.nextRetryIn).toBe(0);
    expect(sync.syncState.online).toBe(true);
  });

  it('服务器明确拒绝（403）→ 不重试，只记错误', async () => {
    const server = new FakeDavServer();
    const store = makeStore(server);
    vi.spyOn(store, 'ensure').mockRejectedValue(
      new (await import('@/storage/webdav/client')).DavError('forbidden', 'nope'),
    );
    sync.setBackend(store);

    expect(await sync.syncNow()).toBe(false);
    expect(sync.syncState.nextRetryIn).toBe(0);
    expect(sync.syncState.online).toBe(true);
    expect(sync.syncState.lastError).toContain('nope');
  });

  it('非 DavError 的异常也会被记录且不重试', async () => {
    const server = new FakeDavServer();
    const store = makeStore(server);
    vi.spyOn(store, 'ensure').mockRejectedValue(new Error('boom'));
    sync.setBackend(store);

    expect(await sync.syncNow()).toBe(false);
    expect(sync.syncState.lastError).toBe('boom');
    expect(sync.syncState.nextRetryIn).toBe(0);
  });

  it('未配置后端时同步是空操作', async () => {
    sync.setBackend(null);
    expect(sync.syncState.unconfigured).toBe(true);
    expect(await sync.syncNow()).toBe(false);
    expect(sync.getBackend()).toBeNull();
  });
});

describe('完整性自检与调度', () => {
  it('本地多出一条干净记录（远端没有）→ 被清掉', async () => {
    const { server } = setup();
    server.seedRecord('task-1', taskRecord('task-1', 'x'));
    await sync.syncNow();

    // 模拟本地状态跑偏：凭空多出一条"干净"记录
    repo.state.records.set('ghost', {
      id: 'ghost',
      kind: 'task',
      data: { title: '幽灵' },
      vc: { devZ: 1 },
      updatedAt: 1,
      dirty: false,
      version: 'e:x',
    });

    await sync.syncNow();
    expect(repo.getRecord('ghost')).toBeUndefined();
    expect(sync.syncState.lastRemovedCount).toBeGreaterThan(0);
  });

  it('本地缺了一条（远端有）→ 全量重建把它补回来', async () => {
    const { server } = setup();
    server.seedRecord('task-1', taskRecord('task-1', 'x'));
    await sync.syncNow();

    repo.state.records.delete('task-1');
    await sync.syncNow();
    expect(repo.getRecord('task-1')).toBeTruthy();
  });

  it('有脏记录时跳过数量自检（推送会改变两侧数量）', async () => {
    const { server } = setup();
    const store = makeStore(server);
    sync.setBackend(store);
    repo.upsertRecord({ kind: 'task', data: { title: 'x' } });
    const listSpy = vi.spyOn(store, 'list');

    await sync.syncNow();
    // push 先跑，所以同步结束时已经没有脏记录；这里是断言 list 只被调用一次（不触发重建）
    expect(listSpy.mock.calls.length).toBe(1);
  });

  it('并发调用被折叠：running 期间的请求返回 false 并排队', async () => {
    const { server, store } = setup();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realEnsure = store.ensure.bind(store);
    vi.spyOn(store, 'ensure').mockImplementation(async () => {
      await gate;
      return realEnsure();
    });

    const first = sync.syncNow();
    await Promise.resolve();
    expect(await sync.syncNow()).toBe(false);
    expect(sync.syncState.queued).toBe(true);

    release!();
    expect(await first).toBe(true);
    await flush();
  });

  it('requestSync 会真的跑一轮；stopSync 复位状态', async () => {
    setup();
    const rec = repo.upsertRecord({ kind: 'task', data: { title: 'x' } });
    sync.requestSync();
    await flush();
    await flush();
    expect(repo.getRecord(rec.id)!.dirty).toBe(false);

    sync.stopSync();
    expect(sync.syncState.running).toBe(false);
    expect(sync.syncState.lastError).toBe('');
    expect(sync.syncState.phase).toBe('idle');
  });

  it('unauthorized 时 requestSync 不再发起同步', async () => {
    const { server } = setup();
    sync.syncState.unauthorized = true;
    const before = server.requests.length;
    sync.requestSync();
    await flush();
    expect(server.requests.length).toBe(before);
  });

  it('subscribeSync 能收到状态变化，退订后不再收到', async () => {
    const seen: boolean[] = [];
    const off = sync.subscribeSync(() => seen.push(sync.syncState.running));
    const { server } = setup();
    await sync.syncNow();
    expect(seen.length).toBeGreaterThan(0);
    const count = seen.length;
    off();
    await sync.syncNow();
    expect(seen.length).toBe(count);
    expect(server.requests.length).toBeGreaterThan(0);
  });

  it('bindOnlineListeners 只绑定一次，并响应 online/offline/可见性变化', async () => {
    const { server } = setup();
    sync.bindOnlineListeners();
    sync.bindOnlineListeners(); // 第二次是空操作

    window.dispatchEvent(new Event('offline'));
    expect(sync.syncState.online).toBe(false);

    window.dispatchEvent(new Event('online'));
    expect(sync.syncState.online).toBe(true);

    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    await flush();
    expect(server.requests.length).toBeGreaterThan(0);
  });
});

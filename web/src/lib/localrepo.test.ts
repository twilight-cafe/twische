import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vcCompare, vcIncrement } from '@shared/vector.js';

/**
 * 本地仓库测试。
 *
 * 收敛策略（applyRemoteRecord 的五个分支）是整个同步协议的客户端半边，
 * 必须与服务端语义严格一致；这里逐分支验证。
 */

let repo: typeof import('./localrepo');
let idb: typeof import('./idb');
const DEV = 'devA';

/** 等待 putMany 等后台落盘完成。 */
const flush = () => new Promise<void>((r) => setTimeout(r, 30));

function makeRemote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    kind: 'task' as const,
    data: { title: 'remote' },
    vc: { devB: 1 },
    updatedAt: 1000,
    deleted: false,
    seq: 3,
    ...overrides,
  };
}

function seedLocal(id: string, vc: Record<string, number>, overrides: Record<string, unknown> = {}) {
  repo.state.records.set(id, {
    id,
    kind: 'task',
    data: { title: 'local' },
    vc,
    updatedAt: 1000,
    dirty: false,
    seq: 5,
    ...overrides,
  } as import('./localrepo').LocalRecord);
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('twische.deviceId', DEV);
  localStorage.setItem('twische.deviceName', '测试机');
  repo = await import('./localrepo');
  idb = await import('./idb');
  await idb.clearAll();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('订阅与修订号', () => {
  it('写入推进 rev 并通知订阅者；退订后不再通知', async () => {
    await repo.initRepo();
    const seen: number[] = [];
    const un = repo.subscribe(() => seen.push(repo.getRev()));
    repo.upsertRecord({ kind: 'task', data: { title: 'a' } });
    un();
    repo.upsertRecord({ kind: 'task', data: { title: 'b' } });
    // initRepo 结束时已 bump 到 1，第一次 upsert 后是 2
    expect(seen).toEqual([2]);
  });
});

describe('设备身份', () => {
  async function bootWithUA(ua: string): Promise<string> {
    vi.resetModules();
    localStorage.clear();
    Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
    const mod = await import('./localrepo');
    await mod.initRepo();
    return mod.state.deviceName;
  }

  it('各平台 UA 的识别', async () => {
    expect(await bootWithUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('iPhone');
    expect(await bootWithUA('Mozilla/5.0 (iPad; CPU OS 16_0)')).toBe('iPad');
    expect(await bootWithUA('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit')).toBe('Pixel 8');
    expect(await bootWithUA('Mozilla/5.0 (Linux; Android 14) AppleWebKit')).toBe('Android 设备');
    expect(await bootWithUA('Mozilla/5.0 (Macintosh; Intel Mac)')).toBe('Mac');
    expect(await bootWithUA('Mozilla/5.0 (Windows NT 10.0)')).toBe('Windows 电脑');
    expect(await bootWithUA('Mozilla/5.0 (X11; Linux)')).toBe('Linux 电脑');
    expect(await bootWithUA('curl/8.0')).toBe('浏览器');
    // Android 设备名超长截断到 40 字符
    const longName = 'X'.repeat(60);
    expect(await bootWithUA(`Mozilla/5.0 (Linux; Android 14; ${longName})`)).toHaveLength(40);
  });

  it('localStorage 不可用时设备 id 与名称降级', async () => {
    // UA 覆盖会在用例间泄漏，先归位成一个无平台关键字的 UA
    Object.defineProperty(window.navigator, 'userAgent', { value: 'curl/8.0', configurable: true });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await repo.initRepo();
    expect(repo.state.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(repo.state.deviceName).toBe('浏览器');
  });

  it('localStorage 有设备名时优先使用', async () => {
    localStorage.setItem('twische.deviceName', '自定义名');
    await repo.initRepo();
    expect(repo.state.deviceName).toBe('自定义名');
  });

  it('setDeviceName 更新状态并持久化；写入失败不崩溃', async () => {
    await repo.initRepo();
    repo.setDeviceName('新名字');
    expect(repo.state.deviceName).toBe('新名字');
    expect(localStorage.getItem('twische.deviceName')).toBe('新名字');

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => repo.setDeviceName('存不进去')).not.toThrow();
    expect(repo.state.deviceName).toBe('存不进去');
  });

  it('设备 id 首次生成后写回 localStorage', async () => {
    localStorage.removeItem('twische.deviceId');
    await repo.initRepo();
    expect(localStorage.getItem('twische.deviceId')).toBe(repo.state.deviceId);
  });
});

describe('localPrefs', () => {
  it('set/get 往返；缺失时回退', () => {
    expect(repo.localPrefs.get('theme', 'auto')).toBe('auto');
    repo.localPrefs.set('theme', 'dark');
    expect(repo.localPrefs.get('theme', 'auto')).toBe('dark');
  });

  it('损坏的 JSON 回退默认值', () => {
    localStorage.setItem('twische.pref.bad', '{not json');
    expect(repo.localPrefs.get('bad', 'fb')).toBe('fb');
  });

  it('localStorage 抛错时静默回退', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(repo.localPrefs.get('x', 1)).toBe(1);
    expect(() => repo.localPrefs.set('x', 2)).not.toThrow();
  });
});

describe('initRepo', () => {
  it('加载记录与 meta；重复调用是空操作', async () => {
    await idb.putMany(idb.STORE_RECORDS, [
      { id: 'a', kind: 'task', data: {}, vc: { [DEV]: 1 }, updatedAt: 1, dirty: true },
    ]);
    await idb.putMany(idb.STORE_META, [
      { key: 'cursor', value: 12 },
      { key: 'floorSeq', value: 4 },
      { key: 'lastSyncAt', value: 99 },
    ]);
    await repo.initRepo();
    expect(repo.state.ready).toBe(true);
    expect(repo.allRecords().map((r) => r.id)).toEqual(['a']);
    expect(repo.state.cursor).toBe(12);
    expect(repo.state.floorSeq).toBe(4);
    expect(repo.state.lastSyncAt).toBe(99);

    await repo.initRepo(); // 第二次直接返回
    expect(repo.getRev()).toBe(1);
  });

  it('本地库读取失败降级为内存模式', async () => {
    // openDb 会缓存连接：resetModules 换一套新模块实例，再让 indexedDB 不可用
    vi.resetModules();
    repo = await import('./localrepo');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('indexedDB', undefined);
    await repo.initRepo();
    expect(repo.state.ready).toBe(true);
    expect(repo.allRecords()).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[twische] 本地库读取失败，将以内存模式运行', expect.anything());
  });

  it('meta 读取失败时使用默认值', async () => {
    let calls = 0;
    vi.stubGlobal('indexedDB', {
      open: () => {
        const req: Record<string, unknown> = {};
        setTimeout(() => {
          req.result = {
            transaction: () => ({
              objectStore: () => ({
                getAll: () => {
                  calls += 1;
                  const r: Record<string, unknown> = {};
                  setTimeout(() => {
                    if (calls === 1) {
                      r.result = [];
                      r.onsuccess?.();
                    } else {
                      r.error = new Error('meta boom');
                      r.onerror?.();
                    }
                  }, 0);
                  return r;
                },
              }),
            }),
          };
          req.onsuccess?.();
        }, 0);
        return req;
      },
    });
    await repo.initRepo();
    expect(repo.state.ready).toBe(true);
    expect(repo.state.cursor).toBe(0);
    expect(repo.state.floorSeq).toBe(0);
  });
});

describe('meta 写入', () => {
  it('setCursor / setLastSyncAt / setFloorSeq 更新状态并落盘；setSyncError 只改内存', async () => {
    await repo.initRepo();
    repo.setCursor(7);
    repo.setLastSyncAt(1234);
    repo.setFloorSeq(2);
    repo.setSyncError('oops');
    expect(repo.state.lastSyncError).toBe('oops');
    await flush();
    const metas = await idb.getAll<{ key: string; value: number }>(idb.STORE_META);
    const m = new Map(metas.map((x) => [x.key, x.value]));
    expect(m.get('cursor')).toBe(7);
    expect(m.get('lastSyncAt')).toBe(1234);
    expect(m.get('floorSeq')).toBe(2);
  });
});

describe('查询', () => {
  it('liveRecords / dirtyRecords / dirtyCount / localVector', async () => {
    await repo.initRepo();
    const keep = repo.upsertRecord({ kind: 'task', data: { title: 'keep' } });
    const gone = repo.upsertRecord({ kind: 'task', data: { title: 'gone' } });
    repo.upsertRecord({ kind: 'completion', data: { taskId: 'x' } });
    repo.tombstoneRecord(gone.id);
    // 模拟已同步的干净记录（墓碑本身也是脏的，一并清掉）
    repo.getRecord(keep.id)!.dirty = false;
    repo.getRecord(gone.id)!.dirty = false;

    expect(repo.allRecords()).toHaveLength(3);
    // 活记录 = 任务 keep + completion（tombstone 已剔除 gone）
    const liveIds = repo.liveRecords().map((r) => r.id).sort();
    expect(liveIds).toHaveLength(2);
    expect(liveIds).toContain(keep.id);
    expect(repo.liveRecords('task').map((r) => r.id)).toEqual([keep.id]);
    expect(repo.liveRecords('completion')).toHaveLength(1);
    expect(repo.dirtyCount()).toBe(1);
    expect(repo.dirtyRecords(1)).toHaveLength(1);
    // 时钟并集：keep 1 次 + gone 的墓碑又推 1 次
    expect(repo.localVector()).toEqual({ [DEV]: 2 });
  });

  it('dirtyRecords 的 limit 截断', async () => {
    await repo.initRepo();
    repo.upsertRecord({ kind: 'task', data: {} });
    repo.upsertRecord({ kind: 'task', data: {} });
    expect(repo.dirtyRecords()).toHaveLength(2);
    expect(repo.dirtyRecords(1)).toHaveLength(1);
  });
});

describe('upsertRecord / tombstoneRecord', () => {
  it('新建：生成 id、推进本设备时钟、深拷贝 data、落盘', async () => {
    await repo.initRepo();
    const input = { title: 'hello', tags: ['a'] };
    const rec = repo.upsertRecord({ kind: 'task', data: input });
    expect(rec.id).toBeTruthy();
    expect(rec.vc).toEqual({ [DEV]: 1 });
    expect(rec.dirty).toBe(true);
    expect(rec.deleted).toBe(false);

    // data 是副本：改输入不影响已落库记录
    input.tags.push('b');
    expect(rec.data).toEqual({ title: 'hello', tags: ['a'] });

    await flush();
    const stored = await idb.getOne<typeof rec>(idb.STORE_RECORDS, rec.id);
    expect(stored?.vc).toEqual({ [DEV]: 1 });
  });

  it('更新既有记录：时钟继续推进、seq 与 deleted 保留', async () => {
    await repo.initRepo();
    const first = repo.upsertRecord({ kind: 'task', data: { title: 'v1' } });
    repo.getRecord(first.id)!.seq = 9;
    const second = repo.upsertRecord({ id: first.id, kind: 'task', data: { title: 'v2' } });
    expect(second.vc).toEqual({ [DEV]: 2 });
    expect(second.seq).toBe(9);
  });

  it('墓碑：存在的记录打删除标记；不存在的返回 false', async () => {
    await repo.initRepo();
    const rec = repo.upsertRecord({ kind: 'task', data: { title: 'x' } });
    expect(repo.tombstoneRecord('nope')).toBe(false);
    expect(repo.tombstoneRecord(rec.id)).toBe(true);
    const tomb = repo.getRecord(rec.id)!;
    expect(tomb.deleted).toBe(true);
    expect(tomb.data).toEqual({});
    expect(tomb.dirty).toBe(true);
    expect(tomb.vc).toEqual({ [DEV]: 2 });
  });

  it('写入落盘失败只警告不崩溃', async () => {
    await repo.initRepo();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('indexedDB', undefined);
    // dbPromise 已缓存真实库，直接清掉模块缓存不现实；用新模块实例验证 persist 的 catch 分支
    vi.resetModules();
    const mod = await import('./localrepo');
    vi.stubGlobal('indexedDB', undefined);
    expect(() => mod.upsertRecord({ kind: 'task', data: {} })).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledWith('[twische] 写入本地库失败', expect.anything());
  });
});

describe('applyRemoteRecord 收敛策略', () => {
  beforeEach(async () => {
    await repo.initRepo();
  });

  it('本地不存在 → created', () => {
    expect(repo.applyRemoteRecord(makeRemote())).toBe('created');
    const r = repo.getRecord('r1')!;
    expect(r.dirty).toBe(false);
    expect(r.vc).toEqual({ devB: 1 });
    expect(r.seq).toBe(3);
  });

  it('远端缺 data 字段时兜底空对象', () => {
    expect(repo.applyRemoteRecord(makeRemote({ data: undefined }))).toBe('created');
    expect(repo.getRecord('r1')!.data).toEqual({});
  });

  it('时钟相等 → unchanged，仅同步 seq', () => {
    seedLocal('r1', { devB: 1 }, { seq: 1 });
    expect(repo.applyRemoteRecord(makeRemote({ vc: { devB: 1 }, seq: 8 }))).toBe('unchanged');
    expect(repo.getRecord('r1')!.seq).toBe(8);
  });

  it('远端支配 → updated，采纳远端并清脏', () => {
    seedLocal('r1', { devB: 1 });
    expect(repo.applyRemoteRecord(makeRemote({ vc: { devB: 2 } }))).toBe('updated');
    const r = repo.getRecord('r1')!;
    expect(r.data).toEqual({ title: 'remote' });
    expect(r.dirty).toBe(false);
    expect(vcCompare(r.vc, { devB: 2 })).toBe('equal');
  });

  it('本地支配 → kept-local，只记 seq', () => {
    seedLocal('r1', { devB: 5, [DEV]: 1 });
    expect(repo.applyRemoteRecord(makeRemote({ vc: { devB: 2 }, seq: 3 }))).toBe('kept-local');
    const r = repo.getRecord('r1')!;
    expect(r.data).toEqual({ title: 'local' });
    expect(r.seq).toBe(5);
    expect(r.dirty).toBe(false);
  });

  it('并发且远端赢 → updated + 时钟取并集', () => {
    seedLocal('r1', { [DEV]: 1 }, { updatedAt: 100 });
    expect(repo.applyRemoteRecord(makeRemote({ vc: { devB: 1 }, updatedAt: 200 }))).toBe('updated');
    const r = repo.getRecord('r1')!;
    expect(r.data).toEqual({ title: 'remote' });
    expect(r.vc).toEqual({ [DEV]: 1, devB: 1 });
    expect(r.dirty).toBe(false);
  });

  it('并发且本地赢 → kept-local + 时钟升级为并集 + 保持脏', () => {
    seedLocal('r1', { [DEV]: 1 }, { updatedAt: 300, seq: 2 });
    expect(repo.applyRemoteRecord(makeRemote({ vc: { devB: 1 }, updatedAt: 200, seq: 4 }))).toBe('kept-local');
    const r = repo.getRecord('r1')!;
    expect(r.data).toEqual({ title: 'local' });
    expect(r.vc).toEqual({ [DEV]: 1, devB: 1 });
    expect(r.dirty).toBe(true);
    expect(r.seq).toBe(4);
  });

  // ── 字段缺省兜底：老版本服务端/客户端可能不带 data 或 seq ──

  it('远端支配且缺 data → 兜底空对象', () => {
    seedLocal('r1', { devB: 1 });
    expect(repo.applyRemoteRecord(makeRemote({ vc: { devB: 2 }, data: undefined }))).toBe('updated');
    expect(repo.getRecord('r1')!.data).toEqual({});
  });

  it('本地支配且远端缺 seq → 保留本地 seq', () => {
    seedLocal('r1', { devB: 5, [DEV]: 1 }, { seq: 7 });
    expect(repo.applyRemoteRecord(makeRemote({ vc: { devB: 2 }, seq: undefined }))).toBe('kept-local');
    expect(repo.getRecord('r1')!.seq).toBe(7);
  });

  it('本地支配且本地缺 seq → 取远端 seq', () => {
    seedLocal('r1', { devB: 5, [DEV]: 1 }, { seq: undefined });
    expect(repo.applyRemoteRecord(makeRemote({ vc: { devB: 2 }, seq: 4 }))).toBe('kept-local');
    expect(repo.getRecord('r1')!.seq).toBe(4);
  });

  it('并发远端赢且缺 data → 兜底空对象', () => {
    seedLocal('r1', { [DEV]: 1 }, { updatedAt: 100 });
    expect(
      repo.applyRemoteRecord(makeRemote({ vc: { devB: 1 }, updatedAt: 200, data: undefined })),
    ).toBe('updated');
    expect(repo.getRecord('r1')!.data).toEqual({});
  });

  it('并发本地赢且双方缺 seq → 归 0 并保持脏', () => {
    seedLocal('r1', { [DEV]: 1 }, { updatedAt: 300, seq: undefined });
    expect(
      repo.applyRemoteRecord(makeRemote({ vc: { devB: 1 }, updatedAt: 200, seq: undefined })),
    ).toBe('kept-local');
    const r = repo.getRecord('r1')!;
    expect(r.seq).toBe(0);
    expect(r.dirty).toBe(true);
  });

  it('adoptRemoteRecord：缺 data 时兜底空对象，且无条件清脏', () => {
    repo.adoptRemoteRecord(makeRemote({ data: undefined, vc: { devB: 9 } }));
    const r = repo.getRecord('r1')!;
    expect(r.data).toEqual({});
    expect(r.vc).toEqual({ devB: 9 });
    expect(r.dirty).toBe(false);
  });
});

describe('applyRemoteBatch / markSynced / fullRebuild / wipeLocal', () => {
  beforeEach(async () => {
    await repo.initRepo();
  });

  it('批量应用并落盘', async () => {
    await repo.applyRemoteBatch([
      makeRemote({ id: 'a' }),
      makeRemote({ id: 'b', vc: { devC: 3 } }),
    ]);
    await flush();
    expect(repo.getRecord('a')).toBeTruthy();
    expect(repo.getRecord('b')!.vc).toEqual({ devC: 3 });
    const stored = await idb.getOne(idb.STORE_RECORDS, 'a');
    expect(stored).toBeTruthy();
  });

  it('markSynced：采纳服务端时钟与 seq、清脏；记录不存在时是空操作', async () => {
    const rec = repo.upsertRecord({ kind: 'task', data: {} });
    await repo.markSynced(rec.id, { [DEV]: 4 }, 11);
    expect(repo.getRecord(rec.id)).toMatchObject({ dirty: false, seq: 11 });
    expect(repo.getRecord(rec.id)!.vc).toEqual({ [DEV]: 4 });
    await expect(repo.markSynced('missing')).resolves.toBeUndefined();
  });

  it('markSynced 的 vc 做归一化（剔除非法分量）', async () => {
    const rec = repo.upsertRecord({ kind: 'task', data: {} });
    await repo.markSynced(rec.id, { [DEV]: 2, ghost: 0 });
    expect(repo.getRecord(rec.id)!.vc).toEqual({ [DEV]: 2 });
  });

  it('fullRebuild：删除集合外的干净记录，保留脏记录', async () => {
    const seenClean = repo.upsertRecord({ id: 'seen', kind: 'task', data: {} });
    await repo.markSynced(seenClean.id);
    const unseenDirty = repo.upsertRecord({ id: 'unseen-dirty', kind: 'task', data: {} });
    repo.upsertRecord({ id: 'unseen-clean', kind: 'task', data: {} });
    await repo.markSynced('unseen-clean');

    const out = await repo.fullRebuild([makeRemote({ id: 'seen' })]);
    expect(out.removed).toBe(1);
    expect(repo.getRecord('seen')).toBeTruthy();
    expect(repo.getRecord('unseen-dirty')).toBeTruthy();
    expect(repo.getRecord('unseen-clean')).toBeUndefined();
    expect(unseenDirty.dirty).toBe(true);
    await flush();
  });

  it('wipeLocal 清空（或保留脏记录）并重置游标', async () => {
    const a = repo.upsertRecord({ kind: 'task', data: {} });
    repo.setCursor(5);
    await repo.wipeLocal(false);
    expect(repo.getRecord(a.id)).toBeUndefined();
    expect(repo.state.cursor).toBe(0);
    expect(repo.state.floorSeq).toBe(0);
    await flush();
    expect(await idb.getAll(idb.STORE_RECORDS)).toEqual([]);

    const b = repo.upsertRecord({ kind: 'task', data: {} });
    const other = repo.upsertRecord({ kind: 'task', data: {} });
    repo.getRecord(b.id)!.dirty = false; // b 已同步 → 可清；other 仍脏 → 保留
    await repo.wipeLocal(true);
    expect(repo.allRecords().map((r) => r.id)).toEqual([other.id]);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vcCompare, vcIncrement } from '@/domain/vector.js';

/**
 * 本地仓库测试。
 *
 * 收敛策略（applyRemoteRecord 的各个分支）是整个同步协议的客户端半边，
 * 必须与旧服务端的语义严格一致；这里逐分支验证。
 * 与 v1 的差别：远端版本标识从 `seq` 换成了 `version` / `etag`（WebDAV 文件）。
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
    version: 'e:3',
    etag: '"3"',
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
    version: 'e:5',
    etag: '"5"',
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
    const seen: number[] = [];
    const off = repo.subscribe(() => seen.push(repo.getRev()));
    const before = repo.getRev();
    repo.upsertRecord({ kind: 'task', data: { title: 'a' } });
    expect(repo.getRev()).toBeGreaterThan(before);
    expect(seen.length).toBeGreaterThan(0);
    const count = seen.length;
    off();
    repo.upsertRecord({ kind: 'task', data: { title: 'b' } });
    expect(seen.length).toBe(count);
  });
});

describe('设备身份', () => {
  it('各平台 UA 的识别', async () => {
    const cases: Array<[string, string]> = [
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'iPhone'],
      ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'iPad'],
      ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit', 'Pixel 8'],
      // 带 Build/ 后缀的真实 UA 会连版本号一起截下来 —— v1 行为如此，保持一致
      ['Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UP1A) AppleWebKit', 'Pixel 8 Build/UP1A'],
      ['Mozilla/5.0 (Linux; Android 14) AppleWebKit', 'Android 设备'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Mac'],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Windows 电脑'],
      ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux 电脑'],
      ['something else', '浏览器'],
    ];
    for (const [ua, expected] of cases) {
      vi.resetModules();
      localStorage.clear();
      vi.stubGlobal('navigator', { userAgent: ua });
      const fresh = await import('./localrepo');
      await fresh.initRepo();
      expect(fresh.state.deviceName, ua).toBe(expected);
    }
  });

  it('localStorage 不可用时设备 id 与名称降级', async () => {
    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    });
    const fresh = await import('./localrepo');
    await fresh.initRepo();
    expect(fresh.state.deviceId.length).toBeGreaterThan(8);
    expect(fresh.state.deviceName.length).toBeGreaterThan(0);
  });

  it('localStorage 有设备名时优先使用', async () => {
    vi.resetModules();
    localStorage.setItem('twische.deviceName', '我的笔记本');
    const fresh = await import('./localrepo');
    await fresh.initRepo();
    expect(fresh.state.deviceName).toBe('我的笔记本');
  });

  it('setDeviceName 更新状态并持久化；写入失败不崩溃', async () => {
    await repo.initRepo();
    repo.setDeviceName('新名字');
    expect(repo.state.deviceName).toBe('新名字');
    expect(localStorage.getItem('twische.deviceName')).toBe('新名字');

    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => repo.setDeviceName('再来')).not.toThrow();
    expect(repo.state.deviceName).toBe('再来');
    spy.mockRestore();
  });

  it('设备 id 首次生成后写回 localStorage', async () => {
    vi.resetModules();
    localStorage.clear();
    const fresh = await import('./localrepo');
    await fresh.initRepo();
    expect(localStorage.getItem('twische.deviceId')).toBe(fresh.state.deviceId);
  });
});

describe('localPrefs', () => {
  it('set/get 往返；缺失时回退', () => {
    expect(repo.localPrefs.get('nope', 'fallback')).toBe('fallback');
    repo.localPrefs.set('theme', 'dark');
    expect(repo.localPrefs.get('theme', 'light')).toBe('dark');
  });

  it('损坏的 JSON 回退默认值', () => {
    localStorage.setItem('twische.pref.broken', '{oops');
    expect(repo.localPrefs.get('broken', 42)).toBe(42);
  });

  it('localStorage 抛错时静默回退', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(repo.localPrefs.get('x', 'd')).toBe('d');
    spy.mockRestore();

    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => repo.localPrefs.set('x', 1)).not.toThrow();
    setSpy.mockRestore();
  });
});

describe('initRepo', () => {
  it('加载记录与 meta；重复调用是空操作', async () => {
    await idb.putMany(idb.STORE_RECORDS, [
      { id: 'x', kind: 'task', data: { title: 'x' }, vc: { a: 1 }, updatedAt: 1 },
    ]);
    await idb.putMany(idb.STORE_META, [{ key: 'lastSyncAt', value: 12345 }]);
    await repo.initRepo();
    expect(repo.getRecord('x')).toBeTruthy();
    expect(repo.state.lastSyncAt).toBe(12345);

    const revBefore = repo.getRev();
    await repo.initRepo();
    expect(repo.getRev()).toBe(revBefore);
  });

  it('本地库读取失败降级为内存模式', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();
    repo = await import('./localrepo');
    idb = await import('./idb');
    const spy = vi.spyOn(idb, 'getAll').mockRejectedValue(new Error('boom'));
    await expect(repo.initRepo()).resolves.toBeUndefined();
    expect(repo.state.ready).toBe(true);
    expect(warn).toHaveBeenCalled();
    spy.mockRestore();
    warn.mockRestore();
  });

  it('meta 读取失败时使用默认值', async () => {
    vi.resetModules();
    repo = await import('./localrepo');
    idb = await import('./idb');
    const real = idb.getAll;
    const spy = vi.spyOn(idb, 'getAll').mockImplementation((async (store: string) => {
      if (store === idb.STORE_META) throw new Error('no meta');
      return real(store as never);
    }) as typeof real);
    await repo.initRepo();
    expect(repo.state.lastSyncAt).toBe(0);
    spy.mockRestore();
  });
});

describe('meta 写入', () => {
  it('setLastSyncAt 更新状态并落盘；setSyncError 只改内存', async () => {
    await repo.initRepo();
    repo.setLastSyncAt(999);
    repo.setSyncError('错了');
    expect(repo.state.lastSyncAt).toBe(999);
    expect(repo.state.lastSyncError).toBe('错了');
    await flush();
    const rows = await idb.getAll<{ key: string; value: unknown }>(idb.STORE_META);
    expect(rows.find((r) => r.key === 'lastSyncAt')?.value).toBe(999);
    expect(rows.find((r) => r.key === 'lastSyncError')).toBeUndefined();
  });
});

describe('查询', () => {
  it('liveRecords / dirtyRecords / dirtyCount / localVector / knownDevices', () => {
    seedLocal('a', { devA: 2, devB: 1 });
    seedLocal('b', { devB: 3 }, { deleted: true });
    seedLocal('c', { devC: 5 }, { dirty: true, kind: 'completion' });

    expect(repo.allRecords().length).toBe(3);
    expect(repo.liveRecords().map((r) => r.id).sort()).toEqual(['a', 'c']);
    expect(repo.liveRecords('completion').map((r) => r.id)).toEqual(['c']);
    expect(repo.dirtyRecords().map((r) => r.id)).toEqual(['c']);
    expect(repo.dirtyCount()).toBe(1);
    expect(repo.localVector()).toEqual({ devA: 2, devB: 3, devC: 5 });
    expect(repo.knownDevices()).toEqual([
      { id: 'devC', counter: 5 },
      { id: 'devB', counter: 3 },
      { id: 'devA', counter: 2 },
    ]);
  });

  it('dirtyRecords 的 limit 截断', () => {
    for (let i = 0; i < 5; i++) seedLocal(`d${i}`, { devA: 1 }, { dirty: true });
    expect(repo.dirtyRecords(2).length).toBe(2);
  });
});

describe('upsertRecord / tombstoneRecord', () => {
  it('新建：生成 id、推进本设备时钟、深拷贝 data、落盘', async () => {
    await repo.initRepo();
    const draft = { title: '草稿', nested: { a: 1 } };
    const rec = repo.upsertRecord({ kind: 'task', data: draft });
    expect(rec.id).toBeTruthy();
    expect(rec.vc[DEV]).toBe(1);
    expect(rec.dirty).toBe(true);
    expect(rec.data).not.toBe(draft);
    draft.title = '改过了';
    expect((rec.data as { title: string }).title).toBe('草稿');

    await flush();
    expect(await idb.getAll(idb.STORE_RECORDS)).toHaveLength(1);
  });

  it('更新既有记录：时钟继续推进、version/etag 保留', async () => {
    await repo.initRepo();
    seedLocal('r1', { [DEV]: 4 }, { version: 'e:old', etag: '"old"', dirty: false });
    const next = repo.upsertRecord({ id: 'r1', kind: 'task', data: { title: 'new' } });
    expect(next.vc[DEV]).toBe(5);
    expect(next.version).toBe('e:old');
    expect(next.etag).toBe('"old"');
    expect(next.dirty).toBe(true);
  });

  it('墓碑：存在的记录打删除标记；不存在的返回 false', async () => {
    await repo.initRepo();
    seedLocal('r1', { [DEV]: 1 });
    expect(repo.tombstoneRecord('r1')).toBe(true);
    const r = repo.getRecord('r1')!;
    expect(r.deleted).toBe(true);
    expect(r.dirty).toBe(true);
    expect(r.data).toEqual({});
    expect(repo.tombstoneRecord('nope')).toBe(false);
  });

  it('写入落盘失败只警告不崩溃', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const spy = vi.spyOn(idb, 'putMany').mockRejectedValue(new Error('disk full'));
    expect(() => repo.upsertRecord({ kind: 'task', data: { title: 'x' } })).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    spy.mockRestore();
  });
});

describe('applyRemoteRecord 收敛策略', () => {
  it('本地不存在 → created，采纳远端版本与时钟', () => {
    expect(repo.applyRemoteRecord(makeRemote())).toBe('created');
    expect(repo.getRecord('r1')).toMatchObject({ dirty: false, version: 'e:3', etag: '"3"' });
  });

  it('远端缺 data / version 字段时兜底', () => {
    expect(repo.applyRemoteRecord(makeRemote({ data: undefined, version: undefined, etag: undefined }))).toBe(
      'created',
    );
    const r = repo.getRecord('r1')!;
    expect(r.data).toEqual({});
    expect(r.version).toBeNull();
    expect(r.etag).toBeNull();
  });

  it('时钟相等 → unchanged，只同步版本指纹（不改脏标记）', () => {
    seedLocal('r1', { devB: 1 }, { version: 'e:1' });
    expect(repo.applyRemoteRecord(makeRemote({ vc: { devB: 1 }, version: 'e:8' }))).toBe('unchanged');
    const r = repo.getRecord('r1')!;
    expect(r.version).toBe('e:8');
    expect(r.dirty).toBe(false);
  });

  it('远端支配 → updated，采纳远端并清脏', () => {
    seedLocal('r1', { devB: 1 }, { dirty: true });
    expect(repo.applyRemoteRecord(makeRemote({ vc: { devB: 2 }, data: { title: 'r' } }))).toBe('updated');
    const r = repo.getRecord('r1')!;
    expect(r.data).toEqual({ title: 'r' });
    expect(r.dirty).toBe(false);

    expect(repo.applyRemoteRecord(makeRemote({ id: 'r1', vc: { devB: 3 }, data: undefined }))).toBe('updated');
    expect(repo.getRecord('r1')!.data).toEqual({});
  });

  it('本地支配 → kept-local，保持脏并记下远端版本（下一轮 If-Match 要用）', () => {
    seedLocal('r1', { devB: 4, [DEV]: 1 }, { dirty: true, version: 'e:2' });
    expect(repo.applyRemoteRecord(makeRemote({ vc: { devB: 2 }, version: 'e:9' }))).toBe('kept-local');
    const r = repo.getRecord('r1')!;
    expect(r.data).toEqual({ title: 'local' });
    expect(r.dirty).toBe(true);
    expect(r.version).toBe('e:9');
  });

  it('并发且远端赢 → updated + 时钟取并集', () => {
    seedLocal('r1', { [DEV]: 1 }, { updatedAt: 100, dirty: true });
    expect(repo.applyRemoteRecord(makeRemote({ vc: { devB: 1 }, updatedAt: 200 }))).toBe('updated');
    const r = repo.getRecord('r1')!;
    expect(r.vc).toEqual({ [DEV]: 1, devB: 1 });
    expect(r.data).toEqual({ title: 'remote' });
    expect(r.dirty).toBe(false);
  });

  it('并发且本地赢 → kept-local + 时钟升级为并集 + 保持脏', () => {
    seedLocal('r1', { [DEV]: 1 }, { updatedAt: 300, dirty: true });
    expect(repo.applyRemoteRecord(makeRemote({ vc: { devB: 1 }, updatedAt: 200 }))).toBe('kept-local');
    const r = repo.getRecord('r1')!;
    expect(r.vc).toEqual({ [DEV]: 1, devB: 1 });
    expect(r.data).toEqual({ title: 'local' });
    expect(r.dirty).toBe(true);
    // 关键：并集时钟严格支配远端，下次推送是一条干净的支配关系更新，不会乒乓
    expect(vcCompare(r.vc, { devB: 1 })).toBe('dominates');
  });

  it('并发远端赢且缺 data → 兜底空对象', () => {
    seedLocal('r1', { [DEV]: 1 }, { updatedAt: 100 });
    expect(
      repo.applyRemoteRecord(makeRemote({ vc: { devB: 1 }, updatedAt: 200, data: undefined })),
    ).toBe('updated');
    expect(repo.getRecord('r1')!.data).toEqual({});
  });
});

describe('批量写入与清理', () => {
  it('applyRemoteBatch 批量应用并落盘', async () => {
    await repo.initRepo();
    await repo.applyRemoteBatch([makeRemote({ id: 'a' }), makeRemote({ id: 'b', vc: { devB: 2 } })]);
    expect(repo.allRecords().length).toBe(2);
    await flush();
    expect(await idb.getAll(idb.STORE_RECORDS)).toHaveLength(2);
  });

  it('markSynced：采纳版本指纹并清脏；记录不存在时是空操作', async () => {
    const rec = repo.upsertRecord({ kind: 'task', data: { title: 'x' } });
    await repo.markSynced(rec.id, { version: 'e:11', etag: '"11"' });
    expect(repo.getRecord(rec.id)).toMatchObject({ dirty: false, version: 'e:11', etag: '"11"' });

    await expect(repo.markSynced('nope')).resolves.toBeUndefined();

    await repo.markSynced(rec.id);
    expect(repo.getRecord(rec.id)!.version).toBe('e:11');
  });

  it('markSynced 传 null 版本时把指纹清空（服务器不给版本标识的场景）', async () => {
    const rec = repo.upsertRecord({ kind: 'task', data: { title: 'x' } });
    await repo.markSynced(rec.id, { version: null, etag: null });
    expect(repo.getRecord(rec.id)).toMatchObject({ version: null, etag: null });
  });

  it('fullRebuild：删除集合外的干净记录，保留脏记录', async () => {
    await repo.initRepo();
    seedLocal('gone', { devA: 1 });
    seedLocal('dirty', { devA: 1 }, { dirty: true });
    seedLocal('dirty-not-remote', { devA: 1 }, { dirty: true });
    await idb.putMany(idb.STORE_RECORDS, [repo.getRecord('gone'), repo.getRecord('dirty')]);

    const { removed } = await repo.fullRebuild([
      makeRemote({ id: 'kept' }),
      makeRemote({ id: 'dirty', vc: { devB: 2 } }),
    ]);
    expect(removed).toBe(1);
    expect(repo.getRecord('gone')).toBeUndefined();
    expect(repo.getRecord('dirty')).toBeTruthy();
    expect(repo.getRecord('kept')).toBeTruthy();
    // 两边都有的记录只做合并，不参与删除判定
    expect(repo.getRecord('dirty')!.dirty).toBe(false);
    // 远端没有但它还是脏的 → 保住（本地未推送的编辑不能被重建抹掉）
    expect(repo.getRecord('dirty-not-remote')).toBeTruthy();
    await flush();
    expect((await idb.getAll<{ id: string }>(idb.STORE_RECORDS)).map((r) => r.id).sort()).toEqual([
      'dirty',
      'kept',
    ]);
  });

  it('dropRecords 同时清内存与 IndexedDB', async () => {
    await repo.initRepo();
    seedLocal('a', { devA: 1 });
    await idb.putMany(idb.STORE_RECORDS, [repo.getRecord('a')]);
    await repo.dropRecords(['a', 'not-there']);
    expect(repo.getRecord('a')).toBeUndefined();
    await flush();
    expect(await idb.getAll(idb.STORE_RECORDS)).toHaveLength(0);
  });

  it('markAllDirty 把干净记录标脏（换服务器时防止本地数据被误删）', async () => {
    await repo.initRepo();
    seedLocal('a', { devA: 1 });
    seedLocal('b', { devA: 1 }, { dirty: true });
    expect(await repo.markAllDirty()).toBe(1);
    expect(repo.dirtyCount()).toBe(2);
    expect(await repo.markAllDirty()).toBe(0);
    expect(repo.dirtyCount()).toBe(2);
  });

  it('persistRecords 空数组直接返回；非空时落盘', async () => {
    await repo.initRepo();
    await expect(repo.persistRecords([])).resolves.toBeUndefined();
    const rec = repo.upsertRecord({ kind: 'task', data: { title: 'x' } });
    await repo.persistRecords([rec]);
    await flush();
    expect(await idb.getAll(idb.STORE_RECORDS)).toHaveLength(1);
  });

  it('wipeLocal 清空（或保留脏记录）', async () => {
    await repo.initRepo();
    seedLocal('clean', { devA: 1 });
    seedLocal('dirty', { devA: 1 }, { dirty: true });
    await repo.wipeLocal(true);
    expect(repo.getRecord('clean')).toBeUndefined();
    expect(repo.getRecord('dirty')).toBeTruthy();

    await repo.wipeLocal(false);
    expect(repo.allRecords()).toHaveLength(0);
    await flush();
    expect(await idb.getAll(idb.STORE_RECORDS)).toHaveLength(0);
  });

  it('vcIncrement / vcCompare 透出给调用方', () => {
    expect(repo.vcIncrement({ a: 1 }, 'a')).toEqual({ a: 2 });
    expect(repo.vcCompare({ a: 1 }, { a: 1 })).toBe('equal');
  });
});

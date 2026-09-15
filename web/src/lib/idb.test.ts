import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * idb 封装测试。
 *
 * 失败分支（打开失败 / onblocked / 事务中止）用全控制 mock；
 * 正常读写用 fake-indexeddb 走真实 IndexedDB 实现。
 * 每个用例前 resetModules，保证 dbPromise 缓存互不污染。
 */

let idb: typeof import('./idb');

beforeEach(async () => {
  vi.resetModules();
  idb = await import('./idb');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 让 indexedDB.open 返回一个可编程的假请求。 */
function stubOpen(trigger: (req: Record<string, unknown>) => void): void {
  vi.stubGlobal('indexedDB', {
    open: () => {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => trigger(req));
      return req;
    },
  });
}

/** 让 indexedDB.open 成功并拿到指定的 mock db。 */
function stubDb(db: unknown): void {
  stubOpen((req) => {
    req.result = db;
    req.onsuccess?.();
  });
}

const defer = (fn) => setTimeout(fn, 0);

function makeStore(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    put: vi.fn(() => ({})),
    delete: vi.fn(() => ({})),
    getAll: vi.fn(() => ({})),
    get: vi.fn(() => ({})),
    ...overrides,
  };
}

describe('openDb 失败分支', () => {
  it('环境不支持 IndexedDB 时拒绝', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(idb.openDb()).rejects.toThrow('当前环境不支持 IndexedDB');
  });

  it('open 请求出错时拒绝，且不缓存失败的 promise', async () => {
    stubOpen((req) => {
      req.error = new Error('db gone');
      req.onerror?.();
    });
    await expect(idb.openDb()).rejects.toThrow('db gone');
    // 第二次调用应重新尝试打开，而不是拿到同一个 rejection
    stubOpen((req) => {
      req.error = new Error('db gone again');
      req.onerror?.();
    });
    await expect(idb.openDb()).rejects.toThrow('db gone again');
  });

  it('open 被其它标签页阻塞时拒绝', async () => {
    stubOpen((req) => req.onblocked?.());
    await expect(idb.openDb()).rejects.toThrow('IndexedDB 被其它标签页阻塞');
  });

  it('open 请求出错且无 error 对象时使用默认文案', async () => {
    stubOpen((req) => req.onerror?.());
    await expect(idb.openDb()).rejects.toThrow('IndexedDB 打开失败');
  });
});

describe('事务失败分支（全控制 mock）', () => {
  it('tx：请求级错误向上传递', async () => {
    const store = makeStore();
    const t: Record<string, unknown> = { objectStore: () => store };
    stubDb({ transaction: () => t });
    store.getAll = vi.fn(() => {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        req.error = new Error('read failed');
        req.onerror?.();
      });
      return req;
    });
    await expect(idb.getAll('records')).rejects.toThrow('read failed');
  });

  it('tx：事务被中止且带错误对象', async () => {
    const req: Record<string, unknown> = {};
    const store = makeStore({ getAll: () => req });
    const t: Record<string, unknown> = { objectStore: () => store, error: new Error('quota') };
    stubDb({ transaction: () => t });
    const p = idb.getAll('records');
    defer(() => t.onabort?.());
    await expect(p).rejects.toThrow('quota');
  });

  it('tx：事务被中止且无错误对象时使用默认文案', async () => {
    const req: Record<string, unknown> = {};
    const store = makeStore({ getAll: () => req });
    const t: Record<string, unknown> = { objectStore: () => store };
    stubDb({ transaction: () => t });
    const p = idb.getAll('records');
    defer(() => t.onabort?.());
    await expect(p).rejects.toThrow('事务被中止');
  });

  it('tx：成功路径取回结果', async () => {
    const req: Record<string, unknown> = { result: [{ id: 'a' }] };
    const store = makeStore({ getAll: () => req });
    const t: Record<string, unknown> = { objectStore: () => store };
    stubDb({ transaction: () => t });
    defer(() => req.onsuccess?.());
    await expect(idb.getAll('records')).resolves.toEqual([{ id: 'a' }]);
  });

  it('getOne 取回单条', async () => {
    const req: Record<string, unknown> = { result: { id: 'a' } };
    const store = makeStore({ get: () => req });
    const t: Record<string, unknown> = { objectStore: () => store };
    stubDb({ transaction: () => t });
    defer(() => req.onsuccess?.());
    await expect(idb.getOne('records', 'a')).resolves.toEqual({ id: 'a' });
  });

  it('putMany：空数组直接返回，不开事务', async () => {
    await expect(idb.putMany('records', [])).resolves.toBeUndefined();
  });

  it('putMany：事务 onerror 拒绝', async () => {
    const store = makeStore();
    const t: Record<string, unknown> = { objectStore: () => store, error: new Error('write failed') };
    stubDb({ transaction: () => t });
    const p = idb.putMany('records', [{ id: 'a' }]);
    defer(() => t.onerror?.());
    await expect(p).rejects.toThrow('write failed');
    expect(store.put).toHaveBeenCalledOnce();
  });

  it('putMany：事务 onabort 使用默认文案', async () => {
    const store = makeStore();
    const t: Record<string, unknown> = { objectStore: () => store };
    stubDb({ transaction: () => t });
    const p = idb.putMany('records', [{ id: 'a' }]);
    defer(() => t.onabort?.());
    await expect(p).rejects.toThrow('事务被中止');
  });

  it('putMany：事务 oncomplete 完成', async () => {
    const store = makeStore();
    const t: Record<string, unknown> = { objectStore: () => store };
    stubDb({ transaction: () => t });
    const p = idb.putMany('records', [{ id: 'a' }, { id: 'b' }]);
    defer(() => t.oncomplete?.());
    await expect(p).resolves.toBeUndefined();
    expect(store.put).toHaveBeenCalledTimes(2);
  });

  it('deleteMany：空数组直接返回', async () => {
    await expect(idb.deleteMany('records', [])).resolves.toBeUndefined();
  });

  it('deleteMany：事务 onerror 拒绝', async () => {
    const store = makeStore();
    const t: Record<string, unknown> = { objectStore: () => store, error: new Error('del failed') };
    stubDb({ transaction: () => t });
    const p = idb.deleteMany('records', ['a']);
    defer(() => t.onerror?.());
    await expect(p).rejects.toThrow('del failed');
    expect(store.delete).toHaveBeenCalledWith('a');
  });

  it('deleteMany：事务 oncomplete 完成', async () => {
    const store = makeStore();
    const t: Record<string, unknown> = { objectStore: () => store };
    stubDb({ transaction: () => t });
    const p = idb.deleteMany('records', ['a', 'b']);
    defer(() => t.oncomplete?.());
    await expect(p).resolves.toBeUndefined();
    expect(store.delete).toHaveBeenCalledTimes(2);
  });

  it('deleteMany：事务 onabort 拒绝（默认文案）', async () => {
    const store = makeStore();
    const t: Record<string, unknown> = { objectStore: () => store };
    stubDb({ transaction: () => t });
    const p = idb.deleteMany('records', ['a']);
    defer(() => t.onabort?.());
    await expect(p).rejects.toThrow('事务被中止');
    expect(store.delete).toHaveBeenCalledOnce();
  });
});

describe('真实 IndexedDB（fake-indexeddb）读写', () => {
  it('onupgradeneeded 建库后完成一轮读写删', async () => {
    await idb.putMany(idb.STORE_RECORDS, [
      { id: 'r1', kind: 'task' },
      { id: 'r2', kind: 'task', deleted: true },
    ]);
    await idb.putMany(idb.STORE_META, [{ key: 'cursor', value: 7 }]);

    const recs = await idb.getAll<{ id: string }>(idb.STORE_RECORDS);
    expect(recs.map((r) => r.id).sort()).toEqual(['r1', 'r2']);

    const one = await idb.getOne<{ id: string }>(idb.STORE_RECORDS, 'r1');
    expect(one?.id).toBe('r1');

    await idb.deleteMany(idb.STORE_RECORDS, ['r2']);
    expect((await idb.getAll(idb.STORE_RECORDS)).map((r) => r.id)).toEqual(['r1']);

    await idb.clearAll();
    expect(await idb.getAll(idb.STORE_RECORDS)).toEqual([]);
    expect(await idb.getAll(idb.STORE_META)).toEqual([]);
  });
});

describe('openDb 打开失败', () => {
  it('req.onerror 触发时拒绝，且失败 promise 不被缓存（下次重试）', async () => {
    const err = new Error('open failed');
    const open = vi.fn(() => {
      const req: Record<string, unknown> = { error: err };
      queueMicrotask(() => req.onerror?.(undefined as never));
      return req;
    });
    vi.stubGlobal('indexedDB', { open });

    await expect(idb.getOne(idb.STORE_RECORDS, 'k')).rejects.toBe(err);
    // 关键行为：失败的 promise 被丢弃，下一次调用会重新 open 而不是永远拿到同一个错误
    await expect(idb.getOne(idb.STORE_RECORDS, 'k')).rejects.toBe(err);
    expect(open).toHaveBeenCalledTimes(2);
  });
});

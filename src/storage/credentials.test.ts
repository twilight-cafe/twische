import { describe, it, expect, vi, beforeEach } from 'vitest';

let creds: typeof import('./credentials');
let idb: typeof import('@/repo/idb');

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllGlobals();
  localStorage.clear();
  creds = await import('./credentials');
  idb = await import('@/repo/idb');
  await idb.clearAll();
});

describe('连接配置', () => {
  it('没有存过时返回空配置', () => {
    expect(creds.loadProfile()).toEqual({ url: '', username: '', remember: true });
  });

  it('保存后能读回；remember 缺省为 true', () => {
    creds.saveProfile({ url: 'https://dav.test/x', username: 'alice', remember: false });
    expect(creds.loadProfile()).toEqual({ url: 'https://dav.test/x', username: 'alice', remember: false });

    localStorage.setItem('twische.dav.profile', JSON.stringify({ url: 'u', username: 'n' }));
    expect(creds.loadProfile().remember).toBe(true);
  });

  it('损坏的 JSON 与字段类型不对时回退默认值', () => {
    localStorage.setItem('twische.dav.profile', '{oops');
    expect(creds.loadProfile().url).toBe('');

    localStorage.setItem('twische.dav.profile', JSON.stringify({ url: 42, username: null }));
    const p = creds.loadProfile();
    expect(p.url).toBe('');
    expect(p.username).toBe('');
  });

  it('clearProfile 清掉配置与内存里的密码', async () => {
    creds.saveProfile({ url: 'u', username: 'n', remember: true });
    await creds.savePassword('pw', true);
    creds.clearProfile();
    expect(creds.loadProfile().url).toBe('');
    expect(await creds.loadPassword()).toBeNull();
  });

  it('localStorage 不可用时不影响本次会话（读回默认值、写入静默失败）', () => {
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
    });
    expect(creds.loadProfile().url).toBe('');
    expect(() => creds.saveProfile({ url: 'u', username: 'n', remember: true })).not.toThrow();
    expect(() => creds.clearProfile()).not.toThrow();
  });

  it('写入抛错（配额满）时静默失败', () => {
    // 只让真正的写入失败，探针那次要放行 —— 否则会走"localStorage 不可用"的另一条分支
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === 'twische.dav.profile') throw new Error('quota');
      Storage.prototype.setItem.wrappedMethod?.call(this, key, value);
    } as never);
    expect(() => creds.saveProfile({ url: 'u', username: 'n', remember: true })).not.toThrow();
    spy.mockRestore();
    localStorage.clear();
  });

  it('删除配置抛错时静默失败', () => {
    // 探针那次 removeItem 必须放行，否则会走"localStorage 不可用"的另一条分支
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key === 'twische.dav.profile') throw new Error('denied');
      Storage.prototype.removeItem.wrappedMethod?.call(this, key);
    } as never);
    expect(() => creds.clearProfile()).not.toThrow();
    spy.mockRestore();
  });
});

describe('密码', () => {
  it('记住密码时落盘，且内存缓存优先', async () => {
    await creds.savePassword('secret', true);
    const row = await idb.getOne<{ key: string; value: string }>(idb.STORE_META, 'davPassword');
    expect(row?.value).toBe('secret');

    creds.__resetCredentialCacheForTest();
    expect(await creds.loadPassword()).toBe('secret');
  });

  it('不记住时只留内存，落盘为空串', async () => {
    await creds.savePassword('secret', false);
    const row = await idb.getOne<{ key: string; value: string }>(idb.STORE_META, 'davPassword');
    expect(row?.value).toBe('');

    // 同一会话内仍然可用
    expect(await creds.loadPassword()).toBe('secret');

    // 模拟"重开页面"：内存清空后读不到密码
    creds.__resetCredentialCacheForTest();
    expect(await creds.loadPassword()).toBeNull();
  });

  it('落盘失败不影响本次会话', async () => {
    const spy = vi.spyOn(idb, 'putMany').mockRejectedValue(new Error('disk'));
    await expect(creds.savePassword('secret', true)).resolves.toBeUndefined();
    expect(await creds.loadPassword()).toBe('secret');
    spy.mockRestore();
  });

  it('读取失败当作没有密码', async () => {
    const spy = vi.spyOn(idb, 'getOne').mockRejectedValue(new Error('broken'));
    expect(await creds.loadPassword()).toBeNull();
    spy.mockRestore();
  });

  it('存的是空串时视为没有密码', async () => {
    await idb.putMany(idb.STORE_META, [{ key: 'davPassword', value: '' }]);
    expect(await creds.loadPassword()).toBeNull();
  });

  it('clearPassword 清内存与落盘；落盘失败时内存先清掉（磁盘上那份只能下次启动再清）', async () => {
    await creds.savePassword('secret', true);
    await creds.clearPassword();
    expect(await creds.loadPassword()).toBeNull();

    await creds.savePassword('again', true);
    const spy = vi.spyOn(idb, 'putMany').mockRejectedValue(new Error('disk'));
    await expect(creds.clearPassword()).resolves.toBeUndefined();
    // 本次会话已经拿不到密码
    expect(await creds.loadPassword()).toBeNull();
    spy.mockRestore();
  });
});

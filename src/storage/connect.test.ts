import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeDavServer } from '@/test/dav-fake';
import { DavError } from './webdav/client';

let connect: typeof import('./connect');

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  connect = await import('./connect');
});

const profile = (over: Partial<import('./credentials').DavProfile> = {}) => ({
  url: 'https://dav.test/dav',
  username: 'alice',
  remember: true,
  ...over,
});

describe('可连接性判断', () => {
  it('地址与用户名都填了才允许提交', () => {
    expect(connect.isConnectable(profile())).toBe(true);
    expect(connect.isConnectable(profile({ url: '   ' }))).toBe(false);
    expect(connect.isConnectable(profile({ username: '' }))).toBe(false);
  });
});

describe('建立连接', () => {
  it('成功时返回 store 与探测摘要，并写下自述文件', async () => {
    const server = new FakeDavServer();
    const conn = await connect.openDavConnection(profile({ url: server.url }), 'secret', {
      fetchImpl: server.fetch,
    });
    expect(conn.probe.created).toBe(true);
    expect(conn.probe.davClasses).toContain('1');
    expect(server.files.has('/dav/twische/meta.json')).toBe(true);
    expect(server.files.has('/dav/twische/records/meta.json')).toBe(false);
  });

  it('已有数据时不再重复写自述文件', async () => {
    const server = new FakeDavServer();
    server.seedRecord('task-1', {
      id: 'task-1',
      kind: 'task',
      data: {},
      vc: { d: 1 },
      updatedAt: 1,
      deleted: false,
    });
    const before = server.requests.length;
    const conn = await connect.openDavConnection(profile({ url: server.url }), 'secret', {
      fetchImpl: server.fetch,
    });
    expect(conn.probe.recordCount).toBe(1);
    const methods = server.requests.slice(before).map((r) => r.method);
    expect(methods).not.toContain('PUT');
  });

  it('非 WebDAV 地址直接抛 not-dav', async () => {
    const server = new FakeDavServer({ davHeader: null });
    const err = (await connect
      .openDavConnection(profile({ url: server.url }), 'secret', { fetchImpl: server.fetch })
      .catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('not-dav');
  });

  it('asBackend 返回同一个 store', async () => {
    const server = new FakeDavServer();
    const conn = await connect.openDavConnection(profile({ url: server.url }), 'secret', {
      fetchImpl: server.fetch,
    });
    expect(connect.asBackend(conn)).toBe(conn.store);
  });
});

describe('错误文案', () => {
  it('每种 DavError 都有标题与可操作提示', () => {
    const kinds = [
      'aborted',
      'network',
      'cors',
      'unauthorized',
      'forbidden',
      'not-found',
      'precondition',
      'conflict',
      'server',
      'bad-response',
      'not-dav',
    ] as const;
    for (const kind of kinds) {
      const friendly = connect.friendlyError(new DavError(kind, 'boom'));
      expect(friendly.title.length, kind).toBeGreaterThan(0);
      expect(friendly.hint.length, kind).toBeGreaterThan(0);
      expect(friendly.detail).toBe('boom');
    }
  });

  it('跨域失败必须提示去配 CORS，而不是只说"连接失败"', () => {
    const friendly = connect.friendlyError(new DavError('cors', 'Failed to fetch'));
    expect(friendly.title).toContain('跨域');
    expect(friendly.hint).toContain('CORS');
  });

  it('未知异常走兜底文案', () => {
    const friendly = connect.friendlyError(new Error('something else'));
    expect(friendly.title).toBe('连接失败');
    expect(friendly.detail).toBe('something else');
    expect(friendly.hint).toBe('');

    expect(connect.friendlyError('字符串错误').detail).toBe('字符串错误');
  });
});

describe('探测结果描述', () => {
  it('渲染成可读文本，ETag 缺失时说明仍可用', () => {
    const lines = connect.describeProbe({
      davClasses: ['1', '2'],
      recordCount: 3,
      etagReadable: false,
      created: false,
    });
    expect(lines.join('\n')).toContain('DAV 级别：1, 2');
    expect(lines.join('\n')).toContain('远端记录数：3');
    expect(lines.join('\n')).toContain('仍可同步');
    expect(lines.join('\n')).toContain('存储目录已存在');
  });

  it('服务器没声明 DAV 级别、首次创建目录时也有可读输出', () => {
    const text = connect
      .describeProbe({ davClasses: [], recordCount: 0, etagReadable: true, created: true })
      .join('\n');
    expect(text).toContain('未声明');
    expect(text).toContain('已创建');
  });
});

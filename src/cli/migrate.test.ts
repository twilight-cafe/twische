import { describe, it, expect, vi } from 'vitest';
import { FakeDavServer } from '@/test/dav-fake';
import { FakeLegacyServer, type LegacyRecord } from '@/test/legacy-fake';
import { parseArgs, validateOptions, runMigration, USAGE } from './migrate.mjs';
import { fetchAllRecords, parseExportFile, LegacyError, checkHealth } from './legacy.mjs';
import { createTarget, basicAuth, sameRecord, pushRecords, pruneTombstones, TargetError } from './target.mjs';

/**
 * CLI 迁移工具的测试。
 *
 * 迁移是「用户把身家性命交出来」的操作，因此这里的重点是：
 * 幂等（重跑不会重复写）、不丢数据（墓碑也搬）、以及错误路径说得清。
 */

function record(id: string, over: Partial<LegacyRecord> = {}): LegacyRecord {
  return {
    id,
    kind: 'task',
    data: { id, title: `任务 ${id}` },
    vc: { devA: 1 },
    updatedAt: 1700000000000,
    deleted: false,
    seq: 1,
    ...over,
  };
}

describe('参数解析', () => {
  it('解析完整参数', () => {
    const opts = parseArgs([
      '--from',
      'http://old:8787',
      '--password',
      'pw',
      '--to',
      'https://dav.test/dav',
      '--user',
      'alice',
      '--pass',
      'secret',
      '--on-conflict',
      'overwrite',
      '--concurrency',
      '8',
      '--dry-run',
      '--report',
      'out.json',
    ]);
    expect(opts).toMatchObject({
      from: 'http://old:8787',
      password: 'pw',
      to: 'https://dav.test/dav',
      user: 'alice',
      pass: 'secret',
      onConflict: 'overwrite',
      concurrency: 8,
      dryRun: true,
      report: 'out.json',
    });
  });

  it('默认值：skip / 并发 4 / 非预演', () => {
    const opts = parseArgs(['--to', 'x', '--user', 'u', '--pass', 'p', '--from-file', 'f.json']);
    expect(opts.onConflict).toBe('skip');
    expect(opts.concurrency).toBe(4);
    expect(opts.dryRun).toBe(false);
  });

  it('未知参数与缺值都报错（拼错不该静默跑成别的东西）', () => {
    expect(() => parseArgs(['--nope'])).toThrow('未知参数');
    expect(() => parseArgs(['--to'])).toThrow('缺少取值');
    expect(() => parseArgs(['--on-conflict', 'whatever'])).toThrow('只能是 skip 或 overwrite');
  });

  it('--help 与 --older-than', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--older-than', '30']).olderThanDays).toBe(30);
    expect(parseArgs(['--prune-tombstones']).prune).toBe(true);
    expect(parseArgs(['--older-than', 'abc']).olderThanDays).toBe(0);
    expect(parseArgs(['--concurrency', '0']).concurrency).toBe(1);
  });

  it('参数组合校验', () => {
    expect(validateOptions({ help: true })).toBeNull();
    expect(validateOptions({})).toContain('--to');
    expect(validateOptions({ to: 'x' })).toContain('--user');
    expect(validateOptions({ to: 'x', user: 'u' })).toContain('--pass');
    expect(validateOptions({ to: 'x', user: 'u', pass: 'p' })).toContain('--from');
    expect(validateOptions({ to: 'x', user: 'u', pass: 'p', from: 'a', fromFile: 'b' })).toContain('只能给一个');
    expect(validateOptions({ to: 'x', user: 'u', pass: 'p', from: 'a' })).toContain('--password');
    expect(validateOptions({ to: 'x', user: 'u', pass: 'p', fromFile: 'b' })).toBeNull();
    expect(validateOptions({ to: 'x', user: 'u', pass: '', prune: true })).toBeNull();
  });

  it('USAGE 里写清了两种入口', () => {
    expect(USAGE).toContain('--from-file');
    expect(USAGE).toContain('--dry-run');
  });
});

describe('旧服务端客户端', () => {
  it('健康检查：未初始化时给出可操作的提示', async () => {
    const server = new FakeLegacyServer([], { initialized: false });
    await expect(checkHealth(server.url, server.fetch)).rejects.toThrow(/twische init/);

    const broken = new FakeLegacyServer();
    await expect(checkHealth('http://nope.test', () => Promise.resolve(new Response('', { status: 502 })))).rejects.toThrow(
      /502/,
    );
    expect(server.requests[0].path).toBe('/api/health');
  });

  it('登录 → 一次性导出全量（含墓碑）', async () => {
    const server = new FakeLegacyServer([record('a'), record('b', { deleted: true })]);
    const result = await fetchAllRecords({ baseUrl: server.url, password: 'old-password', fetchImpl: server.fetch });

    expect(result.source).toBe('export');
    expect(result.records.map((r) => r.id)).toEqual(['a', 'b']);
    expect(result.records[1].deleted).toBe(true);

    const login = server.requests.find((r) => r.path === '/api/auth/login')!;
    expect(login.headers['x-twische-client']).toBe('web');
    expect(login.headers.origin).toBeUndefined();
    expect(JSON.parse(login.body!).deviceName).toBe('Twische 迁移工具');
  });

  it('导出接口不可用时退回分页同步，且从不传 full', async () => {
    const many = Array.from({ length: 7 }, (_, i) => record(`r${i}`, { seq: i + 1 }));
    const server = new FakeLegacyServer(many, { disableExport: true, pageSize: 3 });

    const result = await fetchAllRecords({ baseUrl: server.url, password: 'old-password', fetchImpl: server.fetch, pageSize: 3 });
    expect(result.source).toBe('sync');
    expect(result.records.map((r) => r.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6']);

    const syncCalls = server.requests.filter((r) => r.path === '/api/sync');
    expect(syncCalls.length).toBe(3);
    for (const call of syncCalls) {
      expect(JSON.parse(call.body!).full).toBeUndefined();
    }
    expect(server.requests.some((r) => r.path === '/api/auth/logout')).toBe(true);
  });

  it('进度回调会随页推进', async () => {
    const server = new FakeLegacyServer([record('a'), record('b', { seq: 2 })]);
    const seen: number[] = [];
    await fetchAllRecords({
      baseUrl: server.url,
      password: 'old-password',
      fetchImpl: server.fetch,
      onProgress: (n) => seen.push(n),
    });
    expect(seen[seen.length - 1]).toBe(2);
  });

  it('不传 fetchImpl 时用全局 fetch', async () => {
    const server = new FakeLegacyServer([record('a')]);
    const inner = server.fetch;
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => inner(input, init));
    const result = await fetchAllRecords({ baseUrl: server.url, password: 'old-password' });
    expect(result.records).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('headers 没有 getSetCookie 时退回普通 Set-Cookie 读取', async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
      json: async () => ({ ok: true }),
      headers: {
        get: (name: string) => (name.toLowerCase() === 'set-cookie' ? 'twische_sid=zzz; Path=/' : null),
      },
    } as unknown as Response;
    const fetchImpl = (input: string) =>
      Promise.resolve(
        String(input).endsWith('/api/health')
          ? new Response(JSON.stringify({ ok: true, initialized: true }), { status: 200 })
          : fakeResponse,
      );
    // 登录成功即说明 cookie 被正确取到（否则会抛"没有下发会话 cookie"）
    const result = await fetchAllRecords({ baseUrl: 'http://x', password: 'p', fetchImpl });
    expect(result.records).toEqual([]);
  });

  it('导出与分页返回缺 records 字段时都按空数组处理', async () => {
    const noRecordsExport = (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return Promise.resolve(new Response(JSON.stringify({ ok: true, initialized: true })));
      if (path === '/api/auth/login') {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Set-Cookie': 'twische_sid=x' } }),
        );
      }
      if (path === '/api/account/export') return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      return Promise.resolve(new Response(JSON.stringify({ ok: true, hasMore: false, records: null })));
    };
    const viaExport = await fetchAllRecords({ baseUrl: 'http://x', password: 'p', fetchImpl: noRecordsExport });
    expect(viaExport.source).toBe('export');
    expect(viaExport.records).toEqual([]);

    const syncWithoutRecords = (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/account/export') return Promise.resolve(new Response('', { status: 404 }));
      return noRecordsExport(input);
    };
    const viaSync = await fetchAllRecords({ baseUrl: 'http://x', password: 'p', fetchImpl: syncWithoutRecords });
    expect(viaSync.source).toBe('sync');
    expect(viaSync.records).toEqual([]);
  });

  it('密码错误 / 限流 / 没下发 cookie 都要说清楚', async () => {
    expect(new LegacyError('x').status).toBe(0);
    const bad = new FakeLegacyServer();
    await expect(
      fetchAllRecords({ baseUrl: bad.url, password: 'wrong', fetchImpl: bad.fetch }),
    ).rejects.toThrow('密码不正确');

    const lockedFetch = (input: string) =>
      Promise.resolve(
        String(input).endsWith('/api/health')
          ? new Response(JSON.stringify({ ok: true, initialized: true }), { status: 200 })
          : new Response(JSON.stringify({ ok: false, code: 'locked', retryAfterSec: 60 }), { status: 429 }),
      );
    await expect(fetchAllRecords({ baseUrl: 'http://x', password: 'p', fetchImpl: lockedFetch })).rejects.toThrow(
      /稍后再试/,
    );

    const noCookie = (input: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            String(input).endsWith('/api/health') ? { ok: true, initialized: true } : { ok: true },
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    await expect(fetchAllRecords({ baseUrl: 'http://x', password: 'p', fetchImpl: noCookie })).rejects.toThrow(
      /没有下发会话 cookie/,
    );
  });

  it('服务端返回非 JSON 的登录错误时也能给出可读信息', async () => {
    const res = (input: string) =>
      Promise.resolve(
        String(input).endsWith('/api/health')
          ? new Response(JSON.stringify({ ok: true, initialized: true }), { status: 200 })
          : new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      );
    await expect(fetchAllRecords({ baseUrl: 'http://x', password: 'p', fetchImpl: res })).rejects.toThrow(/502/);
  });

  it('登录失败但响应里没有 code 字段时也能给出通用提示', async () => {
    const res = (input: string) =>
      Promise.resolve(
        String(input).endsWith('/api/health')
          ? new Response(JSON.stringify({ ok: true, initialized: true }), { status: 200 })
          : new Response(JSON.stringify({ ok: false, message: '说不清哪里错了' }), { status: 400 }),
      );
    await expect(fetchAllRecords({ baseUrl: 'http://x', password: 'p', fetchImpl: res })).rejects.toThrow(/HTTP 400/);
  });

  it('登录返回其它错误码时给出通用提示', async () => {
    const res = (input: string) =>
      Promise.resolve(
        String(input).endsWith('/api/health')
          ? new Response(JSON.stringify({ ok: true, initialized: true }), { status: 200 })
          : new Response(JSON.stringify({ ok: false, code: 'bad_request', message: '设备标识不合法' }), {
              status: 400,
            }),
      );
    await expect(fetchAllRecords({ baseUrl: 'http://x', password: 'p', fetchImpl: res })).rejects.toThrow(/HTTP 400/);
  });

  it('导出接口直接抛异常时退回分页', async () => {
    const server = new FakeLegacyServer([record('a', { seq: 1 })]);
    const inner = server.fetch;
    const flaky = (input: string, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/api/account/export') {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return inner(input, init);
    };
    const result = await fetchAllRecords({ baseUrl: server.url, password: 'old-password', fetchImpl: flaky });
    expect(result.source).toBe('sync');
    expect(result.records.map((r) => r.id)).toEqual(['a']);
  });

  it('not_initialized 的登录响应也有专属提示', async () => {
    const fetchImpl = (input: string) =>
      Promise.resolve(
        String(input).endsWith('/api/health')
          ? new Response(JSON.stringify({ ok: true, initialized: true }), { status: 200 })
          : new Response(JSON.stringify({ ok: false, code: 'not_initialized' }), { status: 503 }),
      );
    await expect(fetchAllRecords({ baseUrl: 'http://x', password: 'p', fetchImpl })).rejects.toThrow(/twische init/);
  });

  it('分页接口报错时抛出并带上状态码', async () => {
    const fetchImpl = (input: string) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return Promise.resolve(new Response(JSON.stringify({ ok: true, initialized: true })));
      if (path === '/api/auth/login') {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Set-Cookie': 'twische_sid=x; Path=/' },
          }),
        );
      }
      if (path === '/api/account/export') return Promise.resolve(new Response('', { status: 404 }));
      return Promise.resolve(new Response('', { status: 500 }));
    };
    const err = (await fetchAllRecords({ baseUrl: 'http://x', password: 'p', fetchImpl }).catch((e) => e)) as LegacyError;
    expect(err).toBeInstanceOf(LegacyError);
    expect(err.status).toBe(500);
  });
});

describe('导出文件解析', () => {
  it('解析合法文件，跳过未使用的类型与坏条目', () => {
    const parsed = parseExportFile(
      JSON.stringify({
        format: 'twische-export',
        records: [
          record('ok'),
          record('pref', { kind: 'pref' }),
          { id: 'bad-vc', kind: 'task', vc: [], updatedAt: 1 },
          { id: 'bad-time', kind: 'task', vc: { a: 1 }, updatedAt: 'x' },
          { kind: 'task', vc: { a: 1 }, updatedAt: 1 },
          record('no-data', { data: undefined }),
        ],
      }),
    );
    expect(parsed.records.map((r) => r.id)).toEqual(['ok', 'no-data']);
    expect(parsed.records[1].data).toEqual({});
    expect(parsed.skipped.map((s) => s.id)).toEqual(['pref', 'bad-vc', 'bad-time', '(无 id)']);
  });

  it('兼容裸数组，坏文件直接报错', () => {
    expect(parseExportFile(JSON.stringify([record('a')])).records).toHaveLength(1);
    expect(() => parseExportFile('{oops')).toThrow('不是合法的 JSON');
    expect(() => parseExportFile('{}')).toThrow('没有 records 数组');
  });
});

describe('WebDAV 写入端', () => {
  const make = (server: FakeDavServer) =>
    createTarget({ url: server.url, username: 'alice', password: 'secret', fetchImpl: server.fetch });

  it('basicAuth 用 utf8 编码（中文用户名密码）', () => {
    expect(basicAuth('alice', 'secret')).toBe(`Basic ${Buffer.from('alice:secret').toString('base64')}`);
    expect(basicAuth('用户', '密码')).toBe(`Basic ${Buffer.from('用户:密码', 'utf8').toString('base64')}`);
  });

  it('TargetError 与 toStored 的默认值', async () => {
    const err = new TargetError('出错了');
    expect(err.status).toBe(0);
    expect(err.href).toBe('');

    const server = new FakeDavServer();
    const target = make(server);
    await target.ensure();
    const res = await pushRecords(target, [{ id: 'no-data', kind: 'task', vc: { a: 1 }, updatedAt: 1 } as never]);
    expect(res.created).toBe(1);
    expect(JSON.parse(server.files.get('/dav/twische/records/no-data.json')!.body).data).toEqual({});
  });

  it('403 与读取失败都给出可读错误', async () => {
    const forbidden = new FakeDavServer();
    const target = make(forbidden);
    const deny = () => Promise.resolve(new Response('nope', { status: 403 }));
    const denied = createTarget({ url: forbidden.url, username: 'u', password: 'p', fetchImpl: deny });
    const err = (await denied.ensure().catch((e: unknown) => e)) as TargetError;
    expect(err.message).toContain('没有权限');

    // GET 拿到 500：不是"文件不存在"，必须抛而不是当成新建
    const broken = createTarget({
      url: forbidden.url,
      username: 'u',
      password: 'p',
      fetchImpl: () => Promise.resolve(new Response('boom', { status: 500 })),
    });
    const getErr = (await broken.get('http://x/f.json').catch((e: unknown) => e)) as TargetError;
    expect(getErr.status).toBe(500);
    void target;
  });

  it('不传 fetchImpl 时用全局 fetch（CLI 的真实路径）', async () => {
    const server = new FakeDavServer();
    const inner = server.fetch;
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => inner(input, init));
    const target = createTarget({ url: server.url, username: 'u', password: 'p' });
    await target.ensure();
    await pushRecords(target, [record('a')]);
    expect(server.files.size).toBe(1);
    vi.unstubAllGlobals();
  });

  it('remove 对不存在的文件是幂等的', async () => {
    const server = new FakeDavServer();
    const target = make(server);
    await target.ensure();
    await expect(target.remove(target.recordHref('missing'))).resolves.toBeUndefined();
  });

  it('pushRecords 传空数组时不炸，也不发写请求', async () => {
    const server = new FakeDavServer();
    const target = make(server);
    const result = await pushRecords(target, []);
    expect(result.created).toBe(0);
    expect(server.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
  });

  it('抛出非 Error 时报告里也能读到失败原因', async () => {
    const server = new FakeDavServer();
    const target = make(server);
    await target.ensure();
    vi.spyOn(target, 'put').mockRejectedValueOnce('字符串错误');
    const pushed = await pushRecords(target, [record('a')]);
    expect(pushed.failed[0].reason).toBe('字符串错误');

    server.seed('/dav/twische/records/boom.json', JSON.stringify(record('boom')));
    const getSpy = vi.spyOn(target, 'get').mockRejectedValue('读挂了');
    const pruned = await pruneTombstones(target, { olderThanMs: 0 });
    expect(pruned.failed[0].reason).toBe('读挂了');
    getSpy.mockRestore();
  });

  it('sameRecord 只比较落盘字段（忽略旧的 seq）', () => {
    expect(sameRecord(record('a'), record('a', { seq: 99 }))).toBe(true);
    expect(sameRecord(record('a'), record('a', { updatedAt: 2 }))).toBe(false);
  });

  it('ensure 建两级目录；父目录不存在时报错', async () => {
    const ok = new FakeDavServer();
    await make(ok).ensure();

    const broken = new FakeDavServer();
    broken.meta.delete('/dav');
    const err = (await make(broken).ensure().catch((e: unknown) => e)) as TargetError;
    expect(err).toBeInstanceOf(TargetError);
    expect(err.message).toContain('父目录不存在');
  });

  it('写入：新建 / 内容一致跳过 / 冲突时按策略处理', async () => {
    const server = new FakeDavServer();
    const target = make(server);
    await target.ensure();

    const first = await pushRecords(target, [record('a'), record('b')]);
    expect(first.created).toBe(2);

    // 重跑：内容一致 → 全部跳过（幂等）
    const second = await pushRecords(target, [record('a'), record('b')]);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(2);

    // 目标被改过 → 默认保留目标的版本
    server.seed('/dav/twische/records/a.json', JSON.stringify(record('a', { updatedAt: 999 })));
    const third = await pushRecords(target, [record('a')]);
    expect(third.kept).toBe(1);
    expect(JSON.parse(server.files.get('/dav/twische/records/a.json')!.body).updatedAt).toBe(999);

    const fourth = await pushRecords(target, [record('a')], { onConflict: 'overwrite' });
    expect(fourth.overwritten).toBe(1);
    expect(JSON.parse(server.files.get('/dav/twische/records/a.json')!.body).updatedAt).toBe(1700000000000);
  });

  it('dry-run 不发出任何写请求', async () => {
    const server = new FakeDavServer();
    const target = make(server);
    const result = await pushRecords(target, [record('a')], { dryRun: true });
    expect(result.created).toBe(1);
    expect(server.files.size).toBe(0);
    expect(server.requests.some((r) => r.method === 'PUT' || r.method === 'MKCOL')).toBe(false);
  });

  it('目标内容损坏时按"冲突"处理而不是崩掉', async () => {
    const server = new FakeDavServer();
    const target = make(server);
    await target.ensure();
    server.seed('/dav/twische/records/a.json', '{损坏');

    const result = await pushRecords(target, [record('a')]);
    expect(result.kept).toBe(1);

    const overwritten = await pushRecords(target, [record('a')], { onConflict: 'overwrite' });
    expect(overwritten.overwritten).toBe(1);
  });

  it('单条失败不影响其它记录，并如实记进报告', async () => {
    const server = new FakeDavServer();
    const target = make(server);
    await target.ensure();
    vi.spyOn(target, 'put').mockRejectedValueOnce(new TargetError('写入被拒', { status: 507 }));

    const result = await pushRecords(target, [record('a'), record('b')]);
    expect(result.failed).toHaveLength(1);
    expect(result.created).toBe(1);
  });

  it('list 解析 multistatus，跳过集合与非法文件名', async () => {
    const server = new FakeDavServer();
    const target = make(server);
    await target.ensure();
    server.seed('/dav/twische/records/a.json', '{}');
    server.seed('/dav/twische/records/task-1%7C2026-01-01.json'.replace('%7C', '|'), '{}');
    server.seed('/dav/twische/records/notes.txt', 'ignore');

    const listed = await target.list();
    expect(listed.map((x) => x.id).sort()).toEqual(['a', 'task-1|2026-01-01']);
  });

  it('list 容忍畸形响应：缺 href、非 json、集合自身都跳过', async () => {
    const xml =
      '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
      '<D:response><D:href>/dav/twische/records/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>' +
      '<D:response><D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>' +
      '<D:response><D:href></D:href><D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>' +
      '<D:response><D:href>/dav/twische/records/readme.txt</D:href><D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>' +
      '<D:response><D:href>/dav/twische/records/ok.json</D:href><D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>' +
      '</D:multistatus>';
    const target = createTarget({
      url: 'https://dav.test/dav',
      username: 'u',
      password: 'p',
      fetchImpl: () => Promise.resolve(new Response(xml, { status: 207 })),
    });
    expect((await target.list()).map((x) => x.id)).toEqual(['ok']);
  });

  it('list 在目录不存在时返回空数组', async () => {
    const server = new FakeDavServer();
    server.meta.delete('/dav');
    expect(await make(server).list()).toEqual([]);
  });

  it('认证失败时抛出可读错误', async () => {
    const server = new FakeDavServer({ expectedAuth: 'Basic bm9wZQ==' });
    const err = (await make(server).ensure().catch((e: unknown) => e)) as TargetError;
    expect(err.message).toContain('认证失败');
  });

  it('清理墓碑：只删足够旧的删除标记', async () => {
    const server = new FakeDavServer();
    const target = make(server);
    await target.ensure();
    const now = Date.now();
    server.seed('/dav/twische/records/old-tomb.json', JSON.stringify(record('old-tomb', { deleted: true, updatedAt: now - 100 * 24 * 3600 * 1000 })));
    server.seed('/dav/twische/records/new-tomb.json', JSON.stringify(record('new-tomb', { deleted: true, updatedAt: now })));
    server.seed('/dav/twische/records/live.json', JSON.stringify(record('live', { updatedAt: now - 100 * 24 * 3600 * 1000 })));

    const dry = await pruneTombstones(target, { dryRun: true });
    expect(dry.pruned).toBe(1);
    expect(dry.kept).toBe(2);
    expect(server.files.size).toBe(3);

    const real = await pruneTombstones(target);
    expect(real.pruned).toBe(1);
    expect(server.files.has('/dav/twische/records/old-tomb.json')).toBe(false);
    expect(server.files.has('/dav/twische/records/live.json')).toBe(true);
  });

  it('清理时跳过读取不到的文件', async () => {
    const server = new FakeDavServer();
    const target = make(server);
    await target.ensure();
    server.seed('/dav/twische/records/gone.json', JSON.stringify(record('gone')));
    vi.spyOn(target, 'get').mockResolvedValueOnce(null);
    const result = await pruneTombstones(target, { olderThanMs: 0 });
    expect(result.pruned).toBe(0);
  });

  it('清理时单条损坏不影响其它记录', async () => {
    const server = new FakeDavServer();
    const target = make(server);
    await target.ensure();
    server.seed('/dav/twische/records/broken.json', '{oops');
    server.seed('/dav/twische/records/old.json', JSON.stringify(record('old', { deleted: true, updatedAt: 1 })));

    const result = await pruneTombstones(target, { olderThanMs: 0 });
    expect(result.failed).toHaveLength(1);
    expect(result.pruned).toBe(1);
  });
});

describe('端到端迁移', () => {
  it('旧服务器 → WebDAV：记录逐条搬运，内容与旧服务端一致', async () => {
    const legacy = new FakeLegacyServer([record('a'), record('b', { deleted: true, seq: 2 })]);
    const dav = new FakeDavServer();
    const lines: string[] = [];

    const report = await runMigration(
      {
        from: legacy.url,
        password: 'old-password',
        to: dav.url,
        user: 'alice',
        pass: 'secret',
        onConflict: 'skip',
        concurrency: 2,
        dryRun: false,
      },
      { fetchImpl: (input: string, init?: RequestInit) => (input.startsWith(legacy.url) ? legacy.fetch(input, init) : dav.fetch(input, init)), log: (l: string) => lines.push(l) },
    );

    expect(report.created).toBe(2);
    expect(report.failed).toEqual([]);
    expect(report.source).toMatchObject({ kind: 'server', via: 'export' });

    const stored = JSON.parse(dav.files.get('/dav/twische/records/a.json')!.body);
    expect(stored).toMatchObject({ id: 'a', kind: 'task', vc: { devA: 1 } });
    expect(stored.seq).toBeUndefined(); // 旧字段不落盘
    // 墓碑也必须搬过去，否则别的设备会把它"复活"
    expect(JSON.parse(dav.files.get('/dav/twische/records/b.json')!.body).deleted).toBe(true);
    expect(lines.join('\n')).toContain('完成：');
  });

  it('导出文件 → WebDAV；重跑是幂等的', async () => {
    const dav = new FakeDavServer();
    const text = JSON.stringify({ format: 'twische-export', records: [record('a'), record('b', { seq: 2 })] });
    const opts = {
      fromFile: 'export.json',
      to: dav.url,
      user: 'alice',
      pass: 'secret',
      onConflict: 'skip',
      concurrency: 2,
      dryRun: false,
    };
    const deps = { fetchImpl: dav.fetch, readFile: async () => text, log: () => {} };

    const first = await runMigration(opts, deps);
    expect(first.created).toBe(2);

    const second = await runMigration(opts, deps);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it('预演模式不写任何东西，但报告与真实迁移一致', async () => {
    const dav = new FakeDavServer();
    const text = JSON.stringify({ records: [record('a')] });
    const report = await runMigration(
      { fromFile: 'e.json', to: dav.url, user: 'u', pass: 'p', onConflict: 'skip', concurrency: 1, dryRun: true },
      { fetchImpl: dav.fetch, readFile: async () => text, log: () => {} },
    );
    expect(report.dryRun).toBe(true);
    expect(report.created).toBe(1);
    expect(dav.files.size).toBe(0);
  });

  it('runMigration 不传 log 时也能跑（库调用方）', async () => {
    const dav = new FakeDavServer();
    const report = await runMigration(
      { fromFile: 'e.json', to: dav.url, user: 'u', pass: 'p', onConflict: 'skip', concurrency: 1, dryRun: false },
      { fetchImpl: dav.fetch, readFile: async () => JSON.stringify({ records: [record('a')] }) },
    );
    expect(report.created).toBe(1);
  });

  it('从旧服务器迁移时若导出接口不可用，报告里记为分页来源', async () => {
    const legacy = new FakeLegacyServer([record('a', { seq: 1 })], { disableExport: true });
    const dav = new FakeDavServer();
    const inner = legacy.fetch;
    const report = await runMigration(
      { from: legacy.url, password: 'old-password', to: dav.url, user: 'u', pass: 'p', onConflict: 'skip', concurrency: 1, dryRun: false },
      {
        log: () => {},
        fetchImpl: (input: string, init?: RequestInit) =>
          input.startsWith(legacy.url) ? inner(input, init) : dav.fetch(input, init),
      },
    );
    expect(report.source).toMatchObject({ kind: 'server', via: 'sync' });
    expect(report.created).toBe(1);
  });

  it('清理模式直接走 prune，不拉取数据', async () => {
    const dav = new FakeDavServer();
    await createTarget({ url: dav.url, username: 'u', password: 'p', fetchImpl: dav.fetch }).ensure();
    dav.seed('/dav/twische/records/old.json', JSON.stringify(record('old', { deleted: true, updatedAt: 1 })));

    const report = await runMigration(
      { to: dav.url, user: 'u', pass: 'p', prune: true, olderThanDays: 1, dryRun: false, concurrency: 1, onConflict: 'skip' },
      { fetchImpl: dav.fetch, log: () => {} },
    );
    expect(report.mode).toBe('prune');
    expect(report.pruned).toBe(1);
  });

  it('浏览器与 CLI 共用同一套存储布局（跨实现往返）', async () => {
    // 用浏览器端的 WebDavStore 写，用 CLI 的 target 读 —— 两边必须完全兼容
    const { DavClient } = await import('@/storage/webdav/client');
    const { WebDavStore } = await import('@/storage/webdav/store');
    const dav = new FakeDavServer();
    const browserStore = new WebDavStore(
      new DavClient({ url: dav.url, username: 'u', password: 'p', fetchImpl: dav.fetch }),
    );
    await browserStore.ensure();
    await browserStore.write(record('shared') as never, { etag: null });

    const cliTarget = createTarget({ url: dav.url, username: 'u', password: 'p', fetchImpl: dav.fetch });
    const listed = await cliTarget.list();
    expect(listed.map((x) => x.id)).toEqual(['shared']);

    const text = await cliTarget.get(listed[0].href);
    expect(JSON.parse(text!).data.title).toBe('任务 shared');

    // 反向：CLI 写的记录，浏览器端能读回来
    await pushRecords(cliTarget, [record('from-cli')]);
    const read = await browserStore.read('from-cli');
    expect(read.record.id).toBe('from-cli');
  });
});

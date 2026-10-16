import { describe, test, expect } from 'vitest';
import { DavClient, DavError } from './client';
import {
  WebDavStore,
  encodeRecordId,
  decodeRecordFileName,
  newStoreMeta,
  parseStoredRecord,
  validateStoredRecord,
  RECORDS_DIR,
  type StoredRecord,
} from './store';
import { FakeDavServer } from '@/test/dav-fake';

function makeStore(server: FakeDavServer, auth = true): WebDavStore {
  const client = new DavClient({
    url: server.url,
    username: auth ? 'alice' : '',
    password: auth ? 'secret' : '',
    fetchImpl: server.fetch,
  });
  return new WebDavStore(client);
}

function record(over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id: 'task-1',
    kind: 'task',
    data: { id: 'task-1', title: '晨跑' },
    vc: { 'device-a': 1 },
    updatedAt: 1768000000000,
    ...over,
  };
}

describe('文件名与 id 的往返', () => {
  test('普通 id 与含竖线的打卡 id 都能往返', () => {
    expect(encodeRecordId('abc-123')).toBe('abc-123');
    expect(decodeRecordFileName(`${encodeRecordId('abc-123')}.json`)).toBe('abc-123');

    const completionId = 'task-1|2026-01-15';
    expect(encodeRecordId(completionId)).toBe('task-1%7C2026-01-15');
    expect(decodeRecordFileName(`${encodeRecordId(completionId)}.json`)).toBe(completionId);

    const chinese = '任务-一';
    expect(decodeRecordFileName(`${encodeRecordId(chinese)}.json`)).toBe(chinese);
  });

  test('非记录文件名一律返回 null', () => {
    expect(decodeRecordFileName('meta.json')).toBe('meta');
    expect(decodeRecordFileName('readme.txt')).toBeNull();
    expect(decodeRecordFileName('.json')).toBeNull();
    expect(decodeRecordFileName('')).toBeNull();
  });

  test('非法百分号编码不抛异常', () => {
    expect(decodeRecordFileName('%E0%A4%A.json')).toBeNull();
  });
});

describe('记录校验', () => {
  test('合法记录没有问题', () => {
    expect(validateStoredRecord(record())).toEqual([]);
    expect(validateStoredRecord(record({ deleted: true }))).toEqual([]);
  });

  test('逐条报出问题', () => {
    expect(validateStoredRecord(null)).toEqual(['记录必须是对象']);
    expect(validateStoredRecord('x')).toEqual(['记录必须是对象']);

    const errs = validateStoredRecord({ id: '', kind: 'pref', updatedAt: 'x' });
    expect(errs).toContain('缺少 id');
    expect(errs).toContain('未知的记录类型「pref」');
    expect(errs).toContain('缺少 data');
    expect(errs).toContain('vc 必须是对象');
    expect(errs).toContain('updatedAt 必须是数字');

    expect(validateStoredRecord(record({ id: 'x'.repeat(201) }))).toContain('id 过长');
    expect(validateStoredRecord(record({ vc: [] as unknown as Record<string, number> }))).toContain(
      'vc 必须是对象',
    );
    expect(validateStoredRecord(record({ updatedAt: Number.NaN }))).toContain('updatedAt 必须是数字');
  });

  test('parseStoredRecord：坏 JSON 与不合规内容都抛 DavError（不静默吞掉）', () => {
    expect(parseStoredRecord(JSON.stringify(record()), 'x').id).toBe('task-1');
    expect(() => parseStoredRecord('{oops', '记录 x')).toThrow(DavError);
    expect(() => parseStoredRecord('{"id":"a"}', '记录 x')).toThrow(/内容不合法/);
  });

  test('newStoreMeta 带格式标识与版本', () => {
    const meta = newStoreMeta(123);
    expect(meta).toEqual({ format: 'twische-store', version: 1, createdAt: 123, app: 'twische-nxt' });
  });
});

describe('URL 与 href 映射', () => {
  test('记录文件地址与目录地址', () => {
    const store = makeStore(new FakeDavServer());
    expect(store.recordsDirUrl).toBe('https://dav.test/dav/twische/records');
    expect(store.metaUrl).toBe('https://dav.test/dav/twische/meta.json');
    expect(store.urlFor('a b')).toBe('https://dav.test/dav/twische/records/a%20b.json');
  });

  test('自定义根目录名，且去掉首尾斜杠', () => {
    const store = new WebDavStore(new DavClient({ url: 'https://dav.test/dav/', username: '', password: '' }), '/store/');
    expect(store.root).toBe('store');
    expect(store.recordsDirUrl).toBe('https://dav.test/dav/store/records');
  });

  test('idFromHref 从绝对 URL / 绝对路径 / 相对路径都能反推 id', () => {
    const store = makeStore(new FakeDavServer());
    expect(store.idFromHref('https://dav.test/dav/twische/records/abc.json')).toBe('abc');
    expect(store.idFromHref('/dav/twische/records/abc.json')).toBe('abc');
    expect(store.idFromHref('/dav/twische/records/a%7Cb.json')).toBe('a|b');
    expect(store.idFromHref('/dav/twische/records/')).toBeNull();
    expect(store.idFromHref('/')).toBeNull();
    expect(store.idFromHref('')).toBeNull();
  });
});

describe('目录与自述文件', () => {
  test('ensure 建出 twische/records 两级目录', async () => {
    const server = new FakeDavServer();
    await makeStore(server).ensure();
    expect(server.requests.filter((r) => r.method === 'MKCOL').map((r) => new URL(r.url).pathname)).toEqual([
      '/dav/twische',
      '/dav/twische/records',
    ]);
  });

  test('ensure 在父目录不存在时报 conflict（而不是假装成功）', async () => {
    const server = new FakeDavServer();
    server.meta.delete('/dav'); // 用户填了一个不存在的路径
    const err = (await makeStore(server).ensure().catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('conflict');
  });

  test('writeMetaIfAbsent：不存在时写入，已存在时跳过', async () => {
    const server = new FakeDavServer();
    const store = makeStore(server);
    await store.ensure();
    await store.writeMetaIfAbsent(newStoreMeta(42));
    expect(JSON.parse(server.files.get('/dav/twische/meta.json')!.body)).toEqual(newStoreMeta(42));

    const before = server.requests.length;
    await store.writeMetaIfAbsent(newStoreMeta(99));
    const after = server.requests.slice(before).map((r) => r.method);
    expect(after).toEqual(['GET']);
    expect(JSON.parse(server.files.get('/dav/twische/meta.json')!.body).createdAt).toBe(42);
  });

  test('writeMetaIfAbsent 遇到非 404 错误照抛', async () => {
    const server = new FakeDavServer();
    server.failNextPropfind = 404;
    const failing = new DavClient({
      url: server.url,
      username: '',
      password: '',
      fetchImpl: () => Promise.resolve(new Response('boom', { status: 500 })),
    });
    const err = (await new WebDavStore(failing).writeMetaIfAbsent().catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('server');
  });
});

describe('读写删', () => {
  test('list 列出记录文件，跳过集合与非记录文件', async () => {
    const server = new FakeDavServer();
    server.seedRecord('task-1', record());
    server.seedRecord('task-2', record({ id: 'task-2' }));
    server.seed('/dav/twische/records/notes.txt', 'ignore me');
    const map = await makeStore(server).list();
    expect([...map.keys()].sort()).toEqual(['task-1', 'task-2']);
    expect(map.get('task-1')!.etag).toBe(server.etagOf('/dav/twische/records/task-1.json'));
  });

  test('目录不存在时 list 抛 not-found', async () => {
    const server = new FakeDavServer();
    server.meta.delete('/dav');
    server.meta.delete('/dav/twische');
    const err = (await makeStore(server).list().catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('not-found');
  });

  test('read 取回记录与 ETag', async () => {
    const server = new FakeDavServer();
    server.seedRecord('task-1', record());
    const { record: got, ref } = await makeStore(server).read('task-1');
    expect(got.title ?? (got.data as { title: string }).title).toBe('晨跑');
    expect(ref.etag).toBe(server.etagOf('/dav/twische/records/task-1.json'));
    expect(ref.url).toBe('https://dav.test/dav/twische/records/task-1.json');
  });

  test('read 到损坏内容时抛 bad-response', async () => {
    const server = new FakeDavServer();
    server.seed('/dav/twische/records/task-1.json', '{broken');
    const err = (await makeStore(server).read('task-1').catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('bad-response');
  });

  test('write 新建带 If-None-Match: *，返回新 ETag', async () => {
    const server = new FakeDavServer();
    const store = makeStore(server);
    await store.ensure();
    const ref = await store.write(record(), { etag: null });
    expect(ref.etag).toBe(server.etagOf('/dav/twische/records/task-1.json'));
    const put = server.requests.find((r) => r.method === 'PUT')!;
    expect(put.headers['if-none-match']).toBe('*');
    expect(JSON.parse(server.files.get('/dav/twische/records/task-1.json')!.body).id).toBe('task-1');
  });

  test('write 更新带 If-Match，版本不符时抛 precondition', async () => {
    const server = new FakeDavServer();
    const store = makeStore(server);
    await store.ensure();
    const first = await store.write(record(), { etag: null });
    const second = await store.write(record({ data: { title: '改过' } }), { etag: first.etag });
    expect(second.etag).not.toBe(first.etag);

    const err = (await store.write(record(), { etag: first.etag }).catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('precondition');
    expect(err.isPrecondition).toBe(true);
  });

  test('write 不带 etag 选项时无条件写（服务器没有 ETag 的场景）', async () => {
    const server = new FakeDavServer({ noEtag: true });
    const store = makeStore(server);
    await store.ensure();
    const ref = await store.write(record());
    expect(ref.etag).toBeNull();
    const put = server.requests.find((r) => r.method === 'PUT')!;
    expect(put.headers['if-match']).toBeUndefined();
    expect(put.headers['if-none-match']).toBeUndefined();
  });

  test('write 拒绝不合法的记录，且不发出请求', async () => {
    const server = new FakeDavServer();
    const store = makeStore(server);
    await expect(store.write(record({ id: '' }))).rejects.toThrow(DavError);
    expect(server.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  test('remove 带 If-Match 删除；重复删除是幂等的', async () => {
    const server = new FakeDavServer();
    const store = makeStore(server);
    await store.ensure();
    const ref = await store.write(record(), { etag: null });
    await store.remove('task-1', ref.etag);
    expect(server.files.has('/dav/twische/records/task-1.json')).toBe(false);
    await expect(store.remove('task-1', ref.etag)).resolves.toBeUndefined();
  });

  test('remove 版本不符时抛 precondition', async () => {
    const server = new FakeDavServer();
    const store = makeStore(server);
    await store.ensure();
    const ref = await store.write(record(), { etag: null });
    server.seedRecord('task-1', record({ updatedAt: 2 })); // 别的设备改过了
    const err = (await store.remove('task-1', ref.etag).catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('precondition');
  });
});

describe('连接自检 probe', () => {
  test('没有 DAV 响应头 → not-dav', async () => {
    const server = new FakeDavServer({ davHeader: null });
    const err = (await makeStore(server).probe().catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('not-dav');
    expect(err.hint).toContain('WebDAV');
  });

  test('目录不存在时自动建好，并报告 created', async () => {
    const server = new FakeDavServer(); // 全新服务器：/dav 存在但 twische/ 还没有
    const result = await makeStore(server).probe();
    expect(result.created).toBe(true);
    expect(result.recordCount).toBe(0);
  });

  test('已有数据时报告记录数与 ETag 可读性', async () => {
    const server = new FakeDavServer();
    server.seedRecord('task-1', record());
    const result = await makeStore(server).probe();
    expect(result.created).toBe(false);
    expect(result.recordCount).toBe(1);
    expect(result.etagReadable).toBe(true);
    expect(result.davClasses).toContain('1');
    expect(result.allow).toContain('PROPFIND');
  });

  test('服务器不返回 ETag → etagReadable=false（仍可继续，只是并发窗口变大）', async () => {
    const server = new FakeDavServer({ noEtag: true });
    server.seedRecord('task-1', record());
    expect((await makeStore(server).probe()).etagReadable).toBe(false);
  });

  test('空目录时用自述文件探测 ETag 可读性', async () => {
    const withMeta = new FakeDavServer();
    withMeta.seed('/dav/twische/meta.json', JSON.stringify(newStoreMeta(1)));
    expect((await makeStore(withMeta).probe()).etagReadable).toBe(true);

    const noMeta = new FakeDavServer();
    expect((await makeStore(noMeta).probe()).etagReadable).toBe(false);
  });

  test('目录探测遇到认证失败时照抛', async () => {
    const server = new FakeDavServer({ expectedAuth: 'Basic bm9wZQ==' });
    const store = makeStore(server);
    const err = (await store.probe().catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('unauthorized');
    expect(err.isAuth).toBe(true);
  });

  test('DAV 头里只有非数字标记时也算不是 DAV 服务', async () => {
    const server = new FakeDavServer({ davHeader: 'extended-mkcol' });
    const err = (await makeStore(server).probe().catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('not-dav');
  });

  test('RECORDS_DIR 常量与实现一致', () => {
    expect(RECORDS_DIR).toBe('records');
  });
});

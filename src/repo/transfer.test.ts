import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeDavServer } from '@/test/dav-fake';
import { DavClient } from '@/storage/webdav/client';

let transfer: typeof import('./transfer');
let repo: typeof import('./localrepo');
let idb: typeof import('./idb');

const flush = () => new Promise<void>((r) => setTimeout(r, 20));

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('twische.deviceId', 'devA');
  localStorage.setItem('twische.deviceName', '测试机');
  repo = await import('./localrepo');
  transfer = await import('./transfer');
  idb = await import('./idb');
  await idb.clearAll();
  await repo.initRepo();
});

describe('导出', () => {
  it('按 id 排序、保留墓碑、去掉本地专有字段', () => {
    repo.state.records.set('b', {
      id: 'b',
      kind: 'task',
      data: { title: 'b' },
      vc: { devA: 2 },
      updatedAt: 20,
      dirty: true,
      version: 'e:2',
      etag: '"2"',
    });
    repo.state.records.set('a', {
      id: 'a',
      kind: 'task',
      data: {},
      vc: { devA: 1 },
      updatedAt: 10,
      deleted: true,
    });
    repo.state.records.set('c', {
      id: 'c',
      kind: 'completion',
      data: {},
      vc: { devA: 3 },
      updatedAt: 30,
    });

    const file = transfer.buildExport();
    expect(file.format).toBe('twische-export');
    expect(file.version).toBe(1);
    expect(file.records.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(file.records[0].deleted).toBe(true);
    expect('dirty' in file.records[1]).toBe(false);
    expect('etag' in file.records[1]).toBe(false);
  });

  it('downloadExport 生成 Blob 并触发下载', () => {
    const createUrl = vi.fn(() => 'blob:fake');
    const revokeUrl = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    transfer.downloadExport(transfer.buildExport([]), 'my.json');
    expect(createUrl).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    // 触发下载用的 <a> 会立刻从 DOM 上摘掉，不留痕迹
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('downloadExport 不传文件名时用日期命名', () => {
    let downloadName = '';
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });
    transfer.downloadExport(transfer.buildExport([]));
    expect(downloadName).toMatch(/^twische-export-\d{4}-\d{2}-\d{2}\.json$/);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});

describe('解析导出文件', () => {
  const valid = {
    format: 'twische-export',
    version: 1,
    exportedAt: 1,
    records: [
      { id: 'a', kind: 'task', data: { title: 'a' }, vc: { devA: 1 }, updatedAt: 10, deleted: false },
    ],
  };

  it('解析出记录；损坏条目进 skipped 而不是整体失败', () => {
    const file = {
      ...valid,
      records: [
        ...valid.records,
        { id: 'bad-kind', kind: 'pref', data: {}, vc: { devA: 1 }, updatedAt: 1 },
        { id: 'bad-vc', kind: 'task', data: {}, vc: [], updatedAt: 1 },
        'not-an-object',
      ],
    };
    const result = transfer.parseExport(JSON.stringify(file));
    expect(result.records).toHaveLength(1);
    expect(result.skipped).toHaveLength(3);
    expect(result.skipped.map((s) => s.id)).toEqual(['bad-kind', 'bad-vc', '(无 id)']);
  });

  it('缺 data 时兜底为空对象，deleted 归一为布尔', () => {
    // data 缺失会被校验拦下；data 为 null 才算"缺省可兜底"，deleted 用真值归一
    const file = { ...valid, records: [{ id: 'a', kind: 'task', data: null, vc: { devA: 1 }, updatedAt: 1, deleted: 1 }] };
    const { records } = transfer.parseExport(JSON.stringify(file));
    expect(records[0].data).toEqual({});
    expect(records[0].deleted).toBe(true);
  });

  it('结构不对时抛错', () => {
    expect(() => transfer.parseExport('{oops')).toThrow('不是合法的 JSON');
    expect(() => transfer.parseExport('"str"')).toThrow('不是对象');
    expect(() => transfer.parseExport('{}')).toThrow('没有 records 数组');
  });
});

describe('导入', () => {
  it('导入的记录变成待推送，并清掉远端版本指纹', async () => {
    repo.state.records.set('a', {
      id: 'a',
      kind: 'task',
      data: { title: '旧的' },
      vc: { devA: 1 },
      updatedAt: 1,
      dirty: false,
      version: 'e:9',
      etag: '"9"',
    });

    const { imported } = await transfer.importRecords([
      {
        id: 'a',
        kind: 'task',
        data: { title: '导入的' },
        vc: { devA: 2 },
        updatedAt: 2,
        deleted: false,
      },
      { id: 'b', kind: 'task', data: { title: '新的' }, vc: { devA: 1 }, updatedAt: 3, deleted: false },
    ]);

    expect(imported).toBe(2);
    const a = repo.getRecord('a')!;
    expect((a.data as { title: string }).title).toBe('导入的');
    expect(a.dirty).toBe(true);
    expect(a.version).toBeNull();
    expect(a.etag).toBeNull();
    expect(repo.getRecord('b')!.dirty).toBe(true);

    await flush();
    expect(await idb.getAll(idb.STORE_RECORDS)).toHaveLength(2);
  });

  it('导入的内容比本地旧时保留本地（向量时钟裁决），但仍然标脏', async () => {
    repo.state.records.set('a', {
      id: 'a',
      kind: 'task',
      data: { title: '本机更新' },
      vc: { devA: 5 },
      updatedAt: 500,
      dirty: false,
    });
    await transfer.importRecords([
      { id: 'a', kind: 'task', data: { title: '旧备份' }, vc: { devZ: 1 }, updatedAt: 1, deleted: false },
    ]);
    const a = repo.getRecord('a')!;
    expect((a.data as { title: string }).title).toBe('本机更新');
    expect(a.dirty).toBe(true);
  });

  it('导出→导入往返不丢字段', async () => {
    const rec = repo.upsertRecord({ kind: 'task', data: { title: '往返', nested: { n: 1 } } });
    await repo.markSynced(rec.id, { version: 'e:1', etag: '"1"' });

    const text = JSON.stringify(transfer.buildExport());
    await repo.wipeLocal(false);
    expect(repo.getRecord(rec.id)).toBeUndefined();

    const { records } = transfer.parseExport(text);
    await transfer.importRecords(records);
    const back = repo.getRecord(rec.id)!;
    expect(back.data).toEqual({ title: '往返', nested: { n: 1 } });
    expect(back.vc).toEqual(rec.vc);
  });
});

describe('与真实后端的配合', () => {
  it('导出旧服务器格式的文件可以直接导入并推到 WebDAV', async () => {
    const server = new FakeDavServer();
    const { store, records } = {
      store: new (await import('@/storage/webdav/store')).WebDavStore(
        new DavClient({ url: server.url, username: 'a', password: 'b', fetchImpl: server.fetch }),
      ),
      records: transfer.parseExport(
        JSON.stringify({
          format: 'twische-export',
          version: 1,
          records: [
            {
              id: 'legacy-1',
              kind: 'task',
              data: { id: 'legacy-1', title: '来自旧服务器' },
              vc: { 'old-device': 7 },
              updatedAt: 1700000000000,
              deleted: false,
            },
          ],
        }),
      ).records,
    };

    await transfer.importRecords(records);
    const sync = await import('./sync');
    sync.setBackend(store);
    expect(await sync.syncNow()).toBe(true, sync.syncState.lastError);
    expect(JSON.parse(server.files.get('/dav/twische/records/legacy-1.json')!.body).data.title).toBe(
      '来自旧服务器',
    );
    sync.__resetSyncForTest();
  });
});

import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  DavClient,
  DavError,
  isCrossOrigin,
  normalizeBaseUrl,
  utf8ToBase64,
  type FetchLike,
} from './client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** 构造一个只回一个响应的 fetch。 */
function once(response: Response | (() => Promise<Response>)): FetchLike {
  return () => (typeof response === 'function' ? response() : Promise.resolve(response.clone()));
}

function client(fetchImpl: FetchLike, over: Partial<ConstructorParameters<typeof DavClient>[0]> = {}): DavClient {
  return new DavClient({
    url: 'https://dav.test/dav',
    username: 'alice',
    password: 'secret',
    fetchImpl,
    ...over,
  });
}

describe('基础工具', () => {
  test('normalizeBaseUrl 去掉尾部斜杠（多个也去）', () => {
    expect(normalizeBaseUrl('https://dav.test/dav')).toBe('https://dav.test/dav');
    expect(normalizeBaseUrl('https://dav.test/dav/')).toBe('https://dav.test/dav');
    expect(normalizeBaseUrl('  https://dav.test/dav///  ')).toBe('https://dav.test/dav');
  });

  test('utf8ToBase64 对中文密码也正确（btoa 只吃 latin1）', () => {
    expect(utf8ToBase64('alice:secret')).toBe(btoa('alice:secret'));
    const encoded = utf8ToBase64('用户:密码');
    expect(encoded).toBe('55So5oi3OuWvhueggQ==');
  });

  test('resolve 拼接相对路径，容忍多余的前导斜杠', () => {
    const c = client(once(new Response('')));
    expect(c.resolve('')).toBe('https://dav.test/dav');
    expect(c.resolve('records/a.json')).toBe('https://dav.test/dav/records/a.json');
    expect(c.resolve('/records/a.json')).toBe('https://dav.test/dav/records/a.json');
  });

  test('没有用户名密码时不发 Authorization 头', async () => {
    const seen: Array<Record<string, string>> = [];
    const c = client(
      (url, init) => {
        seen.push((init?.headers ?? {}) as Record<string, string>);
        return Promise.resolve(new Response(null, { status: 200, headers: { DAV: '1' } }));
      },
      { username: '', password: '' },
    );
    await c.options();
    expect(seen[0].Authorization).toBeUndefined();
  });

  test('默认走全局 fetch（不注入 fetchImpl 时）', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response(null, { status: 200, headers: { DAV: '1' } })));
    vi.stubGlobal('fetch', spy);
    const c = new DavClient({ url: 'https://dav.test/dav', username: 'a', password: 'b' });
    await c.options();
    expect(spy).toHaveBeenCalledOnce();
  });

  test('带用户名密码时发 Basic 头', async () => {
    const seen: Array<Record<string, string>> = [];
    const c = client((url, init) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return Promise.resolve(new Response(null, { status: 200, headers: { DAV: '1' } }));
    });
    await c.options();
    expect(seen[0].Authorization).toBe(`Basic ${btoa('alice:secret')}`);
    expect(seen[0]['Content-Type']).toBeUndefined();
  });
});

describe('错误归一', () => {
  const cases: Array<[number, string]> = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [405, 'not-dav'],
    [409, 'conflict'],
    [412, 'precondition'],
    [423, 'conflict'],
    [500, 'server'],
    [503, 'server'],
    [418, 'bad-response'],
  ];

  for (const [status, kind] of cases) {
    test(`HTTP ${status} → ${kind}`, async () => {
      const c = client(once(new Response(`body-${status}`, { status })));
      const err = await c.options().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DavError);
      expect((err as DavError).kind).toBe(kind);
      expect((err as DavError).status).toBe(status);
      expect((err as DavError).detail).toContain(`body-${status}`);
      expect((err as DavError).hint.length).toBeGreaterThan(0);
    });
  }

  test('错误响应体读不出来时不炸（detail 为空串）', async () => {
    const res = new Response('x', { status: 500 });
    Object.defineProperty(res, 'text', { value: () => Promise.reject(new Error('stream broken')) });
    const c = client(() => Promise.resolve(res));
    const err = (await c.options().catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('server');
    expect(err.detail).toBe('');
  });

  test('同源网络失败归类为 network', async () => {
    // 同源地址（jsdom 的 location 是 http://localhost:3000），失败只可能是网络问题
    const c = client(() => Promise.reject(new TypeError('Failed to fetch')), {
      url: 'http://localhost:3000/dav',
    });
    const err = (await c.options().catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('network');
    expect(err.isNetwork).toBe(true);
    expect(err.isAuth).toBe(false);
  });

  test('跨域网络失败归类为 cors，并给出可操作提示', async () => {
    // jsdom 的 location 是 http://localhost:3000，https://dav.test 属于跨域
    const c = client(() => Promise.reject(new TypeError('Failed to fetch')));
    const err = (await c.options().catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('cors');
    expect(err.hint).toContain('CORS');
    expect(err.detail).toContain('Failed to fetch');
  });

  test('非 Error 抛出物也能归类', async () => {
    const c = client(() => Promise.reject('boom'));
    const err = (await c.options().catch((e: unknown) => e)) as DavError;
    expect(err.message).toContain('boom');
  });

  test('外部 abort 归类为 aborted', async () => {
    const c = client(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const err = (await c.options().catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('aborted');
    expect(err.isNetwork).toBe(false);
  });

  test('超时归类为 network 并说明是超时', async () => {
    vi.useFakeTimers();
    const c = client(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const promise = c.options().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20000);
    const err = (await promise) as DavError;
    expect(err.kind).toBe('network');
    expect(err.message).toContain('超时');
  });

  test('412 用 isPrecondition 暴露给同步层', () => {
    const err = new DavError('precondition', 'x');
    expect(err.isPrecondition).toBe(true);
    expect(new DavError('server', 'x').isPrecondition).toBe(false);
  });

  test('DavError 默认字段可省略', () => {
    const err = new DavError('network', 'boom');
    expect(err.status).toBe(0);
    expect(err.href).toBe('');
    expect(err.detail).toBe('');
    expect(err.name).toBe('DavError');
  });
});

describe('isCrossOrigin', () => {
  test('同源为 false，跨域为 true', () => {
    expect(isCrossOrigin('http://localhost:3000/dav')).toBe(false);
    expect(isCrossOrigin('/dav')).toBe(false);
    expect(isCrossOrigin('https://dav.test/dav')).toBe(true);
  });

  test('非浏览器环境恒为 false', () => {
    vi.stubGlobal('location', undefined);
    expect(isCrossOrigin('https://dav.test/dav')).toBe(false);
  });

  test('无法解析的地址为 false', () => {
    expect(isCrossOrigin('http://[')).toBe(false);
  });
});

describe('DAV 方法', () => {
  test('OPTIONS 解析 DAV 与 Allow 头，缺失时返回空数组', async () => {
    const c = client(
      once(new Response(null, { status: 200, headers: { DAV: '1, 2, 3', Allow: 'GET, PUT , PROPFIND' } })),
    );
    expect(await c.options()).toEqual({ dav: ['1', '2', '3'], allow: ['GET', 'PUT', 'PROPFIND'] });

    const bare = client(once(new Response(null, { status: 200 })));
    expect(await bare.options()).toEqual({ dav: [], allow: [] });
  });

  test('PROPFIND 发送 Depth 与 XML 体，并解析 multistatus', async () => {
    let captured: RequestInit | undefined;
    const c = client((url, init) => {
      captured = init;
      return Promise.resolve(
        new Response(
          '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/a.json</D:href>' +
            '<D:propstat><D:prop><D:getetag>"e"</D:getetag></D:prop>' +
            '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>',
          { status: 207 },
        ),
      );
    });
    const res = await c.propfind('https://dav.test/dav/records', 1);
    expect(res[0].etag).toBe('"e"');
    const headers = captured?.headers as Record<string, string>;
    expect(headers.Depth).toBe('1');
    expect(headers['Content-Type']).toContain('application/xml');
    expect(String(captured?.body)).toContain('getetag');
  });

  test('PROPFIND 默认 depth 为 0', async () => {
    let captured: RequestInit | undefined;
    const c = client((url, init) => {
      captured = init;
      return Promise.resolve(
        new Response('<D:multistatus xmlns:D="DAV:"/>', { status: 207 }),
      );
    });
    await c.propfind('https://dav.test/dav');
    expect((captured?.headers as Record<string, string>).Depth).toBe('0');
  });

  test('GET 返回正文、ETag 与 Last-Modified；服务器不给时为 null', async () => {
    const withEtag = client(
      once(
        new Response('{"a":1}', {
          status: 200,
          headers: { ETag: '"x"', 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
        }),
      ),
    );
    expect(await withEtag.get('https://dav.test/dav/a.json')).toEqual({
      body: '{"a":1}',
      etag: '"x"',
      lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    });

    const without = client(once(new Response('{}', { status: 200 })));
    const bare = await without.get('https://dav.test/dav/a.json');
    expect(bare.etag).toBeNull();
    expect(bare.lastModified).toBeNull();
  });

  test('PUT 按需带 If-Match / If-None-Match', async () => {
    const seen: Array<Record<string, string>> = [];
    const c = client((url, init) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return Promise.resolve(new Response(null, { status: 201, headers: { ETag: '"new"' } }));
    });
    const url = 'https://dav.test/dav/a.json';

    expect((await c.put(url, '{}')).etag).toBe('"new"');
    expect(seen[0]['If-Match']).toBeUndefined();
    expect(seen[0]['If-None-Match']).toBeUndefined();
    expect(seen[0]['Content-Type']).toContain('application/json');

    await c.put(url, '{}', { ifMatch: '"old"' });
    expect(seen[1]['If-Match']).toBe('"old"');

    await c.put(url, '{}', { ifNoneMatch: '*' });
    expect(seen[2]['If-None-Match']).toBe('*');

    await c.put(url, '{}', { ifMatch: null, ifNoneMatch: '*' });
    expect(seen[3]['If-Match']).toBeUndefined();
  });

  test('DELETE 把 404 当成功（幂等），其它错误照抛', async () => {
    const ok = client(once(new Response(null, { status: 404 })));
    await expect(ok.remove('https://dav.test/dav/a.json')).resolves.toBeUndefined();

    const stale = client(once(new Response('stale', { status: 412 })));
    const err = (await stale.remove('https://dav.test/dav/a.json').catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('precondition');

    const seen: Array<Record<string, string>> = [];
    const withMatch = client((url, init) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    await withMatch.remove('https://dav.test/dav/a.json', { ifMatch: '"e"' });
    expect(seen[0]['If-Match']).toBe('"e"');
  });

  test('MKCOL 成功时返回 true（真的建了）', async () => {
    const c = client(once(new Response(null, { status: 201 })));
    await expect(c.mkcol('https://dav.test/dav/x')).resolves.toBe(true);
  });

  test('MKCOL 把 405（已存在）当成功并返回 false，409（父目录不存在）照抛', async () => {
    const exists = client(once(new Response(null, { status: 405 })));
    await expect(exists.mkcol('https://dav.test/dav/x')).resolves.toBe(false);

    const missingParent = client(once(new Response(null, { status: 409 })));
    const err = (await missingParent.mkcol('https://dav.test/dav/x').catch((e: unknown) => e)) as DavError;
    expect(err.kind).toBe('conflict');

    const boom = client(once(new Response('nope', { status: 403 })));
    const forbidden = (await boom.mkcol('https://dav.test/dav/x').catch((e: unknown) => e)) as DavError;
    expect(forbidden.kind).toBe('forbidden');
  });
});

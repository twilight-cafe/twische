import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError } from './api';

/** 造一个可编程的 fetch 响应。 */
function res(opts: { ok?: boolean; status?: number; text?: string }): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: async () => opts.text ?? '',
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiError', () => {
  it('isNetwork 只认 network_error', () => {
    expect(new ApiError('network_error', 'x').isNetwork).toBe(true);
    expect(new ApiError('bad_response', 'x').isNetwork).toBe(false);
  });

  it('isAuth 认 code 或 401 状态', () => {
    expect(new ApiError('unauthorized', 'x', 200).isAuth).toBe(true);
    expect(new ApiError('whatever', 'x', 401).isAuth).toBe(true);
    expect(new ApiError('whatever', 'x', 200).isAuth).toBe(false);
  });

  it('needsPassword', () => {
    expect(new ApiError('password_required', 'x').needsPassword).toBe(true);
    expect(new ApiError('other', 'x').needsPassword).toBe(false);
  });
});

describe('request()', () => {
  it('传入外部 AbortSignal 时正常完成并清理监听', async () => {
    const fetchMock = vi.fn(async () => res({ text: '{"ok":true}' }));
    vi.stubGlobal('fetch', fetchMock);
    const ctrl = new AbortController();
    const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener');
    await expect(api.sync({}, ctrl.signal)).resolves.toEqual({ ok: true });
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('HTTP 500 且空响应体 → http_500 兜底码与兜底文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ ok: false, status: 500, text: '' })));
    await expect(api.status()).rejects.toMatchObject({
      code: 'http_500',
      message: '请求失败（500）',
    });
  });

  it('错误响应缺 message 时用状态码兜底文案，payload 仍作为 extra 透传', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res({ ok: false, status: 418, text: '{"code":"teapot"}' })),
    );
    await expect(api.status()).rejects.toMatchObject({
      code: 'teapot',
      message: '请求失败（418）',
      extra: { code: 'teapot' },
    });
  });

  it('成功解析 JSON；GET 不带 Content-Type', async () => {
    const fetchMock = vi.fn(async () => res({ text: '{"ok":true,"v":1}' }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await api.status();
    expect(out).toEqual({ ok: true, v: 1 });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/health');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((init.headers as Record<string, string>)['X-Twische-Client']).toBe('web');
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
  });

  it('带 body 时序列化为 JSON 并设置 Content-Type', async () => {
    const fetchMock = vi.fn(async () => res({ text: '{"ok":true}' }));
    vi.stubGlobal('fetch', fetchMock);
    await api.login('pw', 'dev', 'name');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ password: 'pw', deviceId: 'dev', deviceName: 'name' }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('空响应体返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ text: '' })));
    await expect(api.logout()).resolves.toBeNull();
  });

  it('非 JSON + 非 2xx → bad_response（带状态码）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ ok: false, status: 502, text: '<html>bad gateway</html>' })));
    await expect(api.status()).rejects.toMatchObject({
      code: 'bad_response',
      message: '服务器返回了异常响应（502）',
      status: 502,
    });
  });

  it('非 JSON + 2xx → bad_response（解析失败）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ text: '<html>weird</html>' })));
    await expect(api.status()).rejects.toMatchObject({
      code: 'bad_response',
      message: '服务器返回的内容无法解析',
    });
  });

  it('2xx 之外：payload 带 code 与 message 时透传', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res({ ok: false, status: 423, text: '{"code":"locked","message":"已锁定","retryAfterSec":30}' })),
    );
    const err = await api.status().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('locked');
    expect(err.message).toBe('已锁定');
    expect(err.extra.retryAfterSec).toBe(30);
  });

  it('2xx 之外：payload 无 code 时回退 http_<status>', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ ok: false, status: 500, text: '{"message":"oops"}' })));
    await expect(api.status()).rejects.toMatchObject({ code: 'http_500', message: 'oops' });
  });

  it('fetch 抛 AbortError → aborted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('x', 'AbortError');
    }));
    await expect(api.status()).rejects.toMatchObject({ code: 'aborted', message: '请求已取消' });
  });

  it('fetch 抛 TimeoutError → network_error（超时文案）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('x', 'TimeoutError');
    }));
    await expect(api.status()).rejects.toMatchObject({ code: 'network_error', message: '请求超时，请检查网络' });
  });

  it('fetch 抛其它错误 → network_error（连接失败文案）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    await expect(api.status()).rejects.toMatchObject({ code: 'network_error', message: '无法连接到服务器' });
  });

  it('超时定时器触发 abort：fetch 感知 signal 后拒绝', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_path: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const p = api.status();
      const assertion = expect(p).rejects.toMatchObject({ code: 'network_error', message: '请求超时，请检查网络' });
      await vi.advanceTimersByTimeAsync(8000 + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('外部 signal 中止时取消请求并解绑监听', async () => {
    const external = new AbortController();
    const fetchMock = vi.fn((_path: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const p = api.sync({ cursor: 0 }, external.signal);
    const assertion = expect(p).rejects.toMatchObject({ code: 'aborted' });
    external.abort();
    await assertion;
  });
});

describe('api 端点清单', () => {
  it('各端点打到正确路径与方法', async () => {
    const fetchMock = vi.fn(async () => res({ text: '{"ok":true}' }));
    vi.stubGlobal('fetch', fetchMock);

    await api.logoutAll();
    await api.session();
    await api.changePassword('a', 'b');
    await api.sync({ cursor: 3 });
    await api.devices();
    await api.renameDevice('d1', '新名');
    await api.renameDevice('d1', '新名', 'pw');
    await api.revokeDevice('d1');
    await api.revokeDevice('d1', 'pw');
    await api.forgetDevice('d1');
    await api.forgetDevice('d1', 'pw');
    await api.account();
    await api.audit(10);
    await api.conflicts(5);

    const paths = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(paths).toEqual([
      '/api/auth/logout-all',
      '/api/auth/session',
      '/api/auth/password',
      '/api/sync',
      '/api/devices',
      '/api/devices/rename',
      '/api/devices/rename',
      '/api/devices/revoke',
      '/api/devices/revoke',
      '/api/devices/forget',
      '/api/devices/forget',
      '/api/account',
      '/api/account/audit?limit=10',
      '/api/sync/conflicts?limit=5',
    ]);
    expect(api.exportUrl).toBe('/api/account/export');
  });
});

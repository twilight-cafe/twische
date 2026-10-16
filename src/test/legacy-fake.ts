/**
 * 测试用的假「旧 Twische 服务端」。
 *
 * 复刻实测确认的协议细节：`x-twische-client: web` 必填、Origin 必须缺省、
 * 会话走 Set-Cookie、`/api/account/export` 一次性返回全量。
 * 这些细节任何一条记错，迁移就会以一个看不懂的 400/403 失败。
 */
import type { FetchLike } from '@/storage/webdav/client';

export interface LegacyRecord {
  id: string;
  kind: string;
  data: unknown;
  vc: Record<string, number>;
  updatedAt: number;
  deleted?: boolean;
  seq?: number;
}

export interface FakeLegacyOptions {
  password?: string;
  initialized?: boolean;
  /** 关闭导出接口，逼客户端走分页同步 */
  disableExport?: boolean;
  /** 分页模式下每页条数 */
  pageSize?: number;
  /** 只允许这个 deviceId 前缀登录（用于验证客户端确实带了设备标识） */
  requireClientHeader?: boolean;
}

export class FakeLegacyServer {
  readonly url = 'http://legacy.test:8787';
  readonly requests: Array<{ method: string; path: string; headers: Record<string, string>; body?: string }> = [];
  records: LegacyRecord[] = [];
  opts: FakeLegacyOptions;
  private session: string | null = null;

  constructor(records: LegacyRecord[] = [], opts: FakeLegacyOptions = {}) {
    this.records = records;
    this.opts = opts;
  }

  get fetch(): FetchLike {
    return (input: string, init?: RequestInit) => this.handle(input, init);
  }

  private async handle(input: string, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = new URL(input).pathname;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    this.requests.push({ method, path, headers, body: init?.body as string | undefined });

    if (method === 'GET' && path === '/api/health') {
      return json({ ok: true, initialized: this.opts.initialized !== false, version: '1.0.3' });
    }

    if (method === 'POST' && path === '/api/auth/login') {
      if (headers['x-twische-client'] !== 'web') {
        return json({ ok: false, code: 'bad_request', message: '缺少客户端标识头' }, 400);
      }
      if (headers.origin) {
        return json({ ok: false, code: 'csrf', message: '跨站请求被拒绝' }, 403);
      }
      const body = JSON.parse(String(init?.body ?? '{}'));
      const expected = this.opts.password ?? 'old-password';
      if (body.password !== expected) {
        return json({ ok: false, code: 'bad_credentials', message: '密码不正确' }, 401);
      }
      if (!body.deviceId || String(body.deviceId).length < 8) {
        return json({ ok: false, code: 'bad_request', message: '设备标识不合法' }, 400);
      }
      this.session = 'twische_sid=abc.def';
      return new Response(JSON.stringify({ ok: true, device: { id: body.deviceId, name: body.deviceName } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': `${this.session}; Path=/; HttpOnly` },
      });
    }

    if (path.startsWith('/api/') && this.session && headers.cookie !== this.session) {
      return json({ ok: false, code: 'unauthorized', message: '未登录' }, 401);
    }

    if (method === 'GET' && path === '/api/account/export') {
      if (this.opts.disableExport) return json({ ok: false, code: 'not_found', message: '接口不存在' }, 404);
      return json({
        format: 'twische-export',
        version: 1,
        exportedAt: Date.now(),
        serverVector: { devA: 3 },
        records: this.records,
      });
    }

    if (method === 'POST' && path === '/api/sync') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.full) return json({ ok: false, code: 'bad_request', message: '迁移工具不应传 full' }, 400);
      const limit = Math.min(Number(body.limit) || 500, this.opts.pageSize ?? 500);
      const after = this.records.filter((r) => (r.seq ?? 0) > (Number(body.cursor) || 0));
      const page = after.slice(0, limit);
      return json({
        ok: true,
        cursor: page.length > 0 ? page[page.length - 1].seq ?? 0 : Number(body.cursor) || 0,
        hasMore: after.length > page.length,
        records: page.map((r) => ({ ...r, seq: r.seq ?? 0 })),
      });
    }

    if (method === 'POST' && path === '/api/auth/logout') {
      this.session = null;
      return json({ ok: true });
    }

    return json({ ok: false, code: 'not_found', message: '接口不存在' }, 404);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

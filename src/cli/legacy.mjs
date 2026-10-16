/**
 * 旧 Twische 服务端的客户端（仅 CLI 迁移使用）。
 *
 * 为什么必须有它：旧服务端没有 CORS 头、会话是 HttpOnly + SameSite=Lax 的 cookie，
 * 变更类请求还要求 `Origin` 等于 `Host`。浏览器从跨域静态页直连它在协议层面就不可能，
 * 而 Node 不受这些限制 —— 这正是「填地址 + 密码」这条迁移路径只能做成 CLI 的原因。
 *
 * 协议细节都是实测确认过的（见 docs/DESIGN.md §6）：
 * - 每个 POST 都要带 `x-twische-client: web`，否则 400
 * - 不能带 `Origin` 头，否则被 CSRF 守卫 403
 * - `GET /api/account/export` 一次性返回全量（含墓碑）
 * - 账户很大时改用 `POST /api/sync` 分页，**绝不能带 full:true**
 *   （旧服务端每次都会把游标重置为 0，会把分页变成死循环）
 */

/** @typedef {{ id: string, kind: string, data: unknown, vc: Record<string, number>, updatedAt: number, deleted?: boolean }} Record */

export class LegacyError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'LegacyError';
    this.status = opts.status ?? 0;
    this.body = opts.body ?? '';
  }
}

const CLIENT_HEADER = { 'x-twische-client': 'web' };

/**
 * 登录并返回一个带 cookie 的请求函数。
 *
 * @param {{ baseUrl: string, password: string, deviceId?: string, fetchImpl?: typeof fetch }} opts
 */
export async function login(opts) {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const deviceId = opts.deviceId || `migration-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const res = await doFetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { ...CLIENT_HEADER, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: opts.password, deviceId, deviceName: 'Twische 迁移工具' }),
  });
  const text = await res.text();
  if (!res.ok) {
    let code = '';
    try {
      code = JSON.parse(text).code ?? '';
    } catch {
      /* 服务端可能返回非 JSON（反代错误页） */
    }
    if (code === 'bad_credentials') throw new LegacyError('密码不正确', { status: res.status, body: text });
    if (code === 'locked' || code === 'too_many_requests') {
      throw new LegacyError('尝试过于频繁，请稍后再试', { status: res.status, body: text });
    }
    if (code === 'not_initialized') {
      throw new LegacyError('该服务端尚未初始化（需先在服务器上执行 twische init）', {
        status: res.status,
        body: text,
      });
    }
    throw new LegacyError(`登录失败（HTTP ${res.status}）`, { status: res.status, body: text });
  }

  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new LegacyError('登录成功但服务端没有下发会话 cookie');

  return {
    deviceId,
    request: (path, init = {}) =>
      doFetch(`${base}${path}`, {
        ...init,
        headers: { ...CLIENT_HEADER, ...(init.headers ?? {}), Cookie: cookie },
      }),
  };
}

/** 健康检查：确认这是 Twische 服务端且已初始化。 */
export async function checkHealth(baseUrl, fetchImpl) {
  const doFetch = fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/+$/, '');
  const res = await doFetch(`${base}/api/health`);
  if (!res.ok) throw new LegacyError(`无法访问 ${base}/api/health（HTTP ${res.status}）`, { status: res.status });
  const body = await res.json();
  if (!body.initialized) throw new LegacyError('该服务端尚未初始化（需先在服务器上执行 twische init）');
  return body;
}

/**
 * 拉取全量记录。
 *
 * 优先用一次性导出接口；账户很大或导出失败时退回分页同步。
 *
 * @param {{ baseUrl: string, password: string, fetchImpl?: typeof fetch, pageSize?: number, onProgress?: (n: number) => void }} opts
 * @returns {Promise<{ records: Record[], source: 'export'|'sync' }>}
 */
export async function fetchAllRecords(opts) {
  await checkHealth(opts.baseUrl, opts.fetchImpl);
  const session = await login(opts);

  try {
    const res = await session.request('/api/account/export');
    if (res.ok) {
      const body = await res.json();
      const records = Array.isArray(body.records) ? body.records : [];
      opts.onProgress?.(records.length);
      return { records, source: 'export' };
    }
  } catch {
    // 导出接口不可用（老版本服务端）→ 走分页
  }

  const pageSize = Math.min(opts.pageSize ?? 500, 500);
  const records = [];
  let cursor = 0;
  for (;;) {
    const res = await session.request('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor, limit: pageSize }),
    });
    if (!res.ok) throw new LegacyError(`分页拉取失败（HTTP ${res.status}）`, { status: res.status });
    const body = await res.json();
    const batch = Array.isArray(body.records) ? body.records : [];
    records.push(...batch);
    opts.onProgress?.(records.length);
    if (batch.length > 0) cursor = body.cursor;
    if (!body.hasMore) break;
  }
  await session.request('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
  return { records, source: 'sync' };
}

/** 读取导出文件（`twische-export` 格式），同时兼容裸数组。 */
export function parseExportFile(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LegacyError('文件不是合法的 JSON');
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.records;
  if (!Array.isArray(list)) throw new LegacyError('文件里没有 records 数组');

  const records = [];
  const skipped = [];
  for (const raw of list) {
    const id = typeof raw?.id === 'string' ? raw.id : '';
    if (!id) {
      skipped.push({ id: '(无 id)', reason: '缺少 id' });
      continue;
    }
    if (raw.kind !== 'task' && raw.kind !== 'completion') {
      skipped.push({ id, reason: `未使用的记录类型「${String(raw.kind)}」` });
      continue;
    }
    if (!raw.vc || typeof raw.vc !== 'object' || Array.isArray(raw.vc)) {
      skipped.push({ id, reason: 'vc 不是对象' });
      continue;
    }
    if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) {
      skipped.push({ id, reason: 'updatedAt 不是数字' });
      continue;
    }
    records.push({
      id,
      kind: raw.kind,
      data: raw.data ?? {},
      vc: raw.vc,
      updatedAt: raw.updatedAt,
      deleted: !!raw.deleted,
    });
  }
  return { records, skipped };
}

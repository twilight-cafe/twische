/**
 * 后端 HTTP 客户端。
 *
 * 只做三件事：带上 CSRF 头、把错误规范化成带 code 的异常、区分"网络不通"与"服务端拒绝"。
 * 后者尤其重要 —— 前者要静默重试，后者不能。
 */
import type { RecordKind } from './types';

export class ApiError extends Error {
  code: string;
  status: number;
  extra: Record<string, unknown>;

  constructor(code: string, message: string, status = 0, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }

  /** 网络层失败（离线、DNS、超时），值得重试。 */
  get isNetwork(): boolean {
    return this.code === 'network_error';
  }

  /** 登录状态失效，需要重新登录而不是重试。 */
  get isAuth(): boolean {
    return this.code === 'unauthorized' || this.status === 401;
  }

  /**
   * 服务端要求重新输入密码（会话提权已过期）。
   * 这不是失败，而是"补一个凭证再重试"，调用方应弹密码框后重发同一请求。
   */
  get needsPassword(): boolean {
    return this.code === 'password_required';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** 超时毫秒数。同步请求给得宽一些，登录这种交互请求给得紧一些。 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function request<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, timeoutMs = 20000, signal } = opts;

  const headers: Record<string, string> = {
    // 服务端强制要求该头，跨站请求无法伪造，构成 CSRF 的第一道防线
    'X-Twische-Client': 'web',
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  // 超时用 AbortController 实现；同时尊重外部传入的 signal
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  const onExternalAbort = () => ctrl.abort(new DOMException('aborted', 'AbortError'));
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('aborted', '请求已取消', 0);
    }
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiError('network_error', '请求超时，请检查网络', 0);
    }
    throw new ApiError('network_error', '无法连接到服务器', 0);
  }

  clearTimeout(timer);
  signal?.removeEventListener('abort', onExternalAbort);

  let payload: any = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // 服务端返回了非 JSON（例如反向代理的错误页）
      if (!res.ok) {
        throw new ApiError('bad_response', `服务器返回了异常响应（${res.status}）`, res.status);
      }
      throw new ApiError('bad_response', '服务器返回的内容无法解析', res.status);
    }
  }

  if (!res.ok) {
    const code = payload?.code || `http_${res.status}`;
    const message = payload?.message || `请求失败（${res.status}）`;
    throw new ApiError(code, message, res.status, payload || {});
  }

  return payload as T;
}

// ───────────────────────── 接口定义 ─────────────────────────

export interface ServerStatus {
  initialized: boolean;
  version: string;
  initializedAt: number | null;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string | null;
  createdAt: number;
  lastSeenAt: number;
  activeSessions: number;
  current: boolean;
}

export interface AccountInfo {
  username: string;
  createdAt: number;
  passwordUpdatedAt: number;
  lastLoginAt: number | null;
  passwordRounds: number;
}

export interface StatsInfo {
  records: number;
  tombstones: number;
  devices: number;
  activeSessions: number;
  conflicts: number;
  clock: number;
}

export interface WireRecordPayload {
  id: string;
  kind: RecordKind;
  data: Record<string, unknown>;
  vc: Record<string, number>;
  updatedAt: number;
  deleted: boolean;
}

export interface SyncResponse {
  ok: boolean;
  cursor: number;
  hasMore: boolean;
  records: Array<WireRecordPayload & { seq: number }>;
  corrections: Array<WireRecordPayload & { seq: number }>;
  applied: Array<{
    id: string;
    /**
     * created / updated / unchanged / stale / diverged /
     * conflict:client-won / conflict:kept-server
     *
     * diverged 指"时钟相同但内容不同"——本地状态曾跑偏，服务端回发权威版本纠正。
     */
    status: string;
    seq?: number;
    serverVc?: Record<string, number>;
  }>;
  conflicts: Array<{ id: string; winner: string }>;
  serverVector: Record<string, number>;
  tombstoneFloorSeq: number;
  /** 服务端未删除记录总数，客户端用于完整性自检（不一致时全量重建） */
  liveCount: number;
  resyncRequired: boolean;
  tookMs: number;
}

export const api = {
  status: () => request<ServerStatus>('/api/health', { timeoutMs: 8000 }),

  login: (password: string, deviceId: string, deviceName: string) =>
    request<{ ok: true; device: { id: string; name: string; platform: string } }>('/api/auth/login', {
      method: 'POST',
      body: { password, deviceId, deviceName },
      timeoutMs: 30000, // bcrypt 校验本身就要几百毫秒，弱网下再宽限些
    }),

  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST', body: {}, timeoutMs: 8000 }),

  logoutAll: () =>
    request<{ ok: true; revokedSessions: number }>('/api/auth/logout-all', { method: 'POST', body: {} }),

  session: () =>
    request<{
      ok: true;
      device: { id: string; name: string; platform: string };
      session: {
        expiresAt: number;
        createdAt: number;
        lastSeenAt: number;
        /** 会话提权到期时刻；管理其它设备需要它在未来 */
        elevatedUntil: number;
        elevated: boolean;
      };
      serverVector: Record<string, number>;
      stats: StatsInfo;
    }>('/api/auth/session', { timeoutMs: 8000 }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true; revokedSessions: number }>('/api/auth/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
      timeoutMs: 30000,
    }),

  sync: (
    body: {
      cursor: number;
      push?: WireRecordPayload[];
      limit?: number;
      full?: boolean;
    },
    signal?: AbortSignal,
  ) => request<SyncResponse>('/api/sync', { method: 'POST', body, timeoutMs: 45000, signal }),

  devices: () => request<{ ok: true; devices: DeviceInfo[] }>('/api/devices', { timeoutMs: 8000 }),

  /**
   * 设备管理三个接口都会在做用于**其它设备**时要求会话提权
   * （改自己的名字不需要）。password 只在服务端回 password_required 后补发。
   */
  renameDevice: (deviceId: string, name: string, password?: string) =>
    request<{ ok: true; devices: DeviceInfo[] }>('/api/devices/rename', {
      method: 'POST',
      body: password ? { deviceId, name, password } : { deviceId, name },
    }),

  revokeDevice: (deviceId: string, password?: string) =>
    request<{ ok: true; revokedSessions: number; devices: DeviceInfo[] }>('/api/devices/revoke', {
      method: 'POST',
      body: password ? { deviceId, password } : { deviceId },
    }),

  forgetDevice: (deviceId: string, password?: string) =>
    request<{ ok: true; devices: DeviceInfo[] }>('/api/devices/forget', {
      method: 'POST',
      body: password ? { deviceId, password } : { deviceId },
    }),

  account: () =>
    request<{
      ok: true;
      account: AccountInfo;
      stats: StatsInfo;
      environment: { app: string; runtime: string; platform: string };
    }>('/api/account'),

  audit: (limit = 50) =>
    request<{ ok: true; events: Array<{ at: number; event: string; detail: string | null; ip: string | null }> }>(
      `/api/account/audit?limit=${limit}`,
    ),

  conflicts: (limit = 50) =>
    request<{
      ok: true;
      conflicts: Array<{
        recordId: string;
        kind: string;
        at: number;
        winner: string;
        winnerVc: Record<string, number>;
        loserVc: Record<string, number>;
      }>;
    }>(`/api/sync/conflicts?limit=${limit}`),

  exportUrl: '/api/account/export',
};

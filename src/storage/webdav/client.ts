/**
 * WebDAV 客户端 —— 只实现 RFC 4918 class 1 里我们用到的那几个方法。
 *
 * 设计取舍：
 * 1. 不做任何服务器私有行为的兼容。遇到非标准响应就报错，错误信息里带上原始状态码，
 *    因为「猜服务器想要什么」是这类集成里最容易积累技术债的地方。
 * 2. 网络层失败必须可诊断。跨域被 CORS 拒绝时 `fetch` 只抛一个 `TypeError: Failed to fetch`，
 *    与「地址写错了」完全无法区分，所以这里结合 `location.origin` 做一次归类，
 *    并给出可以直接照做的提示。
 * 3. 超时用 AbortController。WebDAV 服务器（尤其自建小服务）在目录很大时 PROPFIND 很慢，
 *    没有超时会让同步卡死在一个永远不返回的请求上。
 */
import { parseMultiStatus, type DavResponse } from './xml';

export type DavErrorKind =
  | 'aborted'
  | 'network'
  | 'cors'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'precondition'
  | 'conflict'
  | 'server'
  | 'bad-response'
  | 'not-dav';

const KIND_HINTS: Record<DavErrorKind, string> = {
  aborted: '请求已取消',
  network: '无法连接到服务器，请检查地址与网络',
  cors:
    '浏览器拒绝了这次跨域请求。可能原因：服务器没有返回 CORS 响应头，或地址不可达。' +
    '需要在 WebDAV 服务器上允许本站源，并放行 Authorization / PROPFIND / MKCOL。',
  unauthorized: '用户名或密码不正确（若服务器要求两步验证，请使用「应用专用密码」）',
  forbidden: '服务器拒绝访问该路径，请确认账号对该目录有读写权限',
  'not-found': '路径不存在。可尝试填写到目录一级，例如 …/dav/files/用户名/',
  precondition: '资源在本地读取之后被其它设备修改过',
  conflict: '目标路径的父目录不存在，或资源被占用',
  server: '服务器内部错误',
  'bad-response': '服务器返回了无法理解的内容（可能被反向代理改写）',
  'not-dav': '该地址不支持 WebDAV。请确认填写的是 WebDAV 目录，而不是网页地址',
};

export class DavError extends Error {
  readonly kind: DavErrorKind;
  readonly status: number;
  readonly href: string;
  readonly detail: string;

  constructor(kind: DavErrorKind, message: string, opts: { status?: number; href?: string; detail?: string } = {}) {
    super(message);
    this.name = 'DavError';
    this.kind = kind;
    this.status = opts.status ?? 0;
    this.href = opts.href ?? '';
    this.detail = opts.detail ?? '';
  }

  /** 网络层问题（含跨域），值得静默重试。 */
  get isNetwork(): boolean {
    return this.kind === 'network' || this.kind === 'cors';
  }

  /** 凭据问题，重试没有意义，要回到连接页。 */
  get isAuth(): boolean {
    return this.kind === 'unauthorized' || this.kind === 'forbidden';
  }

  /** 乐观并发失败：调用方应重新拉取该资源、合并后再试一次。 */
  get isPrecondition(): boolean {
    return this.kind === 'precondition';
  }

  /** 给用户看的可操作提示。 */
  get hint(): string {
    return KIND_HINTS[this.kind];
  }
}

/**
 * 判断某个异常是不是 DavError。
 *
 * 刻意不用 `instanceof`：同一个模块被加载两次（打包重复、测试里 resetModules）
 * 会产生两个不同的类对象，`instanceof` 静默失败，症状是"错误分类全部失效、
 * 网络错误不再重试"这类极难定位的问题。按名字与形状判断更稳。
 */
export function isDavError(err: unknown): err is DavError {
  if (err instanceof DavError) return true;
  return (
    err instanceof Error &&
    err.name === 'DavError' &&
    typeof (err as DavError).kind === 'string' &&
    typeof (err as DavError).isNetwork === 'boolean'
  );
}

/** 只依赖 fetch 的最小子集，方便测试注入。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DavClientOptions {
  /** 目标目录地址，例如 https://dav.example.com/remote.php/dav/files/alice/twische */
  url: string;
  username: string;
  password: string;
  fetchImpl?: FetchLike;
  /** 单请求超时。PROPFIND 在目录较大时偏慢，默认给得比较宽松。 */
  timeoutMs?: number;
}

/** UTF-8 安全的 base64（btoa 只接受 latin1，中文密码会炸）。 */
export function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** 去掉尾部斜杠，保证拼接不会出现 `//`。 */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.endsWith('/') ? trimmed.replace(/\/+$/, '') : trimmed;
}

function statusToKind(status: number): DavErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 405) return 'not-dav';
  if (status === 409) return 'conflict';
  if (status === 412) return 'precondition';
  if (status === 423) return 'conflict';
  if (status >= 500) return 'server';
  return 'bad-response';
}

export class DavClient {
  readonly url: string;
  private readonly auth: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: DavClientOptions) {
    this.url = normalizeBaseUrl(opts.url);
    this.auth = opts.username || opts.password ? `Basic ${utf8ToBase64(`${opts.username}:${opts.password}`)}` : '';
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  /** 绝对地址：把相对路径拼到根地址上。相对路径里的每一段应由调用方自行编码。 */
  resolve(relPath: string): string {
    if (!relPath) return this.url;
    return `${this.url}/${relPath.replace(/^\/+/, '')}`;
  }

  /** 一次底层请求：带认证、超时、错误归一。 */
  async request(
    method: string,
    url: string,
    opts: { headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...opts.headers };
    if (this.auth) headers.Authorization = this.auth;

    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new DOMException('timeout', 'TimeoutError')),
      opts.timeoutMs ?? this.timeoutMs,
    );

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body,
        signal: ctrl.signal,
        // 用 Authorization 头认证，不需要 cookie；带上 cookie 反而会在
        // 「服务器同时有网页登录态」时产生难以解释的权限错乱。
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new DavError('aborted', '请求已取消', { href: url });
      }
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new DavError('network', `请求超时（${method} ${url}）`, { href: url });
      }
      throw this.classifyFetchFailure(method, url, err);
    }
    clearTimeout(timer);

    if (!res.ok) {
      const detail = await readErrorBody(res);
      throw new DavError(statusToKind(res.status), `${method} ${url} 失败（HTTP ${res.status}）`, {
        status: res.status,
        href: url,
        detail,
      });
    }
    return res;
  }

  /**
   * fetch 抛异常时的归类。
   *
   * 跨域目标上的失败几乎总是 CORS（浏览器不会告诉 JS 真正的原因），
   * 同源或非浏览器环境则只能是网络问题。这个区分直接决定了界面该提示
   * 「去配 CORS」还是「检查地址」。
   */
  private classifyFetchFailure(method: string, url: string, err: unknown): DavError {
    const message = err instanceof Error ? err.message : String(err);
    const crossOrigin = isCrossOrigin(url);
    return new DavError(crossOrigin ? 'cors' : 'network', `${method} ${url} 无法完成：${message}`, {
      href: url,
      detail: message,
    });
  }

  /** OPTIONS：拿 `DAV:` 与 `Allow` 响应头，用于「这是不是 WebDAV」的预检。 */
  async options(url = this.url): Promise<{ dav: string[]; allow: string[] }> {
    const res = await this.request('OPTIONS', url, { timeoutMs: 15000 });
    const dav = (res.headers.get('dav') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const allow = (res.headers.get('allow') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return { dav, allow };
  }

  /** PROPFIND；depth 只允许 0 或 1（不做无限深度，那是把服务器往死里打）。 */
  async propfind(url: string, depth: 0 | 1 = 0): Promise<DavResponse[]> {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<D:propfind xmlns:D="DAV:"><D:prop>' +
      '<D:getetag/><D:resourcetype/><D:getcontentlength/><D:getlastmodified/><D:displayname/>' +
      '</D:prop></D:propfind>';
    const res = await this.request('PROPFIND', url, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', Depth: String(depth) },
      body,
    });
    return parseMultiStatus(await res.text());
  }

  /** 读取文件；同时把 ETag / Last-Modified 带回来（用于版本比较与 If-Match）。 */
  async get(url: string): Promise<{ body: string; etag: string | null; lastModified: string | null }> {
    const res = await this.request('GET', url);
    return {
      body: await res.text(),
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    };
  }

  /** 写入文件。`ifNoneMatch='*'` 表示「不存在才写」，`ifMatch` 表示「版本没变才写」。 */
  async put(
    url: string,
    body: string,
    opts: { ifMatch?: string | null; ifNoneMatch?: string } = {},
  ): Promise<{ etag: string | null; lastModified: string | null }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    if (opts.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch;
    const res = await this.request('PUT', url, { headers, body });
    return { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
  }

  /** 删除文件。已经不存在时视为成功（幂等）。 */
  async remove(url: string, opts: { ifMatch?: string | null } = {}): Promise<void> {
    const headers: Record<string, string> = {};
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    try {
      await this.request('DELETE', url, { headers });
    } catch (err) {
      if (isDavError(err) && err.kind === 'not-found') return;
      throw err;
    }
  }

  /**
   * 建目录，返回「这次是否真的创建了」。
   *
   * 已存在时返回 405（Method Not Allowed），这是 RFC 4918 规定的行为，当成功处理 ——
   * MKCOL 没有幂等语义，只能这样绕。
   * 但 **409 必须抛出去**：它表示父目录不存在，也就是用户填的地址本身有问题；
   * 吞掉它只会让后面每一步都以更难懂的方式失败。
   */
  async mkcol(url: string): Promise<boolean> {
    try {
      await this.request('MKCOL', url);
      return true;
    } catch (err) {
      if (isDavError(err) && err.kind === 'not-dav') return false;
      throw err;
    }
  }
}

/** 目标是否与当前页面跨域（非浏览器环境恒为 false）。 */
export function isCrossOrigin(url: string): boolean {
  if (typeof location === 'undefined') return false;
  try {
    return new URL(url, location.href).origin !== location.origin;
  } catch {
    return false;
  }
}

/** 读取错误响应体，只保留一小段，避免把整个 HTML 错误页塞进日志。 */
async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

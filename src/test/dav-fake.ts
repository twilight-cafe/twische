/**
 * 测试用的假 WebDAV 服务器。
 *
 * 用真实语义（ETag、If-Match/If-None-Match、MKCOL 405、PROPFIND 命名空间）
 * 驱动被测代码，而不是逐个函数 mock —— 同步引擎的正确性恰恰藏在这些交互里。
 *
 * 放在 `src/test/` 下是为了避开 `src/storage/**` 的 100% 覆盖率门槛
 * （测试替身自己不需要被覆盖）。
 */
import type { FetchLike } from '@/storage/webdav/client';

interface FakeFile {
  body: string;
  etag: string;
  lastModified: string;
}

export interface FakeDavOptions {
  /** `DAV:` 响应头；设为 null 表示「这不是 WebDAV 服务」 */
  davHeader?: string | null;
  /** 要求 Basic 认证；给出期望的 `Basic xxx` 头值 */
  expectedAuth?: string;
  /** 所有请求都抛 TypeError（模拟断网或 CORS 被拒） */
  failNetwork?: boolean;
  /** 不返回 ETag 响应头（模拟服务器/CORS 不支持） */
  noEtag?: boolean;
  /** 基础路径，默认 /dav/ */
  basePath?: string;
  url?: string;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** 生成稳定的假 ETag（内容是版本号的函数，便于断言）。 */
let etagSeq = 0;

export class FakeDavServer {
  readonly url: string;
  readonly basePath: string;
  readonly files = new Map<string, FakeFile>();
  readonly requests: RecordedRequest[] = [];
  readonly meta = new Map<string, boolean>(); // 目录存在性（path → true）
  opts: FakeDavOptions;
  /** 下一次 PROPFIND 强制返回的状态码（用于故障注入） */
  failNextPropfind: number | null = null;
  /** 下一次 PUT 强制返回的状态码 */
  failNextPut: number | null = null;

  constructor(opts: FakeDavOptions = {}) {
    this.opts = opts;
    this.basePath = opts.basePath ?? '/dav';
    this.url = opts.url ?? `https://dav.test${this.basePath}`;
    // 目录默认存在，除非显式删除（模拟用户填了一个不存在的路径）
    this.meta.set(this.basePath, true);
  }

  /** 直接放置一个文件（测试夹具）。 */
  seed(path: string, body: string): string {
    etagSeq += 1;
    const etag = `"e${etagSeq}"`;
    this.files.set(path, { body, etag, lastModified: new Date(1700000000000 + etagSeq * 1000).toUTCString() });
    return etag;
  }

  seedRecord(name: string, value: unknown): string {
    return this.seed(`${this.basePath}/twische/records/${name}.json`, JSON.stringify(value));
  }

  etagOf(path: string): string | null {
    return this.files.get(path)?.etag ?? null;
  }

  get fetch(): FetchLike {
    return (input: string, init?: RequestInit) => this.handle(input, init);
  }

  private async handle(input: string, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = input;
    const path = decodeURIComponent(new URL(url).pathname);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    this.requests.push({ method, url, headers, body: init?.body as string | undefined });

    if (this.opts.failNetwork) throw new TypeError('Failed to fetch');
    if (this.opts.expectedAuth && headers.authorization !== this.opts.expectedAuth) {
      return new Response('Unauthorized', { status: 401 });
    }

    switch (method) {
      case 'OPTIONS':
        return this.options();
      case 'PROPFIND':
        return this.propfind(path, headers.depth ?? '0');
      case 'GET':
        return this.get(path);
      case 'PUT':
        return this.put(path, init, headers);
      case 'DELETE':
        return this.remove(path, headers);
      case 'MKCOL':
        return this.mkcol(path);
      default:
        return new Response('Method Not Allowed', { status: 405 });
    }
  }

  private options(): Response {
    if (this.opts.davHeader === null) return new Response(null, { status: 200 });
    return new Response(null, {
      status: 200,
      headers: {
        DAV: this.opts.davHeader ?? '1, 2, 3',
        Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND',
      },
    });
  }

  private propfind(path: string, depth: string): Response {
    if (this.failNextPropfind !== null) {
      const status = this.failNextPropfind;
      this.failNextPropfind = null;
      return new Response('injected', { status });
    }
    if (!this.dirExists(path)) return new Response('Not Found', { status: 404 });

    const entries: Array<{ path: string; collection: boolean }> = [{ path, collection: true }];
    if (depth !== '0') {
      for (const filePath of this.files.keys()) {
        if (filePath.startsWith(`${path}/`) && !filePath.slice(path.length + 1).includes('/')) {
          entries.push({ path: filePath, collection: false });
        }
      }
    }
    return new Response(this.multistatus(entries), {
      status: 207,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
  }

  private dirExists(path: string): boolean {
    if (this.meta.has(path)) return true;
    // 任何文件的祖先目录都算存在
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(`${path}/`)) return true;
    }
    return false;
  }

  private multistatus(entries: Array<{ path: string; collection: boolean }>): string {
    const parts = entries.map((entry) => {
      const file = this.files.get(entry.path);
      const props: string[] = ['<D:displayname>' + escapeXml(entry.path.split('/').pop() ?? '') + '</D:displayname>'];
      props.push(
        entry.collection
          ? '<D:resourcetype><D:collection/></D:resourcetype>'
          : '<D:resourcetype/>',
      );
      if (!entry.collection && file) {
        if (!this.opts.noEtag) props.push(`<D:getetag>${escapeXml(file.etag)}</D:getetag>`);
        props.push(`<D:getcontentlength>${file.body.length}</D:getcontentlength>`);
        props.push(`<D:getlastmodified>${file.lastModified}</D:getlastmodified>`);
      }
      return (
        '<D:response>' +
        `<D:href>${escapeXml(encodeURI(entry.path))}</D:href>` +
        `<D:propstat><D:prop>${props.join('')}</D:prop>` +
        '<D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
        '</D:response>'
      );
    });
    return (
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<D:multistatus xmlns:D="DAV:">' +
      parts.join('') +
      '</D:multistatus>'
    );
  }

  private get(path: string): Response {
    const file = this.files.get(path);
    if (!file) return new Response('Not Found', { status: 404 });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Last-Modified': file.lastModified,
    };
    if (!this.opts.noEtag) headers.ETag = file.etag;
    return new Response(file.body, { status: 200, headers });
  }

  private put(path: string, init: RequestInit | undefined, headers: Record<string, string>): Response {
    if (this.failNextPut !== null) {
      const status = this.failNextPut;
      this.failNextPut = null;
      return new Response('injected', { status });
    }
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (!this.dirExists(parent)) return new Response('Conflict', { status: 409 });

    const existing = this.files.get(path);
    if (headers['if-none-match'] === '*' && existing) return new Response('Precondition Failed', { status: 412 });
    if (headers['if-match'] && (!existing || existing.etag !== headers['if-match'])) {
      return new Response('Precondition Failed', { status: 412 });
    }

    etagSeq += 1;
    const etag = `"e${etagSeq}"`;
    this.files.set(path, {
      body: String(init?.body ?? ''),
      etag,
      lastModified: new Date(1700000000000 + etagSeq * 1000).toUTCString(),
    });
    const resHeaders: Record<string, string> = {};
    if (!this.opts.noEtag) resHeaders.ETag = etag;
    return new Response(null, { status: existing ? 204 : 201, headers: resHeaders });
  }

  private remove(path: string, headers: Record<string, string>): Response {
    const existing = this.files.get(path);
    if (!existing) return new Response('Not Found', { status: 404 });
    if (headers['if-match'] && existing.etag !== headers['if-match']) {
      return new Response('Precondition Failed', { status: 412 });
    }
    this.files.delete(path);
    return new Response(null, { status: 204 });
  }

  private mkcol(path: string): Response {
    if (this.dirExists(path)) return new Response('Method Not Allowed', { status: 405 });
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (!this.dirExists(parent)) return new Response('Conflict', { status: 409 });
    this.meta.set(path, true);
    return new Response(null, { status: 201 });
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

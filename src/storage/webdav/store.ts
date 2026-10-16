/**
 * WebDAV 上的记录存储布局。
 *
 * ```
 * {用户给的地址}/
 * ├── meta.json                 存储自述，用于识别「这个目录是 Twische 的」
 * └── records/
 *     ├── <id>.json             一条记录一个文件，内容与旧服务端的 records 行完全一致
 *     └── …
 * ```
 *
 * 一个记录一个文件是刻意的：WebDAV 的并发控制（ETag）与增量发现（PROPFIND）都以
 * 资源为粒度。若把所有记录塞进一个大 JSON，两台设备同时写就必然互相覆盖，
 * 而且每次同步都要把整个集合读一遍。
 */
import { DavClient, DavError, isDavError } from './client';
import { normalizeHref } from './xml';
import type { RecordKind } from '@/domain/types';

export const STORE_ROOT = 'twische';
export const RECORDS_DIR = 'records';
export const META_FILE = 'meta.json';

/** 落盘的记录形状 —— 与旧服务端 `records` 表的字段一一对应，便于无损迁移。 */
export interface StoredRecord {
  id: string;
  kind: RecordKind;
  data: unknown;
  vc: Record<string, number>;
  updatedAt: number;
  deleted?: boolean;
}

export interface DavFileRef {
  id: string;
  /** 规范化后的绝对 URL */
  url: string;
  /** 服务器给的 ETag；服务器没返回时为 null（此时不能带 If-Match） */
  etag: string | null;
  /**
   * 变更检测用的版本指纹：优先 ETag，服务器不给时退回 Last-Modified。
   * 两者都没有时为空串 —— 那意味着每轮同步都得把这个文件读回来比对，
   * 正确性不受影响，只是变慢。
   */
  version: string;
}

export interface StoreMeta {
  format: 'twische-store';
  version: number;
  createdAt: number;
  app: string;
}

export function newStoreMeta(now = Date.now()): StoreMeta {
  return { format: 'twische-store', version: 1, createdAt: now, app: 'twische-nxt' };
}

/** 版本指纹：ETag 优先，其次 Last-Modified，都没有就给空串（每次都重新读）。 */
export function versionOf(etag: string | null, lastModified: string | null): string {
  if (etag) return `e:${etag}`;
  if (lastModified) return `t:${lastModified}`;
  return '';
}

/** 文件名编码：id 里可能出现 `|`（打卡记录）等对 URL 有特殊含义的字符。 */
export function encodeRecordId(id: string): string {
  return encodeURIComponent(id);
}

export function decodeRecordFileName(fileName: string): string | null {
  if (!fileName.endsWith('.json')) return null;
  const raw = fileName.slice(0, -'.json'.length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * 校验一条记录是否可以落盘。
 *
 * 宁可在这里拒绝，也不要往用户服务器上写半条坏数据 —— WebDAV 那边没有服务端校验，
 * 我们就是最后一道关。返回问题列表，空数组表示通过。
 */
export function validateStoredRecord(rec: unknown): string[] {
  const errs: string[] = [];
  if (!rec || typeof rec !== 'object') return ['记录必须是对象'];
  const r = rec as Partial<StoredRecord>;
  if (typeof r.id !== 'string' || !r.id) errs.push('缺少 id');
  else if (r.id.length > 200) errs.push('id 过长');
  if (r.kind !== 'task' && r.kind !== 'completion') errs.push(`未知的记录类型「${String(r.kind)}」`);
  if (r.data === undefined) errs.push('缺少 data');
  if (!r.vc || typeof r.vc !== 'object' || Array.isArray(r.vc)) errs.push('vc 必须是对象');
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) errs.push('updatedAt 必须是数字');
  return errs;
}

/** 解析一条记录文件；损坏时抛 DavError，而不是安静返回 null。 */
export function parseStoredRecord(text: string, hint: string): StoredRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DavError('bad-response', `${hint} 不是合法 JSON`, { detail: text.slice(0, 200) });
  }
  const errs = validateStoredRecord(parsed);
  if (errs.length > 0) {
    throw new DavError('bad-response', `${hint} 内容不合法：${errs.join('；')}`, {
      detail: text.slice(0, 200),
    });
  }
  return parsed as StoredRecord;
}

export class WebDavStore {
  readonly client: DavClient;
  readonly root: string;

  constructor(client: DavClient, root: string = STORE_ROOT) {
    this.client = client;
    this.root = root.replace(/^\/+|\/+$/g, '');
  }

  get recordsDirUrl(): string {
    return this.client.resolve(`${this.root}/${RECORDS_DIR}`);
  }

  get metaUrl(): string {
    return this.client.resolve(`${this.root}/${META_FILE}`);
  }

  urlFor(id: string): string {
    return `${this.recordsDirUrl}/${encodeRecordId(id)}.json`;
  }

  /** 从 PROPFIND 返回的 href 反推记录 id；不是记录文件时返回 null。 */
  idFromHref(href: string): string | null {
    const path = normalizeHref(href, this.recordsDirUrl);
    const base = path.split('/').filter(Boolean).pop() ?? '';
    return decodeRecordFileName(base);
  }

  /**
   * 确保存储目录存在（幂等）。
   *
   * 每次都把两级目录都 MKCOL 一遍：服务器会用 405 告诉我们「已经有了」，
   * 这比先 PROPFIND 再决定要不要建少一次往返，也不会出现
   * 「根目录在、records/ 被手工删掉」这种半残状态。
   */
  async ensure(): Promise<{ created: boolean }> {
    const createdRoot = await this.client.mkcol(this.client.resolve(this.root));
    const createdRecords = await this.client.mkcol(this.recordsDirUrl);
    return { created: createdRoot || createdRecords };
  }

  /** 写/更新存储自述文件；已存在就跳过，避免无意义地改写服务器上的内容。 */
  async writeMetaIfAbsent(meta: StoreMeta = newStoreMeta()): Promise<void> {
    try {
      await this.client.get(this.metaUrl);
      return;
    } catch (err) {
      if (!isDavError(err) || err.kind !== 'not-found') throw err;
    }
    await this.client.put(this.metaUrl, JSON.stringify(meta, null, 2), { ifNoneMatch: '*' });
  }

  /**
   * 列出目录下所有记录文件及其 ETag。
   *
   * 这是增量同步的锚点：本地保存上一次的 `id → etag` 映射，
   * 下一轮只需比较 ETag 就知道哪些文件变了、哪些消失了。
   */
  async list(): Promise<Map<string, DavFileRef>> {
    const responses = await this.client.propfind(this.recordsDirUrl, 1);
    const out = new Map<string, DavFileRef>();
    for (const res of responses) {
      if (!res.ok || res.isCollection) continue;
      const id = this.idFromHref(res.href);
      if (id === null) continue;
      out.set(id, { id, url: this.urlFor(id), etag: res.etag, version: versionOf(res.etag, res.lastModified) });
    }
    return out;
  }

  async read(id: string): Promise<{ record: StoredRecord; ref: DavFileRef }> {
    const url = this.urlFor(id);
    const { body, etag, lastModified } = await this.client.get(url);
    return {
      record: parseStoredRecord(body, `记录 ${id}`),
      ref: { id, url, etag, version: versionOf(etag, lastModified) },
    };
  }

  /**
   * 写入一条记录。
   *
   * `opts.etag` 给了就带 `If-Match`（版本没变才写），`null` 表示本地认为资源不存在、
   * 带 `If-None-Match: *`。服务器不支持 ETag 时这两个头会被忽略，写入照样成功 ——
   * 并发收敛靠向量时钟，不靠 ETag（见 DESIGN.md §3.3）。
   */
  async write(record: StoredRecord, opts: { etag?: string | null } = {}): Promise<DavFileRef> {
    const errs = validateStoredRecord(record);
    if (errs.length > 0) {
      throw new DavError('bad-response', `拒绝写入不合法的记录：${errs.join('；')}`);
    }
    const url = this.urlFor(record.id);
    const body = JSON.stringify(record);
    const hasEtag = Object.prototype.hasOwnProperty.call(opts, 'etag');
    const { etag, lastModified } = await this.client.put(url, body, {
      ifMatch: hasEtag ? opts.etag ?? null : null,
      ifNoneMatch: hasEtag && opts.etag === null ? '*' : undefined,
    });
    return { id: record.id, url, etag, version: versionOf(etag, lastModified) };
  }

  async remove(id: string, etag?: string | null): Promise<void> {
    await this.client.remove(this.urlFor(id), { ifMatch: etag });
  }

  /**
   * 连接自检：这是不是 WebDAV、认证是否通过、目录能不能建/能读。
   *
   * 返回 `capabilities` 供上层做降级决策（例如拿不到 ETag 时仍然继续，
   * 只是并发窗口变大）。
   */
  async probe(): Promise<{
    davClasses: string[];
    allow: string[];
    recordCount: number;
    etagReadable: boolean;
    created: boolean;
  }> {
    const { dav, allow } = await this.client.options();
    // 允许服务器把小写或带引号的值写进 DAV 头
    const classes = dav.map((v) => v.replace(/"/g, '').trim()).filter(Boolean);
    const supportsDav = classes.length > 0 && classes.some((c) => /^\d/.test(c));
    if (!supportsDav) {
      throw new DavError('not-dav', '该地址没有返回 DAV 响应头，可能不是 WebDAV 服务');
    }

    const { created } = await this.ensure();
    const files = await this.list();
    let etagReadable = files.size > 0 ? [...files.values()].some((f) => f.etag !== null) : false;
    if (files.size === 0) {
      // 目录是空的时没法从列表判断，用自述文件探一次
      try {
        const { etag } = await this.client.get(this.metaUrl);
        etagReadable = etag !== null;
      } catch {
        etagReadable = false;
      }
    }

    return { davClasses: classes, allow, recordCount: files.size, etagReadable, created };
  }
}

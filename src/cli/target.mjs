/**
 * WebDAV 写入端（仅 CLI 使用）。
 *
 * 与浏览器端 `src/storage/webdav/*` 刻意保持两份实现，而不是共享：
 * 浏览器那份依赖 DOMParser 与 AbortController 的浏览器语义，Node 没有 DOMParser；
 * 为了共享而把两边都改成半吊子的抽象，代价比这 200 行更大。
 * **两边必须写出完全一致的存储布局**（`twische/records/<id>.json`），
 * 这条约束由 `migrate.test.ts` 里的"浏览器写入 → CLI 读取"往返用例守住。
 */

export class TargetError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'TargetError';
    this.status = opts.status ?? 0;
    this.href = opts.href ?? '';
  }
}

export const STORE_ROOT = 'twische';
export const RECORDS_DIR = 'records';

export function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export function normalizeBaseUrl(url) {
  return url.trim().replace(/\/+$/, '');
}

/** 落盘用的规范化形状：与浏览器端 StoredRecord 一致（丢掉 seq 之类的旧字段）。 */
export function toStored(record) {
  return {
    id: record.id,
    kind: record.kind,
    data: record.data ?? {},
    vc: record.vc,
    updatedAt: record.updatedAt,
    deleted: !!record.deleted,
  };
}

/** 内容是否一致（决定 skip 还是覆盖）。字段顺序无关，因为都是我们自己序列化的。 */
export function sameRecord(a, b) {
  return JSON.stringify(toStored(a)) === JSON.stringify(toStored(b));
}

function requireOk(res, href) {
  if (res.ok) return res;
  const kind = res.status === 401 ? '认证失败' : res.status === 403 ? '没有权限' : `HTTP ${res.status}`;
  throw new TargetError(`${kind}：${href}`, { status: res.status, href });
}

export function createTarget({ url, username, password, fetchImpl }) {
  const base = normalizeBaseUrl(url);
  const authorization = basicAuth(username, password);
  const doFetch = fetchImpl ?? fetch;
  const headers = { Authorization: authorization };

  return {
    base,
    href(rel) {
      return `${base}/${rel.replace(/^\/+/, '')}`;
    },
    recordHref(id) {
      return `${base}/${STORE_ROOT}/${RECORDS_DIR}/${encodeURIComponent(id)}.json`;
    },
    async request(method, href, init = {}) {
      return doFetch(href, { method, headers: { ...headers, ...(init.headers ?? {}) }, body: init.body });
    },
    /** MKCOL：405 表示已存在，算成功；409 表示父目录不存在，必须报错。 */
    async mkcol(href) {
      const res = await this.request('MKCOL', href);
      if (res.ok || res.status === 405) return;
      if (res.status === 409) {
        throw new TargetError(`父目录不存在：${href}（请检查 --to 填的路径）`, { status: 409, href });
      }
      requireOk(res, href);
    },
    async ensure() {
      await this.mkcol(this.href(STORE_ROOT));
      await this.mkcol(this.href(`${STORE_ROOT}/${RECORDS_DIR}`));
    },
    async get(href) {
      const res = await this.request('GET', href);
      if (res.status === 404) return null;
      requireOk(res, href);
      return res.text();
    },
    async put(href, body) {
      const res = await this.request('PUT', href, {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body,
      });
      requireOk(res, href);
    },
    async remove(href) {
      const res = await this.request('DELETE', href);
      if (res.status === 404) return;
      requireOk(res, href);
    },
    /**
     * 列出记录文件。
     *
     * CLI 只需要 href 与 ETag，用最朴素的解析即可 —— 不值得为它引入 XML 依赖。
     * 浏览器那份用 DOMParser 是因为它本来就在浏览器里跑。
     */
    async list() {
      // 不带尾斜杠：与浏览器端 WebDavStore.recordsDirUrl 保持一致，
      // 少了这个一致性，某些服务器会把两者当成不同的资源
      const href = `${base}/${STORE_ROOT}/${RECORDS_DIR}`;
      const res = await this.request('PROPFIND', href, {
        headers: { 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' },
        body:
          '<?xml version="1.0" encoding="utf-8"?>' +
          '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:resourcetype/></D:prop></D:propfind>',
      });
      if (res.status === 404) return [];
      requireOk(res, href);
      const xml = await res.text();
      const out = [];
      for (const block of xml.split(/<\w*:?response[\s>]/i).slice(1)) {
        const raw = /<\w*:?href[^>]*>([\s\S]*?)<\/\w*:?href>/i.exec(block);
        if (!raw) continue;
        const path = decodeURIComponent(raw[1]);
        if (path.endsWith('/')) continue; // 集合自身
        const name = path.split('/').filter(Boolean).pop() ?? '';
        if (!name.endsWith('.json')) continue;
        out.push({ id: decodeURIComponent(name.slice(0, -'.json'.length)), href: this.recordHref(decodeURIComponent(name.slice(0, -5))) });
      }
      return out;
    },
  };
}

/**
 * 把记录写进 WebDAV。
 *
 * 幂等策略：先 GET 目标，内容一致就跳过（`--on-conflict skip` 默认），
 * 不一致则按 `--on-conflict` 决定覆盖还是保留。因此中断后重跑是安全的。
 */
export async function pushRecords(target, records, opts = {}) {
  const onConflict = opts.onConflict ?? 'skip';
  const dryRun = !!opts.dryRun;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const onProgress = opts.onProgress;
  const summary = { created: 0, skipped: 0, overwritten: 0, kept: 0, failed: [] };

  if (!dryRun) await target.ensure();

  let index = 0;
  async function worker() {
    for (;;) {
      const i = index++;
      if (i >= records.length) return;
      const record = toStored(records[i]);
      const href = target.recordHref(record.id);
      try {
        const existing = dryRun ? null : await target.get(href);
        if (existing === null) {
          if (!dryRun) await target.put(href, JSON.stringify(record));
          summary.created += 1;
        } else {
          let parsed = null;
          try {
            parsed = JSON.parse(existing);
          } catch {
            parsed = null;
          }
          if (parsed && sameRecord(parsed, record)) {
            summary.skipped += 1;
          } else if (onConflict === 'overwrite') {
            if (!dryRun) await target.put(href, JSON.stringify(record));
            summary.overwritten += 1;
          } else {
            summary.kept += 1;
          }
        }
      } catch (err) {
        summary.failed.push({ id: record.id, reason: err instanceof Error ? err.message : String(err) });
      }
      onProgress?.(summary);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, records.length || 1) }, worker));
  return summary;
}

/**
 * 清理过期墓碑。
 *
 * 墓碑在同步里承担"告诉其它设备这条被删了"的职责，所以不能立刻物理删除；
 * 但也不能永远留着 —— 服务器上的文件数会一直涨。默认只清 90 天前的。
 */
export async function pruneTombstones(target, opts = {}) {
  const olderThanMs = opts.olderThanMs ?? 90 * 24 * 3600 * 1000;
  const cutoff = Date.now() - olderThanMs;
  const dryRun = !!opts.dryRun;
  const listed = await target.list();
  const summary = { scanned: listed.length, pruned: 0, kept: 0, failed: [] };

  for (const item of listed) {
    try {
      const text = await target.get(item.href);
      if (text === null) continue;
      const record = JSON.parse(text);
      if (!record.deleted) {
        summary.kept += 1;
        continue;
      }
      if (typeof record.updatedAt === 'number' && record.updatedAt > cutoff) {
        summary.kept += 1;
        continue;
      }
      if (!dryRun) await target.remove(item.href);
      summary.pruned += 1;
    } catch (err) {
      summary.failed.push({ id: item.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return summary;
}

/**
 * 本地导出 / 导入。
 *
 * 格式与 v1 服务端的 `GET /api/account/export` 保持一致，这样：
 * - 从旧服务器导出的文件可以直接导入本版；
 * - 本版导出的文件也能喂给 CLI 迁移工具。
 *
 * 记录里带向量时钟，所以导入不是"覆盖"，而是走一次正常的合并 ——
 * 从备份恢复、把数据搬到另一台设备，用的都是同一条路径。
 */
import {
  applyRemoteRecord,
  allRecords,
  getRecord,
  persistRecords,
  type LocalRecord,
  type WireRecord,
} from './localrepo';
import { validateStoredRecord, type StoredRecord } from '@/storage/webdav/store';

export interface ExportFile {
  format: 'twische-export';
  version: 1;
  exportedAt: number;
  app: string;
  records: StoredRecord[];
}

/** 把本地记录转成导出文件的内容（顺序稳定，便于比对）。 */
export function buildExport(records: LocalRecord[] = allRecords()): ExportFile {
  return {
    format: 'twische-export',
    version: 1,
    exportedAt: Date.now(),
    app: 'twische-nxt',
    records: [...records]
      // id 是 Map 的键，天然唯一，因此不需要相等分支
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        data: r.data,
        vc: r.vc,
        updatedAt: r.updatedAt,
        deleted: !!r.deleted,
      })),
  };
}

export interface ParseResult {
  records: WireRecord[];
  /** 被跳过的条目与原因（未知类型、字段不合法），导入后要如实告诉用户 */
  skipped: Array<{ id: string; reason: string }>;
}

/** 解析导出文件；结构不对时抛错而不是安静地导入一半。 */
export function parseExport(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('文件不是合法的 JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('文件内容不是对象');
  const file = parsed as Partial<ExportFile>;
  if (!Array.isArray(file.records)) throw new Error('文件里没有 records 数组');

  const records: WireRecord[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const raw of file.records) {
    const id = raw && typeof raw === 'object' && typeof (raw as StoredRecord).id === 'string' ? (raw as StoredRecord).id : '(无 id)';
    const errs = validateStoredRecord(raw);
    if (errs.length > 0) {
      skipped.push({ id, reason: errs.join('；') });
      continue;
    }
    const rec = raw as StoredRecord;
    records.push({
      id: rec.id,
      kind: rec.kind,
      data: (rec.data ?? {}) as Record<string, unknown>,
      vc: rec.vc,
      updatedAt: rec.updatedAt,
      deleted: !!rec.deleted,
    });
  }
  return { records, skipped };
}

/**
 * 导入记录。
 *
 * 关键点：导入的记录一律标记为「待推送」。
 * 否则它们会被同步引擎当成"远端已删除"而从本地清掉 —— 导入的数据还没来得及
 * 上传就在下一轮同步里消失了，这是最不能接受的一类 bug。
 */
export async function importRecords(records: WireRecord[]): Promise<{ imported: number }> {
  const touched = new Map<string, LocalRecord>();

  for (const rec of records) {
    applyRemoteRecord(rec);
    // applyRemoteRecord 一定会写入这条记录（新建或更新），所以这里必然存在
    const after = getRecord(rec.id)!;
    after.dirty = true;
    // 本地没有对应的远端版本，必须把版本指纹清掉，否则会带着上一台的 ETag
    // 去发 If-Match，换来一串 412。
    after.version = null;
    after.etag = null;
    touched.set(after.id, after);
  }

  await persistRecords([...touched.values()]);
  return { imported: touched.size };
}

/** 触发浏览器下载（仅浏览器环境可用）。 */
export function downloadExport(file: ExportFile, filename?: string): void {
  const name = filename ?? `twische-export-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 立刻 revoke 会让部分浏览器来不及开始下载，推迟一拍
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

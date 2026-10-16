/**
 * 远端存储的抽象接口。
 *
 * 只抽一层、只留一个实现（WebDAV），不是为了「将来支持很多后端」而抽象，
 * 而是为了让同步引擎与测试都依赖一个稳定的契约：CLI 可以复用同一套映射逻辑，
 * 测试可以塞进内存实现，UI 也不必知道 WebDAV 的细节。
 */
import type { DavFileRef, StoredRecord } from './webdav/store';

export interface RemoteBackend {
  /** 幂等地准备存储目录。`created` 表示这次真的建了目录（用于首次连接提示）。 */
  ensure(): Promise<{ created: boolean }>;
  /** 远端全部记录文件的版本指纹。这是增量同步的锚点。 */
  list(): Promise<Map<string, DavFileRef>>;
  read(id: string): Promise<{ record: StoredRecord; ref: DavFileRef }>;
  write(record: StoredRecord, opts?: { etag?: string | null }): Promise<DavFileRef>;
  remove(id: string, etag?: string | null): Promise<void>;
}

export type { DavFileRef, StoredRecord };

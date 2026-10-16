/**
 * 同步引擎（客户端侧）。
 *
 * 一轮同步 = 先把本地脏记录推上去，再把远端变化的文件拉下来。
 * 采用"推送优先"的顺序：本地改动先落地到远端，随后的拉取就会带回
 * 合并后的权威版本，一轮之内两端对齐。
 *
 * 与 v1 的差别只在传输层：远端从 `POST /api/sync` 换成 WebDAV 的
 * PROPFIND / GET / PUT。合并规则（向量时钟）一字未改，只是裁决者从服务端
 * 变成了客户端自己 —— 用的还是同一份 `domain/vector.js`。
 *
 * 三种异常各有各的处理：
 * - 网络不通（含跨域被拒）→ 静默退避重试，界面照常可用
 * - 凭据失效 → 停止重试并通知界面，继续重试毫无意义
 * - 服务器明确拒绝（403/409/400）→ 重试也不会变好，报错并停下
 */
import { isDavError } from '@/storage/webdav/client';
import type { RemoteBackend, StoredRecord } from '@/storage/backend';
import {
  applyRemoteBatch,
  applyRemoteRecord,
  dirtyRecords,
  dropRecords,
  getRecord,
  markSynced,
  setLastSyncAt,
  setSyncError,
  state as repo,
  type LocalRecord,
  type WireRecord,
} from './localrepo';

export type SyncPhase = 'idle' | 'pushing' | 'pulling' | 'rebuilding';

export interface SyncState {
  running: boolean;
  /** 运行中又来了请求：记下来，本轮结束后再跑一次 */
  queued: boolean;
  phase: SyncPhase;
  lastError: string;
  lastTookMs: number;
  lastPushedCount: number;
  lastPulledCount: number;
  lastConflictCount: number;
  /** 本轮同步删掉了多少条（远端已删） */
  lastRemovedCount: number;
  /** 最近一次成功的同步是否发生了真冲突，用于在设置页提示 */
  hadConflict: boolean;
  online: boolean;
  /** 凭据失效，由 session store 监听 */
  unauthorized: boolean;
  /** 还没连过任何服务器 */
  unconfigured: boolean;
  nextRetryIn: number;
}

const listeners = new Set<() => void>();

/** 订阅同步状态变化。返回取消函数。 */
export function subscribeSync(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(): void {
  for (const fn of listeners) fn();
}

export const syncState: SyncState = {
  running: false,
  queued: false,
  phase: 'idle',
  lastError: '',
  lastTookMs: 0,
  lastPushedCount: 0,
  lastPulledCount: 0,
  lastConflictCount: 0,
  lastRemovedCount: 0,
  hadConflict: false,
  // SSR 防御：Node 侧无 navigator；浏览器包里恒走右侧
  /* v8 ignore next */
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  unauthorized: false,
  unconfigured: true,
  nextRetryIn: 0,
};

/** 一批处理多少条记录。 */
const BATCH = 100;
/** 拉取时并发多少个 GET。 */
const FETCH_CONCURRENCY = 8;

let backend: RemoteBackend | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 3000;
let onlineListenersBound = false;
/** 本次会话遇到的并发冲突次数（跨轮累计）。 */
let conflictCount = 0;

/** 注入/切换远端后端；传 null 表示断开（退出登录）。 */
export function setBackend(next: RemoteBackend | null): void {
  backend = next;
  syncState.unconfigured = next === null;
  notify();
}

export function getBackend(): RemoteBackend | null {
  return backend;
}

// ───────────────────────── 映射 ─────────────────────────

export function toStored(r: LocalRecord): StoredRecord {
  return {
    id: r.id,
    kind: r.kind,
    data: r.data,
    vc: r.vc,
    updatedAt: r.updatedAt,
    deleted: !!r.deleted,
  };
}

export function toWire(rec: StoredRecord, ref: { version: string; etag: string | null }): WireRecord {
  return {
    id: rec.id,
    kind: rec.kind,
    data: (rec.data ?? {}) as Record<string, unknown>,
    vc: rec.vc,
    updatedAt: rec.updatedAt,
    deleted: !!rec.deleted,
    version: ref.version,
    etag: ref.etag,
  };
}

// ───────────────────────── 推送 ─────────────────────────

/** 写一条记录并采纳远端返回的版本指纹。 */
async function writeAndMark(store: RemoteBackend, r: LocalRecord, etag: string | null): Promise<boolean> {
  const ref = await store.write(toStored(r), { etag });
  await markSynced(r.id, ref);
  syncState.lastPushedCount += 1;
  return true;
}

/**
 * 推送一条记录。返回"这条是否已经处理完（不再脏）"。
 *
 * 412 是唯一的"正常失败"：说明这个文件在我们上次读取之后被别人改过（或删掉了）。
 * 正确处理是先看远端现在是什么、用向量时钟裁决，再决定要不要重写一次 ——
 * 直接重试会在两台设备同时编辑时来回覆盖。
 */
async function pushOne(store: RemoteBackend, r: LocalRecord): Promise<boolean> {
  try {
    return await writeAndMark(store, r, r.etag ?? null);
  } catch (err) {
    if (!isDavError(err) || !err.isPrecondition) throw err;

    let remote: WireRecord | null = null;
    try {
      const { record, ref } = await store.read(r.id);
      remote = toWire(record, ref);
    } catch (readErr) {
      // 文件已经不在了：别的设备删掉了它，而本地还在编辑 —— 当作新建重推，
      // 否则这条本地改动会永远卡在 412 上。
      if (!isDavError(readErr) || readErr.kind !== 'not-found') throw readErr;
    }

    if (remote) applyRemoteRecord(remote);
    const after = getRecord(r.id);
    if (!after?.dirty) return false;
    if (!remote) {
      after.etag = null;
      after.version = null;
    }

    try {
      const done = await writeAndMark(store, after, after.etag ?? null);
      syncState.lastConflictCount += 1;
      syncState.hadConflict = true;
      conflictCount += 1;
      return done;
    } catch (retryErr) {
      // 又被抢先了：留给下一轮，不要让它把整轮同步拖垮
      if (isDavError(retryErr) && retryErr.isPrecondition) return false;
      throw retryErr;
    }
  }
}

/**
 * 把所有脏记录推上去。
 *
 * 终止性是构造保证的，不需要额外的轮次上限：每处理完一条，它要么变成干净的
 * （markSynced 清掉 dirty），要么留在脏里；一旦一整批全都没能推进，
 * 说明剩下的都在冲突里打转，直接停手留给下一轮同步。
 * 因此每轮要么严格减少脏记录数，要么立刻退出。
 */
async function pushAll(store: RemoteBackend): Promise<void> {
  syncState.phase = 'pushing';
  notify();

  for (;;) {
    const batch = dirtyRecords(BATCH);
    if (batch.length === 0) return;

    let progressed = false;
    for (const r of batch) {
      if (await pushOne(store, r)) progressed = true;
    }
    if (!progressed) return;
  }
}

// ───────────────────────── 拉取 ─────────────────────────

async function fetchOne(store: RemoteBackend, id: string): Promise<WireRecord> {
  const { record, ref } = await store.read(id);
  return toWire(record, ref);
}

/** 把要拉取的 id 分批并发读回来并应用。 */
async function pullRecords(store: RemoteBackend, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += FETCH_CONCURRENCY) {
    const chunk = ids.slice(i, i + FETCH_CONCURRENCY);
    const wire = await Promise.all(chunk.map((id) => fetchOne(store, id)));
    await applyRemoteBatch(wire);
    syncState.lastPulledCount += wire.length;
    notify();
  }
}

async function pullAll(store: RemoteBackend): Promise<void> {
  syncState.phase = 'pulling';
  notify();

  const files = await store.list();
  const changed: string[] = [];
  for (const [id, ref] of files) {
    const local = getRecord(id);
    // 本地没有 → 新记录；版本不同 → 远端改过；版本为空 → 服务器不给版本标识，
    // 只能每次都读回来比对（内容相同会被向量时钟判为 unchanged，不产生副作用）
    if (!local || local.version !== ref.version || ref.version === '') changed.push(id);
  }
  if (changed.length > 0) await pullRecords(store, changed);

  // 远端已经没有的文件 = 被别的设备删掉了（或墓碑已被清理）。
  // 本地仍有未推送改动的记录要保住 —— 那是用户的编辑，不能被一次同步抹掉。
  const removed: string[] = [];
  for (const [id, r] of repo.records) {
    if (files.has(id)) continue;
    if (r.dirty) continue;
    removed.push(id);
  }
  if (removed.length > 0) {
    await dropRecords(removed);
    syncState.lastRemovedCount += removed.length;
    notify();
  }

}

/**
 * 实际上网跑一轮同步。抛出的异常由 syncNow 统一处理。
 *
 * 不需要"完整性自检 + 全量重建"这一步（v1 有，是因为服务端的增量游标可能漏记录）：
 * PROPFIND 每轮都返回远端的**完整**集合，拉取阶段已经保证
 * 「本地缺的补回来、远端没有的清掉」，两侧集合在无错时必然相等。
 * 少一次全量重建，也就少了一整类"重建把本地数据抹掉"的故障。
 */
async function runSync(store: RemoteBackend): Promise<void> {
  await store.ensure();
  await pushAll(store);
  await pullAll(store);
}

// ───────────────────────── 调度 ─────────────────────────

function clearRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (syncState.nextRetryIn !== 0) {
    syncState.nextRetryIn = 0;
    notify();
  }
}

/** 网络恢复后按指数退避重试；不打扰用户，只是安静地补齐。 */
function scheduleRetry(): void {
  clearRetry();
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, 120_000);
  syncState.nextRetryIn = Math.ceil(delay / 1000);
  notify();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    syncState.nextRetryIn = 0;
    notify();
    void syncNow({ silent: true });
  }, delay);
}

export function bindOnlineListeners(): void {
  if (onlineListenersBound || typeof window === 'undefined') return;
  onlineListenersBound = true;

  window.addEventListener('online', () => {
    syncState.online = true;
    notify();
    retryDelay = 3000;
    clearRetry();
    void syncNow({ silent: true });
  });

  window.addEventListener('offline', () => {
    syncState.online = false;
    notify();
  });

  // 从后台切回前台时补一次同步：移动端最典型的"错过同步"场景
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && syncState.online) {
      void syncNow({ silent: true });
    }
  });
}

export interface SyncOptions {
  /** 静默模式下失败不弹提示，只更新状态 */
  silent?: boolean;
}

/**
 * 触发一次同步。并发调用会被折叠：后到的请求只置一个标记，
 * 本轮结束后自动再跑一次，因此短时间内连续改动不会打出成串请求。
 */
export async function syncNow(opts: SyncOptions = {}): Promise<boolean> {
  if (syncState.running) {
    syncState.queued = true;
    return false;
  }
  if (syncState.unauthorized) return false;
  const store = backend;
  if (!store) {
    syncState.unconfigured = true;
    return false;
  }

  syncState.running = true;
  syncState.queued = false;
  syncState.lastError = '';
  syncState.lastPushedCount = 0;
  syncState.lastPulledCount = 0;
  syncState.lastConflictCount = 0;
  syncState.lastRemovedCount = 0;
  syncState.hadConflict = false;
  notify();

  const startedAt = Date.now();
  let ok = true;

  try {
    await runSync(store);
    setLastSyncAt(Date.now());
    setSyncError('');
    syncState.online = true;
    retryDelay = 3000;
    clearRetry();
  } catch (err) {
    ok = false;
    const message = err instanceof Error ? err.message : String(err);
    syncState.lastError = message;
    setSyncError(message);

    if (isDavError(err)) {
      if (err.isAuth) {
        // 凭据失效：停掉重试，交给会话层处理
        syncState.unauthorized = true;
        clearRetry();
      } else if (err.isNetwork) {
        syncState.online = false;
        scheduleRetry();
      } else {
        // 服务器明确拒绝（校验失败、路径不对等）：重试也不会变好。
        // 但它毕竟回应了，说明网络是通的 —— 顺手把可能存在的离线误判纠正回来。
        syncState.online = true;
        clearRetry();
      }
    } else {
      clearRetry();
    }
  } finally {
    syncState.running = false;
    syncState.phase = 'idle';
    syncState.lastTookMs = Date.now() - startedAt;
    notify();
  }

  if (syncState.queued) {
    syncState.queued = false;
    void syncNow({ silent: true });
  }

  return ok;
}

/** 本地改动之后调用：先乐观更新界面，再后台推送。 */
export function requestSync(): void {
  if (syncState.unauthorized) return;
  void syncNow({ silent: true });
}

/** 退出登录 / 切换账户时停止一切后台活动。 */
export function stopSync(): void {
  clearRetry();
  syncState.running = false;
  syncState.queued = false;
  syncState.unauthorized = false;
  syncState.lastError = '';
  syncState.phase = 'idle';
  retryDelay = 3000;
  notify();
}

/** 本次会话中发生的真冲突次数（跨轮累计）。 */
export function conflictTotal(): number {
  return conflictCount;
}

/** 仅供测试：重置模块级状态。 */
export function __resetSyncForTest(): void {
  clearRetry();
  backend = null;
  conflictCount = 0;
  retryDelay = 3000;
  onlineListenersBound = false;
  syncState.running = false;
  syncState.queued = false;
  syncState.phase = 'idle';
  syncState.lastError = '';
  syncState.lastTookMs = 0;
  syncState.lastPushedCount = 0;
  syncState.lastPulledCount = 0;
  syncState.lastConflictCount = 0;
  syncState.lastRemovedCount = 0;
  syncState.hadConflict = false;
  syncState.unauthorized = false;
  syncState.unconfigured = true;
  syncState.nextRetryIn = 0;
  syncState.online = true;
}

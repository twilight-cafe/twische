/**
 * 同步引擎（客户端侧）。
 *
 * 一轮同步 = 先把本地脏记录推上去，再把游标之后的服务端记录拉下来。
 * 采用"推送优先"的顺序：本地改动先落地到服务端，随后的拉取就会带回
 * 合并后的权威版本，一轮之内两端对齐。
 *
 * 三种异常各有各的处理：
 * - 网络不通 → 静默退避重试，界面照常可用（本地优先的意义就在这）
 * - 登录失效 → 停止重试并通知界面，继续重试毫无意义
 * - 落后过多 → 服务端墓碑已清理，增量不可靠，改走全量重建
 */
import { api, ApiError, type SyncResponse, type WireRecordPayload } from './api';
import {
  adoptRemoteRecord,
  applyRemoteBatch,
  dirtyCount,
  dirtyRecords,
  fullRebuild,
  getRecord,
  liveRecords,
  markSynced,
  setCursor,
  setFloorSeq,
  setLastSyncAt,
  setSyncError,
  state as repo,
  type WireRecord,
} from './localrepo';
import { vcCompare } from '@shared/vector.js';

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
  /** 最近一次成功的同步是否发生了真冲突，用于在设置页提示 */
  hadConflict: boolean;
  online: boolean;
  /** 登录失效，由 session store 监听 */
  unauthorized: boolean;
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
  hadConflict: false,
  // SSR 防御：Node 侧无 navigator；浏览器包里恒走右侧
  /* v8 ignore next */
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  unauthorized: false,
  nextRetryIn: 0,
};

/** 单次同步最多往返多少次，防止服务端异常时死循环。 */
const MAX_PUSH_ROUNDS = 60;
const MAX_PULL_ROUNDS = 200;
const BATCH = 500;

/**
 * 本次会话中"时钟相同但内容不同"被服务端纠正的次数。
 * 正常情况恒为 0；非 0 说明本地曾处于不一致状态（已被自愈），值得在排查时看到。
 */
let divergedCount = 0;

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 3000;
let onlineListenersBound = false;

/** 处理推送回执：采纳服务端时钟、清除脏标记。 */
async function handlePushResult(res: SyncResponse, pushed: WireRecordPayload[]): Promise<void> {
  const corrections = new Map<string, WireRecord & { seq: number }>();
  for (const c of res.corrections || []) corrections.set(c.id, c);

  for (const entry of res.applied || []) {
    const correction = corrections.get(entry.id);
    if (correction) {
      // 我们的版本输给了服务端（或被合并/分歧自愈）：服务端已裁决，
      // 必须无条件采纳（不能走并发裁决——本地更新的墙钟会把纠正顶回去）。
      // 不能只等 pull —— 本地游标可能已越过这条记录，那样永远拿不到纠正数据。
      adoptRemoteRecord(correction);
      await markSynced(entry.id, correction.vc, correction.seq);
      if (entry.status === 'diverged') {
        // 时钟相同但内容不同：本地状态已经跑偏（例如曾被超高时钟分量污染过）。
        // 服务端已回发权威版本，这里采纳即完成自愈。安静记录一笔，便于排查。
        console.warn('[twische] 本地内容与服务端分歧，已采纳服务端版本', entry.id);
        divergedCount += 1;
      }
      continue;
    }
    // created / updated / unchanged：本地时钟已与服务端一致，直接清脏
    await markSynced(entry.id, undefined, entry.seq);
  }

  syncState.lastPushedCount += pushed.length;
  if (res.conflicts?.length) {
    syncState.lastConflictCount += res.conflicts.length;
    syncState.hadConflict = true;
  }
  notify();
}

/** 全量重建：跑完整个集合后一次性对齐本地。 */
async function runFullRebuild(): Promise<void> {
  syncState.phase = 'rebuilding';
  notify();
  const all: Array<WireRecord & { seq: number }> = [];
  let cursor = 0;
  let guard = 0;

  for (;;) {
    if (guard++ > MAX_PULL_ROUNDS) break;
    const res = await api.sync({ cursor, full: true, limit: BATCH });
    all.push(...(res.records as Array<WireRecord & { seq: number }>));
    if (res.records.length > 0) cursor = res.cursor;
    if (!res.hasMore) {
      setFloorSeq(res.tombstoneFloorSeq);
      break;
    }
  }

  await fullRebuild(all);
  setCursor(cursor);
  syncState.lastPulledCount = all.length;
}

/** 实际上网跑一轮同步。抛出的异常由 syncNow 统一处理。 */
async function runSync(): Promise<void> {
  // ── 1) 推送 ──
  syncState.phase = 'pushing';
  notify();
  let round = 0;
  while (round++ < MAX_PUSH_ROUNDS) {
    const batch = dirtyRecords(BATCH);
    if (batch.length === 0) break;

    const payload: WireRecordPayload[] = batch.map((r) => ({
      id: r.id,
      kind: r.kind,
      data: r.data as Record<string, unknown>,
      vc: r.vc,
      updatedAt: r.updatedAt,
      deleted: !!r.deleted,
    }));

    const res = await api.sync({ cursor: repo.cursor, push: payload });

    if (res.resyncRequired) {
      await runFullRebuild();
      return;
    }

    await handlePushResult(res, payload);

    // 服务端可能顺带下发了记录，先应用掉，避免重复拉取
    if (res.records?.length) {
      await applyRemoteBatch(res.records);
      setCursor(res.cursor);
      syncState.lastPulledCount += res.records.length;
      notify();
    }
    setFloorSeq(res.tombstoneFloorSeq);
  }

  // ── 2) 拉取 ──
  syncState.phase = 'pulling';
  notify();
  round = 0;
  let lastPull: SyncResponse | null = null;
  while (round++ < MAX_PULL_ROUNDS) {
    const res = await api.sync({ cursor: repo.cursor, push: [], limit: BATCH });
    lastPull = res;

    if (res.resyncRequired) {
      await runFullRebuild();
      return;
    }

    if (res.records?.length) {
      await applyRemoteBatch(res.records);
      syncState.lastPulledCount += res.records.length;
      notify();
    }
    setCursor(res.cursor);
    setFloorSeq(res.tombstoneFloorSeq);

    if (!res.hasMore) break;
  }

  // ── 3) 完整性自检 ──
  // 游标只前进：若本地曾丢失中间记录（例如浏览器清理了部分站点数据），
  // 增量永远无法补回。服务端给出 liveCount，本地无脏记录时两侧应严格相等；
  // 不等就做一次全量重建自我修复。有脏记录时跳过 —— 推送会改变两侧数量，
  // 此时比较没有意义，等推送清账后下一轮再查。
  if (lastPull && typeof lastPull.liveCount === 'number' && dirtyCount() === 0) {
    const localLive = liveRecords().length;
    if (localLive !== lastPull.liveCount) {
      syncState.phase = 'rebuilding';
      notify();
      await runFullRebuild();
      return;
    }
  }
}

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

  syncState.running = true;
  syncState.queued = false;
  syncState.lastError = '';
  syncState.lastPushedCount = 0;
  syncState.lastPulledCount = 0;
  syncState.lastConflictCount = 0;
  syncState.hadConflict = false;
  notify();

  const startedAt = Date.now();
  let ok = true;

  try {
    await runSync();
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

    if (err instanceof ApiError) {
      if (err.isAuth) {
        // 登录失效：停掉重试，交给会话层处理
        syncState.unauthorized = true;
        clearRetry();
      } else if (err.isNetwork) {
        syncState.online = false;
        scheduleRetry();
      } else {
        // 服务端明确拒绝（校验失败等）：重试也不会变好
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

/** 单条记录是否比服务端更新（供界面显示"待上传"小标记）。 */
export function isAheadOfServer(id: string, serverVc?: Record<string, number>): boolean {
  const r = getRecord(id);
  if (!r || !serverVc) return false;
  return vcCompare(r.vc, serverVc) === 'dominates';
}

/** 本次会话中本地内容被服务端纠正（diverged）的次数。正常恒为 0。 */
export function divergedTotal(): number {
  return divergedCount;
}

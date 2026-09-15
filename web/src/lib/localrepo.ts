/**
 * 本地记录仓库 —— 离线优先的唯一数据源。
 *
 * 所有读写都先落在本地：界面从不等待网络，网络只负责把本地状态与其它设备对齐。
 * 每条记录带一个向量时钟（vc），本地每次修改只推进"我自己"那个分量。
 *
 * 状态是一个 plain 对象 + 订阅通知：写入会推进 rev 并唤醒订阅者
 * （React 侧经 useSyncExternalStore 接入），等价于旧版 Vue reactive 的追踪。
 */
import {
  vcCompare,
  vcIncrement,
  vcMerge,
  vcNormalize,
  vcResolveConflict,
} from '@shared/vector.js';
import { getAll, putMany, deleteMany, STORE_RECORDS, STORE_META, getOne } from './idb';
import { uuid } from './id';
import { toPlain } from './plain';
import type { RecordKind } from './types';

// 记录类型定义在领域层（lib/types），这里只做转出，保持既有引用路径可用
export type { RecordKind };

export interface LocalRecord<T = Record<string, unknown>> {
  id: string;
  kind: RecordKind;
  data: T;
  vc: Record<string, number>;
  /** 客户端墙钟。只用于并发裁决与展示，绝不用于判断因果。 */
  updatedAt: number;
  deleted?: boolean;
  /** 服务端单调序号；未同步过时为空 */
  seq?: number;
  /** 有本地改动尚未推送到服务端 */
  dirty?: boolean;
}

interface RepoState {
  ready: boolean;
  records: Map<string, LocalRecord>;
  cursor: number;
  /** 服务端墓碑水位，用于判断本地是否落后过多 */
  floorSeq: number;
  deviceId: string;
  deviceName: string;
  lastSyncAt: number;
  lastSyncError: string;
  /**
   * 修订号，每次写入自增。
   * 视图侧用它给"展开过的日程"做缓存失效 —— 只比较记录数量是不够的，
   * 编辑一条已有记录不会改变数量，却必须重新展开。
   */
  rev: number;
}

export const state: RepoState = {
  ready: false,
  records: new Map(),
  cursor: 0,
  floorSeq: 0,
  deviceId: '',
  deviceName: '',
  lastSyncAt: 0,
  lastSyncError: '',
  rev: 0,
};

const listeners = new Set<() => void>();

/** 订阅仓库变化（写入会推进 rev 并触发）。返回取消函数。 */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 供 useSyncExternalStore 使用：rev 是"数据是否变过"的唯一判据。 */
export function getRev(): number {
  return state.rev;
}

/**
 * 修订号，每次写入自增。
 * 视图侧用它给"展开过的日程"做缓存失效 —— 只比较记录数量是不够的，
 * 编辑一条已有记录不会改变数量，却必须重新展开。
 */
function bump(): void {
  state.rev += 1;
  for (const fn of listeners) fn();
}

/**
 * 写入的唯一入口。
 * 所有落盘路径都必须经过这里 —— 散落各处的 records.set 迟早会漏掉一次 bump()，
 * 症状是"改了数据但界面不刷新"，而且极难定位。
 */
function setLocal(rec: LocalRecord): void {
  state.records.set(rec.id, rec);
  bump();
}

function dropLocal(id: string): void {
  state.records.delete(id);
  bump();
}

const DEVICE_KEY = 'twische.deviceId';
const DEVICE_NAME_KEY = 'twische.deviceName';

function detectDeviceName(): string {
  // SSR 防御：Node 侧无 navigator；浏览器包里恒走右侧
  /* v8 ignore next */
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) {
    const m = /Android[^;]*;\s*([^)]+?)(?:\s+Build)?\)/.exec(ua);
    return m ? m[1].trim().slice(0, 40) : 'Android 设备';
  }
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows 电脑';
  if (/Linux/i.test(ua)) return 'Linux 电脑';
  return '浏览器';
}

/** 从 localStorage 取设备身份；没有就生成。localStorage 存不下时才退回内存。 */
function loadDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = uuid();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return uuid();
  }
}

function loadDeviceName(): string {
  try {
    return localStorage.getItem(DEVICE_NAME_KEY) || detectDeviceName();
  } catch {
    return detectDeviceName();
  }
}

export function setDeviceName(name: string): void {
  state.deviceName = name;
  bump();
  try {
    localStorage.setItem(DEVICE_NAME_KEY, name);
  } catch {
    /* 忽略：隐私模式下无法持久化 */
  }
}

/** 主题等纯本地偏好，不参与同步。 */
export const localPrefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(`twische.pref.${key}`);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`twische.pref.${key}`, JSON.stringify(value));
    } catch {
      /* 忽略 */
    }
  },
};

// ───────────────────────── 初始化 ─────────────────────────

export async function initRepo(): Promise<void> {
  if (state.ready) return;

  state.deviceId = loadDeviceId();
  state.deviceName = loadDeviceName();

  let records: LocalRecord[] = [];
  try {
    records = await getAll<LocalRecord>(STORE_RECORDS);
  } catch (err) {
    // 读不出来不能让应用卡死：降级为"只有内存中的本次会话"
    console.warn('[twische] 本地库读取失败，将以内存模式运行', err);
  }

  state.records = new Map(records.map((r) => [r.id, r]));

  try {
    const metas = await getAll<{ key: string; value: unknown }>(STORE_META);
    const m = new Map(metas.map((x) => [x.key, x.value]));
    state.cursor = Number(m.get('cursor') ?? 0) || 0;
    state.floorSeq = Number(m.get('floorSeq') ?? 0) || 0;
    state.lastSyncAt = Number(m.get('lastSyncAt') ?? 0) || 0;
  } catch {
    /* 同上 */
  }

  state.ready = true;
  bump();
}

async function persistMeta(key: string, value: unknown): Promise<void> {
  await putMany(STORE_META, [{ key, value }]).catch(() => {});
}

export function setCursor(n: number): void {
  state.cursor = n;
  void persistMeta('cursor', n);
}

export function setLastSyncAt(ts: number): void {
  state.lastSyncAt = ts;
  void persistMeta('lastSyncAt', ts);
}

export function setFloorSeq(n: number): void {
  state.floorSeq = n;
  void persistMeta('floorSeq', n);
}

export function setSyncError(msg: string): void {
  state.lastSyncError = msg;
}

// ───────────────────────── 查询 ─────────────────────────

export function allRecords(): LocalRecord[] {
  return [...state.records.values()];
}

export function liveRecords(kind?: RecordKind): LocalRecord[] {
  const out: LocalRecord[] = [];
  for (const r of state.records.values()) {
    if (r.deleted) continue;
    if (kind && r.kind !== kind) continue;
    out.push(r);
  }
  return out;
}

export function getRecord(id: string): LocalRecord | undefined {
  return state.records.get(id);
}

export function dirtyRecords(limit = 500): LocalRecord[] {
  const out: LocalRecord[] = [];
  for (const r of state.records.values()) {
    if (r.dirty) out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

export function dirtyCount(): number {
  let n = 0;
  for (const r of state.records.values()) if (r.dirty) n++;
  return n;
}

/** 本地所有记录时钟的并集：用于"本机掌握到哪一版"的展示与诊断。 */
export function localVector(): Record<string, number> {
  let vc: Record<string, number> = {};
  for (const r of state.records.values()) vc = vcMerge(vc, r.vc);
  return vc;
}

// ───────────────────────── 本地写入 ─────────────────────────

async function persist(records: LocalRecord[]): Promise<void> {
  await putMany(STORE_RECORDS, records).catch((err) => {
    console.warn('[twische] 写入本地库失败', err);
  });
}

/**
 * 新建或更新一条记录。
 *
 * 关键点：vc 只推进**本设备**的分量，其余分量原样保留 ——
 * 这样服务端才能看出"这条修改基于哪个版本"。
 */
export function upsertRecord<T>(input: {
  id?: string;
  kind: RecordKind;
  data: T;
}): LocalRecord<T> {
  const existing = input.id ? state.records.get(input.id) : undefined;
  const id = input.id || uuid();
  const prevVc = existing ? vcNormalize(existing.vc) : {};

  const record: LocalRecord<T> = {
    id,
    kind: input.kind,
    // 存一份纯数据副本：调用方传进来的往往是编辑器里的响应式草稿，
    // 直接持有引用会让"保存后继续编辑"意外改到已落库的内容，
    // 也会把 Vue 的 Proxy 带进 IndexedDB（不可克隆）。
    data: toPlain(input.data),
    vc: vcIncrement(prevVc, state.deviceId),
    updatedAt: Date.now(),
    deleted: existing?.deleted ?? false,
    seq: existing?.seq,
    dirty: true,
  };

  setLocal(record as LocalRecord);
  void persist([record as LocalRecord]);
  return record;
}

/** 删除：留一个带新时钟的墓碑，这样删除也能同步出去。 */
export function tombstoneRecord(id: string): boolean {
  const existing = state.records.get(id);
  if (!existing) return false;
  const next: LocalRecord = {
    ...existing,
    data: {},
    vc: vcIncrement(existing.vc, state.deviceId),
    updatedAt: Date.now(),
    deleted: true,
    dirty: true,
  };
  setLocal(next);
  void persist([next]);
  return true;
}

// ───────────────────────── 远端写入 ─────────────────────────

export interface WireRecord {
  id: string;
  kind: RecordKind;
  data: Record<string, unknown>;
  vc: Record<string, number>;
  updatedAt: number;
  deleted?: boolean;
  seq?: number;
}

/**
 * 应用一条来自服务端的记录。
 *
 * 收敛策略（最重要的一段逻辑）：
 * - 远端更新 → 直接采纳，并清掉本地脏标记
 * - 本地更新 → 保留本地（它仍是脏的，会被推送出去）
 * - 并发     → 用与**服务端完全相同**的决胜规则选出赢家；无论谁赢，
 *             都把本地时钟换成两者的并集。
 *
 * 第三点是防"乒乓"的关键：若本地赢了却只保留自己的时钟，下次推送仍会被判为并发，
 * 两端就会来回覆盖。换成并集后，本地时钟严格支配远端，下次推送是一条干净的
 * 支配关系更新，一次收敛。
 */
export function applyRemoteRecord(remote: WireRecord): 'created' | 'updated' | 'kept-local' | 'unchanged' {
  const local = state.records.get(remote.id);

  if (!local) {
    const rec: LocalRecord = {
      id: remote.id,
      kind: remote.kind,
      data: remote.data ?? {},
      vc: vcNormalize(remote.vc),
      updatedAt: remote.updatedAt,
      deleted: !!remote.deleted,
      seq: remote.seq,
      dirty: false,
    };
    setLocal(rec);
    return 'created';
  }

  const rel = vcCompare(remote.vc, local.vc);

  if (rel === 'equal') {
    // 内容相同，仅同步服务端序号，避免下次重复拉取
    local.seq = remote.seq;
    return 'unchanged';
  }

  if (rel === 'dominates') {
    const rec: LocalRecord = {
      id: remote.id,
      kind: remote.kind,
      data: remote.data ?? {},
      vc: vcNormalize(remote.vc),
      updatedAt: remote.updatedAt,
      deleted: !!remote.deleted,
      seq: remote.seq,
      dirty: false,
    };
    setLocal(rec);
    return 'updated';
  }

  if (rel === 'dominated') {
    // 本地更新，等着被推送；只把 seq 记下来
    local.seq = Math.max(local.seq ?? 0, remote.seq ?? 0);
    return 'kept-local';
  }

  // 并发
  const winner = vcResolveConflict(
    { vc: local.vc, updatedAt: local.updatedAt },
    { vc: remote.vc, updatedAt: remote.updatedAt },
  );
  const mergedVc = vcMerge(local.vc, remote.vc);

  if (winner === 'remote') {
    const rec: LocalRecord = {
      id: remote.id,
      kind: remote.kind,
      data: remote.data ?? {},
      vc: mergedVc,
      updatedAt: remote.updatedAt,
      deleted: !!remote.deleted,
      seq: remote.seq,
      dirty: false,
    };
    setLocal(rec);
    return 'updated';
  }

  // 本地赢：数据留本地的，时钟升级为并集，保持脏以便推送
  const rec: LocalRecord = {
    ...local,
    vc: mergedVc,
    seq: Math.max(local.seq ?? 0, remote.seq ?? 0),
    dirty: true,
  };
  setLocal(rec);
  return 'kept-local';
}

/** 批量应用并一次性落盘 —— 一次同步可能带回几百条。 */
export async function applyRemoteBatch(list: WireRecord[]): Promise<void> {
  const touched: LocalRecord[] = [];
  for (const remote of list) {
    applyRemoteRecord(remote);
    const r = state.records.get(remote.id);
    if (r) touched.push(r);
  }
  await persist(touched);
}

/**
 * 无条件采纳一条服务端记录，不做时钟比较。
 *
 * 专用于推送回执的 corrections：服务端已经裁决过（diverged 自愈 / 冲突保服务端），
 * 若再走 applyRemoteRecord 的并发裁决，本地几乎总是更新的墙钟会赢，
 * 纠正数据会被静默丢弃 —— 日志里写着"已采纳"，实际什么都没采纳。
 */
export function adoptRemoteRecord(remote: WireRecord): void {
  const rec: LocalRecord = {
    id: remote.id,
    kind: remote.kind,
    data: remote.data ?? {},
    vc: vcNormalize(remote.vc),
    updatedAt: remote.updatedAt,
    deleted: !!remote.deleted,
    seq: remote.seq,
    dirty: false,
  };
  setLocal(rec);
}

/** 推送成功后：采纳服务端时钟（可能是合并结果），并清除脏标记。 */
export async function markSynced(id: string, vc?: Record<string, number>, seq?: number): Promise<void> {
  const r = state.records.get(id);
  if (!r) return;
  if (vc) r.vc = vcNormalize(vc);
  if (typeof seq === 'number') r.seq = seq;
  r.dirty = false;
  await persist([r]);
}

/**
 * 全量重建：服务端返回了完整集合，本地据此对齐。
 *
 * 落在这个集合之外的已同步记录意味着服务端的墓碑已被清理，本地应当一并删除。
 * 仍然脏的记录必须保留 —— 它们是本地尚未推送的编辑，不能因为一次重建就丢掉。
 */
export async function fullRebuild(serverRecords: WireRecord[]): Promise<{ removed: number }> {
  const seen = new Set(serverRecords.map((r) => r.id));
  const removedIds: string[] = [];

  for (const [id, r] of state.records) {
    if (seen.has(id)) continue;
    if (r.dirty) continue; // 保住本地未推送的改动
    removedIds.push(id);
  }
  for (const id of removedIds) dropLocal(id);

  await applyRemoteBatch(serverRecords);
  if (removedIds.length > 0) await deleteMany(STORE_RECORDS, removedIds).catch(() => {});
  return { removed: removedIds.length };
}

/** 清空本地数据（退出登录或重置同步时使用）。 */
export async function wipeLocal(keepDirty = false): Promise<void> {
  const keys: string[] = [];
  for (const [id, r] of state.records) {
    if (keepDirty && r.dirty) continue;
    keys.push(id);
  }
  for (const id of keys) dropLocal(id);
  await deleteMany(STORE_RECORDS, keys).catch(() => {});
  setCursor(0);
  setFloorSeq(0);
}

export { vcMerge, vcCompare, vcIncrement };

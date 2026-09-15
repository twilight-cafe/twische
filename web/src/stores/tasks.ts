/**
 * 任务与日程状态。
 *
 * 这一层是"本地优先"的落点：所有写操作先落到本地仓库（界面立刻更新），
 * 再触发一次后台同步。任何一次写操作都不会因为网络慢而让按钮转圈。
 *
 * 完成打卡不写在任务上，而是独立的 completion 记录 ——
 * 重复任务需要"每一次"都能单独勾选，把 done 放在任务上做不到这件事，
 * 而且多端勾选不同日期的同一条任务会互相覆盖。
 *
 * React 版说明：本模块只持有筛选状态；任务/完成记录直接读本地仓库，
 * 组件侧通过 useRepoRev() 订阅变更（Vue 版靠 reactive 追踪，语义一致）。
 */
import { create } from 'zustand';
import { expandOccurrences, describeRecurrence, validateTask } from '@shared/recurrence.js';
import {
  getRecord,
  liveRecords,
  state as repo,
  tombstoneRecord,
  upsertRecord,
  type LocalRecord,
} from '@/lib/localrepo';
import { requestSync } from '@/lib/sync';
import { uuid } from '@/lib/id';
import { notify } from './ui';
import {
  emptyTask,
  type Completion,
  type Occurrence,
  type OccurrenceWithTask,
  type Task,
} from '@/lib/types';

/** 缓存展开结果。只比较区间是不够的：编辑一条已有任务不改变记录数，却必须重算。 */
let memoKey = '';
let memoRev = -1;
let memoResult: OccurrenceWithTask[] = [];

// ── 原始数据 ──

export function taskRecords(): LocalRecord[] {
  return liveRecords('task');
}

export function listTasks(): Task[] {
  // data 是整体读写的 JSON，运行时的形状由 normalizeTask 兜底，
  // 因此这里的断言是"先当作目标形状传入"，而非真的已验证过
  return taskRecords().map((r) => normalizeTask(r as unknown as LocalRecord<Task>));
}

export function taskMap(): Map<string, Task> {
  const m = new Map<string, Task>();
  for (const t of listTasks()) m.set(t.id, t);
  return m;
}

/** 所有完成记录，键为 `<taskId>|<occurrence>`。 */
export function completionRecords(): LocalRecord[] {
  return liveRecords('completion');
}

export function completionMap(): Map<string, Completion> {
  const m = new Map<string, Completion>();
  for (const r of completionRecords()) {
    const c = r.data as unknown as Completion;
    if (c && typeof c.taskId === 'string') m.set(r.id, c);
  }
  return m;
}

function completionKey(taskId: string, occurrence: string): string {
  return `${taskId}|${occurrence}`;
}

// ── 展开 ──

/**
 * 展开 [fromKey, toKey] 区间内的全部日程实例。
 * 结果已排序，可直接交给时间线渲染。
 */
export function expandRange(fromKey: string, toKey: string): OccurrenceWithTask[] {
  const rev = repo.rev; // 任何写入都会推进 rev，让缓存失效
  const key = `${fromKey}|${toKey}|${rev}`;
  if (key === memoKey) return memoResult;

  const byId = taskMap();
  const completions = completionMap();
  const out: OccurrenceWithTask[] = [];

  for (const task of byId.values()) {
    if (task.status === 'archived') continue;
    const raw = expandOccurrences(task, fromKey, toKey, { completions }) as unknown as Occurrence[];
    for (const occ of raw) {
      out.push({ occurrence: occ, task });
    }
  }

  out.sort(compareOccurrence);

  memoKey = key;
  memoRev = rev;
  memoResult = out;
  return out;
}

function compareOccurrence(a: OccurrenceWithTask, b: OccurrenceWithTask): number {
  const d = a.occurrence.startAt.getTime() - b.occurrence.startAt.getTime();
  if (d !== 0) return d;
  // 同一时刻下，有截止时间的排在前面 —— 它们更需要被看见
  if (a.occurrence.kind !== b.occurrence.kind) return a.occurrence.kind === 'deadline' ? -1 : 1;
  return a.task.title.localeCompare(b.task.title, 'zh-Hans-CN');
}

/** 某一天的实例。刻意不走缓存：单日展开本身就很便宜。 */
export function occurrencesForDate(dateKey: string): OccurrenceWithTask[] {
  void repo.rev; // 与 expandRange 相同的失效语义（读一下 rev 保持调用方一致）
  const byId = taskMap();
  const completions = completionMap();
  const out: OccurrenceWithTask[] = [];

  for (const task of byId.values()) {
    if (task.status === 'archived') continue;
    const raw = expandOccurrences(task, dateKey, dateKey, { completions }) as unknown as Occurrence[];
    for (const occ of raw) out.push({ occurrence: occ, task });
  }

  out.sort(compareOccurrence);
  return out;
}

/** 跨午夜的任务，其"尾巴"会落到次日，需要单独提出来渲染在次日的时间轴顶部。 */
export function overflowInto(dateKey: string): OccurrenceWithTask[] {
  const prev = addDaysKey(dateKey, -1);
  return occurrencesForDate(prev).filter(
    (o) => o.occurrence.spansMidnight && o.occurrence.endsOnNextDay === dateKey,
  );
}

/** 已逾期但未完成的截止任务。 */
export function overdueDeadlines(limit = 20): OccurrenceWithTask[] {
  const today = todayKey();
  const lookback = addDaysKey(today, -60);
  return expandRange(lookback, today)
    .filter((o) => o.occurrence.kind === 'deadline' && o.occurrence.overdue && !o.occurrence.done)
    .sort((a, b) => a.occurrence.startAt.getTime() - b.occurrence.startAt.getTime())
    .slice(0, limit);
}

// ── 写操作 ──

export function createTask(input: Partial<Task>): Task | null {
  // id 必须在校验**之前**就定下来：validateTask 的对象契约里 id 是必填项，
  // 而"待创建的任务"此刻还没有身份。早先的写法把 id 留给 upsertRecord 生成，
  // 结果每一次新建都会在校验处被拦下（"缺少任务 id"）。
  const draft: Task = emptyTask({ ...input, id: input.id || uuid() });
  draft.createdAt = Date.now();
  draft.updatedAt = draft.createdAt;

  const errs = validateTask(draft);
  if (errs.length > 0) {
    notify.error('无法保存', errs.join('；'));
    return null;
  }

  const rec = upsertRecord<Task>({ id: draft.id, kind: 'task', data: draft });
  requestSync();
  return { ...draft, id: rec.id };
}

export function updateTask(id: string, patch: Partial<Task>): boolean {
  const existing = taskMap().get(id);
  if (!existing) return false;

  const next: Task = { ...existing, ...patch, id, updatedAt: Date.now() };
  const errs = validateTask(next);
  if (errs.length > 0) {
    notify.error('无法保存', errs.join('；'));
    return false;
  }

  // 截止时间被改动后，原先基于旧时刻的完成打卡就成了孤儿。
  // 留着不管的话，界面上会永久残留一条谁也看不到的记录。
  // 例外：任务同时改成了 fixed —— 固定任务按日期打卡，不该被清掉。
  if (existing.kind === 'deadline' && next.dueAt !== existing.dueAt && next.kind !== 'fixed') {
    dropOrphanCompletions(id);
  }

  upsertRecord<Task>({ id, kind: 'task', data: next });
  requestSync();
  return true;
}

function dropOrphanCompletions(taskId: string): void {
  for (const r of completionRecords()) {
    if ((r.data as unknown as Completion)?.taskId === taskId) {
      tombstoneRecord(r.id);
    }
  }
}

export function deleteTask(id: string): void {
  // 连带清掉它的完成记录，否则这些记录会永远留在同步集合里
  for (const r of completionRecords()) {
    if ((r.data as unknown as Completion)?.taskId === id) tombstoneRecord(r.id);
  }
  const ok = tombstoneRecord(id);
  if (ok) {
    requestSync();
    notify.ok('任务已删除');
  }
}

export function archiveTask(id: string, archived = true): void {
  updateTask(id, { status: archived ? 'archived' : 'open' });
  notify.ok(archived ? '已归档' : '已取消归档');
}

/** 切换某一次日程的完成状态。 */
export function toggleCompletion(taskId: string, occurrenceKey: string): void {
  const key = completionKey(taskId, occurrenceKey);
  const existing = completionMap().get(key);

  if (existing) {
    tombstoneRecord(key);
    requestSync();
    return;
  }

  const payload: Completion = { taskId, occurrence: occurrenceKey, doneAt: Date.now() };
  // 用确定性 id，保证多端同时勾选同一天时产生的是同一条记录而非两条
  upsertRecord<Completion>({ id: key, kind: 'completion', data: payload });
  requestSync();
}

export function isDone(taskId: string, occurrenceKey: string): boolean {
  return completionMap().has(completionKey(taskId, occurrenceKey));
}

export function duplicateTask(id: string): void {
  const t = taskMap().get(id);
  if (!t) return;
  const copy = createTask({
    ...t,
    id: '',
    title: `${t.title}（副本）`,
  });
  if (copy) notify.ok('已创建副本');
}

// ── 筛选与统计 ──

interface TaskFilterState {
  searchQuery: string;
  filterKind: 'all' | 'fixed' | 'deadline';
  filterTag: string;
  showArchived: boolean;
}

interface TaskFilterActions {
  setSearchQuery(q: string): void;
  setFilterKind(k: 'all' | 'fixed' | 'deadline'): void;
  setFilterTag(t: string): void;
  setShowArchived(v: boolean): void;
  clearFilters(): void;
}

export type TaskStore = TaskFilterState & TaskFilterActions;

export const useTaskStore = create<TaskStore>((set) => ({
  searchQuery: '',
  filterKind: 'all',
  filterTag: '',
  showArchived: false,

  setSearchQuery: (q) => set({ searchQuery: q }),
  setFilterKind: (k) => set({ filterKind: k }),
  setFilterTag: (t) => set({ filterTag: t }),
  setShowArchived: (v) => set({ showArchived: v }),
  clearFilters: () => set({ searchQuery: '', filterKind: 'all', filterTag: '', showArchived: false }),
}));

export function filteredTasks(): Task[] {
  const { searchQuery, filterKind, filterTag, showArchived } = useTaskStore.getState();
  const q = searchQuery.trim().toLowerCase();
  return listTasks()
    .filter((t) => (showArchived ? true : t.status !== 'archived'))
    .filter((t) => (filterKind === 'all' ? true : t.kind === filterKind))
    .filter((t) => (filterTag ? t.tags.includes(filterTag) : true))
    .filter((t) => {
      if (!q) return true;
      return t.title.toLowerCase().includes(q) || (t.notes || '').toLowerCase().includes(q);
    })
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'archived' ? 1 : -1;
      return b.updatedAt - a.updatedAt;
    });
}

export function allTags(): string[] {
  const s = new Set<string>();
  // normalizeTask 保证 tags 恒为数组
  for (const t of listTasks()) for (const tag of t.tags) s.add(tag);
  return [...s].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/** 某个任务的"下一次"日程，用于列表页显示。 */
export function nextOccurrenceOf(taskId: string): Occurrence | null {
  const task = taskMap().get(taskId);
  if (!task || task.status === 'archived') return null;
  const today = todayKey();
  const raw = expandOccurrences(task, today, addDaysKey(today, 366), {
    completions: completionMap(),
    limit: 1,
  }) as unknown as Occurrence[];
  return raw[0] ?? null;
}

/** 连续完成天数（以打卡日期为口径）。 */
export function completionStreak(): number {
  const days = new Set<string>();
  for (const r of completionRecords()) {
    const c = r.data as unknown as Completion;
    if (!c?.occurrence) continue;
    days.add(c.occurrence.slice(0, 10));
  }
  let streak = 0;
  let cursor = todayKey();
  // 今天还没打卡不算断，从昨天开始数
  if (!days.has(cursor)) cursor = addDaysKey(cursor, -1);
  while (days.has(cursor)) {
    streak++;
    cursor = addDaysKey(cursor, -1);
  }
  return streak;
}

export function describe(task: Task): string {
  if (task.kind === 'deadline') {
    if (!task.dueAt) return '无截止时间';
    const d = new Date(task.dueAt.replace('T', ' ').replace(/-/g, '/'));
    const pad = (n: number) => String(n).padStart(2, '0');
    if (task.allDay) return `${d.getMonth() + 1} 月 ${d.getDate()} 日截止（全天）`;
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())} 截止`;
  }
  return describeRecurrence(task.recurrence || {}, {});
}

export function getRawRecord(id: string): LocalRecord | undefined {
  return getRecord(id);
}

// ───────────────────────── 内部工具 ─────────────────────────

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysKey(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** 老版本记录可能缺字段，读出来时补齐默认值，避免下游到处写 `?? `。 */
function normalizeTask(rec: LocalRecord<Task>): Task {
  const d = (rec.data || {}) as Partial<Task>;
  return {
    id: rec.id,
    title: typeof d.title === 'string' ? d.title : '',
    notes: typeof d.notes === 'string' ? d.notes : '',
    kind: d.kind === 'fixed' ? 'fixed' : 'deadline',
    status: d.status === 'archived' ? 'archived' : 'open',
    tags: Array.isArray(d.tags) ? d.tags.filter((t) => typeof t === 'string') : [],
    recurrence: d.recurrence ?? null,
    dueAt: typeof d.dueAt === 'string' ? d.dueAt : null,
    allDay: !!d.allDay,
    priority: (d.priority === 1 || d.priority === 2 ? d.priority : 0) as Task['priority'],
    createdAt: Number(d.createdAt) || rec.updatedAt,
    updatedAt: Number(d.updatedAt) || rec.updatedAt,
  };
}

/**
 * 业务数据类型。
 *
 * 存储后端（CalDAV / WebDAV / 旧服务器）只认识 { id, kind, data }，
 * 业务形状完全由这里定义。因此新增字段不需要动任何后端，也不需要数据迁移：
 * 老版本客户端遇到不认识的字段会原样保留（data 是整体读写的），新旧版本可以并存。
 */

/**
 * 任务类型。
 *
 * - `fixed`    固定重复时段（每周三 09:00–10:00）
 * - `deadline` 精确截止时刻（一次性）
 *
 * 与 v1 保持一致，不新增类型：本版只把同步传输换成 WebDAV，不动领域模型。
 */
export type TaskKind = 'fixed' | 'deadline';
export type TaskStatus = 'open' | 'archived';
export type Priority = 0 | 1 | 2;

/**
 * 同步集合里的一类记录。
 *
 * v1 的 'pref' / 'tag' 两种类型从未被任何代码写入（标签内嵌在 Task.tags，
 * 偏好走 localStorage），新项目直接删除，避免留下无人认领的线上类型。
 */
export type RecordKind = 'task' | 'completion';

export interface Recurrence {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  /** ISO 星期 1=周一 … 7=周日 */
  byWeekday: number[];
  byMonthday: number[];
  byMonth: number[];
  /** 「每月第三个周五」这类规则；存在时优先于 byMonthday */
  nthWeekday: { ordinal: 1 | 2 | 3 | 4 | -1; weekday: number } | null;
  /** 'HH:mm'，本地墙钟 */
  startTime: string;
  /** 'HH:mm'；**小于等于 startTime 表示跨到次日** —— 不用 24:xx 表达 */
  endTime: string;
  /** 'YYYY-MM-DD'，序列首个候选日 */
  dtstart: string;
  until: string | null;
  count: number | null;
  /** 例外日期，逐日跳过 */
  exdates: string[];
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  kind: TaskKind;
  status: TaskStatus;
  tags: string[];
  /** kind === 'fixed' 时有效 */
  recurrence: Recurrence | null;
  /** kind === 'deadline' 时有效，'YYYY-MM-DDTHH:mm'（精确到分钟） */
  dueAt: string | null;
  allDay: boolean;
  priority: Priority;
  createdAt: number;
  updatedAt: number;
}

export interface Completion {
  taskId: string;
  /** 固定任务记归属日（'YYYY-MM-DD'）；截止任务记精确到分钟的截止时刻 */
  occurrence: string;
  doneAt: number;
}

/** 展开后的一个日程实例。 */
export interface Occurrence {
  taskId: string;
  kind: TaskKind;
  /** 完成打卡的主键后缀，与 `taskId` 组成 completion 记录 id */
  key: string;
  dateKey: string;
  allDay: boolean;
  startMinutes: number;
  endMinutes: number;
  durationMinutes: number;
  startAt: Date;
  endAt: Date;
  spansMidnight: boolean;
  /** 跨午夜时，结束落在哪一天 */
  endsOnNextDay: string | null;
  overdue: boolean;
  done: boolean;
  completion: { doneAt: number } | null;
  dueAt?: Date;
}

/** 界面用的"实例 + 所属任务"打包，避免组件反复查表。 */
export interface OccurrenceWithTask {
  occurrence: Occurrence;
  task: Task;
}

export const DEFAULT_TAGS = ['工作', '学习', '生活', '健康'];

export function emptyTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '',
    title: '',
    notes: '',
    kind: 'deadline',
    status: 'open',
    tags: [],
    recurrence: null,
    dueAt: null,
    allDay: false,
    priority: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * 任务编辑器的全局状态。
 *
 * 做成 store 而不是把弹窗挂在某个视图里，是因为"新建任务"的入口散落在
 * 侧栏、FAB、月历格子、今日空态等很多地方。集中在一处维护，
 * 就不必在每个视图里复制一遍弹层逻辑。
 */
import { create } from 'zustand';
import { taskMap, createTask, updateTask, describe } from './tasks';
import { notify } from './ui';
import { emptyTask, type Task } from '@/lib/types';
import { nowLocalDateTime, todayKey, startOfWeek } from '@/lib/datetime';

export type EditorMode = 'create' | 'edit';

interface EditorState {
  open: boolean;
  mode: EditorMode;
  editingId: string;
  draft: Task;
  /** 是否有未保存的改动，用于关闭前提醒。 */
  dirty: boolean;
}

interface EditorActions {
  title(): string;
  openCreate(defaults?: Partial<Task>): void;
  openEdit(id: string): void;
  setDraft(next: Task): void;
  patchDraft(patch: Partial<Task>): void;
  touch(): void;
  close(force?: boolean): boolean;
  save(): boolean;
  saveAndNew(): void;
  defaultDue(): string;
}

export type EditorStore = EditorState & EditorActions;

function snapshot(t: Task): string {
  return JSON.stringify(t);
}

let initialSnapshot = '';

export const useEditorStore = create<EditorStore>((set, get) => ({
  open: false,
  mode: 'create',
  editingId: '',
  draft: emptyTask(),
  dirty: false,

  /** 编辑器标题。 */
  title(): string {
    return get().mode === 'create' ? '新建任务' : '编辑任务';
  },

  openCreate(defaults: Partial<Task> = {}) {
    const next = emptyTask({
      // 默认给一个"一小时后截止"的截止任务：最常见的临时事项形态
      kind: 'deadline',
      dueAt: get().defaultDue(),
      ...defaults,
    });
    initialSnapshot = snapshot(next);
    set({ mode: 'create', editingId: '', draft: next, dirty: false, open: true });
  },

  openEdit(id: string) {
    const t = taskMap().get(id);
    if (!t) {
      notify.error('找不到该任务');
      return;
    }
    // 深拷贝：取消编辑时不能污染原对象
    const copy: Task = JSON.parse(JSON.stringify(t));
    initialSnapshot = snapshot(copy);
    set({ mode: 'edit', editingId: id, draft: copy, dirty: false, open: true });
  },

  setDraft(next: Task) {
    set({ draft: next, dirty: snapshot(next) !== initialSnapshot });
  },

  patchDraft(patch: Partial<Task>) {
    const next: Task = { ...get().draft, ...patch };
    get().setDraft(next);
  },

  touch() {
    set({ dirty: snapshot(get().draft) !== initialSnapshot });
  },

  close(force = false): boolean {
    if (!force && get().dirty) {
      const confirmed = window.confirm('有未保存的改动，确定要关闭吗？');
      if (!confirmed) return false;
    }
    set({ open: false, dirty: false });
    return true;
  },

  save(): boolean {
    const d = get().draft;

    // 表单层面的兜底：不强求用户理解"重复规则"，但要拦住明显不合法的组合
    if (!d.title.trim()) {
      notify.error('请填写标题');
      return false;
    }

    if (d.kind === 'fixed') {
      if (!d.recurrence) {
        notify.error('固定时段任务需要设置重复规则');
        return false;
      }
    } else if (!d.dueAt) {
      notify.error('请设置截止时间');
      return false;
    }

    if (get().mode === 'create') {
      const created = createTask(d);
      if (!created) return false;
      set({ open: false, dirty: false });
      notify.ok('已创建', summarize(d));
      return true;
    }

    const ok = updateTask(get().editingId, d);
    if (!ok) return false;
    set({ open: false, dirty: false });
    notify.ok('已保存', summarize(d));
    return true;
  },

  /** 保存并立刻再建一条，适合连续录入。 */
  saveAndNew(): void {
    const d = get().draft;
    if (!d.title.trim()) {
      notify.error('请填写标题');
      return;
    }
    const created = createTask(d);
    if (!created) return;
    notify.ok('已创建，继续添加');
    const keep = {
      kind: d.kind,
      tags: [...d.tags],
      recurrence: d.recurrence ? JSON.parse(JSON.stringify(d.recurrence)) : null,
    };
    get().openCreate(keep as Partial<Task>);
  },

  defaultDue(): string {
    // 下一个整点，避免出现 15:47 这种"看起来像随手填的"默认值
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
  },
}));

function summarize(t: Task): string {
  if (t.kind === 'fixed') return describe(t);
  // 校验流程保证 deadline 必有 dueAt，这里只是类型收窄的兜底
  /* v8 ignore next */
  if (!t.dueAt) return '无截止时间';
  return t.dueAt.replace('T', ' ') + (t.allDay ? '（全天）' : '');
}

/** 供视图使用：今天是几号、本周从哪天开始。 */
export function editorDefaults() {
  return { today: todayKey(), weekStart: startOfWeek(todayKey(), 1), now: nowLocalDateTime() };
}

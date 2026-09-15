import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '@/lib/types';

vi.mock('@/lib/sync', () => ({ requestSync: vi.fn() }));

let editor: typeof import('./editor');
let tasks: typeof import('./tasks');
let repo: typeof import('@/lib/localrepo');
let ui: typeof import('./ui');

function deadlineDraft(over: Partial<Task> = {}): Partial<Task> {
  return { title: '写周报', kind: 'deadline', dueAt: '2026-09-20T10:00', ...over };
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('twische.deviceId', 'devA');
  const idb = await import('@/lib/idb');
  await idb.clearAll();
  repo = await import('@/lib/localrepo');
  await repo.initRepo();
  tasks = await import('./tasks');
  ui = await import('./ui');
  editor = await import('./editor');
  Object.defineProperty(window, 'confirm', { value: vi.fn(() => true), configurable: true, writable: true });
  const syncMod = await import('@/lib/sync');
  vi.mocked(syncMod.requestSync).mockClear();
});

describe('打开与关闭', () => {
  it('openCreate：默认一小时后截止的截止任务', () => {
    editor.useEditorStore.getState().openCreate();
    const s = editor.useEditorStore.getState();
    expect(s.open).toBe(true);
    expect(s.mode).toBe('create');
    expect(s.dirty).toBe(false);
    expect(s.draft.kind).toBe('deadline');
    expect(s.draft.dueAt).toMatch(/T\d{2}:00$/);
    expect(s.title()).toBe('新建任务');
  });

  it('openCreate 的 defaults 覆盖内置默认', () => {
    editor.useEditorStore.getState().openCreate({ kind: 'deadline', title: '自定义', dueAt: '2026-10-01T09:00' });
    expect(editor.useEditorStore.getState().draft.title).toBe('自定义');
  });

  it('openEdit：深拷贝草稿；找不到任务时报错不打开', () => {
    const t = tasks.createTask(deadlineDraft())!;
    editor.useEditorStore.getState().openEdit(t.id);
    const s = editor.useEditorStore.getState();
    expect(s.mode).toBe('edit');
    expect(s.editingId).toBe(t.id);
    expect(s.draft).toEqual(tasks.taskMap().get(t.id));
    expect(s.draft).not.toBe(tasks.taskMap().get(t.id));
    expect(s.title()).toBe('编辑任务');

    editor.useEditorStore.getState().close(true);
    editor.useEditorStore.getState().openEdit('missing');
    expect(editor.useEditorStore.getState().open).toBe(false);
    expect(ui.useUiStore.getState().toasts.some((x) => x.kind === 'error')).toBe(true);
  });

  it('close：无改动直接关；有改动需确认；拒绝确认则不关', () => {
    const s = editor.useEditorStore.getState();
    s.openCreate();
    expect(s.close()).toBe(true);

    s.openCreate();
    s.patchDraft({ title: '改动' });
    vi.mocked(window.confirm).mockImplementation(() => false);
    expect(s.close()).toBe(false);
    expect(editor.useEditorStore.getState().open).toBe(true);

    vi.mocked(window.confirm).mockImplementation(() => true);
    expect(s.close()).toBe(true);
    expect(window.confirm).toHaveBeenCalledWith('有未保存的改动，确定要关闭吗？');

    s.openCreate();
    s.patchDraft({ title: '改动' });
    expect(s.close(true)).toBe(true); // 强制关闭不弹确认
    expect(window.confirm).toHaveBeenCalledTimes(2); // 只有前两处非强制关闭调用过
  });
});

describe('草稿编辑与 dirty 跟踪', () => {
  it('setDraft / patchDraft / touch 推进 dirty', () => {
    const s = editor.useEditorStore.getState();
    s.openCreate(deadlineDraft());
    expect(s.dirty).toBe(false);
    s.patchDraft({ title: '改标题' });
    expect(editor.useEditorStore.getState().dirty).toBe(true);
    editor.useEditorStore.getState().touch();
    expect(editor.useEditorStore.getState().dirty).toBe(true);
  });

  it('setDraft 回到初始内容时 dirty 归零', () => {
    const s = editor.useEditorStore.getState();
    s.openCreate(deadlineDraft());
    const original = editor.useEditorStore.getState().draft;
    s.setDraft({ ...original, title: '临时' });
    expect(editor.useEditorStore.getState().dirty).toBe(true);
    s.setDraft({ ...original });
    expect(editor.useEditorStore.getState().dirty).toBe(false);
  });
});

describe('save', () => {
  it('没有标题 / fixed 缺重复规则 / deadline 缺截止时间 → 拦截', () => {
    const s = editor.useEditorStore.getState();

    s.openCreate({ title: '  ' });
    expect(s.save()).toBe(false);

    s.openCreate({ title: 'x', kind: 'fixed' as const, recurrence: null });
    expect(s.save()).toBe(false);

    s.openCreate({ title: 'x', kind: 'deadline' as const, dueAt: null });
    expect(s.save()).toBe(false);

    expect(editor.useEditorStore.getState().open).toBe(true);
    expect(ui.useUiStore.getState().toasts.filter((t) => t.kind === 'error').length).toBeGreaterThanOrEqual(3);
  });

  it('create 模式保存成功', () => {
    const s = editor.useEditorStore.getState();
    s.openCreate(deadlineDraft());
    expect(s.save()).toBe(true);
    expect(editor.useEditorStore.getState().open).toBe(false);
    expect(tasks.listTasks()).toHaveLength(1);
    const toast = ui.useUiStore.getState().toasts.find((t) => t.message === '已创建');
    expect(toast?.detail).toBe('2026-09-20 10:00');
  });

  it('create 模式底层校验失败 → 不关闭', () => {
    const s = editor.useEditorStore.getState();
    s.openCreate({ title: 'x', kind: 'deadline', dueAt: 'bad-time' });
    expect(s.save()).toBe(false);
    expect(editor.useEditorStore.getState().open).toBe(true);
  });

  it('edit 模式保存成功 / 失败', () => {
    const t = tasks.createTask(deadlineDraft())!;
    const s = editor.useEditorStore.getState();
    s.openEdit(t.id);
    s.patchDraft({ title: '改名' });
    expect(s.save()).toBe(true);
    expect(tasks.taskMap().get(t.id)!.title).toBe('改名');
    expect(ui.useUiStore.getState().toasts.some((x) => x.message === '已保存')).toBe(true);

    s.openEdit(t.id);
    editor.useEditorStore.getState().patchDraft({ dueAt: 'bad' });
    expect(editor.useEditorStore.getState().save()).toBe(false);
    expect(editor.useEditorStore.getState().open).toBe(true);
  });
});

describe('saveAndNew', () => {
  it('连续录入：保留 kind / tags / recurrence', () => {
    const s = editor.useEditorStore.getState();
    s.openCreate({
      title: '晨会',
      kind: 'fixed',
      recurrence: {
        freq: 'daily', interval: 1, byWeekday: [], byMonthday: [], byMonth: [], nthWeekday: null,
        startTime: '09:00', endTime: '09:30', dtstart: '2026-09-07', until: null, count: null, exdates: [],
      },
      tags: ['工作'],
    });
    s.saveAndNew();
    const s2 = editor.useEditorStore.getState();
    expect(s2.open).toBe(true);
    expect(s2.mode).toBe('create');
    expect(s2.draft.kind).toBe('fixed');
    expect(s2.draft.tags).toEqual(['工作']);
    expect(s2.draft.recurrence).toEqual({
      freq: 'daily', interval: 1, byWeekday: [], byMonthday: [], byMonth: [], nthWeekday: null,
      startTime: '09:00', endTime: '09:30', dtstart: '2026-09-07', until: null, count: null, exdates: [],
    });
    expect(tasks.listTasks()).toHaveLength(1);
    expect(ui.useUiStore.getState().toasts.some((x) => x.message === '已创建，继续添加')).toBe(true);
  });

  it('没有标题时不创建；底层失败时停留在当前草稿', () => {
    const s = editor.useEditorStore.getState();
    s.openCreate({ title: '  ' });
    s.saveAndNew();
    expect(tasks.listTasks()).toHaveLength(0);

    s.openCreate({ title: 'x', kind: 'deadline', dueAt: 'bad' });
    s.saveAndNew();
    expect(tasks.listTasks()).toHaveLength(0);
    expect(editor.useEditorStore.getState().draft.dueAt).toBe('bad');
  });

  it('deadline 任务连续录入：recurrence 保留为 null', () => {
    const s = editor.useEditorStore.getState();
    s.openCreate({ title: '检查邮件', kind: 'deadline', dueAt: '2026-09-20T10:00' });
    s.saveAndNew();
    const s2 = editor.useEditorStore.getState();
    expect(s2.open).toBe(true);
    expect(s2.draft.kind).toBe('deadline');
    expect(s2.draft.recurrence).toBeNull();
    expect(tasks.listTasks()).toHaveLength(1);
  });
});

describe('工具函数', () => {
  it('defaultDue 是下一个整点', () => {
    const due = editor.useEditorStore.getState().defaultDue();
    expect(due).toMatch(/T\d{2}:00$/);
    expect(due).not.toMatch(/T\d{2}:00T/);
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    expect(due.endsWith(`T${String(d.getHours()).padStart(2, '0')}:00`)).toBe(true);
  });

  it('editorDefaults 给出今天 / 本周起始 / 当前时刻', () => {
    const d = editor.editorDefaults();
    expect(d.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(d.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('summarize：fixed 走 describe；无截止时间兜底', () => {
    const s = editor.useEditorStore.getState();
    s.openCreate({ title: 'f', kind: 'fixed', recurrence: {
      freq: 'daily', interval: 1, byWeekday: [], byMonthday: [], byMonth: [], nthWeekday: null,
      startTime: '09:00', endTime: '10:00', dtstart: '2026-09-07', until: null, count: null, exdates: [],
    } });
    editor.useEditorStore.getState().patchDraft({ title: 'f2' });
    expect(editor.useEditorStore.getState().save()).toBe(true);
    const toast = ui.useUiStore.getState().toasts.find((t) => t.message === '已创建');
    expect(toast?.detail).toContain('09:00–10:00');

    // 全天截止任务带（全天）后缀
    s.openCreate({ title: 'x', kind: 'deadline', dueAt: '2026-09-20T10:00', allDay: true });
    editor.useEditorStore.getState().save();
    const toast2 = ui.useUiStore.getState().toasts.filter((t) => t.message === '已创建').pop();
    expect(toast2?.detail).toBe('2026-09-20 10:00（全天）');
  });
});

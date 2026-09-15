import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toLocalDateTime, addDays, toDateKey } from '@shared/recurrence.js';

vi.mock('@/lib/sync', () => ({ requestSync: vi.fn() }));

let tasks: typeof import('./tasks');
let repo: typeof import('@/lib/localrepo');
let ui: typeof import('./ui');

const today = () => {
  const d = new Date();
  return toDateKey(d);
};

function weeklyRule(over: Record<string, unknown> = {}) {
  return {
    freq: 'weekly',
    interval: 1,
    byWeekday: [1],
    byMonthday: [],
    byMonth: [],
    nthWeekday: null,
    startTime: '09:00',
    endTime: '10:00',
    dtstart: '2026-09-07',
    until: null,
    count: null,
    exdates: [],
    ...over,
  };
}

function deadlineTask(title: string, dueAt: string, over: Record<string, unknown> = {}) {
  const t = tasks.createTask({ title, kind: 'deadline', dueAt, ...over });
  expect(t).not.toBeNull();
  return t!;
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
  // store 的筛选状态复位
  tasks.useTaskStore.setState({ searchQuery: '', filterKind: 'all', filterTag: '', showArchived: false });
  const syncMod = await import('@/lib/sync');
  vi.mocked(syncMod.requestSync).mockClear();
});

describe('原始数据与规范化', () => {
  it('listTasks 对老记录补齐默认值', () => {
    repo.upsertRecord({ kind: 'task', data: { title: 'legacy', priority: 9 } });
    const [t] = tasks.listTasks();
    expect(t).toMatchObject({
      title: 'legacy',
      notes: '',
      kind: 'deadline',
      status: 'open',
      tags: [],
      recurrence: null,
      dueAt: null,
      allDay: false,
      priority: 0,
    });
    expect(t.createdAt).toBeTypeOf('number');
  });

  it('tags 里混入非字符串时被剔除', () => {
    repo.upsertRecord({ kind: 'task', data: { title: 'x', tags: ['a', 3, null, 'b'] } });
    expect(tasks.listTasks()[0].tags).toEqual(['a', 'b']);
  });

  it('completionMap 剔除没有 taskId 的脏数据', () => {
    repo.upsertRecord({ kind: 'completion', data: { taskId: 't1', occurrence: '2026-09-09', doneAt: 1 } });
    repo.upsertRecord({ kind: 'completion', data: { foo: 1 } });
    expect(tasks.completionMap().size).toBe(1);
  });

  it('taskMap / getRawRecord', () => {
    const t = deadlineTask('x', '2026-09-20T10:00');
    expect(tasks.taskMap().get(t.id)!.title).toBe('x');
    expect(tasks.getRawRecord(t.id)!.kind).toBe('task');
  });

  it('data 字段为 null 的记录也能读出默认值', () => {
    repo.upsertRecord({ kind: 'task', data: null as unknown as Record<string, unknown> });
    const [t] = tasks.listTasks();
    expect(t.title).toBe('');
    expect(t.tags).toEqual([]);
    expect(t.priority).toBe(0);
  });

  it('title/notes 为非字符串时归空；priority 只认 1/2', () => {
    repo.upsertRecord({ kind: 'task', data: { title: 42, notes: {}, priority: 1 } });
    const [t] = tasks.listTasks();
    expect(t.title).toBe('');
    expect(t.notes).toBe('');
    expect(t.priority).toBe(1);
  });
});

describe('describe 文案', () => {
  it('deadline：具体时刻 / 全天 / 缺截止时间', () => {
    expect(tasks.describe(deadlineTask('a', '2026-09-20T09:30'))).toContain('09:30 截止');
    const allDay = deadlineTask('b', '2026-09-20T09:30', { allDay: true });
    expect(tasks.describe(allDay)).toContain('全天');
    // 缺 dueAt 的 deadline 只能来自脏数据
    repo.upsertRecord({ kind: 'task', data: { kind: 'deadline' } });
    const bad = tasks.listTasks().find((x) => x.title === '' && x.kind === 'deadline')!;
    expect(tasks.describe(bad)).toBe('无截止时间');
  });

  it('fixed：有规则时描述规则；规则缺失时退化为空规则', () => {
    const f = tasks.createTask({ title: 'r', kind: 'fixed', recurrence: weeklyRule() })!;
    expect(tasks.describe(f)).toContain('09:00');
    // 规则缺失只能来自脏数据
    repo.upsertRecord({ kind: 'task', data: { kind: 'fixed', recurrence: null } });
    const bad = tasks.listTasks().find((x) => x.title === '' && x.kind === 'fixed')!;
    expect(() => tasks.describe(bad)).not.toThrow();
  });
});

describe('展开与缓存', () => {
  it('expandRange：固定任务按规则展开并排序；rev 推进后缓存失效', () => {
    const f = tasks.createTask({ title: 'fixed', kind: 'fixed', recurrence: weeklyRule() })!;
    deadlineTask('d', '2026-09-09T08:00');

    const a = tasks.expandRange('2026-09-07', '2026-09-13');
    expect(a.map((o) => o.occurrence.dateKey)).toEqual(['2026-09-07', '2026-09-09']);
    expect(a[0].occurrence.kind).toBe('fixed');
    expect(a[0].task.id).toBe(f.id);

    const b = tasks.expandRange('2026-09-07', '2026-09-13');
    expect(b).toBe(a); // 同 rev 命中缓存

    tasks.updateTask(f.id, { title: 'fixed2' });
    const c = tasks.expandRange('2026-09-07', '2026-09-13');
    expect(c).not.toBe(a);
    expect(c[0].task.title).toBe('fixed2');
  });

  it('归档任务不展开', () => {
    const t = tasks.createTask({ title: 'arch', kind: 'fixed', recurrence: weeklyRule() })!;
    tasks.archiveTask(t.id);
    expect(tasks.expandRange('2026-09-07', '2026-09-13')).toEqual([]);
    expect(tasks.occurrencesForDate('2026-09-07')).toEqual([]);
  });

  it('同一时刻 deadline 排在 fixed 前面；同 kind 按标题排序', () => {
    deadlineTask('b', '2026-09-07T09:00');
    deadlineTask('a', '2026-09-07T09:00');
    tasks.createTask({ title: 'c', kind: 'fixed', recurrence: weeklyRule() })!;
    const out = tasks.expandRange('2026-09-07', '2026-09-07');
    expect(out.map((o) => o.task.title)).toEqual(['a', 'b', 'c']);
  });

  it('occurrencesForDate 单日展开', () => {
    tasks.createTask({ title: 'f', kind: 'fixed', recurrence: weeklyRule() })!;
    const out = tasks.occurrencesForDate('2026-09-07');
    expect(out).toHaveLength(1);
    expect(out[0].occurrence.startMinutes).toBe(540);
    expect(out[0].occurrence.endMinutes).toBe(600);
  });

  it('overflowInto 捕捉跨午夜落到当日的尾巴', () => {
    tasks.createTask({
      title: 'night',
      kind: 'fixed',
      recurrence: weeklyRule({ startTime: '23:00', endTime: '01:00', dtstart: '2026-09-12', byWeekday: [6] }),
    })!;
    const out = tasks.overflowInto('2026-09-13');
    expect(out).toHaveLength(1);
    expect(out[0].occurrence.spansMidnight).toBe(true);
    expect(out[0].occurrence.endsOnNextDay).toBe('2026-09-13');
  });

  it('overdueDeadlines：只收逾期未完成的截止任务，按时间升序并可截断', () => {
    const past1 = toLocalDateTime(new Date(Date.now() - 26 * 3600e3));
    const past2 = toLocalDateTime(new Date(Date.now() - 2 * 3600e3));
    deadlineTask('old', past1);
    deadlineTask('recent', past2);
    deadlineTask('future', toLocalDateTime(new Date(Date.now() + 24 * 3600e3)));

    const done = deadlineTask('done', past1);
    tasks.toggleCompletion(done.id, past1);
    expect(tasks.overdueDeadlines().map((o) => o.task.title)).toEqual(['old', 'recent']);
    expect(tasks.overdueDeadlines(1).map((o) => o.task.title)).toEqual(['old']);
  });
});

describe('写操作', () => {
  it('createTask：校验失败弹错误并返回 null', () => {
    expect(tasks.createTask({ title: '  ' })).toBeNull();
    expect(tasks.createTask({ title: 'x', kind: 'deadline', dueAt: null, tags: Array(21).fill('t') })).toBeNull();
    expect(tasks.listTasks()).toHaveLength(0);
    expect(ui.useUiStore.getState().toasts.some((t) => t.kind === 'error')).toBe(true);
  });

  it('createTask 成功后写入仓库', () => {
    const t = deadlineTask('ok', '2026-09-20T10:00');
    expect(repo.getRecord(t.id)).toBeTruthy();
    expect(t.createdAt).toBeGreaterThan(0);
  });

  it('updateTask：不存在 / 校验失败 / 成功', () => {
    const t = deadlineTask('a', '2026-09-20T10:00');
    expect(tasks.updateTask('missing', { title: 'x' })).toBe(false);
    expect(tasks.updateTask(t.id, { dueAt: 'bad' })).toBe(false);
    expect(tasks.updateTask(t.id, { title: 'b' })).toBe(true);
    expect(tasks.taskMap().get(t.id)!.title).toBe('b');
  });

  it('deadline 改截止时间后，旧的完成打卡被清掉', () => {
    const t = deadlineTask('a', '2026-09-20T10:00');
    tasks.toggleCompletion(t.id, '2026-09-20T10:00');
    expect(tasks.isDone(t.id, '2026-09-20T10:00')).toBe(true);
    expect(tasks.updateTask(t.id, { dueAt: '2026-09-21T10:00' })).toBe(true);
    expect(tasks.isDone(t.id, '2026-09-20T10:00')).toBe(false);
  });

  it('任务改为 fixed 后改截止时间，不影响按日打卡', () => {
    const t = deadlineTask('a', '2026-09-20T10:00');
    tasks.toggleCompletion(t.id, '2026-09-20T10:00');
    expect(
      tasks.updateTask(t.id, {
        kind: 'fixed',
        recurrence: weeklyRule(),
        dueAt: '2026-09-21T10:00',
      }),
    ).toBe(true);
    expect(tasks.isDone(t.id, '2026-09-20T10:00')).toBe(true);
  });

  it('deleteTask 连带清掉完成记录；不存在的 id 安静返回', () => {
    const t = deadlineTask('a', '2026-09-20T10:00');
    tasks.toggleCompletion(t.id, '2026-09-20T10:00');
    tasks.deleteTask(t.id);
    expect(repo.getRecord(t.id)!.deleted).toBe(true);
    expect(tasks.completionRecords().every((r) => r.deleted)).toBe(true);
    tasks.deleteTask('missing');
  });

  it('archiveTask 切换归档状态', () => {
    const t = deadlineTask('a', '2026-09-20T10:00');
    tasks.archiveTask(t.id);
    expect(tasks.taskMap().get(t.id)!.status).toBe('archived');
    tasks.archiveTask(t.id, false);
    expect(tasks.taskMap().get(t.id)!.status).toBe('open');
  });

  it('toggleCompletion 勾选 / 取消；isDone 查询', () => {
    const t = tasks.createTask({ title: 'f', kind: 'fixed', recurrence: weeklyRule() })!;
    expect(tasks.isDone(t.id, '2026-09-07')).toBe(false);
    tasks.toggleCompletion(t.id, '2026-09-07');
    expect(tasks.isDone(t.id, '2026-09-07')).toBe(true);
    tasks.toggleCompletion(t.id, '2026-09-07');
    expect(tasks.isDone(t.id, '2026-09-07')).toBe(false);
  });

  it('duplicateTask 复制任务；不存在时无动作', () => {
    const t = deadlineTask('a', '2026-09-20T10:00');
    tasks.duplicateTask(t.id);
    expect(tasks.listTasks().some((x) => x.title === 'a（副本）')).toBe(true);
    const before = tasks.listTasks().length;
    tasks.duplicateTask('missing');
    expect(tasks.listTasks()).toHaveLength(before);
  });
});

describe('筛选与统计', () => {
  function seed(): { a: string; b: string; c: string } {
    const b = deadlineTask('find-in-notes', '2026-09-21T10:00', { notes: 'needle here' });
    const a = tasks.createTask({ title: 'alpha', kind: 'fixed', tags: ['工作'], recurrence: weeklyRule() })!;
    const c = deadlineTask('old-archived', '2026-09-19T10:00', { status: 'archived' });
    // 同毫秒创建会让 updatedAt 退化为插入序，显式钉住排序
    const bump = (id: string, ts: number) => {
      const r = repo.getRecord(id)!;
      r.data = { ...(r.data as Record<string, unknown>), updatedAt: ts };
    };
    bump(b.id, 1000);
    bump(a.id, 2000);
    bump(c.id, 3000);
    return { a: a.id, b: b.id, c: c.id };
  }

  it('默认隐藏归档；showArchived 打开后归档排最后', () => {
    const { a, b, c } = seed();
    expect(tasks.filteredTasks().map((t) => t.id)).toEqual([a, b]);
    tasks.useTaskStore.getState().setShowArchived(true);
    expect(tasks.filteredTasks().map((t) => t.id)).toEqual([a, b, c]);
  });

  it('kind / tag / 搜索（标题与备注）过滤', () => {
    const { a, b } = seed();
    tasks.useTaskStore.getState().setFilterKind('fixed');
    expect(tasks.filteredTasks().map((t) => t.id)).toEqual([a]);
    tasks.useTaskStore.getState().setFilterKind('all');
    tasks.useTaskStore.getState().setFilterTag('工作');
    expect(tasks.filteredTasks().map((t) => t.id)).toEqual([a]);
    tasks.useTaskStore.getState().setFilterTag('');
    tasks.useTaskStore.getState().setSearchQuery('  NEEDLE  ');
    expect(tasks.filteredTasks().map((t) => t.id)).toEqual([b]);
    tasks.useTaskStore.getState().setSearchQuery('alpha');
    expect(tasks.filteredTasks().map((t) => t.id)).toEqual([a]);
  });

  it('clearFilters 复位全部筛选', () => {
    seed();
    const s = tasks.useTaskStore.getState();
    s.setSearchQuery('x');
    s.setFilterKind('fixed');
    s.setFilterTag('工作');
    s.setShowArchived(true);
    s.clearFilters();
    expect(tasks.useTaskStore.getState()).toMatchObject({
      searchQuery: '',
      filterKind: 'all',
      filterTag: '',
      showArchived: false,
    });
  });

  it('allTags 去重并按中文排序', () => {
    deadlineTask('a', '2026-09-20T10:00', { tags: ['工作', '生活'] });
    deadlineTask('b', '2026-09-20T11:00', { tags: ['工作', '学习'] });
    expect(tasks.allTags()).toEqual(['工作', '生活', '学习']);
  });

  it('nextOccurrenceOf：缺失 / 归档 → null；固定任务给出下一次', () => {
    expect(tasks.nextOccurrenceOf('missing')).toBeNull();
    const t = tasks.createTask({ title: 'f', kind: 'fixed', recurrence: weeklyRule() })!;
    expect(tasks.nextOccurrenceOf(t.id)).not.toBeNull();
    tasks.archiveTask(t.id);
    expect(tasks.nextOccurrenceOf(t.id)).toBeNull();
  });

  it('completionStreak：今天没打卡时从昨天起算', () => {
    const y = addDays(today(), -1)!;
    const y2 = addDays(today(), -2)!;
    repo.upsertRecord({ id: `c1|${y}`, kind: 'completion', data: { taskId: 'c1', occurrence: y, doneAt: 1 } });
    repo.upsertRecord({ id: `c1|${y2}`, kind: 'completion', data: { taskId: 'c1', occurrence: y2, doneAt: 1 } });
    expect(tasks.completionStreak()).toBe(2);

    // 今天也打了 → 3
    repo.upsertRecord({
      id: `c1|${today()}`,
      kind: 'completion',
      data: { taskId: 'c1', occurrence: today(), doneAt: 1 },
    });
    expect(tasks.completionStreak()).toBe(3);
  });

  it('completionStreak：断档归零', () => {
    const y3 = addDays(today(), -3)!;
    repo.upsertRecord({ id: `c2|${y3}`, kind: 'completion', data: { taskId: 'c2', occurrence: y3, doneAt: 1 } });
    expect(tasks.completionStreak()).toBe(0);
  });

  it('completionStreak 忽略没有 occurrence 的记录', () => {
    repo.upsertRecord({ id: 'bad', kind: 'completion', data: { taskId: 'c' } });
    expect(tasks.completionStreak()).toBe(0);
  });
});

describe('describe 描述', () => {
  it('deadline 各形态', () => {
    expect(tasks.describe({ ...emptyDeadline(), dueAt: null })).toBe('无截止时间');
    expect(tasks.describe(emptyDeadline({ dueAt: '2026-09-20T10:00', allDay: true }))).toContain('全天');
    expect(tasks.describe(emptyDeadline({ dueAt: '2026-09-20T10:00' }))).toMatch(/9 月 20 日 10:00 截止/);
  });

  function emptyDeadline(over: Partial<import('@/lib/types').Task> = {}): import('@/lib/types').Task {
    return {
      id: 'x',
      title: 'x',
      notes: '',
      kind: 'deadline',
      status: 'open',
      tags: [],
      recurrence: null,
      dueAt: null,
      allDay: false,
      priority: 0,
      createdAt: 1,
      updatedAt: 1,
      ...over,
    };
  }

  it('fixed 任务走 describeRecurrence', () => {
    const t = tasks.createTask({ title: 'f', kind: 'fixed', recurrence: weeklyRule() })!;
    expect(tasks.describe(t)).toContain('周一');
    expect(tasks.describe(t)).toContain('09:00–10:00');
  });
});

describe('排序与下次日程', () => {
  it('同时刻开始时，截止型排在固定型前面', () => {
    // 2026-09-07 是周一
    tasks.createTask({ title: '固定', kind: 'fixed', recurrence: weeklyRule() });
    deadlineTask('截止', '2026-09-07T09:00');
    const list = tasks.occurrencesForDate('2026-09-07');
    expect(list).toHaveLength(2);
    expect(list[0].occurrence.kind).toBe('deadline');
  });

  it('同时刻同类型按标题排序', () => {
    tasks.createTask({ title: '乙', kind: 'fixed', recurrence: weeklyRule() });
    tasks.createTask({ title: '甲', kind: 'fixed', recurrence: weeklyRule({ startTime: '10:00', endTime: '11:00' }) });
    const list = tasks.occurrencesForDate('2026-09-07');
    expect(list.map((x) => x.task.title)).toEqual(['乙', '甲']);
  });

  it('同时刻同标题的任务保持稳定', () => {
    const a = tasks.createTask({ title: '同', kind: 'fixed', recurrence: weeklyRule() })!;
    const b = tasks.createTask({ title: '同', kind: 'fixed', recurrence: weeklyRule() })!;
    const list = tasks.occurrencesForDate('2026-09-07');
    const ids = list.filter((x) => x.task.title === '同').map((x) => x.task.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('归档任务排在未完成任务后面（showArchived 开启时可见）', () => {
    const open = deadlineTask('进行中', '2026-09-20T10:00');
    const done = deadlineTask('已归档', '2026-09-21T10:00');
    tasks.updateTask(done.id, { status: 'archived' });
    // 再造一条更晚创建的未完成任务：三个任务让比较器的两个方向都被走到
    const open2 = deadlineTask('进行中 2', '2026-09-22T10:00');
    tasks.useTaskStore.getState().setShowArchived(true);
    const statuses = tasks.filteredTasks().map((t) => t.status);
    expect(statuses).toEqual(['open', 'open', 'archived']);
    expect(tasks.filteredTasks()[2].id).toBe(done.id);
  });

  it('nextOccurrenceOf：过去的截止任务返回 null', () => {
    const old = deadlineTask('过去', '2020-01-01T10:00');
    expect(tasks.nextOccurrenceOf(old.id)).toBeNull();
  });
});

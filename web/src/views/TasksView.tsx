/**
 * 任务：全量列表与筛选。
 *
 * 与今日/本周的区别在于视角 —— 那两页看"时间"，这一页看"对象"。
 * 所以这里以任务为单位列出（重复任务只占一行），并给出它的下一次安排，
 * 而不是把每一次重复都铺开。
 */
import {
  allTags as allTagsOf,
  archiveTask,
  completionStreak,
  deleteTask,
  describe,
  duplicateTask,
  filteredTasks,
  listTasks,
  nextOccurrenceOf,
  useTaskStore,
} from '@/stores/tasks';
import { useEditorStore } from '@/stores/editor';
import { formatDateLabel } from '@/lib/datetime';
import { formatDuration } from '@shared/recurrence.js';
import type { Task } from '@/lib/types';
import { useRepoRev } from '@/hooks/useSyncTick';
import PageHead from '@/components/PageHead';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import './TasksView.css';

const KIND_OPTIONS: Array<{ v: 'all' | 'fixed' | 'deadline'; label: string }> = [
  { v: 'all', label: '全部' },
  { v: 'fixed', label: '固定时段' },
  { v: 'deadline', label: '截止' },
];

/** 下一次安排。截止任务只有一次，所以它要么在未来，要么已经过去了。 */
function nextLabel(task: Task): string {
  if (task.status === 'archived') return '已归档';
  const occ = nextOccurrenceOf(task.id);
  if (!occ) return task.kind === 'deadline' ? '已超过截止时间' : '不再有后续日程';

  const day = formatDateLabel(occ.dateKey, { relative: true });
  if (task.kind === 'deadline') {
    const p = (n: number) =>
      `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
    return occ.allDay ? `${day} · 全天` : `${day} · ${p(occ.startMinutes)}`;
  }
  return `${day} · ${formatDuration(occ.durationMinutes)}`;
}

function overdueNow(task: Task): boolean {
  if (task.kind !== 'deadline' || !task.dueAt) return false;
  const occ = nextOccurrenceOf(task.id);
  return !!occ && occ.overdue && !occ.done;
}

export default function TasksView() {
  useRepoRev();

  const searchQuery = useTaskStore((s) => s.searchQuery);
  const filterKind = useTaskStore((s) => s.filterKind);
  const filterTag = useTaskStore((s) => s.filterTag);
  const showArchived = useTaskStore((s) => s.showArchived);
  const setSearchQuery = useTaskStore((s) => s.setSearchQuery);
  const setFilterKind = useTaskStore((s) => s.setFilterKind);
  const setFilterTag = useTaskStore((s) => s.setFilterTag);
  const setShowArchived = useTaskStore((s) => s.setShowArchived);
  const clearFilters = useTaskStore((s) => s.clearFilters);

  const filtered = filteredTasks();
  const active = filtered.filter((t) => t.status !== 'archived');
  const archived = filtered.filter((t) => t.status === 'archived');

  const everyTask = listTasks();
  const hasAnyTask = everyTask.length > 0;
  const filtersOn =
    !!searchQuery.trim() || filterKind !== 'all' || !!filterTag || showArchived;

  const headSubtitle = (() => {
    if (!hasAnyTask) return '还没有任务';
    const parts = [`共 ${everyTask.length} 个任务`];
    if (active.length !== everyTask.filter((t) => t.status !== 'archived').length) {
      parts.push(`筛选出 ${active.length} 个`);
    }
    const streak = completionStreak();
    if (streak > 0) parts.push(`连续打卡 ${streak} 天`);
    return parts.join(' · ');
  })();

  function remove(task: Task): void {
    const ok = window.confirm(`删除「${task.title}」？该操作会同步到所有设备，无法撤销。`);
    if (ok) deleteTask(task.id);
  }

  function toggleArchive(task: Task): void {
    archiveTask(task.id, task.status !== 'archived');
  }

  return (
    <div className="tasks-view">
      <PageHead
        title="任务"
        subtitle={headSubtitle}
        actions={
          <button
            className="btn btn--primary btn--sm"
            type="button"
            onClick={() => useEditorStore.getState().openCreate()}
          >
            <Icon name="plus" size={16} />
            新建
          </button>
        }
      />

      {/* ── 工具条 ── */}
      {hasAnyTask && (
        <div className="bar">
          <label className="search">
            <Icon name="search" size={15} />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              type="search"
              placeholder="搜索标题或备注"
              aria-label="搜索任务"
            />
            {searchQuery && (
              <button
                className="search__clear"
                type="button"
                aria-label="清空搜索"
                onClick={() => setSearchQuery('')}
              >
                <Icon name="x" size={13} />
              </button>
            )}
          </label>

          <div className="seg" role="group" aria-label="按类型筛选">
            {KIND_OPTIONS.map((opt) => (
              <button
                key={opt.v}
                type="button"
                className={`seg__item${filterKind === opt.v ? ' is-on' : ''}`}
                aria-pressed={filterKind === opt.v}
                onClick={() => setFilterKind(opt.v)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {allTagsOf().length > 0 && (
            <select
              value={filterTag}
              onChange={(e) => setFilterTag(e.target.value)}
              className="tag-select"
              aria-label="按标签筛选"
            >
              <option value="">全部标签</option>
              {allTagsOf().map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          )}

          <button
            className={`toggle${showArchived ? ' is-on' : ''}`}
            type="button"
            onClick={() => setShowArchived(!showArchived)}
          >
            <Icon name="archive" size={14} />
            已归档
          </button>

          {filtersOn && (
            <button
              className="btn btn--ghost btn--sm clear"
              type="button"
              onClick={() => clearFilters()}
            >
              清除筛选
            </button>
          )}
        </div>
      )}

      {/* ── 列表 ── */}
      {active.length > 0 || archived.length > 0 ? (
        <div className="list">
          {[...active, ...archived].map((task) => (
            <article
              key={task.id}
              className={`row${task.status === 'archived' ? ' is-archived' : ''}`}
              data-kind={task.kind}
            >
              <span className="row__mark" aria-hidden="true" />

              <div className="row__main">
                <div className="row__line">
                  <h2 className="row__title">{task.title}</h2>
                  {task.priority > 0 && (
                    <span
                      className="row__pri"
                      data-p={task.priority}
                      title={task.priority === 2 ? '紧急' : '重要'}
                    />
                  )}
                  {task.priority > 0 && (
                    <span className="row__pri-text" data-p={task.priority}>
                      {task.priority === 2 ? '紧急' : '重要'}
                    </span>
                  )}
                  {task.status === 'archived' && <span className="row__badge">已归档</span>}
                </div>

                <p className="row__meta">
                  <span className={`row__next${overdueNow(task) ? ' is-overdue' : ''}`}>
                    {nextLabel(task)}
                  </span>
                  <span className="row__sep">·</span>
                  <span className="row__rule">{describe(task)}</span>
                </p>

                {task.notes && <p className="row__notes">{task.notes}</p>}

                {task.tags.length > 0 && (
                  <div className="row__tags">
                    {task.tags.map((tag) => (
                      <span key={tag} className="chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="row__actions">
                <button
                  className="act"
                  type="button"
                  title="编辑"
                  aria-label="编辑"
                  onClick={() => useEditorStore.getState().openEdit(task.id)}
                >
                  <Icon name="edit" size={15} />
                </button>
                <button
                  className="act"
                  type="button"
                  title="创建副本"
                  aria-label="创建副本"
                  onClick={() => duplicateTask(task.id)}
                >
                  <Icon name="copy" size={15} />
                </button>
                <button
                  className="act"
                  type="button"
                  title={task.status === 'archived' ? '取消归档' : '归档'}
                  aria-label={task.status === 'archived' ? '取消归档' : '归档'}
                  onClick={() => toggleArchive(task)}
                >
                  <Icon name={task.status === 'archived' ? 'inbox' : 'archive'} size={15} />
                </button>
                <button
                  className="act act--danger"
                  type="button"
                  title="删除"
                  aria-label="删除"
                  onClick={() => remove(task)}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : !hasAnyTask ? (
        <EmptyState
          icon="list"
          title="还没有任务"
          hint="固定时段的例行安排，或一次性的截止事项，都可以在这里建立。"
        >
          <button
            className="btn btn--primary"
            type="button"
            onClick={() => useEditorStore.getState().openCreate()}
          >
            <Icon name="plus" size={16} />
            新建第一个任务
          </button>
        </EmptyState>
      ) : (
        <EmptyState icon="search" title="没有符合条件的任务" hint="换个关键词，或清除筛选条件。">
          <button className="btn" type="button" onClick={() => clearFilters()}>
            清除筛选
          </button>
        </EmptyState>
      )}

      {active.length + archived.length > 0 && (
        <p className="foot faint tnum">
          显示 {active.length + archived.length} 条
          {archived.length > 0 && <>（含 {archived.length} 条已归档）</>}
        </p>
      )}
    </div>
  );
}

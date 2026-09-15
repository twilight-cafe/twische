/**
 * 任务编辑器。
 *
 * 两种任务类型共用一套表单，但各自的必填项完全不同：
 * - 固定时段：必须有重复规则，起止时间决定时长
 * - 截止时间：必须精确到分钟，可选"全天"
 *
 * 类型切换时会**重建默认值**而不是保留非法字段 —— 否则从"固定"切到"截止"
 * 会留下一个空的 dueAt，用户点保存才被告知缺字段。
 */
import { useEffect, useMemo, useState } from 'react';
import { useEditorStore } from '@/stores/editor';
import { allTags as allTagsOf, deleteTask } from '@/stores/tasks';
import { useRepoRev } from '@/hooks/useSyncTick';
import { notify, useUiStore } from '@/stores/ui';
import { DEFAULT_TAGS, type Recurrence, type Task } from '@/lib/types';
import { addDays, todayKey, WEEKDAY_FULL, isoWeekday } from '@/lib/datetime';
import { useNow } from '@/hooks/useNow';
import Sheet from './Sheet';
import Icon from './Icon';
import RecurrenceBuilder from './RecurrenceBuilder';
import DateField from './DateField';
import TimeField from './TimeField';
import './TaskEditor.css';

/** 默认重复规则：每周一至周五，09:00–18:00 之外更常见的是工作日例会，先给工作日。 */
const DEFAULT_RECURRENCE: Recurrence = {
  freq: 'weekly',
  interval: 1,
  byWeekday: [1, 2, 3, 4, 5],
  byMonthday: [],
  byMonth: [],
  nthWeekday: null,
  startTime: '09:00',
  endTime: '10:00',
  dtstart: todayKey(),
  until: null,
  count: null,
  exdates: [],
};

const DUE_TIME_PRESETS = ['09:00', '12:00', '18:00', '22:00'];

const PRIORITIES = [
  { value: 0, label: '普通' },
  { value: 1, label: '重要' },
  { value: 2, label: '紧急' },
] as const;

export function humanizeSpan(ms: number): string {
  const mins = Math.max(0, Math.round(Math.abs(ms) / 60_000));
  if (mins < 1) return '不到 1 分钟';
  if (mins < 60) return `${mins} 分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} 天 ${rh} 小时` : `${d} 天`;
}

export default function TaskEditor() {
  const open = useEditorStore((s) => s.open);
  const mode = useEditorStore((s) => s.mode);
  const editingId = useEditorStore((s) => s.editingId);
  const draft = useEditorStore((s) => s.draft);
  const editorTitle = useEditorStore((s) => s.title);
  const setDraft = useEditorStore((s) => s.setDraft);
  const close = useEditorStore((s) => s.close);
  const save = useEditorStore((s) => s.save);
  const saveAndNew = useEditorStore((s) => s.saveAndNew);
  const defaultDue = useEditorStore((s) => s.defaultDue);

  // 仓库任何写入都会推进 rev，标签建议随之重算
  useRepoRev();
  const tagPool = allTagsOf();

  // 让"还有多久截止"这行提示自己走时，而不是打开弹窗时算一次就定格
  const { minutes: nowMinutes } = useNow();

  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);

  const isEdit = mode === 'edit';

  function setKind(kind: 'fixed' | 'deadline'): void {
    if (draft.kind === kind) return;
    if (kind === 'fixed') {
      setDraft({
        ...draft,
        kind: 'fixed',
        dueAt: null,
        allDay: false,
        recurrence: draft.recurrence
          ? { ...draft.recurrence, dtstart: todayKey() }
          : { ...DEFAULT_RECURRENCE },
      });
    } else {
      setDraft({
        ...draft,
        kind: 'deadline',
        recurrence: null,
        dueAt: draft.dueAt || defaultDue(),
      });
    }
  }

  // ── 截止时间的快捷设置 ──
  const dueDate = (draft.dueAt || '').slice(0, 10);
  const dueTime = (draft.dueAt || '').slice(11, 16);

  function setDueDate(v: string): void {
    const time = (draft.dueAt || '').slice(11, 16) || '18:00';
    setDraft({ ...draft, dueAt: v ? `${v}T${draft.allDay ? '23:59' : time}` : null });
  }

  function setDueTime(v: string): void {
    const date = (draft.dueAt || '').slice(0, 10) || todayKey();
    setDraft({ ...draft, dueAt: `${date}T${v || '18:00'}` });
  }

  const duePresets = useMemo(() => {
    const t = todayKey();
    const tomorrow = addDays(t, 1)!;
    // 本周日（若今天就是周日，给下周日之后的那个周日会让用户困惑，这里保留今天所在周）
    const iso = isoWeekday(new Date());
    const toSunday = 7 - iso;
    const sunday = addDays(t, toSunday === 0 ? 7 : toSunday)!;
    const nextWeek = addDays(t, 7)!;
    return [
      { label: '今天', date: t },
      { label: '明天', date: tomorrow },
      { label: '本周日', date: sunday },
      { label: '下周', date: nextWeek },
    ].filter((p, i, arr) => arr.findIndex((x) => x.date === p.date) === i);
    // 一天内不会变化，依赖为空是刻意的
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 关掉"全天"时要回到用户上次真正指定的钟点，而不是 23:59 这个内部占位值。 */
  const [lastConcreteTime, setLastConcreteTime] = useState('18:00');
  useEffect(() => {
    if (!draft.allDay && dueTime) setLastConcreteTime(dueTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.allDay, dueTime]);

  function setAllDay(next: boolean): void {
    if (draft.allDay === next) return;
    const date = (draft.dueAt || '').slice(0, 10) || todayKey();
    const time = next ? '23:59' : lastConcreteTime || '18:00';
    setDraft({ ...draft, allDay: next, dueAt: `${date}T${time}` });
  }

  /** 相对当下的紧迫度。读了 nowMinutes 才会随分钟自动刷新，不然打开弹窗后就定格。 */
  const dueHint = useMemo(() => {
    const v = draft.dueAt;
    if (!v) return '';
    const d = new Date(v.replace('T', ' ').replace(/-/g, '/'));
    if (Number.isNaN(d.getTime())) return '';
    void nowMinutes;
    if (draft.allDay) return `当天 23:59 前完成（${WEEKDAY_FULL[isoWeekday(d)]}）`;
    const diff = d.getTime() - Date.now();
    return diff >= 0 ? `还有 ${humanizeSpan(diff)}` : `已逾期 ${humanizeSpan(diff)}`;
  }, [draft.dueAt, draft.allDay, nowMinutes]);

  // ── 标签 ──
  function addTag(raw: string): void {
    const tag = raw.trim().slice(0, 20);
    if (!tag) return;
    if (draft.tags.includes(tag)) {
      setTagInput('');
      return;
    }
    if (draft.tags.length >= 20) {
      notify.warn('标签数量已达上限（20 个）');
      return;
    }
    setDraft({ ...draft, tags: [...draft.tags, tag] });
    setTagInput('');
  }

  function removeTag(tag: string): void {
    setDraft({ ...draft, tags: draft.tags.filter((t) => t !== tag) });
  }

  const tagSuggestions = useMemo(() => {
    const used = new Set(draft.tags);
    const all = new Set([...DEFAULT_TAGS, ...tagPool]);
    return [...all].filter((t) => !used.has(t)).slice(0, 8);
  }, [draft.tags, tagPool]);

  // ── 保存 / 删除 ──
  function onSave(): void {
    setSaving(true);
    save();
    setSaving(false);
  }

  function onDelete(): void {
    if (!isEdit) return;
    if (!window.confirm(`确定删除「${draft.title}」？`)) return;
    deleteTask(editingId);
    close(true);
  }

  const titleText = editorTitle();

  return (
    <Sheet
      open={open}
      title={titleText}
      subtitle={isEdit ? '修改后会立即同步到其它设备' : undefined}
      width="620px"
      dismissable={false}
      onClose={() => close()}
      footer={
        <>
          {isEdit && (
            <button className="btn btn--danger btn--sm te__del" type="button" onClick={onDelete}>
              <Icon name="trash" size={15} />
              删除
            </button>
          )}
          <span className="te__spacer" />
          <button className="btn" type="button" onClick={() => close()}>
            取消
          </button>
          {!isEdit && (
            <button
              className="btn"
              type="button"
              disabled={!draft.title.trim()}
              onClick={saveAndNew}
            >
              保存并继续
            </button>
          )}
          <button
            className="btn btn--primary"
            type="button"
            disabled={!draft.title.trim() || saving}
            onClick={onSave}
          >
            保存
          </button>
        </>
      }
    >
      <div className="te">
        {/* 类型 */}
        <div className="seg seg--block">
          <button
            className={`seg__item${draft.kind === 'deadline' ? ' is-on' : ''}`}
            type="button"
            onClick={() => setKind('deadline')}
          >
            <Icon name="clock" size={15} />
            截止时间
          </button>
          <button
            className={`seg__item${draft.kind === 'fixed' ? ' is-on' : ''}`}
            type="button"
            onClick={() => setKind('fixed')}
          >
            <Icon name="repeat" size={15} />
            固定时段
          </button>
        </div>

        {/* 标题 */}
        <div className="field">
          <label htmlFor="te-title">标题</label>
          <input
            id="te-title"
            value={draft.title}
            type="text"
            maxLength={200}
            placeholder="要做什么？"
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </div>

        {/* ── 截止时间 ── */}
        {draft.kind === 'deadline' ? (
          <div className="field">
            <label>截止于</label>
            <div className="due">
              <div className="due__date">
                <DateField value={dueDate} onChange={setDueDate} ariaLabel="截止日期" />
              </div>
              {!draft.allDay && (
                <div className="due__time">
                  <TimeField
                    value={dueTime}
                    onChange={setDueTime}
                    ariaLabel="截止时间"
                    presets={DUE_TIME_PRESETS}
                  />
                </div>
              )}
              <div className="seg seg--sm due__mode">
                <button
                  className={`seg__item${!draft.allDay ? ' is-on' : ''}`}
                  type="button"
                  aria-pressed={!draft.allDay}
                  onClick={() => setAllDay(false)}
                >
                  指定时间
                </button>
                <button
                  className={`seg__item${draft.allDay ? ' is-on' : ''}`}
                  type="button"
                  aria-pressed={draft.allDay}
                  onClick={() => setAllDay(true)}
                >
                  全天
                </button>
              </div>
            </div>
            <div className="presets">
              {duePresets.map((p) => (
                <button
                  key={p.label}
                  className={`chip chip--btn${dueDate === p.date ? ' is-on' : ''}`}
                  type="button"
                  onClick={() => setDueDate(p.date)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {dueHint && (
              <p className="te__hint">
                <Icon name="clock" size={13} />
                {dueHint}
              </p>
            )}
          </div>
        ) : (
          /* ── 固定时段 ── */
          <div className="te__group">
            <h3 className="te__group-title">重复安排</h3>
            {draft.recurrence && (
              <RecurrenceBuilder
                value={draft.recurrence}
                onChange={(rec: Recurrence) => setDraft({ ...draft, recurrence: rec })}
              />
            )}
          </div>
        )}

        {/* 优先级 */}
        <div className="field">
          <label>优先级</label>
          <div className="seg seg--sm">
            {PRIORITIES.map((p) => (
              <button
                key={p.value}
                className={`seg__item${draft.priority === p.value ? ' is-on' : ''}`}
                type="button"
                onClick={() => setDraft({ ...draft, priority: p.value })}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 标签 */}
        <div className="field">
          <label>标签</label>
          <div className="tags">
            {draft.tags.map((t) => (
              <span key={t} className="chip chip--on">
                {t}
                <button
                  className="chip__x"
                  type="button"
                  aria-label={`移除 ${t}`}
                  onClick={() => removeTag(t)}
                >
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              className="tags__input"
              type="text"
              placeholder="添加标签后回车"
              maxLength={20}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTag(tagInput);
                }
              }}
            />
          </div>
          {tagSuggestions.length > 0 && (
            <div className="presets">
              {tagSuggestions.map((t) => (
                <button key={t} className="chip chip--btn" type="button" onClick={() => addTag(t)}>
                  + {t}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 备注 */}
        <div className="field">
          <label htmlFor="te-notes">备注</label>
          <textarea
            id="te-notes"
            value={draft.notes}
            maxLength={5000}
            placeholder="补充说明（可选）"
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </div>
      </div>
    </Sheet>
  );
}

/** 供测试使用：把草稿的展示名对齐到类型（仅类型引用，避免循环依赖）。 */
export type TaskDraft = Task;

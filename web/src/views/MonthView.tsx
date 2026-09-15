/**
 * 月历：6×7 固定网格 + 选中日详情。
 *
 * 网格固定 6 行是刻意的 —— 不同月份占用的行数不同，若让它自适应，
 * 每次翻月整个页面高度都会跳一次。多出的那一行留白比跳动更可接受。
 *
 * 单元格里最多显示 3 条，其余折叠成"+N"。把 12 条塞进一格只会得到
 * 一片读不出内容的黑点，不如让用户点开看详情。
 */
import { useMemo, useState } from 'react';
import { occurrencesForDate, toggleCompletion } from '@/stores/tasks';
import { useEditorStore } from '@/stores/editor';
import { useUiStore } from '@/stores/ui';
import { useNow } from '@/hooks/useNow';
import { useRepoRev } from '@/hooks/useSyncTick';
import {
  addMonthsKey,
  formatDateLabel,
  formatMonthLabel,
  monthMatrix,
  parseDateKey,
  todayKey,
  WEEKDAY_SHORT,
  isoWeekday,
} from '@/lib/datetime';
import { formatDuration } from '@shared/recurrence.js';
import type { OccurrenceWithTask } from '@/lib/types';
import PageHead from '@/components/PageHead';
import EmptyState from '@/components/EmptyState';
import OccurrenceItem from '@/components/OccurrenceItem';
import Icon from '@/components/Icon';
import './MonthView.css';

const MAX_CHIPS = 3;

interface Cell {
  key: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  weekend: boolean;
  items: OccurrenceWithTask[];
  chips: OccurrenceWithTask[];
  hidden: number;
}

export default function MonthView() {
  useRepoRev();

  const { today } = useNow();
  const weekStart = useUiStore((s) => s.weekStart);

  const [anchor, setAnchor] = useState(todayKey());
  const [selected, setSelected] = useState(todayKey());

  const matrix = monthMatrix(anchor, weekStart);

  const anchorMonth = parseDateKey(anchor)?.m ?? 0;
  const anchorYear = parseDateKey(anchor)?.y ?? 0;

  const headerLabels = (matrix[0] ?? []).map((key) => {
    const p = parseDateKey(key);
    return p ? WEEKDAY_SHORT[isoWeekday(new Date(p.y, p.m - 1, p.d))] : '';
  });

  const cells: Cell[] = useMemo(() => {
    const out: Cell[] = [];
    for (const row of matrix) {
      for (const key of row) {
        const p = parseDateKey(key);
        if (!p) continue;
        const items = occurrencesForDate(key);
        const iso = isoWeekday(new Date(p.y, p.m - 1, p.d));
        out.push({
          key,
          day: p.d,
          inMonth: p.m === anchorMonth && p.y === anchorYear,
          isToday: key === today,
          isSelected: key === selected,
          weekend: iso >= 6,
          items,
          chips: items.slice(0, MAX_CHIPS),
          hidden: Math.max(0, items.length - MAX_CHIPS),
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matrix, anchorMonth, anchorYear, today, selected]);

  /** 本月内有安排的日子数，用于副标题。 */
  const busyDays = cells.filter((c) => c.inMonth && c.items.length > 0).length;
  const monthTotal = cells.reduce((n, c) => (c.inMonth ? n + c.items.length : n), 0);

  const headSubtitle = (() => {
    const parts = [`${formatMonthLabel(anchor)}`];
    if (monthTotal === 0) parts.push('本月暂无安排');
    else parts.push(`${busyDays} 天有安排 · 共 ${monthTotal} 项`);
    return parts.join(' · ');
  })();

  const isCurrentMonth = (() => {
    const t = parseDateKey(today);
    return !!t && t.m === anchorMonth && t.y === anchorYear;
  })();

  const selectedItems = occurrencesForDate(selected);

  const selectedSubtitle = (() => {
    if (selectedItems.length === 0) return '暂无安排';
    const done = selectedItems.filter((o) => o.occurrence.done).length;
    const busy = selectedItems.reduce(
      (s, o) => s + (o.occurrence.kind === 'fixed' ? o.occurrence.durationMinutes : 0),
      0,
    );
    const parts = [`${selectedItems.length} 项`];
    if (done > 0) parts.push(`已完成 ${done}`);
    if (busy > 0) parts.push(`占用 ${formatDuration(busy)}`);
    return parts.join(' · ');
  })();

  const selectedIsToday = selected === today;

  function goMonth(delta: number): void {
    const next = addMonthsKey(anchor, delta);
    setAnchor(next);
    // 翻月时把选中日也带到该月，否则详情区会一直停在别的月份
    const p = parseDateKey(next)!;
    setSelected(`${p.y}-${String(p.m).padStart(2, '0')}-01`);
  }

  function createOn(key: string): void {
    useEditorStore.getState().openCreate({ dueAt: `${key}T09:00` });
  }

  function edit(item: OccurrenceWithTask): void {
    useEditorStore.getState().openEdit(item.task.id);
  }

  function toggle(item: OccurrenceWithTask): void {
    toggleCompletion(item.task.id, item.occurrence.key);
  }

  return (
    <div className="month">
      <PageHead
        title="月历"
        subtitle={headSubtitle}
        actions={
          <>
            <button
              className="nav-btn"
              type="button"
              title="上一月"
              aria-label="上一月"
              onClick={() => goMonth(-1)}
            >
              <Icon name="chevron-left" size={16} />
            </button>
            <button
              className="btn btn--sm"
              type="button"
              disabled={isCurrentMonth}
              onClick={() => {
                setAnchor(todayKey());
                setSelected(todayKey());
              }}
            >
              本月
            </button>
            <button
              className="nav-btn"
              type="button"
              title="下一月"
              aria-label="下一月"
              onClick={() => goMonth(1)}
            >
              <Icon name="chevron-right" size={16} />
            </button>
          </>
        }
      />

      <div className="layout">
        {/* ── 网格 ── */}
        <div className="grid-wrap">
          <div className="wd">
            {headerLabels.map((label, i) => (
              <span key={i} className={`wd__cell${i >= 5 ? ' is-weekend' : ''}`}>
                {label}
              </span>
            ))}
          </div>

          <div className="grid">
            {cells.map((cell) => (
              <div
                key={cell.key}
                className={[
                  'cell',
                  !cell.inMonth ? 'is-out' : '',
                  cell.isToday ? 'is-today' : '',
                  cell.isSelected ? 'is-selected' : '',
                  cell.weekend ? 'is-weekend' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(cell.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    setSelected(cell.key);
                  }
                }}
                onDoubleClick={() => createOn(cell.key)}
              >
                <div className="cell__head">
                  <span className={`cell__day tnum${cell.isToday ? ' is-today' : ''}`}>
                    {cell.day}
                  </span>
                  <button
                    className="cell__add"
                    type="button"
                    aria-label={`在 ${cell.key} 新建`}
                    title="在这一天新建"
                    onClick={(e) => {
                      e.stopPropagation();
                      createOn(cell.key);
                    }}
                  >
                    <Icon name="plus" size={12} />
                  </button>
                </div>

                <div className="cell__body">
                  {cell.chips.map((item) => (
                    <button
                      key={`${item.task.id}-${item.occurrence.key}`}
                      className={[
                        'chip',
                        item.occurrence.kind === 'deadline' ? 'chip--deadline' : '',
                        item.occurrence.done ? 'is-done' : '',
                        item.occurrence.overdue && !item.occurrence.done ? 'is-overdue' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      type="button"
                      title={item.task.title}
                      onClick={(e) => {
                        e.stopPropagation();
                        edit(item);
                      }}
                    >
                      <span className="chip__mark" aria-hidden="true" />
                      <span className="chip__text">{item.task.title}</span>
                    </button>
                  ))}

                  {cell.hidden > 0 && (
                    <button
                      className="chip chip--more"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(cell.key);
                      }}
                    >
                      还有 {cell.hidden} 项
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── 选中日详情 ── */}
        <aside className="detail card">
          <header className="detail__head">
            <div className="detail__text">
              <h2 className="detail__title">{formatDateLabel(selected, { relative: false })}</h2>
              <p className="detail__sub tnum">{selectedSubtitle}</p>
            </div>
            <button
              className="detail__add"
              type="button"
              aria-label={`在 ${selected} 新建`}
              title="在这一天新建"
              onClick={() => createOn(selected)}
            >
              <Icon name="plus" size={15} />
            </button>
          </header>

          {selectedItems.length > 0 ? (
            <div className="detail__list scroll">
              {selectedItems.map((item) => (
                <OccurrenceItem
                  key={`sd-${item.task.id}-${item.occurrence.key}`}
                  item={item}
                  onToggle={() => toggle(item)}
                  onEdit={() => edit(item)}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              compact
              icon="calendar"
              title={selectedIsToday ? '今天没有安排' : '这一天没有安排'}
              hint="双击格子或点右上角 + 即可添加。"
            />
          )}
        </aside>
      </div>

      <p className="foot faint">单击格子查看当天 → 双击直接新建</p>
    </div>
  );
}

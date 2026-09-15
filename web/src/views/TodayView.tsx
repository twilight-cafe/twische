/**
 * 今日：一份按时间排好的日程清单。
 *
 * 这里刻意不画时间网格。一天里的日程通常只有几条，网格会带来大量空白与
 * 需要眼睛去"对齐刻度"的负担；一条竖排清单反而更快读完。
 * 网格留给周视图 —— 那里需要横向比较。
 *
 * 清单里会插入一条"当前时刻"线，位置由实时分钟数决定，因此拖动滚动时
 * 视线自然落在"接下来要做什么"上。
 */
import { useState } from 'react';
import { occurrencesForDate, overflowInto, overdueDeadlines, toggleCompletion } from '@/stores/tasks';
import { useEditorStore } from '@/stores/editor';
import { notify } from '@/stores/ui';
import { useNow } from '@/hooks/useNow';
import { useRepoRev } from '@/hooks/useSyncTick';
import {
  addDays,
  formatDateLabel,
  todayKey,
  WEEKDAY_FULL,
  isoWeekday,
  parseDateKey,
} from '@/lib/datetime';
import { formatDuration } from '@shared/recurrence.js';
import type { OccurrenceWithTask } from '@/lib/types';
import PageHead from '@/components/PageHead';
import EmptyState from '@/components/EmptyState';
import OccurrenceItem from '@/components/OccurrenceItem';
import Icon from '@/components/Icon';
import './TodayView.css';

function weekdayOf(key: string): string {
  const p = parseDateKey(key);
  if (!p) return '';
  return WEEKDAY_FULL[isoWeekday(new Date(p.y, p.m - 1, p.d))];
}

/** 在日程之间插入当前时刻线的行模型。 */
type Row = { type: 'now'; at: number } | { type: 'item'; item: OccurrenceWithTask };

export default function TodayView() {
  // 仓库任何写入（打卡/编辑/同步）都会推进 rev 并触发重算
  useRepoRev();

  const { minutes } = useNow();

  /** 允许翻看其它日期；默认停在今天。 */
  const [dateKey, setDateKey] = useState(todayKey());
  const isToday = dateKey === todayKey();

  const items = occurrencesForDate(dateKey);
  const tails = overflowInto(dateKey);

  /** 截止任务里的全天项单独提出来，它们不占具体时刻。 */
  const allDay = items.filter((o) => o.occurrence.allDay);
  const timed = items.filter((o) => !o.occurrence.allDay);

  const doneCount = items.filter((o) => o.occurrence.done).length;

  /** 固定时段合计占用的时长，用来回答"今天还剩多少时间"。 */
  const busyMinutes = items.reduce(
    (sum, o) => sum + (o.occurrence.kind === 'fixed' ? o.occurrence.durationMinutes : 0),
    0,
  );

  const headParts: string[] = [];
  if (!isToday) headParts.push(formatDateLabel(dateKey, { relative: false }));
  else headParts.push(weekdayOf(dateKey));
  if (items.length === 0) headParts.push('暂无安排');
  else headParts.push(`${items.length} 项日程`);
  if (doneCount > 0) headParts.push(`已完成 ${doneCount} 项`);
  if (busyMinutes > 0) headParts.push(`占用 ${formatDuration(busyMinutes)}`);
  const headSubtitle = headParts.join(' · ');

  /**
   * 清单条目：在日程之间插入当前时刻线。
   * 线只插在"今天"并且确实落在两条之间时才出现。
   */
  const rows: Row[] = (() => {
    const out: Row[] = [];
    const now = minutes;
    let inserted = false;

    for (const item of timed) {
      if (isToday && !inserted && item.occurrence.startMinutes > now) {
        out.push({ type: 'now', at: now });
        inserted = true;
      }
      out.push({ type: 'item', item });
    }

    // 今天的日程全在将来，或一条都没有：线仍然要出现，否则看不出"现在在哪"
    if (isToday && !inserted) out.push({ type: 'now', at: now });
    return out;
  })();

  const overdueList = isToday ? overdueDeadlines(6) : [];

  function go(delta: number): void {
    setDateKey(addDays(dateKey, delta)!);
  }

  /** 在该日新建：截止时间预填该日 09:00，避免落到"今天"上造成误解。 */
  function createHere(): void {
    useEditorStore.getState().openCreate({ dueAt: `${dateKey}T09:00` });
  }

  function toggle(item: OccurrenceWithTask): void {
    toggleCompletion(item.task.id, item.occurrence.key);
  }

  function edit(item: OccurrenceWithTask): void {
    useEditorStore.getState().openEdit(item.task.id);
  }

  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    <div className="today">
      <PageHead
        title={isToday ? '今日' : formatDateLabel(dateKey, { relative: false })}
        subtitle={headSubtitle}
        actions={
          <>
            <button
              className="nav-btn"
              type="button"
              title="前一天"
              aria-label="前一天"
              onClick={() => go(-1)}
            >
              <Icon name="chevron-left" size={16} />
            </button>
            <button className="btn btn--sm" type="button" disabled={isToday} onClick={() => setDateKey(todayKey())}>
              今天
            </button>
            <button
              className="nav-btn"
              type="button"
              title="后一天"
              aria-label="后一天"
              onClick={() => go(1)}
            >
              <Icon name="chevron-right" size={16} />
            </button>
          </>
        }
      />

      {/* ── 逾期未完成：只在看今天时出现，且永远排在其余内容之前 ── */}
      {overdueList.length > 0 && (
        <section className="alert-block">
          <div className="sec-head">
            <h2 className="sec-title">
              <span className="sec-dot" />
              逾期未完成
            </h2>
            <span className="sec-count tnum">{overdueList.length} 项</span>
          </div>
          <div className="alert-list">
            {overdueList.map((item) => (
              <OccurrenceItem
                key={`od-${item.task.id}-${item.occurrence.key}`}
                item={item}
                showDate
                onToggle={() => toggle(item)}
                onEdit={() => edit(item)}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── 前一日跨夜延续过来的时段 ── */}
      {tails.length > 0 && (
        <section className="continuation">
          <div className="sec-head">
            <h2 className="sec-title">跨夜延续</h2>
          </div>
          <div className="alert-list">
            {tails.map((item) => (
              <OccurrenceItem
                key={`tail-${item.task.id}-${item.occurrence.key}`}
                item={item}
                onToggle={() => toggle(item)}
                onEdit={() => edit(item)}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── 全天 ── */}
      {allDay.length > 0 && (
        <section className="all-day">
          <div className="sec-head">
            <h2 className="sec-title">全天</h2>
          </div>
          <div className="alert-list">
            {allDay.map((item) => (
              <OccurrenceItem
                key={`allday-${item.task.id}-${item.occurrence.key}`}
                item={item}
                onToggle={() => toggle(item)}
                onEdit={() => edit(item)}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── 主清单 ── */}
      <section className="timeline">
        {items.length > 0 && (
          <div className="sec-head">
            <h2 className="sec-title">时间线</h2>
            <button
              className="link-btn"
              type="button"
              onClick={() => notify.info('提示', '点击左侧圆圈打卡；点标题可编辑。')}
            >
              <Icon name="sparkle" size={13} />
              小提示
            </button>
          </div>
        )}

        {/* 判空必须以"这一天的日程条数"为准，而不是 rows 的长度：
            今天这一列永远会插入一条当前时刻线，用 rows.length 判空的话
            空态永远不会出现，用户只会看到一条孤零零的时间线。 */}
        {items.length > 0 ? (
          rows.map((row, i) =>
            row.type === 'now' ? (
              <div key={`now-${i}`} className="now-line" aria-label="当前时刻">
                <span className="now-line__dot" />
                <span className="now-line__rule" />
                <span className="now-line__label tnum">
                  {pad(Math.floor(row.at / 60))}:{pad(Math.floor(row.at % 60))}
                </span>
              </div>
            ) : (
              <OccurrenceItem
                key={`${row.item.task.id}-${row.item.occurrence.key}`}
                item={row.item}
                onToggle={() => toggle(row.item)}
                onEdit={() => edit(row.item)}
              />
            ),
          )
        ) : (
          <EmptyState
            icon="calendar-check"
            title={isToday ? '今天没有安排' : '这一天没有安排'}
            hint="留白也是日程的一部分。需要做点什么的话，随手记一条就好。"
          >
            <button className="btn btn--primary" type="button" onClick={createHere}>
              <Icon name="plus" size={16} />
              添加一条
            </button>
          </EmptyState>
        )}

        {items.length > 0 && (
          <button className="add-row" type="button" onClick={createHere}>
            <Icon name="plus" size={15} />
            在本日添加日程
          </button>
        )}
      </section>
    </div>
  );
}

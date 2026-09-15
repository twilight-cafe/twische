/**
 * 本周：7 列时间网格。
 *
 * 与今日的清单不同，周视图要回答的是"哪天更挤"。因此必须有横向可比的刻度 ——
 * 所有列共用同一套小时线，块的**高度**直接等于时长，视觉上就能估出密度。
 *
 * 两个容易出错的点单独处理：
 * - 时间重叠：交给 layoutBlocks 分列，否则后画的块会盖住先画的
 * - 跨午夜：块的下沿会越过当天网格，这里裁剪到 24:00 并打一个"次日"标记
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { occurrencesForDate } from '@/stores/tasks';
import { useEditorStore } from '@/stores/editor';
import { uiHourHeight, useUiStore } from '@/stores/ui';
import { useNow } from '@/hooks/useNow';
import { useRepoRev } from '@/hooks/useSyncTick';
import { layoutBlocks } from '@/lib/layout';
import {
  addDays,
  formatMonthLabel,
  parseDateKey,
  todayKey,
  weekDays,
  WEEKDAY_FULL,
  WEEKDAY_SHORT,
  isoWeekday,
} from '@/lib/datetime';
import { formatDuration } from '@shared/recurrence.js';
import type { OccurrenceWithTask } from '@/lib/types';
import PageHead from '@/components/PageHead';
import Icon from '@/components/Icon';
import './WeekView.css';

const DAY_MINUTES = 1440;

interface TimedBlock {
  item: OccurrenceWithTask;
  col: number;
  cols: number;
  top: number;
  height: number;
  /** 结束时刻越过当日 24:00，下沿被裁剪 */
  spills: boolean;
  deadline: boolean;
}

interface DayColumn {
  key: string;
  weekday: string;
  short: string;
  dayNum: number;
  isToday: boolean;
  weekend: boolean;
  allDay: OccurrenceWithTask[];
  blocks: TimedBlock[];
  count: number;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function weekdayLabel(key: string): string {
  const p = parseDateKey(key);
  if (!p) return '';
  return WEEKDAY_FULL[isoWeekday(new Date(p.y, p.m - 1, p.d))];
}

function pad(n: number): string {
  return String(Math.floor(n)).padStart(2, '0');
}

export default function WeekView() {
  useRepoRev();

  const { minutes, today } = useNow();
  const weekStart = useUiStore((s) => s.weekStart);
  const compactHours = useUiStore((s) => s.compactHours);

  const [anchor, setAnchor] = useState(todayKey());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const HOUR_H = uiHourHeight(compactHours);
  const weekKeys = weekDays(anchor, weekStart);
  const isCurrentWeek = weekKeys.includes(today);

  /**
   * 一次性算出 7 列的全部渲染数据。
   * 放在 useMemo 里而不是模板里逐列调用，是为了保证同一天只展开一次。
   */
  const columns: DayColumn[] = useMemo(() => {
    const h = HOUR_H;
    return weekKeys.map((key) => {
      const items = occurrencesForDate(key);
      const allDay = items.filter((o) => o.occurrence.allDay);
      const timed = items.filter((o) => !o.occurrence.allDay);

      const blocks: TimedBlock[] = layoutBlocks(
        timed.map((o) => ({
          start: o.occurrence.startMinutes,
          end: Math.max(o.occurrence.startMinutes + 1, o.occurrence.endMinutes),
          data: o,
        })),
      ).map((p) => {
        const o = p.item.data as OccurrenceWithTask;
        const isDeadline = o.occurrence.kind === 'deadline';
        const rawEnd = o.occurrence.endMinutes;
        const clampedStart = Math.min(o.occurrence.startMinutes, DAY_MINUTES - 1);

        // 截止任务没有时长，给一个最小高度让它能被点到
        const rawHeight = isDeadline ? 0 : Math.min(rawEnd, DAY_MINUTES) - clampedStart;
        const heightPx = isDeadline ? 22 : Math.max(20, (rawHeight / 60) * h);

        return {
          item: o,
          col: p.col,
          cols: p.cols,
          top: (clampedStart / 60) * h,
          height: heightPx,
          spills: !isDeadline && rawEnd > DAY_MINUTES,
          deadline: isDeadline,
        };
      });

      const p = parseDateKey(key);
      const iso = p ? isoWeekday(new Date(p.y, p.m - 1, p.d)) : 1;

      return {
        key,
        weekday: weekdayLabel(key),
        short: WEEKDAY_SHORT[iso],
        dayNum: p ? p.d : 0,
        isToday: key === today,
        weekend: iso >= 6,
        allDay,
        blocks,
        count: items.length,
      };
    });
    // today / HOUR_H 变化时整表重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekKeys.join(','), today, HOUR_H]);

  const weekTotal = columns.reduce((n, c) => n + c.count, 0);

  const busyMinutes = columns.reduce(
    (sum, c) =>
      sum +
      c.blocks.reduce(
        (s, b) => s + (b.deadline ? 0 : b.item.occurrence.durationMinutes % DAY_MINUTES),
        0,
      ),
    0,
  );

  const rangeLabel = (() => {
    const first = parseDateKey(weekKeys[0]);
    const last = parseDateKey(weekKeys[6]);
    if (!first || !last) return '';
    const head = `${first.m} 月 ${first.d} 日`;
    const tail = first.m === last.m ? `${last.d} 日` : `${last.m} 月 ${last.d} 日`;
    return `${head} – ${tail}`;
  })();

  const headSubtitle = (() => {
    const parts = [formatMonthLabel(anchor)];
    parts.push(weekTotal === 0 ? '本周暂无安排' : `共 ${weekTotal} 项日程`);
    if (busyMinutes > 0) parts.push(`占用 ${formatDuration(busyMinutes)}`);
    return parts.join(' · ');
  })();

  /** 当前时刻线在网格中的纵坐标。 */
  const nowTop = (minutes / 60) * HOUR_H;
  const gridHeight = `${24 * HOUR_H}px`;

  function goWeek(delta: number): void {
    setAnchor(addDays(anchor, delta * 7)!);
  }

  /** 空白处点击 → 按落点换算成整点，直接开始填写。 */
  function onColumnClick(e: React.MouseEvent, key: string): void {
    const el = e.currentTarget as HTMLElement;
    const y = e.clientY - el.getBoundingClientRect().top + el.scrollTop;
    const hour = Math.min(23, Math.max(0, Math.floor(y / HOUR_H)));
    useEditorStore.getState().openCreate({ dueAt: `${key}T${pad(hour)}:00` });
  }

  function openBlock(item: OccurrenceWithTask): void {
    useEditorStore.getState().openEdit(item.task.id);
  }

  function blockStyle(b: TimedBlock): React.CSSProperties {
    const widthPct = 100 / b.cols;
    return {
      top: `${b.top}px`,
      height: `${b.height}px`,
      left: `calc(${b.col * widthPct}% + 2px)`,
      width: `calc(${widthPct}% - 4px)`,
    };
  }

  function blockTime(b: TimedBlock): string {
    const o = b.item.occurrence;
    if (b.deadline) return o.allDay ? '全天' : `${pad(o.startMinutes / 60)}:${pad(o.startMinutes % 60)}`;
    return `${pad(o.startMinutes / 60)}:${pad(o.startMinutes % 60)}–${pad((o.endMinutes % DAY_MINUTES) / 60)}:${pad((o.endMinutes % DAY_MINUTES) % 60)}`;
  }

  /** 手机上先把视口滚到"今天"那一列，否则默认停在周一。 */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || window.innerWidth >= 768) return;
    const idx = columns.findIndex((c) => c.isToday);
    if (idx > 0) el.scrollLeft = (idx / 7) * el.scrollWidth;
    // 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="week">
      <PageHead
        title="本周"
        subtitle={headSubtitle}
        meta={<p className="range tnum">{rangeLabel}</p>}
        actions={
          <>
            <button
              className="nav-btn"
              type="button"
              title="上一周"
              aria-label="上一周"
              onClick={() => goWeek(-1)}
            >
              <Icon name="chevron-left" size={16} />
            </button>
            <button
              className="btn btn--sm"
              type="button"
              disabled={isCurrentWeek}
              onClick={() => setAnchor(todayKey())}
            >
              本周
            </button>
            <button
              className="nav-btn"
              type="button"
              title="下一周"
              aria-label="下一周"
              onClick={() => goWeek(1)}
            >
              <Icon name="chevron-right" size={16} />
            </button>
          </>
        }
      />

      <div className="legend">
        <span className="legend__item">
          <span className="legend__bar" />
          固定时段
        </span>
        <span className="legend__item">
          <span className="legend__dot" />
          截止时间
        </span>
        <span className="legend__item">
          <span className="legend__now" />
          当前时刻
        </span>
        <span className="legend__hint">点击空白处可按小时新建</span>
      </div>

      <div ref={scrollRef} className="week__scroll scroll">
        <div className="grid" style={{ '--hour-h': `${HOUR_H}px` } as React.CSSProperties}>
          {/* ── 日期表头 ── */}
          <div className="head">
            <div className="head__corner">
              <span className="head__tz faint">24h</span>
            </div>
            {columns.map((col) => (
              <div
                key={`h-${col.key}`}
                className={`head__day${col.isToday ? ' is-today' : ''}${col.weekend ? ' is-weekend' : ''}`}
              >
                <span className="head__wd">{col.weekday}</span>
                <span className={`head__num tnum${col.isToday ? ' is-today' : ''}`}>{col.dayNum}</span>
                {col.count > 0 && <span className="head__badge tnum">{col.count}</span>}
              </div>
            ))}
          </div>

          {/* ── 全天行 ── */}
          {columns.some((c) => c.allDay.length > 0) && (
            <div className="allday">
              <div className="allday__label">全天</div>
              {columns.map((col) => (
                <div
                  key={`ad-${col.key}`}
                  className={`allday__cell${col.weekend ? ' is-weekend' : ''}`}
                >
                  {col.allDay.map((item) => (
                    <button
                      key={item.task.id}
                      className={`allday__chip${item.occurrence.done ? ' is-done' : ''}${
                        item.occurrence.overdue ? ' is-overdue' : ''
                      }`}
                      type="button"
                      title={item.task.title}
                      onClick={() => openBlock(item)}
                    >
                      {item.task.title}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* ── 时间网格 ── */}
          <div className="body" style={{ height: gridHeight }}>
            <div className="gutter">
              {HOURS.map((h) => (
                <div key={`g-${h}`} className="gutter__tick" style={{ height: `${HOUR_H}px` }}>
                  <span className="gutter__label tnum">
                    {pad(h)}:00
                  </span>
                </div>
              ))}
            </div>

            {columns.map((col) => (
              <div
                key={`c-${col.key}`}
                className={`col${col.isToday ? ' is-today' : ''}${col.weekend ? ' is-weekend' : ''}`}
                onClick={(e) => onColumnClick(e, col.key)}
              >
                {/* 当前时刻线 */}
                {col.isToday && (
                  <div className="nowline" style={{ top: `${nowTop}px` }} aria-hidden="true">
                    <span className="nowline__dot" />
                  </div>
                )}

                {col.blocks.map((b) => (
                  <button
                    key={`${b.item.task.id}-${b.item.occurrence.key}`}
                    className={[
                      'block',
                      b.deadline ? 'block--deadline' : '',
                      b.item.occurrence.done ? 'is-done' : '',
                      b.item.occurrence.overdue && !b.item.occurrence.done ? 'is-overdue' : '',
                      b.spills ? 'is-spill' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    type="button"
                    style={blockStyle(b)}
                    title={`${blockTime(b)} ${b.item.task.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      openBlock(b.item);
                    }}
                  >
                    <span className="block__title">{b.item.task.title}</span>
                    {b.height >= 34 && <span className="block__time tnum">{blockTime(b)}</span>}
                    {b.spills && (
                      <span className="block__spill">
                        <Icon name="chevron-right" size={10} />
                        次日
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      <p className="foot-hint faint">拖动可横向查看 7 天 · 时段高度与时长成正比</p>
    </div>
  );
}

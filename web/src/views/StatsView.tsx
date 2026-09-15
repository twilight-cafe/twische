/**
 * 统计：把"我到底有多忙"变成可比较的量。
 *
 * 全部用纯 CSS 画柱状图，不引图表库 —— 需要的只有"高度与数值成正比"这一件事，
 * 引一个几十 KB 的库只为画几根柱子不划算，而且它会带来自己的配色和字体，
 * 与这套墨白体系冲突。
 */
import { useMemo } from 'react';
import {
  completionStreak,
  expandRange,
  listTasks,
  overdueDeadlines,
} from '@/stores/tasks';
import { useSessionStore } from '@/stores/session';
import { useEditorStore } from '@/stores/editor';
import { useNow } from '@/hooks/useNow';
import { useRepoRev } from '@/hooks/useSyncTick';
import {
  addDays,
  formatRelative,
  isoWeekday,
  parseDateKey,
  startOfWeek,
  WEEKDAY_FULL,
} from '@/lib/datetime';
import { formatDuration } from '@shared/recurrence.js';
import { state as repo } from '@/lib/localrepo';
import type { OccurrenceWithTask } from '@/lib/types';
import PageHead from '@/components/PageHead';
import EmptyState from '@/components/EmptyState';
import Icon from '@/components/Icon';
import './StatsView.css';

function weekdayOf(key: string): number {
  const p = parseDateKey(key);
  if (!p) return 1;
  return isoWeekday(new Date(p.y, p.m - 1, p.d));
}

export default function StatsView() {
  useRepoRev();

  const { today } = useNow();
  const sessionStats = useSessionStore((s) => s.stats);

  const live = listTasks().filter((t) => t.status !== 'archived');

  const fixedCount = live.filter((t) => t.kind === 'fixed').length;
  const deadlineCount = live.filter((t) => t.kind === 'deadline').length;

  const overdueCount = overdueDeadlines(999).length;

  /** 未来 7 天（含今天）的负载。 */
  const forecast = useMemo(() => {
    const from = today;
    const to = addDays(from, 6)!;
    const items = expandRange(from, to);
    const byDay = new Map<string, OccurrenceWithTask[]>();
    for (let i = 0; i < 7; i++) byDay.set(addDays(from, i)!, []);
    for (const o of items) {
      const bucket = byDay.get(o.occurrence.dateKey);
      if (bucket) bucket.push(o);
    }

    const days = [...byDay.entries()].map(([key, list]) => ({
      key,
      label: key === from ? '今天' : WEEKDAY_FULL[weekdayOf(key)].replace('周', ''),
      full: WEEKDAY_FULL[weekdayOf(key)],
      count: list.length,
      minutes: list.reduce(
        (s, o) => s + (o.occurrence.kind === 'fixed' ? o.occurrence.durationMinutes : 0),
        0,
      ),
      isToday: key === from,
    }));

    const max = Math.max(1, ...days.map((d) => d.count));
    return { days, max, total: items.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  const forecastTotalMinutes = forecast.days.reduce((s, d) => s + d.minutes, 0);

  /** 未来 28 天按星期几聚合 —— 回答"我通常哪天最忙"。 */
  const weekdayLoad = useMemo(() => {
    const from = today;
    const to = addDays(from, 27)!;
    const items = expandRange(from, to);
    const buckets = new Map<number, number>();
    for (let i = 1; i <= 7; i++) buckets.set(i, 0);
    for (const o of items) {
      const iso = weekdayOf(o.occurrence.dateKey);
      buckets.set(iso, (buckets.get(iso) ?? 0) + 1);
    }
    const max = Math.max(1, ...[...buckets.values()]);
    return Array.from({ length: 7 }, (_, i) => {
      const iso = i + 1;
      const count = buckets.get(iso) ?? 0;
      return { iso, label: WEEKDAY_FULL[iso], count, pct: (count / max) * 100 };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  /** 本周完成率。 */
  const thisWeek = useMemo(() => {
    const from = startOfWeek(today, 1);
    const to = addDays(from, 6)!;
    const items = expandRange(from, to);
    const done = items.filter((o) => o.occurrence.done).length;
    return {
      from,
      to,
      total: items.length,
      done,
      pct: items.length === 0 ? 0 : Math.round((done / items.length) * 100),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  const kindSplit = [
    { label: '固定时段', count: fixedCount, pct: (fixedCount / Math.max(1, fixedCount + deadlineCount)) * 100 },
    { label: '截止时间', count: deadlineCount, pct: (deadlineCount / Math.max(1, fixedCount + deadlineCount)) * 100 },
  ];

  const tagLoad = (() => {
    const m = new Map<string, number>();
    for (const t of live) for (const tag of t.tags) m.set(tag, (m.get(tag) ?? 0) + 1);
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'));
    const max = Math.max(1, ...rows.map((r) => r[1]));
    return rows.slice(0, 8).map(([tag, count]) => ({ tag, count, pct: (count / max) * 100 }));
  })();

  const busiestDay = (() => {
    const best = [...weekdayLoad].sort((a, b) => b.count - a.count)[0];
    return best && best.count > 0 ? best.label : null;
  })();

  const headSubtitle = (() => {
    if (live.length === 0) return '暂无数据';
    const parts = [`进行中 ${live.length} 个任务`];
    if (busiestDay) parts.push(`最忙的是${busiestDay}`);
    return parts.join(' · ');
  })();

  const streak = completionStreak();

  return (
    <div className="stats">
      <PageHead title="统计" subtitle={headSubtitle} />

      {live.length === 0 ? (
        <EmptyState
          icon="chart"
          title="还没有可统计的数据"
          hint="建立几个任务并开始打卡后，这里会显示你的时间分布。"
        >
          <button
            className="btn btn--primary"
            type="button"
            onClick={() => useEditorStore.getState().openCreate()}
          >
            <Icon name="plus" size={16} />
            新建任务
          </button>
        </EmptyState>
      ) : (
        <>
          {/* ── 概览 ── */}
          <div className="cards">
            <div className="card stat">
              <span className="stat__label">进行中任务</span>
              <span className="stat__value tnum">{live.length}</span>
              <span className="stat__foot">
                固定 {fixedCount} · 截止 {deadlineCount}
              </span>
            </div>

            <div className="card stat">
              <span className="stat__label">未来 7 天日程</span>
              <span className="stat__value tnum">{forecast.total}</span>
              <span className="stat__foot">
                占用 {formatDuration(forecastTotalMinutes) || '0 分钟'}
              </span>
            </div>

            <div className={`card stat${overdueCount > 0 ? ' is-alert' : ''}`}>
              <span className="stat__label">逾期未完成</span>
              <span className="stat__value tnum">{overdueCount}</span>
              <span className="stat__foot">{overdueCount > 0 ? '需要尽快处理' : '没有拖欠'}</span>
            </div>

            <div className="card stat">
              <span className="stat__label">连续打卡</span>
              <span className="stat__value tnum">
                {streak}
                <small>天</small>
              </span>
              <span className="stat__foot">按有打卡记录的日期计算</span>
            </div>
          </div>

          <div className="panels">
            {/* ── 未来 7 天 ── */}
            <section className="panel card">
              <header className="panel__head">
                <h2 className="panel__title">未来 7 天</h2>
                <span className="panel__hint faint">柱高 = 日程条数</span>
              </header>

              <div className="bars bars--7">
                {forecast.days.map((d) => (
                  <div
                    key={d.key}
                    className={`bars__col${d.isToday ? ' is-today' : ''}`}
                    title={`${d.key} · ${d.count} 项 · ${formatDuration(d.minutes) || '0 分钟'}`}
                  >
                    <span className="bars__value tnum">{d.count || ''}</span>
                    <div className="bars__track">
                      <div
                        className="bars__fill"
                        style={{ height: `${(d.count / forecast.max) * 100}%` }}
                      />
                    </div>
                    <span className="bars__label">{d.label}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* ── 每周节奏 ── */}
            <section className="panel card">
              <header className="panel__head">
                <h2 className="panel__title">每周节奏</h2>
                <span className="panel__hint faint">未来 4 周按星期聚合</span>
              </header>

              <div className="bars bars--7">
                {weekdayLoad.map((d) => (
                  <div key={d.iso} className="bars__col" title={`${d.label} · ${d.count} 项`}>
                    <span className="bars__value tnum">{d.count || ''}</span>
                    <div className="bars__track">
                      <div className="bars__fill" style={{ height: `${d.pct}%` }} />
                    </div>
                    <span className="bars__label">{d.label.replace('周', '')}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* ── 类型分布 ── */}
            <section className="panel card">
              <header className="panel__head">
                <h2 className="panel__title">任务类型</h2>
                <span className="panel__hint faint">共 {live.length} 个</span>
              </header>

              <div className="lines">
                {kindSplit.map((row) => (
                  <div key={row.label} className="lines__row">
                    <span className="lines__label">{row.label}</span>
                    <div className="lines__track">
                      <div className="lines__fill" style={{ width: `${row.pct}%` }} />
                    </div>
                    <span className="lines__value tnum">{row.count}</span>
                  </div>
                ))}
              </div>

              <div className="week-done">
                <div className="week-done__head">
                  <span className="week-done__label">本周完成率</span>
                  <span className="week-done__num tnum">
                    {thisWeek.done} / {thisWeek.total}
                  </span>
                </div>
                <div className="lines__track lines__track--lg">
                  <div className="lines__fill" style={{ width: `${thisWeek.pct}%` }} />
                </div>
                <span className="week-done__hint faint tnum">{thisWeek.pct}%</span>
              </div>
            </section>

            {/* ── 标签分布 ── */}
            <section className="panel card">
              <header className="panel__head">
                <h2 className="panel__title">标签分布</h2>
                <span className="panel__hint faint">最多的 8 个</span>
              </header>

              {tagLoad.length > 0 ? (
                <div className="lines">
                  {tagLoad.map((row) => (
                    <div key={row.tag} className="lines__row">
                      <span className="lines__label">{row.tag}</span>
                      <div className="lines__track">
                        <div className="lines__fill" style={{ width: `${row.pct}%` }} />
                      </div>
                      <span className="lines__value tnum">{row.count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="panel__empty faint">还没有使用标签</p>
              )}
            </section>
          </div>

          {/* ── 数据概况 ── */}
          {sessionStats && (
            <section className="data-note">
              <span className="data-note__title">同步数据</span>
              <span className="data-note__item tnum">
                <span className="faint">记录</span> {sessionStats.records}
              </span>
              <span className="data-note__item tnum">
                <span className="faint">设备</span> {sessionStats.devices}
              </span>
              <span className="data-note__item tnum">
                <span className="faint">冲突</span> {sessionStats.conflicts}
              </span>
              <span className="data-note__item tnum">
                <span className="faint">最后同步</span> {formatRelative(repo.lastSyncAt)}
              </span>
            </section>
          )}
        </>
      )}
    </div>
  );
}

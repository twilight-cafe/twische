/**
 * 今日：以今日为锚点、双向无限加载的日程流。
 *
 * 与旧版“单日 + 前一天/后一天”不同，这里把所有日期放进同一条滚动流：
 * - 每一条 occurrence 仍然出现在它的归属日（跨夜任务按结束日）；
 * - 今日顶部额外汇总所有未完成、已过期的 occurrence；
 * - “已逾期”只在这一处出现，历史日期里不再重复标记；
 * - 上下两端各有一个哨兵，滚动到边界时按 21 天为一块继续扫描，空日期会被跳过。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Empty, Pagination, Spin } from 'ink-design';
import {
  dayGroupsBetween,
  earliestTaskDateKey,
  extendTimelineFuture,
  extendTimelinePast,
  hasFutureTaskCandidates,
  overdueOccurrences,
  toggleCompletion,
  type DayGroup,
} from '@/stores/tasks';
import { useEditorStore } from '@/stores/editor';
import { useNow } from '@/hooks/useNow';
import { useRepoRev } from '@/hooks/useSyncTick';
import { addDays, formatDateLabel } from '@/lib/datetime';
import type { OccurrenceWithTask } from '@/lib/types';
import PageHead from '@/components/PageHead';
import OccurrenceItem from '@/components/OccurrenceItem';
import Icon from '@/components/Icon';
import './TodayView.css';

const OVERDUE_PAGE_SIZE = 3;

interface InitialWindow {
  fromKey: string;
  toKey: string;
  hasPast: boolean;
  hasFuture: boolean;
}

/**
 * 首屏只锚定今天：历史和未来都交给上下哨兵按需加载。
 * 这样初始滚动位置就是今天，而不是被预取的历史推到最上面。
 */
function buildInitialWindow(anchor: string): InitialWindow {
  const earliest = earliestTaskDateKey();
  return {
    fromKey: anchor,
    toKey: anchor,
    hasPast: earliest < anchor,
    hasFuture: hasFutureTaskCandidates(),
  };
}

function dayTitle(key: string, today: string): string {
  const absolute = formatDateLabel(key, { relative: false });
  const relative =
    key === today
      ? '今天'
      : key === addDays(today, 1)
        ? '明天'
        : key === addDays(today, -1)
          ? '昨天'
          : '';
  return relative ? `${relative} · ${absolute}` : absolute;
}

export default function TodayView() {
  const rev = useRepoRev();
  const { today, minutes } = useNow();
  const [state, setState] = useState<InitialWindow>(() => buildInitialWindow(today));
  const [overduePage, setOverduePage] = useState(1);
  const [loadingPast, setLoadingPast] = useState(false);
  const [loadingFuture, setLoadingFuture] = useState(false);

  const topRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const todayRef = useRef<HTMLElement | null>(null);
  const loadingPastRef = useRef(false);
  const loadingFutureRef = useRef(false);
  const initialTodayRef = useRef(today);
  const initialPositionedRef = useRef(false);
  const scrollAnchorRef = useRef<{ node: HTMLElement; top: number } | null>(null);

  const { fromKey, toKey, hasPast, hasFuture } = state;
  const earliest = earliestTaskDateKey();

  const overdue = useMemo(() => overdueOccurrences(), [rev, today, minutes]);
  const groups = useMemo(() => {
    const list = dayGroupsBetween(fromKey, toKey);
    // 今日即使没有原定日程，也要承载“已逾期”的重复项；特殊日期不能按空日期跳过。
    if (overdue.length > 0 && !list.some((group) => group.dateKey === today)) {
      list.push({ dateKey: today, items: [] });
      list.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    }
    return list;
  }, [fromKey, toKey, rev, overdue.length, today]);

  const overduePageCount = Math.max(1, Math.ceil(overdue.length / OVERDUE_PAGE_SIZE));
  const safeOverduePage = Math.min(overduePage, overduePageCount);
  const overdueItems = overdue.slice(
    (safeOverduePage - 1) * OVERDUE_PAGE_SIZE,
    safeOverduePage * OVERDUE_PAGE_SIZE,
  );

  const loadedItemCount = groups.reduce((sum, group) => sum + group.items.length, 0);
  const headParts = [
    overdue.length > 0 ? `逾期 ${overdue.length} 项` : '暂无逾期',
    `已加载 ${groups.length} 天`,
    `${loadedItemCount} 项日程`,
  ];
  const headSubtitle = headParts.join(' · ');

  /** 午夜后“今天”换了位置：重建加载窗口，然后由原生日志/滚动条回到新今日。 */
  useEffect(() => {
    if (initialTodayRef.current === today) return;
    initialTodayRef.current = today;
    setState(buildInitialWindow(today));
    setOverduePage(1);
  }, [today]);

  /** 仓库变化后，可能出现比当前窗口更早的任务；让上边界重新可加载。 */
  useEffect(() => {
    setState((prev) => {
      const nextPast = prev.hasPast || earliest < prev.fromKey;
      const nextFuture = prev.hasFuture || hasFutureTaskCandidates();
      if (nextPast === prev.hasPast && nextFuture === prev.hasFuture) return prev;
      return { ...prev, hasPast: nextPast, hasFuture: nextFuture };
    });
  }, [rev, earliest]);

  /** 向过去扩展一页；返回 false 表示已经到最早。 */
  function loadPast(): void {
    if (!hasPast || loadingPastRef.current) return;
    loadingPastRef.current = true;
    setLoadingPast(true);

    // 插入历史内容前记住一个真实节点的视口位置；渲染后按它自身的位移补偿。
    // 不能只看 scrollHeight：同一批渲染里 future 也会追加内容，按总高度补偿会滚过头。
    const anchorNode = (todayRef.current ?? topRef.current?.nextElementSibling) as HTMLElement | null;
    if (anchorNode) {
      scrollAnchorRef.current = { node: anchorNode, top: anchorNode.getBoundingClientRect().top };
    }

    const next = extendTimelinePast(fromKey, earliest);
    setState((prev) => ({
      ...prev,
      fromKey: next.key,
      hasPast: next.hasMore,
    }));
    loadingPastRef.current = false;
    setLoadingPast(false);
  }

  /** 向未来扩展一页；返回 false 表示 10 年扫描范围内已没有内容。 */
  function loadFuture(): void {
    if (!hasFuture || loadingFutureRef.current) return;
    loadingFutureRef.current = true;
    setLoadingFuture(true);

    const next = extendTimelineFuture(toKey);
    setState((prev) => ({
      ...prev,
      toKey: next.key,
      hasFuture: next.hasMore,
    }));
    loadingFutureRef.current = false;
    setLoadingFuture(false);
  }

  /** 补偿 prepend 造成的位移，保持锚点节点在视口中的位置不变。 */
  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    scrollAnchorRef.current = null;
    if (!anchor || !anchor.node.isConnected) return;
    const scroller = anchor.node.closest('.shell__main') as HTMLElement | null;
    if (!scroller) return;
    const delta = anchor.node.getBoundingClientRect().top - anchor.top;
    if (delta !== 0) scroller.scrollTop += delta;
  });

  /** 首次拿到今日分组时，把今日顶到滚动容器顶部；上方保留历史/页面头部可回拉。 */
  useLayoutEffect(() => {
    if (initialPositionedRef.current) return;
    const node = todayRef.current;
    if (!node) return;
    node.scrollIntoView({ block: 'start' });
    initialPositionedRef.current = true;
  }, [groups]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === topRef.current) loadPast();
          if (entry.target === bottomRef.current) loadFuture();
        }
      },
      { rootMargin: '160px 0px' },
    );
    if (topRef.current) observer.observe(topRef.current);
    if (bottomRef.current) observer.observe(bottomRef.current);
    return () => observer.disconnect();
    // 每次窗口变化都重建 observer，让闭包里的 fromKey/toKey 保持最新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromKey, toKey, hasPast, hasFuture, earliest]);

  function goToday(): void {
    todayRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function toggle(item: OccurrenceWithTask): void {
    toggleCompletion(item.task.id, item.occurrence.key);
  }

  function edit(item: OccurrenceWithTask): void {
    useEditorStore.getState().openEdit(item.task.id);
  }

  function createToday(): void {
    useEditorStore.getState().openCreate({ dueAt: `${today}T09:00` });
  }

  function renderGroup(group: DayGroup): ReactNode {
    const isToday = group.dateKey === today;
    const done = group.items.filter((item) => item.occurrence.done).length;
    return (
      <section
        key={group.dateKey}
        ref={isToday ? todayRef : undefined}
        className={isToday ? 'day-block is-today' : 'day-block'}
      >
        <div className="sec-head day-head">
          <div className="day-head__main">
            <h2 className="sec-title">{dayTitle(group.dateKey, today)}</h2>
          </div>
          <span className="sec-count tnum">
            {group.items.length} 项{done > 0 ? ` · 已完成 ${done}` : ''}
          </span>
        </div>

        {/* ── 已逾期：只在今日分组内出现；按 3 条/页分页。 ── */}
        {isToday && overdue.length > 0 && (
          <div className="alert-block day-overdue">
            <div className="sec-head">
              <h2 className="sec-title">
                <span className="sec-dot" />
                已逾期
              </h2>
              <span className="sec-count tnum">{overdue.length} 项</span>
            </div>
            <div className="alert-list">
              {overdueItems.map((item) => (
                <OccurrenceItem
                  key={`od-${item.task.id}-${item.occurrence.key}`}
                  item={item}
                  showDate
                  forceOverdue
                  onToggle={() => toggle(item)}
                  onEdit={() => edit(item)}
                />
              ))}
            </div>
            {overdue.length > OVERDUE_PAGE_SIZE && (
              <Pagination
                className="today-pager"
                size="small"
                align="end"
                current={safeOverduePage}
                pageSize={OVERDUE_PAGE_SIZE}
                total={overdue.length}
                showTotal={(total) => `共 ${total} 项`}
                onChange={(page) => setOverduePage(page)}
              />
            )}
          </div>
        )}

        {group.items.length > 0 && (
          <div className="alert-list">
            {group.items.map((item) => (
              <OccurrenceItem
                key={`${item.task.id}-${item.occurrence.key}`}
                item={item}
                showOverdue={false}
                onToggle={() => toggle(item)}
                onEdit={() => edit(item)}
              />
            ))}
          </div>
        )}

        {isToday && group.items.length === 0 && (
          <p className="day-empty">今天没有原定日程，先处理上面的逾期项。</p>
        )}
      </section>
    );
  }

  const canUseObserver = typeof IntersectionObserver !== 'undefined';

  return (
    <div className="today">
      <PageHead
        title="今日"
        subtitle={headSubtitle}
        actions={
          <Button small icon={<Icon name="calendar-check" size={15} />} onClick={goToday}>
            回到今天
          </Button>
        }
      />

      {/* ── 双向时间线 ── */}
      <section className="timeline feed">
        <div ref={topRef} className="feed-sentinel" aria-hidden="true">
          {loadingPast && <Spin size="small" />}
        </div>

        {groups.length > 0 && !hasPast && (
          <p className="feed-boundary feed-boundary--top">
            <Icon name="check" size={13} />
            已经到最早了
          </p>
        )}

        {groups.length > 0 ? (
          groups.map(renderGroup)
        ) : hasPast || hasFuture ? (
          <div className="feed-loading" role="status" aria-live="polite">
            <Spin size="small" />
          </div>
        ) : (
          <Empty
            className="today-empty"
            image={
              <span className="today-empty__icon">
                <Icon name="calendar-check" size={26} />
              </span>
            }
            description={
              <>
                <p className="today-empty__title">还没有任何日程</p>
                <p className="today-empty__hint">留白也是日程的一部分。需要做点什么的话，随手记一条就好。</p>
              </>
            }
            footer={
              <Button primary icon={<Icon name="plus" size={16} />} onClick={createToday}>
                添加一条
              </Button>
            }
          />
        )}

        <div ref={bottomRef} className="feed-sentinel" aria-hidden="true">
          {loadingFuture && <Spin size="small" />}
        </div>

        {!canUseObserver && hasPast && (
          <div className="feed-fallback">
            <Button small onClick={loadPast}>
              加载更早
            </Button>
          </div>
        )}
        {!canUseObserver && hasFuture && (
          <div className="feed-fallback">
            <Button small onClick={loadFuture}>
              加载更多
            </Button>
          </div>
        )}

        {groups.length > 0 && !hasFuture && (
          <p className="feed-boundary">
            没有更多日程了
          </p>
        )}
      </section>

      {/* minutes 只用于保持“当前时刻”驱动的重渲染；今日流不画时间线，但逾期判断要跟着钟走。 */}
      <span className="today__clock" aria-hidden="true" data-minutes={Math.floor(minutes)} />
    </div>
  );
}

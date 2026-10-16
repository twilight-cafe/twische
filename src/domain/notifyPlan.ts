/**
 * 通知内容计算。
 *
 * 这一层是纯函数：给一份"当前需要关心的事项"，算出状态栏该显示的一行字。
 * 它不认识网络、不认识 Service Worker、也不碰 DOM ——
 * 因此通知里到底会出现什么，可以在单测里逐字断言，而不必真的弹一条通知。
 *
 * 内容口径（与「今日」页一致）：
 * - 逾期：所有未完成、结束时间已过去的实例
 * - 今日：今天剩下的全部未完成实例，**包括还没到时间的**
 * - 两者都空 → 通知应当被撤销，而不是显示一条"0 项"
 */
import { addDays } from '@/domain/datetime';

/** 通知的固定 tag / 原生通知 id：同一条通知只更新、不堆叠。 */
export const NOTIFY_TAG = 'twische.today';

/** 计算所需的最小数据形状。真实实现由 stores/tasks 提供，测试里给字面量即可。 */
export interface NotifySource {
  /** 未完成且已过期的实例。 */
  overdue: readonly NotifyOccurrence[];
  /** 今天的全部实例（含已完成、含未来）。 */
  today: readonly NotifyOccurrence[];
}

/** 单行标题上限。Android 通知每行只给一行多一点的宽度，超长会把后半句吃掉。 */
export const NOTIFY_TITLE_MAX = 40;

export interface NotifyOccurrence {
  title: string;
  startAt: Date;
  endAt: Date;
  done: boolean;
  /** 全天事项没有可读时刻。领域实例本来就有这个字段，直接带过来即可。 */
  allDay?: boolean;
}

export interface NotifyLine {
  title: string;
  /** 'HH:mm'；截止任务设为「全天」时为 null。 */
  time: string | null;
  /** overdue 逾期 / now 进行中 / later 今天还没到。 */
  kind: 'overdue' | 'now' | 'later';
}

export interface NotifyPlan {
  /** 通知的唯一标识（tag / 原生 id）。 */
  key: string;
  /** 有内容为 true；false 表示应当撤销通知。 */
  active: boolean;
  /** 状态栏折叠时显示的一行。 */
  title: string;
  /** 展开后的正文，每行一项。 */
  body: string;
  /** 未展示的事项数（正文被截断时 > 0）。 */
  more: number;
  /** 事项总数，供角标与原生侧使用。 */
  count: number;
  /** 计算时刻，原生侧用来判断内容是否过时。 */
  stamp: number;
}

/** 内部排序用的临时结构。 */
interface Candidate extends NotifyLine {
  /** 0 逾期 / 1 进行中 / 2 今天还没到 —— 数字小的更该被看见。 */
  urgency: number;
  at: number;
}

/** 通知栏里一行的文字。两端不留空格：空标题不该在正文里留下一道空隙。 */
export function formatLine(line: NotifyLine): string {
  return (line.time ? `${line.time}  ${line.title}` : line.title).trimEnd();
}

/**
 * 由数据源生成通知计划。
 *
 * `now` 显式传入而不是读时钟：调用方（调度器）对它负责，
 * 测试才能构造"下午三点看今天的列表"这种场景。
 */
export function buildNotificationPlan(source: NotifySource, now: number, maxLines: number): NotifyPlan {
  const inProgress = source.today.filter((o) => !o.done && o.startAt.getTime() <= now);

  // 逾期在前，且不重复出现在"今日还没到"里；同一组内按时间排。
  const candidates: Candidate[] = [
    ...source.overdue.map((o) => candidate(o, 0)),
    ...inProgress.map((o) => candidate(o, 1)),
    ...source.today.filter((o) => !o.done && o.startAt.getTime() > now).map((o) => candidate(o, 2)),
  ].sort((a, b) => a.urgency - b.urgency || a.at - b.at || a.title.localeCompare(b.title, 'zh-Hans-CN'));

  const kept = candidates.slice(0, maxLines);
  const more = candidates.length - kept.length;

  // 截断时保留的是最紧急的几项，但**展示顺序仍按时间**：
  // 逾期列表按时间倒着读会让人以为顺序有意义。
  kept.sort((a, b) => a.urgency - b.urgency || a.at - b.at);

  const lines: NotifyLine[] = kept.map((c) => ({ title: c.title, time: c.time, kind: c.kind }));
  const body = [...lines.map(formatLine), ...(more > 0 ? [`…还有 ${more} 项`] : [])].join('\n');
  // 无事可做时连标题都不给：这条计划只会被用来"撤销通知"，
  // 给一个「今日还剩 0 项」反而会被某个调用方顺手显示出去。
  const overdue = source.overdue.length;

  return {
    key: NOTIFY_TAG,
    active: candidates.length > 0,
    title: candidates.length === 0 ? '' : planTitle(overdue, candidates.length - overdue),
    body,
    more,
    count: candidates.length,
    stamp: now,
  };
}

/** 今天剩下多少项是"还没做"的（含还没到时间的）。 */
function planTitle(overdue: number, remaining: number): string {
  if (overdue === 0) return `今日还剩 ${remaining} 项`;
  if (remaining === 0) return `${overdue} 项逾期`;
  return `${overdue} 项逾期 · 今日还剩 ${remaining} 项`;
}

function candidate(o: NotifyOccurrence, urgency: number): Candidate {
  return {
    title: clip(o.title),
    time: timeLabel(o),
    kind: urgency === 0 ? 'overdue' : urgency === 1 ? 'now' : 'later',
    urgency,
    at: o.startAt.getTime(),
  };
}

/** 超长标题截断到 NOTIFY_TITLE_MAX 个字符。 */
function clip(title: string): string {
  const s = (title || '').trim();
  return s.length <= NOTIFY_TITLE_MAX ? s : `${s.slice(0, NOTIFY_TITLE_MAX - 1)}…`;
}

/**
 * 精确到分钟的实例显示 'HH:mm'；全天实例没有可读时刻，显示为 null。
 *
 * 只看 allDay，不做形状猜测。"00:00 且首尾同一时刻"看起来像全天，
 * 但用户完全可能在截止任务上**明确选** 00:00 —— 那是一个真实的可读时刻，
 * 按形状判断会把它悄悄吞掉。领域实例本来就带 allDay，直接用它。
 */
function timeLabel(o: NotifyOccurrence): string | null {
  if (o.allDay) return null;
  const d = o.startAt;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 通知运行时的数据来源。
 *
 * 放这里而不是 domain：它是"从应用状态里取数"的契约，
 * 由 stores/tasks 实现、由 lib/notifyRuntime 消费，domain 只认它算出来的形状。
 */
export type NotifyCollector = () => NotifySource;

/** 供收集器复用的日期区间：往前回看 60 天足够覆盖逾期，往后 1 天覆盖跨夜。 */
export function notifyRange(now: number): { today: string; lookback: string } {
  const d = new Date(now);
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { today, lookback: addDays(today, -60)! };
}

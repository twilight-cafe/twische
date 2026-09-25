/**
 * 一条日程实例的展示单元。
 *
 * 固定时段与截止时间靠 `.oi__time` 的**文字**区分：前者渲染成区间（`09:00–10:00`）
 * 并额外给出时长，后者渲染成单点时刻（`18:30`）或"全天"。这里刻意不再放一个
 * 表示类型的形状标记 —— 它与左侧的打卡圆圈挤在同一列、又没有任何图例承接，
 * 读者无法从形状反推出含义，只会平白多出一个视觉元素。形状语义在有图例的
 * WeekView（`.legend`）和字形更紧凑的任务列表（`.row__mark`）里保留。
 */
import { IconButton, Tag } from 'ink-design';
import type { OccurrenceWithTask } from '@/lib/types';
import { formatDuration } from '@shared/recurrence.js';
import Icon from './Icon';
import './OccurrenceItem.css';

export interface OccurrenceItemProps {
  item: OccurrenceWithTask;
  /** 紧凑模式用于时间网格内的色块 */
  compact?: boolean;
  showDate?: boolean;
  /** 是否显示“已逾期”标记；今日时间线里归属日仍展示，但不重复标记。 */
  showOverdue?: boolean;
  /** 调用方按自己的口径判定为逾期时，强制标记（例如 fixed 的错过实例）。 */
  forceOverdue?: boolean;
  onToggle?: (item: OccurrenceWithTask) => void;
  onEdit?: (item: OccurrenceWithTask) => void;
}

const clock = (n: number): string =>
  String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');

export function OccurrenceItem({
  item,
  compact = false,
  showDate = false,
  showOverdue = true,
  forceOverdue = false,
  onToggle,
  onEdit,
}: OccurrenceItemProps) {
  const occ = item.occurrence;
  const task = item.task;

  const timeLabel =
    occ.kind === 'deadline'
      ? occ.allDay
        ? '全天'
        : clock(occ.startMinutes)
      : `${clock(occ.startMinutes)}–${clock(occ.endMinutes)}`;

  const durationLabel = occ.kind === 'fixed' ? formatDuration(occ.durationMinutes) : '';
  const overdue = showOverdue && (occ.overdue || forceOverdue) && !occ.done;

  const endKey = occ.endsOnNextDay || occ.dateKey;
  const [, m, d] = endKey.split('-');
  const dateLabel = `${Number(m)}/${Number(d)}`;

  const cls = [
    'oi',
    occ.done ? 'is-done' : '',
    overdue ? 'is-overdue' : '',
    compact ? 'oi--compact' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      data-kind={occ.kind}
      role="button"
      tabIndex={0}
      onClick={() => onEdit?.(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onEdit?.(item);
        } else if (e.key === ' ') {
          e.preventDefault();
          onEdit?.(item);
        }
      }}
    >
      <IconButton
        className="oi__check"
        aria-label={occ.done ? '标记为未完成' : '标记为已完成'}
        title={occ.done ? '标记为未完成' : '标记为已完成'}
        onClick={(e) => {
          e.stopPropagation();
          onToggle?.(item);
        }}
      >
        {occ.done && <Icon name="check" size={12} stroke={2.4} />}
      </IconButton>

      <div className="oi__body">
        <div className="oi__line">
          <span className="oi__time tnum">{timeLabel}</span>
          {showDate && <span className="oi__date tnum">{dateLabel}</span>}
          <span className="oi__title">{task.title}</span>
          {task.priority > 0 && (
            <span className="oi__pri" data-p={task.priority} aria-hidden="true" />
          )}
        </div>
        {!compact ? (
          <div className="oi__meta">
            {task.kind === 'fixed' && <span className="oi__dur">{durationLabel}</span>}
            {occ.spansMidnight && (
              <span className="oi__flag">
                <Icon name="chevron-right" size={11} />
                次日 {String(Math.floor(((occ.endMinutes % 1440) / 60))).padStart(2, '0')}:
                {String(occ.endMinutes % 60).padStart(2, '0')}
              </span>
            )}
            {overdue && <span className="oi__overdue">已逾期</span>}
            {task.tags.map((t) => (
              <Tag key={t} className="oi__tag">
                {t}
              </Tag>
            ))}
          </div>
        ) : (
          overdue && <p className="oi__overdue oi__overdue--inline">逾期</p>
        )}
      </div>
    </div>
  );
}

export default OccurrenceItem;

/**
 * 一条日程实例的展示单元。
 *
 * 固定时段与截止时间用**形状**区分而不是颜色：前者是一条实心竖标（表示"占据了
 * 一段连续时间"），后者是一个空心圆点（表示"某一刻的终点"）。整个界面的色彩
 * 克制到只有墨色与一抹暮色，因此形状必须承担主要的区分职责。
 */
import type { OccurrenceWithTask } from '@/lib/types';
import { formatDuration } from '@shared/recurrence.js';
import Icon from './Icon';
import './OccurrenceItem.css';

export interface OccurrenceItemProps {
  item: OccurrenceWithTask;
  /** 紧凑模式用于时间网格内的色块 */
  compact?: boolean;
  showDate?: boolean;
  onToggle?: (item: OccurrenceWithTask) => void;
  onEdit?: (item: OccurrenceWithTask) => void;
}

const clock = (n: number): string =>
  String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');

export function OccurrenceItem({ item, compact = false, showDate = false, onToggle, onEdit }: OccurrenceItemProps) {
  const occ = item.occurrence;
  const task = item.task;

  const timeLabel =
    occ.kind === 'deadline'
      ? occ.allDay
        ? '全天'
        : clock(occ.startMinutes)
      : `${clock(occ.startMinutes)}–${clock(occ.endMinutes)}`;

  const durationLabel = occ.kind === 'fixed' ? formatDuration(occ.durationMinutes) : '';
  const overdue = occ.overdue && !occ.done;

  const [, m, d] = occ.dateKey.split('-');
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
      <button
        className="oi__check"
        type="button"
        aria-label={occ.done ? '标记为未完成' : '标记为已完成'}
        title={occ.done ? '标记为未完成' : '标记为已完成'}
        onClick={(e) => {
          e.stopPropagation();
          onToggle?.(item);
        }}
      >
        {occ.done && <Icon name="check" size={12} stroke={2.4} />}
      </button>

      <span className="oi__rule" aria-hidden="true" />

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
              <span key={t} className="oi__tag">
                {t}
              </span>
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

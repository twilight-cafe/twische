/**
 * 日期选择器。
 *
 * 取代原生 `<input type="date">`：原生控件显示的是浏览器区域格式（`2026/09/13`），
 * 弹出的日历是系统蓝色的，和这里的墨白语言无关；移动端还会盖住半屏且难以点准。
 *
 * 自绘日历沿用与月视图同一套网格（`monthMatrix` 固定 6 行 7 列），
 * 所以切换月份时高度不跳动，视觉上也和"月历"页是同一个东西。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePopover } from '@/hooks/usePopover';
import { useUiStore } from '@/stores/ui';
import {
  WEEKDAY_FULL,
  WEEKDAY_SHORT,
  addDays,
  formatMonthLabel,
  isoWeekday,
  monthMatrix,
  parseDateKey,
  todayKey,
} from '@/lib/datetime';
import Icon from './Icon';
import './DateField.css';

export interface DateFieldPreset {
  label: string;
  date: string;
}

export interface DateFieldProps {
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
  /** 允许清空（截止日期必须有值，重复规则的"结束于"可以没有） */
  clearable?: boolean;
  /** 浮层里的快捷日期，调用方给文案与日期 */
  presets?: DateFieldPreset[];
  dense?: boolean;
}

export function DateField({
  value,
  onChange,
  ariaLabel = '选择日期',
  disabled = false,
  clearable = false,
  presets = [],
  dense = false,
}: DateFieldProps) {
  const weekStart = useUiStore((s) => s.weekStart);
  const { open, triggerRef, panelRef, style, placement, toggle, close } = usePopover({ width: 280 });

  const today = todayKey();

  /** 面板当前翻到的月份，只在打开时对齐到已选值，避免"关掉再开跳回今天"。 */
  const [cursor, setCursor] = useState(value || today);

  useEffect(() => {
    if (open) setCursor(value || todayKey());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const weeks = monthMatrix(cursor, weekStart);

  /** 表头星期按用户设置的"一周从哪天开始"旋转，与月视图保持同一顺序。 */
  const weekdayLabels = Array.from({ length: 7 }, (_, i) => {
    const first = weekStart === 0 ? 7 : weekStart; // ISO 里 7 = 周日
    const iso = ((first - 1 + i) % 7) + 1;
    return { short: WEEKDAY_SHORT[iso], full: WEEKDAY_FULL[iso] };
  });

  const cursorMonth = parseDateKey(cursor)?.m ?? 1;
  const cells = weeks.flat().map((key) => {
    const p = parseDateKey(key);
    return { key, day: p?.d ?? 0, inMonth: p?.m === cursorMonth };
  });

  const p = parseDateKey(value);
  let label = '';
  if (p) {
    const wd = WEEKDAY_FULL[isoWeekday(new Date(p.y, p.m - 1, p.d))];
    const year = p.y === new Date().getFullYear() ? '' : `${p.y} 年 `;
    label = `${year}${p.m} 月 ${p.d} 日 ${wd}`;
  }

  /** 相对今天的位置，用于在触发按钮上补一个"今天/明天"的即时反馈。 */
  let relativeTag = '';
  if (value) {
    if (value === today) relativeTag = '今天';
    else if (value === addDays(today, 1)) relativeTag = '明天';
    else if (value === addDays(today, -1)) relativeTag = '昨天';
  }

  function pick(key: string): void {
    onChange(key);
    close();
  }

  function shiftMonth(delta: number): void {
    const cur = parseDateKey(cursor);
    if (!cur) return;
    const total = cur.y * 12 + (cur.m - 1) + delta;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    setCursor(`${y}-${String(m).padStart(2, '0')}-01`);
  }

  function goToday(): void {
    setCursor(today);
    pick(today);
  }

  function clear(): void {
    onChange('');
    close();
  }

  return (
    <div className={dense ? 'df df--dense' : 'df'}>
      <button
        ref={triggerRef as React.Ref<HTMLButtonElement>}
        className="df__trigger"
        type="button"
        disabled={disabled}
        aria-label={`${ariaLabel}，当前 ${label || '未设置'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        {label ? (
          <span className="df__value">
            {label}
            {relativeTag && <span className="df__tag">{relativeTag}</span>}
          </span>
        ) : (
          <span className="df__placeholder">选择日期</span>
        )}
        <span className="df__caret" aria-hidden="true">
          <Icon name="calendar" size={15} />
        </span>
      </button>

      {open &&
        createPortal(
          <div className="pop-layer" style={style}>
            <div
              ref={panelRef as React.Ref<HTMLDivElement>}
              className="pop-panel df__panel"
              role="dialog"
              aria-label={ariaLabel}
              data-placement={placement}
            >
              <div className="pop-head">
                <button className="df__nav" type="button" aria-label="上个月" onClick={() => shiftMonth(-1)}>
                  <Icon name="chevron-left" size={16} />
                </button>
                <span className="pop-title">{formatMonthLabel(cursor)}</span>
                <button className="df__nav" type="button" aria-label="下个月" onClick={() => shiftMonth(1)}>
                  <Icon name="chevron-right" size={16} />
                </button>
              </div>

              <div className="df__grid df__grid--head" aria-hidden="true">
                {weekdayLabels.map((w) => (
                  <span key={w.full}>{w.short}</span>
                ))}
              </div>

              <div className="df__grid" role="grid">
                {cells.map((c) => (
                  <button
                    key={c.key}
                    className={[
                      'cell df__day',
                      c.key === value ? 'is-on' : '',
                      !c.inMonth ? 'cell--mute' : '',
                      c.key === today && c.key !== value ? 'cell--today' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    type="button"
                    role="gridcell"
                    aria-label={c.key}
                    aria-current={c.key === today ? 'date' : undefined}
                    onClick={() => pick(c.key)}
                  >
                    {c.day}
                  </button>
                ))}
              </div>

              {presets.length > 0 && (
                <div className="df__presets">
                  {presets.map((pr) => (
                    <button
                      key={pr.label}
                      className={`chip chip--btn${pr.date === value ? ' is-on' : ''}`}
                      type="button"
                      onClick={() => pick(pr.date)}
                    >
                      {pr.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="pop-foot">
                <button className="btn btn--sm" type="button" onClick={goToday}>
                  今天
                </button>
                <span className="df__spacer" />
                {clearable && value && (
                  <button className="btn btn--sm" type="button" onClick={clear}>
                    清除
                  </button>
                )}
                <button className="btn btn--sm" type="button" onClick={close}>
                  完成
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export default DateField;

/**
 * 日期选择器：应用侧统一外观 / 值类型（YYYY-MM-DD）的薄封装。
 *
 * 交互、日历网格、清空、键盘可达性全部交给 ink-design 的 DatePicker；
 * 这里只负责把应用里的日期键转成 Date，并保留 RecurrenceBuilder 需要的快捷日期。
 */
import { Chip, DatePicker } from 'ink-design';
import { parseDateKey } from '@/lib/datetime';
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

function toDate(value: string): Date | null {
  const p = parseDateKey(value);
  if (!p) return null;
  return new Date(p.y, p.m - 1, p.d, 0, 0, 0, 0);
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
  return (
    <div className={dense ? 'df df--dense' : 'df'}>
      <DatePicker
        className="df__picker"
        value={toDate(value)}
        format="YYYY-MM-DD"
        placeholder="选择日期"
        disabled={disabled}
        allowClear={clearable}
        aria-label={ariaLabel}
        onChange={(_date, dateString) => onChange(dateString)}
      />
      {presets.length > 0 && (
        <div className="df__presets">
          {presets.map((preset) => (
            <Chip
              key={preset.label}
              className={preset.date === value ? 'is-on' : undefined}
              onClick={() => onChange(preset.date)}
            >
              {preset.label}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

export default DateField;

/**
 * 时间选择器：包装 ink-design 的 TimePicker。
 *
 * 应用侧继续使用 'HH:mm' 字符串；下拉列、键入 & 校验、清空都由 InkUI 负责。
 * 常用时间以 chip 形式保留在触发器下方，减少一次展开操作。
 */
import { Chip, TimePicker } from 'ink-design';
import { timeToMinutes } from '@/lib/datetime';
import './TimeField.css';

export interface TimeFieldProps {
  value: string;
  onChange: (v: string) => void;
  /** 常用时间快捷项，传空数组则不显示这一行 */
  presets?: string[];
  /** 分钟粒度 */
  minuteStep?: number;
  ariaLabel?: string;
  disabled?: boolean;
  /** 紧凑模式：用于并排放两个时间（起—止） */
  dense?: boolean;
}

export function TimeField({
  value,
  onChange,
  presets = ['08:00', '09:00', '12:00', '14:00', '18:00', '22:00'],
  minuteStep = 5,
  ariaLabel = '选择时间',
  disabled = false,
  dense = false,
}: TimeFieldProps) {
  const normalizedValue = timeToMinutes(value) === null ? null : value;

  return (
    <div className={dense ? 'tf tf--dense' : 'tf'}>
      <TimePicker
        className="tf__picker"
        value={normalizedValue}
        placeholder="--:--"
        disabled={disabled}
        minuteStep={Math.max(1, Math.min(30, minuteStep))}
        aria-label={ariaLabel}
        onChange={(next) => onChange(next ?? '')}
      />
      {presets.length > 0 && (
        <div className="tf__presets">
          {presets.map((preset) => (
            <Chip
              key={preset}
              className={preset === value ? 'is-on' : undefined}
              onClick={() => onChange(preset)}
            >
              {preset}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

export default TimeField;

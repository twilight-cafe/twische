/**
 * 时间选择器。
 *
 * 取代原生 `<input type="time">`：原生控件在中文环境下是系统/浏览器自己的一套
 * 外观（12 小时制、蓝色高亮、桌面端要靠点小米粒箭头或逐位键入），和全站
 * "墨白 + 4px 圆角"的语言完全不是一回事，也控制不了它的可点区域。
 *
 * 交互上做了三层，覆盖不同熟练度：
 * 1. 常用时间胶囊 —— 排期里绝大多数时间是整点或半点，一次点击就够；
 * 2. 时 × 分网格 —— 两次点击得到任意 5 分钟粒度，不需要拖拽和滚动；
 * 3. 直接键入 —— 认 `930` / `9:30` / `9点30` 这些写法，回车生效。
 * 关掉浮层不丢值：点外部、Esc 都只是收起，选择即生效。
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { usePopover } from '@/hooks/usePopover';
import { dateToTimeInput, minutesToClock, normalizeTime, timeToMinutes } from '@/lib/datetime';
import './TimeField.css';

const HOURS = Array.from({ length: 24 }, (_, i) => i);

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

const pad = (n: number): string => String(n).padStart(2, '0');

export function TimeField({
  value,
  onChange,
  presets = ['08:00', '09:00', '12:00', '14:00', '18:00', '22:00'],
  minuteStep = 5,
  ariaLabel = '选择时间',
  disabled = false,
  dense = false,
}: TimeFieldProps) {
  const { open, triggerRef, panelRef, style, placement, toggle, close } = usePopover({ width: 288 });

  const total = timeToMinutes(value);
  const hour = total === null ? -1 : Math.floor(total / 60);
  const minute = total === null ? -1 : total % 60;

  /** 分钟网格：按粒度铺开，并保证"当前值"一定在列表里（可能是 23:59 这类非整步值）。 */
  const minuteOptions = useMemo(() => {
    const step = Math.max(1, Math.min(30, minuteStep));
    const set = new Set<number>();
    for (let m = 0; m < 60; m += step) set.add(m);
    if (minute >= 0) set.add(minute);
    return [...set].sort((a, b) => a - b);
  }, [minuteStep, minute]);

  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (open) setTyped(value);
    // 仅在打开浮层时对齐输入框，避免打断正在进行的输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function pick(h: number, m: number): void {
    onChange(minutesToClock(h * 60 + m));
  }

  function pickPreset(v: string): void {
    const t = timeToMinutes(v);
    if (t === null) return;
    onChange(minutesToClock(t));
  }

  function setNow(): void {
    const v = dateToTimeInput(new Date());
    onChange(v);
    setTyped(v);
  }

  function commitTyped(): void {
    const v = normalizeTime(typed);
    if (v) {
      onChange(v);
      setTyped(v);
    } else {
      setTyped(value);
    }
  }

  /** 键盘微调：方向键按粒度走，Shift 精调 1 分钟，PgUp/PgDn 走整点。 */
  function nudge(delta: number): void {
    const base = total ?? 0;
    onChange(minutesToClock(base + delta));
  }

  function onTriggerKey(e: React.KeyboardEvent): void {
    const step = Math.max(1, Math.min(30, minuteStep));
    if (e.key === 'ArrowUp') nudge(e.shiftKey ? 1 : step);
    else if (e.key === 'ArrowDown') nudge(e.shiftKey ? -1 : -step);
    else if (e.key === 'PageUp') nudge(60);
    else if (e.key === 'PageDown') nudge(-60);
    else return;
    e.preventDefault();
  }

  return (
    <div className={dense ? 'tf tf--dense' : 'tf'}>
      <button
        ref={triggerRef as React.Ref<HTMLButtonElement>}
        className="tf__trigger"
        type="button"
        disabled={disabled}
        aria-label={`${ariaLabel}，当前 ${value}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onTriggerKey}
      >
        <span className="tf__value">{value || '--:--'}</span>
        <span className="tf__caret" aria-hidden="true">
          <Icon name="chevron-down" size={13} />
        </span>
      </button>

      {open &&
        createPortal(
          <div className="pop-layer" style={style}>
            <div
              ref={panelRef as React.Ref<HTMLDivElement>}
              className="pop-panel tf__panel"
              role="dialog"
              aria-label={ariaLabel}
              data-placement={placement}
            >
              <div className="pop-head">
                <span className="pop-title">{ariaLabel}</span>
                <button className="btn btn--sm" type="button" onClick={setNow}>
                  现在
                </button>
              </div>

              <label className="tf__type">
                <span className="sr-only">直接输入时间</span>
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="09:30"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitTyped();
                    }
                  }}
                  onBlur={commitTyped}
                />
                <span className="tf__type-hint">直接输入</span>
              </label>

              {presets.length > 0 && (
                <>
                  <p className="pop-label">常用</p>
                  <div className="tf__presets">
                    {presets.map((p) => (
                      <button
                        key={p}
                        className={`chip chip--btn${p === value ? ' is-on' : ''}`}
                        type="button"
                        onClick={() => pickPreset(p)}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <p className="pop-label">时</p>
              <div className="tf__grid">
                {HOURS.map((h) => (
                  <button
                    key={h}
                    className={`cell${h === hour ? ' is-on' : ''}`}
                    type="button"
                    aria-pressed={h === hour}
                    onClick={() => pick(h, minute < 0 ? 0 : minute)}
                  >
                    {pad(h)}
                  </button>
                ))}
              </div>

              <p className="pop-label">分</p>
              <div className="tf__grid">
                {minuteOptions.map((m) => (
                  <button
                    key={m}
                    className={`cell${m === minute ? ' is-on' : ''}`}
                    type="button"
                    aria-pressed={m === minute}
                    onClick={() => pick(hour < 0 ? 0 : hour, m)}
                  >
                    {pad(m)}
                  </button>
                ))}
              </div>

              <div className="pop-foot">
                <span className="tf__foot-hint">↑↓ 微调 · Shift 精调 1 分钟</span>
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

export default TimeField;

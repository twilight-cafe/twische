/**
 * 重复规则构建器。
 *
 * 设计原则：**不要逼用户理解 RRULE**。用户脑子里想的是"每周一三五早上九点"
 * 或"每月 15 号"，所以界面就按这两种说法组织，而不是暴露 freq/interval/byXXX
 * 这些术语。
 *
 * 两个刻意的取舍：
 * 1. 跨午夜靠"结束时间早于开始时间"表达，但界面必须**立刻回显**「次日 01:00」，
 *    语义不能靠猜。
 * 2. 「按日期」与「按星期」是两种心智模型（15 号 vs 第三个周五），
 *    用显式切换而不是塞进一个多选里 —— 后者会让"每月第 3 个周五"这种
 *    极常见的需求变得无法表达。
 */
import { useMemo, useState } from 'react';
import { describeRecurrence, daysInMonth, parseDateKey, isoWeekday } from '@shared/recurrence.js';
import type { Recurrence } from '@/lib/types';
import {
  WEEKDAY_SHORT,
  WEEKDAY_FULL,
  addDays,
  addMinutesToTime,
  durationMinutes,
  formatDuration,
  timeToMinutes,
  todayKey,
} from '@/lib/datetime';
import Icon from './Icon';
import TimeField from './TimeField';
import DateField from './DateField';
import './RecurrenceBuilder.css';

const FREQS = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'yearly', label: '每年' },
] as const;

const INTERVAL_UNIT: Record<string, string> = {
  daily: '天',
  weekly: '周',
  monthly: '月',
  yearly: '年',
};

const DURATION_PRESETS = [
  { min: 30, label: '30 分' },
  { min: 60, label: '1 小时' },
  { min: 90, label: '1.5 小时' },
  { min: 120, label: '2 小时' },
  { min: 180, label: '3 小时' },
];

const WORKDAYS = [1, 2, 3, 4, 5];

const ORDINALS = [
  { value: 1, label: '第一个' },
  { value: 2, label: '第二个' },
  { value: 3, label: '第三个' },
  { value: 4, label: '第四个' },
  { value: -1, label: '最后一个' },
] as const;

export interface RecurrenceBuilderProps {
  value: Recurrence;
  onChange: (next: Recurrence) => void;
}

export default function RecurrenceBuilder({ value: rule, onChange }: RecurrenceBuilderProps) {
  function patch(p: Partial<Recurrence>): void {
    onChange({ ...rule, ...p });
  }

  // ── 时段 ──
  const startMin = timeToMinutes(rule.startTime);
  const endMin = timeToMinutes(rule.endTime);

  /** 结束早于开始 ⇒ 跨到次日（共享引擎的约定：不用 24:xx 表达）。 */
  const spansMidnight = startMin !== null && endMin !== null && endMin < startMin;
  /** 起止相同 ⇒ 整天。同样要说出来，否则用户会以为自己填错了。 */
  const allDayLike = startMin !== null && endMin !== null && startMin === endMin;

  const duration = durationMinutes(rule.startTime, rule.endTime);
  const durationLabel =
    startMin === null || endMin === null ? '' : formatDuration(duration);

  function setDuration(minutes: number): void {
    patch({ endTime: addMinutesToTime(rule.startTime, minutes) });
  }

  /**
   * 改开始时间时**保持时长**，让结束时间跟着走。
   * 否则把 09:00–10:00 的开始改成 11:00，会突然变成"次日 10:00 结束"（23 小时），
   * 而用户想要的显然是 11:00–12:00。
   */
  function setStart(v: string): void {
    patch({ startTime: v, endTime: addMinutesToTime(v, duration) });
  }

  // ── 间隔 / 次数 ──
  function setIntervalValue(v: number): void {
    patch({ interval: Math.max(1, Math.min(99, v || 1)) });
  }

  function setCount(v: number): void {
    patch({ count: Math.max(1, Math.min(999, v || 1)) });
  }

  // ── 每周 ──
  function toggleWeekday(d: number): void {
    const set = new Set(rule.byWeekday);
    if (set.has(d)) set.delete(d);
    else set.add(d);
    patch({ byWeekday: [...set].sort((a, b) => a - b) });
  }

  const isWorkdays =
    rule.byWeekday.length === 5 && WORKDAYS.every((d) => rule.byWeekday.includes(d));

  // ── 每月 ──
  const monthMode: 'day' | 'nth' = rule.nthWeekday ? 'nth' : 'day';

  function setMonthMode(mode: 'day' | 'nth'): void {
    if (mode === 'day') {
      patch({
        nthWeekday: null,
        byMonthday: rule.byMonthday.length ? rule.byMonthday : [1],
      });
    } else {
      patch({ nthWeekday: { ordinal: 1, weekday: 1 } });
    }
  }

  function toggleMonthday(d: number): void {
    const set = new Set(rule.byMonthday);
    if (set.has(d)) set.delete(d);
    else set.add(d);
    patch({ byMonthday: [...set].sort((a, b) => a - b) });
  }

  /** 当前选中的日期里，哪些在部分月份并不存在 —— 提前提示，避免用户以为漏排了。 */
  const skippedDays =
    monthMode !== 'day' ? [] : rule.byMonthday.filter((d) => d > 28);

  const nthOrdinal = rule.nthWeekday?.ordinal ?? 1;
  const nthWeekday = rule.nthWeekday?.weekday ?? 1;

  function setNth(ordinal: number, weekday: number): void {
    patch({ nthWeekday: { ordinal: ordinal as 1 | 2 | 3 | 4 | -1, weekday } });
  }

  // ── 每年 ──
  function toggleMonth(m: number): void {
    const set = new Set(rule.byMonth);
    if (set.has(m)) set.delete(m);
    else set.add(m);
    patch({ byMonth: [...set].sort((a, b) => a - b) });
  }

  /** 闰日提醒：2/29 只在闰年出现，用户需要知道这件事。 */
  const leapDaySelected =
    rule.freq === 'yearly' && rule.byMonth.includes(2) && rule.byMonthday.includes(29);

  // ── 终止条件 ──
  const endMode: 'never' | 'until' | 'count' = rule.until
    ? 'until'
    : rule.count
      ? 'count'
      : 'never';

  function setEndMode(m: 'never' | 'until' | 'count'): void {
    if (m === 'never') patch({ until: null, count: null });
    else if (m === 'until') patch({ until: rule.until || todayKey(), count: null });
    else patch({ count: rule.count || 10, until: null });
  }

  // ── 生效区间 ──
  const startPresets = useMemo(
    () => [
      { label: '今天', date: todayKey() },
      { label: '明天', date: addDays(todayKey(), 1)! },
      { label: '下周一', date: nextWeekdayKey(1) },
    ],
    // 一天内不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── 例外日期 ──
  const [exdateDraft, setExdateDraft] = useState('');

  function addExdate(key: string): void {
    if (!key) return;
    const set = new Set(rule.exdates);
    set.add(key);
    patch({ exdates: [...set].sort() });
    setExdateDraft('');
  }

  function removeExdate(d: string): void {
    patch({ exdates: rule.exdates.filter((x) => x !== d) });
  }

  const preview = describeRecurrence(rule);

  /** 未来几次发生日期，让用户立刻验证规则是否符合预期。 */
  const previewDates = useMemo(() => {
    const out: string[] = [];
    const now = new Date();
    const start = parseDateKey(rule.dtstart) ? rule.dtstart : todayKey();
    const from = start > todayKey() ? start : todayKey();
    // 用一个极简的前向展开，只服务于预览，不追求完备
    for (let i = 0; i < 400 && out.length < 5; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (key < from) continue;
      if (rule.until && key > rule.until) break;
      if (matches(rule, d, key)) out.push(key);
    }
    return out;
  }, [rule]);

  return (
    <div className="rb">
      {/* ── 频率 ── */}
      <div className="rb__row">
        <span className="label">重复</span>
        <div className="seg">
          {FREQS.map((f) => (
            <button
              key={f.value}
              className={`seg__item${rule.freq === f.value ? ' is-on' : ''}`}
              type="button"
              aria-pressed={rule.freq === f.value}
              onClick={() => patch({ freq: f.value })}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── 间隔 ── */}
      <div className="rb__row">
        <span className="label">间隔</span>
        <div className="rb__inline">
          <span className="mut">每</span>
          <div className="stepper">
            <button
              className="stepper__btn"
              type="button"
              aria-label="减少间隔"
              disabled={rule.interval <= 1}
              onClick={() => setIntervalValue(rule.interval - 1)}
            >
              <Icon name="minus" size={14} />
            </button>
            <input
              type="number"
              min={1}
              max={99}
              inputMode="numeric"
              aria-label="间隔数量"
              value={rule.interval}
              onChange={(e) => setIntervalValue(Number(e.target.value))}
            />
            <button
              className="stepper__btn"
              type="button"
              aria-label="增加间隔"
              disabled={rule.interval >= 99}
              onClick={() => setIntervalValue(rule.interval + 1)}
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
          <span className="mut">{INTERVAL_UNIT[rule.freq]}</span>
        </div>
      </div>

      {/* ── 每周：选星期 ── */}
      {rule.freq === 'weekly' && (
        <div className="rb__row rb__row--top">
          <span className="label">星期</span>
          <div>
            <div className="rb__weekdays">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <button
                  key={d}
                  className={`wd${rule.byWeekday.includes(d) ? ' is-on' : ''}`}
                  type="button"
                  title={WEEKDAY_FULL[d]}
                  aria-label={WEEKDAY_FULL[d]}
                  aria-pressed={rule.byWeekday.includes(d)}
                  onClick={() => toggleWeekday(d)}
                >
                  {WEEKDAY_SHORT[d]}
                </button>
              ))}
            </div>
            <div className="rb__quick">
              <button
                className="chip chip--btn"
                type="button"
                onClick={() => patch({ byWeekday: [...WORKDAYS] })}
              >
                工作日
              </button>
              <button className="chip chip--btn" type="button" onClick={() => patch({ byWeekday: [6, 7] })}>
                周末
              </button>
              <button
                className="chip chip--btn"
                type="button"
                onClick={() => patch({ byWeekday: [1, 2, 3, 4, 5, 6, 7] })}
              >
                每天
              </button>
              {isWorkdays && <span className="rb__tag">已是工作日</span>}
            </div>
          </div>
        </div>
      )}

      {/* ── 每月 ── */}
      {rule.freq === 'monthly' && (
        <>
          <div className="rb__row">
            <span className="label">方式</span>
            <div className="seg seg--sm">
              <button
                className={`seg__item${monthMode === 'day' ? ' is-on' : ''}`}
                type="button"
                aria-pressed={monthMode === 'day'}
                onClick={() => setMonthMode('day')}
              >
                按日期
              </button>
              <button
                className={`seg__item${monthMode === 'nth' ? ' is-on' : ''}`}
                type="button"
                aria-pressed={monthMode === 'nth'}
                onClick={() => setMonthMode('nth')}
              >
                按星期
              </button>
            </div>
          </div>

          {monthMode === 'day' ? (
            <div className="rb__row rb__row--top">
              <span className="label">日期</span>
              <div>
                <div className="rb__days">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31].map(
                    (d) => (
                      <button
                        key={d}
                        className={`cell${rule.byMonthday.includes(d) ? ' is-on' : ''}${d > 28 ? ' cell--mute' : ''}`}
                        type="button"
                        aria-pressed={rule.byMonthday.includes(d)}
                        onClick={() => toggleMonthday(d)}
                      >
                        {d}
                      </button>
                    ),
                  )}
                </div>
                {skippedDays.length > 0 && (
                  <p className="rb__note">
                    <Icon name="alert" size={13} />
                    {skippedDays.join('、')} 号在部分月份不存在（如 2 月没有 30
                    号），这些月份会自动跳过，不会顺延到次月。
                  </p>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="rb__row rb__row--top">
                <span className="label">第几个</span>
                <div className="rb__quick rb__quick--flat">
                  {ORDINALS.map((o) => (
                    <button
                      key={o.value}
                      className={`chip chip--btn${nthOrdinal === o.value ? ' is-on' : ''}`}
                      type="button"
                      aria-pressed={nthOrdinal === o.value}
                      onClick={() => setNth(o.value, nthWeekday)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="rb__row rb__row--top">
                <span className="label">星期</span>
                <div className="rb__weekdays">
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                    <button
                      key={d}
                      className={`wd${nthWeekday === d ? ' is-on' : ''}`}
                      type="button"
                      title={WEEKDAY_FULL[d]}
                      aria-label={WEEKDAY_FULL[d]}
                      aria-pressed={nthWeekday === d}
                      onClick={() => setNth(nthOrdinal, d)}
                    >
                      {WEEKDAY_SHORT[d]}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* ── 每年 ── */}
      {rule.freq === 'yearly' && (
        <>
          <div className="rb__row rb__row--top">
            <span className="label">月份</span>
            <div className="rb__months">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => (
                <button
                  key={m}
                  className={`cell${rule.byMonth.includes(m) ? ' is-on' : ''}`}
                  type="button"
                  aria-pressed={rule.byMonth.includes(m)}
                  onClick={() => toggleMonth(m)}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div className="rb__row rb__row--top">
            <span className="label">日期</span>
            <div>
              <div className="rb__days">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31].map(
                  (d) => (
                    <button
                      key={d}
                      className={`cell${rule.byMonthday.includes(d) ? ' is-on' : ''}${d > 28 ? ' cell--mute' : ''}`}
                      type="button"
                      aria-pressed={rule.byMonthday.includes(d)}
                      onClick={() => toggleMonthday(d)}
                    >
                      {d}
                    </button>
                  ),
                )}
              </div>
              {leapDaySelected && (
                <p className="rb__note">
                  <Icon name="alert" size={13} />
                  选了 2 月 29 日：这一天只在闰年存在，平年会自动跳过（下一次是 2028 年）。
                </p>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── 时段 ── */}
      <div className="rb__row rb__row--top">
        <span className="label">时段</span>
        <div className="rb__time">
          <div className="rb__time-line">
            <div className="rb__slot">
              <TimeField value={rule.startTime} onChange={setStart} ariaLabel="开始时间" dense />
            </div>
            <span className="rb__arrow" aria-hidden="true">
              <Icon name="arrow-right" size={14} />
            </span>
            <div className="rb__slot">
              <TimeField
                value={rule.endTime}
                onChange={(v) => patch({ endTime: v })}
                ariaLabel="结束时间"
                dense
              />
            </div>
            <span className="rb__dur">{durationLabel}</span>
          </div>

          <div className="rb__quick rb__quick--flat">
            {DURATION_PRESETS.map((p) => (
              <button
                key={p.min}
                className={`chip chip--btn${duration === p.min && !allDayLike ? ' is-on' : ''}`}
                type="button"
                onClick={() => setDuration(p.min)}
              >
                {p.label}
              </button>
            ))}
            {spansMidnight ? (
              <span className="rb__tag rb__tag--dusk">
                <Icon name="moon" size={12} />
                到次日 {rule.endTime}
              </span>
            ) : allDayLike ? (
              <span className="rb__tag rb__tag--dusk">
                <Icon name="alert" size={12} />
                起止相同，按整天（24 小时）处理
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* ── 生效区间 ── */}
      <div className="rb__row">
        <span className="label">开始于</span>
        <DateField
          value={rule.dtstart}
          ariaLabel="序列开始日期"
          presets={startPresets}
          onChange={(v) => patch({ dtstart: v || todayKey() })}
        />
      </div>

      <div className="rb__row rb__row--top">
        <span className="label">结束</span>
        <div className="rb__stack">
          <div className="seg seg--sm">
            <button
              className={`seg__item${endMode === 'never' ? ' is-on' : ''}`}
              type="button"
              aria-pressed={endMode === 'never'}
              onClick={() => setEndMode('never')}
            >
              不限
            </button>
            <button
              className={`seg__item${endMode === 'until' ? ' is-on' : ''}`}
              type="button"
              aria-pressed={endMode === 'until'}
              onClick={() => setEndMode('until')}
            >
              到某天
            </button>
            <button
              className={`seg__item${endMode === 'count' ? ' is-on' : ''}`}
              type="button"
              aria-pressed={endMode === 'count'}
              onClick={() => setEndMode('count')}
            >
              共几次
            </button>
          </div>

          {endMode === 'until' && (
            <div className="rb__end-extra">
              <DateField
                value={rule.until || ''}
                ariaLabel="结束日期"
                dense
                onChange={(v) => patch({ until: v || null })}
              />
            </div>
          )}

          {endMode === 'count' && (
            <div className="rb__inline rb__end-extra">
              <div className="stepper">
                <button
                  className="stepper__btn"
                  type="button"
                  aria-label="减少次数"
                  disabled={(rule.count || 1) <= 1}
                  onClick={() => setCount((rule.count || 1) - 1)}
                >
                  <Icon name="minus" size={14} />
                </button>
                <input
                  type="number"
                  min={1}
                  max={999}
                  inputMode="numeric"
                  aria-label="发生次数"
                  value={rule.count || 1}
                  onChange={(e) => setCount(Number(e.target.value))}
                />
                <button
                  className="stepper__btn"
                  type="button"
                  aria-label="增加次数"
                  disabled={(rule.count || 1) >= 999}
                  onClick={() => setCount((rule.count || 1) + 1)}
                >
                  <Icon name="plus" size={14} />
                </button>
              </div>
              <span className="mut">次之后停止</span>
            </div>
          )}
        </div>
      </div>

      {/* ── 例外日期 ── */}
      <div className="rb__row rb__row--top">
        <span className="label">跳过</span>
        <div>
          <div className="rb__exdate-add">
            <DateField
              value={exdateDraft}
              ariaLabel="选择要跳过的日期"
              dense
              onChange={addExdate}
            />
            <span className="rb__hint">选中的日期不排期，例如节假日</span>
          </div>
          {rule.exdates.length > 0 && (
            <div className="rb__exdates">
              {rule.exdates.map((d) => (
                <span key={d} className="chip">
                  {fmtExdate(d)}
                  <button
                    className="chip__x"
                    type="button"
                    aria-label={`移除 ${d}`}
                    onClick={() => removeExdate(d)}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── 预览 ── */}
      <div className="rb__preview">
        <p className="rb__preview-line">
          <Icon name="repeat" size={14} />
          <span>{preview}</span>
        </p>
        {previewDates.length > 0 && (
          <p className="rb__preview-dates">
            接下来：
            {previewDates.map((d) => (
              <span key={d} className="rb__date">
                {fmtPreview(d)}
              </span>
            ))}
          </p>
        )}
      </div>
    </div>
  );
}

function nextWeekdayKey(weekday: number): string {
  const t = todayKey();
  for (let i = 1; i <= 7; i++) {
    const key = addDays(t, i)!;
    const p = parseDateKey(key);
    if (p && isoWeekday(new Date(p.y, p.m - 1, p.d)) === weekday) return key;
  }
  return t;
}

function fmtExdate(d: string): string {
  const p = parseDateKey(d);
  if (!p) return d;
  const wd = WEEKDAY_FULL[isoWeekday(new Date(p.y, p.m - 1, p.d))];
  return `${p.m}/${p.d} ${wd}`;
}

function fmtPreview(key: string): string {
  const p = parseDateKey(key);
  if (!p) return key;
  const wd = WEEKDAY_FULL[isoWeekday(new Date(p.y, p.m - 1, p.d))];
  return `${p.m}/${p.d} ${wd}`;
}

/** 预览用的前向匹配（与共享引擎同一套语义的轻量展开）。 */
function matches(r: Recurrence, d: Date, key: string): boolean {
  const ds = parseDateKey(r.dtstart);
  if (!ds) return false;
  const anchor = new Date(ds.y, ds.m - 1, ds.d);
  const dayDiff = Math.round((d.getTime() - anchor.getTime()) / 86400000);
  if (dayDiff < 0) return false;
  if (r.exdates.includes(key)) return false;

  if (r.freq === 'daily') return dayDiff % Math.max(1, r.interval) === 0;

  if (r.freq === 'weekly') {
    const anchorMonday = new Date(anchor);
    anchorMonday.setDate(anchorMonday.getDate() - ((anchor.getDay() + 6) % 7));
    const monday = new Date(d);
    monday.setDate(monday.getDate() - ((d.getDay() + 6) % 7));
    const weekDiff = Math.round((monday.getTime() - anchorMonday.getTime()) / (7 * 86400000));
    if (weekDiff % Math.max(1, r.interval) !== 0) return false;
    return r.byWeekday.includes(isoWeekday(d));
  }

  if (r.freq === 'monthly') {
    const monthDiff = (d.getFullYear() - anchor.getFullYear()) * 12 + (d.getMonth() - anchor.getMonth());
    if (monthDiff < 0) return false;
    if (monthDiff % Math.max(1, r.interval) !== 0) return false;
    if (r.nthWeekday) {
      const { ordinal, weekday } = r.nthWeekday;
      if (isoWeekday(d) !== weekday) return false;
      const dim = daysInMonth(d.getFullYear(), d.getMonth() + 1);
      if (ordinal === -1) return d.getDate() + 7 > dim;
      return Math.floor((d.getDate() - 1) / 7) + 1 === ordinal;
    }
    return r.byMonthday.includes(d.getDate());
  }

  if (r.freq === 'yearly') {
    const yearDiff = d.getFullYear() - anchor.getFullYear();
    if (yearDiff < 0 || yearDiff % Math.max(1, r.interval) !== 0) return false;
    return r.byMonth.includes(d.getMonth() + 1) && r.byMonthday.includes(d.getDate());
  }
  return false;
}

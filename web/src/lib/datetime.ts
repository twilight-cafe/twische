/**
 * 日期与时间的展示层工具。
 *
 * 排期本身的时间运算（构造、跨天、DST）一律走 @shared/recurrence，
 * 这里只负责"给人看"的格式化与日历网格的拼装。
 */
import { addDays, daysBetween, daysInMonth, isLeapYear, parseDateKey, toDateKey, isoWeekday } from '@shared/recurrence.js';

export { addDays, daysBetween, daysInMonth, isLeapYear, parseDateKey, toDateKey, isoWeekday };

export const WEEKDAY_FULL = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const WEEKDAY_SHORT = ['', '一', '二', '三', '四', '五', '六', '日'];
export const MONTH_NAMES = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月',
];

export const todayKey = (): string => toDateKey(new Date());

export function nowLocalDateTime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${toDateKey(d)}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 本周起始日。weekStart 用 0=周日、1=周一（与 Date.getDay 一致）。 */
export function startOfWeek(key: string, weekStart = 1): string {
  const iso = isoWeekday(new Date(...(toTuple(key) as [number, number, number])));
  // 把 ISO 星期(1..7) 换算成相对 weekStart 的偏移
  const offset = (iso - 1 - (weekStart === 0 ? 6 : weekStart - 1) + 7) % 7;
  return addDays(key, -offset)!;
}

function toTuple(key: string): [number, number, number] {
  const p = parseDateKey(key);
  if (!p) return [1970, 1, 1];
  return [p.y, p.m - 1, p.d];
}

/** 从 weekStart 起算的 7 天日期键。 */
export function weekDays(anchorKey: string, weekStart = 1): string[] {
  const s = startOfWeek(anchorKey, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(s, i)!);
}

export function addMonthsKey(key: string, delta: number): string {
  const p = parseDateKey(key);
  if (!p) return key;
  // 先按月份推进，再把日期夹到该月合法范围内 —— 1/31 加一个月应得 2/28 而非 3/3
  const total = p.y * 12 + (p.m - 1) + delta;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const d = Math.min(p.d, daysInMonth(y, m));
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 月视图网格：固定 6 行 × 7 列，保证切换月份时高度不跳动。 */
export function monthMatrix(anchorKey: string, weekStart = 1): string[][] {
  const p = parseDateKey(anchorKey);
  if (!p) return [];
  const firstOfMonth = `${p.y}-${String(p.m).padStart(2, '0')}-01`;
  const gridStart = startOfWeek(firstOfMonth, weekStart);
  return Array.from({ length: 6 }, (_, row) =>
    Array.from({ length: 7 }, (_, col) => addDays(gridStart, row * 7 + col)!),
  );
}

/** '9月12日 周六' / '今天' / '明天' / '昨天' */
export function formatDateLabel(key: string, opts: { relative?: boolean } = {}): string {
  const p = parseDateKey(key);
  if (!p) return key;
  const diff = daysBetween(todayKey(), key);
  if (opts.relative !== false) {
    if (diff === 0) return '今天';
    if (diff === 1) return '明天';
    if (diff === -1) return '昨天';
  }
  const wd = WEEKDAY_FULL[isoWeekday(new Date(p.y, p.m - 1, p.d))];
  const base = `${p.m} 月 ${p.d} 日 ${wd}`;
  if (p.y !== new Date().getFullYear()) return `${p.y} 年 ${base}`;
  return base;
}

export function formatMonthLabel(key: string): string {
  const p = parseDateKey(key);
  if (!p) return key;
  return `${p.y} 年 ${MONTH_NAMES[p.m - 1]}`;
}

/** 相对时间，用于"最后同步于…"。 */
export function formatRelative(ts: number | null | undefined): string {
  if (!ts) return '从未';
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  if (diff < 45_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 分钟数 → 'HH:mm'，供时间轴刻度使用。超过一天时回绕。 */
export function minutesToClock(minutes: number): string {
  const n = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

/** 把 Date 转成 input[type=time] 需要的 'HH:mm'。 */
export function dateToTimeInput(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 'HH:mm' → 自 0 点起的分钟数；不合法返回 null。 */
export function timeToMinutes(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v || '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 用户随手敲的时间 → 'HH:mm'。
 *
 * 时间选择器允许直接输入，就得接受人的写法：`9:30`、`930`、`09`、`9点30`。
 * 解析不出来时返回 null，由调用方决定是忽略还是提示，不要在这里猜。
 */
export function normalizeTime(raw: string): string | null {
  const s = (raw || '').trim();
  if (!s) return null;

  const colon = /^(\d{1,2})\s*[:：.时]\s*(\d{1,2})?\s*分?$/.exec(s);
  if (colon) {
    const h = Number(colon[1]);
    const m = colon[2] === undefined || colon[2] === '' ? 0 : Number(colon[2]);
    if (h > 23 || m > 59) return null;
    return minutesToClock(h * 60 + m);
  }

  const digits = s.replace(/\D/g, '');
  if (digits.length === 0 || digits.length > 4) return null;
  const h = digits.length <= 2 ? Number(digits) : Number(digits.slice(0, digits.length - 2));
  const m = digits.length <= 2 ? 0 : Number(digits.slice(-2));
  if (h > 23 || m > 59) return null;
  return minutesToClock(h * 60 + m);
}

/** 在 'HH:mm' 上加减分钟，跨午夜自动回绕。 */
export function addMinutesToTime(v: string, delta: number): string {
  const base = timeToMinutes(v);
  if (base === null) return v;
  return minutesToClock(base + delta);
}

/**
 * 时间区间的时长（分钟）。结束早于开始视为跨到次日 —— 与共享排期引擎
 * 对 endTime 的定义保持一致（见 shared/recurrence.js 的 parseHHMM 约定）。
 */
export function durationMinutes(startTime: string, endTime: string): number {
  const s = timeToMinutes(startTime);
  const e = timeToMinutes(endTime);
  if (s === null || e === null) return 0;
  return e > s ? e - s : e - s + 1440;
}

/** 时长 → '1 小时 30 分钟'。 */
export function formatDuration(minutes: number): string {
  if (minutes <= 0) return '0 分钟';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} 分钟`;
  if (m === 0) return `${h} 小时`;
  return `${h} 小时 ${m} 分钟`;
}

/** 当前时刻在时间轴上的位置（分钟，含秒的小数部分，让线平滑移动）。 */
export function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

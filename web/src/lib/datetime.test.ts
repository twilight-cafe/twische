import { describe, it, expect } from 'vitest';
import {
  todayKey,
  nowLocalDateTime,
  startOfWeek,
  weekDays,
  addMonthsKey,
  monthMatrix,
  formatDateLabel,
  formatMonthLabel,
  formatRelative,
  formatDateTime,
  minutesToClock,
  dateToTimeInput,
  timeToMinutes,
  normalizeTime,
  addMinutesToTime,
  durationMinutes,
  formatDuration,
  WEEKDAY_FULL,
  MONTH_NAMES,
} from './datetime';
import { addDays } from '@shared/recurrence.js';

describe('常量表', () => {
  it('周表 1..7 对应周一..周日，0 号位为空', () => {
    expect(WEEKDAY_FULL[0]).toBe('');
    expect(WEEKDAY_FULL[1]).toBe('周一');
    expect(WEEKDAY_FULL[7]).toBe('周日');
    expect(MONTH_NAMES).toHaveLength(12);
    expect(MONTH_NAMES[0]).toBe('一月');
  });
});

describe('todayKey / nowLocalDateTime', () => {
  it('todayKey 是合法日期键', () => {
    expect(todayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('nowLocalDateTime 是 YYYY-MM-DDTHH:mm', () => {
    expect(nowLocalDateTime()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

describe('startOfWeek / weekDays', () => {
  it('2026-09-13 是周日：周一起始应回退到 09-07', () => {
    expect(startOfWeek('2026-09-13', 1)).toBe('2026-09-07');
  });

  it('周日起始时周日当天即是周首', () => {
    expect(startOfWeek('2026-09-13', 0)).toBe('2026-09-13');
  });

  it('周一锚点在周中回退正确（周三 → 本周一）', () => {
    expect(startOfWeek('2026-09-09', 1)).toBe('2026-09-07');
  });

  it('非法日期键不抛错（toTuple 退化为 epoch）', () => {
    expect(() => startOfWeek('bad-key')).not.toThrow();
  });

  it('weekDays 返回从周首起连续 7 天', () => {
    const days = weekDays('2026-09-13', 1);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-09-07');
    expect(days[6]).toBe('2026-09-13');
  });
});

describe('addMonthsKey', () => {
  it('1/31 加一个月夹到 2/28（非闰年）', () => {
    expect(addMonthsKey('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('闰年夹到 2/29', () => {
    expect(addMonthsKey('2024-01-31', 1)).toBe('2024-02-29');
  });

  it('普通日期正常推进，跨年正确', () => {
    expect(addMonthsKey('2026-03-15', 10)).toBe('2027-01-15');
    expect(addMonthsKey('2026-01-15', -1)).toBe('2025-12-15');
  });

  it('非法日期键原样返回', () => {
    expect(addMonthsKey('not-a-date', 1)).toBe('not-a-date');
  });
});

describe('monthMatrix', () => {
  it('固定 6 行 × 7 列，包含当月 1 号', () => {
    const grid = monthMatrix('2026-09-13');
    expect(grid).toHaveLength(6);
    grid.forEach((row) => expect(row).toHaveLength(7));
    const flat = grid.flat();
    expect(flat).toContain('2026-09-01');
    // 网格首尾连续
    expect(flat[1]).toBe(addDays(flat[0], 1));
  });

  it('周日起始时 1 号可能落在第一行首', () => {
    const grid = monthMatrix('2026-02-15', 0);
    expect(grid.flat()).toContain('2026-02-01');
  });

  it('非法锚点返回空网格', () => {
    expect(monthMatrix('bad')).toEqual([]);
  });
});

describe('formatDateLabel', () => {
  it('今天 / 明天 / 昨天', () => {
    const t = todayKey();
    expect(formatDateLabel(t)).toBe('今天');
    expect(formatDateLabel(addDays(t, 1)!)).toBe('明天');
    expect(formatDateLabel(addDays(t, -1)!)).toBe('昨天');
  });

  it('同年其它日期显示 月 日 周几', () => {
    // 2026-09-12 周六（当年为 2026）
    const label = formatDateLabel('2026-09-12', { relative: false });
    expect(label).toContain('9 月 12 日');
    expect(label).toContain('周六');
  });

  it('跨年显示年份前缀', () => {
    const label = formatDateLabel('2030-01-01', { relative: false });
    expect(label).toContain('2030 年');
  });

  it('relative: false 关闭今天/明天文案', () => {
    const t = todayKey();
    const label = formatDateLabel(t, { relative: false });
    expect(label).not.toBe('今天');
  });

  it('非法键原样返回', () => {
    expect(formatDateLabel('oops')).toBe('oops');
  });
});

describe('formatMonthLabel', () => {
  it('年 + 中文月名', () => {
    expect(formatMonthLabel('2026-09-01')).toBe('2026 年 九月');
  });

  it('非法键原样返回', () => {
    expect(formatMonthLabel('x')).toBe('x');
  });
});

describe('formatRelative', () => {
  it('空值显示 从未', () => {
    expect(formatRelative(null)).toBe('从未');
    expect(formatRelative(0)).toBe('从未');
    expect(formatRelative(undefined)).toBe('从未');
  });

  it('未来时刻与 45 秒内都算 刚刚', () => {
    expect(formatRelative(Date.now() + 10_000)).toBe('刚刚');
    expect(formatRelative(Date.now() - 10_000)).toBe('刚刚');
  });

  it('分钟 / 小时 / 天', () => {
    expect(formatRelative(Date.now() - 120_000)).toBe('2 分钟前');
    expect(formatRelative(Date.now() - 2 * 3_600_000)).toBe('2 小时前');
    expect(formatRelative(Date.now() - 3 * 86_400_000)).toBe('3 天前');
  });

  it('超过一周显示日期', () => {
    const ts = Date.now() - 8 * 86_400_000;
    expect(formatRelative(ts)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatDateTime', () => {
  it('空值显示 -', () => {
    expect(formatDateTime(null)).toBe('-');
    expect(formatDateTime(undefined)).toBe('-');
    expect(formatDateTime(0)).toBe('-');
  });

  it('格式为 YYYY-MM-DD HH:mm', () => {
    // 本地时区构造一个已知时刻
    const d = new Date(2026, 8, 13, 9, 5);
    expect(formatDateTime(d.getTime())).toBe('2026-09-13 09:05');
  });
});

describe('minutesToClock', () => {
  it('基本换算与回绕', () => {
    expect(minutesToClock(725)).toBe('12:05');
    expect(minutesToClock(1440)).toBe('00:00');
    expect(minutesToClock(-60)).toBe('23:00');
    expect(minutesToClock(1500)).toBe('01:00');
    expect(minutesToClock(60.4)).toBe('01:00');
  });
});

describe('dateToTimeInput', () => {
  it('补零为 HH:mm', () => {
    expect(dateToTimeInput(new Date(2026, 0, 1, 3, 4))).toBe('03:04');
  });
});

describe('timeToMinutes', () => {
  it('合法值', () => {
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('23:59')).toBe(1439);
  });

  it('非法值返回 null', () => {
    expect(timeToMinutes('24:00')).toBeNull();
    expect(timeToMinutes('12:60')).toBeNull();
    expect(timeToMinutes('abc')).toBeNull();
    expect(timeToMinutes('')).toBeNull();
  });
});

describe('normalizeTime', () => {
  it('空输入返回 null', () => {
    expect(normalizeTime('')).toBeNull();
    expect(normalizeTime('   ')).toBeNull();
  });

  it('分隔符写法', () => {
    expect(normalizeTime('9:30')).toBe('09:30');
    expect(normalizeTime('9：30')).toBe('09:30');
    expect(normalizeTime('9.30')).toBe('09:30');
    expect(normalizeTime('9时30分')).toBe('09:30');
    expect(normalizeTime('9时')).toBe('09:00');
    expect(normalizeTime('9:5')).toBe('09:05');
    expect(normalizeTime('23:59')).toBe('23:59');
  });

  it('分隔符写法的越界值', () => {
    expect(normalizeTime('24:00')).toBeNull();
    expect(normalizeTime('9:60')).toBeNull();
  });

  it('纯数字写法', () => {
    expect(normalizeTime('930')).toBe('09:30');
    expect(normalizeTime('09')).toBe('09:00');
    expect(normalizeTime('9')).toBe('09:00');
    expect(normalizeTime('0')).toBe('00:00');
  });

  it('纯数字写法的越界与不合法', () => {
    expect(normalizeTime('2400')).toBeNull();
    expect(normalizeTime('99')).toBeNull();
    expect(normalizeTime('12345')).toBeNull();
    expect(normalizeTime('abc')).toBeNull();
  });
});

describe('addMinutesToTime', () => {
  it('跨午夜回绕', () => {
    expect(addMinutesToTime('23:50', 20)).toBe('00:10');
    expect(addMinutesToTime('00:10', -20)).toBe('23:50');
  });

  it('非法输入原样返回', () => {
    expect(addMinutesToTime('nope', 5)).toBe('nope');
  });
});

describe('durationMinutes', () => {
  it('同日区间', () => {
    expect(durationMinutes('09:00', '10:30')).toBe(90);
  });

  it('结束早于开始视为跨次日', () => {
    expect(durationMinutes('23:00', '01:00')).toBe(120);
  });

  it('相等视为整整一天', () => {
    expect(durationMinutes('10:00', '10:00')).toBe(1440);
  });

  it('非法输入返回 0', () => {
    expect(durationMinutes('xx', '10:00')).toBe(0);
    expect(durationMinutes('09:00', '25:00')).toBe(0);
  });
});

describe('formatDuration', () => {
  it('各种分段', () => {
    expect(formatDuration(0)).toBe('0 分钟');
    expect(formatDuration(-5)).toBe('0 分钟');
    expect(formatDuration(45)).toBe('45 分钟');
    expect(formatDuration(60)).toBe('1 小时');
    expect(formatDuration(90)).toBe('1 小时 30 分钟');
  });
});

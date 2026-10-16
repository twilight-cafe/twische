import { describe, test, expect } from 'vitest';
import {
  expandOccurrences,
  validateTask,
  describeRecurrence,
  normalizeRecurrence,
  nthWeekdayOfMonth,
  parseDateKey,
  parseLocalDateTime,
  daysBetween,
  localAt,
  toDateKey,
} from './recurrence.js';

/**
 * 补齐 v1 那套用例没覆盖到的分支。
 *
 * 这一组刻意只放"边界与防御分支"：正常路径在 recurrence.test.js 里。
 * 其中几条是**证明不可达**的防御代码，用 `v8 ignore` 标注并说明原因 ——
 * 比编造一个永远走不到的测试诚实。
 */

const base = (over = {}) => ({
  id: 'task-1',
  title: '测试任务',
  kind: 'fixed',
  status: 'open',
  recurrence: { freq: 'daily', startTime: '09:00', endTime: '10:00', dtstart: '2026-01-01' },
  ...over,
});

describe('时间基元的非法输入', () => {
  test('非字符串一律拒绝，而不是抛异常', () => {
    expect(parseDateKey(null)).toBeNull();
    expect(parseDateKey(20260101)).toBeNull();
    expect(parseLocalDateTime(123)).toBeNull();
    expect(parseLocalDateTime('2026-02-30T10:00')).toBeNull();
    expect(parseLocalDateTime('2026-01-01T25:00')).toBeNull();
    expect(localAt('不是日期', 0)).toBeNull();
  });

  test('daysBetween 遇到非法日期返回 NaN', () => {
    expect(Number.isNaN(daysBetween('bad', '2026-01-01'))).toBe(true);
    expect(Number.isNaN(daysBetween('2026-01-01', 'bad'))).toBe(true);
    expect(daysBetween('2026-01-01', '2026-01-03')).toBe(2);
  });

  test('nthWeekdayOfMonth：最后一个周五', () => {
    expect(nthWeekdayOfMonth(2026, 1, -1, 5)).toBe('2026-01-30');
    expect(nthWeekdayOfMonth(2026, 2, 5, 5)).toBeNull(); // 2026 年 2 月只有 4 个周五
  });
});

describe('规则规范化的兜底路径', () => {
  test('输入为 null / 字段类型全错时也能收敛成合法规则', () => {
    expect(normalizeRecurrence(null).rule.freq).toBe('weekly');

    const { rule } = normalizeRecurrence({
      freq: 'monthly',
      dtstart: '2026-03-15',
      byWeekday: 'nope',
      exdates: 'nope',
      nthWeekday: 'nope',
      until: undefined,
    });
    // 每月但没给日期 → 用起始日那天
    expect(rule.byMonthday).toEqual([15]);
    expect(rule.byWeekday).toEqual([]);
    expect(rule.exdates).toEqual([]);
    expect(rule.nthWeekday).toBeNull();
    expect(rule.until).toBeNull();
  });

  test('until 给非法值时收敛成 null（而不是原样留在规则里）', () => {
    expect(normalizeRecurrence({ until: '不是日期' }).rule.until).toBeNull();
    expect(normalizeRecurrence({ until: '2026-01-01', dtstart: '2026-05-01' }).rule.until).toBeNull();
    expect(normalizeRecurrence({ until: '2026-06-01', dtstart: '2026-05-01' }).rule.until).toBe('2026-06-01');
  });

  test('结束时间非法时按开始时间 + 1 小时兜底', () => {
    const { rule } = normalizeRecurrence({ startTime: '08:30', endTime: 'nope' });
    expect(rule.startTime).toBe('08:30');
    expect(rule.endTime).toBe('09:30');
  });

  test('nthWeekday 只在 ordinal 与 weekday 都合法时才保留', () => {
    expect(normalizeRecurrence({ freq: 'monthly', nthWeekday: { ordinal: 3, weekday: 99 } }).rule.nthWeekday).toBeNull();
    expect(normalizeRecurrence({ freq: 'monthly', nthWeekday: { ordinal: 9, weekday: 5 } }).rule.nthWeekday).toBeNull();
  });

  test('校验任务时补上 id 与标题的缺失分支', () => {
    expect(validateTask({ kind: 'fixed', title: 'x' })).toContain('缺少任务 id');
    expect(validateTask({ id: 'a', kind: 'fixed' })).toContain('标题不能为空');
  });

  test('起止时间都非法时回退 09:00–10:00', () => {
    const { rule } = normalizeRecurrence({ startTime: 'nope', endTime: 'nope' });
    expect(rule.startTime).toBe('09:00');
    expect(rule.endTime).toBe('10:00');
  });

  test('dtstart 落在月末时每月规则取该日', () => {
    const { rule } = normalizeRecurrence({ freq: 'monthly', dtstart: '2026-01-31' });
    expect(rule.byMonthday).toEqual([31]);
  });
});

describe('展开器的边界与防护', () => {
  test('查询区间远远超出上限时靠周期上限刹车（而不是挂死）', () => {
    // 1000 年 ≈ 36 万天，远超 MAX_PERIODS(50000)；这条用例同时是防死循环的回归测试
    const daily = expandOccurrences(
      base({ recurrence: { freq: 'daily', dtstart: '2000-01-01' } }),
      '2000-01-01',
      '9999-12-31',
    );
    expect(daily.length).toBeGreaterThan(0);
    expect(daily.length).toBeLessThanOrEqual(5000);

    const weekly = expandOccurrences(
      base({ recurrence: { freq: 'weekly', dtstart: '2000-01-03', byWeekday: [1] } }),
      '2000-01-01',
      '9999-12-31',
    );
    expect(weekly.length).toBeLessThanOrEqual(5000);

    const monthly = expandOccurrences(
      base({ recurrence: { freq: 'monthly', dtstart: '2000-01-15', byMonthday: [15] } }),
      '2000-01-01',
      '9999-12-31',
    );
    expect(monthly.length).toBeLessThanOrEqual(5000);
  }, 20000);

  test('每年重复：从 dtstart 之后很多年才开始查也能算对', () => {
    const task = base({
      recurrence: { freq: 'yearly', dtstart: '2020-03-08', byMonth: [3], byMonthday: [8] },
    });
    const occ = expandOccurrences(task, '2026-01-01', '2026-12-31');
    expect(occ.map((o) => o.key)).toEqual(['2026-03-08']);
  });

  test('每年重复遇到闰日：平年跳过而不是挪到 3 月', () => {
    const task = base({
      recurrence: { freq: 'yearly', dtstart: '2024-02-29', byMonth: [2], byMonthday: [29] },
    });
    expect(expandOccurrences(task, '2025-01-01', '2025-12-31')).toEqual([]);
    expect(expandOccurrences(task, '2028-01-01', '2028-12-31').map((o) => o.key)).toEqual(['2028-02-29']);
  });

  test('月初之后才开始查的每月规则也对齐', () => {
    const task = base({ recurrence: { freq: 'monthly', dtstart: '2020-01-31', byMonthday: [31] } });
    // 2 月没有 31 号 → 跳过（与 RFC 5545 一致）
    expect(expandOccurrences(task, '2026-02-01', '2026-02-28')).toEqual([]);
    expect(expandOccurrences(task, '2026-03-01', '2026-03-31').map((o) => o.key)).toEqual(['2026-03-31']);
  });
});

describe('规则描述', () => {
  test('omitTime 时不带时段', () => {
    const text = describeRecurrence({ freq: 'daily', startTime: '09:00', endTime: '10:00' }, { omitTime: true });
    expect(text).toBe('每天');
  });

  test('每周七天等价于每天；间隔大于 1 时也要说清楚', () => {
    expect(describeRecurrence({ freq: 'weekly', byWeekday: [1, 2, 3, 4, 5, 6, 7] })).toContain('每天');
    expect(describeRecurrence({ freq: 'weekly', interval: 2, byWeekday: [1, 2, 3, 4, 5, 6, 7] })).toContain(
      '每 2 周（每天）',
    );
  });

  test('每年、终止条件、跳过天数都能读出来', () => {
    const text = describeRecurrence({
      freq: 'yearly',
      interval: 1,
      byMonth: [3],
      byMonthday: [8],
      startTime: '09:00',
      endTime: '10:00',
      until: '2030-03-08',
      exdates: ['2026-03-08'],
    });
    expect(text).toContain('每年 3 月 8 日');
    expect(text).toContain('至 2030-03-08');
    expect(text).toContain('跳过 1 天');

    expect(describeRecurrence({ freq: 'daily', count: 5 })).toContain('共 5 次');
  });

  test('每月第几个星期几的描述', () => {
    expect(describeRecurrence({ freq: 'monthly', nthWeekday: { ordinal: 3, weekday: 5 } })).toContain(
      '每月第三个周五',
    );
    expect(describeRecurrence({ freq: 'monthly', nthWeekday: { ordinal: -1, weekday: 5 } })).toContain(
      '每月最后一个周五',
    );
  });
});

describe('toDateKey 与本地时间构造', () => {
  test('补零正确', () => {
    expect(toDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toDateKey(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  expandOccurrences,
  describeRecurrence,
  validateTask,
  normalizeRecurrence,
  parseHHMM,
  formatHHMM,
  formatDuration,
  parseDateKey,
  toDateKey,
  addDays,
  daysInMonth,
  isLeapYear,
  nthWeekdayOfMonth,
  toLocalDateTime,
  localAt,
  occurrenceCompletionId,
} from '../recurrence.js';

const base = (over = {}) => ({
  id: 'task-1',
  title: '测试任务',
  kind: 'fixed',
  status: 'open',
  recurrence: { freq: 'daily', startTime: '09:00', endTime: '10:00', dtstart: '2026-01-01' },
  ...over,
});

/** 展开后取日期键，便于断言 */
const keys = (task, from, to, opts) => expandOccurrences(task, from, to, opts).map((o) => o.key);

describe('时间基元 · 解析与格式化', () => {
  test('parseHHMM 只接受 00:00–23:59，跨天不靠 >24h 表达', () => {
    assert.equal(parseHHMM('09:05'), 545);
    assert.equal(parseHHMM('9:05'), 545);
    assert.equal(parseHHMM('00:00'), 0);
    assert.equal(parseHHMM('23:59'), 1439);
    assert.equal(parseHHMM('9:5'), null);
    assert.equal(parseHHMM('24:00'), null, '跨午夜应写 00:00 并让 endTime <= startTime 表达');
    assert.equal(parseHHMM('24:60'), null);
    assert.equal(parseHHMM('25:30'), null);
    assert.equal(parseHHMM('abc'), null);
    assert.equal(parseHHMM(null), null);
  });

  test('formatHHMM 把计算/兜底结果收进 00:00–23:59 合法域', () => {
    assert.equal(formatHHMM(0), '00:00');
    assert.equal(formatHHMM(545), '09:05');
    assert.equal(formatHHMM(1439), '23:59');
    assert.equal(formatHHMM(1440), '00:00', '满一天应回绕，不能写成 24:00');
    assert.equal(formatHHMM(1530), '01:30');
    assert.equal(formatHHMM(-60), '23:00', '负数不应越界');
  });

  test('formatDuration 中文可读', () => {
    assert.equal(formatDuration(0), '0 分钟');
    assert.equal(formatDuration(45), '45 分钟');
    assert.equal(formatDuration(60), '1 小时');
    assert.equal(formatDuration(90), '1 小时 30 分钟');
    assert.equal(formatDuration(-5), '0 分钟', '负时长不应显示成负数');
  });

  test('parseDateKey 拒绝现实中不存在的日期', () => {
    assert.deepEqual(parseDateKey('2026-03-15'), { y: 2026, m: 3, d: 15 });
    assert.equal(parseDateKey('2026-02-30'), null, '2 月 30 日必须被拒');
    assert.equal(parseDateKey('2025-02-29'), null, '平年 2 月 29 日必须被拒');
    assert.deepEqual(parseDateKey('2024-02-29'), { y: 2024, m: 2, d: 29 }, '闰年 2 月 29 日合法');
    assert.equal(parseDateKey('2026-13-01'), null);
    assert.equal(parseDateKey('2026-00-10'), null);
    assert.equal(parseDateKey('26-01-01'), null);
  });

  test('闰年判定覆盖百年/四百年规则', () => {
    assert.equal(isLeapYear(2024), true);
    assert.equal(isLeapYear(2025), false);
    assert.equal(isLeapYear(1900), false, '整百年需能被 400 整除');
    assert.equal(isLeapYear(2000), true);
    assert.equal(daysInMonth(2024, 2), 29);
    assert.equal(daysInMonth(2025, 2), 28);
    assert.equal(daysInMonth(2026, 4), 30);
  });

  test('addDays 正确跨越月末与年末', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addDays('2025-12-31', 1), '2026-01-01');
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
    assert.equal(addDays('2024-03-01', -1), '2024-02-29');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('bad', 1), null);
  });

  test('nthWeekdayOfMonth 处理"第 N 个"与"最后一个"，缺位时返回 null', () => {
    // 2026-01: 周五是 2,9,16,23,30
    assert.equal(nthWeekdayOfMonth(2026, 1, 1, 5), '2026-01-02');
    assert.equal(nthWeekdayOfMonth(2026, 1, 3, 5), '2026-01-16');
    assert.equal(nthWeekdayOfMonth(2026, 1, -1, 5), '2026-01-30');
    // 2026-02 只有 4 个周五(6,13,20,27) → 第 5 个不存在
    assert.equal(nthWeekdayOfMonth(2026, 2, 5, 5), null);
    assert.equal(nthWeekdayOfMonth(2026, 2, -1, 5), '2026-02-27');
  });
});

describe('重复展开 · 每日', () => {
  test('基本展开，区间两端均为闭区间', () => {
    const t = base();
    assert.deepEqual(keys(t, '2026-01-01', '2026-01-05'), [
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
    ]);
  });

  test('dtstart 之前的日期不产生实例（从区间中段开始查询也不会外溢）', () => {
    const t = base({ recurrence: { freq: 'daily', dtstart: '2026-01-10', startTime: '09:00', endTime: '10:00' } });
    assert.deepEqual(keys(t, '2026-01-01', '2026-01-12'), ['2026-01-10', '2026-01-11', '2026-01-12']);
  });

  test('interval = 3 时锚定 dtstart 而非区间起点（跨区间查询结果一致）', () => {
    const t = base({
      recurrence: { freq: 'daily', interval: 3, dtstart: '2026-01-01', startTime: '09:00', endTime: '10:00' },
    });
    const full = keys(t, '2026-01-01', '2026-01-13');
    assert.deepEqual(full, [
      '2026-01-01',
      '2026-01-04',
      '2026-01-07',
      '2026-01-10',
      '2026-01-13',
    ]);
    // 分段查询拼接后必须与整段一致 —— 锚定逻辑写错时这里必然露馅
    const part1 = keys(t, '2026-01-01', '2026-01-07');
    const part2 = keys(t, '2026-01-08', '2026-01-13');
    assert.deepEqual([...part1, ...part2], full);
  });
});

describe('重复展开 · 每周', () => {
  test('多个星期几，且同一周内按星期升序', () => {
    const t = base({
      recurrence: { freq: 'weekly', byWeekday: [5, 1, 3], dtstart: '2026-01-05', startTime: '09:00', endTime: '10:00' },
    });
    // 2026-01-05 是周一
    assert.deepEqual(keys(t, '2026-01-05', '2026-01-18'), [
      '2026-01-05', // 一
      '2026-01-07', // 三
      '2026-01-09', // 五
      '2026-01-12',
      '2026-01-14',
      '2026-01-16',
    ]);
  });

  test('interval = 2 隔周重复，跨月边界仍锚定起始周', () => {
    const t = base({
      recurrence: { freq: 'weekly', interval: 2, byWeekday: [1], dtstart: '2026-01-05', startTime: '09:00', endTime: '10:00' },
    });
    assert.deepEqual(keys(t, '2026-01-01', '2026-02-10'), [
      '2026-01-05',
      '2026-01-19',
      '2026-02-02',
    ]);
  });

  test('未指定星期几时回落到 dtstart 当天星期', () => {
    const t = base({
      recurrence: { freq: 'weekly', dtstart: '2026-01-07', startTime: '09:00', endTime: '10:00' },
    });
    // 2026-01-07 是周三
    assert.deepEqual(keys(t, '2026-01-01', '2026-01-21'), ['2026-01-07', '2026-01-14', '2026-01-21']);
  });

  test('星期几去重且排序：传入 [5,5,1,9,0] 只保留合法值', () => {
    const { rule } = normalizeRecurrence({ freq: 'weekly', byWeekday: [5, 5, 1, 9, 0] });
    assert.deepEqual(rule.byWeekday, [1, 5]);
  });
});

describe('重复展开 · 每月（月末缺失日是重点）', () => {
  test('31 号在只有 30 天的月份被跳过——对齐 RFC 5545，而非顺延到次月', () => {
    const t = base({
      recurrence: { freq: 'monthly', byMonthday: [31], dtstart: '2026-01-31', startTime: '09:00', endTime: '10:00' },
    });
    assert.deepEqual(keys(t, '2026-01-01', '2026-06-30'), [
      '2026-01-31',
      // 2 月无 31 日 → 跳过
      '2026-03-31',
      // 4 月无 31 日 → 跳过
      '2026-05-31',
      // 6 月无 31 日 → 跳过
    ]);
  });

  test('2 月 29 日的月度规则：平年跳过，闰年命中', () => {
    const t = base({
      recurrence: { freq: 'monthly', byMonthday: [29], dtstart: '2024-01-29', startTime: '09:00', endTime: '10:00' },
    });
    const got = keys(t, '2025-01-01', '2025-03-31');
    assert.deepEqual(got, ['2025-01-29', '2025-03-29'], '2025 年 2 月无 29 日，应跳过');
    const leap = keys(t, '2024-02-01', '2024-02-29');
    assert.deepEqual(leap, ['2024-02-29']);
  });

  test('多个日期（如 1 号与 15 号）同月内升序', () => {
    const t = base({
      recurrence: { freq: 'monthly', byMonthday: [15, 1], dtstart: '2026-01-01', startTime: '09:00', endTime: '10:00' },
    });
    assert.deepEqual(keys(t, '2026-01-01', '2026-02-28'), [
      '2026-01-01',
      '2026-01-15',
      '2026-02-01',
      '2026-02-15',
    ]);
  });

  test('「每月第三个周五」', () => {
    const t = base({
      recurrence: { freq: 'monthly', nthWeekday: { ordinal: 3, weekday: 5 }, dtstart: '2026-01-01', startTime: '09:00', endTime: '10:00' },
    });
    assert.deepEqual(keys(t, '2026-01-01', '2026-04-30'), [
      '2026-01-16',
      '2026-02-20',
      '2026-03-20',
      '2026-04-17',
    ]);
  });

  test('「每月最后一个工作日式」的最后一个周五', () => {
    const t = base({
      recurrence: { freq: 'monthly', nthWeekday: { ordinal: -1, weekday: 5 }, dtstart: '2026-01-01', startTime: '09:00', endTime: '10:00' },
    });
    assert.deepEqual(keys(t, '2026-01-01', '2026-03-31'), [
      '2026-01-30',
      '2026-02-27',
      '2026-03-27',
    ]);
  });

  test('interval = 2 的双月规则', () => {
    const t = base({
      recurrence: { freq: 'monthly', interval: 2, byMonthday: [10], dtstart: '2026-01-10', startTime: '09:00', endTime: '10:00' },
    });
    assert.deepEqual(keys(t, '2026-01-01', '2026-07-31'), [
      '2026-01-10',
      '2026-03-10',
      '2026-05-10',
      '2026-07-10',
    ]);
  });
});

describe('重复展开 · 每年', () => {
  test('2 月 29 日年度任务只在闰年出现', () => {
    const t = base({
      recurrence: { freq: 'yearly', byMonth: [2], byMonthday: [29], dtstart: '2024-02-29', startTime: '09:00', endTime: '10:00' },
    });
    assert.deepEqual(keys(t, '2024-01-01', '2029-12-31'), ['2024-02-29', '2028-02-29']);
  });

  test('年度默认取 dtstart 的月与日', () => {
    const t = base({
      recurrence: { freq: 'yearly', dtstart: '2026-06-15', startTime: '09:00', endTime: '10:00' },
    });
    assert.deepEqual(keys(t, '2026-01-01', '2028-12-31'), ['2026-06-15', '2027-06-15', '2028-06-15']);
  });
});

describe('重复展开 · 终止条件（until / count / exdate）', () => {
  test('until 为闭区间上界', () => {
    const t = base({
      recurrence: { freq: 'daily', dtstart: '2026-01-01', until: '2026-01-03', startTime: '09:00', endTime: '10:00' },
    });
    assert.deepEqual(keys(t, '2026-01-01', '2026-01-31'), ['2026-01-01', '2026-01-02', '2026-01-03']);
  });

  test('count 从 dtstart 起算，而不是从查询区间起算', () => {
    const t = base({
      recurrence: { freq: 'daily', dtstart: '2026-01-01', count: 3, startTime: '09:00', endTime: '10:00' },
    });
    assert.deepEqual(keys(t, '2026-01-01', '2026-12-31'), ['2026-01-01', '2026-01-02', '2026-01-03']);
    // 从第 3 天开始查也必须只剩最后一天 —— 最容易写错的地方
    assert.deepEqual(keys(t, '2026-01-03', '2026-12-31'), ['2026-01-03']);
    assert.deepEqual(keys(t, '2026-01-04', '2026-12-31'), [], 'count 用尽后不应再产生实例');
  });

  test('count 与 exdate 同时存在时，被跳过的日子计入 count 名额', () => {
    const t = base({
      recurrence: {
        freq: 'daily',
        dtstart: '2026-01-01',
        count: 3,
        exdates: ['2026-01-02'],
        startTime: '09:00',
        endTime: '10:00',
      },
    });
    // 前 3 次是 1/1,1/2,1/3，其中 1/2 被跳过 → 只剩 1/1 与 1/3
    assert.deepEqual(keys(t, '2026-01-01', '2026-12-31'), ['2026-01-01', '2026-01-03']);
  });

  test('exdate 可跳过单个日期，非法日期被静默剔除', () => {
    const t = base({
      recurrence: {
        freq: 'daily',
        dtstart: '2026-01-01',
        exdates: ['2026-01-02', 'not-a-date', '2026-13-40'],
        startTime: '09:00',
        endTime: '10:00',
      },
    });
    assert.deepEqual(keys(t, '2026-01-01', '2026-01-04'), ['2026-01-01', '2026-01-03', '2026-01-04']);
    assert.deepEqual(normalizeRecurrence(t.recurrence).rule.exdates, ['2026-01-02']);
  });
});

describe('重复展开 · 时段与跨午夜', () => {
  test('跨午夜时段时长按 24h 回绕计算，并标注结束落于次日', () => {
    const t = base({
      recurrence: { freq: 'daily', dtstart: '2026-01-01', startTime: '23:00', endTime: '01:00' },
    });
    const [occ] = expandOccurrences(t, '2026-01-01', '2026-01-01');
    assert.equal(occ.durationMinutes, 120);
    assert.equal(occ.spansMidnight, true);
    assert.equal(occ.endsOnNextDay, '2026-01-02');
    assert.equal(occ.endAt.getHours(), 1);
    assert.equal(occ.endAt.getDate(), 2);
  });

  test('同日时段不标记跨午夜', () => {
    const t = base({ recurrence: { freq: 'daily', dtstart: '2026-01-01', startTime: '08:30', endTime: '17:45' } });
    const [occ] = expandOccurrences(t, '2026-01-01', '2026-01-01');
    assert.equal(occ.spansMidnight, false);
    assert.equal(occ.durationMinutes, 555);
    assert.equal(occ.startAt.getHours(), 8);
    assert.equal(occ.endAt.getMinutes(), 45);
  });

  test('起止时间相同的零时长时段被归一为全天时长，而不是 0', () => {
    const { rule } = normalizeRecurrence({
      freq: 'daily',
      dtstart: '2026-01-01',
      startTime: '09:00',
      endTime: '09:00',
    });
    const t = base({ recurrence: rule });
    const [occ] = expandOccurrences(t, '2026-01-01', '2026-01-01');
    assert.ok(occ, '零时长不应让实例整条消失');
    assert.equal(occ.durationMinutes, 1440, '零时长会让周视图网格塌陷，必须回绕成整日');
  });

  test('跨午夜时段跨越月末：1/31 23:00–01:00 结束于 2/1', () => {
    const t = base({
      recurrence: { freq: 'monthly', byMonthday: [31], dtstart: '2026-01-31', startTime: '23:00', endTime: '01:30' },
    });
    const [occ] = expandOccurrences(t, '2026-01-01', '2026-02-28');
    assert.equal(occ.dateKey, '2026-01-31');
    assert.equal(occ.endsOnNextDay, '2026-02-01');
    assert.equal(toLocalDateTime(occ.endAt), '2026-02-01T01:30');
  });
});

describe('重复展开 · 夏令时（墙钟语义）', () => {
  // 在无 DST 的时区（如 Asia/Shanghai）下这些断言毫无区分力，所以显式切到
  // America/New_York 的子进程里执行，并额外断言"偏移量确实变了"。
  const MODULE_URL = pathToFileURL(fileURLToPath(new URL('../recurrence.js', import.meta.url))).href;
  const runInTz = (script, tz) =>
    JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      }).trim(),
    );

  test('跨 DST 切换日，23:00 始终是本地 23:00，但实际经过的时长会变', () => {
    const script = `
      import { expandOccurrences } from ${JSON.stringify(MODULE_URL)};
      const t = {
        id:'t', title:'x', kind:'fixed', status:'open',
        recurrence:{ freq:'daily', dtstart:'2026-03-07', startTime:'23:00', endTime:'23:59' }
      };
      const occ = expandOccurrences(t, '2026-03-07', '2026-03-09');
      console.log(JSON.stringify(occ.map(o => ({
        key: o.key,
        startHour: o.startAt.getHours(),
        startOffset: o.startAt.getTimezoneOffset(),
        endHour: o.endAt.getHours()
      }))));
    `;
    const rows = runInTz(script, 'America/New_York');

    assert.equal(rows.length, 3);
    // 墙钟被保住了：三天都是 23:00 开始、23:59 结束
    for (const r of rows) {
      assert.equal(r.startHour, 23, `${r.key} 的墙钟时间被 DST 挪走了`);
      assert.equal(r.endHour, 23);
    }
    // 而时区偏移确实变了 —— 证明这个测试跑在有 DST 的时区里，不是空转通过
    const offsets = new Set(rows.map((r) => r.startOffset));
    assert.equal(offsets.size, 2, '该时区这一段没有发生 DST 切换，测试失去意义');
  });

  test('时段横跨春季跳变：墙钟端点不变，但真实经过的时长会缩短', () => {
    // 这条用例专门区分"日历分量推进"与"毫秒推进"两种实现：
    //   - 日历分量（正确）：2026-03-08 01:30 → 03:30，墙钟 2 小时，实际只过了 1 小时
    //   - 毫秒推进（错误）：01:30 EST + 120min = 04:30 EDT，墙钟被推后一小时
    const script = `
      import { expandOccurrences } from ${JSON.stringify(MODULE_URL)};
      const t = {
        id:'t', title:'x', kind:'fixed', status:'open',
        recurrence:{ freq:'daily', dtstart:'2026-03-08', startTime:'01:30', endTime:'03:30' }
      };
      const [o] = expandOccurrences(t, '2026-03-08', '2026-03-08');
      console.log(JSON.stringify({
        startHour: o.startAt.getHours(),
        startMin: o.startAt.getMinutes(),
        endHour: o.endAt.getHours(),
        endMin: o.endAt.getMinutes(),
        wallSpanMinutes: o.durationMinutes,
        realElapsedMinutes: Math.round((o.endAt - o.startAt) / 60000)
      }));
    `;
    const r = runInTz(script, 'America/New_York');

    assert.equal(r.startHour, 1, '起始墙钟被挪动');
    assert.equal(r.startMin, 30);
    assert.equal(r.endHour, 3, '结束墙钟被 DST 推后了 —— 说明用了毫秒推进而非日历分量');
    assert.equal(r.endMin, 30);
    assert.equal(r.wallSpanMinutes, 120, '日程表上仍应显示为 2 小时');
    assert.equal(r.realElapsedMinutes, 60, '3 月 8 日 02:00–03:00 不存在，真实只过了 1 小时');
  });

  test('春季跳变当天不存在的时刻会被运行时规整而非产生 Invalid Date', () => {
    const script = `
      import { localAt } from ${JSON.stringify(MODULE_URL)};
      const d = localAt('2026-03-08', 2*60+30);   // 美东 2026-03-08 02:30 不存在
      console.log(JSON.stringify({ valid: !Number.isNaN(d.getTime()), hour: d.getHours(), day: d.getDate() }));
    `;
    const r = runInTz(script, 'America/New_York');
    assert.equal(r.valid, true, '产生了 Invalid Date，日程会整片消失');
    assert.equal(r.hour, 3, '不存在的 02:30 应被规整为 03:30');
  });
});

describe('重复展开 · 截止型任务', () => {
  const deadlineTask = (over = {}) => ({
    id: 'd1',
    title: '交周报',
    kind: 'deadline',
    status: 'open',
    dueAt: '2026-03-10T18:30',
    ...over,
  });

  test('精确到分钟，只产生一个实例', () => {
    const occ = expandOccurrences(deadlineTask(), '2026-03-01', '2026-03-31');
    assert.equal(occ.length, 1);
    assert.equal(occ[0].key, '2026-03-10T18:30');
    assert.equal(occ[0].dateKey, '2026-03-10');
    assert.equal(occ[0].startAt.getMinutes(), 30);
    assert.equal(occ[0].startAt.getHours(), 18);
  });

  test('区间外不产生实例', () => {
    assert.equal(expandOccurrences(deadlineTask(), '2026-04-01', '2026-04-30').length, 0);
  });

  test('非法 dueAt 静默丢弃而不是抛异常污染整个视图', () => {
    assert.deepEqual(expandOccurrences(deadlineTask({ dueAt: '2026-03-10' }), '2026-03-01', '2026-03-31'), []);
    assert.deepEqual(expandOccurrences(deadlineTask({ dueAt: null }), '2026-03-01', '2026-03-31'), []);
  });

  test('已打卡的截止任务不再标记逾时', () => {
    const t = deadlineTask({ dueAt: '2000-01-01T09:00' });
    const [notDone] = expandOccurrences(t, '2000-01-01', '2000-01-01');
    assert.equal(notDone.overdue, true);

    const completions = new Map([[`d1|2000-01-01T09:00`, { id: 'd1|2000-01-01T09:00', doneAt: 1 }]]);
    const [done] = expandOccurrences(t, '2000-01-01', '2000-01-01', { completions });
    assert.equal(done.overdue, false);
    assert.equal(done.done, true);
  });
});

describe('重复展开 · 完成打卡与归档', () => {
  test('固定任务按"归属日"记录完成，重开任务不会串味', () => {
    const t = base({ recurrence: { freq: 'daily', dtstart: '2026-01-01', startTime: '09:00', endTime: '10:00' } });
    assert.equal(occurrenceCompletionId('task-1', '2026-01-02'), 'task-1|2026-01-02');

    const completions = new Map([['task-1|2026-01-02', { id: 'task-1|2026-01-02', doneAt: 5 }]]);
    const occ = expandOccurrences(t, '2026-01-01', '2026-01-03', { completions });
    assert.deepEqual(occ.map((o) => o.done), [false, true, false]);
  });

  test('跨午夜任务的完成归属仍记在开始日', () => {
    const t = base({
      recurrence: { freq: 'daily', dtstart: '2026-01-01', startTime: '23:00', endTime: '01:00' },
    });
    const completions = new Map([['task-1|2026-01-01', { doneAt: 1 }]]);
    const occ = expandOccurrences(t, '2026-01-01', '2026-01-02', { completions });
    assert.deepEqual(occ.map((o) => o.done), [true, false]);
  });

  test('已归档任务不再展开', () => {
    assert.deepEqual(expandOccurrences(base({ status: 'archived' }), '2026-01-01', '2026-12-31'), []);
  });
});

describe('重复展开 · 防御性边界', () => {
  test('区间倒置、非法区间、空任务都返回空数组而不抛错', () => {
    assert.deepEqual(expandOccurrences(base(), '2026-05-01', '2026-04-01'), []);
    assert.deepEqual(expandOccurrences(base(), 'bad', '2026-04-01'), []);
    assert.deepEqual(expandOccurrences(null, '2026-01-01', '2026-02-01'), []);
    assert.deepEqual(expandOccurrences(undefined, '2026-01-01', '2026-02-01'), []);
  });

  test('结果始终按时间升序，供时间线直接渲染', () => {
    const t = base({
      recurrence: { freq: 'weekly', byWeekday: [7, 2, 4], dtstart: '2026-01-01', startTime: '07:00', endTime: '08:00' },
    });
    const got = keys(t, '2026-01-01', '2026-02-28');
    const sorted = [...got].sort();
    assert.deepEqual(got, sorted, '顺序不对会让周视图的行渲染错位');
  });

  test('limit 生效，且超长区间不会展开成海量实例', () => {
    const t = base();
    const occ = expandOccurrences(t, '2026-01-01', '2126-12-31', { limit: 100 });
    assert.equal(occ.length, 100);
  });

  test('始终没有重复日期的实例', () => {
    const t = base({
      recurrence: { freq: 'weekly', byWeekday: [1, 1, 1], dtstart: '2026-01-05', startTime: '09:00', endTime: '10:00' },
    });
    const got = keys(t, '2026-01-05', '2026-01-31');
    assert.equal(new Set(got).size, got.length);
  });
});

describe('规则描述与校验', () => {
  // 描述文案不得依赖"今天"，否则测试会随时间漂移。统一锚定 dtstart。
  const D = '2026-01-01';

  test('描述文案覆盖各频率', () => {
    assert.equal(
      describeRecurrence({ freq: 'daily', dtstart: D, startTime: '09:00', endTime: '10:00' }),
      '每天 09:00–10:00',
    );
    assert.equal(
      describeRecurrence({ freq: 'daily', dtstart: D, interval: 2, startTime: '09:00', endTime: '10:00' }),
      '每 2 天 09:00–10:00',
    );
    assert.equal(
      describeRecurrence({ freq: 'weekly', dtstart: D, byWeekday: [1, 3], startTime: '09:00', endTime: '10:00' }),
      '每周 周一、周三 09:00–10:00',
    );
    assert.equal(
      describeRecurrence({ freq: 'monthly', dtstart: D, byMonthday: [15], startTime: '14:00', endTime: '15:30' }),
      '每月 15 日 14:00–15:30',
    );
    assert.equal(
      describeRecurrence({
        freq: 'monthly',
        dtstart: D,
        nthWeekday: { ordinal: 3, weekday: 5 },
        startTime: '09:00',
        endTime: '10:00',
      }),
      '每月第三个周五 09:00–10:00',
    );
    assert.equal(
      describeRecurrence({
        freq: 'monthly',
        dtstart: D,
        nthWeekday: { ordinal: -1, weekday: 1 },
        startTime: '09:00',
        endTime: '10:00',
      }),
      '每月最后一个周一 09:00–10:00',
    );
  });

  test('描述会带上终止条件与例外', () => {
    const text = describeRecurrence({
      freq: 'daily',
      dtstart: D,
      startTime: '09:00',
      endTime: '10:00',
      until: '2026-06-30',
      exdates: ['2026-01-05'],
    });
    assert.match(text, /至 2026-06-30/);
    assert.match(text, /跳过 1 天/);
    assert.equal(
      describeRecurrence({ freq: 'daily', dtstart: D, startTime: '09:00', endTime: '10:00', count: 5 }),
      '每天 09:00–10:00，共 5 次',
    );
  });

  test('每周七天全选时降级为"每天"', () => {
    assert.equal(
      describeRecurrence({
        freq: 'weekly',
        dtstart: D,
        byWeekday: [1, 2, 3, 4, 5, 6, 7],
        startTime: '09:00',
        endTime: '10:00',
      }),
      '每天 09:00–10:00',
    );
  });

  test('validateTask 逐条报出问题', () => {
    assert.deepEqual(validateTask(base()), []);
    assert.ok(validateTask(base({ title: '   ' })).includes('标题不能为空'));
    assert.ok(validateTask(base({ title: 'x'.repeat(201) })).some((e) => e.includes('标题过长')));
    assert.ok(validateTask(base({ kind: 'nope' })).some((e) => e.includes('未知的任务类型')));
    assert.ok(validateTask(base({ kind: 'deadline', dueAt: '2026-03-10' })).some((e) => e.includes('截止时间格式')));
    assert.deepEqual(validateTask(base({ kind: 'deadline', dueAt: '2026-03-10T18:30' })), []);
    assert.ok(validateTask(base({ notes: 'x'.repeat(5001) })).some((e) => e.includes('备注过长')));
    assert.ok(validateTask(base({ tags: new Array(21).fill('a') })).some((e) => e.includes('标签数量过多')));
    assert.deepEqual(validateTask(null), ['任务不能为空']);
  });

  test('normalizeRecurrence 把脏输入修好而不是抛错（表单中间态可安全调用）', () => {
    const { rule, issues } = normalizeRecurrence({
      freq: 'wtf',
      interval: 0,
      byWeekday: [1, 1, 99],
      startTime: '8:5',
      endTime: 'garbage',
      dtstart: 'nope',
      until: '1999-01-01',
      count: -3,
    });
    assert.equal(rule.freq, 'weekly');
    assert.equal(rule.interval, 1);
    assert.deepEqual(rule.byWeekday, [1]);
    assert.equal(rule.startTime, '09:00');
    assert.equal(rule.endTime, '10:00');
    assert.ok(parseDateKey(rule.dtstart), 'dtstart 必须被兜底成合法日期');
    assert.equal(rule.until, null);
    assert.equal(rule.count, null);
    assert.ok(issues.length >= 2);
  });

  test('interval 有上界，防止 UI 造出天文数字', () => {
    assert.equal(normalizeRecurrence({ freq: 'daily', interval: 100000 }).rule.interval, 99);
    assert.equal(normalizeRecurrence({ freq: 'daily', interval: 2.7 }).rule.interval, 2, '小数应向下取整');
  });
});

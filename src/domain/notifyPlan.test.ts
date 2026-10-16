import { describe, it, expect } from 'vitest';
import {
  buildNotificationPlan,
  formatLine,
  notifyRange,
  NOTIFY_TAG,
  NOTIFY_TITLE_MAX,
  type NotifyOccurrence,
  type NotifySource,
} from './notifyPlan';

/** 2026-10-15 是周四。所有断言都用这一天的绝对时刻，不受测试运行时间影响。 */
const NOW = new Date(2026, 9, 15, 15, 0).getTime();

function occ(
  title: string,
  hhmm: string,
  opts: { done?: boolean; allDay?: boolean; date?: [number, number, number] } = {},
): NotifyOccurrence {
  const [y, m, d] = opts.date ?? [2026, 9, 15];
  const [h, min] = opts.allDay ? [0, 0] : hhmm.split(':').map(Number);
  const startAt = new Date(y, m - 1, d, h, min);
  return { title, startAt, endAt: startAt, done: opts.done === true, allDay: opts.allDay === true };
}

function source(overdue: NotifyOccurrence[] = [], today: NotifyOccurrence[] = []): NotifySource {
  return { overdue, today };
}

describe('buildNotificationPlan', () => {
  it('没有逾期也没有今日事项时应当是 inactive，且不带任何文案', () => {
    const plan = buildNotificationPlan(source(), NOW, 8);
    expect(plan).toEqual({
      key: NOTIFY_TAG,
      active: false,
      title: '',
      body: '',
      more: 0,
      count: 0,
      stamp: NOW,
    });
  });

  it('今日全清也应当是 inactive —— 这正是"做完最后一项就撤掉通知"的依据', () => {
    const plan = buildNotificationPlan(source([], [occ('写周报', '09:00', { done: true })]), NOW, 8);
    expect(plan.active).toBe(false);
    expect(plan.count).toBe(0);
  });

  it('只有逾期时标题只报逾期数', () => {
    const plan = buildNotificationPlan(
      source([occ('交报销', '09:00', { date: [2026, 9, 14] })]),
      NOW,
      8,
    );
    expect(plan.title).toBe('1 项逾期');
    expect(plan.count).toBe(1);
  });

  it('只有今日时标题报剩余数', () => {
    const plan = buildNotificationPlan(source([], [occ('写周报', '20:00'), occ('晨会', '09:00')]), NOW, 8);
    expect(plan.title).toBe('今日还剩 2 项');
  });

  it('两者都有时两段都报', () => {
    const plan = buildNotificationPlan(
      source([occ('交报销', '09:00', { date: [2026, 9, 14] })]),
      NOW,
      8,
    );
    expect(plan.title).toBe('1 项逾期');

    const both = buildNotificationPlan(
      source([occ('交报销', '09:00', { date: [2026, 9, 14] })], [occ('写周报', '20:00')]),
      NOW,
      8,
    );
    expect(both.title).toBe('1 项逾期 · 今日还剩 1 项');
  });

  it('逾期排在今日之前，组内按时间升序', () => {
    const plan = buildNotificationPlan(
      source(
        [occ('逾期晚的', '18:00', { date: [2026, 9, 14] }), occ('逾期早的', '08:00', { date: [2026, 9, 14] })],
        [occ('下午的', '16:00'), occ('还没到的晚上', '21:00'), occ('进行中的', '10:00')],
      ),
      NOW,
      8,
    );
    expect(plan.body.split('\n')).toEqual([
      '08:00  逾期早的',
      '18:00  逾期晚的',
      '10:00  进行中的',
      '16:00  下午的',
      '21:00  还没到的晚上',
    ]);
  });

  it('今天的未来事项也算在内 —— "哪怕还没到"', () => {
    const plan = buildNotificationPlan(source([], [occ('深夜的', '23:30')]), NOW, 8);
    expect(plan.active).toBe(true);
    expect(plan.count).toBe(1);
  });

  it('已完成的今日事项不计入，也不出现在正文里', () => {
    const plan = buildNotificationPlan(
      source([], [occ('做完的', '09:00', { done: true }), occ('没做的', '10:00')]),
      NOW,
      8,
    );
    expect(plan.count).toBe(1);
    expect(plan.body).toBe('10:00  没做的');
  });

  it('kind 区分逾期 / 进行中 / 还没到', () => {
    const overdueOcc = occ('逾期的', '09:00', { date: [2026, 9, 14] });
    const nowOcc = occ('进行中', '10:00');
    const laterOcc = occ('还没到', '22:00');
    const plan = buildNotificationPlan(source([overdueOcc], [nowOcc, laterOcc]), NOW, 8);
    expect(plan.body.split('\n')).toEqual([
      '09:00  逾期的',
      '10:00  进行中',
      '22:00  还没到',
    ]);
  });

  it('全天事项没有可读时刻，只显示标题', () => {
    const plan = buildNotificationPlan(source([], [occ('全天的事', '00:00', { allDay: true })]), NOW, 8);
    expect(plan.body).toBe('全天的事');
  });

  it('明确选了 00:00 的截止任务仍然显示 00:00（allDay=false）', () => {
    const plan = buildNotificationPlan(source([], [occ('零点交付', '00:00', { allDay: false })]), NOW, 8);
    expect(plan.body).toBe('00:00  零点交付');
  });

  it('同一时刻的两项按标题稳定排序', () => {
    const plan = buildNotificationPlan(source([], [occ('B 项', '10:00'), occ('A 项', '10:00')]), NOW, 8);
    expect(plan.body.split('\n')).toEqual(['10:00  A 项', '10:00  B 项']);
  });

  it('超过行数上限时保留最紧急的，其余归并成一行提示', () => {
    const overdue = [occ('逾期一', '01:00', { date: [2026, 9, 13] }), occ('逾期二', '02:00', { date: [2026, 9, 13] })];
    const today = [occ('今日一', '01:00'), occ('今日二', '02:00'), occ('今日三', '23:00')];
    const plan = buildNotificationPlan(source(overdue, today), NOW, 3);

    expect(plan.count).toBe(5);
    expect(plan.more).toBe(2);
    // 5 项里最紧急的是两条逾期和三条已开始的今日项，保留前 3 条
    expect(plan.body.split('\n')).toEqual([
      '01:00  逾期一',
      '02:00  逾期二',
      '01:00  今日一',
      '…还有 2 项',
    ]);
    expect(plan.title).toBe('2 项逾期 · 今日还剩 3 项');
  });

  it('正好等于上限时不出现"还有"', () => {
    const plan = buildNotificationPlan(source([], [occ('一', '01:00'), occ('二', '02:00')]), NOW, 2);
    expect(plan.more).toBe(0);
    expect(plan.body.split('\n')).toHaveLength(2);
  });

  it('超长标题被截断，且总长不超过上限', () => {
    const long = '非常长的任务标题'.repeat(10);
    const plan = buildNotificationPlan(source([], [occ(long, '10:00')]), NOW, 8);
    const line = plan.body.split('\n')[0];
    expect(line.endsWith('…')).toBe(true);
    expect(line).toContain('…');
    expect(line.length).toBeLessThanOrEqual(NOTIFY_TITLE_MAX + '10:00  '.length);
  });

  it('标题为空白时不会在正文里留下一段空隙', () => {
    const plan = buildNotificationPlan(source([], [occ('   ', '10:00')]), NOW, 8);
    expect(plan.body).toBe('10:00');
  });

  it('标题字段缺失（老数据）也不会渲染出 undefined', () => {
    const broken = { title: undefined as unknown as string, startAt: new Date(2026, 9, 15, 10, 0), endAt: new Date(2026, 9, 15, 10, 0), done: false };
    const plan = buildNotificationPlan(source([], [broken]), NOW, 8);
    expect(plan.body).toBe('10:00');
  });

  it('stamp 记录计算时刻', () => {
    expect(buildNotificationPlan(source([], [occ('一', '10:00')]), NOW, 8).stamp).toBe(NOW);
  });
});

describe('formatLine', () => {
  it('有时间就带时间，没时间就只给标题', () => {
    expect(formatLine({ title: '开会', time: '09:30', kind: 'later' })).toBe('09:30  开会');
    expect(formatLine({ title: '全天', time: null, kind: 'now' })).toBe('全天');
  });
});

describe('notifyRange', () => {
  it('回看 60 天，今天按本地日期计算', () => {
    const { today, lookback } = notifyRange(new Date(2026, 0, 3, 8, 0).getTime());
    expect(today).toBe('2026-01-03');
    expect(lookback).toBe('2025-11-04');
  });
});

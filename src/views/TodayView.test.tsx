/**
 * 「今日」时间线首屏锚定的回归测试。
 *
 * 曾经的问题：手机端进入「今日」会从数据库里最早的日程开始铺开，当天要翻很久
 * 才能翻到。两个原因各自都会导致这个结果：
 *   1. 当天没有原定日程时今日分组被整个跳过 —— 滚动锚点根本不存在；
 *   2. 定位依赖 Element.scrollIntoView，它在移动端的嵌套滚动容器里会失效
 *      （甚至抛错），首屏于是停在内容最顶上。
 *
 * 这里把「今天必须在页面上方」钉成断言：既看加载窗口（只加载今天），
 * 也看滚动容器的 scrollTop（今天被顶到顶部）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { addDays, toDateKey } from '@/domain/recurrence.js';
import { SCROLL_GAP } from '@/lib/scroll';

vi.mock('@/repo/sync', () => ({
  requestSync: vi.fn(),
  subscribeSync: vi.fn(() => () => undefined),
}));

let tasks: typeof import('@/stores/tasks');
let TodayView: typeof import('./TodayView').default;

/** 测试环境没有布局引擎：给每个元素发一个可控的"视口位置"。 */
const TODAY_TOP = 400;
let todayTops: number[] = [];

function rect(top: number): DOMRect {
  return {
    top,
    bottom: top + 60,
    left: 0,
    right: 320,
    width: 320,
    height: 60,
    x: 0,
    y: top,
    toJSON: () => undefined,
  } as DOMRect;
}

function stubLayout(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ): DOMRect {
    if (this.classList.contains('shell__main')) return rect(0);
    // 视口位置 = 文档位置 - 当前滚动量，让 scrollTop 的读写自洽
    const scrolled = (document.querySelector('.shell__main') as HTMLElement | null)?.scrollTop ?? 0;
    // 今天的分组按队列取值：插入历史内容后它会被推下去，用来验证补偿
    if (this.classList.contains('is-today')) {
      return rect((todayTops.length > 0 ? todayTops.shift()! : TODAY_TOP) - scrolled);
    }
    return rect(0);
  });
}

function createDeadline(title: string, dueAt: string): void {
  const created = tasks.createTask({ title, kind: 'deadline', dueAt });
  expect(created).not.toBeNull();
}

function renderToday(): HTMLElement {
  render(
    <div className="shell__main" data-testid="scroller">
      <div className="shell__content">
        <TodayView />
      </div>
    </div>,
  );
  return screen.getByTestId('scroller');
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('twische.deviceId', 'devA');
  const idb = await import('@/repo/idb');
  await idb.clearAll();
  const repo = await import('@/repo/localrepo');
  await repo.initRepo();
  tasks = await import('@/stores/tasks');
  TodayView = (await import('./TodayView')).default;
  todayTops = [];
  stubLayout();
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('TodayView 首屏锚定今天', () => {
  it('当天没有原定日程、历史很多时：今天仍在场，并且只加载今天', () => {
    const today = toDateKey(new Date());
    createDeadline('很久以前的截止', `${addDays(today, -120)}T10:00`);

    const main = renderToday();

    // 今日分组必须存在 —— 它就是滚动锚点与「回到今天」的落点
    const blocks = main.querySelectorAll('.day-block');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].classList.contains('is-today')).toBe(true);
    expect(screen.getByText(/^今天 · /)).toBeTruthy();

    // 首屏只锚定今天，不能被历史推到最早的日期上
    expect(screen.getByText(/已加载 1 天/)).toBeTruthy();

    // 今天被顶到滚动容器顶部（留 14px，与 .day-block 的 scroll-margin-top 对齐）
    expect(main.scrollTop).toBe(TODAY_TOP - SCROLL_GAP);
  });

  it('当天有原定日程时：日程在今天的分组里，今天同样被顶到顶部', () => {
    const today = toDateKey(new Date());
    createDeadline('今天要交', `${today}T09:00`);

    const main = renderToday();

    expect(main.querySelectorAll('.day-block')).toHaveLength(1);
    const todayBlock = main.querySelector('.day-block.is-today')!;
    expect(todayBlock.textContent).toContain('今天要交');
    expect(main.scrollTop).toBe(TODAY_TOP - SCROLL_GAP);
  });

  it('向上加载历史后，被推下去的今天会被补偿回原位', () => {
    const today = toDateKey(new Date());
    createDeadline('很久以前的截止', `${addDays(today, -120)}T10:00`);

    const main = renderToday();
    expect(main.scrollTop).toBe(TODAY_TOP - SCROLL_GAP);

    // 插入历史前今天的视口位置是 300，插入后被推到 900（位移 600）
    todayTops = [300, 900];
    fireEvent.click(screen.getByText('加载更早'));

    const blocks = main.querySelectorAll('.day-block');
    expect(blocks).toHaveLength(2);
    // 历史在今天的上方，今天依然是最后一个分组
    expect([...blocks].map((b) => b.classList.contains('is-today'))).toEqual([false, true]);
    // 位移被完整补偿：今天没有跑走
    expect(main.scrollTop).toBe(TODAY_TOP - SCROLL_GAP + 600);
    // 已经到最早了，不再重复加载
    expect(screen.queryByText('加载更早')).toBeNull();
    expect(screen.getByText('已经到最早了')).toBeTruthy();
  });

  it('一条日程都没有时显示空态', () => {
    const main = renderToday();
    expect(screen.getByText('还没有任何日程')).toBeTruthy();
    expect(main.querySelectorAll('.day-block')).toHaveLength(0);
    expect(main.scrollTop).toBe(0);
  });

  it('逾期项仍然可以在今日打卡', () => {
    const today = toDateKey(new Date());
    createDeadline('昨天就该交', `${addDays(today, -1)}T09:00`);

    const main = renderToday();
    expect(main.querySelectorAll('.day-overdue .oi')).toHaveLength(1);

    fireEvent.click(screen.getByLabelText('标记为已完成'));
    expect(tasks.completionMap().size).toBe(1);
    // 打完卡就不再是逾期项，整个逾期区块随之收起
    expect(main.querySelector('.day-overdue')).toBeNull();
  });
});

describe('TodayView 回到今天', () => {
  afterEach(() => {
    // jsdom 没有实现 scrollTo；用完还原，避免影响其它用例
    delete (Element.prototype as unknown as Record<string, unknown>).scrollTo;
  });

  it('环境支持 scrollTo 时走平滑滚动', () => {
    const today = toDateKey(new Date());
    createDeadline('很久以前的截止', `${addDays(today, -120)}T10:00`);

    const scrollTo = vi.fn();
    (Element.prototype as unknown as Record<string, unknown>).scrollTo = scrollTo;

    const main = renderToday();
    // 首屏用的是直接赋值：挂载过程不该依赖 scrollTo
    expect(main.scrollTop).toBe(TODAY_TOP - SCROLL_GAP);
    expect(scrollTo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('回到今天'));
    expect(scrollTo).toHaveBeenCalledWith({ top: TODAY_TOP - SCROLL_GAP, behavior: 'smooth' });
  });
});

describe('TodayView 跨午夜', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('日期翻篇后重新锚定新的今天', () => {
    const today = toDateKey(new Date());
    createDeadline('很久以前的截止', `${addDays(today, -120)}T10:00`);

    const main = renderToday();
    expect(main.scrollTop).toBe(TODAY_TOP - SCROLL_GAP);

    // 用户自己滚到别处，随后时间跨过午夜
    main.scrollTop = 0;
    vi.setSystemTime(new Date(Date.now() + 24 * 3600e3));
    act(() => {
      vi.advanceTimersByTime(20_000);
    });

    // 加载窗口回到"只有新的今天"，锚点也换了新的那一条
    expect(main.querySelectorAll('.day-block')).toHaveLength(1);
    expect(main.querySelectorAll('.day-block.is-today')).toHaveLength(1);
    expect(screen.getByText(/已加载 1 天/)).toBeTruthy();
    expect(main.scrollTop).toBe(TODAY_TOP - SCROLL_GAP);
  });
});

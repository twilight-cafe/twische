/**
 * hooks 测试：useNow 的单例定时器与引用计数、useRepoRev/useSyncTick 的
 * 外部 store 订阅、usePopover 的完整浮层行为（开合/三种定位/点外关闭/Esc）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { createElement } from 'react';

// Plain 用例会 stub 掉 requestAnimationFrame，文件级还原防止泄漏到后续用例
afterEach(() => {
  vi.unstubAllGlobals();
});

// ── useNow ──
import { useNow, currentMinutes } from './useNow';
import { nowMinutes } from '@/lib/datetime';

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('返回当前分钟与今天，定时推进后更新', () => {
    const { result } = renderHook(() => useNow());
    expect(result.current.minutes).toBe(nowMinutes());
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(result.current.minutes).toBe(nowMinutes());
  });

  it('两个消费者共享一个定时器，卸载一个后另一个仍更新', () => {
    const a = renderHook(() => useNow());
    const b = renderHook(() => useNow());
    a.unmount();
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(b.result.current.minutes).toBe(nowMinutes());
    b.unmount();
    // 全部卸载后定时器已停：再推进也不应抛错
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
  });

  it('定时推进后跨午夜 → today 更新', () => {
    const { result } = renderHook(() => useNow());
    vi.setSystemTime(new Date(2026, 8, 14, 0, 0, 30)); // 次日 00:00:30
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(result.current.today).toBe('2026-09-14');
  });

  it('currentMinutes 是不参与订阅的一次性读取', () => {
    expect(currentMinutes()).toBe(nowMinutes());
  });
});

// ── useRepoRev / useSyncTick ──
import { useRepoRev, useSyncTick } from './useSyncTick';
import { upsertRecord, getRev } from '@/lib/localrepo';

const { subscribeSyncMock } = vi.hoisted(() => ({
  subscribeSyncMock: vi.fn((_cb: () => void) => () => undefined),
}));

vi.mock('@/lib/sync', () => ({ subscribeSync: subscribeSyncMock }));

describe('useRepoRev', () => {
  it('仓库写入后 rev 变化触发重渲染', async () => {
    const { result } = renderHook(() => useRepoRev());
    const before = result.current;
    await act(async () => {
      upsertRecord({ kind: 'task', data: { title: 'x' } });
    });
    expect(result.current).toBeGreaterThan(before);
    expect(result.current).toBe(getRev());
  });
});

describe('useSyncTick', () => {
  it('同步层通知一次版本号 +1', () => {
    const cbs: Array<() => void> = [];
    subscribeSyncMock.mockImplementation((cb: () => void) => {
      cbs.push(cb);
      return () => undefined;
    });
    const { result } = renderHook(() => useSyncTick());
    const v0 = result.current;
    act(() => {
      for (const cb of cbs) cb();
    });
    expect(result.current).toBe(v0 + cbs.length);
  });
});

// ── usePopover ──
import { usePopover, type PopoverOptions } from './usePopover';

function Harness(props: { options?: PopoverOptions; rect?: DOMRect }) {
  const pop = usePopover(props.options);
  const triggerRef = (el: HTMLElement | null) => {
    pop.triggerRef(el);
    if (el && props.rect) el.getBoundingClientRect = () => props.rect;
  };
  return createElement(
    'div',
    null,
    createElement(
      'button',
      { ref: triggerRef, onClick: pop.toggle, 'data-testid': 'trigger' },
      'T',
    ),
    createElement('button', { onClick: pop.close, 'data-testid': 'close' }, 'C'),
    createElement('button', { onClick: () => void pop.openPanel(), 'data-testid': 'open' }, 'O'),
    pop.open &&
      createElement(
        'div',
        { ref: pop.panelRef, style: pop.style, 'data-placement': pop.placement, 'data-testid': 'panel' },
        createElement('input', { 'data-autofocus': true }),
      ),
  );
}

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 10,
    right: 50,
    width: 40,
    height: bottom - top,
    x: 10,
    y: top,
    toJSON: () => undefined,
  } as DOMRect;
}

describe('usePopover', () => {
  beforeEach(() => {
    cleanup();
    window.innerWidth = 1200;
    window.innerHeight = 800;
  });

  it('toggle 开合；重复 open 是空操作', async () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByTestId('trigger'));
    await waitFor(() => expect(screen.getByTestId('panel')).toBeTruthy());
    // 再点触发器 → 关闭
    fireEvent.click(screen.getByTestId('trigger'));
    expect(screen.queryByTestId('panel')).toBeNull();
  });

  it('未打开时 close 是空操作', () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByTestId('close'));
    expect(screen.queryByTestId('panel')).toBeNull();
  });

  it('已打开时重复 openPanel 不会重复执行', async () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByTestId('trigger'));
    await waitFor(() => expect(screen.getByTestId('panel')).toBeTruthy());
    // openRef 已置位：再次 openPanel 直接返回，面板仍在且不报错
    fireEvent.click(screen.getByTestId('open'));
    expect(screen.getByTestId('panel')).toBeTruthy();
  });

  it('宽屏下方有空间 → below 定位', async () => {
    render(createElement(Harness, { rect: rect(100, 140) }));
    fireEvent.click(screen.getByTestId('trigger'));
    // 'below' 是初始值，必须等 style 被真正计算出来
    await waitFor(() =>
      expect(screen.getByTestId('panel').style.top).toBe('146px'), // bottom 140 + gap 6
    );
    expect(screen.getByTestId('panel').getAttribute('data-placement')).toBe('below');
  });

  it('下方放不下且上方有空间 → above 定位', async () => {
    render(createElement(Harness, { rect: rect(700, 790) }));
    fireEvent.click(screen.getByTestId('trigger'));
    await waitFor(() =>
      expect(screen.getByTestId('panel').getAttribute('data-placement')).toBe('above'),
    );
    expect(screen.getByTestId('panel').style.top).toBe('374px'); // top 700 - 320 - 6
  });

  it('窄屏 → sheet 贴底展开', async () => {
    window.innerWidth = 500;
    render(createElement(Harness));
    fireEvent.click(screen.getByTestId('trigger'));
    await waitFor(() =>
      expect(screen.getByTestId('panel').getAttribute('data-placement')).toBe('sheet'),
    );
    expect(screen.getByTestId('panel').style.left).toBe('10px');
    expect(screen.getByTestId('panel').style.right).toBe('10px');
  });

  it('点外面关闭，点面板/触发器内部不关', async () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByTestId('trigger'));
    await waitFor(() => expect(screen.getByTestId('panel')).toBeTruthy());

    const panel = screen.getByTestId('panel');
    panel.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(screen.getByTestId('panel')).toBeTruthy();

    screen.getByTestId('trigger').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(screen.getByTestId('panel')).toBeTruthy();

    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await waitFor(() => expect(screen.queryByTestId('panel')).toBeNull());
  });

  it('Escape 关闭并把焦点还给触发器', async () => {
    render(createElement(Harness));
    const trigger = screen.getByTestId('trigger') as HTMLButtonElement;
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByTestId('panel')).toBeTruthy());

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.queryByTestId('panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('非 Escape 按键不关闭', async () => {
    render(createElement(Harness));
    fireEvent.click(screen.getByTestId('trigger'));
    await waitFor(() => expect(screen.getByTestId('panel')).toBeTruthy());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(screen.getByTestId('panel')).toBeTruthy();
  });

  it('resize / scroll 触发重定位而不崩溃', async () => {
    render(createElement(Harness, { rect: rect(100, 140) }));
    fireEvent.click(screen.getByTestId('trigger'));
    await waitFor(() => expect(screen.getByTestId('panel')).toBeTruthy());

    // 拉高触发器位置后 resize：below 空间不足 → above
    screen.getByTestId('trigger').getBoundingClientRect = () => rect(700, 790);
    window.dispatchEvent(new Event('resize'));
    await waitFor(() =>
      expect(screen.getByTestId('panel').getAttribute('data-placement')).toBe('above'),
    );
    window.dispatchEvent(new Event('scroll'));
  });

  it('面板没有 data-autofocus 元素时不聚焦也不报错', async () => {
    // 用可控的 rAF 队列，确定性地走完 openPanel 的两次定位与聚焦尝试
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    const Plain = () => {
      const pop = usePopover();
      const triggerRef = (el: HTMLElement | null) => pop.triggerRef(el);
      return createElement(
        'div',
        null,
        createElement('button', { ref: triggerRef, onClick: pop.toggle, 'data-testid': 'trigger' }, 'T'),
        pop.open && createElement('div', { ref: pop.panelRef, 'data-testid': 'panel' }),
      );
    };
    render(createElement(Plain));
    fireEvent.click(screen.getByTestId('trigger'));
    // flush 一轮 rAF 后用宏任务等 openPanel 的续体跑完（它会排入下一个 rAF）
    const flush = async (): Promise<void> => {
      queue.splice(0).forEach((cb) => cb(performance.now()));
      await new Promise((r) => setTimeout(r, 0));
    };
    await act(async () => {
      await flush();
      await flush();
    });
    expect(screen.getByTestId('panel')).toBeTruthy();
    expect(document.activeElement).not.toBe(screen.getByTestId('panel'));
  });

  it('面板含 data-autofocus 元素时自动聚焦（确定性 rAF）', async () => {
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    render(createElement(Harness));
    fireEvent.click(screen.getByTestId('trigger'));
    const flush = async (): Promise<void> => {
      queue.splice(0).forEach((cb) => cb(performance.now()));
      await new Promise((r) => setTimeout(r, 0));
    };
    await act(async () => {
      await flush();
      await flush();
    });
    const input = screen.getByTestId('panel').querySelector('input');
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it('打开后立即卸载：后续定位与聚焦安全跳过', async () => {
    const { unmount } = render(createElement(Harness));
    fireEvent.click(screen.getByTestId('trigger'));
    // rAF 回调触发前卸载：panelRef 已被 React 置空
    unmount();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
  });

  it('卸载组件解除全局监听（无泄漏报错）', async () => {
    const { unmount } = render(createElement(Harness));
    fireEvent.click(screen.getByTestId('trigger'));
    await waitFor(() => expect(screen.getByTestId('panel')).toBeTruthy());
    unmount();
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(new Event('resize'));
  });
});

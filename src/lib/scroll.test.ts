/**
 * 滚动定位工具测试。
 *
 * 这几个函数替代了 Element.scrollIntoView —— 首屏能不能把「今天」顶到页面上方
 * 全靠它们，因此每条分支（找不到容器、节点已卸载、位移为零、平滑滚动不支持）
 * 都必须有用例钉住。
 */
import { describe, it, expect, vi } from 'vitest';
import { SCROLL_GAP, holdAnchor, scrollHost, scrollNodeToTop, scrollTopIntoView } from './scroll';

/** 只带定位所需成员的最小节点/容器替身，避免依赖 jsdom 没有的布局。 */
function node(over: Record<string, unknown> = {}): HTMLElement {
  return {
    getBoundingClientRect: () => ({ top: 0 }),
    isConnected: true,
    closest: () => null,
    ...over,
  } as unknown as HTMLElement;
}

function host(over: Record<string, unknown> = {}): HTMLElement {
  return {
    getBoundingClientRect: () => ({ top: 0 }),
    scrollTop: 0,
    ...over,
  } as unknown as HTMLElement;
}

describe('scrollHost', () => {
  it('返回最近的 .shell__main，不在其中时返回 null', () => {
    const main = document.createElement('main');
    main.className = 'shell__main';
    const inner = document.createElement('section');
    main.append(inner);
    document.body.append(main);
    expect(scrollHost(inner)).toBe(main);
    expect(scrollHost(document.createElement('div'))).toBeNull();
    expect(scrollHost(null)).toBeNull();
    main.remove();
  });
});

describe('scrollTopIntoView', () => {
  it('节点在容器下方：当前滚动量 + 相对位移 - 留白', () => {
    const target = node({ getBoundingClientRect: () => ({ top: 300 }) });
    const container = host({ getBoundingClientRect: () => ({ top: 100 }), scrollTop: 50 });
    expect(scrollTopIntoView(target, container, SCROLL_GAP)).toBe(50 + 200 - SCROLL_GAP);
  });

  it('节点已在容器上方：夹到 0，不产生负的 scrollTop', () => {
    const target = node({ getBoundingClientRect: () => ({ top: 10 }) });
    const container = host({ getBoundingClientRect: () => ({ top: 100 }), scrollTop: 0 });
    expect(scrollTopIntoView(target, container, SCROLL_GAP)).toBe(0);
  });
});

describe('scrollNodeToTop', () => {
  it('节点为空 / 不在滚动容器内时都是空操作', () => {
    expect(() => scrollNodeToTop(null)).not.toThrow();
    const detached = node({ getBoundingClientRect: () => ({ top: 420 }) });
    expect(() => scrollNodeToTop(detached)).not.toThrow();
  });

  it('默认直接写 scrollTop（不依赖 scrollIntoView）', () => {
    const container = host({ getBoundingClientRect: () => ({ top: 0 }), scrollTop: 0 });
    const target = node({
      getBoundingClientRect: () => ({ top: 420 }),
      closest: () => container,
    });
    scrollNodeToTop(target);
    expect(container.scrollTop).toBe(420 - SCROLL_GAP);
  });

  it('behavior=smooth 且支持 scrollTo 时走原生平滑滚动', () => {
    const scrollTo = vi.fn();
    const container = host({ getBoundingClientRect: () => ({ top: 0 }), scrollTo });
    const target = node({
      getBoundingClientRect: () => ({ top: 420 }),
      closest: () => container,
    });
    scrollNodeToTop(target, 'smooth');
    expect(scrollTo).toHaveBeenCalledWith({ top: 420 - SCROLL_GAP, behavior: 'smooth' });
    expect(container.scrollTop).toBe(0);
  });

  it('behavior=smooth 但环境没有 scrollTo 时退回直接赋值', () => {
    const container = host({ getBoundingClientRect: () => ({ top: 0 }), scrollTop: 3 });
    const target = node({
      getBoundingClientRect: () => ({ top: 100 }),
      closest: () => container,
    });
    scrollNodeToTop(target, 'smooth');
    expect(container.scrollTop).toBe(3 + 100 - SCROLL_GAP);
  });
});

describe('holdAnchor', () => {
  it('锚点不在滚动容器内时不做任何补偿', () => {
    const anchor = node({ getBoundingClientRect: () => ({ top: 500 }) });
    expect(() => holdAnchor(anchor, 100)).not.toThrow();
  });

  it('锚点已从文档卸载时跳过补偿', () => {
    const container = host({ scrollTop: 10 });
    const anchor = node({
      isConnected: false,
      getBoundingClientRect: () => ({ top: 500 }),
      closest: () => container,
    });
    holdAnchor(anchor, 100);
    expect(container.scrollTop).toBe(10);
  });

  it('位移为零时不写 scrollTop', () => {
    const container = host({ scrollTop: 10 });
    const anchor = node({ getBoundingClientRect: () => ({ top: 100 }), closest: () => container });
    holdAnchor(anchor, 100);
    expect(container.scrollTop).toBe(10);
  });

  it('被 prepend 的内容推下去多少，就补回多少', () => {
    const container = host({ scrollTop: 10 });
    const anchor = node({ getBoundingClientRect: () => ({ top: 700 }), closest: () => container });
    holdAnchor(anchor, 100);
    expect(container.scrollTop).toBe(610);
  });
});

/**
 * 浮层选择器的公共行为（React 版）。
 *
 * 把位置计算、点外关闭、Esc、滚动重定位这四件事收在一处：日期与时间是同一个
 * 交互模型，各写一遍必然会漂移（一个能点外关闭、另一个不能，是最常见的那种）。
 *
 * 位置用 `position: fixed` + 触发元素的实时矩形，而不是 `absolute` 挂在父节点上：
 * 弹窗的 `.sheet-body` 是滚动容器，absolute 浮层会被裁掉一截。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PopoverOptions {
  /** 面板宽度，用于贴边时夹取；实际以渲染后的宽度为准 */
  width?: number;
  /** 与触发元素之间的间距 */
  gap?: number;
  /** 小于此宽度时改为贴底展开（手机端拇指区） */
  mobileAt?: number;
}

export type PopoverPlacement = 'below' | 'above' | 'sheet';

export function usePopover(options: PopoverOptions = {}) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<Record<string, string>>({});
  const [placement, setPlacement] = useState<PopoverPlacement>('below');
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(false);

  const gap = options.gap ?? 6;
  const mobileAt = options.mobileAt ?? 700;

  const place = useCallback((): void => {
    const t = triggerRef.current;
    const p = panelRef.current;
    if (!t) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 手机端：贴底展开，不跟随输入框 —— 跟着输入框跑一定会被键盘和屏幕边缘夹住
    if (vw < mobileAt) {
      setPlacement('sheet');
      setStyle({
        left: '10px',
        right: '10px',
        bottom: 'calc(10px + env(safe-area-inset-bottom))',
        width: 'auto',
      });
      return;
    }

    const r = t.getBoundingClientRect();
    const pw = p?.offsetWidth || options.width || 300;
    const ph = p?.offsetHeight || 320;

    const left = Math.max(8, Math.min(r.left, vw - pw - 8));
    const below = r.bottom + gap;
    const above = r.top - ph - gap;

    if (below + ph <= vh - 8 || above < 8) {
      setPlacement('below');
      setStyle({ left: `${left}px`, top: `${Math.max(8, Math.min(below, vh - ph - 8))}px` });
    } else {
      setPlacement('above');
      setStyle({ left: `${left}px`, top: `${above}px` });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gap, mobileAt, options.width]);

  const close = useCallback((): void => {
    if (!openRef.current) return;
    openRef.current = false;
    setOpen(false);
    unbind();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onDocPointerDown(e: PointerEvent): void {
    // 防御性守卫：DOM 事件派发时 target 恒非空
    /* v8 ignore next 2 */
    const node = e.target as Node | null;
    if (!node) return;
    if (panelRef.current?.contains(node) || triggerRef.current?.contains(node)) return;
    close();
  }

  function onDocKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    // 只吃自己这一层：弹窗（Sheet）也监听 Esc，先关浮层更符合直觉
    e.stopPropagation();
    close();
    triggerRef.current?.focus({ preventScroll: true });
  }

  function bind(): void {
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeydown, true);
    window.addEventListener('resize', place);
    // capture：滚动可能发生在任意祖先容器（弹窗正文）上
    window.addEventListener('scroll', place, true);
  }

  function unbind(): void {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeydown, true);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
  }

  const openPanel = useCallback(async (): Promise<void> => {
    if (openRef.current) return;
    openRef.current = true;
    setOpen(true);
    bind();
    // 两次 rAF：等面板完成布局再量，内容换行变高时量完再校正一次
    await new Promise((r) => requestAnimationFrame(r));
    place();
    await new Promise((r) => requestAnimationFrame(r));
    place();
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place]);

  const toggle = useCallback((): void => {
    if (openRef.current) close();
    else void openPanel();
  }, [close, openPanel]);

  // 卸载时解除全局监听
  useEffect(() => unbind, []);

  const setTrigger = useCallback((el: HTMLElement | null) => {
    triggerRef.current = el;
  }, []);
  const setPanel = useCallback((el: HTMLElement | null) => {
    panelRef.current = el;
  }, []);

  return {
    open,
    triggerRef: setTrigger,
    panelRef: setPanel,
    style,
    placement,
    openPanel,
    close,
    toggle,
    place,
  };
}

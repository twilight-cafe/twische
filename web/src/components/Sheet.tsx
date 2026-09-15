/**
 * 响应式浮层容器。
 *
 * 桌面端是居中对话框，手机端是底部抽屉 —— 后者更贴合拇指操作区，
 * 也是移动端用户对"编辑表单"的固有预期。
 *
 * 这里处理了几个容易被忽略的细节：
 * - 打开时锁定 body 滚动，并补偿滚动条宽度，避免背景横向抖动
 * - Esc 关闭、点击遮罩关闭
 * - 焦点移入面板，关闭后归还给触发元素（键盘用户不会"丢失位置"）
 */
import { useEffect, useRef, type ReactNode } from 'react';
import Icon from './Icon';
import './Sheet.css';

export interface SheetProps {
  open: boolean;
  title?: string;
  subtitle?: string;
  /** 桌面端最大宽度 */
  width?: string;
  /** 点遮罩是否可关（表单填到一半时可以选择不关） */
  dismissable?: boolean;
  onClose?: () => void;
  children?: ReactNode;
  footer?: ReactNode;
}

export function Sheet({
  open,
  title = '',
  subtitle = '',
  width = '560px',
  dismissable = true,
  onClose,
  children,
  footer,
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const prevOverflowRef = useRef('');
  const prevPaddingRef = useRef('');
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const dismissableNow = dismissable;

    function lockScroll() {
      const body = document.body;
      const scrollbar = window.innerWidth - document.documentElement.clientWidth;
      prevOverflowRef.current = body.style.overflow;
      prevPaddingRef.current = body.style.paddingRight;
      body.style.overflow = 'hidden';
      // 桌面端滚动条消失会让内容右移，补一段等价内边距抵消
      if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
    }

    function unlockScroll() {
      document.body.style.overflow = prevOverflowRef.current;
      document.body.style.paddingRight = prevPaddingRef.current;
    }

    function onKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape' && dismissableNow) {
        e.stopPropagation();
        onClose?.();
      }
    }

    if (open) {
      lastFocusedRef.current = document.activeElement as HTMLElement | null;
      lockScroll();
      document.addEventListener('keydown', onKeydown, true);
      // 优先聚焦第一个可输入控件；没有就聚焦面板本身
      requestAnimationFrame(() => {
        const target =
          panelRef.current?.querySelector<HTMLElement>(
            'input:not([type=hidden]), textarea, select, [data-autofocus]',
          ) || panelRef.current;
        target?.focus({ preventScroll: true });
      });
      return () => {
        document.removeEventListener('keydown', onKeydown, true);
        unlockScroll();
        lastFocusedRef.current?.focus?.({ preventScroll: true });
        lastFocusedRef.current = null;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 卸载时若仍开着，恢复滚动
  useEffect(() => {
    return () => {
      if (openRef.current) {
        document.body.style.overflow = prevOverflowRef.current;
        document.body.style.paddingRight = prevPaddingRef.current;
      }
    };
  }, []);

  if (!open) return null;

  return (
    <div className="sheet-root" role="dialog" aria-modal="true">
      <div
        className="sheet-backdrop"
        onClick={() => {
          if (dismissable) onClose?.();
        }}
      />
      <div ref={panelRef} className="sheet-panel" tabIndex={-1} style={{ '--sheet-width': width } as React.CSSProperties}>
        {(title || subtitle) && (
          <header className="sheet-head">
            <div className="sheet-head__text">
              <h2 className="sheet-title">{title}</h2>
              {subtitle && <p className="sheet-sub">{subtitle}</p>}
            </div>
            <button
              className="sheet-close"
              type="button"
              aria-label="关闭"
              onClick={() => onClose?.()}
            >
              <Icon name="x" size={18} />
            </button>
          </header>
        )}

        <div className="sheet-body scroll">{children}</div>

        {footer && <footer className="sheet-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export default Sheet;

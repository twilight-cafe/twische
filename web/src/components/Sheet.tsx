/**
 * 响应式浮层容器。
 *
 * 桌面端是 ink-design Modal（居中对话框），手机端是 ink-design Drawer（底部抽屉）——
 * 后者更贴合拇指操作区，也是移动端用户对"编辑表单"的固有预期。
 * 滚动锁、Esc、遮罩点击、Portal 全部由设计系统接管，应用侧只负责按断点选择形态。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Drawer, Modal } from 'ink-design';
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

function useMobileSheet(): boolean {
  const [mobile, setMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 699px)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 699px)');
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  return mobile;
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
  const mobile = useMobileSheet();
  const titleNode =
    title || subtitle ? (
      <span className="sheet-title-wrap">
        <span className="sheet-title">{title}</span>
        {subtitle && <span className="sheet-sub">{subtitle}</span>}
      </span>
    ) : undefined;

  if (mobile) {
    return (
      <Drawer
        open={open}
        placement="bottom"
        title={titleNode}
        height="92vh"
        closable={dismissable}
        maskClosable={dismissable}
        keyboard={dismissable}
        onClose={onClose}
        footer={footer}
        className="sheet-drawer"
      >
        {children}
      </Drawer>
    );
  }

  return (
    <Modal
      open={open}
      title={titleNode}
      width={width}
      centered
      closable={dismissable}
      maskClosable={dismissable}
      keyboard={dismissable}
      onCancel={() => onClose?.()}
      footer={footer ? <div className="modal-footer">{footer}</div> : null}
      className="sheet-modal"
    >
      {children}
    </Modal>
  );
}

export default Sheet;

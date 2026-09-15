/**
 * 空态。
 *
 * 空态不是"没有内容"的占位，而是这个界面唯一能给出主动指引的时刻：
 * 说清为什么空、以及下一步能做什么。
 */
import type { ReactNode } from 'react';
import Icon from './Icon';
import './EmptyState.css';

export interface EmptyStateProps {
  icon?: string;
  title: string;
  hint?: string;
  /** 紧凑版：用于侧栏内的小面板 */
  compact?: boolean;
  children?: ReactNode;
}

export function EmptyState({ icon = 'inbox', title, hint = '', compact = false, children }: EmptyStateProps) {
  return (
    <div className={compact ? 'empty empty--compact' : 'empty'}>
      <span className="empty__icon">
        <Icon name={icon} size={compact ? 18 : 24} />
      </span>
      <p className="empty__title">{title}</p>
      {hint && <p className="empty__hint">{hint}</p>}
      {children && <div className="empty__action">{children}</div>}
    </div>
  );
}

export default EmptyState;

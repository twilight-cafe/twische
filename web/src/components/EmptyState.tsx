/**
 * 空态。
 *
 * 空态不是"没有内容"的占位，而是这个界面唯一能给出主动指引的时刻：
 * 说清为什么空、以及下一步能做什么。
 *
 * 结构、默认插画和 footer 全交给 ink-design Empty；本组件只负责把应用里的
 * `icon/title/hint/children` 接口映射过去。
 */
import type { ReactNode } from 'react';
import { Empty } from 'ink-design';
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
    <Empty
      className={compact ? 'empty-state empty-state--compact' : 'empty-state'}
      image={
        <span className="empty-state__icon">
          <Icon name={icon} size={compact ? 18 : 24} />
        </span>
      }
      description={
        <>
          <p className="empty-state__title">{title}</p>
          {hint && <p className="empty-state__hint">{hint}</p>}
        </>
      }
      footer={children ? <div className="empty-state__action">{children}</div> : undefined}
    />
  );
}

export default EmptyState;

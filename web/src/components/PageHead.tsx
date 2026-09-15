/**
 * 页面标题区。
 *
 * 六个视图的头部结构完全一致，抽出来是为了保证"标题字重、副标题灰度、
 * 操作区落位"在任何一页都相同 —— 手写六遍迟早会漂移出一两像素的差别。
 */
import type { ReactNode } from 'react';
import './PageHead.css';

export interface PageHeadProps {
  title: string;
  subtitle?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}

export function PageHead({ title, subtitle, meta, actions }: PageHeadProps) {
  return (
    <header className="ph">
      <div className="ph__main">
        <h1 className="ph__title">{title}</h1>
        {subtitle && <p className="ph__sub tnum">{subtitle}</p>}
        {meta}
      </div>
      {actions && <div className="ph__actions">{actions}</div>}
    </header>
  );
}

export default PageHead;

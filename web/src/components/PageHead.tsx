/**
 * 页面标题区。
 *
 * 六个视图的头部结构完全一致，抽出来是为了保证"标题字重、副标题灰度、
 * 操作区落位"在任何一页都相同 —— 手写六遍迟早会漂移出一两像素的差别。
 *
 * 标题与副标题使用 ink-design Typography，避免再手写 h1/p/字号。
 */
import type { ReactNode } from 'react';
import { Text, Title } from 'ink-design';
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
        <Title level={1} className="ph__title">
          {title}
        </Title>
        {subtitle && (
          <Text type="secondary" className="ph__sub tnum">
            {subtitle}
          </Text>
        )}
        {meta}
      </div>
      {actions && <div className="ph__actions">{actions}</div>}
    </header>
  );
}

export default PageHead;

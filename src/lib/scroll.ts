/**
 * 滚动定位工具。
 *
 * 刻意不用 Element.scrollIntoView：它的语义是"滚动所有祖先容器"，在移动端
 * （iOS Safari、部分 Android WebView）的嵌套滚动容器里经常定位到错误的祖先，
 * 甚至完全不生效 —— 表现就是首屏纹丝不动地停在内容最顶上。这里统一算出
 * 目标节点相对滚动容器的偏移，直接写 scrollTop，各端行为一致，也能在 jsdom 里断言。
 */

/** 目标节点顶到容器顶部后预留的留白，与 `.day-block` 的 scroll-margin-top 对齐。 */
export const SCROLL_GAP = 14;

/** 最近的滚动容器。本应用只有一个滚动区 `.shell__main`。 */
export function scrollHost(node: HTMLElement | null): HTMLElement | null {
  return node ? (node.closest('.shell__main') as HTMLElement | null) : null;
}

/** 把 node 顶到 host 顶部（减去 gap 留白）所需的 scrollTop；负数夹到 0。 */
export function scrollTopIntoView(node: HTMLElement, host: HTMLElement, gap: number): number {
  const delta = node.getBoundingClientRect().top - host.getBoundingClientRect().top;
  return Math.max(0, host.scrollTop + delta - gap);
}

/** 把 node 顶到滚动容器顶部。behavior='smooth' 且环境支持时走原生平滑滚动。 */
export function scrollNodeToTop(node: HTMLElement | null, behavior: ScrollBehavior = 'auto'): void {
  const host = scrollHost(node);
  if (!node || !host) return;
  const top = scrollTopIntoView(node, host, SCROLL_GAP);
  if (behavior === 'smooth' && typeof host.scrollTo === 'function') {
    host.scrollTo({ top, behavior });
    return;
  }
  host.scrollTop = top;
}

/**
 * 向滚动容器上方 prepend 内容后，按节点自身在视口中的位移补偿滚动位置。
 *
 * 只认锚点节点的位移：同一次渲染里 future 也可能追加内容，按总高度补偿会滚过头。
 */
export function holdAnchor(node: HTMLElement, previousTop: number): void {
  const host = scrollHost(node);
  if (!host || !node.isConnected) return;
  const delta = node.getBoundingClientRect().top - previousTop;
  if (delta !== 0) host.scrollTop += delta;
}

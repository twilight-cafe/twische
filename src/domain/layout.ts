/**
 * 时间网格的列布局。
 *
 * 周视图里两个日程完全可能重叠（09:00–10:00 与 09:30–10:30）。如果每个都按
 * 整列宽度绘制，后画的会把先画的盖住 —— 用户看不到的那一条，在他眼里就是不存在的。
 *
 * 做法是把"时间上互相连通的块"划成一组，组内贪心分列，每列占 1/n 宽度。
 * 关键是分组要传递：A 与 B 重叠、B 与 C 重叠、但 A 与 C 不重叠时，三者仍须同组，
 * 否则 A 会占满整宽压住 C。
 */

export interface Block {
  /** 起始分钟（当天 00:00 起算，可 >1440 表示跨夜） */
  start: number;
  /** 结束分钟，必须 > start */
  end: number;
  /** 关联的任意业务数据 */
  data?: unknown;
}

export interface Placed<T> {
  item: T;
  /** 0 起算的列序号 */
  col: number;
  /** 该组总列数 */
  cols: number;
}

/**
 * @param items 任意块列表；不会修改入参
 * @returns 每块的列位置；同一组内 cols 相同，便于统一算宽度
 */
export function layoutBlocks<T extends Block>(items: T[]): Array<Placed<T>> {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Array<Placed<T>> = [];

  let group: T[] = [];
  let groupEnd = -Infinity;

  const flush = () => {
    if (group.length === 0) return;

    // 组内贪心分列：每列记录它当前的结束时刻
    const colEnds: number[] = [];
    const assigned = new Map<T, number>();

    for (const it of group) {
      let placed = -1;
      for (let i = 0; i < colEnds.length; i++) {
        // 允许首尾相接（09:00–10:00 与 10:00–11:00 共用一列）
        if (colEnds[i] <= it.start) {
          placed = i;
          break;
        }
      }
      if (placed === -1) {
        placed = colEnds.length;
        colEnds.push(it.end);
      } else {
        colEnds[placed] = it.end;
      }
      assigned.set(it, placed);
    }

    const cols = colEnds.length;
    for (const it of group) {
      out.push({ item: it, col: assigned.get(it)!, cols });
    }

    group = [];
    groupEnd = -Infinity;
  };

  for (const it of sorted) {
    // 与当前组已覆盖的区间不连通 → 结算上一组
    if (group.length > 0 && it.start >= groupEnd) flush();
    group.push(it);
    groupEnd = Math.max(groupEnd, it.end);
  }
  flush();

  return out;
}

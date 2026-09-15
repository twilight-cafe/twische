import { describe, it, expect } from 'vitest';
import { layoutBlocks, type Block } from './layout';

describe('layoutBlocks', () => {
  it('空输入返回空数组', () => {
    expect(layoutBlocks([])).toEqual([]);
  });

  it('单个块独占一列', () => {
    const out = layoutBlocks([{ start: 0, end: 30 }]);
    expect(out).toEqual([{ item: { start: 0, end: 30 }, col: 0, cols: 1 }]);
  });

  it('首尾相接的块共用一列（10:00 结束与 10:00 开始不冲突）', () => {
    const a = { start: 0, end: 60 };
    const b = { start: 60, end: 120 };
    const out = layoutBlocks([b, a]);
    expect(out.map((p) => p.col)).toEqual([0, 0]);
    expect(out.every((p) => p.cols === 1)).toBe(true);
  });

  it('重叠块分列', () => {
    const a = { start: 540, end: 600 };
    const b = { start: 570, end: 630 };
    const out = layoutBlocks([a, b]);
    expect(out.map((p) => p.col).sort()).toEqual([0, 1]);
    expect(out.every((p) => p.cols === 2)).toBe(true);
  });

  it('分组具传递性：A-B 重叠、B-C 重叠但 A-C 不重叠时三者同组', () => {
    const a = { start: 0, end: 10 };
    const b = { start: 5, end: 15 };
    const c = { start: 12, end: 20 };
    const out = layoutBlocks([a, b, c]);
    // 同组 → cols 一致（3 块 2 列：a=0, b=1, c=0）
    expect(out.map((p) => p.col)).toEqual([0, 1, 0]);
    expect(out.every((p) => p.cols === 2)).toBe(true);
  });

  it('不连通的块分成两组，各自独立计列', () => {
    const out = layoutBlocks([
      { start: 100, end: 200 },
      { start: 0, end: 50 },
    ]);
    expect(out.find((p) => p.item.start === 0)!.cols).toBe(1);
    expect(out.find((p) => p.item.start === 100)!.cols).toBe(1);
  });

  it('排序比较器：起始时刻相同按结束时刻排序', () => {
    const out = layoutBlocks([
      { start: 10, end: 40 },
      { start: 10, end: 20 },
    ]);
    // 结束早的先处理，占第 0 列
    expect(out.map((p) => p.item.end)).toEqual([20, 40]);
    expect(out.every((p) => p.cols === 2)).toBe(true);
  });

  it('列复用：三块两两错开时间可共用两列以内', () => {
    const items: Block[] = [
      { start: 0, end: 30 },
      { start: 10, end: 40 },
      { start: 30, end: 60 }, // 与第一块首尾相接，复用其列
    ];
    const out = layoutBlocks(items);
    expect(out.map((p) => p.col)).toEqual([0, 1, 0]);
    expect(out.every((p) => p.cols === 2)).toBe(true);
  });

  it('同起点时按结束时间排序；不修改入参顺序', () => {
    const items = [
      { start: 10, end: 20 },
      { start: 0, end: 15 },
    ];
    const snapshot = [...items];
    layoutBlocks(items);
    expect(items).toEqual(snapshot);
  });

  it('保留 data 字段', () => {
    const out = layoutBlocks([{ start: 0, end: 1, data: 'x' }]);
    expect(out[0].item.data).toBe('x');
  });
});

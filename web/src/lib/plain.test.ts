import { describe, it, expect } from 'vitest';
import { toPlain } from './plain';

describe('toPlain', () => {
  it('undefined / null 原样返回', () => {
    expect(toPlain(undefined)).toBeUndefined();
    expect(toPlain(null)).toBeNull();
  });

  it('原始类型原样返回', () => {
    expect(toPlain(42)).toBe(42);
    expect(toPlain('x')).toBe('x');
    expect(toPlain(true)).toBe(true);
  });

  it('对象深拷贝并断开引用', () => {
    const src = { a: 1, nested: { b: [1, 2, 3] } };
    const out = toPlain(src);
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
    expect(out.nested).not.toBe(src.nested);
    out.nested.b.push(4);
    expect(src.nested.b).toEqual([1, 2, 3]);
  });

  it('数组也走深拷贝', () => {
    const src = [{ id: 1 }];
    const out = toPlain(src);
    expect(out).toEqual([{ id: 1 }]);
    expect(out[0]).not.toBe(src[0]);
  });

  it('Proxy 包裹的对象（模拟响应式代理）也能展开为普通对象', () => {
    const target = { a: 1 };
    const proxy = new Proxy(target, {});
    const out = toPlain(proxy);
    expect(out).toEqual({ a: 1 });
    // 结构化克隆检查：普通对象才可克隆
    expect(() => structuredClone(out)).not.toThrow();
    expect(() => structuredClone(proxy)).toThrow();
  });
});

import { describe, test, expect } from 'vitest';
import { vcNormalize, vcResolveConflict } from './vector.js';

/** 补齐 v1 用例没覆盖到的防御分支。 */
describe('向量时钟的防御分支', () => {
  test('vcNormalize 丢弃非法分量与空键名', () => {
    expect(vcNormalize({ '': 3, devA: 2 })).toEqual({ devA: 2 });
    // 分量必须是 >=1 的安全整数：0、负数、小数一律剔除
    expect(vcNormalize({ devA: 0, devB: -1, devC: 1.9, devD: 2 })).toEqual({ devD: 2 });
    expect(vcNormalize(null)).toEqual({});
    expect(vcNormalize('nope')).toEqual({});
  });

  test('冲突裁决在缺少 updatedAt / vc 时按 0 处理，且结果稳定', () => {
    expect(vcResolveConflict({}, {})).toBe('local');
    expect(vcResolveConflict({ updatedAt: 5 }, {})).toBe('local');
    expect(vcResolveConflict({}, { updatedAt: 5 })).toBe('remote');
    // 时间相同则比时钟指纹，两端算出的赢家必须一致
    const a = { updatedAt: 100, vc: { devA: 1 } };
    const b = { updatedAt: 100, vc: { devB: 1 } };
    expect(vcResolveConflict(a, b)).toBe(vcResolveConflict(a, b));
  });
});

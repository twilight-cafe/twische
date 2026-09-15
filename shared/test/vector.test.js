import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  vcIncrement,
  vcMerge,
  vcMergeAll,
  vcCompare,
  vcDominates,
  vcIsSubset,
  vcNormalize,
  vcFingerprint,
  vcSum,
  vcDevices,
  vcResolveConflict,
  vcGet,
  isValidVcCounter,
  MAX_VC_COUNTER,
} from '../vector.js';

/**
 * 分量上界：一旦某个分量超过 IEEE-754 的整数精度上限（2^53），
 * `vcGet(...) + 1` 会因舍入而不再增长（1e19 + 1 === 1e19），
 * 此后这条记录的每次修改都会被归一化回同一个时钟、判为 equal 而静默丢弃 ——
 * 用户看到"已同步"，数据却没了。服务端同样拒绝这类输入，这里是第二道防线。
 */
describe('向量时钟 · 分量上界', () => {
  test('上界必须低于 JS 安全整数上限，否则 +1 会失效', () => {
    assert.ok(
      MAX_VC_COUNTER <= Number.MAX_SAFE_INTEGER,
      `MAX_VC_COUNTER(${MAX_VC_COUNTER}) 必须 <= 2^53-1`,
    );
    assert.ok(MAX_VC_COUNTER > 0);
  });

  test('越界分量会被剔除，绝不会进入时钟', () => {
    for (const bad of [1e19, 1e300, Number.MAX_VALUE, Infinity]) {
      assert.deepEqual(vcNormalize({ A: bad }), {}, `分量 ${bad} 应被剔除`);
      assert.equal(vcGet({ A: bad }, 'A'), 0, `vcGet 对 ${bad} 应回落到 0`);
    }
  });

  test('上界本身可用，上界 +1 被拒（边界条件）', () => {
    assert.equal(isValidVcCounter(MAX_VC_COUNTER), true);
    assert.equal(isValidVcCounter(MAX_VC_COUNTER + 1), false);
    assert.deepEqual(vcNormalize({ A: MAX_VC_COUNTER }), { A: MAX_VC_COUNTER });
    assert.deepEqual(vcNormalize({ A: MAX_VC_COUNTER + 1 }), {});
  });

  test('被污染的历史时钟不能让本设备计数器卡死（这是本次修复的核心）', () => {
    // 模拟修复前会落库的污染值
    const poisoned = { A: 1e19 };
    // 归一化把它清掉，于是本地推进从 0 开始 —— 而不是停在 1e19 不动
    const next = vcIncrement(poisoned, 'A');
    assert.deepEqual(next, { A: 1 });
    assert.notEqual(next.A, poisoned.A, '计数器必须还能增长');
  });

  test('长时间推进后 +1 依然精确（上界之内不会出现舍入）', () => {
    let vc = {};
    for (let i = 0; i < 1000; i++) vc = vcIncrement(vc, 'A');
    assert.equal(vc.A, 1000);
    // 直接从上界附近推进，+1 必须精确
    const nearMax = { A: MAX_VC_COUNTER - 1 };
    assert.equal(vcIncrement(nearMax, 'A').A, MAX_VC_COUNTER);
    // 到达上界后夹住，不会溢出到不安全整数
    assert.equal(vcIncrement({ A: MAX_VC_COUNTER }, 'A').A, MAX_VC_COUNTER);
  });
  test('越界分量不影响其它合法分量', () => {
    assert.deepEqual(vcNormalize({ A: 1e19, B: 3 }), { B: 3 });
  });
});

describe('向量时钟 · 基元', () => {
  test('缺失分量视为 0，且 0 值在归一化时被剔除', () => {
    assert.equal(vcGet({ A: 3 }, 'B'), 0);
    assert.equal(vcGet(null, 'A'), 0);
    assert.deepEqual(vcNormalize({ A: 1, B: 0, C: -2, D: NaN }), { A: 1 });
  });

  test('increment 只推进本设备分量，且不篡改入参（不可变性）', () => {
    const base = { A: 2, B: 1 };
    const next = vcIncrement(base, 'A');
    assert.deepEqual(next, { A: 3, B: 1 });
    assert.deepEqual(base, { A: 2, B: 1 }, '原对象被就地修改了 —— 会造成难以追踪的别名 bug');
  });

  test('merge 逐设备取 max，且可交换', () => {
    const a = { A: 5, B: 1 };
    const b = { A: 2, B: 7, C: 4 };
    assert.deepEqual(vcMerge(a, b), { A: 5, B: 7, C: 4 });
    assert.deepEqual(vcMerge(b, a), vcMerge(a, b));
  });

  test('mergeAll 归并空集与 null 不炸', () => {
    assert.deepEqual(vcMergeAll([]), {});
    assert.deepEqual(vcMergeAll(null), {});
    assert.deepEqual(vcMergeAll([{ A: 1 }, null, undefined, { B: 2 }]), { A: 1, B: 2 });
  });

  test('fingerprint 与 devices 与键插入顺序无关', () => {
    assert.equal(vcFingerprint({ B: 2, A: 1 }), vcFingerprint({ A: 1, B: 2 }));
    assert.deepEqual(vcDevices({ C: 1, A: 2 }), ['A', 'C']);
    assert.equal(vcSum({ A: 3, B: 4 }), 7);
  });
});

describe('向量时钟 · 偏序判定', () => {
  test('完全一致（含全空）判为 equal', () => {
    assert.equal(vcCompare({ A: 1 }, { A: 1 }), 'equal');
    assert.equal(vcCompare({}, {}), 'equal');
    assert.equal(vcCompare(null, undefined), 'equal');
  });

  test('单设备线性推进：后发生的支配先发生的', () => {
    assert.equal(vcCompare({ A: 3 }, { A: 1 }), 'dominates');
    assert.equal(vcCompare({ A: 1 }, { A: 3 }), 'dominated');
  });

  test('跨设备因果：看见过对方历史的才是新版本', () => {
    // A 在收到 B 的 1 之后又写了一笔 → A 有 {A:2,B:1}，因果上晚于 B 的 {B:1}
    assert.equal(vcCompare({ A: 2, B: 1 }, { B: 1 }), 'dominates');
    assert.equal(vcCompare({ B: 1 }, { A: 2, B: 1 }), 'dominated');
  });

  test('各自独立演进 → concurrent（真冲突，必须交给业务裁决）', () => {
    assert.equal(vcCompare({ A: 2 }, { B: 1 }), 'concurrent');
    assert.equal(vcCompare({ A: 1, B: 2 }, { A: 2, B: 1 }), 'concurrent');
  });

  test('零分量不影响等价性：{A:1,B:0} 与 {A:1} 等价', () => {
    assert.equal(vcCompare({ A: 1, B: 0 }, { A: 1 }), 'equal');
  });

  test('dominates 包含 equal 情形（⊇ 语义）', () => {
    assert.equal(vcDominates({ A: 1 }, { A: 1 }), true);
    assert.equal(vcDominates({ A: 2 }, { A: 1 }), true);
    assert.equal(vcDominates({ A: 1 }, { A: 2 }), false);
    assert.equal(vcDominates({ A: 2 }, { B: 1 }), false, '并发关系不是支配');
  });
});

describe('向量时钟 · 同步判据 vcIsSubset', () => {
  test('客户端没见过的新版本判为"不是子集"，需要拉取', () => {
    const clientVec = { A: 1 };
    assert.equal(vcIsSubset({ A: 1 }, clientVec), true, '见过的版本不该重复下发');
    assert.equal(vcIsSubset({ A: 2 }, clientVec), false, '服务端更新过，必须下发');
    assert.equal(vcIsSubset({ B: 1 }, clientVec), false, '另一台设备的写入必须下发');
  });

  test('空记录时钟恒为子集（新库不产生无谓流量）', () => {
    assert.equal(vcIsSubset({}, { A: 5 }), true);
  });
});

describe('向量时钟 · 并发冲突决胜', () => {
  test('墙钟新的一方胜出', () => {
    assert.equal(
      vcResolveConflict({ vc: { A: 2 }, updatedAt: 2000 }, { vc: { B: 1 }, updatedAt: 1000 }),
      'local',
    );
    assert.equal(
      vcResolveConflict({ vc: { A: 2 }, updatedAt: 1000 }, { vc: { B: 1 }, updatedAt: 2000 }),
      'remote',
    );
  });

  test('墙钟完全相同时退化为向量指纹，且两端必须算出同一份赢家', () => {
    // 最关键的性质：若两端各自"保留自己的"，就永远收敛不了。
    // 因此不硬编码谁赢，而是断言"两边推导出的胜出数据是同一份"。
    const pairs = [
      [{ vc: { A: 2 }, updatedAt: 1000 }, { vc: { B: 1 }, updatedAt: 1000 }],
      [{ vc: { B: 1 }, updatedAt: 1000 }, { vc: { A: 2 }, updatedAt: 1000 }],
      [
        { vc: { dev1: 7, dev2: 3 }, updatedAt: 42 },
        { vc: { dev2: 4 }, updatedAt: 42 },
      ],
      [{ vc: {}, updatedAt: 9 }, { vc: { x: 1 }, updatedAt: 9 }],
    ];

    for (const [a, b] of pairs) {
      const onASide = vcResolveConflict(a, b) === 'local' ? a : b;
      const onBSide = vcResolveConflict(b, a) === 'local' ? b : a;
      assert.deepEqual(
        onASide.vc,
        onBSide.vc,
        `两端收敛到不同版本：${JSON.stringify(a.vc)} vs ${JSON.stringify(b.vc)}`,
      );
    }
  });

  test('指纹按字典序决胜（可预测，不依赖对象键顺序）', () => {
    const z = { vc: { Z: 1 }, updatedAt: 1000 };
    const a = { vc: { A: 1 }, updatedAt: 1000 };
    assert.equal(vcResolveConflict(z, a), 'local', "'Z:1' 字典序大于 'A:1'");
    assert.equal(vcResolveConflict(a, z), 'remote');
  });

  test('决胜结果与时钟键顺序无关（避免序列化差异导致不一致）', () => {
    const a = { vc: { A: 1, B: 2 }, updatedAt: 5 };
    const b = { vc: { B: 2, A: 1 }, updatedAt: 5 };
    assert.equal(vcResolveConflict(a, b), 'local', '指纹相同时应判定为无实质差异');
  });

  test('缺少 updatedAt 时按 0 处理，不产生 NaN 比较陷阱', () => {
    assert.equal(vcResolveConflict({ vc: { A: 1 } }, { vc: { B: 1 }, updatedAt: 1 }), 'remote');
  });
});

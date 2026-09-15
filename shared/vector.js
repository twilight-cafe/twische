/**
 * 向量时钟（Vector Clock）—— Twische 多端同步的版本判定内核。
 *
 * 为什么不用时间戳：多台设备的墙钟永远对不齐，`updatedAt` 只适合裁决"同一时刻的
 * 并发写"这种最后一步，不能用来判断因果关系。谁"看见过"谁的修改，只有向量时钟
 * 说得清。
 *
 * 时钟结构：{ [deviceId]: counter }，counter 是该设备本地单调递增的逻辑计数。
 * 约定：缺失的设备键等价于 0（见 `get`）。
 */

const EMPTY = Object.freeze({});

/**
 * 时钟分量的上界，必须与服务端 `SyncConfig.MaxVcCounter` 保持一致。
 *
 * 这不是"够不够用"的问题，而是正确性的必要条件：分量由各设备本地 +1 递增，
 * 一台设备要走到 N 就必须先同步 N 次，2^40 远超任何真实使用。反过来，一旦分量
 * 超过 IEEE-754 的整数精度上限 2^53，`vcGet(...) + 1` 会因为舍入而不再增长
 * （1e19 + 1 === 1e19），此后这条记录的每次修改都会被"归一化"回同一个时钟，
 * 被判为 equal / unchanged 而静默丢弃 —— 用户看到"已同步"，数据却没了。
 *
 * 服务端已拒绝超界输入，这里是第二道防线：即使时钟来自被污染的旧库或
 * 服务端版本不一致，本地也绝不接受会导致计数器卡死的值。
 */
export const MAX_VC_COUNTER = 2 ** 40;

/**
 * 一个值是否是本模块可以安全参与运算的时钟分量。
 * @param {unknown} v
 * @returns {boolean}
 */
export function isValidVcCounter(v) {
  return (
    typeof v === 'number' &&
    Number.isSafeInteger(v) &&
    v >= 1 &&
    v <= MAX_VC_COUNTER
  );
}

/**
 * 读取某设备的分量，缺失即为 0 —— 这是全模块的唯一约定，别在别处写 `|| 0`。
 * @param {Record<string, number>|null|undefined} vc
 * @param {string} deviceId
 * @returns {number}
 */
export function vcGet(vc, deviceId) {
  if (!vc) return 0;
  const v = vc[deviceId];
  return isValidVcCounter(v) ? v : 0;
}

/**
 * 归一化：剔除 0 值与非法值，保证同样的因果状态有同样的序列化结果。
 * @param {Record<string, number>|null|undefined} vc
 * @returns {Record<string, number>}
 */
export function vcNormalize(vc) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!vc || typeof vc !== 'object') return out;
  for (const [k, v] of Object.entries(vc)) {
    if (typeof k !== 'string' || k.length === 0) continue;
    if (!isValidVcCounter(v)) continue;
    out[k] = Math.floor(v);
  }
  return out;
}

/**
 * 本地发生一次修改：把我自己的分量 +1。
 *
 * 分量已在上界内（vcGet 会剔除越界值），因此 +1 之后仍精确可表示；
 * 这里再夹一次是为了防御性收口 —— 计数器一旦越过精度上限就会永久卡死，
 * 代价太大，不值得赌。
 * @param {Record<string, number>|null|undefined} vc
 * @param {string} deviceId
 * @returns {Record<string, number>}
 */
export function vcIncrement(vc, deviceId) {
  const out = vcNormalize(vc);
  out[deviceId] = Math.min(vcGet(out, deviceId) + 1, MAX_VC_COUNTER);
  return out;
}

/**
 * 归并两个时钟，逐设备取 max。用于接收远端变更后推进本地认知。
 * @param {Record<string, number>|null|undefined} a
 * @param {Record<string, number>|null|undefined} b
 * @returns {Record<string, number>}
 */
export function vcMerge(a, b) {
  const out = vcNormalize(a);
  for (const [k, v] of Object.entries(vcNormalize(b))) {
    out[k] = Math.max(vcGet(out, k), v);
  }
  return out;
}

/**
 * 归并一组时钟。
 * @param {Array<Record<string, number>>|null|undefined} list
 * @returns {Record<string, number>}
 */
export function vcMergeAll(list) {
  /** @type {Record<string, number>} */
  let out = {};
  for (const vc of list || []) out = vcMerge(out, vc);
  return out;
}

/**
 * 偏序比较 —— 同步引擎的核心判定。
 * @returns {'equal'|'dominates'|'dominated'|'concurrent'}
 *   equal      : 完全一致（含全空）—— 幂等重放
 *   dominates  : a 严格新于 b（a 看见过 b 的全部历史）
 *   dominated  : a 严格旧于 b
 *   concurrent : 双方各自独立演进过 —— 真冲突，需要业务裁决
 */
export function vcCompare(a, b) {
  const na = vcNormalize(a);
  const nb = vcNormalize(b);
  let aGreater = false;
  let bGreater = false;
  const keys = new Set([...Object.keys(na), ...Object.keys(nb)]);
  for (const k of keys) {
    const va = vcGet(na, k);
    const vb = vcGet(nb, k);
    if (va > vb) aGreater = true;
    else if (vb > va) bGreater = true;
    if (aGreater && bGreater) return 'concurrent';
  }
  if (!aGreater && !bGreater) return 'equal';
  return aGreater ? 'dominates' : 'dominated';
}

/** a 是否"不旧于" b（a ⊇ b），即 a 已包含 b 的全部因果历史。 */
export function vcDominates(a, b) {
  const rel = vcCompare(a, b);
  return rel === 'dominates' || rel === 'equal';
}

/**
 * vc 是否为 ref 的子集（vc ⊆ ref）：vc 中每个分量都不超过 ref。
 * 同步的 pull 判据 —— 只要 vc ⊄ ref，说明客户端还没见过这条记录的这版。
 */
export function vcIsSubset(vc, ref) {
  for (const [k, v] of Object.entries(vcNormalize(vc))) {
    if (v > vcGet(ref, k)) return false;
  }
  return true;
}

/** 分量总和：用于"落后多少"的粗略度量与 UI 展示。 */
export function vcSum(vc) {
  return Object.values(vcNormalize(vc)).reduce((s, v) => s + v, 0);
}

/** 参与过写入的设备列表，按 id 排序，保证确定性。 */
export function vcDevices(vc) {
  return Object.keys(vcNormalize(vc)).sort();
}

/** 稳定的字符串指纹：分量按键名排序，可用于字典序决胜与去重。 */
export function vcFingerprint(vc) {
  const n = vcNormalize(vc);
  return Object.keys(n)
    .sort()
    .map((k) => `${k}:${n[k]}`)
    .join('|');
}

/**
 * 并发冲突的确定性决胜。
 *
 * 先用墙钟（越新越优先），完全相等时退化为向量指纹字典序取大者。
 * 关键点：指纹比较保证**所有设备算出同一个赢家**，否则两端会各自保留自己的
 * 版本，永远收敛不到一起——这是 LWW 最容易翻车的地方。
 */
export function vcResolveConflict(local, remote) {
  const lt = Number(local?.updatedAt ?? 0);
  const rt = Number(remote?.updatedAt ?? 0);
  if (lt !== rt) {
    return lt > rt ? 'local' : 'remote';
  }
  const lf = vcFingerprint(local?.vc);
  const rf = vcFingerprint(remote?.vc);
  if (lf === rf) return 'local'; // 内容指纹相同，取谁都一样
  return lf > rf ? 'local' : 'remote';
}

export const EMPTY_VECTOR = EMPTY;

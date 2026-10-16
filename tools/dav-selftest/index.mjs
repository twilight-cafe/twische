#!/usr/bin/env node
/**
 * 线上 WebDAV 自检。
 *
 * 打真实的服务器，验证应用**真正依赖**的那些行为：
 * 认证、MKCOL、PUT/GET、PROPFIND + ETag、DELETE，以及浏览器端最容易卡住的 CORS。
 *
 * 复用 `src/cli/target.mjs`（零依赖的 Node 侧 WebDAV 实现），
 * 并用一个包装过的 fetch 给每个请求加上 **Origin 头** ——
 * 这正是浏览器会做、而 curl 不会做的事。少一个 CORS 头就会失败，
 * 与页面里看到的现象一致。
 *
 * 写入路径为 `<根>/twische/records/`，用 selftest- 前缀的 id，跑完即删。
 *
 * 用法：
 *   node tools/dav-selftest/index.mjs --url https://dav.example.com/ --user test --pass '...'
 *   # 可选：--origin https://localhost（默认模拟安卓壳的源）
 */
import { createTarget, pushRecords, pruneTombstones, STORE_ROOT, RECORDS_DIR } from '../../src/cli/target.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}

const BASE = arg('url', '');
const USER = arg('user', '');
const PASS = arg('pass', '');
const ORIGIN = arg('origin', 'https://localhost');

if (!BASE || !USER || !PASS) {
  console.error('用法: node tools/dav-selftest/index.mjs --url <地址> --user <用户> --pass <密码>');
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

/** 给每个请求带上 Origin，并记下响应里的 CORS 头。 */
const seen = { origins: new Set(), acao: null, expose: null, statuses: [] };
const browserishFetch = async (url, init = {}) => {
  const headers = { ...(init.headers ?? {}), Origin: ORIGIN };
  const res = await fetch(url, { ...init, headers });
  seen.statuses.push(`${init.method ?? 'GET'} ${res.status}`);
  seen.origins.add(ORIGIN);
  seen.acao ??= res.headers.get('access-control-allow-origin');
  seen.expose ??= res.headers.get('access-control-expose-headers');
  return res;
};

const target = createTarget({ url: BASE, username: USER, password: PASS, fetchImpl: browserishFetch });
const ids = ['selftest-1', 'selftest-2'];

console.log(`服务器: ${BASE}`);
console.log(`用户  : ${USER}`);
console.log(`模拟源: ${ORIGIN}`);
console.log('');

try {
  // ── 1. 建目录 ──
  await target.ensure();
  check('MKCOL 建 twische/records（或已存在）', true);

  // ── 2. 写入 ──
  const records = ids.map((id, i) => ({
    id,
    kind: 'task',
    vc: { selftest: 1 },
    updatedAt: Date.now() + i,
    deleted: false,
    data: { id, title: `自检任务 ${i + 1}`, kind: 'deadline', status: 'open', notes: '', tags: [] },
  }));

  const pushed = await pushRecords(target, records);
  check('PUT 两条记录', pushed.created === 2 && pushed.failed.length === 0,
    `created=${pushed.created} failed=${pushed.failed.length}${pushed.failed[0] ? ' ' + pushed.failed[0].reason : ''}`);

  // ── 3. 幂等重跑（迁移工具的核心保证）──
  const again = await pushRecords(target, records);
  check('重跑幂等：内容一致即跳过', again.skipped === 2 && again.created === 0,
    `skipped=${again.skipped} created=${again.created} overwritten=${again.overwritten}`);

  // ── 4. PROPFIND 列出 ──
  const listed = await target.list();
  const mine = listed.filter((f) => ids.includes(f.id));
  check('PROPFIND 列出刚写的记录', mine.length === 2, `目录共 ${listed.length} 个文件`);

  // ── 5. GET 读回 ──
  const text = await target.get(target.recordHref('selftest-1'));
  check('GET 读回内容一致',
    !!text && JSON.parse(text).data.title === '自检任务 1');

  // ── 6. CORS：浏览器真正依赖的部分 ──
  const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  const pf = await fetch(`${BASE}/${STORE_ROOT}/${RECORDS_DIR}`, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'PROPFIND',
      'Access-Control-Request-Headers': 'authorization,depth',
    },
  });
  const acao = pf.headers.get('access-control-allow-origin');
  const acam = pf.headers.get('access-control-allow-methods') ?? '';
  const acah = (pf.headers.get('access-control-allow-headers') ?? '').toLowerCase();
  const expose = (pf.headers.get('access-control-expose-headers') ?? '').toLowerCase();
  check('预检放行该源', !!acao, `status=${pf.status} ACAO=${acao ?? '(无)'}`);
  check('预检声明 PROPFIND', /PROPFIND/i.test(acam), acam || '(无)');
  check('预检放行 Authorization', acah.includes('authorization'), acah || '(无)');
  check('暴露 ETag（拿不到只是并发窗口变大）', expose.includes('etag'), expose || '(无)');

  // 实际请求里也要带 ACAO，否则响应会被浏览器丢掉
  check('实请求响应带 ACAO', seen.acao === ORIGIN, seen.acao ?? '(无)');

  // 这台服务器是否做了源白名单？
  //
  // 不设成"必须拒绝"：允许所有源是**功能上完全够用**的配置，
  // 把它判成失败会制造一个假警报。但它是安全姿态上的选择，
  // 所以如实报出来，让人知道自己用的是哪一种。
  const stranger = await fetch(`${BASE}/`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://not-a-configured-origin.test', 'Access-Control-Request-Method': 'PROPFIND' },
  });
  const strangerAcao = stranger.headers.get('access-control-allow-origin');
  if (strangerAcao) {
    console.log(
      `· 提示：服务器允许所有浏览器源（任意 Origin 都被回显为 ACAO，Vary: Origin）。\n` +
      `        功能上没问题（应用能连），但意味着任何网站都能向它发跨域请求；\n` +
      `        想收紧的话，把 WebDAV 配置里的 cors_domains 写成具体源列表即可。`,
    );
  } else {
    check('源白名单生效（未配置的源拿不到 ACAO）', true, `status=${stranger.status}`);
  }

  // ── 7. 清理 ──
  for (const id of ids) await target.remove(target.recordHref(id));
  const left = (await target.list()).filter((f) => ids.includes(f.id));
  check('DELETE 后记录消失', left.length === 0);

  const pruned = await pruneTombstones(target);
  check('墓碑清理可运行', typeof pruned.pruned === 'number', `扫描 ${pruned.scanned}，清理 ${pruned.pruned}`);
} catch (err) {
  check('执行过程无异常', false, err?.message ?? String(err));
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`请求状态序列: ${seen.statuses.join(' → ')}`);
console.log(`结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  - ' + f.name);
}
process.exit(failed.length ? 1 : 0);

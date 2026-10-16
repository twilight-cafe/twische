#!/usr/bin/env node
/**
 * 备份旧 Twische 服务器上的全部数据。
 *
 * 做三件事，缺一不可：
 *   1. 原样保存 `/api/account/export` 的响应（字节级原始备份，将来能直接喂给迁移工具）
 *   2. 再用分页同步接口独立拉一遍，交叉校验条数与内容
 *   3. 输出摘要（记录数、墓碑数、各类记录分布、向量时钟分量）
 *
 * 第 2 步不是多余的：导出接口是"一次性返回全量"，一旦中途被反代截断或
 * 服务端有 bug，拿到一个"看起来正常但少了几条"的 JSON 是最危险的情况 ——
 * 两条独立路径拿到一致的结果，才敢说备份是完整的。
 *
 * 用法：
 *   LEGACY_PASSWORD='...' node scripts/backup-legacy.mjs --url https://old.example.com [--out ../../backups]
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_OUT = resolve(SCRIPT_DIR, '../../backups');

function parseArgs(argv) {
  const out = { url: '', out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') out.url = argv[++i];
    else if (argv[i] === '--out') out.out = resolve(process.cwd(), argv[++i]);
    else if (argv[i] === '--help') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.url) {
  process.stdout.write(
    '用法：LEGACY_PASSWORD=\'...\' node scripts/backup-legacy.mjs --url <旧服务器地址> [--out <备份目录>]\n',
  );
  process.exit(args.help ? 0 : 2);
}
const password = process.env.LEGACY_PASSWORD;
if (!password) {
  process.stderr.write('缺少环境变量 LEGACY_PASSWORD（避免把密码写进命令行历史）\n');
  process.exit(2);
}

const base = args.url.replace(/\/+$/, '');
const CLIENT = { 'x-twische-client': 'web' };

function fail(message) {
  process.stderr.write(`备份失败：${message}\n`);
  process.exit(1);
}

// ── 1. 健康检查 ──────────────────────────────────────────────
const health = await fetch(`${base}/api/health`).then((r) => r.json());
if (!health.initialized) fail('该服务端尚未初始化');
process.stdout.write(`服务端版本 ${health.version}，已初始化\n`);

// ── 2. 登录 ─────────────────────────────────────────────────
const deviceId = `backup-${Date.now().toString(36)}`;
const loginRes = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { ...CLIENT, 'Content-Type': 'application/json' },
  body: JSON.stringify({ password, deviceId, deviceName: '备份工具' }),
});
if (!loginRes.ok) {
  const body = await loginRes.text();
  fail(`登录失败（HTTP ${loginRes.status}）：${body.slice(0, 200)}`);
}
const cookie = (loginRes.headers.getSetCookie?.() ?? [loginRes.headers.get('set-cookie')])
  .filter(Boolean)
  .map((c) => c.split(';')[0])
  .join('; ');
if (!cookie) fail('登录成功但没有下发会话 cookie');

const auth = (path, init = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...CLIENT, ...(init.headers ?? {}), Cookie: cookie } });

// ── 3. 原样导出 ─────────────────────────────────────────────
process.stdout.write('拉取 /api/account/export …\n');
const exportRes = await auth('/api/account/export');
if (!exportRes.ok) fail(`导出接口返回 HTTP ${exportRes.status}`);
const rawExport = await exportRes.text();

let parsed;
try {
  parsed = JSON.parse(rawExport);
} catch {
  fail('导出接口返回的不是合法 JSON（可能被反向代理截断）');
}
if (!Array.isArray(parsed.records)) fail('导出内容里没有 records 数组');

// ── 4. 分页同步交叉校验 ─────────────────────────────────────
process.stdout.write('用分页同步接口独立拉一遍做交叉校验 …\n');
const paged = [];
let cursor = 0;
for (let round = 0; round < 1000; round++) {
  const res = await auth('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cursor, limit: 500 }),
  });
  if (!res.ok) fail(`分页同步返回 HTTP ${res.status}`);
  const body = await res.json();
  const batch = body.records ?? [];
  paged.push(...batch);
  if (batch.length > 0) cursor = body.cursor;
  if (!body.hasMore) break;
}

// ── 5. 落盘 ─────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = join(args.out, `legacy-${stamp}`);
mkdirSync(dir, { recursive: true });

const exportPath = join(dir, 'twische-export.json');
writeFileSync(exportPath, rawExport, 'utf8');
writeFileSync(
  join(dir, 'README.txt'),
  [
    `旧 Twische 服务器数据备份`,
    `服务器：${base}`,
    `时间：${new Date().toISOString()}`,
    `服务端版本：${health.version}`,
    ``,
    `twische-export.json  —— /api/account/export 的原始响应，可直接用于迁移：`,
    `  node tools/migrate/index.mjs --from-file ${exportPath} \\`,
    `    --to <WebDAV 地址> --user <用户名> --pass <密码>`,
    ``,
    `记录数：${parsed.records.length}（其中墓碑 ${parsed.records.filter((r) => r.deleted).length} 条）`,
    `交叉校验（分页同步）：${paged.length} 条`,
    ``,
    `注意：这份备份包含全部任务内容，请妥善保管（不要提交到公开仓库）。`,
  ].join('\n'),
  'utf8',
);
try {
  const { chmodSync } = await import('node:fs');
  chmodSync(exportPath, 0o600);
} catch {
  /* 某些文件系统不支持，忽略 */
}

// ── 6. 校验与摘要 ───────────────────────────────────────────
const byId = new Map(parsed.records.map((r) => [r.id, r]));
const kinds = {};
for (const r of parsed.records) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
const tombstones = parsed.records.filter((r) => r.deleted).length;
const devices = new Set();
for (const r of parsed.records) for (const d of Object.keys(r.vc ?? {})) devices.add(d);

const problems = [];
if (byId.size !== parsed.records.length) problems.push('导出内容里存在重复 id');
if (paged.length !== parsed.records.length) {
  problems.push(`两条路径条数不一致：导出 ${parsed.records.length} / 分页 ${paged.length}`);
} else {
  for (const r of paged) {
    const other = byId.get(r.id);
    if (!other) {
      problems.push(`分页里多出记录 ${r.id}`);
      break;
    }
    if (JSON.stringify(other.vc) !== JSON.stringify(r.vc)) {
      problems.push(`记录 ${r.id} 的向量时钟在两条路径下不一致`);
      break;
    }
  }
}

process.stdout.write(
  [
    '',
    `备份目录：${dir}`,
    `记录总数：${parsed.records.length}`,
    `  任务：${kinds.task ?? 0}　打卡：${kinds.completion ?? 0}　其它：${
      Object.entries(kinds).filter(([k]) => k !== 'task' && k !== 'completion').map(([k, v]) => `${k}=${v}`).join(' ') || '无'
    }`,
    `墓碑（已删除）：${tombstones}`,
    `向量时钟分量：${devices.size} 个（${[...devices].map((d) => d.slice(0, 8)).join(', ')}）`,
    `交叉校验：${problems.length === 0 ? '通过（两条路径一致）' : '失败'}`,
    ...problems.map((p) => `  ⚠ ${p}`),
    '',
  ].join('\n'),
);

// 顺手确认备份文件能读回来（别把"写成功"当成"备好了"）
const reread = JSON.parse(readFileSync(exportPath, 'utf8'));
if (reread.records.length !== parsed.records.length) fail('备份文件回读校验失败');
process.stdout.write('备份文件回读校验通过。\n');

process.exit(problems.length === 0 ? 0 : 3);

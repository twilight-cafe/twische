/**
 * 迁移编排：旧服务器 / 导出文件 → WebDAV。
 *
 * 纯逻辑 + 注入 IO，因此可被 vitest 直接测试；命令行外壳在 tools/migrate/index.mjs。
 */

import { fetchAllRecords, parseExportFile, LegacyError } from './legacy.mjs';
import { createTarget, pushRecords, pruneTombstones, TargetError } from './target.mjs';

export const USAGE = `用法：
  node tools/migrate/index.mjs --from <旧服务器地址> --password <密码> --to <WebDAV 地址> --user <用户名> --pass <密码>
  node tools/migrate/index.mjs --from-file <导出的 JSON> --to <WebDAV 地址> --user <用户名> --pass <密码>

参数：
  --from <url>            旧 Twische 服务器地址（例如 http://192.168.1.10:8787）
  --password <pw>         旧服务器的访问密码
  --from-file <path>      也可以直接从导出的 JSON 文件迁移
  --to <url>              目标 WebDAV 目录（不存在会自动创建）
  --user <name>           WebDAV 用户名
  --pass <pw>             WebDAV 密码（建议用应用专用密码）
  --on-conflict <mode>    skip（默认，保留目标已有内容）/ overwrite（用旧数据覆盖）
  --dry-run               只统计不写入
  --report <path>         把结果报告写成 JSON
  --concurrency <n>       并发写入数（默认 4）
  --prune-tombstones      只做清理：删除超过 90 天的墓碑文件
  --older-than <days>     配合 --prune-tombstones，默认 90
  --help                  显示本说明

说明：
  迁移是幂等的 —— 已经搬过去的记录会被识别为"内容一致"并跳过，中断后可以直接重跑。
  旧记录里的删除墓碑（deleted: true）同样会搬过去，否则别的设备会把它"复活"。
`;

/** 解析命令行参数。未知参数直接报错，避免拼错时静默跑成别的东西。 */
export function parseArgs(argv) {
  const known = new Set([
    '--from',
    '--password',
    '--from-file',
    '--to',
    '--user',
    '--pass',
    '--on-conflict',
    '--report',
    '--concurrency',
    '--older-than',
    '--dry-run',
    '--prune-tombstones',
    '--help',
    '-h',
  ]);
  const out = { dryRun: false, prune: false, onConflict: 'skip', concurrency: 4, olderThanDays: 90 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--prune-tombstones') {
      out.prune = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (!known.has(arg)) throw new Error(`未知参数：${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`参数 ${arg} 缺少取值`);
    switch (arg) {
      case '--from':
        out.from = value;
        break;
      case '--password':
        out.password = value;
        break;
      case '--from-file':
        out.fromFile = value;
        break;
      case '--to':
        out.to = value;
        break;
      case '--user':
        out.user = value;
        break;
      case '--pass':
        out.pass = value;
        break;
      case '--on-conflict':
        if (value !== 'skip' && value !== 'overwrite') throw new Error('--on-conflict 只能是 skip 或 overwrite');
        out.onConflict = value;
        break;
      case '--report':
        out.report = value;
        break;
      case '--concurrency':
        out.concurrency = Math.max(1, Number(value) || 1);
        break;
      case '--older-than':
        out.olderThanDays = Math.max(0, Number(value) || 0);
        break;
    }
  }
  return out;
}

/** 校验参数组合，返回可读的错误信息（null 表示没问题）。 */
export function validateOptions(opts) {
  if (opts.help) return null;
  if (!opts.to) return '缺少 --to（目标 WebDAV 地址）';
  if (!opts.user) return '缺少 --user（WebDAV 用户名）';
  if (opts.pass === undefined) return '缺少 --pass（WebDAV 密码）';
  if (opts.prune) return null;
  if (!opts.from && !opts.fromFile) return '需要 --from（旧服务器）或 --from-file（导出文件）之一';
  if (opts.from && opts.fromFile) return '--from 与 --from-file 只能给一个';
  if (opts.from && !opts.password) return '从旧服务器迁移需要 --password';
  return null;
}

/**
 * 执行迁移。
 *
 * @param {object} opts 解析后的参数
 * @param {object} deps 可注入的依赖（测试用）
 * @returns {Promise<object>} 结果报告
 */
export async function runMigration(opts, deps = {}) {
  const log = deps.log ?? (() => {});
  const readFile = deps.readFile;
  const target = createTarget({
    url: opts.to,
    username: opts.user,
    password: opts.pass,
    fetchImpl: deps.fetchImpl,
  });

  if (opts.prune) {
    log(`清理墓碑：仅删除 ${opts.olderThanDays} 天前的删除标记`);
    const result = await pruneTombstones(target, {
      olderThanMs: opts.olderThanDays * 24 * 3600 * 1000,
      dryRun: opts.dryRun,
    });
    log(`扫描 ${result.scanned} 个文件，删除 ${result.pruned} 个，保留 ${result.kept} 个`);
    return { mode: 'prune', ...result, dryRun: opts.dryRun };
  }

  let records;
  let skipped = [];
  let source;
  if (opts.fromFile) {
    const text = await readFile(opts.fromFile);
    const parsed = parseExportFile(text);
    records = parsed.records;
    skipped = parsed.skipped;
    source = { kind: 'file', path: opts.fromFile };
    log(`已读取 ${records.length} 条记录（跳过 ${skipped.length} 条）`);
  } else {
    log(`正在从 ${opts.from} 拉取数据…`);
    const fetched = await fetchAllRecords({
      baseUrl: opts.from,
      password: opts.password,
      fetchImpl: deps.fetchImpl,
      onProgress: (n) => log(`  已拉取 ${n} 条`),
    });
    records = fetched.records;
    source = { kind: 'server', url: opts.from, via: fetched.source };
    log(`共 ${records.length} 条记录（通过 ${fetched.source === 'export' ? '一次性导出' : '分页同步'}）`);
  }

  log(opts.dryRun ? '预演模式：不会写入任何内容' : `正在写入 ${opts.to} …`);
  const pushed = await pushRecords(target, records, {
    onConflict: opts.onConflict,
    dryRun: opts.dryRun,
    concurrency: opts.concurrency,
    onProgress: (s) => {
      const done = s.created + s.skipped + s.overwritten + s.kept + s.failed.length;
      // 第一条立刻反馈（否则大批量迁移时前几十秒没有任何输出），之后每 25 条报一次
      if (done === 1 || done % 25 === 0) log(`  进度 ${done}/${records.length}`);
    },
  });

  const report = {
    mode: 'migrate',
    dryRun: opts.dryRun,
    source,
    target: { url: target.base },
    onConflict: opts.onConflict,
    total: records.length,
    created: pushed.created,
    skipped: pushed.skipped,
    overwritten: pushed.overwritten,
    kept: pushed.kept,
    failed: pushed.failed,
    skippedInput: skipped,
    finishedAt: new Date().toISOString(),
  };
  log(
    `完成：新增 ${report.created} · 跳过（内容一致）${report.skipped} · 覆盖 ${report.overwritten} · ` +
      `保留目标已有 ${report.kept} · 失败 ${report.failed.length}`,
  );
  return report;
}

export { LegacyError, TargetError };

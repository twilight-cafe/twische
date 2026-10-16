#!/usr/bin/env node
/**
 * Twische 数据迁移工具。
 *
 * 把旧 Twische 服务器（或它的导出 JSON）里的记录搬到一个 WebDAV 目录，
 * 格式与新版前端完全一致，搬完就能直接用。
 *
 * 为什么是 CLI 而不是网页向导：旧服务端没有 CORS 头、会话是 HttpOnly cookie、
 * 还要求 Origin 等于 Host —— 浏览器从跨域静态页直连它在协议层面就不可能。
 * Node 不受这些限制，所以「填地址 + 密码」这条路径只能落在这里。
 *
 * 零依赖：只用 Node 内置的 fetch / fs。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, validateOptions, runMigration, USAGE } from '../../src/cli/migrate.mjs';

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const problem = validateOptions(opts);
  if (problem) {
    process.stderr.write(`参数有误：${problem}\n\n${USAGE}`);
    return 2;
  }

  const quiet = process.env.TWISCHE_MIGRATE_QUIET === '1';
  const log = (line) => {
    if (!quiet) process.stdout.write(`${line}\n`);
  };

  try {
    const report = await runMigration(opts, {
      log,
      readFile: (path) => readFile(path, 'utf8'),
    });
    if (opts.report) {
      await writeFile(opts.report, JSON.stringify(report, null, 2), 'utf8');
      log(`报告已写入 ${opts.report}`);
    }
    return report.failed.length > 0 ? 1 : 0;
  } catch (err) {
    process.stderr.write(`迁移失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`迁移异常：${err?.stack ?? err}\n`);
    process.exitCode = 1;
  },
);

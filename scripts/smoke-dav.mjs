#!/usr/bin/env node
/**
 * 端到端冒烟测试：在真实的 HTTP 上跑一遍完整迁移。
 *
 * 单元测试用的是进程内的假服务器（mock fetch），验证不到"真实 socket 上的
 * 请求头与响应到底长什么样"。这个脚本起一个真的 WebDAV 服务端与一个假的旧
 * Twische 服务端，然后**用命令行工具本身**把数据搬过去，最后逐条核对结果。
 *
 * 只用 Node 内置模块，不需要任何外部依赖或 Docker：
 *   node scripts/smoke-dav.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

// ───────────────────────── 迷你 WebDAV 服务端 ─────────────────────────
/** @type {Map<string, string>} */
const davFiles = new Map();
// /dav 是用户已经存在的目录（真实场景里 --to 指向的就是一个已存在的目录），
// twische/ 与 records/ 由工具自己创建
const davDirs = new Set(['/', '/dav']);
let etagSeq = 0;

function davServer() {
  return createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS, PROPFIND, MKCOL',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Depth, If-Match, If-None-Match',
      'Access-Control-Expose-Headers': 'ETag',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.headers.authorization !== `Basic ${Buffer.from('alice:secret').toString('base64')}`) {
      res.writeHead(401, cors);
      res.end('unauthorized');
      return;
    }

    const dirExists = (p) => davDirs.has(p) || [...davFiles.keys()].some((f) => f.startsWith(`${p}/`));
    const parent = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

    if (req.method === 'MKCOL') {
      if (dirExists(path)) {
        res.writeHead(405, cors);
        res.end();
        return;
      }
      if (!dirExists(parent(path))) {
        res.writeHead(409, cors);
        res.end();
        return;
      }
      davDirs.add(path);
      res.writeHead(201, cors);
      res.end();
      return;
    }

    if (req.method === 'PROPFIND') {
      if (!dirExists(path)) {
        res.writeHead(404, cors);
        res.end();
        return;
      }
      const entries = [{ path, dir: true }];
      if (req.headers.depth !== '0') {
        for (const f of davFiles.keys()) {
          if (f.startsWith(`${path}/`) && !f.slice(path.length + 1).includes('/')) entries.push({ path: f, dir: false });
        }
      }
      const body =
        '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' +
        entries
          .map(
            (e) =>
              `<D:response><D:href>${encodeURI(e.path)}</D:href><D:propstat><D:prop>` +
              `<D:resourcetype>${e.dir ? '<D:collection/>' : ''}</D:resourcetype>` +
              (e.dir ? '' : `<D:getetag>${davFiles.get(e.path).etag}</D:getetag>`) +
              '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>',
          )
          .join('') +
        '</D:multistatus>';
      res.writeHead(207, { ...cors, 'Content-Type': 'application/xml' });
      res.end(body);
      return;
    }

    if (req.method === 'GET') {
      const file = davFiles.get(path);
      if (!file) {
        res.writeHead(404, cors);
        res.end();
        return;
      }
      res.writeHead(200, { ...cors, ETag: file.etag, 'Content-Type': 'application/json' });
      res.end(file.body);
      return;
    }

    if (req.method === 'PUT' || req.method === 'DELETE') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (!dirExists(parent(path))) {
          res.writeHead(409, cors);
          res.end();
          return;
        }
        const existing = davFiles.get(path);
        if (req.method === 'DELETE') {
          if (!existing) {
            res.writeHead(404, cors);
            res.end();
            return;
          }
          davFiles.delete(path);
          res.writeHead(204, cors);
          res.end();
          return;
        }
        if (req.headers['if-none-match'] === '*' && existing) {
          res.writeHead(412, cors);
          res.end();
          return;
        }
        if (req.headers['if-match'] && existing?.etag !== req.headers['if-match']) {
          res.writeHead(412, cors);
          res.end();
          return;
        }
        etagSeq += 1;
        const etag = `"s${etagSeq}"`;
        davFiles.set(path, { body: raw, etag });
        res.writeHead(existing ? 204 : 201, { ...cors, ETag: etag });
        res.end();
      });
      return;
    }

    res.writeHead(405, cors);
    res.end();
  });
}

// ───────────────────────── 迷你旧版 Twische 服务端 ─────────────────────────
const legacyRecords = [
  { id: 'task-1', kind: 'task', data: { id: 'task-1', title: '晨跑' }, vc: { devOld: 2 }, updatedAt: 1700000000000, deleted: false, seq: 1 },
  { id: 'task-2', kind: 'task', data: { id: 'task-2', title: '读论文' }, vc: { devOld: 3 }, updatedAt: 1700000001000, deleted: false, seq: 2 },
  { id: 'task-1|2026-01-15', kind: 'completion', data: { taskId: 'task-1', occurrence: '2026-01-15', doneAt: 1700000002000 }, vc: { devOld: 4 }, updatedAt: 1700000002000, deleted: false, seq: 3 },
  { id: 'task-9', kind: 'task', data: {}, vc: { devOld: 5 }, updatedAt: 1700000003000, deleted: true, seq: 4 },
];

function legacyServer() {
  return createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const json = (body, status = 200, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (path === '/api/health') return json({ ok: true, initialized: true, version: '1.0.3' });
      if (path === '/api/auth/login') {
        if (req.headers['x-twische-client'] !== 'web') return json({ ok: false, code: 'bad_request' }, 400);
        if (JSON.parse(raw).password !== 'old-password') return json({ ok: false, code: 'bad_credentials' }, 401);
        return json({ ok: true }, 200, { 'Set-Cookie': 'twische_sid=smoke; Path=/' });
      }
      if (path === '/api/account/export') {
        if (!String(req.headers.cookie ?? '').includes('twische_sid')) return json({ ok: false, code: 'unauthorized' }, 401);
        return json({ format: 'twische-export', version: 1, records: legacyRecords });
      }
      json({ ok: false, code: 'not_found' }, 404);
    });
  });
}

// ───────────────────────── 跑 ─────────────────────────
const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const work = mkdtempSync(join(tmpdir(), 'twische-smoke-'));
let failures = 0;

function check(label, ok, extra = '') {
  if (ok) {
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  ✗ ${label}${extra ? ` — ${extra}` : ''}\n`);
  }
}

/**
 * 跑一次 CLI。
 *
 * 必须用异步 spawn：spawnSync 会**阻塞事件循环**，而本脚本自己就托管着
 * 被测的两个服务端 —— 子进程连上来时没人 accept，直接死锁。
 */
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'tools/migrate/index.mjs'), ...args], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const dav = davServer();
const legacy = legacyServer();
const davPort = await listen(dav);
const legacyPort = await listen(legacy);
const davUrl = `http://127.0.0.1:${davPort}/dav`;
const legacyUrl = `http://127.0.0.1:${legacyPort}`;

try {
  process.stdout.write('1) 从旧服务器直连迁移（真实 HTTP）\n');
  const reportPath = join(work, 'report.json');
  const first = await runCli([
    '--from', legacyUrl, '--password', 'old-password',
    '--to', davUrl, '--user', 'alice', '--pass', 'secret',
    '--report', reportPath,
  ]);
  check('CLI 退出码为 0', first.status === 0, first.stderr.trim());
  check('4 条记录全部写入', davFiles.size === 4, `实际 ${davFiles.size}`);

  const stored = JSON.parse(davFiles.get('/dav/twische/records/task-1.json')?.body ?? '{}');
  check('任务内容与旧服务端一致', stored.data?.title === '晨跑');
  check('向量时钟原样保留', JSON.stringify(stored.vc) === '{"devOld":2}');
  check('旧的 seq 字段不落盘', stored.seq === undefined);
  check(
    '墓碑也搬过去了（否则会被别的设备复活）',
    JSON.parse(davFiles.get('/dav/twische/records/task-9.json')?.body ?? '{}').deleted === true,
  );
  check('含竖线的打卡 id 正确落盘', davFiles.has('/dav/twische/records/task-1|2026-01-15.json'));

  const report = first.status === 0 ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  check('报告统计正确', report?.created === 4 && report.failed.length === 0, JSON.stringify(report));

  process.stdout.write('2) 重跑一遍：应当是幂等的\n');
  const second = await runCli([
    '--from', legacyUrl, '--password', 'old-password',
    '--to', davUrl, '--user', 'alice', '--pass', 'secret',
  ]);
  check('重跑退出码为 0', second.status === 0);
  check('全部识别为「内容一致」并跳过', second.stdout.includes('跳过（内容一致）4'), second.stdout.trim());
  check('没有产生重复文件', davFiles.size === 4);

  process.stdout.write('3) 预演模式不写任何东西\n');
  writeFileSync(join(work, 'export.json'), JSON.stringify({ format: 'twische-export', records: legacyRecords }));
  davFiles.clear();
  const dry = await runCli([
    '--from-file', join(work, 'export.json'),
    '--to', davUrl, '--user', 'alice', '--pass', 'secret',
    '--dry-run',
  ]);
  check('预演退出码为 0', dry.status === 0, dry.stderr.trim());
  check('确实没有写入', davFiles.size === 0, `实际 ${davFiles.size}`);

  process.stdout.write('4) 导出文件 → WebDAV\n');
  const fromFile = await runCli([
    '--from-file', join(work, 'export.json'),
    '--to', davUrl, '--user', 'alice', '--pass', 'secret',
  ]);
  check('退出码为 0', fromFile.status === 0, fromFile.stderr.trim());
  check('4 条记录写入', davFiles.size === 4);

  process.stdout.write('5) 错误路径也要说人话\n');
  const badPass = await runCli([
    '--from', legacyUrl, '--password', 'wrong',
    '--to', davUrl, '--user', 'alice', '--pass', 'secret',
  ]);
  check('密码错误时退出码非 0', badPass.status !== 0);
  check('提示是「密码不正确」而不是堆栈', badPass.stderr.includes('密码不正确'), badPass.stderr.trim());

  const badPath = await runCli([
    '--from-file', join(work, 'export.json'),
    '--to', 'http://127.0.0.1:1/nope', '--user', 'alice', '--pass', 'secret',
  ]);
  check('地址不可达时退出码非 0 且有可读信息', badPath.status !== 0 && badPath.stderr.includes('失败'));

  process.stdout.write('6) 清理墓碑\n');
  const pruned = await runCli([
    '--prune-tombstones', '--older-than', '0',
    '--to', davUrl, '--user', 'alice', '--pass', 'secret',
  ]);
  check('清理退出码为 0', pruned.status === 0, pruned.stderr.trim());
  check('墓碑被删掉', !davFiles.has('/dav/twische/records/task-9.json'));
  check('正常记录留着', davFiles.has('/dav/twische/records/task-1.json'));
} finally {
  dav.close();
  legacy.close();
  rmSync(work, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? '\n全部通过。\n' : `\n${failures} 项失败。\n`);
process.exitCode = failures === 0 ? 0 : 1;

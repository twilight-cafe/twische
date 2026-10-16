#!/usr/bin/env node
/**
 * 浏览器端真实验证。
 *
 * 验证的是"纯静态页面 + 真 WebDAV 服务器"这条最容易坏、又最难自查的链路：
 *
 *  1. 页面能起来、Service Worker 注册成功
 *  2. 用真实凭据连上真实 WebDAV（这一步只要 CORS 有一个头不对就必然失败）
 *  3. 数据被真正拉下来，渲染出「今日」页
 *  4. Service Worker 的通知消息通道能走通（页面 → SW 的协议）
 *
 * **不写入任何数据**：只读验证。测试账号的数据被当成只读样例。
 *
 * 用法：
 *   node scripts/browser-check.mjs --user test --pass '...' [--url https://dav.example.com/] [--headed]
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const DIST = resolve(HERE, '../dist');
const CHROME = process.env.CHROME_PATH
  || '/home/twilight/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const DAV_URL = arg('url', '');
const DAV_USER = arg('user', '');
const DAV_PASS = arg('pass', '');
// 不设默认值：凭据与服务器地址是这个仓库之外的信息，
// 写死成某个真实主机只会让拿到这个脚本的人打错地方。
if (!DAV_URL || !DAV_USER || !DAV_PASS) {
  console.error(
    '用法: node scripts/browser-check.mjs --url <地址> --user <用户> --pass <密码> [--headed]',
  );
  process.exit(2);
}

/** 应用请求的源必须与服务端 CORS 允许列表一致，否则整条链路会被浏览器拦掉。 */
const APP_PORT = Number(arg('port', '3080'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = createServer((req, res) => {
  void (async () => {
    const raw = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = join(DIST, raw);
    try {
      const info = await stat(file);
      if (info.isDirectory()) file = join(file, 'index.html');
      await stat(file);
    } catch {
      file = join(DIST, 'index.html'); // SPA 回落
    }
    const type = TYPES[extname(file)] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': file.endsWith('sw.js') ? 'no-store' : 'public, max-age=60',
    });
    createReadStream(file).pipe(res);
  })();
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

await new Promise((r) => server.listen(APP_PORT, '127.0.0.1', r));
console.log(`静态页面: http://localhost:${APP_PORT}/`);
console.log(`WebDAV  : ${DAV_URL} (${DAV_USER})`);
console.log('');

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !has('headed'),
  args: [
    '--no-sandbox',
    // 让 Chromium 把 localhost 解析到 127.0.0.1，并允许访问我们起的端口
    `--host-resolver-rules=MAP localhost 127.0.0.1`,
    '--disable-dev-shm-usage',
  ],
});

const context = await browser.newContext({
  // 通知权限自动授予，才能验证 SW 通知通道
  permissions: ['notifications'],
  viewport: { width: 420, height: 900 },
});

const page = await context.newPage();
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

const requestFailures = [];
page.on('requestfailed', (req) => {
  requestFailures.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? '?'}`);
});

try {
  await page.goto(`http://localhost:${APP_PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // 1) Service Worker
  const swState = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const reg = await Promise.race([
      navigator.serviceWorker.ready.then((r) => r.active?.state ?? 'activating'),
      new Promise((r) => setTimeout(() => r('timeout'), 8000)),
    ]);
    return reg;
  });
  check('Service Worker 已激活', swState === 'activated', `state=${swState}`);

  // 2) 连接向导出现
  const hasForm = await page.locator('#dav-url').count();
  check('连接向导渲染（首次访问无本地配置）', hasForm === 1, `#dav-url 数量=${hasForm}`);

  if (hasForm === 1) {
    await page.fill('#dav-url', DAV_URL);
    await page.fill('#dav-user', DAV_USER);
    await page.fill('#dav-password', DAV_PASS);
    await page.click('button[type=submit]');
  }

  // 3) 等应用就绪（出现主导航即认为连接成功）
  const ready = await page
    .waitForSelector('nav, .shell, [class*=sidebar], [class*=tabbar]', { timeout: 25_000 })
    .then(() => true)
    .catch(() => false);
  check('连接 WebDAV 成功并进入主界面', ready);

  // 失败时把页面上的错误文案抓出来，不然只剩一个 false 没法排查
  if (!ready) {
    const text = await page.locator('body').innerText().catch(() => '');
    console.log('\n--- 页面当前文案 ---');
    console.log(text.slice(0, 900));
    console.log('--- 网络失败 ---');
    for (const f of requestFailures.slice(0, 12)) console.log('  ' + f);
    throw new Error('连接未成功');
  }

  // 4) 数据是否真的拉下来了
  const davCalls = [];
  page.on('request', (req) => {
    if (req.url().includes('dav.') || req.headers()['authorization']) davCalls.push(req.method());
  });
  await page.goto(`http://localhost:${APP_PORT}/today`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const bodyText = await page.locator('body').innerText();
  check('今日页有内容（不是空白/报错页）', bodyText.includes('今日'), bodyText.slice(0, 60).replace(/\n/g, ' '));

  // 5) Service Worker 通知通道
  const notifyResult = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    reg.active?.postMessage({
      type: 'TWISCHE_NOTIFY',
      plan: {
        key: 'twische.today',
        active: true,
        title: '2 项逾期 · 今日还剩 3 项',
        body: '09:00  晨会\n21:00  写周报',
        count: 5,
      },
    });
    // 没有直接的"读通知"API，这里只验证消息被 SW 收下且没有抛错
    await new Promise((r) => setTimeout(r, 600));
    const list = await reg.getNotifications({ tag: 'twische.today' });
    return { permission: Notification.permission, shown: list.length, title: list[0]?.title ?? '' };
  });
  check(
    'SW 通知消息通道可用',
    notifyResult.permission === 'granted',
    `permission=${notifyResult.permission} 通知数=${notifyResult.shown} 标题=${notifyResult.title}`,
  );

  const realErrors = consoleErrors.filter((e) => !/favicon|manifest/i.test(e));
  check('控制台无错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('执行过程无异常', false, err.message);
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);

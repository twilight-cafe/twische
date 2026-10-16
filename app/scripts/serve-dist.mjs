#!/usr/bin/env node
/**
 * 本地静态服务器：把构建好的 dist 挂在指定端口上，供浏览器端自测。
 *
 * 存在的理由很实际：WebDAV 服务器的 CORS 允许列表是按**源**配的
 * （当前是 `http://localhost:3080`），而 `vite preview` 默认落在别的端口上，
 * 于是所有请求都会被 CORS 拦掉 —— 那不是代码的问题，却看起来一模一样。
 * 这个脚本让你能把页面挂在服务端认可的源上。
 *
 * 用法：
 *   node scripts/serve-dist.mjs [--port 3080] [--dir ../dist]
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', '3080'));
const ROOT = resolve(HERE, arg('dir', '../dist'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function resolveFile(urlPath) {
  // 先当作真实文件；命中目录或找不到就回落到 index.html（SPA 路由）
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const candidate = join(ROOT, clean);
  if (!candidate.startsWith(ROOT)) return null;

  try {
    const info = await stat(candidate);
    if (info.isFile()) return candidate;
    if (info.isDirectory()) {
      const index = join(candidate, 'index.html');
      const idx = await stat(index);
      if (idx.isFile()) return index;
    }
  } catch {
    /* 落到下面的兜底 */
  }

  try {
    const fallback = join(ROOT, 'index.html');
    await stat(fallback);
    return fallback;
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const file = await resolveFile(req.url || '/');
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('dist 里没有 index.html，先跑一次 npm run build');
      return;
    }

    const type = TYPES[extname(file)] || 'application/octet-stream';
    // Service Worker 必须每次回源，否则浏览器会一直用旧版本
    const noStore = file.endsWith('sw.js') || file.endsWith('index.html');
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': noStore ? 'no-store' : 'public, max-age=3600',
    });
    createReadStream(file).pipe(res);
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Twische 静态页面: http://localhost:${PORT}/`);
  console.log(`根目录: ${ROOT}`);
  console.log('（Ctrl+C 停止）');
});

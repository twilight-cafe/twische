/* eslint-env serviceworker */
/**
 * Twische Service Worker。
 *
 * 策略：
 * - 应用壳（index.html / manifest / 图标 / 主题引导）→ 预缓存，离线可开
 * - /assets/*（Vite 产物，文件名带内容哈希，且被后端标为 immutable）→ cache-first
 * - 导航请求 → network-first，断网时回退到缓存的 index.html
 * - /api/* → **完全不拦截**。同步逻辑由应用自己处理离线队列，
 *   在 SW 里再包一层缓存只会让"离线时读到过期数据"变得难以察觉。
 *
 * 更新：新版本装好后不自动接管，而是等页面发出 SKIP_WAITING，
 * 这样正在编辑的任务不会被一次静默刷新打断。
 */
const VERSION = 'twische-1.0.0';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/theme-boot.js',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 逐个添加：addAll 只要有一个 404 就整体失败，装机直接报废。
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {
            /* 单个资源缺失不应阻断安装 */
          }),
        ),
      );
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      );
      // 让已打开的旧标签页也能立刻走新 SW
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/** 只处理同源 GET。 */
function isCacheable(request, url) {
  if (request.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  // API 永不缓存
  if (url.pathname.startsWith('/api/')) return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (!isCacheable(request, url)) return;

  // 导航：优先网络，保证拿到最新入口；断网回退到应用壳
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          // 只缓存成功响应：把 500/502 错误页写进缓存，
          // 离线回退就会在服务端恢复后仍然给出错误页
          if (fresh.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put('/index.html', fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match('/index.html')) ||
            (await cache.match('/')) ||
            new Response(
              '<!doctype html><meta charset="utf-8"><title>离线</title>' +
                '<body style="font-family:system-ui;max-width:30rem;margin:15vh auto;padding:0 24px;line-height:1.8;color:#151515">' +
                '<h1 style="font-size:24px">当前离线</h1>' +
                '<p>Twische 的应用外壳还没缓存好。请连上网络后再打开一次。</p></body>',
              { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
            )
          );
        }
      })(),
    );
    return;
  }

  // 带内容哈希的构建产物：可以放心 cache-first
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const fresh = await fetch(request);
          if (fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
          return fresh;
        } catch (err) {
          // 命中不了就老实失败，让上层看到真实的网络错误
          throw err;
        }
      })(),
    );
    return;
  }

  // 其余同源资源（图标、manifest 等）：stale-while-revalidate
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(request);
      const network = fetch(request)
        .then((fresh) => {
          if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
          return fresh;
        })
        .catch(() => null);
      if (hit) {
        // 后台静默更新，本次直接返回缓存
        network.catch(() => {});
        return hit;
      }
      const fresh = await network;
      if (fresh) return fresh;
      throw new Error('offline');
    })(),
  );
});

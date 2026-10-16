/* eslint-env serviceworker */
/**
 * Twische Service Worker。
 *
 * 策略：
 * - 应用壳（index.html / manifest / 图标 / 主题引导）→ 预缓存，离线可开
 * - 带内容哈希的构建产物（assets/）→ cache-first
 * - 导航请求 → network-first，断网时回退到缓存的 index.html
 * - **带 Authorization 的请求一律不拦截**：那是 WebDAV 的数据请求。
 *   在 SW 里缓存它们只会让"离线时读到过期数据"变得难以察觉，
 *   也会把用户的日程明文留在 Cache Storage 里。
 *
 * 路径一律用相对形式（`./`），这样部署在子路径下也能正常工作。
 *
 * 更新：新版本装好后不自动接管，而是等页面发出 SKIP_WAITING，
 * 这样正在编辑的任务不会被一次静默刷新打断。
 */
const VERSION = '__TWISCHE_VERSION__';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

/** SW 自己所在的目录。子路径部署时图标与"打开应用"的地址都要从这里拼。 */
const BASE = new URL('./', self.location.href).href;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './theme-boot.js',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
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

// ───────────────────────── 状态栏通知 ─────────────────────────

/**
 * 由页面发来的通知负载直接显示/撤销。
 *
 * 为什么让页面算、SW 只负责显示：通知内容依赖重复规则展开、向量时钟合并后的
 * 本地仓库，那套代码在主包里。SW 是独立打包的，让它重算等于把领域逻辑再实现一遍，
 * 两边一旦不一致就会显示过期内容。
 *
 * 页面在后台时消息依然会被投递（SW 会被唤醒），所以"切走之后状态栏自己更新"
 * 这条路径是通的；真正断掉的是页面被划掉之后 —— 那时没有任何 JS 在跑。
 */
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'TWISCHE_NOTIFY') return;

  event.waitUntil(
    (async () => {
      const plan = msg.plan;
      try {
        if (!plan || !plan.active) {
          const existing = await self.registration.getNotifications({ tag: 'twische.today' });
          for (const n of existing) n.close();
          return;
        }
        await self.registration.showNotification(plan.title, {
          tag: plan.key || 'twische.today',
          body: plan.body || undefined,
          // 点开落回今日页 —— 通知说的就是今天的事
          data: { url: `${BASE}today` },
          icon: `${BASE}icons/icon-192.png`,
          badge: `${BASE}icons/favicon-32.png`,
          // 内容会随勾选不断更新，每更新一次都响一声是骚扰
          silent: true,
        });
      } catch (err) {
        // 通知失败绝不能影响 SW 的其它职责（离线缓存才是它的主业）
        console.warn('[twische] Service Worker 通知失败', err);
      }
    })(),
  );
});

/**
 * 这个 client 是否就是本应用。
 *
 * 不能写成 `client.url.startsWith(BASE)`：那是字符串前缀，不是路径边界，
 * 部署在 `/app/` 下时 `/application/` 这种兄弟路径也会被判成"就是它"。
 */
function isOurClient(client, base) {
  try {
    const url = new URL(client.url);
    return url.origin === base.origin && url.pathname.startsWith(base.pathname);
  } catch {
    return false;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || `${BASE}today`;

  event.waitUntil(
    (async () => {
      // 已经开着就把它拉到前台，而不是再开一个窗口 —— 应用是单页的，
      // 多开一个只会让两个实例各自同步同一份数据。
      const base = new URL(BASE);
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if (!isOurClient(client, base)) continue;
        // 用户可能停在别的页面上（比如设置页）；通知说的是今天的事，
        // 所以要把已有窗口也导航过去，而不是只把它拉到前台。
        if (client.url !== target && 'navigate' in client) {
          await client.navigate(target).catch(() => {});
        }
        await client.focus();
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

/**
 * 是否可以交给 SW 缓存。
 *
 * 关键判定是 **Authorization 头**：WebDAV 请求全靠它认证，
 * 同源部署（把静态页与 WebDAV 放在同一个域名下）时光看 origin 是分不出来的。
 */
function isCacheable(request, url) {
  if (request.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  if (request.headers.has('authorization')) return false;
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
            cache.put('./index.html', fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match('./index.html')) ||
            (await cache.match('./')) ||
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
  if (/\/assets\//.test(url.pathname)) {
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

# 部署与 CORS

静态页与 WebDAV 服务器**不同源**时，浏览器会先发 `OPTIONS` 预检，预检不过就
一律失败 —— 而且在 JS 里只会看到一个 `TypeError: Failed to fetch`，与"地址写错了"
长得一模一样。这份文档就是为这一步准备的。

> 同源部署（把 `dist/` 放到 WebDAV 服务器自己的目录下）**完全不需要**配置 CORS。
> 如果可以选择，优先选同源。

---

## 一、服务器需要返回什么

| 响应头 | 值 | 少了会怎样 |
| --- | --- | --- |
| `Access-Control-Allow-Origin` | 你的静态站源，例如 `https://twische.example.com`；或 `*`（见下） | 全部请求失败 |
| `Access-Control-Allow-Methods` | `GET, PUT, DELETE, OPTIONS, PROPFIND, MKCOL` | 漏 `PROPFIND` 就连不上；漏 `MKCOL` 建不了目录 |
| `Access-Control-Allow-Headers` | `Authorization, Content-Type, Depth, If-Match, If-None-Match` | 漏 `Authorization` 全部请求失败（它必然触发预检） |
| `Access-Control-Expose-Headers` | `ETag` | 仍可同步，但拿不到版本标识，并发窗口变大 |
| `Access-Control-Max-Age` | `600` | 只是每次请求都多一次预检，慢 |

**`Allow-Origin` 能不能写 `*`？**
本应用用 `Authorization` 头认证，并且 `fetch` 用的是 `credentials: 'omit'`
（不依赖 cookie），因此按 CORS 规范 `*` 是允许的。
但如果你的 WebDAV 服务器同时依赖 cookie 会话，就必须回显具体源并加 `Vary: Origin`。

---

## 二、各服务器的配置片段

### nginx 反代（最通用）

```nginx
location /dav/ {
    proxy_pass http://127.0.0.1:8080/;
    proxy_set_header Host $host;

    # 预检：直接由 nginx 回，不打扰后端
    if ($request_method = OPTIONS) {
        add_header Access-Control-Allow-Origin  $http_origin always;
        add_header Access-Control-Allow-Methods "GET, PUT, DELETE, OPTIONS, PROPFIND, MKCOL" always;
        add_header Access-Control-Allow-Headers "Authorization, Content-Type, Depth, If-Match, If-None-Match" always;
        add_header Access-Control-Expose-Headers "ETag" always;
        add_header Access-Control-Max-Age 600 always;
        add_header Vary Origin always;
        return 204;
    }

    add_header Access-Control-Allow-Origin  $http_origin always;
    add_header Access-Control-Expose-Headers "ETag" always;
    add_header Vary Origin always;
}
```

> 注意 `add_header` 在 `if` 块里会覆盖外层的同名头，这是刻意的：
> 预检响应不需要业务头，业务响应不需要 `Allow-Methods`。

### Radicale

`config`：

```ini
[headers]
Access-Control-Allow-Origin = *
Access-Control-Allow-Methods = GET, PUT, DELETE, OPTIONS, PROPFIND, MKCOL
Access-Control-Allow-Headers = Authorization, Content-Type, Depth, If-Match, If-None-Match
Access-Control-Expose-Headers = ETag
Access-Control-Max-Age = 600
```

Radicale 从 3.x 起支持自定义响应头。改完记得重启。

### Nextcloud

Nextcloud 的 DAV 端点在 `remote.php/dav/`，默认不向任意源开放。
推荐用**同源**部署（把 `dist/` 放进 Nextcloud 的某个公开目录），
或者在前面加一层 nginx 按上面的片段补头。

### Apache / mod_dav

```apache
<IfModule mod_headers.c>
    Header always set Access-Control-Allow-Origin "https://twische.example.com"
    Header always set Access-Control-Allow-Methods "GET, PUT, DELETE, OPTIONS, PROPFIND, MKCOL"
    Header always set Access-Control-Allow-Headers "Authorization, Content-Type, Depth, If-Match, If-None-Match"
    Header always set Access-Control-Expose-Headers "ETag"
    Header always set Vary "Origin"
    # 让 DAV 方法真正可用
    <LimitExcept GET POST OPTIONS>
        Require valid-user
    </LimitExcept>
</Files>
```

（Apache 还需要 `Dav On` 与 `AuthType Basic` 等基础配置，这里只列 CORS 部分。）

### 自建 webdavd

配置文件里的 `cors_domains` 填静态站的源即可，其余响应头由服务端按标准补齐。
**本应用只依赖 RFC 4918 class 1 的标准能力**，不为任何服务器的私有行为做兼容；
如果某个方法不被支持，会直接报错并带上原始状态码，而不是悄悄降级。

---

## 三、怎么确认配对了

在浏览器控制台里跑一遍（把地址换成你自己的）：

```js
await fetch('https://dav.example.com/dav/你的目录/', {
  method: 'PROPFIND',
  headers: { Authorization: 'Basic ' + btoa('用户名:密码'), Depth: '0' },
});
```

- 抛 `TypeError: Failed to fetch` → 预检没过：看 Network 面板里那条 `OPTIONS` 的状态与响应头。
- 返回 `207` → 通了，接着看 `Access-Control-Expose-Headers` 里有没有 `ETag`。
- 返回 `401` → CORS 已经通了，只是用户名/密码不对（这是好消息）。

应用内的「连接 → 保存并测试」会做同样的检查，并把失败归到具体原因上
（跨域被拒 / 认证失败 / 不是 WebDAV / 路径不存在），比控制台里那个 TypeError 好读得多。

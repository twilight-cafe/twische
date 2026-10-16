# Twische 次世代（nxt_generation）设计方案 · 重新计划版

> **目标：保留原版全部功能，只把「数据同步方式」从自建 Go 服务端换成第三方 WebDAV。**
> 外加一个把旧服务器数据搬到 WebDAV 的 CLI 迁移工具。
>
> 相比首版计划，**CalDAV / iCalendar 已移出范围**（调研结论存档在 `future-caldav.md`）。
> 这是一个小得多的改动：数据模型、同步算法、界面全部沿用，只换传输层。

---

## 0. 一句话说清楚

```
原版：  浏览器 ──/api/sync(JSON, 向量时钟)──▶ Go 服务端 ──▶ SQLite
新版：  浏览器 ──PROPFIND/GET/PUT/DELETE──▶ 第三方 WebDAV 服务器
                 （每条记录一个 JSON 文件，内容与原来一模一样）
```

**记录格式不变**（`{id, kind, data, vc, updatedAt, deleted}`），
因此**迁移 = 逐条搬运 JSON，无字段映射、无信息损失**。
向量时钟继续承担多端合并，只是裁决者从服务端变成客户端（规则用的是同一份 `vector.js`）。

---

## 1. 保留 / 替换 / 移除

| 原版 | 新版 | 说明 |
| --- | --- | --- |
| 四个视图（今日/本周/月/任务）、任务编辑器、重复规则构建器、打卡、标签、搜索过滤、统计 | **原样保留** | 复制 `web/src` 后仅改数据源接线 |
| 领域层：`recurrence.js`、`vector.js`、`datetime`、`layout` | **原样保留** | 已移植到 `src/domain/`，测试全绿 |
| 离线优先：IndexedDB 为唯一数据源、界面不等网络 | **原样保留** | 这是原版最值钱的设计 |
| 向量时钟多端合并、`vcResolveConflict`（updatedAt → 指纹） | **原样保留** | 裁决位置从服务端移到客户端 |
| 墓碑（`deleted:true`）与 90 天清理 | **保留** | 清理从「服务端启动时」改为 CLI 子命令 |
| PWA / Service Worker / 安装到桌面 | **保留**（SW 需改缓存判定） | DAV 请求必须永不缓存 |
| `POST /api/sync` 的 `cursor` 单调序号 | **替换**为 ETag 差异 + 全量自检 | 无服务端序号可用 |
| 会话 cookie、`need-init`、提权（elevation） | **替换**为 WebDAV Basic 认证 | 每请求带凭据，无会话概念 |
| 账户信息、改密码、设备列表（改名/吊销/移除）、审计日志、服务端冲突记录 | **移除** | 这些是服务端功能，WebDAV 下不存在 |
| 服务端导出 `/api/account/export` | **替换**为本地导出/导入 JSON | 浏览器直接生成 `twische-export` 格式 |
| — | **新增** CLI 迁移工具 | 旧服务器（地址+密码）或导出文件 → WebDAV |

> 「支持原来全部功能」按**应用功能**理解（日程/任务/重复/打卡/离线/PWA）。
> 服务器管理类功能（设备会话、改密码、审计）在无后端架构里没有对应物，一律移除。

---

## 2. WebDAV 存储布局

```
{davRoot}/                      用户给的地址，例如 https://dav.example.com/remote.php/dav/files/alice/twische/
├── meta.json                   { "format":"twische-store", "version":1, "createdAt":…, "app":"twische-nxt" }
└── records/
    ├── <taskId>.json           一条记录一个文件
    ├── <taskId>|<occurrence>.json   打卡记录（id 含竖线，文件名需 URL 编码）
    └── …
```

单个记录文件的内容与旧服务器 `records` 表里的 `data`/`vc` 完全一致：

```json
{
  "id": "3f2a…",
  "kind": "task",
  "data": { "id": "3f2a…", "title": "晨跑", "kind": "fixed", "recurrence": { … } },
  "vc": { "device-uuid": 7 },
  "updatedAt": 1768000000000,
  "deleted": false
}
```

**为什么一个记录一个文件**：WebDAV 的并发控制与增量发现都以资源（文件）为粒度，
`PROPFIND Depth:1` 一次就能拿到全部 `href + getetag`，比读一个大 JSON 再整体比较更快，
也避免了「两台设备同时写同一个大文件」这种必然互相覆盖的局面。

文件名规则：`encodeURIComponent(id) + '.json'`。`id` 允许 `[A-Za-z0-9_-]` 与
`<taskId>|<occurrence>` 两段式，编码后依然是合法路径段。

### 需要的 DAV 能力（RFC 4918 class 1）

| 用途 | 方法 |
| --- | --- |
| 探测目录是否存在 / 列目录取 ETag | `PROPFIND Depth: 0/1` |
| 建目录 | `MKCOL` |
| 读单条记录 | `GET` |
| 写单条记录 | `PUT`（带 `If-Match` / `If-None-Match: *`） |
| 删单条记录 | `DELETE` |
| 连通性预检 | `OPTIONS` |

`REPORT`、`MKCALENDAR`、`calendar-data` 一律不用 —— 这是「普通 WebDAV」，
所以自建 `webdavd`、Nextcloud 文件空间、坚果云、Apache mod_dav、rclone serve 都能用。

---

## 3. 同步引擎（客户端裁决）

### 3.1 一轮同步

```
syncOnce():
  1. ensureStore()       MKCOL twische/ 与 twische/records/（幂等，404/405 都算成功）
  2. push                对每条 dirty 记录：
                           PUT records/<id>.json
                             If-Match: <上次拿到的 ETag>      （已存在）
                             If-None-Match: *                 （本地新建）
                           412 → 拉该文件 → vc 合并 → 重试一次
                           → 记下新 ETag，清 dirty
  3. pull                PROPFIND Depth:1 records/  →  [{href, getetag}]
                           href 不在本地 → GET → applyRemoteRecord（vc 比较）
                           etag 变了     → GET → applyRemoteRecord
                           href 消失     → 远端已删 → 本地留墓碑删记录（dirty 的除外）
  4. 自检                本地非墓碑条数 vs 远端文件数；不一致且无 dirty → 全量重建
```

与原版 `sync.ts` 的三段式（push → pull → 完整性自检）**结构完全一致**，
替换的只有 `api.sync()` 这一层。

### 3.2 冲突裁决

原版由服务端裁决，新版在客户端用**同一份规则**裁决（`src/domain/vector.js`）：

- 远端支配本地 → 采纳远端，清 dirty
- 本地支配远端 → 保留本地，继续推送
- 并发 → `vcResolveConflict`（先比 `updatedAt`，相同再比时钟指纹），
  **本地胜出时把时钟升级为两者的并集**（这条防乒乓的关键设计原样保留）
- 判为并发时记一条本地冲突日志，设置页可查看（替代原版的服务端 `conflicts` 表）

`localrepo.applyRemoteRecord` 已经实现了全部四条分支，**代码不需要改**。

### 3.3 ETag 是优化，不是正确性前提

`If-Match` 只能缩小「双方同时写同一文件」的窗口；即使服务器不支持 ETag
（或 CORS 没 expose `ETag`）导致拿不到，同步依然收敛：
败方会在下一轮 pull 中看到对方的版本，按 vc 规则重新裁决并再次推送。
这一点必须在实现里保持——**不要在拿不到 ETag 时报错或降级为只读**。

### 3.4 不需要的东西

- ❌ `cursor` / `floorSeq`：本地不再需要服务端序号（`seq` 字段保留仅为兼容导出格式，不再参与逻辑）
- ❌ `resyncRequired`：改为「文件数不一致就全量重建」
- ❌ 会话 cookie / 提权：Basic 认证每次带上

---

## 4. 连接、凭据与首启流程

### 4.1 配置

```ts
interface DavProfile {
  url: string;           // 用户输入的 WebDAV 目录地址
  username: string;
  remember: boolean;     // false = 密码只存在内存里（关闭页面即失效）
}
```
密码存 IndexedDB `secrets` store（`remember:false` 时只放内存）。
UI 明示「明文保存在本机，建议用应用专用密码」。

### 4.2 状态机

原版：`checking | need-init | need-login | ready | error`
新版：`checking | need-setup | need-login | ready | error`

- `need-setup`：从未配置过 WebDAV 地址 → 连接向导
- `need-login`：配置过但密码没记住（或认证失败）→ 输入密码
- 启动仍是「先给界面，再对答案」：配置过就立刻用 IndexedDB 渲染，`OPTIONS`+`PROPFIND` 探测丢后台

### 4.3 连接向导（替换 `LoginView` / `NotInitializedView`）

1. WebDAV 地址（含路径）、用户名、密码
2. 「测试连接」：`OPTIONS` → `PROPFIND` 目标目录 → 必要时 `MKCOL` 建 `twische/records/`
3. 失败分类给出可读原因：`network` / `cors` / `unauthorized` / `not-found` / `readonly` / `not-dav`
4. `cors` 时直接内联服务器需要补的响应头（见 §8）

---

## 5. 设置页改造

| 原版标签页 | 新版 | 内容 |
| --- | --- | --- |
| 外观 | **保留** | 主题、周起始、行高 |
| 账户 | → **连接** | WebDAV 地址/用户名/密码、测试连接、保存；移除改密码与审计 |
| 设备 | → **本机** | 本机名称、本机 deviceId、参与同步的时钟分量列表（从记录里归纳）；移除吊销/移除设备 |
| 同步与数据 | **保留 + 扩充** | 同步状态、立即同步、冲突日志、离线与安装、**本地导出/导入**、关于 |

「导出」改为浏览器本地生成的 `twische-export` JSON（与原服务端格式一致，便于互操作），
「导入」用于无 CLI 场景下的恢复。

---

## 6. CLI 迁移工具（`tools/migrate`）

零依赖（Node ≥ 20 内置 `fetch`），Node 侧没有 CORS 约束，因此**可以真正做到「填地址 + 密码直连旧服务器」**。

```bash
# 旧服务器 → WebDAV
node tools/migrate/index.mjs \
  --from http://192.168.1.10:8787 --password '旧密码' \
  --to https://dav.example.com/twische/ --user alice --pass 'app-password' \
  --dry-run --report ./migration-report.json

# 导出文件 → WebDAV
node tools/migrate/index.mjs --from-file ./twische-export.json --to … 

# 维护：清理 90 天前的墓碑
node tools/migrate/index.mjs --prune-tombstones --older-than 90d --to …
```

旧服务端交互（协议细节已实测确认）：

1. `GET /api/health` → 校验 `initialized`
2. `POST /api/auth/login`，头 `Content-Type: application/json` + `x-twische-client: web`，
   体 `{password, deviceId:"migration-<uuid>", deviceName:"Twische 迁移工具"}` → 保存 `Set-Cookie: twische_sid=…`
   （**不能发 `Origin` 头**，否则被 CSRF 守卫 403）
3. `GET /api/account/export` 一次性取全量（含墓碑）；账户很大时改用 `POST /api/sync` 分页
   （`cursor` 严格递增，**不要传 `full`**——旧服务端每次都会把游标重置为 0）
4. `POST /api/auth/logout` 收尾

写入端：`ensureStore()` → 逐条 `PUT records/<id>.json`，**记录原样搬运**（vc/updatedAt/deleted 都不改）。
- 幂等：目标已存在同 id 文件时 `GET` 比较内容，相同则跳过（`--on-conflict skip|overwrite`，默认 skip）
- 可续跑：`--resume state.json` 记录已完成 id
- 限速：默认 4 并发、每批 25 个，避免打爆小型服务器
- 报告：新增/跳过/覆盖/失败 + 失败明细

**为什么必须做成 CLI**：旧服务端无任何 CORS 头、会话是 `HttpOnly + SameSite=Lax` cookie
（跨站不发送），变更类请求还要求 `Origin == Host`。浏览器从跨域静态页直连旧服务器
在协议层面不可能，CLI 是唯一能「填地址 + 密码」的路径。

---

## 7. 目录结构

```
nxt_generation/
├── docs/{DESIGN.md, future-caldav.md, migration.md}
├── public/                     PWA：manifest / sw.js / icons / theme-boot.js
├── tools/migrate/index.mjs     CLI（零依赖）
├── src/
│   ├── domain/                 领域层（recurrence.js / vector.js / datetime / layout / types / id / plain）
│   ├── storage/
│   │   ├── backend.ts          后端接口（为将来预留，目前只有 webdav 一个实现）
│   │   ├── webdav/
│   │   │   ├── client.ts       PROPFIND/GET/PUT/DELETE/MKCOL + Basic 认证 + 错误归一
│   │   │   ├── xml.ts          multistatus 极简解析
│   │   │   ├── store.ts        记录 ↔ 文件的映射、ensureStore、listAll、changes
│   │   │   └── profile.ts      连接配置的读写与探测
│   │   ├── credentials.ts      凭据（记住 / 仅会话）
│   │   └── legacy.ts           旧 Twische HTTP 客户端（仅 CLI 与网页兜底用）
│   ├── repo/                   IndexedDB 仓库 + 同步引擎（localrepo.ts / sync.ts / idb.ts）
│   ├── stores/  views/  components/  hooks/  styles/
└── package.json  vite.config.ts  tsconfig.json  index.html
```

`storage/backend.ts` 保留一个薄接口，是为了让 CLI、测试（内存后端）与将来的
CalDAV/本地文件后端都能插进来，而不是为了抽象而抽象。

---

## 8. CORS（跨域部署的硬约束）

静态站与 WebDAV 服务器不同源时，浏览器会发预检。服务器需要：

```
Access-Control-Allow-Origin: https://你的静态站
Access-Control-Allow-Methods: GET, PUT, DELETE, OPTIONS, PROPFIND, MKCOL
Access-Control-Allow-Headers: Authorization, Content-Type, If-Match, If-None-Match, Depth
Access-Control-Expose-Headers: ETag
Access-Control-Max-Age: 600
```

四个最常踩的点（`docs/migration.md` 里给出 nginx / Nextcloud / Apache 的配置片段）：

1. `Authorization` 会触发预检，`Allow-Headers` 漏了它 → 全部请求失败
2. `Allow-Methods` 漏 `PROPFIND` / `MKCOL` → 连不上或建不了目录
3. `Expose-Headers` 漏 `ETag` → 拿不到版本标识（仍可用，只是并发窗口变大）
4. `Allow-Origin` 必须回显具体源并带 `Vary: Origin`，不能图省事用 `*` 配 `credentials`

自建 `webdavd` 的配置里有 `cors_domains`，按标准填即可；**实现按 RFC 写，不为任何服务器的
私有行为做兼容**。

---

## 9. 里程碑

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **M0** 脚手架 + 领域层 | Vite/React/vitest 工程；`domain/` 移植（`recurrence` 的 50 个用例改用 vitest） | ✅ 138 个用例通过 |
| **M1** WebDAV 传输层 | `xml.ts` + `client.ts`（OPTIONS/PROPFIND/GET/PUT/DELETE/MKCOL、Basic、错误分类、CORS 诊断） | ✅ 用假服务器驱动的全流程测试，100% 覆盖 |
| **M2** 同步引擎 | `store.ts`（记录↔文件）+ `sync.ts` 改造（etag 差异、vc 裁决、远端删除） | ✅ 新建/更新/删除/并发 412/离线重试均有测试 |
| **M3** 连接与界面 | `need-setup` 状态机、连接向导、设置页改造（连接/本机/同步与数据） | ✅ 四个视图沿用原版，仅换数据源接线 |
| **M4** CLI 迁移 | `tools/migrate/index.mjs` + `src/cli/` | ✅ 48 个用例；dry-run / 幂等 / 断点续跑 / 报告 |
| **M5** 收尾 | 本地导出/导入、SW 改造（DAV 永不缓存）、`base` 子路径、文档 | ✅ 构建通过；子路径构建验证过 |

最终状态：**582 个用例、覆盖率 100%（行/分支/函数/语句）**，`tsc --noEmit` 与
`vite build` 均通过。

### 实施过程中的三处修正（与初版设计的差异）

1. **去掉了「完整性自检 + 全量重建」**。v1 需要它是因为服务端的增量游标可能漏记录；
   而 PROPFIND 每轮都返回远端**完整**集合，拉取阶段已经保证「本地缺的补回来、
   远端没有的清掉」，两侧必然相等。少一次全量重建，也就少了一整类
   「重建把本地数据抹掉」的故障（v1 的 `runFullRebuild` 恰好有这个问题）。
2. **版本指纹优先 ETag、缺失时退回 Last-Modified**。
   只比较 ETag 时，服务器不给 ETag 就会每轮把所有文件重读一遍；
   退回 `Last-Modified` 就能继续做增量。两者都没有时才退化为"每次都读回来比对"。
3. **`instanceof DavError` 换成 `isDavError()`**。
   同一个模块被打包两次（或测试里 resetModules）会产生两个类对象，
   `instanceof` 静默失败，症状是"错误分类全部失效、网络错误不再重试"。
   这个坑是测试先暴露出来的。

---

## 10. 测试策略

沿用原版门槛：`domain/`、`repo/`、`storage/`、`stores/`、`hooks/` 保持 100% 行/分支/函数/语句覆盖。

重点：
1. `multistatus` XML 解析（含命名空间前缀差异、`<D:` / `<d:` / 默认命名空间、状态码分组）
2. 同步：新建/更新/删除/远端删除/并发冲突/412 重试/文件数自检
3. vc 合并与冲突裁决（复用 `domain/vector.test.js` 的 24 个用例）
4. 迁移：计划生成、幂等重跑、断点续跑、报告
5. CORS 诊断：模拟 `TypeError: Failed to fetch` → 断言归类为 `cors` 并给出可操作提示

---

## 11. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 服务器不支持 WebDAV（只是普通 HTTP） | `OPTIONS` 预检 + `DAV:` 响应头判定，失败时明确告知 |
| 跨域被拒（无 CORS 头） | 预检 + `failed to fetch` 归类为 `cors`，内联给出该补的响应头 |
| 拿不到 ETag | 不报错：退化为无条件 PUT，靠 vc 收敛（§3.3） |
| 记录数很多（几千条）导致 PROPFIND 很大 | 分页不必要但要做进度提示；首轮之后本地缓存 ETag 映射，日常只比较 |
| 文件名里的 `\|` 与 URL 编码 | 统一 `encodeURIComponent`，并有往返测试 |
| 用户在设置里换服务器 | 明确提示「本地数据会与目标合并」，提供「换服务器前先导出」引导 |

---

## 12. 待确认

1. **换服务器时的本地数据策略**：直接与目标合并（现有 vc 规则）／先清空本地再全量拉取？
   我倾向「合并 + 首次同步前提示」，但清空更符合直觉。
2. **墓碑清理**放在 CLI 子命令（我倾向）还是设置页按钮？
3. 原版「导出」是服务端生成的；新版改为浏览器本地生成，格式保持一致 —— 确认可以。

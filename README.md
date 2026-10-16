# Twische · 次世代（nxt_generation）

纯静态的日程管理页面 + 你自己的 WebDAV 服务器。

没有自建后端：整个应用是一堆静态文件，所有数据以 JSON 文件的形式存在
**你自己的** WebDAV 目录里。多台设备之间靠向量时钟自动合并，离线也能照常使用。

```
浏览器（这个静态页） ──PROPFIND / GET / PUT / DELETE──▶ 你的 WebDAV 服务器
```

---

## 特点

- **没有服务端**：`dist/` 丢到任何静态托管（Nginx、GitHub Pages、对象存储、Nextcloud 公共目录）就能用。
- **数据是你的**：一条记录一个 `.json` 文件，直接躺在你的 WebDAV 目录里，随时能拿走。
- **离线优先**：IndexedDB 是唯一数据源，界面从不等待网络；联网后自动补齐。
- **多端合并**：向量时钟 + 确定的冲突决胜规则，两台设备离线各改各的也不会丢改动。
- **原版功能一个不少**：今日 / 本周 / 月历 / 任务四个视图、重复规则构建器、
  打卡、标签、搜索过滤、统计、PWA 安装。

## 快速开始

```bash
npm install
npm run dev        # http://localhost:5273
```

首次打开会让你填 WebDAV 地址、用户名、密码。填完点「保存并测试」，
通过后就可以直接用了。

> 跨域部署需要 WebDAV 服务器允许本站源访问，配置片段见 **[docs/cors.md](docs/cors.md)**。
> 如果能把 `dist/` 放到 WebDAV 服务器同域下，就完全不用管 CORS。

## 构建与部署

```bash
npm run build                      # 产物在 dist/
NXT_BASE=/twische/ npm run build   # 部署在子路径时
```

把 `dist/` 整个目录上传即可。子路径部署要带 `NXT_BASE`，
否则刷新 `/week` 这类路由会 404。

## 从旧版 Twische 迁移

旧的 Go 服务端数据可以用自带的 CLI 搬过来（**填地址 + 密码直连**，
浏览器做不到这件事，原因见文档）：

```bash
node tools/migrate/index.mjs \
  --from http://192.168.1.10:8787 --password '旧密码' \
  --to https://dav.example.com/twische/ --user alice --pass '应用专用密码' \
  --dry-run
```

完整说明（含参数、幂等性、常见错误、墓碑清理）见 **[docs/migration.md](docs/migration.md)**。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run（582 个用例）
npm run coverage    # 纯逻辑层要求 100% 行/分支/函数/语句覆盖
npm run smoke       # 真实 HTTP 上的端到端冒烟：起一个 WebDAV 服务端 + 一个假旧服务端，
                    # 然后用 CLI 本身把数据搬过去并逐条核对（无需 Docker / 外部依赖）
```

### 目录

| 路径 | 内容 |
| --- | --- |
| `src/domain/` | 领域层：重复规则引擎、向量时钟、日期时间、周视图分列算法 |
| `src/storage/webdav/` | WebDAV 客户端（PROPFIND/GET/PUT/DELETE + multistatus 解析） |
| `src/storage/` | 连接配置、凭据、连接自检 |
| `src/repo/` | IndexedDB 仓库、同步引擎、导出导入 |
| `src/cli/` | 迁移工具的核心逻辑（`tools/migrate/` 是它的命令行外壳） |
| `src/stores/` `src/views/` `src/components/` | 界面 |
| `docs/` | 设计文档、迁移手册、CORS 指南 |

## 数据长什么样

```
你的 WebDAV 目录/
└── twische/
    ├── meta.json                存储自述
    └── records/
        ├── 3f2a…​.json           一条任务
        └── 3f2a…|2026-01-15.json 一条打卡记录
```

单个文件的内容：

```json
{
  "id": "3f2a…",
  "kind": "task",
  "data": { "title": "晨跑", "kind": "fixed", "recurrence": { "…": "…" } },
  "vc": { "设备-id": 7 },
  "updatedAt": 1768000000000,
  "deleted": false
}
```

**一条记录一个文件**是刻意的：WebDAV 的并发控制（ETag）与增量发现（PROPFIND）
都以资源为粒度。若把所有记录塞进一个大 JSON，两台设备同时写就必然互相覆盖。

## 设计取舍

- **ETag 是优化，不是正确性前提**。服务器不给 ETag 时照样能同步 ——
  败方会在下一轮按向量时钟重新裁决，只是并发窗口大一点。
- **`instanceof` 判错不可靠**。跨模块副本会让它静默失败，因此统一用 `isDavError()` 按形状判断。
- **未知的远端文件不会被静默丢弃**：解析失败一律报错，
  因为"读不出来"被当成"远端没有"会触发删除本地数据。
- **不兼容任何服务器的私有行为**：只用 RFC 4918 class 1 的标准能力，
  不支持就报错并带上原始状态码。

更完整的架构说明见 **[docs/DESIGN.md](docs/DESIGN.md)**，
CalDAV 相关的调研结论存档在 [docs/future-caldav.md](docs/future-caldav.md)。

# 从旧服务器迁移到 WebDAV

旧版 Twische 的数据在自建服务端的 SQLite 里（`data/twische.db`）。
新版没有服务端，数据以 JSON 文件存在你自己的 WebDAV 目录里。
这份文档说明怎么把数据搬过去。

---

## 零、先理解一件事

**浏览器没法直连旧服务器。** 这不是实现问题，是协议限制：

- 旧服务端不返回任何 CORS 头，`OPTIONS /api/*` 直接 404；
- 会话是 `HttpOnly + SameSite=Lax` 的 cookie，跨站请求根本不会带上；
- 变更类请求还要求 `x-twische-client: web` **且** `Origin` 必须等于 `Host`。

所以「填地址 + 密码 → 迁移」只有一条路能走通：**CLI**（Node 不受 CORS 约束）。
网页里也内置了迁移向导，但它只能处理「导入导出文件」与「同源直连」两种情况。

| 入口 | 适用场景 | 能不能填地址+密码直连旧服务器 |
| --- | --- | --- |
| **CLI**（推荐） | 任何场景 | ✅ 可以 |
| 网页向导 · 导入文件 | 任何场景（先导出 JSON） | ❌ |
| 网页向导 · 同源直连 | 新前端被部署在旧服务器的同源下 | ✅ 但需要同源 |

---

## 一、CLI 迁移（推荐）

需要 Node ≥ 20（用它的内置 `fetch`，零依赖）。

```bash
cd nxt_generation

# 先看一眼要搬什么（不写入任何东西）
node tools/migrate/index.mjs \
  --from http://192.168.1.10:8787 --password '旧服务器密码' \
  --to https://dav.example.com/twische/ --user alice --pass '应用专用密码' \
  --dry-run

# 确认无误后真正执行，并把报告落盘
node tools/migrate/index.mjs \
  --from http://192.168.1.10:8787 --password '旧服务器密码' \
  --to https://dav.example.com/twische/ --user alice --pass '应用专用密码' \
  --report ./migration-report.json
```

跑完会看到：

```
共 214 条记录（通过 一次性导出）
正在写入 https://dav.example.com/twische/ …
完成：新增 214 · 跳过（内容一致）0 · 覆盖 0 · 保留目标已有 0 · 失败 0
```

### 参数

| 参数 | 说明 |
| --- | --- |
| `--from <url>` | 旧服务器地址 |
| `--password <pw>` | 旧服务器访问密码 |
| `--from-file <path>` | 也可以直接从导出的 JSON 迁移（见第二节） |
| `--to <url>` | 目标 WebDAV 目录，不存在会自动创建 |
| `--user` / `--pass` | WebDAV 凭据（建议用应用专用密码） |
| `--on-conflict skip\|overwrite` | 目标已有同名记录且内容不同时怎么办，默认 `skip`（保留目标） |
| `--dry-run` | 只统计不写入 |
| `--report <path>` | 结果报告写成 JSON（含失败明细） |
| `--concurrency <n>` | 并发写入数，默认 4 |
| `--prune-tombstones` | 只做清理：删掉 90 天前的删除墓碑 |
| `--older-than <days>` | 配合上一条，默认 90 |

### 迁移是幂等的

已经搬过去的记录会被识别为「内容一致」并跳过。中断了、报错了、想再跑一遍 ——
直接重新执行同一条命令即可，不会产生重复数据。

**别删旧服务器上的数据**，等新版用顺了再删。`data/twische.db` 是唯一的原始副本。

### 墓碑也会一起搬

旧记录里的 `deleted: true`（删除墓碑）同样会被写过去。
这不是多余 —— 少了它，别的设备下次同步时会认为"服务器上从来没有过这条"，
从而把已经删掉的任务**复活**。

墓碑会一直留在 WebDAV 上（同步需要它），但不会永远留：
过一段时间用 `--prune-tombstones` 清理 90 天前的即可。

---

## 二、先导出再迁移（跨域时的兜底）

CI 里跑不了 Node、或者旧服务器已经关掉了，可以用导出文件：

```bash
# 用旧版 UI 的「设置 → 数据导出」下载，或者：
curl -c cookies.txt -H 'x-twische-client: web' -H 'Content-Type: application/json' \
     -d '{"password":"旧密码","deviceId":"migration-cli","deviceName":"curl"}' \
     http://192.168.1.10:8787/api/auth/login

curl -b cookies.txt http://192.168.1.10:8787/api/account/export -o twische-export.json
```

然后：

```bash
node tools/migrate/index.mjs --from-file ./twische-export.json \
  --to https://dav.example.com/twische/ --user alice --pass '应用专用密码'
```

同一个文件也可以直接在应用里「设置 → 同步与数据 → 导入 JSON」——
导入的记录会进入待上传队列，由下一次同步推到服务器。

---

## 三、迁移之后

1. 打开新版页面，在连接向导里填同一个 WebDAV 地址与凭据。
2. 确认任务数、归档状态、打卡记录都对得上。
3. 其它设备同样连一次，它们的数据会通过向量时钟合并，不需要再迁一遍。

如果发现数字对不上，**先别急着删任何东西**，把 `--report` 生成的报告留好：
里面逐条记录了哪些成功、哪些跳过、哪些失败（含 HTTP 状态）。

---

## 四、常见问题

**`密码不正确`**
旧服务器的密码。注意旧服务端有锁定策略：连续失败 5 次会锁 60 秒并指数退避。

**`该服务端尚未初始化`**
旧服务器还没跑过 `twische init`，或者是地址指到了别的服务。

**`父目录不存在`（--to）**
`--to` 要填到一个已存在的目录下，新目录由工具创建。例如填
`https://dav.example.com/dav/files/alice/twische/`，其中 `.../alice/` 必须已经存在。

**`没有下发会话 cookie`**
旧服务端版本太老（登录接口不存在或行为不同）。用第二节的导出文件方式。

**失败若干条但大部分成功**
重跑一次即可（幂等）。仍失败的看报告里的 `reason` 字段。

**迁移到一半中断**
直接重跑。已搬过去的会被跳过。

---

## 五、清理墓碑（可选）

墓碑在同步里承担「告诉其它设备这条被删了」的职责，所以不能立刻删除；
但也不能永远留着，服务器上的文件数会一直涨。

```bash
node tools/migrate/index.mjs --prune-tombstones --older-than 90 \
  --to https://dav.example.com/twische/ --user alice --pass '应用专用密码' --dry-run
```

确认要删的数量合理后再去掉 `--dry-run`。

> 清理之前请确保**所有设备都已经同步过**。
> 如果某台设备离线超过 90 天，它的本地副本会把清理掉的记录当成"服务器上还有"，
> 下一次同步时重新推上去 —— 这不会丢数据，只是白清理一次。

# 归档：CalDAV / iCalendar 方案（暂不实施）

> 本文件是 2026-xx 首版设计的存档。**当前范围已改为「WebDAV 同步 + CLI 迁移」，
> 不实现 CalDAV**（见 `DESIGN.md`）。保留此文档是因为 iCalendar 映射的调研结论
> 本身是有效的，将来若要接入标准日历客户端可直接复用，不必重新调研。

## 为什么当时想做 CalDAV

让 Twische 的任务/日程与 iOS 日历、Thunderbird、DAVx5 等标准客户端互通，
并把「完成打卡」「归档」「标签」这些私有语义编码进 iCalendar。

## 映射表（结论部分）

### fixed 任务（重复时段）→ `VEVENT`

| iCalendar | Twische | 说明 |
| --- | --- | --- |
| `UID` | `task.id` | UUID |
| `SUMMARY` / `DESCRIPTION` | `title` / `notes` | TEXT 转义 |
| `CATEGORIES` | `tags[]` | 多值属性 |
| `DTSTART` / `DTEND` | `recurrence.dtstart + startTime/endTime` | floating local time，无 `TZID` |
| `RRULE` | `recurrence` | 见下方 RRULE 映射 |
| `EXDATE` | `recurrence.exdates` | floating 本地时刻 |
| `PRIORITY` | `priority` | `2 紧急→1`、`1 重要→5`、`0 普通→0` |
| `STATUS` | 派生 | `archived` → `CANCELLED`（仅供第三方客户端表现） |
| `X-TWISCHE-KIND` | `fixed` | |
| `X-TWISCHE-STATUS` | `open` / `archived` | **权威值** |
| `X-TWISCHE-DONE` | completion 列表 | 多值，值为 occurrence 键（`YYYY-MM-DD`） |
| `DTSTAMP`/`LAST-MODIFIED`/`CREATED` | `updatedAt`/`createdAt` | UTC |
| `SEQUENCE` | 本地修订号 | 每次写入 +1 |

### deadline 任务（精确截止）→ `VTODO`

`DUE` ← `dueAt`（floating）；完成状态映射到 `STATUS` / `COMPLETED` / `PERCENT-COMPLETE`；
其余同上。

### RRULE 双向映射

| Twische | iCalendar |
| --- | --- |
| `freq: 'weekly'` + `byWeekday: [1,3]` | `FREQ=WEEKLY;BYDAY=MO,WE` |
| `freq: 'monthly'` + `byMonthday: [1,15]` | `FREQ=MONTHLY;BYMONTHDAY=1,15` |
| `freq: 'monthly'` + `nthWeekday: {ordinal:3, weekday:5}` | `FREQ=MONTHLY;BYDAY=3FR` |
| `freq: 'yearly'` + `byMonth` + `byMonthday` | `FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=8` |
| `interval` / `until` / `count` / `exdates` | `INTERVAL` / `UNTIL` / `COUNT` / `EXDATE` |

注意 `COUNT` 与 `EXDATE` 的先后语义：RFC 5545 要求 **先按 COUNT 切片、再用 EXDATE 剔除**，
`src/domain/recurrence.js` 的展开器已按此实现，映射时必须保持。

## 三条值得记住的结论

1. **时间用 floating local time**。Twische 的领域模型是本地墙钟（`startTime: 'HH:mm'`），
   floating 语义天然吻合，且不需要生成 `VTIMEZONE`。
2. **保真写回**：解析时保留原始 ICS，写入时以它为模板只替换真正变化的属性行。
   否则第三方客户端挂的 `VALARM`（提醒）、`ATTENDEE`、`X-APPLE-*` 会被静默抹掉。
   这也是 `patch`（定点属性替换）无法用现成 iCal 库实现、必须自研的原因。
3. **`VEVENT` 无 `RRULE`（单次会议）在原模型里没有归宿**。当时打算新增
   `kind: 'once'`；该改动已随本方案一起撤回。

## 未解决的外部约束（当时调研到的）

- 浏览器跨域直连 CalDAV 需要服务器显式开 CORS（`Allow-Methods` 含 `PROPFIND`/`REPORT`、
  `Allow-Headers` 含 `Authorization`、`Expose-Headers` 含 `ETag`），iCloud / Google 基本无解。
- 拿不到 `ETag` 时只能退化为用 `calendar-data` 的内容哈希做版本标识。
- 引入标准客户端后，冲突必须从「服务端裁决」改为「ETag + 三方合并」，
  向量时钟无处安放（第三方客户端不会遵守）。

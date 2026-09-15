# Twische 组件库清单

> 盘点范围：`web/src` 全部 41 个源文件（21 个 `.vue` + 18 个 `.ts` + 2 个 `.css`）。
> 盘点方式：类名双向扫描（模板用到的 vs CSS 定义过的）+ 断点/字号/高度/圆角取值统计 + 逐文件元素清单 + 浏览器实测截图。
> 本文只列"需要哪些组件"，不含实现代码。

---

## 一、结论

现有界面里一共有 **12 个组件**、**116 处 `<button>`**、**540 个模板类名**，而其中真正被复用的组件只有 4 个
（`Icon` / `PageHead` / `OccurrenceItem` / `EmptyState`）。其余重复全靠"每个文件各写一份 scoped 样式"解决。

要支撑现在这套界面（并让它以后不继续劣化），需要 **52 个新组件**，合计 64 个。
其中有 **11 个是高优先级**，它们承担了当前绝大部分重复面积：

| 优先级 | 组件 | 直接消除的重复 |
| --- | --- | --- |
| P0 | `Btn` / `IconBtn` | 116 处 `<button>`；**11 套**各写一遍的方形图标按钮（15/20/22/28/30/32/34px） |
| P0 | `Seg` | 3 个文件在用，另有 2 套等价物（`tabs__btn`、`choice__btn`） |
| P0 | `Chip` | 6 个文件在用，`MonthView` 又自己定义了一份同名的 |
| P0 | `Cell` | 4 个文件在用，`MonthView`/`WeekView` 各定义一份 |
| P0 | `KindMark` | **6 处**重复绘制同一个"实心条 = 固定时段 / 空心圆 = 截止"的语义 |
| P0 | `ConfirmDialog` | 7 处 `window.confirm` |
| P0 | `Field` | 4 个文件各自实现"标签 + 控件 + 提示" |
| P0 | `BrandMark` | 三份手写的"T + 暮色点"（登录页 / 启动态 / 侧栏） |
| P1 | `Card` / `Section` | 至少 5 套"带标题的卡片容器" |
| P1 | `ListRow` / `ActionBar` | `TasksView` 与 `SettingsView` 各写一份，且 `.act` 是**逐行相同的复制** |
| P1 | `Toolbar` / `PageStage` | 5 处"带边框横条"、4 处"居中窄栏舞台" |

---

## 二、现状：已有组件（12 个）

| 组件 | 职责 | 需要补的东西 |
| --- | --- | --- |
| `Icon.vue` | 45 个描边图标，1.6 线宽 | 未知图标名现在**静默回退成时钟**（已加开发期告警）；需要尺寸档位与图标清单文档 |
| `Sheet.vue` | 弹窗 / 底部抽屉二合一，焦点管理、滚动锁定 | 缺尺寸档（现在只有固定 620px 用法）、缺 confirm 形态 |
| `ToastHost.vue` | 提示宿主，4 种语气 | `tone` 命名与 `SyncBadge`、`StatsView` 的 tone 不统一 |
| `EmptyState.vue` | 空态（含 compact） | 缺"无搜索结果 / 出错重试"变体 |
| `PageHead.vue` | 页面标题区（title + subtitle + meta + actions 插槽） | 已经是好范式，保留 |
| `OccurrenceItem.vue` | 一条日程（含 compact、完成打卡、跨天标记） | 需要补 `block`（周视图色块）变体 |
| `SyncBadge.vue` | 同步状态 5 态 + 手动同步 | 基本完备 |
| `AppShell.vue` | 三档响应式外壳（侧栏 / 图标轨 / 顶栏 + 底栏） | 528 行，需要拆出 NavItem/TabBar/Fab/Brand |
| `TimeField.vue` | 自绘时间选择（胶囊 + 时/分网格 + 键入 + 键盘微调） | 本次新增 |
| `DateField.vue` | 自绘日期选择（墨白日历 + 快捷项） | 本次新增 |
| `RecurrenceBuilder.vue` | 重复规则构建 | 949 行，需要内部拆分 |
| `TaskEditor.vue` | 任务编辑弹窗 | 505 行，表单部分应改为通用组件拼装 |

已有的基础设施：`usePopover`（本次新增）、`useNow`、`layoutBlocks`（周视图重叠分列算法）、
`ui` store（toast / 主题 / 偏好）、`styles/tokens.css`、`styles/base.css`。

---

## 三、盘点出的结构性事实（决定清单的依据）

| 事实 | 数据 | 含义 |
| --- | --- | --- |
| 按钮是最重的重复源 | 116 处 `<button>` / 13 个文件；`.btn--sm` ×13、`.btn--primary` ×12 | 按钮必须组件化，且尺寸档要收敛 |
| 图标按钮各写一遍 | `act`×2 / `nav-btn`×3 / `icon-btn` / `sheet-close` / `toast__close` / `search__clear` / `chip__x` / `stepper__btn` / `cmd__copy` / `pw-toggle` / `detail__add` / `cell__add` —— **11 套**，尺寸 15/20/22/28/30/32/34px | 需要 `IconBtn` |
| "选中"有三种叫法 | `is-on` ×32、`is-active` ×2、`is-selected` ×1 | 状态词汇必须先统一 |
| "紧凑"有两种叫法 | `oi--compact` / `empty--compact` / `compact` 属性 **vs** `tf--dense` / `df--dense` / `dense` 属性 | 统一为 `compact` 或 `dense` 之一 |
| 没有字号阶梯 | 20+ 种字号：9.5 / 10 / 10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 13.5 / 14 / 14.5 / 15 / 16 / 17 / 19 / 22 / 24 / 26 / 28 / 30px | 必须先定阶梯，否则组件内部还是会各写各的 |
| 没有控件高度阶梯 | 10 种：24 / 26 / 28 / 30 / 32 / 34 / 36 / 38 / 40 / 52px | 同上 |
| 间距令牌定义了但从未使用 | `--sp-1..8` 各被引用 1 次（即只有定义行本身） | 要么真正启用，要么删掉 |
| 断点是"差一像素"的成对写法 | 560 / 699+700 / 767+768 / 1023+1024 | 需要断点令牌，否则每个组件都要重猜 |
| 圆角有历史残留 | `var(--radius)` ×39、`50%` ×21、`999px` ×12，另有 1/2/3/5/9/10/14px 散值；`SettingsView` 用了**不存在的** `var(--radius-sm, 6px)` 静默回退 | 圆角令牌要补全并清理 |
| z-index 是裸数字 | 30(FAB) / 60(Sheet) / 72(Popover) / 90(Toast) / 95(更新条) | 需要 z-index 阶梯，否则新浮层一定打架 |
| 过渡动画名重复定义 | `fade` 在 `App.vue` 与 `RecurrenceBuilder.vue` 各定义一份 | 提取共享过渡集 |
| 卡片容器至少 5 套 | `.card`(全局) + StatsView `panel*` + SettingsView `group*` + MonthView `card`/`detail*` + NotInitializedView `init__card` | 需要 `Card` / `Section` |
| 页面翻页按钮 ×3 | `nav-btn` 在 `TodayView` / `WeekView` / `MonthView` 各写一份 | 需要 `PagerNav` |
| 当前时刻线 ×2 | `TodayView.now-line*` 与 `WeekView.nowline*` | 需要 `NowLine` |
| 原生 confirm ×7 | `editor.ts:82`、`TaskEditor:205`、`SettingsView:89/94/117/122`、`TasksView:80` | 需要 `ConfirmDialog` |
| 原生 title 提示 ×23 | 全站 | 见"明确不做"一节 |
| 完全没有的表单类型 | 无 `<table>`、无 checkbox/radio/range、无 `<details>`、无 `<dialog>` | 组件库不需要这些 |

### 3.1 类名撞车（会直接决定组件库的命名方案）

同一个类名在"全局原子层"和"视图局部"表达**完全不同的东西**，现在靠 scoped 的
`[data-v-*]` 属性选择器提高特异度硬压过去。一旦把这些原语提升为全局类（就像这次
`.seg`/`.cell` 那样），视图会被静默改坏：

| 类名 | 全局层含义 | 视图局部含义 |
| --- | --- | --- |
| `.cell` | 32px 选择器小格（DateField / TimeField / RecurrenceBuilder 在用） | `MonthView` 的日期格：`min-height:104px`、无边框、`is-out`/`is-selected` |
| `.chip` | 999px 描边胶囊（标签、快捷项） | `MonthView` 的格内条目行：2px 圆角、无边框、带形状标记 |
| `.grid` | 无 | `WeekView` 周网格（`min-width:720px`）**vs** `MonthView` 月网格（`repeat(7,1fr)`） |
| `.wd` | 无 | `MonthView` 静态表头行 **vs** `RecurrenceBuilder` 可点周几按钮 |

**结论**：组件库的类名必须带命名空间（例如统一 `ui-` 前缀），或者组件样式完全封闭、
不依赖任何全局原子类。这是"地基批次"必须先定的事。

### 3.2 死代码与"抽了但没人用"

| 位置 | 问题 |
| --- | --- |
| `WeekView` | `.head__day.is-today`、`.allday__cell.is-weekend` 只绑定 class，**没有任何 CSS 规则** |
| `MonthView` | `.cell.is-today`、`.wd__cell.is-weekend` 同上；`.grid-wrap` 全文件**零规则**，纯匿名容器 |
| `OccurrenceItem` | `compact` 变体连同样式（含 14px 打卡圈等）**全站无人传参**；`WeekView` 宁可手绘 90 行 `.block` 样式取代它 |
| `tokens.css` | `--sp-1..8` 定义齐全但**零引用** |
| `SettingsView.elevate__input` | 同时引用了 **三个都不存在**的令牌：`var(--bg-sunk, transparent)`、`var(--radius-sm, 6px)`、`var(--accent, currentColor)` —— 全部静默回退 |
| `base.css` 表单选择器 | input 的类型白名单只有 `text/password/time/date/datetime-local/number`，**漏了 `search`**，导致 TasksView 的搜索框要整段重置边框与背景 |
| `data-tone` vs `data-kind` | 同一套语气词汇两种属性名：`SyncBadge[data-tone]`、`SettingsView.tone[data-tone]`、`ToastHost[data-kind]` |
| `TasksView.toggle` | 用了 `.is-on` 表示开，但**漏了 `aria-pressed`**（同页的 `.seg__item` 写了） |
| `App.vue` / `LoginView` | `.boot__mark`、`.auth__mark`、`AppShell.brand__mark` 是同一图案的三份手写，尺寸 56/52/32/26 各不同 |

`OccurrenceItem.compact` 这条尤其值得记：它证明"抽了组件"不等于"组件会被用"。
组件库的每一批都必须带**迁移验收**（旧实现删除、无残留 CSS），否则只会再加一层。

### 3.3 同一语义的多套数值（组件 API 必须把它们收敛成档位）

| 语义 | 现有实现 | 差异 |
| --- | --- | --- |
| 页头副标题 | `PageHead.ph__sub` / `WeekView.range` / `MonthView.detail__sub` | 13px `--mut` mt4 / 13px `--faint` mt3 / 12px `--faint` mt2 |
| 底部脚注 | `WeekView.foot-hint` / `MonthView.foot` / `TasksView.foot` | mt10·11.5px / mt10·11.5px / mt12·11.5px |
| "今日"标记 | `WeekView.head__num.is-today` / `MonthView.cell__day.is-today` | 24px 正圆 / 19px 高胶囊 |
| 方形图标按钮 | `nav-btn` / `detail__add` / `cell__add` | 32 有边框 / 28 有边框 / 20 无边框 |
| "固定=竖条 / 截止=空心圆" | `oi__rule`、`block`、`allday__chip`、`legend__bar+dot`、`chip__mark`、`sec-dot` | **6 处各画一遍**，竖条宽 2/3px、圆点 6/7px |
| 当前时刻线 | `TodayView.now-line`（点+线+标签）/ `WeekView.nowline`（1.5px 覆盖线）/ `legend__now` | **3 处** |
| 过渡时长 | 0.12s / 0.14s / 0.15s 混用 | 同一交互三种速度 |
| 列表壳 | `TodayView.alert-list`(×3) / `MonthView.detail__list` | `gap:1px` 相同，padding/overflow 不同 |
| 分区标题 | `TodayView.sec-head`（**文件内 4 次**） / `SettingsView.group__head` | 12px sans 大写 vs 14.5px serif 900 |

---

## 四、组件清单

编号用"层 + 序号"（A1、B3…），方便单独引用某一项。
命名沿用现有的 BEM 风格（`块__元素--修饰符`），组件名用大驼峰。
"证据"列写的是这个组件要替掉的现状位置。

### A. 基础原子（12 个）

| # | 组件 | 职责 | 变体 / 关键 props | 证据 |
| --- | --- | --- | --- | --- |
| A1 | `Btn` | 按钮 | `variant`: primary / default / ghost / **link**（TodayView `.link-btn`）/ **dashed**（TodayView `.add-row`）/ danger；`size`: sm / md；`block`；`loading`；`icon` | `.btn` + 4 修饰符，13 文件 116 处；另有 `.link-btn`、`.add-row` 两个"其实也是按钮"的独立实现 |
| A2 | `IconBtn` | 纯图标按钮（正方形、可达名称必填） | `size`: xs(20) / sm(28) / md(32) / lg(36)；`variant`: plain / outline / muted；`label`(必填)；`revealOnHover`（MonthView `.cell__add` 的隐式显示） | `act`(30×2 文件) / `nav-btn`(32×3 文件) / `icon-btn`(34) / `sheet-close`(32) / `detail__add`(28) / `cmd__copy`(28) / `pw-toggle`(30) / `toast__close`(22) / `search__clear`(20) / `chip__x`(15) / `df__nav`(28) —— **11 套手写** |
| A3 | `Seg` | 分段控件（互斥选项） | `modelValue`、`options`、`size`、`block`、`ariaLabel` | `.seg`（RecurrenceBuilder / TaskEditor / TasksView）+ `SettingsView.tabs__btn`、`SettingsView.choice__btn` 两套等价物 |
| A4 | `Chip` | 胶囊 | `clickable`、`selected`、`removable`、`mark`(dot/bar/none)、`size` | `.chip` 6 文件；`--btn/--on/--deadline/--more`；MonthView 另有一份同名不同物的 |
| A5 | `Cell` | 网格里的可点方块（日期/小时/分钟/月份/星期共用） | `selected`、`today`、`muted`、`weekend`、`size` | `.cell` 4 文件；MonthView `cell`(9 行) + `wd__cell`；WeekView `allday__cell` |
| A6 | `Stepper` | 数量步进（− 数字 +） | `modelValue`、`min`、`max`、`step`、`suffix` | 本次新增，RecurrenceBuilder 2 处 |
| A7 | `Badge` | 文字徽标 | `tone`: neutral / ok / warn / danger；`solid`（`dev__badge` 实心 / `row__badge` 描边）；`size` | `row__badge`、`dev__badge`(+`--quiet`)、`head__badge`、`sec-count` |
| A8 | `TagPill` | 标签 | `removable` | `oi__tag`、`row__tags`、TaskEditor 的 `chip--on` |
| A9 | `PriorityDot` | 优先级点（实心点大小 + 一抹暮色，不引新颜色） | `level`: 0/1/2；`withText`（TasksView 的"紧急"文字版） | `oi__pri` 与 `row__pri` **规则逐字相同**，各写一份 |
| A10 | `KindMark` | **形状语义**：实心竖条 = 固定时段，空心圆 = 截止 | `kind`: fixed / deadline；`size`；`orientation` | `oi__rule`、`row__mark`、`block`/`block--deadline::before`、`allday__chip`、`legend__bar`+`legend__dot`、`chip__mark` —— **6 处** |
| A11 | `BrandMark` | 品牌标记（墨色方块 + 衬线 T + 右下暮色点） | `size`: sm(26) / md(32) / lg(52) / xl(56)；`pulse`（启动态动画） | `AppShell.brand__mark`(32/26) / `LoginView.auth__mark`(52) / `App.boot__mark`(56+脉冲) —— **三份手写** |
| A12 | `Spinner` | 加载指示 | `size` | `SyncBadge` 的 `@keyframes spin` |

### B. 表单（9 个）

| # | 组件 | 职责 | 变体 / 关键 props | 证据 |
| --- | --- | --- | --- | --- |
| B1 | `Field` | 字段壳：标签 + 控件 + 提示 + 错误 | `label`、`hint`、`error`、`for`、`layout`: stack / inline（64px 标签列） | `.field`/`.label`（全局）；提示各写各的：`te__hint`、`rb__hint`、`hint`、`group__desc`、`mismatch` |
| B2 | `TextInput` | 文本输入 | `size`、`disabled`、`invalid`、前缀图标插槽、后缀插槽（清除/眼睛） | 原生 input + 全局样式；`pw-wrap`/`pw-input`/`pw-toggle`、`tags__input`、`dev__input`、`elevate__input`、`init__pw-row` 各写一遍 |
| B3 | `Textarea` | 多行输入 | `rows`、`maxlength`、字数提示 | `TaskEditor` 备注 |
| B4 | `Select` | 下拉（原生外观收敛） | `modelValue`、`options`、`placeholder`、`size` | `TasksView.tag-select`（唯一一处，仍单独写了 8 行样式） |
| B5 | `SearchInput` | 搜索框（含清空） | `modelValue`、`placeholder`、`loading` | `TasksView.search`；注意 base.css 的 input 选择器**不含 `type="search"`**，所以它不得不整段重置 |
| B6 | `TagInput` | 标签录入 + 建议 | `modelValue`、`suggestions`、`max`、`maxlength` | `TaskEditor.tags` / `tags__input` / 候选胶囊 |
| B7 | `Toggle` | 布尔开关（开关式按钮） | `modelValue`、`label`、`icon`、`size` | `TasksView.toggle`（已归档）、`SettingsView.choice__btn`；两者几乎相同却各写一份，且 `.toggle` **漏了 `aria-pressed`** |
| B8 | `TaskCheck` | 完成打卡圆钮（勾选态为实心圆） | `checked`、`size`、`disabled` | `OccurrenceItem.oi__check` |
| B9 | `CheckList` | 校验清单（通过/未通过两态） | `items: {ok, text}[]` | `SettingsView.hints` / `hints li.is-ok`（密码强度三条规则） |

> 说明：`DateField` / `TimeField` 已实现，归入本层。

### C. 反馈与浮层（5 个）

| # | 组件 | 职责 | 变体 / 关键 props | 证据 |
| --- | --- | --- | --- | --- |
| C1 | `Popover` | 浮层壳（定位、点外关闭、Esc、滚动重定位） | `trigger` 插槽、`width`、`placement`；内部用已有的 `usePopover` | `DateField`/`TimeField` 各自复制了 `pop-layer`/`pop-panel`/`pop-head`/`pop-title`/`pop-label`/`pop-foot` 模板 |
| C2 | `ConfirmDialog` + `useConfirm` | 确认弹窗，返回 `Promise<boolean>` | `title`、`message`、`confirmText`、`danger`、`requireText`（移除设备这类高危操作） | **7 处 `window.confirm`** |
| C3 | `ProgressBar` | 进度条 / 比例条 | `value`、`max`、`tone`、`size`(sm 8px / lg 10px)、`label` | `StatsView.lines__track/__fill`（任务类型、标签分布、本周完成率三处共用） |
| C4 | `BarChart` | 柱状图（含灰色底柱） | `data: {label, value, highlight}[]`、`columns` | `StatsView.bars` / `bars--7` / `bars__col` / `bars__track`（未来 7 天 + 每周节奏两处同构） |
| C5 | `StatCard` | 指标卡 | `label`、`value`、`unit`、`foot`、`tone`、`alert` | `StatsView.stat` / `stat__value` / `stat__label` / `stat__foot` / `.is-alert` |

### D. 布局与导航（17 个）

| # | 组件 | 职责 | 变体 / 关键 props | 证据 |
| --- | --- | --- | --- | --- |
| D1 | `Card` | 卡片壳 | `padding`、`flat`、`hoverable`、`sticky`（MonthView 详情面板） | `.card`（全局）；`StatsView.card stat` / `panel card`、`SettingsView.card group`(13 处)、`MonthView.detail.card`、`TaskEditor.te__group` |
| D2 | `Section` | Card + 标题 + 描述 + 脚注（设置页的基本单元） | `title`、`desc`、`foot`、`flush` | `SettingsView.group*`(5 个类)、`StatsView.panel*`(4 个类)、`MonthView.detail*`(7 个类)、`Sheet.sheet-head*` |
| D3 | `SectionHead` | 分区标题行（标题 + 可选圆点 / 计数 / 右侧动作） | `title`、`dot`、`count`、`tone`(dusk)、`actions` 插槽 | `TodayView.sec-head`+`.sec-title` **文件内 4 次**；`SettingsView.group__head` 是同一结构的另一套数值 |
| D4 | `AlertBlock` | 告警/错误提示块（左侧暮色竖条 + 暮色底） | `tone`、`title`、`count`、默认插槽、`inline`（SettingsView 的单行版） | `TodayView.alert-block`、`SettingsView.error-line`、`ToastHost` 的 error 语气 —— **同一视觉写了三处** |
| D5 | `ListRow` | 列表行：左标记槽 + 主区 + 右侧操作 | `mark`、`title`、`meta`、`actions`、`interactive`、`disabled`、`revealActions` | `TasksView.row`(7 行样式) **与** `SettingsView.dev` 同构各写一份；`events__row` 是第三处 |
| D6 | `ListShell` | 紧贴列表容器（`flex column; gap:1px`） | `divided`、`scrollable`、`padding` | `TodayView.alert-list`（文件内 3 次）、`TasksView.list`、`SettingsView.devices`/`events`、`MonthView.detail__list`、`AppShell.nav` |
| D7 | `ActionBar` | 行内操作按钮组 | `danger`、`size`、`revealOnHover` | `act` / `act--danger` 在 `TasksView` 与 `SettingsView` **逐行相同的纯复制** |
| D8 | `KeyValueList` | 「标签 — 值」行列表 | `items`、`layout`: row / column | `SettingsView.kv` / `kv__row`（同一套类在 4 个分组里复用 23 行） |
| D9 | `StepList` | 编号步骤指引 | `steps: {title, desc, body}[]` | `NotInitializedView.steps` / `step` / `step__no` |
| D10 | `CommandBlock` | 命令行 + 复制按钮 | `command`、`label`、`copyable` | `NotInitializedView.cmd` / `cmd__text` / `cmd__copy`；另有 `App.fatal__hint code`、`init__warn code` 两处同款内联代码 |
| D11 | `Footnote` | 页面/区块底部说明文字 | `align`、`tone` | `WeekView.foot-hint` / `MonthView.foot` / `TasksView.foot` / `LoginView.auth__note` / `SettingsView.note` —— 同构五份 |
| D12 | `Form` | 竖排表单容器（统一间距） | `gap`、`maxWidth`、`@submit` | 四处只差间距：`SettingsView.form`(14) / `LoginView.auth__form`(16) / `NotInitializedView.elevate`(12) / `TaskEditor.te`(18) |
| D13 | `Toolbar` | 横向工具条（带上下边框的 flex 行） | `bordered`: top / bottom、`wrap`、插槽 | `TasksView.bar` / `SettingsView.tabs` / `WeekView.legend` / `StatsView.data-note` / `StatsView.week-done` —— 五处同一模式 |
| D14 | `PagerNav` | 页头翻页（‹ 今天 ›） | `label`、`onPrev`、`onNext`、`onToday`、`atEdge` | `nav-btn` 在 `TodayView`/`WeekView`/`MonthView` **逐字节相同 3 份** |
| D15 | `PageStage` | 居中舞台 + 窄栏内容列（登录/初始化/致命错误/启动） | `width`: sm(380) / md(620) / lg(30rem) | `LoginView.auth`+`auth__card`、`NotInitializedView.init`+`init__card`、`App.fatal`+`fatal__box`、`App.boot` —— 四份同构 |
| D16 | `NavList` / `NavItem` | 侧栏与图标轨导航 | `items`、`active`、`collapsed` | `AppShell` 内联（528 行） |
| D17 | `TabBar` / `Fab` | 手机底部标签栏 + 悬浮新建按钮 | `items`、`active`、`onCreate` | `AppShell` 内联 |

### E. 领域组件（9 个 + 1 组内部拆分）

| # | 组件 | 职责 | 变体 / 关键 props | 证据 |
| --- | --- | --- | --- | --- |
| E1 | `EventBlock` | 周视图时间网格里的色块（含重叠分列） | `col`、`cols`（来自 `layoutBlocks`）、`spills`、`done`、`overdue`、`deadline`、`height` | `WeekView.block` 及 5 个变体，**90 行手绘样式**，是 `OccurrenceItem` 的手绘复制 |
| E2 | `EventChip` | 网格/列表里的单行日程芯片（形状标记 + 省略号标题） | `kind`、`done`、`overdue`、`dense`（手机端只留形状标记） | `MonthView.chip`+`__mark`+`__text`+`--deadline`+`--more` **与** `WeekView.allday__chip` 几乎同款，两处各写一遍 |
| E3 | `DayCell` | 月视图日期格（含日程芯片与"更多"） | `date`、`inMonth`、`today`、`weekend`、`selected`、`items`、`maxVisible` | `MonthView.cell*` 5 个类；另有 2 个只绑定 class 没有 CSS 的死钩子 |
| E4 | `MonthGrid` | 月视图 6×7 网格 + 星期表头 | `anchor`、`weekStart`、`cell` 插槽 | `MonthView.grid` / `wd` / `wd__cell`（`.wd` 与 RecurrenceBuilder 撞名） |
| E5 | `WeekGrid` + `HourGutter` | 周视图网格：粘性表头 + 24 小时刻度 + 7 列画布 | `anchor`、`weekStart`、`hourHeight`、`compact` | `WeekView.grid` / `head*` / `body` / `gutter*` / `col`（同一列模板值写了 6 遍） |
| E6 | `AllDayRow` | 全天/跨天日程行 | `items`、`visible` | `WeekView.allday*`（只有存在全天项时整行才渲染） |
| E7 | `NowLine` | 当前时刻线 | `minutes`、`variant`: inline(点+线+标签) / overlay(1.5px 覆盖线) | `TodayView.now-line*` 与 `WeekView.nowline*` **两套实现 + 1 个图例缩略，共 3 处** |
| E8 | `TimelineSection` | 今日分组段（标题 + 计数 + 逾期块 + 续接 + 添加行） | `title`、`count`、`tone`、`items`、`empty` | `TodayView.sec-head` / `alert-block` / `continuation` / `all-day` / `add-row` |
| E9 | `Legend` | 图例（形状 + 当前时刻线说明） | `items` | `WeekView.legend*`；三个色板是 `KindMark` / `NowLine` 的缩略复制 |
| — | `RecurrenceBuilder` 内部拆分 | 现在 949 行，拆为 `FrequencyPicker` / `WeekdayPicker` / `MonthdayGrid` / `NthWeekdayPicker` / `DurationPicker` / `EndConditionPicker` | 内部结构，不对外 | —— |

**合计：12 个已有组件 + 52 个新组件 = 64 个。**

> 已知缺口：`WeekView` 是唯一**没有任何空态**的视图（空周只渲染 24 行刻度和 7 条空列），
> 而 `EmptyState` 已经存在——这是"组件有了但没铺开"的又一例。
> `WeekView` 715 行、`MonthView` 586 行、`TasksView` 551 行、`SettingsView` 1091 行，
> 拆分后都应落到 200 行以内。

---

## 五、明确**不**做的组件（避免过度设计）

| 不做 | 理由 |
| --- | --- |
| 通用 `Table` | 全站 0 个 `<table>`，列表需求用 `ListRow` 表达 |
| `Checkbox` / `Radio` / `Slider` | 全站 0 处原生用法；互斥选项由 `Seg`/`Chip` 承担，完成态由 `TaskCheck` 承担 |
| 自绘 `Tooltip` | 23 处原生 `title` 已能工作、无障碍免费、不动手就没有定位/触屏坑。只对**纯图标按钮**用 `IconBtn.label` 保证可达名称 |
| `Skeleton` 骨架屏 | 本地优先架构（IndexedDB 即数据源），首屏没有网络等待 |
| `DatePicker` 的完整版（时间区间/多选/预设面板） | 现有 `DateField` + `TimeField` 已覆盖全部真实用法 |
| `Tabs` 通用页签 | 只有设置页一处，用 `Seg` 的 `block` 变体即可 |
| 虚拟滚动 | 单用户日程数据量（当前 3 条、目标上限千级）不需要，先不加复杂度 |
| 主题切换器组件 | 只有 AppShell 一处，保留内联 |

---

## 六、必须先补的设计令牌（否则组件会各写各的）

| 令牌 | 现状 | 建议 |
| --- | --- | --- |
| 字号阶梯 | 20+ 种散值 | `--fs-xs 11` / `--fs-sm 12` / `--fs-md 13` / `--fs-base 14` / `--fs-lg 16` / `--fs-xl 19` / `--fs-2xl 24`（标题继续用 clamp） |
| 控件高度 | 10 种 | `--ctl-xs 24` / `--ctl-sm 30` / `--ctl-md 34` / `--ctl-lg 38` / `--ctl-xl 44` |
| 间距 | `--sp-1..8` 已定义但 0 使用 | 组件内部一律改用 `--sp-*`，或删除令牌（二选一，别留着误导） |
| 圆角 | 缺 `--radius-sm`（`SettingsView` 已在用不存在的它） | 补 `--radius-sm: 3px`，并清理 1/2/5/9/10/14px 散值 |
| 缺失令牌 | `--bg-sunk`、`--accent` 也被引用但不存在 | 要么补上，要么把引用改掉——**留着一堆静默回退的 `var()` 比硬编码更危险** |
| z-index | 裸数字 30/60/72/90/95 | `--z-fab 30` / `--z-sheet 60` / `--z-popover 70` / `--z-toast 90` / `--z-banner 95` |
| 断点 | 560 / 699+700 / 767+768 / 1023+1024 | 统一为 560 / 700 / 768 / 1024（并修掉成对写法） |
| 动效时长 | 0.12 ~ 0.28s 散值 | `--dur-fast 140ms` / `--dur-base 180ms` / `--dur-slow 260ms` |
| 语义色 | `--dusk` 一色多用（逾期 / 跨天 / 警告 / 危险按钮） | 保持单色，但在组件层明确"何时允许用暮色"：仅逾期、跨天、危险操作 |

---

## 七、目录结构与分发方式（需要你拍板）

**方案甲（推荐，改动最小）**：组件库留在应用内，但立起明确边界

```
web/src/ui/
  tokens.css        设计令牌（吸收现有 tokens.css，补齐上表）
  base.css          原子类 / 重置（保留）
  index.ts          统一出口，视图只从 '@/ui' 导入
  components/       A~E 五层组件
  composables/      usePopover / useNow / useConfirm / useMediaQuery
  transitions.css   共享过渡（fade / pop / sheet / toast / page）
```

**方案乙**：抽成 monorepo 独立包 `packages/ui`

- 好处：边界由工具强制、未来可给别的项目用
- 代价：要加构建产物、类型声明、workspace 配置；当前只有 web 一个消费方，收益暂时为零
- 建议：**等第二个消费方出现再升级**，甲方案的目录结构可以无痛平移到乙方案

无论哪种，都必须配一个**组件预览台**：项目没有 Storybook，建议加一条隐藏路由 `/dev/ui`
（复用现有 router，vite 生产构建时不打包），一页展示所有组件的全部变体与状态。
没有它，组件库一定会在两个月内退化成"另一堆没人敢改的 CSS"。

---

## 八、落地顺序（每批都能独立验收）

| 批次 | 内容 | 验收标准 |
| --- | --- | --- |
| **0. 地基** | 定命名空间（解决 4 处类名撞车）；补字号/高度/z-index/断点/圆角令牌；清掉三个不存在的 `var()`；`--sp-*` 要么启用要么删；统一 `is-on`/`is-active`/`is-selected` 与 `compact`/`dense`；`tone`/`kind` 二选一 | `npm run typecheck` + `build` 通过；六个视图浅色/暗色/手机端截图无回归 |
| **1. 原子** | `Btn` `IconBtn` `Seg` `Chip` `Cell` `KindMark` `BrandMark` `Stepper` `Badge` `TagPill` `PriorityDot` `Spinner` | 替换 `TasksView`/`TaskEditor`/`MonthView`/三个日历页头；删掉 `nav-btn`×3、`.act`×2、`brand__mark`×3 等重复 CSS |
| **2. 表单** | `Field` `TextInput` `Textarea` `Select` `SearchInput` `TagInput` `Toggle` `TaskCheck` `CheckList` `Form` | `TaskEditor`/`LoginView`/`SettingsView` 不再出现裸 `<input>`；`input[type=search]` 的漏洞被组件吸收 |
| **3. 浮层** | `Popover` 壳、`ConfirmDialog` + `useConfirm`、`AlertBlock` | 7 处 `window.confirm` 归零；`DateField`/`TimeField` 改用 `Popover`；三处"暮色左竖条提示"合一 |
| **4. 布局** | `Card` `Section` `SectionHead` `ListRow` `ListShell` `ActionBar` `KeyValueList` `StepList` `CommandBlock` `Footnote` `Toolbar` `PagerNav` `PageStage` | `SettingsView` 从 1091 行降到 400 行以内；`TasksView` 551 → 300 以内 |
| **5. 领域** | `EventBlock` `EventChip` `DayCell` `MonthGrid` `WeekGrid` `AllDayRow` `NowLine` `TimelineSection` `Legend` | 三个日历视图共用同一套格子与时刻线；`WeekView` 715 → 300 以内并补上空态 |
| **6. 图表** | `ProgressBar` `BarChart` `StatCard` | `StatsView` 只剩数据计算，没有样式 |
| **7. 预览台** | `/dev/ui` 隐藏路由 | 64 个组件的所有变体与状态可在一页看完 |

**验收通则**：每一批结束时必须做到"旧实现已删除"——`inventory.mjs` 里该类的"多处定义一份"
条目归零，否则只是又叠了一层。

---

## 九、需要你决定的三件事

1. **分发方式**：方案甲（应用内 `web/src/ui/`）还是方案乙（`packages/ui` 独立包）？
2. **依赖策略**：维持零运行时依赖（自研，全部走 CSS 变量 + 组合式函数），还是允许引入 headless 库
   （如 `reka-ui`）？后者能省掉浮层定位/焦点陷阱的实现成本，但会打破当前"单文件内嵌、离线优先"的干净度。
3. **样式策略**：组件是否允许接收外部 `class` 覆盖（现在 `Sheet`/`PageHead` 的做法是插槽 + `:deep()`），
   还是改为 props 驱动的封闭组件？这决定了每个组件的 API 表面有多大。

---

### 附：盘点脚本

本文数据可用仓库内的脚本复现：

```
node .workbuddy/inventory.mjs   # 类名双向扫描：用了没定义 / 多处各定义一份
node .workbuddy/perfile.mjs     # 逐文件元素清单（模板类名 + CSS 定义行数）
```

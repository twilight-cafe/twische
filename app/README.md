# Twische 安卓外壳

把 `../dist` 里的静态页面装进 WebView，并额外提供一个**状态栏常驻通知**的前台服务。

## 为什么需要它

「有逾期或今天还没做完的事，就挂在状态栏上」这件事，纯网页做不到：

| 手段 | 能不能常驻状态栏 | 能不能在页面被划掉后继续 |
| --- | --- | --- |
| 浏览器 Web 通知 | 不能，用户一划就没 | 不能，没有任何 JS 在跑 |
| 后台同步 / 定时器 | —— | 不能，浏览器会冻结 |
| Web Push | 可以 | 可以，**但需要一个推送服务器** |
| **原生前台服务** | **可以，且不可划掉** | **可以，进程由系统保活** |

本项目的架构约定是"没有自建后端"，所以 Web Push 出局，只剩原生前台服务。
这就是这层外壳存在的唯一理由 —— 界面代码一行都没有重写。

## 结构

```
app/
├── capacitor.config.json      # webDir 指向 ../dist
├── package.json               # 只装 Capacitor，无其它依赖
├── scripts/serve-dist.mjs     # 本地起静态服务器，用于浏览器端自测
└── android/                   # Capacitor 生成 + 本项目新增的 3 个类
    └── app/src/main/
        ├── AndroidManifest.xml                    # 服务/权限/开机广播声明
        ├── java/cn/twilightcafe/twische/
        │   ├── MainActivity.java                  # 唯一的 Activity，注册插件
        │   ├── NotifyPlugin.java                   # 网页 ↔ 原生的桥
        │   ├── NotifyService.java                  # 前台服务，负责显示
        │   └── BootReceiver.java                   # 开机后恢复通知
        └── res/drawable/ic_notify.xml              # 状态栏图标（纯白矢量）
```

### 职责划分

**内容由网页算，原生只负责显示。**

原生侧不持有任何日程数据，它只接收一段**已经渲染好的文本**：

```json
{
  "id": 1,
  "tag": "twische.today",
  "title": "2 项逾期 · 今日还剩 3 项",
  "body": "09:00  晨会\n21:00  写周报\n…还有 1 项",
  "count": 5,
  "active": true
}
```

这样划分的理由是重复规则展开、向量时钟合并这些逻辑都在网页里，
在原生侧重算等于把领域逻辑实现第二遍，两边一旦不一致就会显示过期内容。
原生侧只做三件事：申请权限、把文本转交给服务、撤掉通知。

## 构建

前置：JDK 17+、Android SDK（platform 36 / build-tools 36）。

三步固定动作，debug / release 都一样：

```bash
# 1. 先构建网页（外壳只是把它装进去）
cd ..            # 仓库根
npm run build

# 2. 同步进 Android 工程（拷贝 dist/ + 生成插件清单）
cd app
npx cap sync android

# 3. 打包
cd android
./gradlew assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` 里的 `sdk.dir` 指向本机 SDK；这个文件不进版本库。

**改了网页一定要重跑第 1、2 步。** `cap sync` 把 `../dist` 拷进
`android/app/src/main/assets/public/`，只跑 `gradlew` 打出来的是上一次的页面。

### Release 构建（自签名）

Release 需要一个签名密钥，配置一次即可长期复用。
没配密钥时构建**不会报错**，但产物是未签名的包，装不上设备（详见第 3 步）。

#### 1. 生成密钥库（只做一次）

```bash
cd app/android
keytool -genkeypair -v \
  -keystore twische-release.jks \
  -alias twische \
  -keyalg RSA -keysize 4096 -validity 10950 \
  -storepass <你的口令> -keypass <你的口令> \
  -dname "CN=Twische, OU=personal, O=twilightcafe, C=CN"
```

- `-validity 10950` 是 30 年。自签名侧载对有效期没有硬性要求
  （实测 1 年期的密钥也能正常打包安装），但**上架 Google Play 要求证书至少有效到
  2033-10-22**；一次生成到位就不用再管它。
- `keytool` **要求口令至少 6 个字符**，短了会直接
  `Key password must be at least 6 characters` 并且**不生成文件**。
- `-dname` 随便填，自签名证书不进任何信任链，只用来标识"同一把钥匙"。

#### 2. 写 `app/android/keystore.properties`

`storeFile` 相对 `app/android/` 解析：

```properties
storeFile=twische-release.jks
storePassword=<你的口令>
keyAlias=twische
keyPassword=<你的口令>
```

#### 3. 打包

```bash
cd app/android
./gradlew assembleRelease      # → app/build/outputs/apk/release/app-release.apk
```

`app/build.gradle` 会自动读取 `keystore.properties` 并接上签名配置。

**没有密钥时构建照样报 `BUILD SUCCESSFUL`**，但产物叫
`app-release-unsigned.apk`（少了 `-unsigned` 才是签好名的那个）。
未签名的包 `apksigner verify` 会直接报
`DOES NOT VERIFY / Missing META-INF/MANIFEST.MF`，装到设备上会被拒。
看到文件名带 `-unsigned` 就说明密钥没被读到——回头检查第 2 步。

#### 密钥的保管

`twische-release.jks` 与 `keystore.properties` 都已被
`app/android/.gitignore` 排除（`*.jks` / `keystore.properties`），**不要提交**。

**换机器构建时要把这两个文件一起搬过去。** 签名不同会导致覆盖安装失败，
必须先卸载旧版——而卸载会清掉应用数据（本地 IndexedDB 里的日程缓存）。
数据本体在 WebDAV 上不会丢，重新连接后会同步回来，
但"记住的密码"和本机设置需要重配。

#### 校验产物

```bash
# 签名是否有效、用了哪种签名方案
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs \
  app/build/outputs/apk/release/app-release.apk

# 4 字节对齐（影响安装后的内存占用）
$ANDROID_HOME/build-tools/36.0.0/zipalign -c 4 \
  app/build/outputs/apk/release/app-release.apk

# 权限与前台服务类型是否符合预期
$ANDROID_HOME/build-tools/36.0.0/aapt2 dump badging \
  app/build/outputs/apk/release/app-release.apk | grep uses-permission
```

本项目实测产出的是 **v2 签名**（`apksigner` 报 `v1 scheme: false`）。
这是对的：v2 从 API 24 起受支持，而 `minSdk` 就是 24；
v1（JAR）签名只对 API 23 及以下有意义。

### 产物

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `app/build/outputs/apk/release/app-release.apk` | ~3.6 MB | 自签名，直接装 |
| `app/build/outputs/apk/debug/app-debug.apk` | ~4.8 MB | 调试用，可 `chrome://inspect` |

### 装机

```bash
adb install -r app/build/outputs/apk/release/app-release.apk
```

`-r` 是覆盖安装，保留数据。**只有签名一致时才有效**——
换过密钥库的话先 `adb uninstall cn.twilightcafe.twische`（会清数据）。

## 必须先配服务器：CORS 允许列表

WebView 里的页面源是 `https://localhost`，对 WebDAV 的请求是跨域的。
服务器的 `cors_domains` 里**必须有这一条**，否则壳装上去和浏览器里一样连不上：

```json
{
  "users": [
    {
      "name": "test",
      "cors_domains": [
        "https://localhost",
        "http://localhost:3080",
        "http://localhost:5273"
      ]
    }
  ]
}
```

- `https://localhost` —— 安卓壳（Capacitor 的 `androidScheme: https`）
- `http://localhost:3080` —— 浏览器端自测（本项目实测用这个端口通过全部校验）
- `http://localhost:5273` —— `npm run dev` 的默认端口

改完重启 `webdavd`，然后用一条命令验证：

```bash
curl -s -D - -o /dev/null -X OPTIONS \
  -H 'Origin: https://localhost' \
  -H 'Access-Control-Request-Method: PROPFIND' \
  -H 'Access-Control-Request-Headers: authorization,depth' \
  https://你的服务器/ | grep -i access-control
```

四个头（`allow-origin` / `allow-methods` / `allow-headers` / `expose-headers`）
一个都不能少 —— 漏掉 `expose-headers: ETag` 只是同步效率变差，
漏掉另外三个里的任何一个都是"完全连不上"。

## 自测脚本

```bash
# 线上 WebDAV 自检（在仓库根跑）——不必起浏览器，不打 Origin 之外的花样
node tools/dav-selftest/index.mjs --url https://你的服务器/ --user test --pass '...'

# 浏览器端真实链路（需要本机有 chromium；playwright-core 已是 app 的 devDependency）
cd app && npm install          # 首次
node scripts/browser-check.mjs --url https://你的服务器/ --user test --pass '...'
# 或者：npm run check:browser -- --url ... --user ... --pass ...

# 只起静态服务器，自己用浏览器点
node app/scripts/serve-dist.mjs --port 3080
```

**`tools/dav-selftest/index.mjs`** 用 `src/cli/target.mjs`（零依赖的 Node 侧 WebDAV 实现）
打真实服务器，并给**每个请求都加上 `Origin` 头**——这正是浏览器会做、而 curl 不会做的事。
覆盖 MKCOL / PUT / GET / PROPFIND+ETag / DELETE、预检的四个 CORS 头，
以及"重跑幂等"。写入用 `selftest-` 前缀的 id，跑完即删。
它也会顺手探测服务器是否做了源白名单：允许所有源（`cors_domains: ["*"]`）
是**功能上完全够用**的配置，所以只提示、不判失败。

**`browser-check.mjs`** 是**只读**验证：不会写任何数据到服务器。
它用 `playwright-core` 驱动本机 chromium；`CHROME_PATH` 环境变量可以指定浏览器路径，
默认找 `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`。

## 通知是怎么工作的

1. 网页里的 `lib/notifyRuntime.ts` 监听本地仓库变化、每分钟对齐一次时钟，
   算出「逾期 + 今天剩下的」；
2. 通过 `NotifyPlugin.setNotification()` 把渲染好的文本推给原生；
3. `NotifyService` 用前台服务把它挂到状态栏，**不可划掉**；
4. 用户在网页上勾完最后一项 → 计划变成 `active: false` → 通知被撤掉；
5. 进程被杀后重启（或设备重启）→ `BootReceiver` / `MainActivity` 把**最后一次**
   的内容挂回去，等网页加载完再刷新。

### 前台服务类型为什么是 `specialUse`

不是 `dataSync`，有两个硬理由（都来自 AOSP 行为，不是偏好）：

1. **Android 15 起 `BOOT_COMPLETED` 不允许启动 `dataSync` 前台服务** ——
   `ActiveServices.shouldAllowBootCompletedStart()` 的白名单
   （`FGS_BOOT_COMPLETED_ALLOWLIST`）里只有
   `connectedDevice / health / remoteMessaging / systemExempted / specialUse / location`。
   用 `dataSync` 的话，重启后恢复通知会直接抛
   `ForegroundServiceStartNotAllowedException`。
2. **Android 15 起 `dataSync` 在后台累计满 6 小时会被判超时** ——
   系统回调 `Service.onTimeout()`，不在几秒内 `stopSelf()` 就是一次
   `RemoteServiceException` 崩溃。而本服务的常态就是"一直挂着"，必然撞上。
   `specialUse` 不受时长约束。

代价：若上架 Google Play 需要说明用途（`PROPERTY_SPECIAL_USE_FGS_SUBTYPE`
已声明为 `persistent_status_bar_reminder`）；自签名侧载不受影响。

即便如此，`onTimeout()` 仍然被覆写并降级为普通通知 —— 多一层保险。

### 一个刻意的取舍：失败不删数据

任何"这一轮没显示成功"的路径都只撤通知、**保留**落盘负载。
因为失败原因（后台启动受限、额度用尽、服务被重建）大多是**可恢复**的，
把负载删掉就等于把"下次还能补上"变成"永远补不上"。
只有网页明确说"没有事项了"时才真正删除。

### 开发时的一个坑

`npm run dev`（Vite 开发服务器）下 Service Worker **不会注册**，
所以浏览器里点开"开启通知"不会真的出现通知 —— 这是有意为之（SW 会干扰热更新）。
要验证浏览器端通知，请用构建产物：

```bash
npm run build && node app/scripts/serve-dist.mjs --port 3080
```

## 已知边界

- **后台精确刷新做不到。** 网页被系统回收后没有任何 JS 在跑，状态栏保留的是最后一次
  算出来的内容 —— 它不会消失，但可能过时。要做分钟级精确刷新，就得在原生侧再实现
  一套排期（AlarmManager + 通知数据本地化），目前刻意没做。
- **国产 ROM 的省电策略。** 小米 / 华为 / OPPO / vivo 可能连前台服务一起冻结。
  需要在系统设置里把 Twische 加进"电池优化白名单 / 允许后台运行"。
- **前台服务被系统收走时会有一次降级。** `specialUse` 不受时长限制，
  但如果系统因内存压力回收进程，服务会按 `START_STICKY` 重建；
  重建失败时通知会退化成普通通知（可见、但可能被划掉）。
  这是刻意的：宁可降级，也不要让进程崩在 `RemoteServiceException` 上。
- **CORS 仍然必需。** WebView 的页面源是 `https://localhost`，对 WebDAV 的请求
  是跨域的 —— 服务器必须把 `https://localhost` 放进 `cors_domains`，
  否则壳装上去和浏览器里一样连不上。

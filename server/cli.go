// Twische 命令行入口。
//
// 子命令：
//   init      初始化实例（写入 bcrypt 密码哈希）。未初始化则服务拒绝启动。
//   serve     启动 HTTP 服务
//   status    查看实例状态
//   passwd    修改密码（会吊销所有会话）
//   devices   列出已登记设备
//   reset     清空并重新初始化（先自动备份）
//   export    导出全部记录为 JSON
//   help      帮助
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"
)

// ───────────────────────── 参数解析 ─────────────────────────

type cmdFlags map[string]string

func (f cmdFlags) has(key string) bool {
	_, ok := f[key]
	return ok
}

func parseFlags(list []string) cmdFlags {
	f := cmdFlags{}
	for i := 0; i < len(list); i++ {
		a := list[i]
		if !strings.HasPrefix(a, "--") {
			continue
		}
		eq := strings.Index(a, "=")
		if eq > 0 {
			f[a[2:eq]] = a[eq+1:]
			continue
		}
		key := a[2:]
		if i+1 < len(list) && !strings.HasPrefix(list[i+1], "--") {
			f[key] = list[i+1]
			i++
		} else {
			f[key] = "true"
		}
	}
	return f
}

// ───────────────────────── 输出 ─────────────────────────

const useColor = true

func cDim(s string) string   { if useColor { return "\x1b[2m" + s + "\x1b[0m" }; return s }
func cBold(s string) string  { if useColor { return "\x1b[1m" + s + "\x1b[0m" }; return s }
func cRed(s string) string   { if useColor { return "\x1b[31m" + s + "\x1b[0m" }; return s }
func cGreen(s string) string { if useColor { return "\x1b[32m" + s + "\x1b[0m" }; return s }
func cAmber(s string) string { if useColor { return "\x1b[33m" + s + "\x1b[0m" }; return s }

func okLine(s string)  { fmt.Printf("%s %s\n", cGreen("✓"), s) }
func failLine(s string) { fmt.Fprintf(os.Stderr, "%s %s\n", cRed("✗"), s) }
func infoLine(s string) { fmt.Printf("  %s\n", s) }

func banner() {
	fmt.Println()
	fmt.Printf("  %s %s  %s\n", cBold("Twische"), cDim("v"+Version), cDim("· 以代码为笔，以时间为墨"))
	fmt.Println()
}

func die(message string, code int) {
	failLine(message)
	os.Exit(code)
}

// ───────────────────────── 读取密码 ─────────────────────────

func readStdinAll() string {
	b, _ := io.ReadAll(os.Stdin)
	return string(b)
}

// acquirePassword 优先级：--password-stdin > --password > 交互输入。
func acquirePassword(fl cmdFlags, confirm bool, label string) (string, bool) {
	if fl.has("password-stdin") {
		raw := strings.TrimSpace(readStdinAll())
		if raw == "" {
			failLine("标准输入为空，未读到密码")
			return "", false
		}
		return raw, true
	}
	if pw, ok := fl["password"]; ok && fl["password"] != "true" {
		warnLine("通过 --password 传参会让密码留在 shell 历史与进程列表里，仅建议本地临时使用")
		infoLine(cDim("更安全的方式：twische init --password-stdin"))
		return pw, true
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		failLine("当前不是交互式终端，请用 --password 或 --password-stdin 提供密码")
		return "", false
	}
	fmt.Print(label + ": ")
	first, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		failLine("已取消")
		return "", false
	}
	if confirm {
		fmt.Print("再输入一次以确认: ")
		second, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if err != nil || string(first) != string(second) {
			failLine("两次输入不一致")
			return "", false
		}
	}
	return string(first), true
}

func warnLine(s string) { fmt.Printf("%s %s\n", cAmber("!"), s) }

// ───────────────────────── init ─────────────────────────

func timestamp() string {
	return time.Now().Format("20060102-150405")
}

// backupDatabase 把现有库挪到备份目录，返回备份路径。危险操作前必须先做这一步。
func backupDatabase() string {
	if _, err := os.Stat(DBPath); err != nil {
		return ""
	}
	os.MkdirAll(BackupDir, 0o755)
	target := filepath.Join(BackupDir, "twische-"+timestamp()+".db")
	if err := copyFile(DBPath, target); err != nil {
		return ""
	}
	// WAL 与 SHM 也一起留一份，否则备份可能缺少最近未落盘的提交
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(DBPath + suffix); err == nil {
			copyFile(DBPath+suffix, target+suffix)
		}
	}
	return target
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func cmdInit(fl cmdFlags) {
	os.MkdirAll(DataDir, 0o755)
	db, err := openDatabase(DBPath)
	if err != nil {
		die("打开数据库失败："+err.Error(), 1)
	}
	if isInitialized(db) {
		var devices int
		db.QueryRow("SELECT COUNT(*) FROM devices").Scan(&devices)
		db.Close()
		banner()
		failLine("该实例已完成初始化，拒绝重复执行。")
		infoLine("数据库：" + cDim(DBPath))
		infoLine("已登记设备：" + itoa(devices) + " 台")
		fmt.Println()
		infoLine("如需修改密码：" + cBold("twische passwd"))
		infoLine("如需清空重来：" + cBold("twische reset") + cDim("（会先自动备份）"))
		os.Exit(1)
	}

	password := ""
	if fl.has("generate") {
		password = generatePassword(20)
		fmt.Println()
		fmt.Println("  " + cBold("已生成访问密码（请立即保存，此密码不会再次显示）"))
		fmt.Println()
		fmt.Println("    " + cGreen(password))
		fmt.Println()
	} else {
		pw, ok := acquirePassword(fl, true, "设置访问密码")
		if !ok {
			os.Exit(1)
		}
		password = pw
		strength := assessPassword(password)
		if !strength.OK {
			db.Close()
			banner()
			failLine("密码强度不足：")
			for _, p := range strength.Problems {
				infoLine("· " + p)
			}
			fmt.Println()
			infoLine(fmt.Sprintf("建议至少 %d 个字符，混合大小写与数字。", Auth.MinPasswordLength))
			infoLine("或让 Twische 生成一个：" + cBold("twische init --generate"))
			os.Exit(1)
		}
	}

	nowTs := now()
	username := "twilight"
	if u, ok := fl["username"]; ok && fl["username"] != "true" {
		username = truncateRunes(u, 60)
	}

	tx, err := db.Begin()
	if err != nil {
		die("事务失败："+err.Error(), 1)
	}
	if _, err := tx.Exec(
		`INSERT INTO account
		   (id, username, password_hash, password_algo, password_rounds, password_updated_at, created_at)
		 VALUES (1, ?, ?, 'bcrypt', ?, ?, ?)`,
		username, hashPassword(password, Auth.BcryptRounds), Auth.BcryptRounds, nowTs, nowTs,
	); err != nil {
		die("写入账户失败："+err.Error(), 1)
	}
	metaSetInt(tx, META_KEYS.InitializedAt, nowTs)
	metaSet(tx, META_KEYS.InstanceID, randomUUID())
	if err := tx.Commit(); err != nil {
		die("提交失败："+err.Error(), 1)
	}
	// 注意：单连接模式下，事务提交前不能用 db 执行任何查询（会死锁）
	audit(db, "instance.initialized", "bcrypt rounds="+itoa(Auth.BcryptRounds), "", "")
	db.Close()

	banner()
	okLine("初始化完成")
	fmt.Println()
	infoLine("数据库    " + cDim(DBPath))
	infoLine(fmt.Sprintf("密码哈希  %s", cDim(fmt.Sprintf("bcrypt，代价因子 %d", Auth.BcryptRounds))))
	fmt.Println()
	okLine("当前记录 0 条，设备 0 台")
	fmt.Println()
	fmt.Println("  下一步：" + cBold("twische serve"))
	fmt.Println("          " + cDim(fmt.Sprintf("默认监听 http://%s:%d", Server.Host, Server.Port)))
	fmt.Println()
}

// ───────────────────────── serve ─────────────────────────

func cmdServe(fl cmdFlags) {
	// --data-dir 覆盖数据目录（默认 <项目根>/data，或环境变量 TWISCHE_DATA_DIR）。
	// 必须在打开数据库之前生效；显式传了不存在的目录就报错，不静默创建空实例。
	if d, ok := fl["data-dir"]; ok && d != "true" {
		abs, err := filepath.Abs(d)
		if err != nil {
			die("data-dir 无法解析："+err.Error(), 1)
		}
		if !isDir(abs) {
			die("data-dir 不存在："+abs, 1)
		}
		DataDir = abs
		DBPath = filepath.Join(abs, "twische.db")
	}
	os.MkdirAll(DataDir, 0o755)
	db, err := openDatabase(DBPath)
	if err != nil {
		die("打开数据库失败："+err.Error(), 1)
	}
	if !isInitialized(db) {
		db.Close()
		banner()
		failLine("实例尚未初始化，服务拒绝启动。")
		fmt.Println()
		infoLine("请先执行：")
		fmt.Println("    " + cBold("twische init --password <你的密码>"))
		fmt.Println()
		infoLine(cDim("（或使用更安全的 twische init --password-stdin）"))
		fmt.Println()
		os.Exit(1)
	}

	host := Server.Host
	if h, ok := fl["host"]; ok && fl["host"] != "true" {
		host = h
	}
	port := Server.Port
	if p, ok := fl["port"]; ok && fl["port"] != "true" {
		if n, err := strconv.Atoi(p); err == nil {
			port = n
		}
	}

	// 启动时的例行维护：清理过期会话与墓碑
	pruneSessions(db)
	maintenance, _ := purgeTombstones(db)

	webDist := ""
	if fi, err := os.Stat(WebDist); err == nil && fi.IsDir() {
		webDist = WebDist
	}

	addr := net.JoinHostPort(host, strconv.Itoa(port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		if isAddrInUse(err) {
			die(fmt.Sprintf("端口 %d 已被占用。换一个：twische serve --port %d", port, port+1), 1)
		}
		die("服务启动失败："+err.Error(), 1)
	}

	srv := &http.Server{Handler: NewApp(db, webDist)}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			failLine("服务异常退出：" + err.Error())
			os.Exit(1)
		}
	}()

	banner()
	okLine("Twische 已启动")
	fmt.Println()
	shown := host
	if host == "0.0.0.0" || host == "::" || host == "" {
		shown = "localhost"
	}
	infoLine("地址      " + cBold(fmt.Sprintf("http://%s:%d", shown, port)))
	infoLine("数据      " + cDim(DBPath))
	if embeddedWebFS() != nil {
		infoLine("前端      " + cDim("已内嵌，由本进程托管"))
	} else if webDist != "" {
		infoLine("前端      " + cDim("已构建，由本进程托管"))
	} else {
		infoLine("前端      " + cAmber("未构建（python build.py 或 npm run build）"))
	}
	if maintenance.Purged > 0 {
		infoLine(fmt.Sprintf("维护      清理 %d 条过期墓碑，水位 %d", maintenance.Purged, maintenance.FloorSeq))
	}
	if host == "0.0.0.0" {
		fmt.Println()
		warnLine("正在监听所有网卡，请确保已配置 HTTPS 或仅在可信内网使用")
	}
	fmt.Println()
	fmt.Println(cDim("  按 Ctrl+C 停止"))
	fmt.Println()

	// 优雅退出：停收新请求 → WAL 检查点 → 关库
	sig := make(chan os.Signal, 1)
	signalNotify(sig)
	<-sig
	fmt.Println()
	fmt.Println(cDim("  收到退出信号，正在关闭…"))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
	db.Close()
	fmt.Println(cDim("  已安全退出"))
}

func isAddrInUse(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "address already in use") ||
		strings.Contains(msg, "Only one usage of each socket address") ||
		strings.Contains(msg, "10048")
}

// ───────────────────────── status ─────────────────────────

func fmtTime(ts int64) string {
	if ts == 0 {
		return "-"
	}
	d := time.UnixMilli(ts)
	rel := now() - ts
	var suffix string
	switch {
	case rel < 60000:
		suffix = "刚刚"
	case rel < 3600000:
		suffix = fmt.Sprintf("%d 分钟前", rel/60000)
	case rel < 86400000:
		suffix = fmt.Sprintf("%d 小时前", rel/86400000)
	default:
		suffix = fmt.Sprintf("%d 天前", rel/86400000)
	}
	return d.Format("2006-01-02 15:04") + "（" + suffix + "）"
}

func cmdStatus() {
	banner()
	infoLine("数据库    " + cDim(DBPath))
	if _, err := os.Stat(DBPath); err != nil {
		infoLine("存在      " + cAmber("否"))
		fmt.Println()
		warnLine("尚未初始化，请执行 twische init --password <密码>")
		os.Exit(1)
	}
	infoLine("存在      " + cGreen("是"))

	db, err := openDatabase(DBPath)
	if err != nil {
		die("打开数据库失败："+err.Error(), 1)
	}
	defer db.Close()
	if !isInitialized(db) {
		infoLine("已初始化  " + cRed("否"))
		os.Exit(1)
	}
	infoLine("已初始化  " + cGreen("是"))

	acct, apiErr := getAccount(db)
	if apiErr != nil {
		die("读取账户失败", 1)
	}
	s := stats(db)
	devices, _ := listDevices(db, "")
	var dbBytes int64
	if fi, err := os.Stat(DBPath); err == nil {
		dbBytes = fi.Size()
	}

	fmt.Println()
	fmt.Println("  " + cBold("账户"))
	infoLine("用户名        " + acct.Username)
	infoLine(fmt.Sprintf("密码算法      bcrypt（代价因子 %d）", acct.PasswordRounds))
	infoLine("密码更新于    " + fmtTime(acct.PasswordUpdatedAt))
	if acct.LastLoginAt.Valid {
		infoLine("最近登录      " + fmtTime(acct.LastLoginAt.Int64))
	} else {
		infoLine("最近登录      " + cDim("从未"))
	}
	if acct.FailedAttempts > 0 {
		infoLine(cAmber(fmt.Sprintf("连续失败      %d 次", acct.FailedAttempts)))
	}
	if acct.LockedUntil > now() {
		infoLine(cRed("锁定至        "+fmtTime(acct.LockedUntil)))
	}

	fmt.Println()
	fmt.Println("  " + cBold("数据"))
	infoLine(fmt.Sprintf("记录          %d 条", s["records"]))
	infoLine(fmt.Sprintf("墓碑          %d 条", s["tombstones"]))
	infoLine(fmt.Sprintf("版本向量总和  %d", s["clock"]))
	infoLine(fmt.Sprintf("冲突记录      %d 次", s["conflicts"]))
	infoLine(fmt.Sprintf("库文件        %.1f KB", float64(dbBytes)/1024))
	infoLine("墓碑水位      " + itoa(int(metaGetInt(db, META_KEYS.TombstoneFloorSeq, 0))))

	fmt.Println()
	fmt.Println(fmt.Sprintf("  %s", cBold(fmt.Sprintf("设备（%d）", len(devices)))))
	if len(devices) == 0 {
		infoLine(cDim("暂无设备登录过"))
	} else {
		for _, d := range devices {
			tags := []string{}
			if d.Platform != "" {
				tags = append(tags, d.Platform)
			}
			tags = append(tags, fmt.Sprintf("%d 个活跃会话", d.ActiveSessions))
			infoLine(fmt.Sprintf("%-22s %s", d.Name, cDim(strings.Join(tags, " · "))))
			infoLine(fmt.Sprintf("%-22s %s", "", cDim("最后活跃 "+fmtTime(d.LastSeenAt))))
		}
	}
	fmt.Println()
}

// ───────────────────────── passwd ─────────────────────────

func cmdPasswd(fl cmdFlags) {
	db, err := openDatabase(DBPath)
	if err != nil {
		die("打开数据库失败："+err.Error(), 1)
	}
	defer db.Close()
	if !isInitialized(db) {
		die("实例尚未初始化", 1)
	}

	password := ""
	if fl.has("generate") {
		password = generatePassword(20)
		fmt.Println()
		fmt.Println("  " + cBold("已生成新密码（请立即保存，此密码不会再次显示）"))
		fmt.Println()
		fmt.Println("    " + cGreen(password))
		fmt.Println()
	} else {
		pw, ok := acquirePassword(fl, true, "设置新密码")
		if !ok {
			os.Exit(1)
		}
		password = pw
		strength := assessPassword(password)
		if !strength.OK {
			failLine("密码强度不足：")
			for _, p := range strength.Problems {
				infoLine("· " + p)
			}
			os.Exit(1)
		}
	}

	revoked, err := revokeAllSessions(db, "password_changed", "")
	if err != nil {
		die("吊销会话失败："+err.Error(), 1)
	}
	db.Exec(
		`UPDATE account SET password_hash = ?, password_rounds = ?, password_updated_at = ?,
		        failed_attempts = 0, locked_until = 0 WHERE id = 1`,
		hashPassword(password, Auth.BcryptRounds), Auth.BcryptRounds, now())
	audit(db, "password.changed", fmt.Sprintf("通过 CLI 修改，吊销 %d 个会话", revoked), "", "")

	banner()
	okLine("密码已更新")
	infoLine(fmt.Sprintf("已吊销 %d 个登录会话，所有设备需要重新登录", revoked))
}

// ───────────────────────── devices ─────────────────────────

func cmdDevices() {
	db, err := openDatabase(DBPath)
	if err != nil {
		die("打开数据库失败："+err.Error(), 1)
	}
	defer db.Close()
	if !isInitialized(db) {
		die("实例尚未初始化", 1)
	}
	devices, err := listDevices(db, "")
	if err != nil {
		die("读取设备失败："+err.Error(), 1)
	}
	banner()
	if len(devices) == 0 {
		infoLine(cDim("暂无设备登录过"))
		return
	}
	for _, d := range devices {
		platform := d.Platform
		if platform == "" {
			platform = "未知"
		}
		okLine(fmt.Sprintf("%s %s", d.Name, cDim("("+platform+")")))
		infoLine("ID        " + d.ID)
		infoLine(fmt.Sprintf("会话      %d 个活跃", d.ActiveSessions))
		infoLine("最后活跃  " + fmtTime(d.LastSeenAt))
		fmt.Println()
	}
}

// ───────────────────────── reset ─────────────────────────

func cmdReset(fl cmdFlags) {
	if _, err := os.Stat(DBPath); err != nil {
		die("数据库不存在，无需重置", 1)
	}
	if !fl.has("yes") && !fl.has("y") {
		banner()
		fmt.Println("  " + cRed(cBold("⚠  此操作将清空全部数据！")))
		fmt.Println()
		infoLine("包括：账户、密码、所有日程记录、所有设备与会话")
		infoLine("Twische 会先把当前数据库复制到备份目录，但这只对\"误操作\"有效，")
		infoLine("如果你已确认不再需要这些数据，备份也只是一个副本而已。")
		fmt.Println()
		infoLine("备份目录：" + cDim(BackupDir))
		fmt.Println()
		infoLine("确认请追加 --yes：" + cBold("twische reset --yes"))
		os.Exit(1)
	}

	backupPath := backupDatabase()
	banner()
	if backupPath != "" {
		rel, err := filepath.Rel(cwd(), backupPath)
		if err != nil {
			rel = backupPath
		}
		okLine("已备份旧数据库 → " + cDim(rel))
	}

	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Remove(DBPath + suffix); err != nil && !os.IsNotExist(err) {
			if errors.Is(err, syscall.EBUSY) || isSharingViolation(err) {
				failLine("数据库文件正被占用：" + filepath.Base(DBPath))
				fmt.Println()
				infoLine("通常是还有另一个 Twische 服务在运行。请先停掉它（在它的终端按 Ctrl+C），再重试。")
				fmt.Println()
				os.Exit(1)
			}
			die("移除旧数据库失败："+err.Error(), 1)
		}
	}
	okLine("旧数据库已移除")
	cmdInit(fl)
}

func isSharingViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "being used by another process")
}

func cwd() string {
	d, _ := os.Getwd()
	return d
}

// ───────────────────────── export ─────────────────────────

func cmdExport(fl cmdFlags) {
	db, err := openDatabase(DBPath)
	if err != nil {
		die("打开数据库失败："+err.Error(), 1)
	}
	defer db.Close()
	if !isInitialized(db) {
		die("实例尚未初始化", 1)
	}
	rows, err := db.Query("SELECT " + recordColumns + " FROM records ORDER BY seq ASC")
	if err != nil {
		die("读取记录失败："+err.Error(), 1)
	}
	defer rows.Close()
	records := []map[string]any{}
	for rows.Next() {
		r := &recordRow{}
		var origin sql.NullString
		if err := rows.Scan(&r.RowID, &r.Seq, &r.ID, &r.Kind, &r.Data, &r.Vc, &r.UpdatedAt,
			&r.Deleted, &r.ByteSize, &origin, &r.CreatedAt); err != nil {
			die("读取记录失败："+err.Error(), 1)
		}
		records = append(records, map[string]any{
			"id":        r.ID,
			"kind":      r.Kind,
			"data":      jsonRaw(r.Data),
			"vc":        parseVc(r.Vc),
			"updatedAt": r.UpdatedAt,
			"deleted":   r.Deleted != 0,
			"seq":       r.Seq,
		})
	}
	payload := map[string]any{
		"format":     "twische-export",
		"version":    1,
		"exportedAt": now(),
		"records":    records,
	}

	out, err := marshalPretty(payload)
	if err != nil {
		die("序列化失败："+err.Error(), 1)
	}
	if o, ok := fl["out"]; ok && fl["out"] != "true" {
		abs, _ := filepath.Abs(o)
		if err := os.WriteFile(abs, out, 0o644); err != nil {
			die("写入文件失败："+err.Error(), 1)
		}
		okLine(fmt.Sprintf("已导出 %d 条记录 → %s", len(records), abs))
	} else {
		os.Stdout.Write(out)
	}
}

// ───────────────────────── help ─────────────────────────

func cmdHelp() {
	banner()
	fmt.Println("  " + cBold("用法") + "  twische <命令> [选项]")
	fmt.Println()
	fmt.Println("  " + cBold("命令"))
	infoLine(pad("init", 10) + " 初始化实例，写入 bcrypt 密码哈希")
	infoLine(pad("serve", 10) + " 启动 HTTP 服务（未初始化会拒绝启动）")
	infoLine(pad("status", 10) + " 查看账户、数据量与设备状态")
	infoLine(pad("passwd", 10) + " 修改密码并吊销所有会话")
	infoLine(pad("devices", 10) + " 列出已登记设备")
	infoLine(pad("export", 10) + " 导出全部记录为 JSON")
	infoLine(pad("reset", 10) + " 清空并重新初始化（自动备份）")
	infoLine(pad("help", 10) + " 显示本帮助")
	fmt.Println()
	fmt.Println("  " + cBold("常用选项"))
	infoLine(pad("--password <pw>", 26) + " 指定密码（会留在 shell 历史，慎用）")
	infoLine(pad("--password-stdin", 26) + " 从标准输入读取密码（推荐）")
	infoLine(pad("--generate", 26) + " 由 Twische 生成强密码（passwd）")
	infoLine(pad("--port <n>", 26) + fmt.Sprintf(" 监听端口（默认 %d）", Server.Port))
	infoLine(pad("--host <addr>", 26) + fmt.Sprintf(" 监听地址（默认 %s）", Server.Host))
	infoLine(pad("--yes", 26) + " 跳过 reset 的确认")
	fmt.Println()
	fmt.Println("  " + cBold("示例"))
	fmt.Println("    twische init --password-stdin < 密码文件")
	fmt.Println("    twische serve --host 0.0.0.0 --port 8787")
	fmt.Println()
	fmt.Println(cDim("  数据目录  " + DataDir))
	fmt.Println()
}

func pad(s string, n int) string {
	w := 0
	for range s {
		w++
	}
	if w >= n {
		return s
	}
	return s + strings.Repeat(" ", n-w)
}

// 身份验证：登录、会话、锁定退避、改密。
//
// 安全设计要点：
// - 会话令牌拆成 `id.secret`：id 用于 O(1) 查表，secret 只存 sha256，
//   库被读走也无法反推出可用的令牌。两者都用高熵随机数。
// - 恒定响应：无论密码错、账户被锁还是库异常，错误码不泄漏账户存在性。
// - 双层退避：账户级锁定（持久化，防重启绕过）+ IP 级限流（内存，防跨账户探测）。
// - 改密即吊销其它所有会话，但保留当前设备，避免"改完自己也被踢"。
package main

import (
	"database/sql"
	"regexp"
	"sync"
	"time"
)

// ───────────────────────── IP 级限流（内存滑动窗口） ─────────────────────────

type ipBucket struct {
	hits         []int64
	blockedUntil int64
}

var (
	ipMu      sync.Mutex
	ipBuckets = map[string]*ipBucket{}
)

const (
	ipWindowMs    = 15 * 60 * 1000 // 每 15 分钟
	ipMaxAttempts = 30             // 最多 30 次登录尝试
	ipBlockMs     = 5 * 60 * 1000  // 超出则封锁 5 分钟
)

func ipBucketOf(ip string) *ipBucket {
	t := nowMs()
	b := ipBuckets[ip]
	if b == nil {
		b = &ipBucket{}
		ipBuckets[ip] = b
	}
	kept := b.hits[:0]
	for _, ts := range b.hits {
		if t-ts < ipWindowMs {
			kept = append(kept, ts)
		}
	}
	b.hits = kept
	return b
}

// checkIpThrottle 超限则按指数退避封锁该 IP。
func checkIpThrottle(ip string) *AppError {
	ipMu.Lock()
	defer ipMu.Unlock()
	b := ipBucketOf(ip)
	t := nowMs()
	if b.blockedUntil > t {
		return E.Throttled(int((b.blockedUntil - t + 999) / 1000))
	}
	if len(b.hits) >= ipMaxAttempts {
		b.blockedUntil = t + ipBlockMs
		return E.Throttled(int(ipBlockMs / 1000))
	}
	return nil
}

func recordIpAttempt(ip string) {
	ipMu.Lock()
	defer ipMu.Unlock()
	ipBucketOf(ip).hits = append(ipBucketOf(ip).hits, nowMs())
}

// ResetThrottle 单测与维护用：清空限流状态。
func ResetThrottle() {
	ipMu.Lock()
	defer ipMu.Unlock()
	ipBuckets = map[string]*ipBucket{}
}

// ───────────────────────── 设备 ─────────────────────────

type Device struct {
	ID          string
	Name        string
	Platform    sql.NullString
	CreatedAt   int64
	LastSeenAt  int64
	PushCount   int64
	PullCount   int64
}

func nowMs() int64 { return time.Now().UnixMilli() }

var (
	reIOS     = regexp.MustCompile(`(?i)iPhone|iPad|iPod`)
	reAndroid = regexp.MustCompile(`(?i)Android`)
	reMac     = regexp.MustCompile(`(?i)Macintosh|Mac OS X`)
	reWindows = regexp.MustCompile(`(?i)Windows`)
	reLinux   = regexp.MustCompile(`(?i)Linux`)
)

// simplePlatform 从 UA 猜平台，仅用于展示。
func simplePlatform(ua string) string {
	switch {
	case reIOS.MatchString(ua):
		return "iOS"
	case reAndroid.MatchString(ua):
		return "Android"
	case reMac.MatchString(ua):
		return "macOS"
	case reWindows.MatchString(ua):
		return "Windows"
	case reLinux.MatchString(ua):
		return "Linux"
	}
	return "未知"
}

// deviceColumns 供 selectDevice 复用。
const deviceColumns = "id, name, platform, created_at, last_seen_at, push_count, pull_count"

func scanDevice(row *sql.Row) (*Device, error) {
	var d Device
	var platform sql.NullString
	if err := row.Scan(&d.ID, &d.Name, &platform, &d.CreatedAt, &d.LastSeenAt, &d.PushCount, &d.PullCount); err != nil {
		return nil, err
	}
	d.Platform = platform
	return &d, nil
}

// upsertDevice 注册或刷新设备。设备名以客户端上报为准，支持用户改名。
// 同一 deviceId 重复登录不会产生重复行（登录态失效后重登是常态）。
func upsertDevice(db *sql.DB, deviceID, deviceName, userAgent string) (*Device, error) {
	t := nowMs()
	var exists string
	err := db.QueryRow("SELECT id FROM devices WHERE id = ?", deviceID).Scan(&exists)
	switch {
	case err == nil:
		if _, err := db.Exec(
			"UPDATE devices SET last_seen_at = ?, platform = ? WHERE id = ?",
			t, simplePlatform(userAgent), deviceID,
		); err != nil {
			return nil, err
		}
	case err == sql.ErrNoRows:
		name, err := normalizeDeviceName(db, deviceName)
		if err != nil {
			return nil, err
		}
		if _, err := db.Exec(
			"INSERT INTO devices (id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
			deviceID, name, simplePlatform(userAgent), t, t,
		); err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	return selectDevice(db, deviceID)
}

func selectDevice(db *sql.DB, id string) (*Device, error) {
	return scanDevice(db.QueryRow("SELECT "+deviceColumns+" FROM devices WHERE id = ?", id))
}

// normalizeDeviceName 设备重名时追加序号，让设置页里的列表可辨识。
func normalizeDeviceName(db *sql.DB, raw string) (string, error) {
	name := truncateRunes(trimSpace(raw), 60)
	if name == "" {
		name = "未命名设备"
	}
	rows, err := db.Query("SELECT name FROM devices")
	if err != nil {
		return "", err
	}
	defer rows.Close()
	taken := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return "", err
		}
		taken[n] = true
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if !taken[name] {
		return name, nil
	}
	for i := 2; i < 100; i++ {
		candidate := name + " (" + itoa(i) + ")"
		if !taken[candidate] {
			return candidate, nil
		}
	}
	return name + " (" + itoa(int(nowMs())) + ")", nil
}

// ───────────────────────── 会话 ─────────────────────────

type Session struct {
	ID            string
	SecretHash    string
	DeviceID      string
	UserAgent     sql.NullString
	IP            sql.NullString
	CreatedAt     int64
	LastSeenAt    int64
	ExpiresAt     int64
	ElevatedUntil int64
	RevokedAt     sql.NullInt64
	RevokedReason sql.NullString
}

const sessionColumns = "id, secret_hash, device_id, user_agent, ip, created_at, last_seen_at, expires_at, elevated_until, revoked_at, revoked_reason"

func scanSession(row *sql.Row) (*Session, error) {
	var s Session
	err := row.Scan(&s.ID, &s.SecretHash, &s.DeviceID, &s.UserAgent, &s.IP,
		&s.CreatedAt, &s.LastSeenAt, &s.ExpiresAt, &s.ElevatedUntil, &s.RevokedAt, &s.RevokedReason)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// newSessionToken 会话令牌：`id.secret`，id 用于 O(1) 查表。
func newSessionToken() (id, secret, token string) {
	id = randomToken(9)
	secret = randomToken(32)
	return id, secret, id + "." + secret
}

var (
	reTokenID     = regexp.MustCompile(`^[A-Za-z0-9_-]{6,64}$`)
	reTokenSecret = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)
)

// parseToken 基本形状校验，挡掉明显的垃圾输入，避免无谓的查库。
func parseToken(token string) (id, secret string, ok bool) {
	if token == "" {
		return "", "", false
	}
	idx := -1
	for i := 0; i < len(token); i++ {
		if token[i] == '.' {
			idx = i
			break
		}
	}
	if idx <= 0 || idx == len(token)-1 {
		return "", "", false
	}
	id, secret = token[:idx], token[idx+1:]
	if !reTokenID.MatchString(id) || !reTokenSecret.MatchString(secret) {
		return "", "", false
	}
	return id, secret, true
}

// createSession 建立会话并顺带清理过期会话。
//
// elevatedUntil 为提权到期时刻：登录本身即视为提权（用户刚证明过身份）。
func createSession(db *sql.DB, deviceID, userAgent, ip string) (*Session, string, error) {
	id, secret, token := newSessionToken()
	t := nowMs()
	ua := truncateRunes(userAgent, 300)
	if _, err := db.Exec(
		`INSERT INTO sessions (id, secret_hash, device_id, user_agent, ip, created_at, last_seen_at, expires_at, elevated_until)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, sha256Hex(secret), deviceID, nullStr(ua), nullStr(ip), t, t, t+Auth.SessionTtlMs,
		t+Auth.ElevateTtlMs,
	); err != nil {
		return nil, "", err
	}
	if err := pruneSessions(db); err != nil {
		return nil, "", err
	}
	sess, err := selectSession(db, id)
	if err != nil {
		return nil, "", err
	}
	return sess, token, nil
}

// isElevated 会话是否处于提权有效期内。
func isElevated(s *Session) bool {
	return s != nil && s.ElevatedUntil > nowMs()
}

// elevateSession 校验密码并延长会话提权有效期。用于管理其它设备这类敏感操作。
func elevateSession(db *sql.DB, s *Session, password string) *AppError {
	acct, apiErr := getAccount(db)
	if apiErr != nil {
		return apiErr
	}
	if !verifyPassword(password, acct.PasswordHash) {
		audit(db, "session.elevate_failed", "提权密码不正确", s.IP.String, s.DeviceID)
		return E.PasswordMismatch()
	}
	until := nowMs() + Auth.ElevateTtlMs
	if _, err := db.Exec("UPDATE sessions SET elevated_until = ? WHERE id = ? AND revoked_at IS NULL",
		until, s.ID); err != nil {
		return internalErr(err)
	}
	s.ElevatedUntil = until
	audit(db, "session.elevated", "提权至 "+itoa(int(until/1000))+"s", s.IP.String, s.DeviceID)
	return nil
}

func selectSession(db *sql.DB, id string) (*Session, error) {
	return scanSession(db.QueryRow("SELECT "+sessionColumns+" FROM sessions WHERE id = ?", id))
}

// verifySession 校验会话令牌；有效则刷新 last_seen 并滑动续期。
func verifySession(db *sql.DB, token string) (*Session, bool) {
	id, secret, ok := parseToken(token)
	if !ok {
		return nil, false
	}
	row, err := scanSession(db.QueryRow("SELECT "+sessionColumns+" FROM sessions WHERE id = ?", id))
	if err != nil || row.RevokedAt.Valid {
		return nil, false
	}
	t := nowMs()
	if row.ExpiresAt <= t {
		return nil, false
	}
	if !safeEqualHex(sha256Hex(secret), row.SecretHash) {
		return nil, false
	}
	// 滑动续期：只在剩余不足一半时才写库，避免每个请求都产生一次写事务，
	// 否则 WAL 会被高频心跳撑爆。
	remaining := row.ExpiresAt - t
	if remaining < Auth.SessionTtlMs/2 {
		db.Exec("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", t, t+Auth.SessionTtlMs, row.ID)
		row.ExpiresAt = t + Auth.SessionTtlMs
		row.LastSeenAt = t
	} else if t-row.LastSeenAt > 60*1000 {
		db.Exec("UPDATE sessions SET last_seen_at = ? WHERE id = ?", t, row.ID)
		row.LastSeenAt = t
	}
	return row, true
}

func revokeSession(db *sql.DB, sessionID, reason string) error {
	_, err := db.Exec(
		"UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL",
		nowMs(), reason, sessionID)
	return err
}

// revokeAllSessions 吊销会话。exceptSessionID 用于改密场景保留当前会话。
func revokeAllSessions(db *sql.DB, reason, exceptSessionID string) (int64, error) {
	t := nowMs()
	var info sql.Result
	var err error
	if exceptSessionID != "" {
		info, err = db.Exec(
			"UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE revoked_at IS NULL AND id != ?",
			t, reason, exceptSessionID)
	} else {
		info, err = db.Exec(
			"UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE revoked_at IS NULL", t, reason)
	}
	if err != nil {
		return 0, err
	}
	return info.RowsAffected()
}

// pruneSessions 清理过期与已吊销超过 7 天的会话，并限制单账户会话总数。
func pruneSessions(db *sql.DB) error {
	t := nowMs()
	if _, err := db.Exec(
		"DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)",
		t-24*3600*1000, t-7*24*3600*1000,
	); err != nil {
		return err
	}
	rows, err := db.Query(
		`SELECT id FROM sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC`, t)
	if err != nil {
		return err
	}
	var live []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		live = append(live, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(live) > Auth.MaxSessions {
		for _, id := range live[Auth.MaxSessions:] {
			db.Exec("UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ?",
				t, "evicted:too_many_sessions", id)
		}
	}
	return nil
}

// ───────────────────────── 账户 ─────────────────────────

type Account struct {
	Username          string
	PasswordHash      string
	PasswordAlgo      string
	PasswordRounds    int64
	PasswordUpdatedAt int64
	FailedAttempts    int64
	LockedUntil       int64
	LastLoginAt       sql.NullInt64
	CreatedAt         int64
}

func getAccount(db *sql.DB) (*Account, *AppError) {
	if !isInitialized(db) {
		return nil, E.NotInitialized()
	}
	var a Account
	var lastLogin sql.NullInt64
	err := db.QueryRow(
		`SELECT username, password_hash, password_algo, password_rounds, password_updated_at,
		        failed_attempts, locked_until, last_login_at, created_at
		 FROM account WHERE id = 1`,
	).Scan(&a.Username, &a.PasswordHash, &a.PasswordAlgo, &a.PasswordRounds, &a.PasswordUpdatedAt,
		&a.FailedAttempts, &a.LockedUntil, &lastLogin, &a.CreatedAt)
	if err != nil {
		return nil, E.NotInitialized()
	}
	a.LastLoginAt = lastLogin
	return &a, nil
}

// login 校验密码并建立会话。
func login(db *sql.DB, password, deviceID, deviceName, userAgent, ip string) (token string, device *Device, sess *Session, apiErr *AppError) {
	if err := checkIpThrottle(ip); err != nil {
		return "", nil, nil, err
	}
	acct, apiErr := getAccount(db)
	if apiErr != nil {
		return "", nil, nil, apiErr
	}
	t := nowMs()

	if acct.LockedUntil > t {
		retryAfterSec := int((acct.LockedUntil - t + 999) / 1000)
		audit(db, "login.blocked", "账户处于锁定期", ip, "")
		return "", nil, nil, E.Locked(retryAfterSec)
	}

	if !verifyPassword(password, acct.PasswordHash) {
		recordIpAttempt(ip)
		failed := acct.FailedAttempts + 1
		lockedUntil := int64(0)
		if int(failed) >= Auth.LockoutThreshold {
			over := int(failed) - Auth.LockoutThreshold
			delay := Auth.LockoutBaseMs << over
			if delay > Auth.LockoutMaxMs || delay <= 0 {
				delay = Auth.LockoutMaxMs
			}
			lockedUntil = t + delay
		}
		db.Exec("UPDATE account SET failed_attempts = ?, locked_until = ? WHERE id = 1", failed, lockedUntil)
		audit(db, "login.failed", "连续失败 "+itoa(int(failed))+" 次", ip, deviceID)
		if lockedUntil > t {
			return "", nil, nil, E.Locked(int((lockedUntil - t + 999) / 1000))
		}
		return "", nil, nil, E.BadCredentials()
	}

	// 成功：清零失败计数，必要时透明升级哈希代价
	db.Exec("UPDATE account SET failed_attempts = 0, locked_until = 0, last_login_at = ? WHERE id = 1", t)
	if needsRehash(acct.PasswordHash) {
		db.Exec("UPDATE account SET password_hash = ?, password_rounds = ?, password_updated_at = ? WHERE id = 1",
			hashPassword(password, Auth.BcryptRounds), Auth.BcryptRounds, t)
		audit(db, "password.rehash", "代价因子升级至 "+itoa(Auth.BcryptRounds), "", "")
	}

	device, err := upsertDevice(db, deviceID, deviceName, userAgent)
	if err != nil {
		return "", nil, nil, internalErr(err)
	}
	sess, token, err = createSession(db, deviceID, userAgent, ip)
	if err != nil {
		return "", nil, nil, internalErr(err)
	}
	audit(db, "login.success", "", ip, deviceID)
	return token, device, sess, nil
}

// changePasswordResult 改密的返回。
type changePasswordResult struct {
	Revoked int64
	Session *Session
	Token   string
}

// changePassword 修改密码。要求校验当前密码；成功后吊销其它设备会话。
func changePassword(db *sql.DB, currentPassword, newPassword, sessionID, deviceID, userAgent, ip string) (*changePasswordResult, *AppError) {
	acct, apiErr := getAccount(db)
	if apiErr != nil {
		return nil, apiErr
	}

	if !verifyPassword(currentPassword, acct.PasswordHash) {
		audit(db, "password.change_failed", "当前密码不正确", ip, deviceID)
		return nil, E.PasswordMismatch()
	}

	strength := assessPassword(newPassword)
	if !strength.OK {
		return nil, E.WeakPassword(strength.Problems)
	}
	if currentPassword == newPassword {
		return nil, E.WeakPassword([]string{"新密码不能与当前密码相同"})
	}

	t := nowMs()
	if _, err := db.Exec(
		`UPDATE account SET password_hash = ?, password_rounds = ?, password_updated_at = ?,
		        failed_attempts = 0, locked_until = 0 WHERE id = 1`,
		hashPassword(newPassword, Auth.BcryptRounds), Auth.BcryptRounds, t,
	); err != nil {
		return nil, internalErr(err)
	}

	// 当前会话也一并作废并重发，确保"改密后旧令牌立刻失效"这一语义无例外
	revoked, err := revokeAllSessions(db, "password_changed", "")
	if err != nil {
		return nil, internalErr(err)
	}
	sess, token, err := createSession(db, deviceID, userAgent, ip)
	if err != nil {
		return nil, internalErr(err)
	}
	audit(db, "password.changed", "吊销 "+itoa(int(revoked))+" 个会话", ip, deviceID)
	return &changePasswordResult{Revoked: revoked, Session: sess, Token: token}, nil
}

// deviceInfo 设备列表条目（对外形状）。
type deviceInfo struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Platform       string `json:"platform"`
	CreatedAt      int64  `json:"createdAt"`
	LastSeenAt     int64  `json:"lastSeenAt"`
	ActiveSessions int64  `json:"activeSessions"`
	Current        bool   `json:"current"`
}

// listDevices 列出设备及其会话状态，供设置页展示。
func listDevices(db *sql.DB, currentDeviceID string) ([]deviceInfo, error) {
	t := nowMs()
	rows, err := db.Query(
		`SELECT d.id, d.name, d.platform,
		        (SELECT COUNT(*) FROM sessions s
		          WHERE s.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
		 FROM devices d ORDER BY d.last_seen_at DESC`, t)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []deviceInfo{}
	for rows.Next() {
		var d deviceInfo
		var platform sql.NullString
		if err := rows.Scan(&d.ID, &d.Name, &platform, &d.ActiveSessions); err != nil {
			return nil, err
		}
		d.Platform = platform.String
		d.Current = d.ID == currentDeviceID
		// createdAt / lastSeenAt 需要整行，单独补查代价过高；这里一并扫出
		out = append(out, d)
	}
	// 补齐 createdAt / lastSeenAt
	for i := range out {
		var createdAt, lastSeen int64
		db.QueryRow("SELECT created_at, last_seen_at FROM devices WHERE id = ?", out[i].ID).Scan(&createdAt, &lastSeen)
		out[i].CreatedAt = createdAt
		out[i].LastSeenAt = lastSeen
	}
	return out, rows.Err()
}

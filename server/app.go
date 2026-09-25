// HTTP 应用装配：中间件、路由、静态资源、错误处理。
//
// 这里刻意只做三件事 —— 身份验证、资料存储、同步。任何"业务计算"
// （重复规则展开、日程视图拼装）都在客户端完成，后端不认识"任务"长什么样。
package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
)

type server struct {
	db    *sql.DB
	webFS fs.FS // 前端资源：内嵌产物（单文件）或磁盘 web/dist；nil 表示尚未构建
}

// NewApp 装配 HTTP handler。
//
// webDist 是磁盘上的前端产物目录（开发模式）。若编译时已内嵌真实产物
// （build.py 填充 server/webdist 后），内嵌优先 —— 单文件部署不依赖磁盘布局。
func NewApp(db *sql.DB, webDist string) http.Handler {
	s := &server{db: db}
	if fsys := embeddedWebFS(); fsys != nil {
		s.webFS = fsys
	} else if webDist != "" {
		s.webFS = os.DirFS(webDist)
	}
	return s
}

// ───────────────────────── 基础设施 ─────────────────────────

// writeJSON 与旧版 res.json 行为一致：不转义 HTML 字符。
//
// 先在内存里编码完再写头：json.Encoder 是流式的，一旦边编码边写响应，
// 中途失败就会留下一个"200 + 半截 JSON"，客户端拿到无法解析的响应却
// 以为请求成功了。先编码则失败时可以干净地返回 500。
func writeJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		fmt.Println("[twische] 响应序列化失败:", err)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		buf.Reset()
		enc = json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		enc.Encode(map[string]any{"ok": false, "code": "internal_error", "message": "服务器内部错误"})
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	w.Write(buf.Bytes())
}

func (s *server) respondError(w http.ResponseWriter, err error) {
	var ae *AppError
	if !errors.As(err, &ae) {
		fmt.Println("[twische] 未处理异常:", err)
		ae = &AppError{Code: "internal_error", Message: "服务器内部错误", Status: 500}
	}
	if v, ok := ae.Extra["retryAfterSec"]; ok {
		switch n := v.(type) {
		case int:
			w.Header().Set("Retry-After", itoa(n))
		case int64:
			w.Header().Set("Retry-After", strconv.FormatInt(n, 10))
		}
	}
	body := map[string]any{"ok": false}
	for k, v := range ae.Body() {
		body[k] = v
	}
	writeJSON(w, ae.Status, body)
}

func securityHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	// 字体与脚本全部自托管，因此 CSP 可以收得很紧。
	// worker-src 必须放开 blob: —— PWA 的 Service Worker 更新检查会用到。
	h.Set("Content-Security-Policy", strings.Join([]string{
		"default-src 'self'",
		"script-src 'self'",
		// Vue 的 <style> 与运行时内联样式需要 unsafe-inline
		"style-src 'self' 'unsafe-inline'",
		// fontsource 字体包里部分字型以内嵌 data: URI 分发
		"font-src 'self' data:",
		"img-src 'self' data: blob:",
		"connect-src 'self'",
		"worker-src 'self' blob:",
		"manifest-src 'self'",
		"base-uri 'none'",
		"form-action 'none'",
		"object-src 'none'",
		"frame-ancestors 'none'",
	}, "; "))
}

// readBody 读取并解析 JSON 请求体。
//
// 与旧版 express.json 一致：只认 application/json；空体返回空对象；
// 超限 413；解析失败 400。顶层用 RawMessage 保留字段原貌（data 的
// 键序与数字字面量不被二次改写，等价旧版 JSON.stringify 的行为）。
func readBody(r *http.Request) (map[string]json.RawMessage, *AppError) {
	body := map[string]json.RawMessage{}
	ct := r.Header.Get("Content-Type")
	if ct == "" {
		return body, nil
	}
	mt, _, err := mime.ParseMediaType(ct)
	if err != nil || !strings.EqualFold(mt, "application/json") {
		// 带体但不是 JSON：明确拒绝，而不是"忽略请求体照常处理"。
		// 后者会让一个 4 MB 的表单体在 keep-alive 连接上反复占用内存。
		if r.ContentLength != 0 {
			return nil, E.BadRequest("请求体必须是 application/json")
		}
		return body, nil
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, Sync.MaxBodyBytes+1))
	if err != nil {
		return nil, E.TooLarge("请求体超出上限")
	}
	if int64(len(raw)) > Sync.MaxBodyBytes {
		return nil, E.TooLarge("请求体超出上限")
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return body, nil
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, E.BadRequest("请求体不是合法的 JSON")
	}
	return body, nil
}

// csrfGuard 自定义请求头 + Origin 校验。跨站表单无法设置自定义头，
// 跨站 fetch 会因预检失败而拿不到响应，因此只要强制要求该头，伪造请求就无从下手。
func csrfGuard(r *http.Request) *AppError {
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return nil
	}
	if r.Header.Get("x-twische-client") != "web" {
		return E.BadRequest("缺少客户端标识头")
	}
	origin := r.Header.Get("Origin")
	if origin != "" {
		host := r.Host
		u, err := urlParse(origin)
		if err != nil {
			return E.BadRequest("Origin 头不合法")
		}
		if u.Host != host {
			return &AppError{Code: "csrf", Message: "跨站请求被拒绝", Status: 403}
		}
	}
	return nil
}

func readCookie(r *http.Request, name string) string {
	raw := r.Header.Get("Cookie")
	if raw == "" {
		return ""
	}
	for _, part := range strings.Split(raw, ";") {
		eq := strings.Index(part, "=")
		if eq < 0 {
			continue
		}
		if strings.TrimSpace(part[:eq]) == name {
			return cookieUnescape(strings.TrimSpace(part[eq+1:]))
		}
	}
	return ""
}

func isSecure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if Server.TrustProxy && r.Header.Get("x-forwarded-proto") == "https" {
		return true
	}
	return false
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, token string, maxAgeMs int64) {
	http.SetCookie(w, &http.Cookie{
		Name:     Auth.CookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(maxAgeMs / 1000),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   isSecure(r),
	})
}

func clearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     Auth.CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1, // 序列化为 Max-Age=0，浏览器即删除
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   isSecure(r),
	})
}

// clientIp 取请求来源 IP。
//
// 信任反向代理时取 X-Forwarded-For 的**最右**一跳，而不是最左。
// 最左一份是客户端自己写的：取它等于把限流的身份标识交给攻击者，
// 每次请求伪造一个新 IP 就能让 IP 级限流彻底失效（实测可绕过）。
// 最右一份由直接连上来的那一跳（也就是我们信任的代理）追加，才可信。
// 多级代理的场景请在最外层代理上覆写而不是追加该头。
func clientIp(r *http.Request) string {
	if Server.TrustProxy {
		xff := r.Header.Get("x-forwarded-for")
		if xff != "" {
			parts := strings.Split(xff, ",")
			if last := strings.TrimSpace(parts[len(parts)-1]); last != "" {
				return last
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// requireElevation 敏感操作的统一闸门：会话必须在提权有效期内。
//
// 未提权时允许请求体里带 password 现场换取提权（登录后 15 分钟内免再次输入），
// 否则返回 password_required，让客户端弹窗后重试。
func (s *server) requireElevation(sess *Session, body map[string]json.RawMessage, action string) *AppError {
	if isElevated(sess) {
		return nil
	}
	if password, ok := bodyString(body, "password"); ok && password != "" {
		return elevateSession(s.db, sess, password)
	}
	audit(s.db, "device.manage_denied", action+" 需要提权", sess.IP.String, sess.DeviceID)
	return E.PasswordRequired()
}

// requireSession 载入会话。失败即 401；设备行丢失时吊销会话并清 cookie。
func (s *server) requireSession(w http.ResponseWriter, r *http.Request) (*Session, *Device, *AppError) {
	token := readCookie(r, Auth.CookieName)
	if token == "" {
		return nil, nil, E.Unauthorized()
	}
	sess, ok := verifySession(s.db, token)
	if !ok {
		return nil, nil, E.Unauthorized()
	}
	dev, err := selectDevice(s.db, sess.DeviceID)
	if err == sql.ErrNoRows {
		// 设备行被手工删除，会话失去主体，视为失效
		revokeSession(s.db, sess.ID, "device_missing")
		clearSessionCookie(w, r)
		return nil, nil, E.Unauthorized()
	} else if err != nil {
		return nil, nil, internalErr(err)
	}
	return sess, dev, nil
}

// requireInitGate 未初始化就拒绝提供任何业务接口。
func (s *server) requireInitGate() *AppError {
	if !isInitialized(s.db) {
		return E.NotInitialized()
	}
	return nil
}

// ───────────────────────── 请求体取值工具 ─────────────────────────

// bodyString 取字符串字段；缺失或类型不符返回 false（对齐 JS typeof 检查）。
func bodyString(body map[string]json.RawMessage, key string) (string, bool) {
	raw, ok := body[key]
	if !ok {
		return "", false
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

// parseNumberField 对齐 JS Number(x) 的宽松转换：数字字面量或数字字符串。
func parseNumberField(raw json.RawMessage) (float64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return 0, false
	}
	if trimmed[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return 0, false
		}
		trimmed = strings.TrimSpace(s)
	}
	f, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

// ───────────────────────── 总入口 ─────────────────────────

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	securityHeaders(w)

	p := r.URL.Path
	if p != "/api" && len(p) > 1 && strings.HasSuffix(p, "/") {
		p = strings.TrimRight(p, "/") // express 默认容忍尾斜杠
		if p == "" {
			p = "/"
		}
	}

	if p == "/api" || strings.HasPrefix(p, "/api/") {
		if err := s.routeAPI(w, r, p); err != nil {
			s.respondError(w, err)
		}
		return
	}
	s.serveStatic(w, r, p)
}

// routeAPI 全部业务接口。未命中的路径返回 JSON 404，而不是掉进 SPA 的 index.html。
func (s *server) routeAPI(w http.ResponseWriter, r *http.Request, p string) error {
	body, err := readBody(r)
	if err != nil {
		return err
	}
	if apiErr := csrfGuard(r); apiErr != nil {
		return apiErr
	}

	key := r.Method + " " + p
	switch key {
	case "GET /api/health":
		writeJSON(w, 200, map[string]any{
			"ok":          true,
			"initialized": isInitialized(s.db),
			"version":     Version,
			"time":        now(),
		})
		return nil

	case "GET /api/auth/status":
		// 未登录也要能拿到，否则前端无法区分"没初始化"与"没登录"。
		initialized := isInitialized(s.db)
		var initializedAt any
		if initialized {
			n := metaGetInt(s.db, META_KEYS.InitializedAt, 0)
			initializedAt = &n
		}
		writeJSON(w, 200, map[string]any{
			"initialized":   initialized,
			"version":       Version,
			"initializedAt": initializedAt,
		})
		return nil

	case "POST /api/auth/login":
		return s.handleLogin(w, r, body)

	case "GET /api/auth/session":
		if apiErr := s.requireInitGate(); apiErr != nil {
			return apiErr
		}
		sess, dev, apiErr := s.requireSession(w, r)
		if apiErr != nil {
			return apiErr
		}
		writeJSON(w, 200, map[string]any{
			"ok":           true,
			"device":       devicePublic(dev),
			"session":      sessionPublic(sess),
			"serverVector": globalVector(s.db),
			"stats":        stats(s.db),
		})
		return nil
	case "POST /api/auth/logout":
		// 允许未登录时调用（幂等），避免前端在会话已失效时卡住
		if sess, ok := verifySession(s.db, readCookie(r, Auth.CookieName)); ok {
			revokeSession(s.db, sess.ID, "logout")
			audit(s.db, "logout", "", clientIp(r), sess.DeviceID)
		}
		clearSessionCookie(w, r)
		writeJSON(w, 200, map[string]any{"ok": true})
		return nil

	case "POST /api/auth/password":
		if apiErr := s.requireInitGate(); apiErr != nil {
			return apiErr
		}
		sess, dev, apiErr := s.requireSession(w, r)
		if apiErr != nil {
			return apiErr
		}
		currentPassword, ok1 := bodyString(body, "currentPassword")
		newPassword, ok2 := bodyString(body, "newPassword")
		if !ok1 || !ok2 {
			return E.BadRequest("缺少密码字段")
		}
		result, apiErr := changePassword(s.db, currentPassword, newPassword,
			sess.ID, dev.ID, r.Header.Get("User-Agent"), clientIp(r))
		if apiErr != nil {
			return apiErr
		}
		// 新旧令牌交替：旧 cookie 立即失效，换发新的，当前设备不掉线
		setSessionCookie(w, r, result.Token, Auth.SessionTtlMs)
		writeJSON(w, 200, map[string]any{"ok": true, "revokedSessions": result.Revoked})
		return nil

	case "POST /api/auth/logout-all":
		if apiErr := s.requireInitGate(); apiErr != nil {
			return apiErr
		}
		_, dev, apiErr := s.requireSession(w, r)
		if apiErr != nil {
			return apiErr
		}
		n, err := revokeAllSessions(s.db, "logout_all", "")
		if err != nil {
			return internalErr(err)
		}
		audit(s.db, "logout.all", "吊销 "+itoa(int(n))+" 个会话", clientIp(r), dev.ID)
		clearSessionCookie(w, r)
		writeJSON(w, 200, map[string]any{"ok": true, "revokedSessions": n})
		return nil

	case "POST /api/sync":
		if apiErr := s.requireInitGate(); apiErr != nil {
			return apiErr
		}
		sess, dev, apiErr := s.requireSession(w, r)
		if apiErr != nil {
			return apiErr
		}
		return s.handleSync(w, r, body, sess, dev)

	case "GET /api/sync/vector":
		if apiErr := s.requireInitGate(); apiErr != nil {
			return apiErr
		}
		if _, _, apiErr := s.requireSession(w, r); apiErr != nil {
			return apiErr
		}
		writeJSON(w, 200, map[string]any{
			"ok":           true,
			"serverVector": globalVector(s.db),
			"stats":        stats(s.db),
		})
		return nil

	case "GET /api/sync/conflicts":
		if apiErr := s.requireInitGate(); apiErr != nil {
			return apiErr
		}
		if _, _, apiErr := s.requireSession(w, r); apiErr != nil {
			return apiErr
		}
		limit := int64(50)
		if v, err := strconv.ParseFloat(r.URL.Query().Get("limit"), 64); err == nil {
			limit = int64(v)
		}
		conflicts, err := listConflicts(s.db, limit)
		if err != nil {
			return internalErr(err)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "conflicts": conflicts})
		return nil

	case "GET /api/devices":
		if apiErr := s.requireInitGate(); apiErr != nil {
			return apiErr
		}
		_, dev, apiErr := s.requireSession(w, r)
		if apiErr != nil {
			return apiErr
		}
		devices, err := listDevices(s.db, dev.ID)
		if err != nil {
			return internalErr(err)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "devices": devices})
		return nil

	case "POST /api/devices/rename":
		if apiErr := s.requireInitGate(); apiErr != nil {
			return apiErr
		}
		sess, dev, apiErr := s.requireSession(w, r)
		if apiErr != nil {
			return apiErr
		}
		deviceID, ok1 := bodyString(body, "deviceId")
		name, ok2 := bodyString(body, "name")
		if !ok1 || !ok2 {
			return E.BadRequest("缺少设备标识或名称")
		}
		// 管理其它设备需要提权；改自己的名字不需要（登录即可）
		if deviceID != dev.ID {
			if apiErr := s.requireElevation(sess, body, "devices.rename"); apiErr != nil {
				return apiErr
			}
		}
		clean := truncateRunes(trimSpace(name), 60)
		if clean == "" {
			return E.BadRequest("设备名称不能为空")
		}
		var exists string
		if err := s.db.QueryRow("SELECT id FROM devices WHERE id = ?", deviceID).Scan(&exists); err != nil {
			if err == sql.ErrNoRows {
				return E.NotFound("设备不存在")
			}
			return internalErr(err)
		}
		if _, err := s.db.Exec("UPDATE devices SET name = ? WHERE id = ?", clean, deviceID); err != nil {
			return internalErr(err)
		}
		if deviceID != dev.ID {
			audit(s.db, "device.renamed", "改名 "+deviceID, clientIp(r), dev.ID)
		}
		devices, err := listDevices(s.db, dev.ID)
		if err != nil {
			return internalErr(err)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "devices": devices})
		return nil

	case "POST /api/devices/revoke":
		if apiErr := s.requireInitGate(); apiErr != nil {
			return apiErr
		}
		sess, dev, apiErr := s.requireSession(w, r)
		if apiErr != nil {
			return apiErr
		}
		deviceID, ok := bodyString(body, "deviceId")
		if !ok {
			return E.BadRequest("缺少设备标识")
		}
		if deviceID == dev.ID {
			return E.Conflict("无法吊销当前设备的会话，请使用退出登录")
		}
		if apiErr := s.requireElevation(sess, body, "devices.revoke"); apiErr != nil {
			return apiErr
		}
		info, err := s.db.Exec(
			"UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE device_id = ? AND revoked_at IS NULL",
			now(), "revoked_by_device", deviceID)
		if err != nil {
			return internalErr(err)
		}
		n, _ := info.RowsAffected()
		audit(s.db, "device.revoked", "吊销 "+itoa(int(n))+" 个会话", clientIp(r), dev.ID)
		devices, err := listDevices(s.db, dev.ID)
		if err != nil {
			return internalErr(err)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "revokedSessions": n, "devices": devices})
		return nil

	case "POST /api/devices/forget":
		if apiErr := s.requireInitGate(); apiErr != nil {
			return apiErr
		}
		sess, dev, apiErr := s.requireSession(w, r)
		if apiErr != nil {
			return apiErr
		}
		deviceID, ok := bodyString(body, "deviceId")
		if !ok {
			return E.BadRequest("缺少设备标识")
		}
		if deviceID == dev.ID {
			return E.Conflict("无法移除当前设备")
		}
		if apiErr := s.requireElevation(sess, body, "devices.forget"); apiErr != nil {
			return apiErr
		}
		tx, err := s.db.Begin()
		if err != nil {
			return internalErr(err)
		}
		if _, err := tx.Exec(
			"UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE device_id = ? AND revoked_at IS NULL",
			now(), "device_forgotten", deviceID); err != nil {
			tx.Rollback()
			return internalErr(err)
		}
		if _, err := tx.Exec("DELETE FROM devices WHERE id = ?", deviceID); err != nil {
			tx.Rollback()
			return internalErr(err)
		}
		// 注意：不能删除 device_clocks。它同时是向量时钟的历史注册表，
		// 删除后任何引用过该设备的记录都会在后续推送中被判为“未登记设备”。
		if err := tx.Commit(); err != nil {
			return internalErr(err)
		}
		audit(s.db, "device.forgotten", deviceID, clientIp(r), dev.ID)
		devices, err := listDevices(s.db, dev.ID)
		if err != nil {
			return internalErr(err)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "devices": devices})
		return nil

	case "GET /api/account":
		if apiErr := s.requireInitGate(); apiErr != nil {
			return apiErr
		}
		if _, _, apiErr := s.requireSession(w, r); apiErr != nil {
			return apiErr
		}
		acct, apiErr := getAccount(s.db)
		if apiErr != nil {
			return apiErr
		}
		var lastLoginAt any
		if acct.LastLoginAt.Valid {
			n := acct.LastLoginAt.Int64
			lastLoginAt = &n
		}
		writeJSON(w, 200, map[string]any{
			"ok": true,
			"account": map[string]any{
				"username":          acct.Username,
				"createdAt":         acct.CreatedAt,
				"passwordUpdatedAt": acct.PasswordUpdatedAt,
				"lastLoginAt":       lastLoginAt,
			},
			"stats":       stats(s.db),
			"environment": DescribeEnv(),
		})
		return nil

	case "GET /api/account/export":
		if apiErr := s.requireInitGate(); apiErr != nil {
			return apiErr
		}
		if _, _, apiErr := s.requireSession(w, r); apiErr != nil {
			return apiErr
		}
		return s.handleExport(w)

	case "GET /api/account/audit":
		if apiErr := s.requireInitGate(); apiErr != nil {
			return apiErr
		}
		if _, _, apiErr := s.requireSession(w, r); apiErr != nil {
			return apiErr
		}
		limit := int64(50)
		if v, err := strconv.ParseFloat(r.URL.Query().Get("limit"), 64); err == nil && v >= 1 {
			limit = int64(v)
		}
		if limit < 1 {
			limit = 1
		}
		if limit > 200 {
			limit = 200
		}
		rows, err := s.db.Query("SELECT at, event, detail, ip FROM audit_log ORDER BY at DESC LIMIT ?", limit)
		if err != nil {
			return internalErr(err)
		}
		defer rows.Close()
		events := []map[string]any{}
		for rows.Next() {
			var at int64
			var event string
			var detail, ip sql.NullString
			if err := rows.Scan(&at, &event, &detail, &ip); err != nil {
				return internalErr(err)
			}
			events = append(events, map[string]any{"at": at, "event": event, "detail": detail.String, "ip": ip.String})
		}
		if err := rows.Err(); err != nil {
			return internalErr(err)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "events": events})
		return nil
	}

	return E.NotFound("接口不存在")
}

// ───────────────────────── 具体处理器 ─────────────────────────

func devicePublic(d *Device) map[string]any {
	return map[string]any{"id": d.ID, "name": d.Name, "platform": d.Platform.String}
}

func sessionPublic(s *Session) map[string]any {
	return map[string]any{
		"expiresAt":  s.ExpiresAt,
		"createdAt":  s.CreatedAt,
		"lastSeenAt": s.LastSeenAt,
		// 客户端据此决定设备管理操作是否需要先弹密码框，避免多一次失败往返
		"elevatedUntil": s.ElevatedUntil,
		"elevated":      isElevated(s),
	}
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request, body map[string]json.RawMessage) error {
	password, ok := bodyString(body, "password")
	if !ok {
		return E.BadRequest("缺少密码")
	}
	deviceID, ok := bodyString(body, "deviceId")
	if !ok || utf8Count(deviceID) < 8 || utf8Count(deviceID) > 128 {
		return E.BadRequest("设备标识不合法")
	}
	deviceName, _ := bodyString(body, "deviceName")

	token, device, session, apiErr := login(s.db, password, deviceID, deviceName,
		r.Header.Get("User-Agent"), clientIp(r))
	if apiErr != nil {
		return apiErr
	}
	setSessionCookie(w, r, token, Auth.SessionTtlMs)
	writeJSON(w, 200, map[string]any{
		"ok":           true,
		"device":       devicePublic(device),
		"expiresAt":    session.ExpiresAt,
		"serverVector": globalVector(s.db),
	})
	return nil
}

func (s *server) handleSync(w http.ResponseWriter, r *http.Request, body map[string]json.RawMessage, sess *Session, dev *Device) error {
	// session 绑定的设备与请求声明的设备必须一致，否则同一令牌可冒充任意设备
	if raw, present := body["deviceId"]; present {
		var declared string
		if json.Unmarshal(raw, &declared) != nil || declared != dev.ID {
			return &AppError{Code: "device_mismatch", Message: "会话与设备标识不匹配", Status: 403}
		}
	}

	var push []json.RawMessage
	if raw, present := body["push"]; present {
		if strings.TrimSpace(string(raw)) == "null" {
			return E.BadRequest("push 必须是数组")
		}
		if err := json.Unmarshal(raw, &push); err != nil {
			return E.BadRequest("push 必须是数组")
		}
	}

	cursor := int64(0)
	if raw, present := body["cursor"]; present {
		if f, ok := parseNumberField(raw); ok {
			cursor = int64(f) // 正数向零截断即 floor；负数由 syncOnce 钳到 0
		}
	}
	limit := int64(0)
	if raw, present := body["limit"]; present {
		if f, ok := parseNumberField(raw); ok {
			limit = int64(f)
		}
	}
	full := false
	if raw, present := body["full"]; present {
		var fv any
		if err := decodeWithNumber(raw, &fv); err == nil {
			full = truthyJSON(fv) == 1
		}
	}

	result, apiErr := syncOnce(s.db, dev.ID, cursor, push, limit, full)
	if apiErr != nil {
		return apiErr
	}
	writeJSON(w, 200, result)
	return nil
}

func (s *server) handleExport(w http.ResponseWriter) error {
	// 全量导出：把整个账户的数据吐成一个 JSON。
	// 数据自持是自托管工具的基本义务 —— 用户必须能随时带着数据走。
	rows, err := s.db.Query("SELECT " + recordColumns + " FROM records ORDER BY seq ASC")
	if err != nil {
		return internalErr(err)
	}
	defer rows.Close()
	records := []map[string]any{}
	for rows.Next() {
		r := &recordRow{}
		var origin sql.NullString
		if err := rows.Scan(&r.RowID, &r.Seq, &r.ID, &r.Kind, &r.Data, &r.Vc, &r.UpdatedAt,
			&r.Deleted, &r.ByteSize, &origin, &r.CreatedAt); err != nil {
			return internalErr(err)
		}
		data := json.RawMessage(r.Data)
		if len(bytes.TrimSpace(data)) == 0 {
			data = json.RawMessage("{}")
		}
		records = append(records, map[string]any{
			"id":        r.ID,
			"kind":      r.Kind,
			"data":      data,
			"vc":        parseVc(r.Vc),
			"updatedAt": r.UpdatedAt,
			"deleted":   r.Deleted != 0,
			"seq":       r.Seq,
		})
	}
	if err := rows.Err(); err != nil {
		return internalErr(err)
	}
	payload := map[string]any{
		"format":       "twische-export",
		"version":      1,
		"exportedAt":   now(),
		"serverVector": globalVector(s.db),
		"records":      records,
	}

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(payload); err != nil {
		return internalErr(err)
	}

	stamp := time.Now().UTC().Format("2006-01-02-15-04-05")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", "twische-export-"+stamp+".json"))
	w.WriteHeader(200)
	w.Write(buf.Bytes())
	return nil
}

// ───────────────────────── 静态资源 ─────────────────────────

func (s *server) serveStatic(w http.ResponseWriter, r *http.Request, p string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.NotFound(w, r)
		return
	}

	if s.webFS == nil {
		// 前端尚未构建：给出可照做的指引而不是空白页
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		w.WriteHeader(503)
		fmt.Fprint(w, `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>Twische · 尚未构建前端</title>
<body style="font-family:system-ui;max-width:34rem;margin:12vh auto;line-height:1.7;color:#151515">
<h1 style="font-weight:900">前端尚未构建</h1>
<p>后端已在运行，但找不到前端产物。请先在项目根目录执行：</p>
<pre style="background:#f4f4f4;padding:12px 14px;border-radius:4px">python build.py</pre>
<p>或开发模式下另开一个终端执行 <code>npm run dev:web</code>。</p>
</body></html>`)
		return
	}

	// 安全校验：path.Clean 只认 '/' 为分隔符。URL 里的 %5C 解码成反斜杠后
	// 会原样穿过 Clean，而 Windows 的 filepath 把 '\' 当分隔符 ——
	// 不拦下来就是目录穿越（详见 static_test.go 的守护用例）。
	name := path.Clean("/" + p)
	if strings.ContainsRune(name, '\\') || strings.ContainsRune(name, 0) {
		http.NotFound(w, r)
		return
	}

	rel := strings.TrimPrefix(name, "/")
	if rel == "" {
		rel = "index.html" // SPA 入口
		s.serveStaticFile(w, r, rel, true)
		return
	}

	if fi, err := fs.Stat(s.webFS, rel); err == nil && !fi.IsDir() {
		s.serveStaticFile(w, r, rel, false)
		return
	}

	// SPA fallback：所有未命中的路径交给 index.html（Service Worker 与入口
	// HTML 绝不能被缓存，否则用户拿不到新版本）
	s.serveStaticFile(w, r, "index.html", true)
}

// serveStaticFile 从 webFS 读出单个文件并回写。noCache 用于入口 HTML 与
// sw.js —— 它们是版本更新的生命线，必须每次回源校验。
func (s *server) serveStaticFile(w http.ResponseWriter, r *http.Request, name string, noCache bool) {
	f, err := s.webFS.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()

	if noCache {
		w.Header().Set("Cache-Control", "no-cache, must-revalidate")
	} else {
		s.setStaticCacheHeaders(w, name)
	}

	var rs io.ReadSeeker
	if seeker, ok := f.(io.ReadSeeker); ok {
		rs = seeker
	} else {
		// fs.FS 不保证可 Seek；兜底整体读入（前端产物都很小）
		data, err := io.ReadAll(f)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		rs = bytes.NewReader(data)
	}

	var modTime time.Time
	if fi, err := f.Stat(); err == nil {
		modTime = fi.ModTime()
	}
	http.ServeContent(w, r, path.Base(name), modTime, rs)
}

func (s *server) setStaticCacheHeaders(w http.ResponseWriter, relPath string) {
	base := path.Base(relPath)
	switch base {
	case "sw.js", "index.html":
		w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		if base == "sw.js" {
			w.Header().Set("Service-Worker-Allowed", "/")
		}
		return
	}
	switch strings.ToLower(path.Ext(base)) {
	case ".woff2", ".woff", ".png", ".svg", ".ico", ".webmanifest":
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		return
	}
	// Vite 产物带内容哈希，可长缓存
	if path.Dir(relPath) == "assets" {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
}

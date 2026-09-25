// 服务端集成测试：真起 HTTP 服务、真走 cookie、真跑一次完整同步往返。
// 从旧版 server/test/api.test.js 全量移植，断言语义逐条对应。
package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const testPassword = "Twische@2026!ok"

// instance 一个独立的测试实例。
type instance struct {
	db   *sql.DB
	base string
	ts   *httptest.Server
	jars map[string]string
}

func makeInstance(t *testing.T, initialized bool) *instance {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := openDatabase(dbPath)
	if err != nil {
		t.Fatalf("打开数据库失败: %v", err)
	}

	if initialized {
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(
			`INSERT INTO account (id, username, password_hash, password_algo, password_rounds, password_updated_at, created_at)
			 VALUES (1, 'tester', ?, 'bcrypt', 4, ?, ?)`,
			hashPassword(testPassword, 4), nowMs(), nowMs(),
		); err != nil {
			t.Fatal(err)
		}
		metaSetInt(tx, META_KEYS.InitializedAt, nowMs())
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}

	app := NewApp(db, "")
	ts := httptest.NewServer(app)
	inst := &instance{db: db, base: ts.URL, ts: ts, jars: map[string]string{}}
	t.Cleanup(func() {
		ts.Close()
		db.Close()
		os.RemoveAll(dir)
	})
	return inst
}

type apiResponse struct {
	status  int
	json    map[string]any
	jsonArr []any
	text    string
	headers http.Header
}

// call 带 cookie 的请求封装（手工接管，对齐旧测试的 jar 行为）。
func (inst *instance) call(t *testing.T, method, p string, body any, opts map[string]string) *apiResponse {
	t.Helper()
	headers := map[string]string{"x-twische-client": "web"}
	for k, v := range opts {
		headers[k] = v
	}
	var payload io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		payload = bytes.NewReader(b)
		headers["content-type"] = "application/json"
	}
	cookie := opts["cookie"]
	if cookie == "" {
		cookie = inst.jars["default"]
	}

	req, err := http.NewRequest(method, inst.base+p, payload)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		if v != "" {
			req.Header.Set(k, v)
		}
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	rawSetCookies := res.Header.Values("Set-Cookie")
	if len(rawSetCookies) > 0 {
		all := strings.Join(rawSetCookies, ";")
		if strings.Contains(all, "Max-Age=0") {
			delete(inst.jars, "default")
		} else {
			var pairs []string
			for _, c := range rawSetCookies {
				pairs = append(pairs, strings.Split(c, ";")[0])
			}
			inst.jars["default"] = strings.Join(pairs, "; ")
		}
	}

	buf := new(bytes.Buffer)
	buf.ReadFrom(res.Body)
	out := &apiResponse{status: res.StatusCode, text: buf.String(), headers: res.Header}
	var m map[string]any
	if json.Unmarshal(buf.Bytes(), &m) == nil {
		out.json = m
	}
	return out
}

func (inst *instance) login(t *testing.T, opts map[string]string) *apiResponse {
	password := testPassword
	deviceID := "device-A-0001"
	deviceName := "测试设备"
	if opts != nil {
		if v, ok := opts["password"]; ok {
			password = v
		}
		if v, ok := opts["deviceId"]; ok {
			deviceID = v
		}
		if v, ok := opts["deviceName"]; ok {
			deviceName = v
		}
	}
	return inst.call(t, "POST", "/api/auth/login", map[string]any{
		"password": password, "deviceId": deviceID, "deviceName": deviceName,
	}, nil)
}

func (inst *instance) loginSimple(t *testing.T) *apiResponse {
	return inst.login(t, nil)
}

// registerDevice 登记一台额外设备（登录一次即可），并恢复调用前的会话 cookie。
//
// 向量时钟的设备键必须对应真实登记过的设备（否则任意字符串都能凭空造出
// device_clocks 行，污染全局版本向量），所以"以另一台设备的名义写时钟"
// 这类用例必须先把那台设备登录出来。
func (inst *instance) registerDevice(t *testing.T, deviceID, name string) string {
	t.Helper()
	prev := inst.jars["default"]
	res := inst.login(t, map[string]string{"deviceId": deviceID, "deviceName": name})
	if res.status != 200 {
		t.Fatalf("登记设备 %s 失败: %d %s", deviceID, res.status, res.text)
	}
	cookie := inst.jars["default"]
	inst.jars["default"] = prev
	return cookie
}

// rec 构造一条合法的入站记录。
func rec(id string, vc map[string]any, data any, updatedAt int64, extra map[string]any) map[string]any {
	out := map[string]any{
		"id": id, "kind": "task", "data": data, "vc": vc, "updatedAt": updatedAt, "deleted": false,
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func syncBody(deviceID string, cursor int64, push []map[string]any) map[string]any {
	b := map[string]any{"deviceId": deviceID, "cursor": cursor}
	if push != nil {
		b["push"] = push
	}
	return b
}

func mustJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	b, _ := json.Marshal(v)
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("非对象 JSON: %v", err)
	}
	return m
}

func assertDeepEqual(t *testing.T, got, want any, label string) {
	t.Helper()
	gb, _ := json.Marshal(got)
	wb, _ := json.Marshal(want)
	if !bytes.Equal(gb, wb) {
		t.Fatalf("%s 不一致\n got: %s\nwant: %s", label, gb, wb)
	}
}

// ═══════════════════════════════════════════════════════════

func TestHealthAndInitGate(t *testing.T) {
	t.Run("未初始化时 health 报 initialized=false，且业务接口返回 503", func(t *testing.T) {
		inst := makeInstance(t, false)
		health := inst.call(t, "GET", "/api/health", nil, nil)
		if health.status != 200 || health.json["initialized"] != false {
			t.Fatalf("health 异常: %v", health.json)
		}
		status := inst.call(t, "GET", "/api/auth/status", nil, nil)
		if status.json["initialized"] != false {
			t.Fatalf("status.initialized 应为 false: %v", status.json)
		}
		if status.json["initializedAt"] != nil {
			t.Fatalf("initializedAt 应为 null: %v", status.json)
		}
		login := inst.loginSimple(t)
		if login.status != 503 || login.json["code"] != "not_initialized" {
			t.Fatalf("login 应 503/not_initialized: %d %v", login.status, login.json)
		}
		if !regexp.MustCompile("初始化").MatchString(login.json["message"].(string)) {
			t.Fatalf("message 应包含 初始化: %v", login.json["message"])
		}
	})

	t.Run("已初始化时 health 与 auth/status 正常", func(t *testing.T) {
		inst := makeInstance(t, true)
		health := inst.call(t, "GET", "/api/health", nil, nil)
		if health.json["initialized"] != true {
			t.Fatalf("initialized 应为 true")
		}
		status := inst.call(t, "GET", "/api/auth/status", nil, nil)
		if status.json["initialized"] != true {
			t.Fatal("status 应已初始化")
		}
		ia, _ := status.json["initializedAt"].(float64)
		if ia <= 0 {
			t.Fatalf("initializedAt 应 > 0: %v", status.json["initializedAt"])
		}
	})
}

func TestCsrfAndSession(t *testing.T) {
	t.Run("缺少客户端标识头的写请求被拒绝", func(t *testing.T) {
		inst := makeInstance(t, true)
		res := inst.call(t, "POST", "/api/auth/login",
			map[string]any{"password": testPassword, "deviceId": "device-A-0001"},
			map[string]string{"x-twische-client": ""})
		if res.status != 400 || res.json["code"] != "bad_request" {
			t.Fatalf("应 400/bad_request: %d %v", res.status, res.json)
		}
	})

	t.Run("跨站 Origin 的写请求被拒绝", func(t *testing.T) {
		inst := makeInstance(t, true)
		res := inst.call(t, "POST", "/api/auth/login",
			map[string]any{"password": testPassword, "deviceId": "device-A-0001"},
			map[string]string{"Origin": "https://evil.example.com"})
		if res.status != 403 || res.json["code"] != "csrf" {
			t.Fatalf("应 403/csrf: %d %v", res.status, res.json)
		}
	})

	t.Run("密码错误返回 401 且不泄漏账户是否存在", func(t *testing.T) {
		inst := makeInstance(t, true)
		res := inst.login(t, map[string]string{"password": "wrong-password-here"})
		if res.status != 401 || res.json["code"] != "bad_credentials" {
			t.Fatalf("应 401/bad_credentials: %d %v", res.status, res.json)
		}
		if res.json["message"] != "密码不正确" {
			t.Fatalf("message 应为 密码不正确: %v", res.json["message"])
		}
	})

	t.Run("登录成功后下发 httpOnly cookie，且能读取会话", func(t *testing.T) {
		inst := makeInstance(t, true)
		res := inst.loginSimple(t)
		if res.status != 200 || res.json["ok"] != true {
			t.Fatalf("login 失败: %d %v", res.status, res.json)
		}
		dev := res.json["device"].(map[string]any)
		if dev["id"] != "device-A-0001" {
			t.Fatalf("device.id 应为 device-A-0001: %v", dev)
		}
		cookie := inst.jars["default"]
		if !strings.HasPrefix(cookie, "twische_sid=") {
			t.Fatalf("未下发会话 cookie: %q", cookie)
		}
		sess := inst.call(t, "GET", "/api/auth/session", nil, nil)
		if sess.status != 200 {
			t.Fatalf("session 应 200: %d", sess.status)
		}
		if sess.json["device"].(map[string]any)["id"] != "device-A-0001" {
			t.Fatal("session.device.id 不符")
		}
		stats := sess.json["stats"].(map[string]any)
		if _, ok := stats["records"]; !ok {
			t.Fatal("session.stats.records 缺失")
		}
	})

	t.Run("无 cookie 访问受保护接口返回 401", func(t *testing.T) {
		inst := makeInstance(t, true)
		res := inst.call(t, "GET", "/api/auth/session", nil, nil)
		if res.status != 401 || res.json["code"] != "unauthorized" {
			t.Fatalf("应 401/unauthorized: %d %v", res.status, res.json)
		}
	})

	t.Run("伪造的令牌形状不正确时直接判无效", func(t *testing.T) {
		inst := makeInstance(t, true)
		res := inst.call(t, "GET", "/api/auth/session", nil, map[string]string{"cookie": "twische_sid=garbage"})
		if res.status != 401 {
			t.Fatalf("应 401: %d", res.status)
		}
	})
}

func TestLoginLockout(t *testing.T) {
	t.Run("连续失败触发锁定，且锁定会持久化到库（重启不可绕过）", func(t *testing.T) {
		inst := makeInstance(t, true)
		ResetThrottle()
		defer ResetThrottle()
		for i := 0; i < 4; i++ {
			res := inst.login(t, map[string]string{"password": "bad-password-attempt"})
			if res.status != 401 || res.json["code"] != "bad_credentials" {
				t.Fatalf("第 %d 次尝试不应被锁定: %d %v", i+1, res.status, res.json)
			}
		}
		locked := inst.login(t, map[string]string{"password": "bad-password-attempt"})
		if locked.status != 429 || locked.json["code"] != "locked" {
			t.Fatalf("第 5 次应 429/locked: %d %v", locked.status, locked.json)
		}
		if ras, _ := locked.json["retryAfterSec"].(float64); ras < 1 {
			t.Fatalf("retryAfterSec 应 >= 1: %v", locked.json["retryAfterSec"])
		}
		if locked.headers.Get("Retry-After") == "" {
			t.Fatal("缺少 Retry-After 响应头")
		}
		var failed int64
		var lockedUntil int64
		inst.db.QueryRow("SELECT failed_attempts, locked_until FROM account WHERE id = 1").Scan(&failed, &lockedUntil)
		if failed != 5 {
			t.Fatalf("failed_attempts 应为 5: %d", failed)
		}
		if lockedUntil <= nowMs() {
			t.Fatal("locked_until 应在未来")
		}
		correctButLocked := inst.loginSimple(t)
		if correctButLocked.status != 429 {
			t.Fatalf("锁定期内正确密码也必须被拒: %d", correctButLocked.status)
		}
	})

	t.Run("锁定到期或手工清零后，正确密码可正常登录", func(t *testing.T) {
		inst := makeInstance(t, true)
		ResetThrottle()
		defer ResetThrottle()
		inst.login(t, map[string]string{"password": "bad"})
		inst.db.Exec("UPDATE account SET failed_attempts = 0, locked_until = 0 WHERE id = 1")
		okRes := inst.loginSimple(t)
		if okRes.status != 200 {
			t.Fatalf("正确密码应能登录: %d", okRes.status)
		}
		var failed int64
		inst.db.QueryRow("SELECT failed_attempts FROM account WHERE id = 1").Scan(&failed)
		if failed != 0 {
			t.Fatalf("登录成功后失败计数必须清零: %d", failed)
		}
	})
}

func TestSyncProtocol(t *testing.T) {
	loggedIn := func(t *testing.T) *instance {
		inst := makeInstance(t, true)
		res := inst.loginSimple(t)
		if res.status != 200 {
			t.Fatalf("login 失败: %d", res.status)
		}
		return inst
	}

	t.Run("首次推送创建记录，重复推送幂等且不推进游标", func(t *testing.T) {
		inst := loggedIn(t)
		r1 := rec("task-1", map[string]any{"device-A-0001": 1}, map[string]any{"title": "写周报"}, 1000, nil)
		first := inst.call(t, "POST", "/api/sync", syncBody("device-A-0001", 0, []map[string]any{r1}), nil)
		if first.status != 200 {
			t.Fatalf("sync 失败: %d %s", first.status, first.text)
		}
		assertDeepEqual(t, first.json["applied"], []any{map[string]any{"id": "task-1", "status": "created"}}, "applied")
		recs := first.json["records"].([]any)
		if len(recs) != 1 {
			t.Fatalf("records 应 1 条: %v", recs)
		}
		cursor := int64(first.json["cursor"].(float64))
		if cursor < 1 {
			t.Fatalf("cursor 应 >= 1: %d", cursor)
		}
		second := inst.call(t, "POST", "/api/sync", syncBody("device-A-0001", cursor, []map[string]any{r1}), nil)
		assertDeepEqual(t, second.json["applied"],
			[]any{map[string]any{"id": "task-1", "status": "unchanged", "seq": float64(cursor)}}, "applied(replay)")
		if len(second.json["records"].([]any)) != 0 {
			t.Fatal("幂等重放不应再次下发同一条记录")
		}
		if int64(second.json["cursor"].(float64)) != cursor {
			t.Fatal("无写入时游标不得前进")
		}
	})

	t.Run("支配关系判定：新版本被接受，旧版本被判 stale 并回吐服务端版本", func(t *testing.T) {
		inst := loggedIn(t)
		inst.call(t, "POST", "/api/sync",
			syncBody("device-A-0001", 0, []map[string]any{rec("task-1", map[string]any{"device-A-0001": 1}, map[string]any{"title": "旧"}, 1000, nil)}), nil)
		upd := inst.call(t, "POST", "/api/sync",
			syncBody("device-A-0001", 0, []map[string]any{rec("task-1", map[string]any{"device-A-0001": 2}, map[string]any{"title": "新"}, 2000, nil)}), nil)
		assertDeepEqual(t, upd.json["applied"], []any{map[string]any{"id": "task-1", "status": "updated"}}, "applied")
		for _, r := range upd.json["records"].([]any) {
			rm := r.(map[string]any)
			if rm["id"] == "task-1" {
				if rm["data"].(map[string]any)["title"] != "新" {
					t.Fatalf("records 中应为新标题: %v", rm)
				}
			}
		}
		stale := inst.call(t, "POST", "/api/sync",
			syncBody("device-A-0001", 0, []map[string]any{rec("task-1", map[string]any{"device-A-0001": 1}, map[string]any{"title": "旧"}, 1000, nil)}), nil)
		applied := stale.json["applied"].([]any)[0].(map[string]any)
		if applied["status"] != "stale" {
			t.Fatalf("应 stale: %v", applied)
		}
		assertDeepEqual(t, applied["serverVc"], map[string]any{"device-A-0001": float64(2)}, "serverVc")
		var corrected map[string]any
		for _, c := range stale.json["corrections"].([]any) {
			if c.(map[string]any)["id"] == "task-1" {
				corrected = c.(map[string]any)
			}
		}
		if corrected == nil {
			t.Fatal("stale 必须回吐纠正数据")
		}
		if corrected["data"].(map[string]any)["title"] != "新" {
			t.Fatalf("纠正数据应为新标题: %v", corrected)
		}
		assertDeepEqual(t, corrected["vc"], map[string]any{"device-A-0001": float64(2)}, "corrected.vc")
	})

	t.Run("stale 纠正不受游标影响：即使游标已越过该记录也能拿到服务端版本", func(t *testing.T) {
		inst := loggedIn(t)
		first := inst.call(t, "POST", "/api/sync",
			syncBody("device-A-0001", 0, []map[string]any{rec("task-1", map[string]any{"device-A-0001": 1}, map[string]any{"title": "v1"}, 1000, nil)}), nil)
		afterFirst := int64(first.json["cursor"].(float64))
		second := inst.call(t, "POST", "/api/sync",
			syncBody("device-A-0001", afterFirst, []map[string]any{rec("task-1", map[string]any{"device-A-0001": 2}, map[string]any{"title": "v2"}, 2000, nil)}), nil)
		cursor := int64(second.json["cursor"].(float64))
		res := inst.call(t, "POST", "/api/sync",
			syncBody("device-A-0001", cursor, []map[string]any{rec("task-1", map[string]any{"device-A-0001": 1}, map[string]any{"title": "v1"}, 1000, nil)}), nil)
		if res.json["applied"].([]any)[0].(map[string]any)["status"] != "stale" {
			t.Fatal("应 stale")
		}
		if len(res.json["records"].([]any)) != 0 {
			t.Fatal("游标已到顶，pull 侧不应有内容")
		}
		var corrected map[string]any
		for _, c := range res.json["corrections"].([]any) {
			if c.(map[string]any)["id"] == "task-1" {
				corrected = c.(map[string]any)
			}
		}
		if corrected == nil {
			t.Fatal("若纠正数据只走 pull，客户端会永久停留在错误版本")
		}
		if corrected["data"].(map[string]any)["title"] != "v2" {
			t.Fatalf("纠正数据应为 v2: %v", corrected)
		}
	})

	t.Run("并发冲突：按墙钟决胜，且合并后的向量时钟同时支配双方", func(t *testing.T) {
		inst := loggedIn(t)
		cookieA := inst.jars["default"]
		cookieB := inst.registerDevice(t, "device-B-0002", "B 的手机")
		inst.call(t, "POST", "/api/sync",
			syncBody("device-A-0001", 0, []map[string]any{rec("task-1", map[string]any{"device-A-0001": 1}, map[string]any{"title": "A 的版本"}, 1000, nil)}), nil)
		inst.jars["default"] = cookieB
		r := inst.call(t, "POST", "/api/sync",
			syncBody("device-B-0002", 0, []map[string]any{rec("task-1", map[string]any{"device-B-0002": 1}, map[string]any{"title": "B 的版本"}, 5000, nil)}), nil)
		inst.jars["default"] = cookieA
		if r.json["applied"].([]any)[0].(map[string]any)["status"] != "conflict:client-won" {
			t.Fatal("应 conflict:client-won")
		}
		if len(r.json["conflicts"].([]any)) != 1 {
			t.Fatal("conflicts 应 1 条")
		}
		var vcRaw, dataRaw string
		inst.db.QueryRow("SELECT vc, data FROM records WHERE id = 'task-1'").Scan(&vcRaw, &dataRaw)
		var storedVc map[string]any
		json.Unmarshal([]byte(vcRaw), &storedVc)
		assertDeepEqual(t, storedVc, map[string]any{"device-A-0001": float64(1), "device-B-0002": float64(1)}, "合并后的时钟必须是并集")
		var storedData map[string]any
		json.Unmarshal([]byte(dataRaw), &storedData)
		if storedData["title"] != "B 的版本" {
			t.Fatalf("赢家数据应为 B 的版本: %v", storedData)
		}
		conflicts := inst.call(t, "GET", "/api/sync/conflicts", nil, nil)
		if len(conflicts.json["conflicts"].([]any)) != 1 {
			t.Fatal("conflicts 接口应 1 条")
		}
		if conflicts.json["conflicts"].([]any)[0].(map[string]any)["winner"] != "client" {
			t.Fatal("winner 应为 client")
		}
	})

	t.Run("冲突只判定一次：输家重推被判 stale 而非再次冲突（防乒乓）", func(t *testing.T) {
		inst := loggedIn(t)
		cookieA := inst.jars["default"]
		cookieB := inst.registerDevice(t, "device-B-0002", "B 的手机")
		original := rec("task-1", map[string]any{"device-A-0001": 1}, map[string]any{"title": "A 的版本"}, 1000, nil)
		inst.call(t, "POST", "/api/sync", syncBody("device-A-0001", 0, []map[string]any{original}), nil)
		inst.jars["default"] = cookieB
		inst.call(t, "POST", "/api/sync",
			syncBody("device-B-0002", 0, []map[string]any{rec("task-1", map[string]any{"device-B-0002": 1}, map[string]any{"title": "B 的版本"}, 5000, nil)}), nil)
		inst.jars["default"] = cookieA
		again := inst.call(t, "POST", "/api/sync", syncBody("device-A-0001", 0, []map[string]any{original}), nil)
		if again.json["applied"].([]any)[0].(map[string]any)["status"] != "stale" {
			t.Fatal("若仍判为并发，两端会无限互相覆盖，永远收敛不了")
		}
		var corrected map[string]any
		for _, c := range again.json["corrections"].([]any) {
			if c.(map[string]any)["id"] == "task-1" {
				corrected = c.(map[string]any)
			}
		}
		if corrected == nil {
			t.Fatal("被纠正的数据必须随响应下发")
		}
		if corrected["data"].(map[string]any)["title"] != "B 的版本" {
			t.Fatalf("A 应当被纠正到赢家版本: %v", corrected)
		}
		assertDeepEqual(t, corrected["vc"],
			map[string]any{"device-A-0001": float64(1), "device-B-0002": float64(1)}, "corrected.vc")
	})

	t.Run("冲突赢家也要收到纠正，用来采纳合并后的向量时钟（省一个来回）", func(t *testing.T) {
		inst := loggedIn(t)
		cookieA := inst.jars["default"]
		cookieB := inst.registerDevice(t, "device-B-0002", "B 的手机")
		inst.call(t, "POST", "/api/sync",
			syncBody("device-A-0001", 0, []map[string]any{rec("task-1", map[string]any{"device-A-0001": 1}, map[string]any{"title": "A"}, 1000, nil)}), nil)
		inst.jars["default"] = cookieB
		res := inst.call(t, "POST", "/api/sync",
			syncBody("device-B-0002", 0, []map[string]any{rec("task-1", map[string]any{"device-B-0002": 1}, map[string]any{"title": "B"}, 5000, nil)}), nil)
		inst.jars["default"] = cookieA
		if res.json["applied"].([]any)[0].(map[string]any)["status"] != "conflict:client-won" {
			t.Fatal("应 conflict:client-won")
		}
		var corrected map[string]any
		for _, c := range res.json["corrections"].([]any) {
			if c.(map[string]any)["id"] == "task-1" {
				corrected = c.(map[string]any)
			}
		}
		if corrected == nil {
			t.Fatal("赢家也要收到纠正")
		}
		assertDeepEqual(t, corrected["vc"],
			map[string]any{"device-A-0001": float64(1), "device-B-0002": float64(1)},
			"本地 vc 应立刻升级为并集，否则下次推送必然被判 stale，多耗一个来回")
		if corrected["data"].(map[string]any)["title"] != "B" {
			t.Fatalf("corrected.title 应为 B: %v", corrected)
		}
	})

	t.Run("游标增量拉取：只下发游标之后被写入的记录", func(t *testing.T) {
		inst := loggedIn(t)
		first := inst.call(t, "POST", "/api/sync",
			syncBody("device-A-0001", 0, []map[string]any{rec("task-1", map[string]any{"device-A-0001": 1}, map[string]any{"title": "1"}, 1000, nil)}), nil)
		cursor := int64(first.json["cursor"].(float64))
		second := inst.call(t, "POST", "/api/sync",
			syncBody("device-A-0001", cursor, []map[string]any{rec("task-2", map[string]any{"device-A-0001": 2}, map[string]any{"title": "2"}, 2000, nil)}), nil)
		recs := second.json["records"].([]any)
		if len(recs) != 1 || recs[0].(map[string]any)["id"] != "task-2" {
			t.Fatalf("只应下发 task-2: %v", recs)
		}
		repeat := inst.call(t, "POST", "/api/sync", syncBody("device-A-0001", cursor, nil), nil)
		recs = repeat.json["records"].([]any)
		if len(recs) != 1 || recs[0].(map[string]any)["id"] != "task-2" {
			t.Fatalf("同一游标重复请求不应重复下发: %v", recs)
		}
	})

	t.Run("设备标识与会话不匹配时拒绝（防令牌冒充设备）", func(t *testing.T) {
		inst := loggedIn(t)
		res := inst.call(t, "POST", "/api/sync",
			map[string]any{"deviceId": "device-OTHER-9999", "cursor": 0, "push": []any{}}, nil)
		if res.status != 403 || res.json["code"] != "device_mismatch" {
			t.Fatalf("应 403/device_mismatch: %d %v", res.status, res.json)
		}
	})

	t.Run("入站记录校验：缺时钟 / 非法 vc / 非对象 data 都被拒", func(t *testing.T) {
		inst := loggedIn(t)
		cases := []struct {
			payload map[string]any
			pattern string
		}{
			{rec("t1", map[string]any{}, map[string]any{"title": "x"}, 1000, nil), "向量时钟"},
			{rec("t2", map[string]any{"device-A-0001": 0}, map[string]any{"title": "x"}, 1000, nil), "正整数"},
			{rec("t3", map[string]any{"device-A-0001": 1}, nil, 1000, nil), "data 必须是对象"},
			{rec("t4", map[string]any{"device-A-0001": 1}, map[string]any{"title": "x"}, 1000, map[string]any{"kind": "unknown"}), "不受支持"},
			{rec("t5", map[string]any{"device-A-0001": 1}, map[string]any{"title": "x"}, 1000, map[string]any{"updatedAt": "nope"}), "updatedAt"},
			{rec("t6", map[string]any{"device-A-0001": 1}, map[string]any{"title": "x"}, 1000, map[string]any{"id": ""}), "id"},
		}
		for _, c := range cases {
			res := inst.call(t, "POST", "/api/sync", syncBody("device-A-0001", 0, []map[string]any{c.payload}), nil)
			if res.status != 400 {
				t.Fatalf("未拒绝(%d)：%s", res.status, c.pattern)
			}
			if !strings.Contains(res.json["message"].(string), c.pattern) {
				t.Fatalf("message 应包含 %q: %v", c.pattern, res.json["message"])
			}
		}
		// 校验失败必须整批回滚，不能留下半截数据
		var n int
		inst.db.QueryRow("SELECT COUNT(*) FROM records").Scan(&n)
		if n != 0 {
			t.Fatalf("应无残留记录: %d", n)
		}
	})

	t.Run("墓碑水位：游标落后于水位时提示需要全量重建", func(t *testing.T) {
		inst := loggedIn(t)
		inst.call(t, "POST", "/api/sync",
			syncBody("device-A-0001", 0, []map[string]any{rec("task-1", map[string]any{"device-A-0001": 1}, map[string]any{"title": "x"}, 1000, nil)}), nil)
		metaSetInt(inst.db, META_KEYS.TombstoneFloorSeq, 999)
		res := inst.call(t, "POST", "/api/sync", syncBody("device-A-0001", 1, nil), nil)
		if res.json["resyncRequired"] != true {
			t.Fatal("resyncRequired 应为 true")
		}
		full := inst.call(t, "POST", "/api/sync",
			map[string]any{"deviceId": "device-A-0001", "cursor": 999, "full": true}, nil)
		if full.json["resyncRequired"] != false {
			t.Fatal("full 时 resyncRequired 应为 false")
		}
		if len(full.json["records"].([]any)) != 1 {
			t.Fatal("full 重建应下发 1 条")
		}
	})

	t.Run("删除以墓碑形式传播，且删除会产生新的 seq 供其它设备追平", func(t *testing.T) {
		inst := loggedIn(t)
		created := inst.call(t, "POST", "/api/sync",
			syncBody("device-A-0001", 0, []map[string]any{rec("task-1", map[string]any{"device-A-0001": 1}, map[string]any{"title": "x"}, 1000, nil)}), nil)
		afterCreate := int64(created.json["cursor"].(float64))
		del := inst.call(t, "POST", "/api/sync",
			syncBody("device-A-0001", afterCreate, []map[string]any{rec("task-1", map[string]any{"device-A-0001": 2}, map[string]any{}, 2000, map[string]any{"deleted": true})}), nil)
		if del.json["applied"].([]any)[0].(map[string]any)["status"] != "updated" {
			t.Fatal("删除应判 updated")
		}
		var pulled map[string]any
		for _, r := range del.json["records"].([]any) {
			if r.(map[string]any)["id"] == "task-1" {
				pulled = r.(map[string]any)
			}
		}
		if pulled == nil {
			t.Fatal("删除必须凭新的 seq 才能被其它设备拉到")
		}
		if pulled["deleted"] != true {
			t.Fatal("pulled.deleted 应为 true")
		}
		if int64(del.json["cursor"].(float64)) <= afterCreate {
			t.Fatal("墓碑必须推进游标，否则删除事件永远传不出去")
		}
	})

	t.Run("多设备各推各的：服务端全局向量包含所有设备分量", func(t *testing.T) {
		inst := loggedIn(t)
		cookieA := inst.jars["default"]
		cookieB := inst.registerDevice(t, "device-B-0002", "B 的手机")
		inst.call(t, "POST", "/api/sync",
			syncBody("device-A-0001", 0, []map[string]any{rec("task-a", map[string]any{"device-A-0001": 3}, map[string]any{"title": "a"}, 1000, nil)}), nil)
		// B 以自己的身份推一条，证明两台设备的分量各自成立
		inst.jars["default"] = cookieB
		inst.call(t, "POST", "/api/sync",
			syncBody("device-B-0002", 0, []map[string]any{rec("task-b", map[string]any{"device-B-0002": 7}, map[string]any{"title": "b"}, 2000, nil)}), nil)
		inst.jars["default"] = cookieA
		v := inst.call(t, "GET", "/api/sync/vector", nil, nil)
		sv := v.json["serverVector"].(map[string]any)
		if sv["device-A-0001"] != float64(3) || sv["device-B-0002"] != float64(7) {
			t.Fatalf("serverVector 不符: %v", sv)
		}
	})
}

func TestPasswordAndDevices(t *testing.T) {
	t.Run("改密吊销其它设备会话，当前设备换发新令牌且不掉线", func(t *testing.T) {
		inst := makeInstance(t, true)
		inst.login(t, map[string]string{"deviceId": "device-A-0001", "deviceName": "笔记本"})
		cookieA := inst.jars["default"]
		inst.login(t, map[string]string{"deviceId": "device-B-0002", "deviceName": "手机"})
		cookieB := inst.jars["default"]
		if cookieA == cookieB {
			t.Fatal("两台设备的 cookie 不应相同")
		}
		inst.jars["default"] = cookieA
		changed := inst.call(t, "POST", "/api/auth/password",
			map[string]any{"currentPassword": testPassword, "newPassword": "BrandNewPass@2026"}, nil)
		if changed.status != 200 {
			t.Fatalf("改密失败: %d %s", changed.status, changed.text)
		}
		if changed.json["revokedSessions"].(float64) < 1 {
			t.Fatal("revokedSessions 应 >= 1")
		}
		cookieA2 := inst.jars["default"]
		if cookieA2 == cookieA {
			t.Fatal("改密后必须换发新令牌")
		}
		stillOk := inst.call(t, "GET", "/api/auth/session", nil, map[string]string{"cookie": cookieA2})
		if stillOk.status != 200 {
			t.Fatalf("当前设备不应掉线: %d", stillOk.status)
		}
		oldToken := inst.call(t, "GET", "/api/auth/session", nil, map[string]string{"cookie": cookieA})
		if oldToken.status != 401 {
			t.Fatal("旧令牌应立即失效")
		}
		bKilled := inst.call(t, "GET", "/api/auth/session", nil, map[string]string{"cookie": cookieB})
		if bKilled.status != 401 {
			t.Fatal("其它设备的会话应被吊销")
		}
		ResetThrottle()
		oldPw := inst.login(t, map[string]string{"password": testPassword, "deviceId": "device-C-0003"})
		if oldPw.status != 401 {
			t.Fatal("旧密码应失效")
		}
		newPw := inst.login(t, map[string]string{"password": "BrandNewPass@2026", "deviceId": "device-C-0003"})
		if newPw.status != 200 {
			t.Fatal("新密码应可登录")
		}
	})

	t.Run("改密时当前密码不对 → 403，且新密码不生效", func(t *testing.T) {
		inst := makeInstance(t, true)
		inst.loginSimple(t)
		res := inst.call(t, "POST", "/api/auth/password",
			map[string]any{"currentPassword": "not-my-password", "newPassword": "WhateverPass@2026"}, nil)
		if res.status != 403 || res.json["code"] != "password_mismatch" {
			t.Fatalf("应 403/password_mismatch: %d %v", res.status, res.json)
		}
		ResetThrottle()
		stillOld := inst.login(t, map[string]string{"deviceId": "device-Z-9999"})
		if stillOld.status != 200 {
			t.Fatal("失败的改密不应影响原密码")
		}
	})

	t.Run("改密时新密码过弱 → 400 并给出逐条原因", func(t *testing.T) {
		inst := makeInstance(t, true)
		inst.loginSimple(t)
		res := inst.call(t, "POST", "/api/auth/password",
			map[string]any{"currentPassword": testPassword, "newPassword": "123456"}, nil)
		if res.status != 400 || res.json["code"] != "weak_password" {
			t.Fatalf("应 400/weak_password: %d %v", res.status, res.json)
		}
		problems, ok := res.json["problems"].([]any)
		if !ok || len(problems) == 0 {
			t.Fatal("problems 应为非空数组")
		}
	})

	t.Run("设备列表与吊销：可以踢掉其它设备，但不能踢自己", func(t *testing.T) {
		inst := makeInstance(t, true)
		inst.login(t, map[string]string{"deviceId": "device-A-0001", "deviceName": "笔记本"})
		cookieA := inst.jars["default"]
		inst.login(t, map[string]string{"deviceId": "device-B-0002", "deviceName": "手机"})
		cookieB := inst.jars["default"]

		inst.jars["default"] = cookieA
		list := inst.call(t, "GET", "/api/devices", nil, nil)
		devices := list.json["devices"].([]any)
		if len(devices) != 2 {
			t.Fatalf("应有 2 台设备: %v", devices)
		}
		var mine map[string]any
		for _, d := range devices {
			if d.(map[string]any)["id"] == "device-A-0001" {
				mine = d.(map[string]any)
			}
		}
		if mine == nil || mine["current"] != true || mine["name"] != "笔记本" {
			t.Fatalf("当前设备标记不符: %v", mine)
		}
		selfKill := inst.call(t, "POST", "/api/devices/revoke", map[string]any{"deviceId": "device-A-0001"}, nil)
		if selfKill.status != 409 {
			t.Fatalf("不应允许通过该接口踢掉自己: %d", selfKill.status)
		}
		kick := inst.call(t, "POST", "/api/devices/revoke", map[string]any{"deviceId": "device-B-0002"}, nil)
		if kick.status != 200 || kick.json["revokedSessions"].(float64) != 1 {
			t.Fatalf("kick 应 200 且吊销 1 个会话: %d %v", kick.status, kick.json)
		}
		bKilled := inst.call(t, "GET", "/api/auth/session", nil, map[string]string{"cookie": cookieB})
		if bKilled.status != 401 {
			t.Fatal("被踢设备应 401")
		}
	})

	t.Run("设备重名自动加序号，列表可辨识", func(t *testing.T) {
		inst := makeInstance(t, true)
		inst.login(t, map[string]string{"deviceId": "device-A-0001", "deviceName": "Chrome"})
		inst.login(t, map[string]string{"deviceId": "device-B-0002", "deviceName": "Chrome"})
		inst.login(t, map[string]string{"deviceId": "device-C-0003", "deviceName": "Chrome"})
		list := inst.call(t, "GET", "/api/devices", nil, nil)
		var names []string
		for _, d := range list.json["devices"].([]any) {
			names = append(names, d.(map[string]any)["name"].(string))
		}
		assertDeepEqual(t, names, []string{"Chrome (3)", "Chrome (2)", "Chrome"}, "设备名")
	})

	t.Run("退出登录后 cookie 被清除且会话失效", func(t *testing.T) {
		inst := makeInstance(t, true)
		inst.loginSimple(t)
		before := inst.jars["default"]
		out := inst.call(t, "POST", "/api/auth/logout", map[string]any{}, nil)
		if out.status != 200 {
			t.Fatalf("logout 应 200: %d", out.status)
		}
		if _, ok := inst.jars["default"]; ok {
			t.Fatal("clearCookie 应清除本地 jar")
		}
		after := inst.call(t, "GET", "/api/auth/session", nil, map[string]string{"cookie": before})
		if after.status != 401 {
			t.Fatalf("旧会话应失效: %d", after.status)
		}
	})
}

func TestAccountAndExport(t *testing.T) {
	t.Run("导出包含全部记录与向量时钟", func(t *testing.T) {
		inst := makeInstance(t, true)
		inst.loginSimple(t)
		inst.call(t, "POST", "/api/sync",
			syncBody("device-A-0001", 0, []map[string]any{
				rec("task-1", map[string]any{"device-A-0001": 1}, map[string]any{"title": "一"}, 1000, nil),
				rec("task-2", map[string]any{"device-A-0001": 2}, map[string]any{"title": "二"}, 2000, nil),
			}), nil)
		res := inst.call(t, "GET", "/api/account/export", nil, nil)
		if res.status != 200 {
			t.Fatalf("export 应 200: %d", res.status)
		}
		var payload map[string]any
		json.Unmarshal([]byte(res.text), &payload)
		if payload["format"] != "twische-export" {
			t.Fatal("format 不符")
		}
		if len(payload["records"].([]any)) != 2 {
			t.Fatalf("records 应 2 条: %v", payload["records"])
		}
		first := payload["records"].([]any)[0].(map[string]any)
		assertDeepEqual(t, first["vc"], map[string]any{"device-A-0001": float64(1)}, "export.vc")
		if !strings.Contains(res.headers.Get("Content-Disposition"), "attachment") {
			t.Fatal("Content-Disposition 应为 attachment")
		}
	})

	t.Run("账户信息不泄漏数据库路径等内部细节", func(t *testing.T) {
		inst := makeInstance(t, true)
		inst.loginSimple(t)
		res := inst.call(t, "GET", "/api/account", nil, nil)
		text := res.text
		if regexp.MustCompile(`(?i)\.db`).MatchString(text) {
			t.Fatal("响应中不应出现数据库路径")
		}
		if regexp.MustCompile(`AppData|Users\\\\`).MatchString(text) {
			t.Fatal("响应中不应出现本机路径")
		}
		acct := res.json["account"].(map[string]any)
		if _, ok := acct["createdAt"].(float64); !ok {
			t.Fatal("account.createdAt应为数字")
		}
	})

	t.Run("审计日志记录了初始化与登录事件", func(t *testing.T) {
		inst := makeInstance(t, true)
		inst.loginSimple(t)
		res := inst.call(t, "GET", "/api/account/audit", nil, nil)
		events := res.json["events"].([]any)
		found := false
		for _, e := range events {
			if e.(map[string]any)["event"] == "login.success" {
				found = true
			}
		}
		if !found {
			t.Fatal("审计日志应包含 login.success")
		}
	})
}

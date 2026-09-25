// 安全回归测试：把渗透测试中发现并修好的每一条都钉死在这里。
//
// 每条用例都对应一次真实的攻击尝试，"修复前会变成什么样"写在各自的注释里。
// 全部只读写 t.TempDir() 独立库，不触碰 data/。
package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// ═══════════════════════════════════════════════════════════
// 向量时钟：设备键必须是已登记设备
// 修复前：{"GHOST-DEVICE-NEVER-EXISTED": 7} 被接受，凭空造出 device_clocks 行，
// 幽灵设备污染全局版本向量
// ═══════════════════════════════════════════════════════════

func TestSec_UnknownVcDeviceRejected(t *testing.T) {
	inst := makeInstance(t, true)
	if r := inst.loginSimple(t); r.status != 200 {
		t.Fatalf("登录失败: %d %s", r.status, r.text)
	}

	res := inst.call(t, "POST", "/api/sync",
		syncBody("device-A-0001", 0, []map[string]any{
			rec("rec-inject-1",
				map[string]any{"device-A-0001": 1, "GHOST-DEVICE-NEVER-EXISTED": 7},
				map[string]any{"title": "hello"}, 1_700_000_000_000, nil),
		}), nil)
	if res.status != 400 {
		t.Fatalf("引用未登记设备必须 400，实际 %d %s", res.status, res.text)
	}
	if !strings.Contains(res.text, "未登记的设备") {
		t.Fatalf("错误提示应指出未登记设备: %s", res.text)
	}

	// 幽灵设备不得在库里留下任何痕迹
	var clocks int
	inst.db.QueryRow("SELECT COUNT(*) FROM device_clocks WHERE device_id = ?",
		"GHOST-DEVICE-NEVER-EXISTED").Scan(&clocks)
	if clocks != 0 {
		t.Fatalf("幽灵设备的时钟行不该存在: %d", clocks)
	}
	var records int
	inst.db.QueryRow("SELECT COUNT(*) FROM records").Scan(&records)
	if records != 0 {
		t.Fatalf("整批推送应被事务回滚，records 应为 0: %d", records)
	}

	// 正常记录仍然可以写入
	ok := inst.call(t, "POST", "/api/sync",
		syncBody("device-A-0001", 0, []map[string]any{
			rec("rec-ok", map[string]any{"device-A-0001": 1}, map[string]any{"title": "ok"}, 1_700_000_000_000, nil),
		}), nil)
	if ok.status != 200 {
		t.Fatalf("合法推送不应受影响: %d %s", ok.status, ok.text)
	}
}

// ═══════════════════════════════════════════════════════════
// 向量时钟：分量上界 + 拒绝科学计数法
// 修复前：1e19 落库，客户端 vcGet()+1 因浮点舍入不再增长，该记录被永久冻结；
// 1e300 更会被未定义的 float64→uint64 转换塌缩成 2^63，两个不同输入映射成同一值
// ═══════════════════════════════════════════════════════════

func TestSec_OversizedVcComponentRejected(t *testing.T) {
	inst := makeInstance(t, true)
	if r := inst.loginSimple(t); r.status != 200 {
		t.Fatalf("登录失败: %d %s", r.status, r.text)
	}

	// 1e19、1e300、超出 uint64、以及超过协议上界的普通整数
	for _, probe := range []string{"1e19", "1e300", "99999999999999999999", "1099511627777"} {
		body := pushRaw("device-A-0001",
			`{"id":"rec-poison","kind":"task","data":{"title":"p"},`+
				`"vc":{"device-A-0001":`+probe+`},"updatedAt":1700000000000,"deleted":false}`)
		res := inst.call(t, "POST", "/api/sync", body, nil)
		if res.status != 400 {
			t.Errorf("分量 %s 应被拒绝，实际 %d %s", probe, res.status, firstLine(res.text))
		} else {
			t.Logf("分量 %-22s → 400 %s", probe, firstLine(res.text))
		}
	}

	// 上界本身必须可用（边界不能写成 >=）
	limit := fmt.Sprintf("%d", Sync.MaxVcCounter)
	body := pushRaw("device-A-0001",
		`{"id":"rec-limit","kind":"task","data":{"title":"p"},`+
			`"vc":{"device-A-0001":`+limit+`},"updatedAt":1700000000000,"deleted":false}`)
	if res := inst.call(t, "POST", "/api/sync", body, nil); res.status != 200 {
		t.Errorf("恰好等于上界应被接受（边界条件）: %d %s", res.status, res.text)
	}

	// 字符串形式的数字：拒绝，避免不同 JSON 实现的宽松转换差异
	body = pushRaw("device-A-0001",
		`{"id":"rec-str","kind":"task","data":{"title":"p"},`+
			`"vc":{"device-A-0001":"5"},"updatedAt":1700000000000,"deleted":false}`)
	if res := inst.call(t, "POST", "/api/sync", body, nil); res.status != 400 {
		t.Errorf("字符串数字应被拒绝: %d %s", res.status, res.text)
	}

	// 小数：拒绝（时钟分量必须是整数）
	body = pushRaw("device-A-0001",
		`{"id":"rec-frac","kind":"task","data":{"title":"p"},`+
			`"vc":{"device-A-0001":1.5},"updatedAt":1700000000000,"deleted":false}`)
	if res := inst.call(t, "POST", "/api/sync", body, nil); res.status != 400 {
		t.Errorf("小数分量应被拒绝: %d %s", res.status, res.text)
	}

	// 全局向量里不该出现任何天文数字
	v := inst.call(t, "GET", "/api/sync/vector", nil, nil)
	for dev, counter := range v.json["serverVector"].(map[string]any) {
		if f, ok := counter.(float64); ok && f > float64(Sync.MaxVcCounter) {
			t.Errorf("全局向量出现超界分量 %s=%v", dev, f)
		}
	}
}

// 上界必须显著低于 IEEE-754 的整数精度上限，否则客户端 +1 依然会失效。
func TestSec_MaxVcCounterBelowFloatPrecisionLimit(t *testing.T) {
	const jsMaxSafeInteger = 1<<53 - 1
	if Sync.MaxVcCounter > jsMaxSafeInteger {
		t.Fatalf("MaxVcCounter(%d) 必须 <= 2^53-1(%d)，否则客户端 vcGet()+1 会因舍入停止增长",
			Sync.MaxVcCounter, jsMaxSafeInteger)
	}
	t.Logf("MaxVcCounter=%d，JS 安全整数上限=%d，客户端 +1 在两端都精确可表示",
		Sync.MaxVcCounter, jsMaxSafeInteger)
}

// ═══════════════════════════════════════════════════════════
// 记录冻结：被投毒的记录必须仍可被正常更新
// 修复前：攻击者写入超大分量后，受害者以本地时钟提交的修改被判 unchanged 丢弃，
// 界面显示"已同步"而数据丢失
// ═══════════════════════════════════════════════════════════

func TestSec_RecordNotFreezableByVcPoison(t *testing.T) {
	// 先以发起设备（device-A-0001）登录，再登记受害者设备
	inst := makeInstance(t, true)
	if r := inst.loginSimple(t); r.status != 200 {
		t.Fatalf("登录失败: %d %s", r.status, r.text)
	}
	inst.registerDevice(t, "device-VICTIM-01", "受害设备")

	// 攻击者尝试投毒 —— 必须被拒
	poison := inst.call(t, "POST", "/api/sync",
		pushRaw("device-A-0001",
			`{"id":"rec-shared","kind":"task","data":{"title":"攻击者版本"},`+
				`"vc":{"device-A-0001":1,"device-VICTIM-01":1e19},"updatedAt":1700000000000,"deleted":false}`),
		nil)
	if poison.status != 400 {
		t.Fatalf("投毒必须被拒: %d %s", poison.status, poison.text)
	}

	// 受害者写入自己的版本
	inst.jars["default"] = cookieFor(t, inst, "device-VICTIM-01")
	first := inst.call(t, "POST", "/api/sync",
		syncBody("device-VICTIM-01", 0, []map[string]any{
			rec("rec-shared", map[string]any{"device-VICTIM-01": 5},
				map[string]any{"title": "受害者版本"}, 1_700_000_100_000, nil),
		}), nil)
	if first.status != 200 {
		t.Fatalf("受害者首次写入失败: %d %s", first.status, first.text)
	}

	// 受害者再改一次（计数器 +1）—— 必须被接受，不能被静默丢弃
	second := inst.call(t, "POST", "/api/sync",
		syncBody("device-VICTIM-01", 0, []map[string]any{
			rec("rec-shared", map[string]any{"device-VICTIM-01": 6},
				map[string]any{"title": "受害者改过了"}, 1_700_000_200_000, nil),
		}), nil)
	var applied []map[string]any
	b, _ := json.Marshal(second.json["applied"])
	json.Unmarshal(b, &applied)
	if len(applied) == 0 || applied[0]["status"] != "updated" {
		t.Fatalf("受害者的修改必须被接受，实际: %v", applied)
	}

	var data string
	inst.db.QueryRow("SELECT data FROM records WHERE id = ?", "rec-shared").Scan(&data)
	if !strings.Contains(data, "受害者改过了") {
		t.Fatalf("库内应为受害者最新版本，实际 %s", data)
	}
}

// ═══════════════════════════════════════════════════════════
// 时钟相等但内容不同：必须纠正，不能回 unchanged
// 修复前：服务端回 unchanged（内容不校验），客户端据此清掉脏标记 → 静默丢数据
// ═══════════════════════════════════════════════════════════

func TestSec_DivergedContentIsCorrected(t *testing.T) {
	inst := makeInstance(t, true)
	if r := inst.loginSimple(t); r.status != 200 {
		t.Fatalf("登录失败")
	}

	inst.call(t, "POST", "/api/sync",
		syncBody("device-A-0001", 0, []map[string]any{
			rec("task-1", map[string]any{"device-A-0001": 1}, map[string]any{"title": "权威版本"}, 1000, nil),
		}), nil)

	// 同一个时钟、同一 updatedAt，但内容不同 —— 客户端状态已经跑偏
	diverged := inst.call(t, "POST", "/api/sync",
		syncBody("device-A-0001", 0, []map[string]any{
			rec("task-1", map[string]any{"device-A-0001": 1}, map[string]any{"title": "客户端跑偏的版本"}, 1000, nil),
		}), nil)

	var applied []map[string]any
	b, _ := json.Marshal(diverged.json["applied"])
	json.Unmarshal(b, &applied)
	if len(applied) == 0 || applied[0]["status"] != "diverged" {
		t.Fatalf("时钟相等但内容不同应判 diverged，实际: %v", applied)
	}
	if applied[0]["serverVc"] == nil {
		t.Fatal("diverged 必须带上服务端时钟")
	}

	// 必须回发权威版本，让客户端能自我修复
	var corrected map[string]any
	for _, c := range diverged.json["corrections"].([]any) {
		if c.(map[string]any)["id"] == "task-1" {
			corrected = c.(map[string]any)
		}
	}
	if corrected == nil {
		t.Fatal("diverged 必须回发纠正数据，否则客户端永远停在错误版本")
	}
	if corrected["data"].(map[string]any)["title"] != "权威版本" {
		t.Fatalf("纠正数据应为服务端版本: %v", corrected)
	}

	// 真正的内容一致重放仍然要回 unchanged（幂等语义不能被破坏）
	same := inst.call(t, "POST", "/api/sync",
		syncBody("device-A-0001", 0, []map[string]any{
			rec("task-1", map[string]any{"device-A-0001": 1}, map[string]any{"title": "权威版本"}, 1000, nil),
		}), nil)
	b, _ = json.Marshal(same.json["applied"])
	applied = nil
	json.Unmarshal(b, &applied)
	if len(applied) == 0 || applied[0]["status"] != "unchanged" {
		t.Fatalf("完全一致的重放必须仍是 unchanged: %v", applied)
	}
}

// ═══════════════════════════════════════════════════════════
// 记录 id：字符白名单
// 修复前：'; DROP TABLE records;--、../../etc/passwd、含 NUL/ANSI 的 id 全部落库
// ═══════════════════════════════════════════════════════════

func TestSec_RecordIDCharsetEnforced(t *testing.T) {
	inst := makeInstance(t, true)
	if r := inst.loginSimple(t); r.status != 200 {
		t.Fatalf("登录失败")
	}

	bad := []string{
		`'; DROP TABLE records;--`,
		"rec\x00\x07\x1b[31mred",
		"../../etc/passwd",
		"rec with space",
		"rec/slash",
		"rec\\backslash",
		"设备",
	}
	for _, id := range bad {
		spec := fmt.Sprintf(
			`{"id":%s,"kind":"task","data":{"title":"x"},"vc":{"device-A-0001":1},`+
				`"updatedAt":1700000000000,"deleted":false}`, string(mustRawJSON(id)))
		res := inst.call(t, "POST", "/api/sync", pushRaw("device-A-0001", spec), nil)
		if res.status != 400 {
			t.Errorf("非法 id %q 应被拒绝，实际 %d %s", id, res.status, firstLine(res.text))
		}
	}

	var n int
	inst.db.QueryRow("SELECT COUNT(*) FROM records").Scan(&n)
	if n != 0 {
		t.Fatalf("非法 id 不应落库: %d", n)
	}
	var tables int
	inst.db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='records'").Scan(&tables)
	if tables != 1 {
		t.Fatal("records 表消失了 —— 疑似 SQL 注入")
	}

	// 客户端真实使用的 id 形状必须仍然通过：uuid v4 与 `kind-时间戳-随机`
	for _, id := range []string{
		"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
		"task-1789266602859-a1b2c3",
		"rec_underscore",
	} {
		spec := fmt.Sprintf(
			`{"id":%s,"kind":"task","data":{"title":"x"},"vc":{"device-A-0001":1},`+
				`"updatedAt":1700000000000,"deleted":false}`, string(mustRawJSON(id)))
		res := inst.call(t, "POST", "/api/sync", pushRaw("device-A-0001", spec), nil)
		if res.status != 200 {
			t.Errorf("正常 id %q 不应被拒: %d %s", id, res.status, firstLine(res.text))
		}
	}
}

// ═══════════════════════════════════════════════════════════
// 记录 id：两段式 completion 主键
//
// 修复前：完成打卡用 `taskId|实例键` 作确定性 id（多端勾选同一天必须算出同一条
// 记录），但 id 白名单只有单段分支，竖线一律被拒。后果是这些记录在客户端正常
// 落库、界面照常显示"已打卡"，只有同步静默失败 —— 最后一位服务端确认过的打卡
// 永远推不上去，且用户毫无察觉。
// ═══════════════════════════════════════════════════════════

func TestSec_CompositeCompletionIDAccepted(t *testing.T) {
	inst := makeInstance(t, true)
	if r := inst.loginSimple(t); r.status != 200 {
		t.Fatalf("登录失败")
	}

	taskID := "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b"

	// 客户端会产生两类后缀：固定任务按归属日（YYYY-MM-DD），
	// 截止任务按精确到分钟的本地时刻（YYYY-MM-DDTHH:mm）。
	for _, suffix := range []string{
		"2026-09-16",
		"2026-09-20T18:30",
		"2026-09-20T00:00",
	} {
		recID := taskID + "|" + suffix
		spec := fmt.Sprintf(
			`{"id":%s,"kind":"completion","data":{"taskId":%s,"occurrence":%s,"doneAt":1},`+
				`"vc":{"device-A-0001":1},"updatedAt":1700000000000,"deleted":false}`,
			string(mustRawJSON(recID)), string(mustRawJSON(taskID)), string(mustRawJSON(suffix)))
		res := inst.call(t, "POST", "/api/sync", pushRaw("device-A-0001", spec), nil)
		if res.status != 200 {
			t.Fatalf("两段式 id %q 应被接受，实际 %d %s", recID, res.status, firstLine(res.text))
		}
		if !strings.Contains(res.text, `"created"`) {
			t.Fatalf("两段式 id %q 应落库为 created，实际 %s", recID, firstLine(res.text))
		}
	}

	// 确认真的进了库（而不是被"接受"却默默丢弃）
	var n int
	inst.db.QueryRow(
		"SELECT COUNT(*) FROM records WHERE kind = 'completion' AND id LIKE '%|%'").Scan(&n)
	if n != 3 {
		t.Fatalf("两段式 completion 记录应落库 3 条，实际 %d", n)
	}

	// 幂等：同一条重复推送必须判为 unchanged，否则多端同步会产生乒乓
	recID := taskID + "|2026-09-16"
	dup := fmt.Sprintf(
		`{"id":%s,"kind":"completion","data":{"taskId":%s,"occurrence":"2026-09-16","doneAt":1},`+
			`"vc":{"device-A-0001":1},"updatedAt":1700000000000,"deleted":false}`,
		string(mustRawJSON(recID)), string(mustRawJSON(taskID)))
	res := inst.call(t, "POST", "/api/sync", pushRaw("device-A-0001", dup), nil)
	if res.status != 200 || !strings.Contains(res.text, `"unchanged"`) {
		t.Fatalf("重复推送应判为 unchanged，实际 %d %s", res.status, firstLine(res.text))
	}
}

// 放宽不得成为开后门：两段式的每一段都必须落在收紧的字符集里。
// 用例必须断言**拒绝理由来自 id 白名单本身** —— 否则别的字段先报错时，
// 就算 id 被放行也看不出来，这条测试就成了摆设。
func TestSec_CompositeIDStillRejectsPayloads(t *testing.T) {
	inst := makeInstance(t, true)
	if r := inst.loginSimple(t); r.status != 200 {
		t.Fatalf("登录失败")
	}

	bad := []string{
		`'; DROP TABLE records;--|2026-09-16`,
		"task\x00\x07\x1b[31mred|2026-09-16",
		"../../etc/passwd|2026-09-16",
		"../x|2026-09-16",
		"task|../../etc/passwd",
		"task with space|2026-09-16",
		"task|x/y",
		"task|x\\y",
		"a|b|c",                                  // 两段以上
		"|2026-09-16",                            // 前缀为空
		"task|",                                  // 后缀为空
		"|",                                      // 两侧皆空
		"task|2026-09-16|",                       // 尾随竖线
		strings.Repeat("x", 129) + "|2026-09-16", // 前缀超长
		"task|" + strings.Repeat("y", 65),        // 后缀超长
	}

	for _, id := range bad {
		spec := fmt.Sprintf(
			`{"id":%s,"kind":"task","data":{"title":"x"},"vc":{"device-A-0001":1},`+
				`"updatedAt":1700000000000,"deleted":false}`, string(mustRawJSON(id)))
		res := inst.call(t, "POST", "/api/sync", pushRaw("device-A-0001", spec), nil)
		if res.status != 400 {
			t.Errorf("非法 id %q 应被拒绝，实际 %d %s", id, res.status, firstLine(res.text))
			continue
		}
		// 必须是被 id 白名单拦下的，不是碰巧被别的字段拦下
		if !strings.Contains(res.text, "记录 id") {
			t.Errorf("非法 id %q 的拒绝理由应指向 id 白名单，实际 %s", id, firstLine(res.text))
		}
	}

	var n int
	inst.db.QueryRow("SELECT COUNT(*) FROM records").Scan(&n)
	if n != 0 {
		t.Fatalf("非法 id 不应落库: %d", n)
	}
	var tables int
	inst.db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='records'").Scan(&tables)
	if tables != 1 {
		t.Fatal("records 表消失了 —— 疑似 SQL 注入")
	}
}

// ═══════════════════════════════════════════════════════════
// 设备管理提权
// 修复前：任何登录设备可改名/吊销/删除其它设备，无需任何额外凭证
// ═══════════════════════════════════════════════════════════

func TestSec_DeviceManagementRequiresElevation(t *testing.T) {
	inst := makeInstance(t, true)

	// A 登录（登录即提权）
	if r := inst.login(t, map[string]string{"deviceId": "device-A-0001", "deviceName": "A"}); r.status != 200 {
		t.Fatalf("A 登录失败")
	}
	cookieA := inst.jars["default"]
	// B 登录，随后取回 B 的 cookie 备用
	if r := inst.login(t, map[string]string{"deviceId": "device-B-0002", "deviceName": "B 的手机"}); r.status != 200 {
		t.Fatalf("B 登录失败")
	}
	cookieB := inst.jars["default"]

	// 登录后 15 分钟内：管理其它设备应直接成功（不能把常用流程变难用）
	inst.jars["default"] = cookieA
	res := inst.call(t, "POST", "/api/devices/rename",
		map[string]any{"deviceId": "device-B-0002", "name": "A 改的名字"},
		map[string]string{"cookie": cookieA})
	if res.status != 200 {
		t.Fatalf("登录后短时间内应允许管理其它设备: %d %s", res.status, firstLine(res.text))
	}

	// 改自己的名字不受提权限制
	res = inst.call(t, "POST", "/api/devices/rename",
		map[string]any{"deviceId": "device-A-0001", "name": "A 自己"},
		map[string]string{"cookie": cookieA})
	if res.status != 200 {
		t.Fatalf("改自己名字不该要求提权: %d %s", res.status, firstLine(res.text))
	}

	// 提权过期后：必须要求密码
	inst.db.Exec("UPDATE sessions SET elevated_until = 0 WHERE device_id = ?", "device-A-0001")
	for _, spec := range []struct {
		path string
		body map[string]any
	}{
		{"/api/devices/rename", map[string]any{"deviceId": "device-B-0002", "name": "偷改的名字"}},
		{"/api/devices/revoke", map[string]any{"deviceId": "device-B-0002"}},
		{"/api/devices/forget", map[string]any{"deviceId": "device-B-0002"}},
	} {
		res := inst.call(t, "POST", spec.path, spec.body, map[string]string{"cookie": cookieA})
		if res.status != 403 || res.json["code"] != "password_required" {
			t.Errorf("%s 提权过期后应 403/password_required，实际 %d %s",
				spec.path, res.status, firstLine(res.text))
		}
	}

	// 提权过期后 B 的会话必须仍然有效（上面的操作都不该生效）
	sessB := inst.call(t, "GET", "/api/auth/session", nil, map[string]string{"cookie": cookieB})
	if sessB.status != 200 {
		t.Fatalf("未提权的操作不该真的吊销 B: %d", sessB.status)
	}
	var name string
	inst.db.QueryRow("SELECT name FROM devices WHERE id = ?", "device-B-0002").Scan(&name)
	if name != "A 改的名字" {
		t.Fatalf("未提权的改名不该生效: %q", name)
	}

	// 密码错误 → 403 password_mismatch，且不提权
	res = inst.call(t, "POST", "/api/devices/revoke",
		map[string]any{"deviceId": "device-B-0002", "password": "wrong-password"},
		map[string]string{"cookie": cookieA})
	if res.status != 403 || res.json["code"] != "password_mismatch" {
		t.Fatalf("密码错误应 403/password_mismatch: %d %s", res.status, firstLine(res.text))
	}

	// 带正确密码 → 换取提权并完成操作
	res = inst.call(t, "POST", "/api/devices/revoke",
		map[string]any{"deviceId": "device-B-0002", "password": testPassword},
		map[string]string{"cookie": cookieA})
	if res.status != 200 {
		t.Fatalf("正确密码应换取提权: %d %s", res.status, firstLine(res.text))
	}
	if res.json["revokedSessions"].(float64) != 1 {
		t.Fatalf("应吊销 1 个会话: %v", res.json)
	}
	sessB = inst.call(t, "GET", "/api/auth/session", nil, map[string]string{"cookie": cookieB})
	if sessB.status != 401 {
		t.Fatalf("B 应被吊销: %d", sessB.status)
	}

	// 提权在有效期内复用，不必每次带密码
	inst.db.Exec("UPDATE sessions SET elevated_until = 0 WHERE device_id = ?", "device-A-0001")
	res = inst.call(t, "POST", "/api/devices/revoke",
		map[string]any{"deviceId": "device-B-0002", "password": testPassword},
		map[string]string{"cookie": cookieA})
	if res.status != 200 {
		t.Fatalf("首次提权应成功: %d", res.status)
	}
	res = inst.call(t, "POST", "/api/devices/forget",
		map[string]any{"deviceId": "device-B-0002"}, map[string]string{"cookie": cookieA})
	if res.status != 200 {
		t.Fatalf("提权有效期内后续操作应免密: %d %s", res.status, firstLine(res.text))
	}
}

// ═══════════════════════════════════════════════════════════
// 限流身份：X-Forwarded-For 只取最右一跳
// 修复前：取最左一份（客户端可自填），每次伪造新 IP 即让 IP 级限流完全失效
// ═══════════════════════════════════════════════════════════

func TestSec_XffUsesRightmostHop(t *testing.T) {
	inst := makeInstance(t, true)
	ResetThrottle()
	defer ResetThrottle()
	Server.TrustProxy = true
	defer func() { Server.TrustProxy = false }()

	// 客户端伪造最左一段，代理在右侧追加真实来源。身份必须取最右。
	if got := clientIpFromHeader("1.2.3.4, 10.9.9.9"); got != "10.9.9.9" {
		t.Fatalf("应取最右一跳 10.9.9.9，实际 %q", got)
	}
	if got := clientIpFromHeader("10.9.9.9"); got != "10.9.9.9" {
		t.Fatalf("单段时应取该段，实际 %q", got)
	}
	if got := clientIpFromHeader("  1.2.3.4 ,  10.9.9.9  "); got != "10.9.9.9" {
		t.Fatalf("应忽略空白，实际 %q", got)
	}

	// 单段伪造：节流把同一个身份累计起来，账户锁定必然触发
	got429 := 0
	for i := 0; i < 8; i++ {
		res := inst.call(t, "POST", "/api/auth/login",
			map[string]any{"password": "wrong-" + fmt.Sprint(i), "deviceId": "device-A-0001"},
			map[string]string{"x-forwarded-for": "10.7.7.7"})
		if res.status == 429 {
			got429++
		}
	}
	if got429 == 0 {
		t.Fatal("同一身份连续失败必须触发锁定")
	}
	t.Logf("同一伪造身份 8 次失败 → 429×%d（身份被正确累计）", got429)
}

// ═══════════════════════════════════════════════════════════
// 请求体处理：非 JSON 的带体请求明确拒绝
// 修复前：静默忽略请求体，4 MB 表单体在 keep-alive 连接上反复占用内存
// ═══════════════════════════════════════════════════════════

func TestSec_NonJSONBodyRejected(t *testing.T) {
	inst := makeInstance(t, true)
	if r := inst.loginSimple(t); r.status != 200 {
		t.Fatalf("登录失败")
	}

	req, _ := http.NewRequest("POST", inst.base+"/api/sync", strings.NewReader("a=1&b=2"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("x-twische-client", "web")
	req.Header.Set("Cookie", inst.jars["default"])
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("带体的非 JSON 请求应 400，实际 %d", res.StatusCode)
	}

	// 无体的 POST（客户端确实会这么发 logout）不受影响
	out := inst.call(t, "POST", "/api/auth/logout", nil, nil)
	if out.status != 200 {
		t.Fatalf("无体 POST 不应被误伤: %d %s", out.status, firstLine(out.text))
	}
}

// ═══════════════════════════════════════════════════════════
// 数值健壮性：越界浮点绝不进入整数域
// ═══════════════════════════════════════════════════════════

func TestSec_FloatConversionStaysInRange(t *testing.T) {
	// vcNormalizeRaw 必须把越界值剔除而不是交给未定义的转换
	for _, probe := range []float64{1e19, 1e300, math.MaxFloat64, math.Inf(1), math.NaN(), -1, 0} {
		vc := vcNormalizeRaw(map[string]any{"dev": probe})
		if len(vc) != 0 {
			t.Errorf("越界值 %v 应被剔除，实际 %v", probe, vc)
		}
	}
	// 合法值保留
	vc := vcNormalizeRaw(map[string]any{"dev": float64(Sync.MaxVcCounter)})
	if vc["dev"] != Sync.MaxVcCounter {
		t.Fatalf("上界本身应保留: %v", vc)
	}
	vc2 := vcNormalizeRaw(map[string]any{"d2": json.Number("7")})
	if vc2["d2"] != 7 {
		t.Fatalf("普通分量应保留: %v", vc2)
	}
	// 超过上界立刻剔除，绝不进入整数域
	if got := vcNormalizeRaw(map[string]any{"d": float64(Sync.MaxVcCounter) + 1})["d"]; got != 0 {
		t.Fatalf("上界+1 应被剔除: %v", got)
	}
	// 1e300 与 2^63 这类输入不得塌缩成同一个值（修复前两者都会变成 9223372036854775808）
	if got := vcNormalizeRaw(map[string]any{"d": 1e300})["d"]; got != 0 {
		t.Errorf("1e300 不该被接受: %v", got)
	}
}

// 开库消毒：历史库里的超界分量必须被夹到上界，让记录重新可写
func TestSec_LegacyClockSanitizedOnOpen(t *testing.T) {
	dir := t.TempDir()
	dbPath := dir + "/legacy.db"
	db, err := openDatabase(dbPath)
	if err != nil {
		t.Fatalf("开库失败: %v", err)
	}
	defer db.Close()

	// 直接写入一条"修复前才可能出现"的污染记录
	if _, err := db.Exec(
		`INSERT INTO records (seq, id, kind, data, vc, updated_at, deleted, byte_size, created_at)
		 VALUES (1, 'legacy-1', 'task', '{"title":"x"}', '{"dev":10000000000000000000}', 1700000000000, 0, 13, 1700000000000)`,
	); err != nil {
		t.Fatalf("写入历史脏数据失败: %v", err)
	}
	db.Exec("INSERT INTO device_clocks (device_id, counter, updated_at) VALUES ('dev', 10000000000000000000, 1700000000000)")
	db.Close()

	// 重新打开：消毒应把分量夹到上界
	db2, err := openDatabase(dbPath)
	if err != nil {
		t.Fatalf("再次开库失败: %v", err)
	}
	defer db2.Close()

	var vcRaw string
	db2.QueryRow("SELECT vc FROM records WHERE id = 'legacy-1'").Scan(&vcRaw)
	var m map[string]any
	if err := json.Unmarshal([]byte(vcRaw), &m); err != nil {
		t.Fatalf("vc 不是合法 JSON: %s", vcRaw)
	}
	got, _ := m["dev"].(float64)
	if got > float64(Sync.MaxVcCounter) {
		t.Fatalf("历史超界分量应被夹到上界 %d，实际 %v", Sync.MaxVcCounter, got)
	}
	var counter int64
	db2.QueryRow("SELECT counter FROM device_clocks WHERE device_id = 'dev'").Scan(&counter)
	if counter > int64(Sync.MaxVcCounter) {
		t.Fatalf("device_clocks 也应被夹到上界，实际 %d", counter)
	}
	t.Logf("消毒后 vc.dev=%v device_clocks.counter=%d（上界 %d）", got, counter, Sync.MaxVcCounter)
}

// ═══════════════════════════════════════════════════════════
// 设备移除：device_clocks 必须保留为向量时钟历史注册表
// 修复前：forget 同时删除 devices 与 device_clocks，引用过该设备的记录
// 之后会被 validateIncoming 判为“未登记设备”，永远无法再推送。
// ═══════════════════════════════════════════════════════════
func TestSec_DeviceForgetKeepsVcHistory(t *testing.T) {
	inst := makeInstance(t, true)
	if r := inst.login(t, map[string]string{"deviceId": "device-A-0001", "deviceName": "A"}); r.status != 200 {
		t.Fatalf("A 登录失败")
	}
	cookieA := inst.jars["default"]
	cookieB := cookieFor(t, inst, "device-B-0002")

	// B 先以自己的身份写一条记录，device_clocks 留下 B 的历史分量。
	inst.jars["default"] = cookieB
	created := inst.call(t, "POST", "/api/sync",
		syncBody("device-B-0002", 0, []map[string]any{
			rec("forget-keeps-writable", map[string]any{"device-B-0002": 1},
				map[string]any{"title": "B 的版本"}, 1_700_000_000_000, nil),
		}), nil)
	if created.status != 200 {
		t.Fatalf("B 创建记录失败: %d %s", created.status, created.text)
	}

	// A 移除 B：只应删除当前设备行，不能删除历史时钟。
	inst.jars["default"] = cookieA
	forgot := inst.call(t, "POST", "/api/devices/forget",
		map[string]any{"deviceId": "device-B-0002", "password": testPassword}, nil)
	if forgot.status != 200 {
		t.Fatalf("移除 B 失败: %d %s", forgot.status, forgot.text)
	}
	list := inst.call(t, "GET", "/api/devices", nil, nil)
	for _, d := range list.json["devices"].([]any) {
		if d.(map[string]any)["id"] == "device-B-0002" {
			t.Fatal("被移除的设备不应继续出现在设备列表里")
		}
	}

	// A 更新时仍带着 B 的分量：必须通过，而不是被判未登记设备。
	updated := inst.call(t, "POST", "/api/sync",
		syncBody("device-A-0001", 0, []map[string]any{
			rec("forget-keeps-writable", map[string]any{"device-B-0002": 1, "device-A-0001": 1},
				map[string]any{"title": "A 更新后的版本"}, 1_700_000_100_000, nil),
		}), nil)
	if updated.status != 200 {
		t.Fatalf("移除设备后原记录应仍可推送: %d %s", updated.status, updated.text)
	}
	if updated.json["applied"].([]any)[0].(map[string]any)["status"] != "updated" {
		t.Fatalf("记录应被接受为 updated: %v", updated.json["applied"])
	}
	var clocks int
	inst.db.QueryRow("SELECT COUNT(*) FROM device_clocks WHERE device_id = ?", "device-B-0002").Scan(&clocks)
	if clocks != 1 {
		t.Fatalf("device_clocks 历史注册项应保留，实际 %d", clocks)
	}
}

// ═══════════════════════════════════════════════════════════
// 向量时钟：不能替其它设备推进分量
// 修复前：A 可推送 {B: MAX}，把 B 的时钟顶到上界；B 之后每次编辑
// vcIncrement 都被夹在 MAX，VC 不再变化，修改被服务端判为 diverged 后丢弃。
// ═══════════════════════════════════════════════════════════
func TestSec_OtherDeviceClockCannotBeForged(t *testing.T) {
	inst := makeInstance(t, true)
	if r := inst.login(t, map[string]string{"deviceId": "device-A-0001", "deviceName": "A"}); r.status != 200 {
		t.Fatalf("A 登录失败")
	}
	cookieA := inst.jars["default"]
	cookieB := cookieFor(t, inst, "device-B-0002")

	// A 还没有见过 B 的任何时钟分量，不能替 B 创建 B:1。
	forged := inst.call(t, "POST", "/api/sync",
		syncBody("device-A-0001", 0, []map[string]any{
			rec("clock-forge", map[string]any{"device-B-0002": 1},
				map[string]any{"title": "伪造版本"}, 1_700_000_000_000, nil),
		}), nil)
	if forged.status != 400 {
		t.Fatalf("替其它设备推进时钟必须被拒绝: %d %s", forged.status, forged.text)
	}

	// B 自己可以写 B:1，服务端时钟随之变为 1。
	inst.jars["default"] = cookieB
	created := inst.call(t, "POST", "/api/sync",
		syncBody("device-B-0002", 0, []map[string]any{
			rec("clock-forge", map[string]any{"device-B-0002": 1},
				map[string]any{"title": "B 的合法版本"}, 1_700_000_100_000, nil),
		}), nil)
	if created.status != 200 || created.json["applied"].([]any)[0].(map[string]any)["status"] != "created" {
		t.Fatalf("B 自己的首次推送应成功: %d %s", created.status, created.text)
	}

	// A 仍然不能把 B 推到 2。
	inst.jars["default"] = cookieA
	forgedAgain := inst.call(t, "POST", "/api/sync",
		syncBody("device-A-0001", 0, []map[string]any{
			rec("clock-forge", map[string]any{"device-B-0002": 2},
				map[string]any{"title": "再次伪造"}, 1_700_000_200_000, nil),
		}), nil)
	if forgedAgain.status != 400 {
		t.Fatalf("超过服务端已知值的分量必须被拒绝: %d %s", forgedAgain.status, forgedAgain.text)
	}

	// B 自己更新到 2，证明正常设备不受影响。
	inst.jars["default"] = cookieB
	updated := inst.call(t, "POST", "/api/sync",
		syncBody("device-B-0002", 0, []map[string]any{
			rec("clock-forge", map[string]any{"device-B-0002": 2},
				map[string]any{"title": "B 更新后的版本"}, 1_700_000_300_000, nil),
		}), nil)
	if updated.status != 200 || updated.json["applied"].([]any)[0].(map[string]any)["status"] != "updated" {
		t.Fatalf("B 自己的后续更新应成功: %d %s", updated.status, updated.text)
	}
	inst.jars["default"] = cookieA
}

// ═══════════════════════════════════════════════════════════
// 登录限流：并发失败不能绕过 IP 预占与账户锁定原子自增
// 修复前：40 个并发错误请求全部跑 bcrypt，failed_attempts 因丢失更新只 +1。
// ═══════════════════════════════════════════════════════════
func TestSec_LoginConcurrentAtomicThrottle(t *testing.T) {
	inst := makeInstance(t, true)
	ResetThrottle()
	defer ResetThrottle()
	const ip = "203.0.113.77"
	const attempts = 40
	errs := make(chan *AppError, attempts)
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _, _, apiErr := login(inst.db, fmt.Sprintf("wrong-concurrent-%d", i),
				"race-device-0001", "", "test-agent", ip)
			errs <- apiErr
		}(i)
	}
	wg.Wait()
	close(errs)
	throttled, locked := 0, 0
	for apiErr := range errs {
		if apiErr == nil {
			t.Fatal("错误密码不应登录成功")
		}
		switch apiErr.Code {
		case "too_many_requests":
			throttled++
		case "locked":
			locked++
		case "bad_credentials":
		default:
			t.Fatalf("意外错误: %v", apiErr)
		}
	}
	if throttled != attempts-ipMaxAttempts {
		t.Fatalf("并发预占应只放行 %d 次，实际 throttled=%d", ipMaxAttempts, throttled)
	}
	if locked == 0 {
		t.Fatal("并发失败必须触发账户锁定")
	}
	var failed int64
	var lockedUntil int64
	inst.db.QueryRow("SELECT failed_attempts, locked_until FROM account WHERE id = 1").Scan(&failed, &lockedUntil)
	if failed < int64(Auth.LockoutThreshold) || failed > ipMaxAttempts {
		t.Fatalf("failed_attempts 应原子累计到 5–30，实际 %d", failed)
	}
	if lockedUntil <= nowMs() {
		t.Fatal("账户应处于锁定状态")
	}
	if got := len(ipBucketOf(ip).hits); got != ipMaxAttempts {
		t.Fatalf("IP 预占名额应停在 %d，实际 %d", ipMaxAttempts, got)
	}
	if _, _, _, apiErr := login(inst.db, "another-wrong", "race-device-0001", "", "test-agent", ip); apiErr == nil || apiErr.Code != "too_many_requests" {
		t.Fatalf("封锁窗口内应直接 429/too_many_requests，实际 %v", apiErr)
	}
}

// 登录成功必须释放预占名额，否则正常用户会被自己的成功请求计入限流。
func TestSec_LoginSuccessReleasesIpReservation(t *testing.T) {
	inst := makeInstance(t, true)
	ResetThrottle()
	defer ResetThrottle()
	const ip = "203.0.113.88"
	for i := 0; i < 3; i++ {
		_, _, _, apiErr := login(inst.db, testPassword, fmt.Sprintf("device-ok-%04d", i),
			"OK 设备", "test-agent", ip)
		if apiErr != nil {
			t.Fatalf("正确密码登录失败: %v", apiErr)
		}
	}
	if got := len(ipBucketOf(ip).hits); got != 0 {
		t.Fatalf("成功登录后预占名额应被释放，实际残留 %d", got)
	}
}

// ═══════════════════════════════════════════════════════════
// 同步状态加载：覆盖数据库错误分支，避免修复逻辑只在 happy path 上被验证。
// ═══════════════════════════════════════════════════════════
func TestSec_SyncStateLoadErrorBranches(t *testing.T) {
	closed, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := closed.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := loadKnownDevices(closed); err == nil {
		t.Fatal("关闭的数据库应让 loadKnownDevices 返回错误")
	}
	if _, err := loadDeviceClocks(closed); err == nil {
		t.Fatal("关闭的数据库应让 loadDeviceClocks 返回错误")
	}

	// Scan 错误：id 为 NULL。
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`
		CREATE TABLE devices (id TEXT);
		CREATE TABLE device_clocks (device_id TEXT, counter INTEGER);
		INSERT INTO devices (id) VALUES (NULL);
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := loadKnownDevices(db); err == nil {
		t.Fatal("NULL id 应让 loadKnownDevices 返回 Scan 错误")
	}

	// Scan 错误：counter 为 NULL；同时用于覆盖 applyPush 的加载失败分支。
	db2, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	db2.SetMaxOpenConns(1)
	if _, err := db2.Exec(`
		CREATE TABLE devices (id TEXT);
		CREATE TABLE device_clocks (device_id TEXT, counter TEXT);
		INSERT INTO device_clocks (device_id, counter) VALUES ('device-B-0002', NULL);
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := loadDeviceClocks(db2); err == nil {
		t.Fatal("NULL counter 应让 loadDeviceClocks 返回 Scan 错误")
	}
	tx, err := db2.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, apiErr := applyPush(tx, "device-A-0001", nil); apiErr == nil || apiErr.Code != "internal_error" {
		t.Fatalf("applyPush 加载设备时钟失败时应返回 internal_error，实际 %v", apiErr)
	}
	_ = tx.Rollback()
}

// ═══════════════════════════════════════════════════════════
// validateIncoming：补齐边界输入的拒绝路径
// ═══════════════════════════════════════════════════════════
func TestSec_ValidateIncomingRejectsMalformed(t *testing.T) {
	known := map[string]bool{"device-A-0001": true}
	cases := []struct {
		name string
		raw  string
	}{
		{"非法 JSON", `{`},
		{"缺少 id", `{"kind":"task","data":{},"vc":{"device-A-0001":1},"updatedAt":1}`},
		{"id 字符集不合法", `{"id":"bad id","kind":"task","data":{},"vc":{"device-A-0001":1},"updatedAt":1}`},
		{"kind 不合法", `{"id":"x","kind":"nope","data":{},"vc":{"device-A-0001":1},"updatedAt":1}`},
		{"data 不是对象/数组", `{"id":"x","kind":"task","data":"str","vc":{"device-A-0001":1},"updatedAt":1}`},
		{"缺少 vc", `{"id":"x","kind":"task","data":{},"updatedAt":1}`},
		{"vc 是数组", `{"id":"x","kind":"task","data":{},"vc":[],"updatedAt":1}`},
		{"vc 分量为未知设备", `{"id":"x","kind":"task","data":{},"vc":{"unknown-device":1},"updatedAt":1}`},
		{"vc 设备键为空", `{"id":"x","kind":"task","data":{},"vc":{"":1},"updatedAt":1}`},
		{"vc 分量不是整数", `{"id":"x","kind":"task","data":{},"vc":{"device-A-0001":"1"},"updatedAt":1}`},
		{"vc 分量为 0", `{"id":"x","kind":"task","data":{},"vc":{"device-A-0001":0},"updatedAt":1}`},
		{"vc 分量超出上界", fmt.Sprintf(`{"id":"x","kind":"task","data":{},"vc":{"device-A-0001":%d},"updatedAt":1}`, uint64(Sync.MaxVcCounter)+1)},
		{"vc 分量非普通整数", `{"id":"x","kind":"task","data":{},"vc":{"device-A-0001":1e3},"updatedAt":1}`},
		{"缺少 updatedAt", `{"id":"x","kind":"task","data":{},"vc":{"device-A-0001":1}}`},
		{"updatedAt 非普通整数", `{"id":"x","kind":"task","data":{},"vc":{"device-A-0001":1},"updatedAt":1e3}`},
		{"data 超过记录上限", fmt.Sprintf(`{"id":"x","kind":"task","data":{"x":%q},"vc":{"device-A-0001":1},"updatedAt":1}`, strings.Repeat("a", Sync.MaxRecordBytes))},
	}
	// vc 分量过多：在单独 case 里构造，避免字面量过长。
	var many strings.Builder
	many.WriteString(`{"id":"x","kind":"task","data":{},"vc":{`)
	for i := 0; i <= Sync.MaxVcDevices; i++ {
		if i > 0 {
			many.WriteByte(',')
		}
		fmt.Fprintf(&many, `"k%d":1`, i)
	}
	many.WriteString(`},"updatedAt":1}`)
	cases = append(cases, struct {
		name string
		raw  string
	}{"vc 分量过多", many.String()})

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			inc, apiErr := validateIncoming([]byte(tc.raw), known, "device-A-0001", map[string]uint64{"device-A-0001": 1})
			if apiErr == nil || inc != nil {
				t.Fatalf("应拒绝，实际 inc=%v err=%v", inc, apiErr)
			}
		})
	}
}

// ───────────────────────── 辅助 ─────────────────────────

// cookieFor 以指定设备登录并返回其 cookie（不改动 default 槽位的语义由调用方负责）。
func cookieFor(t *testing.T, inst *instance, deviceID string) string {
	t.Helper()
	prev := inst.jars["default"]
	res := inst.login(t, map[string]string{"deviceId": deviceID})
	if res.status != 200 {
		t.Fatalf("登录 %s 失败: %d %s", deviceID, res.status, res.text)
	}
	c := inst.jars["default"]
	inst.jars["default"] = prev
	return c
}

// clientIpFromHeader 直接验证 XFF 取值规则（只信任最右一跳）。
func clientIpFromHeader(xff string) string {
	r := &http.Request{Header: http.Header{}, RemoteAddr: "127.0.0.1:12345"}
	r.Header.Set("x-forwarded-for", xff)
	return clientIp(r)
}

func pushRaw(deviceID, recordJSON string) map[string]any {
	return map[string]any{
		"deviceId": deviceID,
		"cursor":   0,
		"push":     []json.RawMessage{json.RawMessage(recordJSON)},
	}
}

func mustRawJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func firstLine(s string) string {
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		return s[:i]
	}
	return truncateForLog(s, 200)
}

func truncateForLog(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

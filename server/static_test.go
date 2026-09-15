package main

// 静态文件服务的守护测试。
//
// 核心不变量：任何 URL 都不能读到 webDist 之外的文件。
// Windows 上反斜杠是路径分隔符，而 path.Clean 只认 '/'，
// %5C 逃过 Clean 后经 filepath.Join 清洗即可穿越 —— 这里的用例
// 在修复前必须失败（返回 200），修复后必须全部 404。

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStaticSecurity(t *testing.T) {
	dir := t.TempDir()
	dist := filepath.Join(dir, "dist")
	if err := os.MkdirAll(filepath.Join(dist, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dist, "index.html"), []byte("<html>spa-entry</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dist, "assets", "app-abc123.js"), []byte("console.log(1)"), 0o644); err != nil {
		t.Fatal(err)
	}
	// webDist 之外的机密文件：穿越成功就能读到它
	secret := filepath.Join(dir, "secret.txt")
	if err := os.WriteFile(secret, []byte("TOP-SECRET"), 0o644); err != nil {
		t.Fatal(err)
	}

	inst := makeInstanceWithDist(t, dist)

	// 反斜杠/UNC 形式：path.Clean 无法清洗，必须显式 404
	backslashPaths := []string{
		"/%5C..%5Csecret.txt",                // 单层反斜杠穿越
		"/%5C..%5C..%5Csecret.txt",           // 多层反斜杠穿越
		"/assets/%5C..%5C..%5Csecret.txt",    // 从子目录出发
		"/..%5Csecret.txt",                   // 前缀形式
		"/%5C%5Cserver%5Cshare%5Csecret.txt", // UNC 路径
	}
	for _, p := range backslashPaths {
		res := inst.call(t, "GET", p, nil, nil)
		if res.status != http.StatusNotFound {
			t.Errorf("穿越路径 %s 应返回 404，实际 %d", p, res.status)
		}
		if strings.Contains(res.text, "TOP-SECRET") {
			t.Errorf("穿越路径 %s 泄露了 webDist 外的文件内容", p)
		}
	}

	// 正斜杠 ../ 形式：path.Clean 会把它们规约回 webDist 内的路径，
	// 未命中时走 SPA fallback 返回 200 的 index.html —— 这是设计行为。
	// 不变量只有一条：绝不返回 webDist 外的文件内容。
	forwardPaths := []string{
		"/%2e%2e%2fsecret.txt",
		"/..%2fsecret.txt",
	}
	for _, p := range forwardPaths {
		res := inst.call(t, "GET", p, nil, nil)
		if strings.Contains(res.text, "TOP-SECRET") {
			t.Errorf("穿越路径 %s 泄露了 webDist 外的文件内容", p)
		}
	}

	// 正常路径不受影响
	res := inst.call(t, "GET", "/", nil, nil)
	if res.status != 200 || !strings.Contains(res.text, "spa-entry") {
		t.Errorf("SPA 入口应 200 并返回 index.html，实际 %d", res.status)
	}
	res = inst.call(t, "GET", "/assets/app-abc123.js", nil, nil)
	if res.status != 200 || !strings.Contains(res.text, "console.log(1)") {
		t.Errorf("静态资源应 200，实际 %d", res.status)
	}
	// SPA fallback：未知路径交 index.html
	res = inst.call(t, "GET", "/tasks/xxx", nil, nil)
	if res.status != 200 || !strings.Contains(res.text, "spa-entry") {
		t.Errorf("SPA fallback 应 200，实际 %d", res.status)
	}
}

// makeInstanceWithDist 与 makeInstance 同构，但允许指定前端产物目录。
func makeInstanceWithDist(t *testing.T, dist string) *instance {
	t.Helper()
	dir := t.TempDir()
	db, err := openDatabase(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("打开数据库失败: %v", err)
	}
	app := NewApp(db, dist)
	ts := httptest.NewServer(app)
	inst := &instance{db: db, base: ts.URL, ts: ts, jars: map[string]string{}}
	t.Cleanup(func() {
		ts.Close()
		db.Close()
		os.RemoveAll(dir)
	})
	return inst
}

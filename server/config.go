// 运行期配置。所有可变项都支持环境变量覆盖，方便部署时不改代码。
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
)

const Version = "1.0.2"

// 仓库根目录：优先 TWISCHE_ROOT，其次从工作目录向上找同时含 web/ 与 server/ 的目录。
func findRoot() string {
	if v := os.Getenv("TWISCHE_ROOT"); v != "" {
		return v
	}
	cwd, err := os.Getwd()
	if err == nil {
		for _, c := range []string{cwd, filepath.Dir(cwd)} {
			if isDir(filepath.Join(c, "web")) && isDir(filepath.Join(c, "server")) {
				return c
			}
		}
	}
	return cwd
}

func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

var (
	Root      = findRoot()
	DataDir   = envPath("TWISCHE_DATA_DIR", filepath.Join(Root, "data"))
	DBPath    = envPath("TWISCHE_DB", filepath.Join(DataDir, "twische.db"))
	BackupDir = filepath.Join(DataDir, "backup")
	WebDist   = filepath.Join(Root, "web", "dist")
)

// Server 运行参数。
type ServerConfig struct {
	Port       int
	Host       string
	TrustProxy bool
}

// Auth 安全参数。数值与旧版 Node 服务端逐项一致。
type AuthConfig struct {
	CookieName        string
	SessionTtlMs      int64
	MaxSessions       int
	LockoutThreshold  int
	LockoutBaseMs     int64
	LockoutMaxMs      int64
	MinPasswordLength int
	MaxPasswordLength int
	BcryptRounds      int
	// ElevateTtlMs 会话提权有效期：登录本身即视为提权，此后管理其它设备
	// （改名 / 吊销 / 移除）需要重新输入密码换取一段有效期。
	ElevateTtlMs int64
}

// Sync 同步协议参数。
type SyncConfig struct {
	MaxPushBatch   int
	MaxPullBatch   int
	MaxRecordBytes int
	MaxBodyBytes   int64
	TombstoneTtlMs int64
	// MaxVcCounter 单个设备在向量时钟里的分量上界。
	//
	// 这不是"够不够用"的问题，而是同步正确性的必要条件：计数器由各设备
	// 本地单调递增，一台设备要走到 N 就必须先同步 N 次，因此 2^40
	// （约 1.1e12 次）远超任何真实使用。反过来，不加界就等于允许客户端
	// 申报任意大的数——一旦超过 IEEE-754 的整数精度上限 2^53，
	// 客户端 `vcGet(...) + 1` 会因浮点舍入而不再增长（1e19 + 1 == 1e19），
	// 该记录此后任何修改都会被判为 "equal/unchanged" 而静默丢弃。
	MaxVcCounter uint64
	// MaxVcDevices 单条记录向量时钟的分量个数上界，防止用海量设备键撑爆内存。
	MaxVcDevices int
}

var (
	Server = ServerConfig{
		Port:       envInt2("TWISCHE_PORT", "PORT", 8787),
		Host:       envStr("TWISCHE_HOST", "127.0.0.1"),
		TrustProxy: os.Getenv("TWISCHE_TRUST_PROXY") == "1",
	}
	Auth = AuthConfig{
		CookieName:        "twische_sid",
		SessionTtlMs:      30 * 24 * 3600 * 1000,
		MaxSessions:       32,
		LockoutThreshold:  5,
		LockoutBaseMs:     60 * 1000,
		LockoutMaxMs:      15 * 60 * 1000,
		MinPasswordLength: 8,
		MaxPasswordLength: 200,
		BcryptRounds:      envInt("TWISCHE_BCRYPT_ROUNDS", 12),
		ElevateTtlMs:      15 * 60 * 1000,
	}
	Sync = SyncConfig{
		MaxPushBatch:    500,
		MaxPullBatch:    500,
		MaxRecordBytes:  256 * 1024,
		MaxBodyBytes:    4 * 1024 * 1024,
		TombstoneTtlMs:  90 * 24 * 3600 * 1000,
		MaxVcCounter:    1 << 40,
		MaxVcDevices:    64,
	}
)

var RecordKinds = []string{"task", "completion", "pref", "tag"}

func isRecordKind(k string) bool {
	for _, v := range RecordKinds {
		if v == k {
			return true
		}
	}
	return false
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envInt2(k1, k2 string, def int) int {
	if v := os.Getenv(k1); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return envInt(k2, def)
}

func envPath(key, def string) string {
	if v := os.Getenv(key); v != "" {
		if p, err := filepath.Abs(v); err == nil {
			return p
		}
		return v
	}
	return def
}

// DescribeEnv 对外的环境描述，故意不含数据库路径与主机名。
func DescribeEnv() map[string]any {
	return map[string]any{
		"app":      fmt.Sprintf("Twische %s", Version),
		"runtime":  runtime.Version(),
		"platform": runtime.GOOS,
	}
}

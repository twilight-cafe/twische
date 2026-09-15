// SQLite 接入层：连接、PRAGMA 调优、版本化迁移。
//
// 设计约束（来自需求）：后端只负责身份验证与资料存储，不承载业务计算。
// 因此这里没有"日程表"，只有一张通用的 records 表 + 向量时钟列 —— 业务形状
// 由客户端定义并随 data(JSON) 一起流动，后端只做版本判定与持久化。
//
// 与旧版 Node 服务端共用同一 schema（user_version=1），库文件二进制兼容，
// 可以直接在现有数据上切换运行。
package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// schemaV1 与旧版 db.js 迁移 #1 的 SQL 完全一致。
const schemaV1 = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  username            TEXT    NOT NULL,
  password_hash       TEXT    NOT NULL,
  password_algo       TEXT    NOT NULL DEFAULT 'bcrypt',
  password_rounds     INTEGER NOT NULL DEFAULT 12,
  password_updated_at INTEGER NOT NULL,
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        INTEGER NOT NULL DEFAULT 0,
  last_login_at       INTEGER,
  created_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  secret_hash    TEXT NOT NULL,
  device_id      TEXT NOT NULL,
  user_agent     TEXT,
  ip             TEXT,
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_device  ON sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  platform     TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  push_count   INTEGER NOT NULL DEFAULT 0,
  pull_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- 关键设计：seq 与主键分离。每一次被接受的写入（含更新、含墓碑）都要
-- 重新领取 seq，否则"别的设备改了某条记录"不会产生新 seq，增量同步追不下来。
CREATE TABLE IF NOT EXISTS records (
  row_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  seq           INTEGER NOT NULL,
  id            TEXT    NOT NULL UNIQUE,
  kind          TEXT    NOT NULL,
  data          TEXT    NOT NULL,
  vc            TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  byte_size     INTEGER NOT NULL,
  origin_device TEXT,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_seq  ON records(seq);
CREATE INDEX        IF NOT EXISTS idx_records_kind ON records(kind);
CREATE INDEX        IF NOT EXISTS idx_records_del  ON records(deleted, updated_at);

CREATE TABLE IF NOT EXISTS device_clocks (
  device_id  TEXT PRIMARY KEY,
  counter    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conflicts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id         TEXT NOT NULL,
  kind              TEXT NOT NULL,
  at                INTEGER NOT NULL,
  winner            TEXT NOT NULL,
  loser_vc          TEXT NOT NULL,
  winner_vc         TEXT NOT NULL,
  loser_updated_at  INTEGER NOT NULL,
  winner_updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conflicts_at ON conflicts(at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  event     TEXT NOT NULL,
  detail    TEXT,
  ip        TEXT,
  device_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
`

// schemaV2 会话提权：管理其它设备（改名 / 吊销 / 移除）属于敏感操作，
// 需要一段由重新输入密码换来的有效期。登录本身即视为提权。
const schemaV2 = `
ALTER TABLE sessions ADD COLUMN elevated_until INTEGER NOT NULL DEFAULT 0;
`

// migrateStep 一次版本迁移。
type migrateStep struct {
	to  int
	sql string
}

// migrations 按序应用；每一步都在同一事务里，失败即整体回滚。
//
// 加新版本时只追加一条，不要改动已有条目 —— 已有实例的 user_version
// 会跳过它们，改了也不会生效。
var migrations = []migrateStep{
	{to: 1, sql: schemaV1},
	{to: 2, sql: schemaV2},
}

var META_KEYS = struct {
	InitializedAt     string
	InstanceID        string
	TombstoneFloorSeq string
	SchemaNote        string
}{
	InitializedAt:     "initialized_at",
	InstanceID:        "instance_id",
	TombstoneFloorSeq: "tombstone_floor_seq",
	SchemaNote:        "schema_note",
}

// openDatabase 打开数据库并完成 PRAGMA 调优 + 迁移。
//
// 单连接（MaxOpenConns=1）：与旧版 better-sqlite3 的单线程串行语义一致，
// 事务内外不会争抢连接，也就天然避免了 SQLITE_BUSY 的多数场景。
func openDatabase(filePath string) (*sql.DB, error) {
	if filePath != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
			return nil, err
		}
	}
	dsn := filePath
	if filePath == ":memory:" {
		// 内存库也要保证多个连接看到同一份数据（这里只有 1 个连接，仍显式声明）
		dsn = "file:twische_mem?mode=memory&cache=shared"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	for _, pragma := range []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA synchronous = NORMAL",
		"PRAGMA busy_timeout = 5000",
		"PRAGMA foreign_keys = ON",
		"PRAGMA temp_store = MEMORY",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("pragma %q: %w", pragma, err)
		}
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	// 与迁移分开：消毒必须在**每次**开库时执行，而不是只在新版本迁移时执行。
	// 放在 migrate 里会被 `from >= 最新版本` 的提前返回跳过，历史脏数据就永远
	// 留在库里（实测过：第二次开库时不会被清理）。
	if err := sanitizeLegacyClocks(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func currentVersion(db *sql.DB) int {
	var v int
	_ = db.QueryRow("PRAGMA user_version").Scan(&v)
	return v
}

// migrate 逐条应用未执行的迁移，整体包在一个事务里，失败即回滚。
func migrate(db *sql.DB) error {
	from := currentVersion(db)
	if from >= migrations[len(migrations)-1].to {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, m := range migrations {
		if m.to <= from {
			continue
		}
		if _, err := tx.Exec(m.sql); err != nil {
			return fmt.Errorf("迁移到 v%d 失败: %w", m.to, err)
		}
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", m.to)); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return nil
}

// sanitizeLegacyClocks 修复历史数据：v2 之前的版本没有时钟分量上界，
// 超过 Sync.MaxVcCounter 的分量可能已经落库（实测 1e19 可写入，1e300 会被
// 未定义的浮点转换塌缩成 2^63）。这些值会让客户端 `vcGet + 1` 停止增长，
// 使对应记录再也无法更新，因此开库时统一夹到上界。
//
// 只夹不删：把超高分量降到上界，记录仍可被更新（客户端下一次写入即可
// 以正常时钟支配它），比直接丢弃数据温和。
func sanitizeLegacyClocks(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	rows, err := tx.Query("SELECT row_id, vc FROM records")
	if err != nil {
		return err
	}
	type fix struct {
		rowID int64
		vc    string
	}
	var fixes []fix
	for rows.Next() {
		var rowID int64
		var raw string
		if err := rows.Scan(&rowID, &raw); err != nil {
			rows.Close()
			return err
		}
		vc, changed := vcClampOversized(raw)
		if changed {
			fixes = append(fixes, fix{rowID: rowID, vc: vc})
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, f := range fixes {
		if _, err := tx.Exec("UPDATE records SET vc = ? WHERE row_id = ?", f.vc, f.rowID); err != nil {
			return err
		}
	}

	// device_clocks 同理：全局版本向量直接由它汇总而来
	if _, err := tx.Exec(
		"UPDATE device_clocks SET counter = ? WHERE counter > ?",
		int64(Sync.MaxVcCounter), int64(Sync.MaxVcCounter)); err != nil {
		return err
	}
	return tx.Commit()
}

// rowQuerier 同时被 *sql.DB 与 *sql.Tx 满足，让 meta/counters 两种上下文都能用。
type rowQuerier interface {
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
	Exec(query string, args ...any) (sql.Result, error)
}

// nextSeq 领取下一个 records.seq。
//
// 必须在写入记录的同一次事务里调用，否则并发写入可能拿到相同序号
// （seq 上有 UNIQUE 索引，重复会直接报错而不是静默出错，这是有意的）。
// 用 RETURNING 一次往返拿到结果，避免"先更新再查询"之间的竞态。
func nextSeq(q rowQuerier) (int64, error) {
	var v int64
	err := q.QueryRow(
		`INSERT INTO counters (name, value) VALUES ('records_seq', 1)
		 ON CONFLICT(name) DO UPDATE SET value = value + 1
		 RETURNING value`,
	).Scan(&v)
	return v, err
}

// ───────────────────────── meta 便捷读写 ─────────────────────────

func metaGet(q rowQuerier, key string) (string, bool) {
	var v string
	err := q.QueryRow("SELECT value FROM meta WHERE key = ?", key).Scan(&v)
	if err != nil {
		return "", false
	}
	return v, true
}

func metaGetInt(q rowQuerier, key string, fallback int64) int64 {
	if v, ok := metaGet(q, key); ok {
		var n int64
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil {
			return n
		}
	}
	return fallback
}

func metaSet(q rowQuerier, key, value string) error {
	_, err := q.Exec(
		`INSERT INTO meta (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

func metaSetInt(q rowQuerier, key string, value int64) error {
	return metaSet(q, key, fmt.Sprintf("%d", value))
}

func metaDel(db *sql.DB, key string) error {
	_, err := db.Exec("DELETE FROM meta WHERE key = ?", key)
	return err
}

// isInitialized 是否已完成 `twische init`。整个后端以此为准决定能否提供服务。
func isInitialized(db *sql.DB) bool {
	var id int64
	err := db.QueryRow("SELECT id FROM account WHERE id = 1").Scan(&id)
	if err != nil {
		return false
	}
	_, ok := metaGet(db, META_KEYS.InitializedAt)
	return ok
}

// audit 审计流水：登录、改密、初始化等安全事件。
func audit(db *sql.DB, event string, detail, ip, deviceID string) {
	db.Exec(
		"INSERT INTO audit_log (at, event, detail, ip, device_id) VALUES (?, ?, ?, ?, ?)",
		time.Now().UnixMilli(), event, nullStr(detail), nullStr(ip), nullStr(deviceID),
	)
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// stats 汇总统计，供 `twische status` 与设置页使用。
func stats(db *sql.DB) map[string]any {
	one := func(query string, args ...any) int64 {
		var n int64
		db.QueryRow(query, args...).Scan(&n)
		return n
	}
	return map[string]any{
		"records":        one("SELECT COUNT(*) FROM records WHERE deleted = 0"),
		"tombstones":     one("SELECT COUNT(*) FROM records WHERE deleted = 1"),
		"devices":        one("SELECT COUNT(*) FROM devices"),
		"activeSessions": one("SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > ?", time.Now().UnixMilli()),
		"conflicts":      one("SELECT COUNT(*) FROM conflicts"),
		"clock":          one("SELECT IFNULL(SUM(counter), 0) FROM device_clocks"),
	}
}

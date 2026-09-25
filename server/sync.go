// 同步引擎（服务端侧）。
//
// ## 协议
// `POST /api/sync` 单次往返完成"推 + 拉"：
//
//	{ deviceId, cursor, limit, push: [ {id, kind, data, vc, updatedAt, deleted} ] }
//	→ { cursor, records, hasMore, serverVector, applied, conflicts, resyncRequired }
//
// ## 为什么这样设计
//  1. 游标 + 向量时钟双判据：游标(seq)负责"我没见过的新记录"，向量时钟负责
//     "我见过、但看到的不是最新版"。任一被接受的写入都会刷新 seq，因此
//     `seq > cursor` 就足以覆盖增量；向量时钟则用在 push 侧做因果判定。
//  2. 冲突必须收敛到同一点：接受写入时统一存 merge(旧, 新) —— 结果同时支配
//     双方，输家下次推送必然被判为 stale 并被动拉取赢家数据，一次收敛。
//  3. 幂等：vc 相同的重复推送判为 unchanged，不产生写入、不推进 seq。
//  4. 墓碑有水位：墓碑被清理后，落后太多的客户端必须走全量重建。
package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"time"
)

// wireRecord 出站记录。
type wireRecord struct {
	ID        string          `json:"id"`
	Kind      string          `json:"kind"`
	Data      json.RawMessage `json:"data"`
	Vc        VC              `json:"vc"`
	UpdatedAt int64           `json:"updatedAt"`
	Deleted   bool            `json:"deleted"`
	Seq       int64           `json:"seq"`
}

// appliedEntry 单条推送的处理结果。
type appliedEntry struct {
	ID              string `json:"id"`
	Status          string `json:"status"`
	Seq             int64  `json:"seq,omitempty"`
	ServerVc        VC     `json:"serverVc,omitempty"`
	ServerUpdatedAt int64  `json:"serverUpdatedAt,omitempty"`
}

type conflictEntry struct {
	ID     string `json:"id"`
	Winner string `json:"winner"`
}

// incomingRecord 严格校验后的入站记录。
type incomingRecord struct {
	ID        string
	Kind      string
	DataJSON  string // 紧凑 JSON（保序，等价旧版 JSON.stringify）
	Vc        VC
	VcJSON    string
	UpdatedAt int64
	Deleted   int
	Bytes     int
}

func now() int64 { return time.Now().UnixMilli() }

// decodeWithNumber 带精确数字语义的 JSON 解码。
func decodeWithNumber(b []byte, out any) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	return dec.Decode(out)
}

// parseVc 解析库内 vc 列，损坏时回退空时钟（不抛错，与旧版一致）。
func parseVc(raw string) VC {
	if raw == "" {
		return VC{}
	}
	var m map[string]any
	if err := decodeWithNumber([]byte(raw), &m); err != nil {
		return VC{}
	}
	return vcNormalizeRaw(m)
}

// recordRow records 表行。
type recordRow struct {
	RowID        int64
	Seq          int64
	ID           string
	Kind         string
	Data         string
	Vc           string
	UpdatedAt    int64
	Deleted      int64
	ByteSize     int64
	OriginDevice sql.NullString
	CreatedAt    int64
}

const recordColumns = "row_id, seq, id, kind, data, vc, updated_at, deleted, byte_size, origin_device, created_at"

func scanRecord(row *sql.Row) (*recordRow, error) {
	var r recordRow
	var origin sql.NullString
	err := row.Scan(&r.RowID, &r.Seq, &r.ID, &r.Kind, &r.Data, &r.Vc, &r.UpdatedAt,
		&r.Deleted, &r.ByteSize, &origin, &r.CreatedAt)
	if err != nil {
		return nil, err
	}
	r.OriginDevice = origin
	return &r, nil
}

// selectRecord 按业务 id 查记录；不存在返回 (nil, nil)。
func selectRecord(q rowQuerier, id string) (*recordRow, error) {
	r, err := scanRecord(q.QueryRow("SELECT "+recordColumns+" FROM records WHERE id = ?", id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return r, err
}

// toWire 序列化出站记录。
func toWire(row *recordRow) wireRecord {
	data := json.RawMessage(row.Data)
	if len(bytes.TrimSpace(data)) == 0 {
		data = json.RawMessage("{}")
	}
	return wireRecord{
		ID:        row.ID,
		Kind:      row.Kind,
		Data:      data,
		Vc:        parseVc(row.Vc),
		UpdatedAt: row.UpdatedAt,
		Deleted:   row.Deleted != 0,
		Seq:       row.Seq,
	}
}

// validateIncoming 单条入站记录的严格校验。宁可拒绝一条脏数据，也不让它污染向量时钟。
// raw 是单条 push 元素的原始 JSON。knownDevices 是服务端认可的合法设备标识集合
// （由 applyPush 在事务内一次性载入）—— 向量时钟的设备键必须落在其中。
func validateIncoming(raw []byte, knownDevices map[string]bool, authDeviceID string, serverClocks map[string]uint64) (*incomingRecord, *AppError) {
	var fields map[string]json.RawMessage
	if err := decodeWithNumber(raw, &fields); err != nil {
		return nil, E.BadRequest("记录必须是对象")
	}

	idRaw, hasID := fields["id"]
	id := ""
	if hasID {
		json.Unmarshal(idRaw, &id) // 非字符串时保持 ""，走同一条错误路径
	}
	if len(id) < 1 || utf8Count(id) > 128 {
		return nil, E.BadRequest("记录 id 必须是 1–128 字符的字符串")
	}
	// 记录 id 会被写进库、回吐给所有设备、出现在导出文件与 URL 查询里。
	// 不限制字符集就等于允许控制字符、ANSI 转义、路径片段这类载荷自由流动，
	// 因此这里收成白名单（见 reRecordID 的说明）。
	if !reRecordID.MatchString(id) {
		return nil, E.BadRequest("记录 id 只能包含字母、数字、连字符、下划线，或 `任务id|实例键` 形式的两段式 id")
	}

	kind := ""
	if kindRaw, ok := fields["kind"]; ok {
		json.Unmarshal(kindRaw, &kind)
	}
	if !isRecordKind(kind) {
		return nil, E.BadRequest("记录类型「" + truncateRunes(kind, 20) + "」不受支持")
	}

	// data 必须是对象（JS 语义里数组也算 object，故这里同样放行数组）
	dataRaw, hasData := fields["data"]
	if !hasData || !isJSONComposite(dataRaw) {
		return nil, E.BadRequest("记录 " + id + " 的 data 必须是对象")
	}

	// 先逐分量校验原始输入，再归一化。
	// 若先归一化，{A:0} 会被规范化成 {}，报出来的错误变成"缺少向量时钟"，
	// 掩盖了真正的问题（分量写成了 0）。
	vcRaw, hasVc := fields["vc"]
	var vcMap map[string]any
	if hasVc {
		if err := decodeWithNumber(vcRaw, &vcMap); err != nil {
			vcMap = nil // 数组等非对象输入
		}
	}
	if !hasVc || vcMap == nil || len(vcMap) == 0 {
		return nil, E.BadRequest("记录 " + id + " 缺少向量时钟")
	}
	if len(vcMap) > Sync.MaxVcDevices {
		return nil, E.BadRequest("记录 " + id + " 的向量时钟分量过多（上限 " +
			itoa(Sync.MaxVcDevices) + "）")
	}
	for dev, counter := range vcMap {
		if dev == "" || utf8Count(dev) > 128 {
			return nil, E.BadRequest("记录 " + id + " 的向量时钟包含非法设备标识")
		}
		// 设备键必须是服务端登记过的设备。否则任意字符串都能凭空造出一条
		// device_clocks 行，污染全局版本向量（幽灵设备），并使
		// `twische status` 的"版本向量总和"失去意义。
		if !knownDevices[dev] {
			return nil, E.BadRequest("记录 " + id + " 的向量时钟引用了未登记的设备")
		}
		n, isInt := numOfI(counter)
		if !isInt || n < 1 {
			return nil, E.BadRequest("记录 " + id + " 的向量时钟分量 " + dev + " 必须为正整数")
		}
		// 上界校验：见 SyncConfig.MaxVcCounter。超出即拒绝，不做截断 ——
		// 截断会把两个不同的输入映射成同一个时钟，破坏幂等与因果判据。
		if !vcComponentInRange(n) {
			return nil, E.BadRequest("记录 " + id + " 的向量时钟分量 " + dev +
				" 超出允许范围（1–" + itoa64(int64(Sync.MaxVcCounter)) + "）")
		}
		// 科学计数法字面量（1e19）在不同 JSON 实现里会被舍入到不同的值，
		// 落库后可能超出精度上限。要求写成普通十进制整数，语义无歧义。
		if !isPlainIntegerLiteral(counter) {
			return nil, E.BadRequest("记录 " + id + " 的向量时钟分量 " + dev +
				" 必须写成十进制整数，不支持科学计数法或字符串")
		}
		if dev != authDeviceID && uint64(n) > serverClocks[dev] {
			return nil, E.BadRequest("记录 " + id + " 的向量时钟分量 " + dev +
				" 超过了服务端已知值，不能替其它设备推进时钟")
		}
	}
	vc := vcNormalizeRaw(vcMap)
	if len(vc) == 0 {
		return nil, E.BadRequest("记录 " + id + " 缺少有效的向量时钟")
	}

	upRaw, hasUp := fields["updatedAt"]
	if !hasUp {
		return nil, E.BadRequest("记录 " + id + " 的 updatedAt 不合法")
	}
	var upNum any
	if err := decodeWithNumber(upRaw, &upNum); err != nil {
		return nil, E.BadRequest("记录 " + id + " 的 updatedAt 不合法")
	}
	upF, ok := numOf(upNum)
	if !ok || upF <= 0 || upF != upF || upF > 1e308 || upF < -1e308 {
		return nil, E.BadRequest("记录 " + id + " 的 updatedAt 不合法")
	}
	if !isPlainIntegerLiteral(upNum) {
		return nil, E.BadRequest("记录 " + id + " 的 updatedAt 必须是十进制整数")
	}
	// 截断到毫秒整数前先确认没有小数部分，避免 1.9 被悄悄当成 1
	if upF != math.Trunc(upF) {
		return nil, E.BadRequest("记录 " + id + " 的 updatedAt 必须是整数毫秒")
	}
	updatedAt := int64(upF) // 已确认是整数且在 int64 量程内

	// data 紧凑化：等价于旧版 JSON.stringify(rec.data)（去空白、保键序）
	var compact bytes.Buffer
	if err := json.Compact(&compact, dataRaw); err != nil {
		return nil, E.BadRequest("记录 " + id + " 的 data 不是合法的 JSON")
	}
	dataJSON := compact.String()
	if len(dataJSON) > Sync.MaxRecordBytes {
		return nil, E.TooLarge("记录 " + id + " 体积 " + itoa(len(dataJSON)) +
			" 字节，超出上限 " + itoa(Sync.MaxRecordBytes) + " 字节")
	}

	deleted := 0
	if dRaw, ok := fields["deleted"]; ok {
		var dv any
		if err := decodeWithNumber(dRaw, &dv); err == nil {
			deleted = truthyJSON(dv)
		}
	}

	return &incomingRecord{
		ID:        id,
		Kind:      kind,
		DataJSON:  dataJSON,
		Vc:        vc,
		VcJSON:    vcJSON(vc),
		UpdatedAt: updatedAt,
		Deleted:   deleted,
		Bytes:     len(dataJSON),
	}, nil
}

// reRecordID 记录 id 的白名单。两条分支，对应两类 id：
//
//  1. 单段 id —— 字母、数字、连字符、下划线（上限 128 字符）。
//     客户端生成的任务/偏好 id 走这条：`uuid()` 的 RFC4122 形态、
//     `shortId()` 的 `t_xxxx` 形态都落在这里。
//
//  2. 两段式 id —— `前缀|后缀`，前后各自收紧、整体仍受 128 字符约束。
//     完成打卡记录用 `taskId|实例键`（见 shared/recurrence.js 的
//     occurrenceCompletionId）。这个复合形态是**功能性的**：多端同时勾选
//     同一天必须算出同一条记录，否则会各写一条、打卡状态互相看不见。
//
//     最早这里只有单段分支，结果所有含竖线的 completion id 一律被拒 ——
//     而客户端本地照样写库、界面照样显示"已打卡"，只有同步静默失败。
//     最后一位服务端确认过的任务打卡就成了永远推不上去的孤岛。
//
// 两段分支的前缀沿用单段字符集（它本来就是 taskId），后缀是日期或
// 本地时间戳，故允许 ':'、'+'、'.'。整体仍排除空白、控制字符、ANSI 转义、
// 引号、反斜杠与 '/' —— 这正是当初收紧字符集的理由，必须保留。
var reRecordID = regexp.MustCompile(
	`^(?:[A-Za-z0-9_-]{1,128}|[A-Za-z0-9_-]{1,128}\|[A-Za-z0-9:+.TZ_-]{1,64})$`)

// isPlainIntegerLiteral 判断一个已解码的 JSON 值是否是"普通十进制整数"字面量：
// json.Number 且只含数字（允许前导 -）。科学计数法（1e19）、带小数点（1.0）、
// 字符串形式的数字一律不算 —— 这些写法在不同 JSON 实现里语义不完全一致，
// 而时钟分量必须无歧义。
func isPlainIntegerLiteral(v any) bool {
	n, ok := v.(json.Number)
	if !ok {
		return false
	}
	s := n.String()
	if s == "" {
		return false
	}
	if s[0] == '-' {
		s = s[1:]
	}
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// itoa64 十进制输出，用于错误提示。
func itoa64(n int64) string { return strconv.FormatInt(n, 10) }

// truthyJSON JS 语义的真值判定（deleted 任意类型）。
func truthyJSON(v any) int {
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
	case json.Number:
		f, err := x.Float64()
		if err == nil && f != 0 {
			return 1
		}
	case string:
		if x != "" {
			return 1
		}
	default:
		return 1 // 对象 / 数组恒为真
	}
	return 0
}

// isJSONComposite 首个非空白字节是否为 '{' 或 '['。
func isJSONComposite(b []byte) bool {
	for _, c := range b {
		switch c {
		case ' ', '\t', '\n', '\r':
			continue
		case '{', '[':
			return true
		default:
			return false
		}
	}
	return false
}

func utf8Count(s string) int {
	n := 0
	for range s {
		n++
	}
	return n
}

// applyPushResult applyPush 的产出。
type applyPushResult struct {
	Applied     []appliedEntry
	Conflicts   []conflictEntry
	Corrections []wireRecord
}

// loadKnownDevices 载入服务端认可的设备标识集合。
//
// devices 是当前仍可管理/登录的设备；device_clocks 是历史时钟注册表。
// 忘记设备只删除 devices 行，不删除时钟行，否则它参与过的记录会永久无法推送。
// 两者取并集，既挡掉凭空捏造的幽灵设备，又不丢历史因果信息。
func loadKnownDevices(q rowQuerier) (map[string]bool, error) {
	rows, err := q.Query("SELECT id FROM devices UNION SELECT device_id FROM device_clocks")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// loadDeviceClocks 载入服务端权威设备时钟。
//
// 客户端只能在向量时钟里推进自己的分量；其它设备的分量必须来自服务端已经
// 接受过的历史值。否则一台已认证设备可以把别的设备推到 MaxVcCounter，
// 让它之后的本地修改永远无法形成新的因果版本。
func loadDeviceClocks(q rowQuerier) (map[string]uint64, error) {
	rows, err := q.Query("SELECT device_id, counter FROM device_clocks")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]uint64{}
	for rows.Next() {
		var id string
		var counter int64
		if err := rows.Scan(&id, &counter); err != nil {
			return nil, err
		}
		if counter > 0 {
			out[id] = uint64(counter)
		}
	}
	return out, rows.Err()
}

// applyPush 应用一批推送。整体事务：要么全部生效，要么全部不生效。
// 必须在事务内调用（tx 仅限事务内使用）。
func applyPush(tx *sql.Tx, deviceID string, pushList []json.RawMessage) (*applyPushResult, *AppError) {
	t := now()
	out := &applyPushResult{
		Applied:     []appliedEntry{},
		Conflicts:   []conflictEntry{},
		Corrections: []wireRecord{},
	}
	var correctionIDs []string

	knownDevices, err := loadKnownDevices(tx)
	if err != nil {
		return nil, internalErr(err)
	}
	serverClocks, err := loadDeviceClocks(tx)
	if err != nil {
		return nil, internalErr(err)
	}

	for _, raw := range pushList {
		inc, apiErr := validateIncoming(raw, knownDevices, deviceID, serverClocks)
		if apiErr != nil {
			return nil, apiErr
		}
		stored, err := selectRecord(tx, inc.ID)
		if err != nil {
			return nil, internalErr(err)
		}

		// 无论接受与否，都要记录"这台设备已经走到了第几笔" —— 全局版本向量靠它推进
		for dev, counter := range inc.Vc {
			if _, err := tx.Exec(
				`INSERT INTO device_clocks (device_id, counter, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(device_id) DO UPDATE SET counter = MAX(counter, excluded.counter), updated_at = excluded.updated_at`,
				dev, int64(counter), t,
			); err != nil {
				return nil, internalErr(err)
			}
		}

		if stored == nil {
			seq, err := nextSeq(tx)
			if err != nil {
				return nil, internalErr(err)
			}
			if _, err := tx.Exec(
				`INSERT INTO records (seq, id, kind, data, vc, updated_at, deleted, byte_size, origin_device, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				seq, inc.ID, inc.Kind, inc.DataJSON, inc.VcJSON, inc.UpdatedAt, inc.Deleted, inc.Bytes, deviceID, t,
			); err != nil {
				return nil, internalErr(err)
			}
			out.Applied = append(out.Applied, appliedEntry{ID: inc.ID, Status: "created"})
			continue
		}

		storedVc := parseVc(stored.Vc)
		rel := vcCompare(inc.Vc, storedVc)

		switch rel {
		case "equal":
			// 时钟相等：幂等重放，或"客户端自认的新版本"。
			//
			// 关键：时钟相等**不等于内容相等**。客户端采纳了服务端时钟后本地
			// 再改数据，vc 可能算出同一个值（计数器已被服务端抬到精度上限时尤其
			// 如此）。若这时一律回 unchanged，客户端的修改会被静默丢弃，
			// 而它还因为收到 unchanged 而清掉脏标记 —— 界面显示"已同步"，数据没了。
			// 因此这里必须比对内容：不一致就无条件回发服务端权威版本。
			if stored.Kind == inc.Kind && stored.Data == inc.DataJSON &&
				stored.Deleted == int64(inc.Deleted) && stored.UpdatedAt == inc.UpdatedAt {
				out.Applied = append(out.Applied, appliedEntry{ID: inc.ID, Status: "unchanged", Seq: stored.Seq})
				continue
			}
			out.Applied = append(out.Applied, appliedEntry{
				ID: inc.ID, Status: "diverged", Seq: stored.Seq,
				ServerVc: storedVc, ServerUpdatedAt: stored.UpdatedAt,
			})
			correctionIDs = append(correctionIDs, inc.ID)
			continue

		case "dominated":
			// 服务端的更新，客户端必须采纳。
			// 注意：这里不能只依赖 pull 的游标 —— 客户端的游标可能已经越过这条记录，
			// 那样它就永远拿不到纠正数据。所以显式放进 corrections。
			out.Applied = append(out.Applied, appliedEntry{
				ID: inc.ID, Status: "stale", Seq: stored.Seq,
				ServerVc: storedVc, ServerUpdatedAt: stored.UpdatedAt,
			})
			correctionIDs = append(correctionIDs, inc.ID)
			continue
		}

		// 到这里只剩两种情况：incoming 支配 stored（正常更新），或二者并发（真冲突）。
		// 统一策略：存 merge(旧, 新)，保证结果同时支配双方 —— 冲突只判定一次。
		mergedVc := vcMerge(storedVc, inc.Vc)

		if rel == "concurrent" {
			winner := vcResolveConflict(
				conflictSide{Vc: storedVc, UpdatedAt: stored.UpdatedAt},
				conflictSide{Vc: inc.Vc, UpdatedAt: inc.UpdatedAt},
			)
			keepLocal := winner == "local"
			finalKind := inc.Kind
			finalData := inc.DataJSON
			finalUpdatedAt := inc.UpdatedAt
			finalDeleted := int64(inc.Deleted)
			finalOrigin := deviceID
			if keepLocal {
				finalKind = stored.Kind
				finalData = stored.Data
				finalUpdatedAt = stored.UpdatedAt
				finalDeleted = stored.Deleted
				finalOrigin = stored.OriginDevice.String
			}
			finalBytes := len(finalData)

			seq, err := nextSeq(tx)
			if err != nil {
				return nil, internalErr(err)
			}
			if _, err := tx.Exec(
				`UPDATE records SET seq = ?, kind = ?, data = ?, vc = ?, updated_at = ?,
				        deleted = ?, byte_size = ?, origin_device = ? WHERE id = ?`,
				seq, finalKind, finalData, vcJSON(mergedVc), finalUpdatedAt,
				finalDeleted, finalBytes, nullStr(finalOrigin), inc.ID,
			); err != nil {
				return nil, internalErr(err)
			}

			loserVc := inc.Vc
			loserUpdatedAt := inc.UpdatedAt
			winnerName := "client"
			if keepLocal {
				loserVc = storedVc
				loserUpdatedAt = stored.UpdatedAt
				winnerName = "server"
			}
			if _, err := tx.Exec(
				`INSERT INTO conflicts (record_id, kind, at, winner, loser_vc, winner_vc, loser_updated_at, winner_updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				inc.ID, finalKind, t, winnerName, vcJSON(loserVc), vcJSON(mergedVc),
				loserUpdatedAt, finalUpdatedAt,
			); err != nil {
				return nil, internalErr(err)
			}

			status := "conflict:client-won"
			if keepLocal {
				status = "conflict:kept-server"
			}
			out.Applied = append(out.Applied, appliedEntry{ID: inc.ID, Status: status})
			out.Conflicts = append(out.Conflicts, conflictEntry{ID: inc.ID, Winner: winnerName})
			// 两种情况下客户端都需要纠正：输了一方要改用赢家数据；赢的一方也要
			// 把本地 vc 换成合并后的并集，否则下一次推送必然被判 stale（多一个来回）。
			correctionIDs = append(correctionIDs, inc.ID)
			continue
		}

		// rel === "dominates"：干净的新版本。merged === incoming，客户端本地已一致，无需纠正。
		seq, err := nextSeq(tx)
		if err != nil {
			return nil, internalErr(err)
		}
		if _, err := tx.Exec(
			`UPDATE records SET seq = ?, kind = ?, data = ?, vc = ?, updated_at = ?,
			        deleted = ?, byte_size = ?, origin_device = ? WHERE id = ?`,
			seq, inc.Kind, inc.DataJSON, vcJSON(mergedVc), inc.UpdatedAt,
			inc.Deleted, inc.Bytes, deviceID, inc.ID,
		); err != nil {
			return nil, internalErr(err)
		}
		out.Applied = append(out.Applied, appliedEntry{ID: inc.ID, Status: "updated"})
	}

	// 纠正数据在全部推送处理完后统一回捞，保证拿到的是最终版本
	for _, cid := range correctionIDs {
		r, err := selectRecord(tx, cid)
		if err != nil {
			return nil, internalErr(err)
		}
		if r != nil {
			out.Corrections = append(out.Corrections, toWire(r))
		}
	}
	return out, nil
}

// globalVector 服务端全局版本向量。
func globalVector(db *sql.DB) VC {
	rows, err := db.Query("SELECT device_id, counter FROM device_clocks")
	vc := VC{}
	if err != nil {
		return vc
	}
	defer rows.Close()
	for rows.Next() {
		var dev string
		var counter int64
		if rows.Scan(&dev, &counter) == nil && counter > 0 {
			vc[dev] = uint64(counter)
		}
	}
	return vc
}

// syncOnce 一次同步往返。cursor/limit 为解码后的原始数值语义（0 表示未提供）。
func syncOnce(db *sql.DB, deviceID string, cursor int64, push []json.RawMessage, limit int64, full bool) (map[string]any, *AppError) {
	batch := int64(Sync.MaxPullBatch)
	if limit > 0 && limit < batch {
		batch = limit
	}
	if batch < 1 {
		batch = 1
	}

	if len(push) > Sync.MaxPushBatch {
		return nil, E.TooLarge("单次最多推送 " + itoa(Sync.MaxPushBatch) + " 条记录，当前 " + itoa(len(push)) + " 条")
	}

	startedAt := now()
	applied := []appliedEntry{}
	conflicts := []conflictEntry{}
	corrections := []wireRecord{}

	if len(push) > 0 {
		tx, err := db.Begin()
		if err != nil {
			return nil, internalErr(err)
		}
		result, apiErr := applyPush(tx, deviceID, push)
		if apiErr != nil {
			tx.Rollback()
			return nil, apiErr
		}
		if err := tx.Commit(); err != nil {
			return nil, internalErr(err)
		}
		applied, conflicts, corrections = result.Applied, result.Conflicts, result.Corrections
	}

	// 墓碑水位：客户端落后到水位之前，增量已无法保证正确性。
	// 但 full 请求本身就是"我正在做全量重建"，此时不该再要求它重建一次。
	floorSeq := metaGetInt(db, META_KEYS.TombstoneFloorSeq, 0)
	effectiveCursor := cursor
	if effectiveCursor < 0 {
		effectiveCursor = 0
	}
	if full {
		effectiveCursor = 0
	}
	resyncRequired := !full && effectiveCursor < floorSeq

	rows, err := db.Query(
		"SELECT "+recordColumns+" FROM records WHERE seq > ? ORDER BY seq ASC LIMIT ?",
		effectiveCursor, batch+1)
	if err != nil {
		return nil, internalErr(err)
	}
	var fetched []*recordRow
	for rows.Next() {
		r := &recordRow{}
		var origin sql.NullString
		if err := rows.Scan(&r.RowID, &r.Seq, &r.ID, &r.Kind, &r.Data, &r.Vc, &r.UpdatedAt,
			&r.Deleted, &r.ByteSize, &origin, &r.CreatedAt); err != nil {
			rows.Close()
			return nil, internalErr(err)
		}
		r.OriginDevice = origin
		fetched = append(fetched, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, internalErr(err)
	}

	hasMore := int64(len(fetched)) > batch
	page := fetched
	if hasMore {
		page = fetched[:batch]
	}
	newCursor := effectiveCursor
	records := make([]wireRecord, 0, len(page))
	if len(page) > 0 {
		newCursor = page[len(page)-1].Seq
		for _, r := range page {
			records = append(records, toWire(r))
		}
	}

	t := now()
	db.Exec(
		`UPDATE devices SET last_seen_at = ?, push_count = push_count + ?, pull_count = pull_count + ? WHERE id = ?`,
		t, len(push), len(page), deviceID)

	liveCount := int64(0)
	db.QueryRow("SELECT COUNT(*) FROM records WHERE deleted = 0").Scan(&liveCount)

	// 与旧版字段顺序保持一致，方便对拍
	return map[string]any{
		"ok":                true,
		"cursor":            newCursor,
		"hasMore":           hasMore,
		"records":           records,
		"corrections":       corrections,
		"serverVector":      globalVector(db),
		"applied":           applied,
		"conflicts":         conflicts,
		"tombstoneFloorSeq": floorSeq,
		"liveCount":         liveCount,
		"resyncRequired":    resyncRequired,
		"tookMs":            t - startedAt,
	}, nil
}

// purgeTombstonesResult 清理墓碑的返回。
type purgeTombstonesResult struct {
	Purged   int64
	FloorSeq int64
}

// purgeTombstones 清理过期墓碑：不删硬数据，只把 deleted=1 且久未更新的行移除，
// 并抬高水位 —— 否则一台离线半年的手机会把已删除的任务重新推回来。
func purgeTombstones(db *sql.DB) (purgeTombstonesResult, error) {
	cutoff := now() - Sync.TombstoneTtlMs
	tx, err := db.Begin()
	if err != nil {
		return purgeTombstonesResult{}, err
	}
	defer tx.Rollback()

	var maxSeq int64
	if err := tx.QueryRow(
		"SELECT IFNULL(MAX(seq), 0) FROM records WHERE deleted = 1 AND updated_at < ?", cutoff,
	).Scan(&maxSeq); err != nil {
		return purgeTombstonesResult{}, err
	}
	if maxSeq == 0 {
		return purgeTombstonesResult{Purged: 0, FloorSeq: metaGetInt(tx, META_KEYS.TombstoneFloorSeq, 0)}, nil
	}
	info, err := tx.Exec("DELETE FROM records WHERE deleted = 1 AND updated_at < ?", cutoff)
	if err != nil {
		return purgeTombstonesResult{}, err
	}
	purged, _ := info.RowsAffected()
	floor := metaGetInt(tx, META_KEYS.TombstoneFloorSeq, 0)
	if maxSeq > floor {
		floor = maxSeq
	}
	if err := metaSetInt(tx, META_KEYS.TombstoneFloorSeq, floor); err != nil {
		return purgeTombstonesResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return purgeTombstonesResult{}, err
	}
	return purgeTombstonesResult{Purged: purged, FloorSeq: floor}, nil
}

// conflictInfo 近期冲突列表条目。
type conflictInfo struct {
	RecordID string `json:"recordId"`
	Kind     string `json:"kind"`
	At       int64  `json:"at"`
	Winner   string `json:"winner"`
	WinnerVc VC     `json:"winnerVc"`
	LoserVc  VC     `json:"loserVc"`
}

// listConflicts 近期冲突列表，供设置页展示"哪次同步发生了冲突"。
func listConflicts(db *sql.DB, limit int64) ([]conflictInfo, error) {
	if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := db.Query(
		"SELECT record_id, kind, at, winner, winner_vc, loser_vc FROM conflicts ORDER BY at DESC LIMIT ?", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []conflictInfo{}
	for rows.Next() {
		var c conflictInfo
		var winnerVc, loserVc string
		if err := rows.Scan(&c.RecordID, &c.Kind, &c.At, &c.Winner, &winnerVc, &loserVc); err != nil {
			return nil, err
		}
		c.WinnerVc = parseVc(winnerVc)
		c.LoserVc = parseVc(loserVc)
		out = append(out, c)
	}
	return out, rows.Err()
}

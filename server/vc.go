// 向量时钟（Vector Clock）—— Twische 多端同步的版本判定内核。
//
// 为什么不用时间戳：多台设备的墙钟永远对不齐，updatedAt 只适合裁决"同一时刻的
// 并发写"这种最后一步，不能用来判断因果关系。
//
// 时钟结构：{ [deviceId]: counter }，counter 是该设备本地单调递增的逻辑计数。
// 约定：缺失的设备键等价于 0。
package main

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
)

// VC 归一化后的向量时钟：所有分量均为正整数。
type VC map[string]uint64

// vcComponentInRange 判断一个已解析的数值是否是合法的时钟分量：正整数且不超过
// 协议上界。上界的必要性见 SyncConfig.MaxVcCounter 的说明 —— 超过 IEEE-754
// 整数精度上限的计数器会让客户端的 `+1` 失效，从而静默冻结该记录。
//
// 注意这里全部用 float64 比较，绝不把未校验的浮点值转成整数类型：
// float64 → uint64/int64 的越界转换在 Go 里属未定义行为，实测 1e300 会塌缩成
// 9223372036854775808，让两个不同的输入落库成同一个值，破坏幂等判据。
func vcComponentInRange(n float64) bool {
	return n >= 1 && n <= float64(Sync.MaxVcCounter) && n == math.Trunc(n)
}

// vcGet 读取某设备的分量，缺失即为 0。
func vcGet(vc VC, deviceID string) uint64 {
	if vc == nil {
		return 0
	}
	return vc[deviceID]
}

// vcNormalizeRaw 归一化原始解码输入：剔除 0 值与非法值，正数向下取整。
// raw 的值来自 JSON 解码（json.Number / float64 可用，其它类型非法）。
//
// 超出上界的值一律剔除，且剔除发生在浮点域内 —— 先比较再转换，
// 避免越界的 float64 转 uint64 产生未定义结果。
func vcNormalizeRaw(raw map[string]any) VC {
	out := VC{}
	for k, v := range raw {
		if k == "" || len(k) > 128 {
			continue
		}
		n, ok := numOf(v)
		if !ok || math.IsInf(n, 0) || math.IsNaN(n) {
			continue
		}
		if !vcComponentInRange(n) {
			continue
		}
		out[k] = uint64(n)
	}
	return out
}

// numOf 把 json.Number / float64 统一转成 float64；其它类型视为非法。
func numOf(v any) (float64, bool) {
	switch x := v.(type) {
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case float64:
		return x, true
	}
	return 0, false
}

// numOfI 把 json.Number / float64 转成整数语义的 float64（要求必须是整数）。
// 只做"是不是整数"的判断；是否落在协议允许的范围内由 vcComponentInRange 负责。
func numOfI(v any) (float64, bool) {
	f, ok := numOf(v)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	if f != math.Trunc(f) {
		return 0, false
	}
	return f, true
}

// vcMerge 归并两个时钟，逐设备取 max。
func vcMerge(a, b VC) VC {
	out := VC{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		if v > out[k] {
			out[k] = v
		}
	}
	return out
}

// vcCompare 偏序比较 —— 同步引擎的核心判定。
// 返回 "equal" | "dominates" | "dominated" | "concurrent"。
func vcCompare(a, b VC) string {
	aGreater, bGreater := false, false
	keys := map[string]bool{}
	for k := range a {
		keys[k] = true
	}
	for k := range b {
		keys[k] = true
	}
	for k := range keys {
		va, vb := vcGet(a, k), vcGet(b, k)
		if va > vb {
			aGreater = true
		} else if vb > va {
			bGreater = true
		}
		if aGreater && bGreater {
			return "concurrent"
		}
	}
	if !aGreater && !bGreater {
		return "equal"
	}
	if aGreater {
		return "dominates"
	}
	return "dominated"
}

// vcFingerprint 稳定字符串指纹：分量按键名排序。
// 用于并发冲突时的字典序决胜 —— 保证所有设备算出同一个赢家。
func vcFingerprint(vc VC) string {
	keys := make([]string, 0, len(vc))
	for k := range vc {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+":"+strconv.FormatUint(vc[k], 10))
	}
	return strings.Join(parts, "|")
}

// conflictSide 并发冲突双方：时钟 + 墙钟。
type conflictSide struct {
	Vc        VC
	UpdatedAt int64
}

// vcResolveConflict 并发冲突的确定性决胜：
// 先用墙钟（越新越优先），完全相等时退化为向量指纹字典序取大者。
// 返回 "local" 或 "remote"。
func vcResolveConflict(local, remote conflictSide) string {
	if local.UpdatedAt != remote.UpdatedAt {
		if local.UpdatedAt > remote.UpdatedAt {
			return "local"
		}
		return "remote"
	}
	lf, rf := vcFingerprint(local.Vc), vcFingerprint(remote.Vc)
	if lf == rf {
		return "local" // 内容指纹相同，取谁都一样
	}
	if lf > rf {
		return "local"
	}
	return "remote"
}

// vcSum 分量总和。
func vcSum(vc VC) uint64 {
	s := uint64(0)
	for _, v := range vc {
		s += v
	}
	return s
}

// vcJSON 紧凑序列化（encoding/json 对 map 按键名字典序输出）。
func vcJSON(vc VC) string {
	b, err := json.Marshal(vc)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// vcClampOversized 把库内历史 vc 中超界的成员夹到上界，返回新的 JSON 与是否改动。
//
// 用于开库消毒：v2 之前没有上界校验，1e19 这类分量可能已经落库。夹到上界而不是
// 删除，是为了让记录重新变得可写 —— 客户端以正常时钟的下一次写入即可重新支配它。
// 无法解析的输入原样返回（解析失败的 vc 由 parseVc 回退为空时钟，不在这里处理）。
func vcClampOversized(raw string) (string, bool) {
	if raw == "" {
		return raw, false
	}
	var m map[string]any
	if err := decodeWithNumber([]byte(raw), &m); err != nil {
		return raw, false
	}
	out := VC{}
	changed := false
	for k, v := range m {
		if k == "" || len(k) > 128 {
			changed = true
			continue
		}
		n, ok := numOf(v)
		if !ok || math.IsInf(n, 0) || math.IsNaN(n) || n < 1 {
			changed = true
			continue
		}
		if !vcComponentInRange(n) {
			// 超界或非整数：夹到上界并标记改动
			out[k] = Sync.MaxVcCounter
			changed = true
			continue
		}
		out[k] = uint64(n)
	}
	if !changed {
		return raw, false
	}
	if len(out) == 0 {
		// 全部成员都非法：留一个空对象，parseVc 会回退为空时钟
		return "{}", true
	}
	return vcJSON(out), true
}

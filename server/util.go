// 小工具：字符串与内部错误包装。
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"unicode/utf8"
)

func itoa(n int) string { return strconv.Itoa(n) }

func trimSpace(s string) string { return strings.TrimSpace(s) }

// truncateRunes 按 Unicode 码点截断（对齐 JS String.slice 的近似语义）。
func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	runes := []rune(s)
	return string(runes[:n])
}

// internalErr 未预期错误的统一出口：日志留全量，响应只给一句话。
func internalErr(err error) *AppError {
	fmt.Println("[twische] 未处理异常:", err)
	return &AppError{Code: "internal_error", Message: "服务器内部错误", Status: 500}
}

// urlParse 解析 Origin 头。
func urlParse(s string) (*url.URL, error) { return url.Parse(s) }

// cookieUnescape 对齐 JS decodeURIComponent（不把 + 当空格）。
func cookieUnescape(s string) string {
	if d, err := url.PathUnescape(s); err == nil {
		return d
	}
	return s
}

// jsonRaw 把库内 JSON 文本原样作为输出载荷。
func jsonRaw(s string) json.RawMessage {
	if strings.TrimSpace(s) == "" {
		return json.RawMessage("{}")
	}
	return json.RawMessage(s)
}

// marshalPretty 两空格缩进、不转义 HTML 的 JSON（对齐 JSON.stringify(_, null, 2)）。
func marshalPretty(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// signalNotify 跨平台注册退出信号。
func signalNotify(ch chan<- os.Signal) {
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
}

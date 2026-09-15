// 统一的错误类型。
//
// 原则：对外只暴露稳定的错误码 + 安全的中文提示，绝不把 SQL、堆栈或
// "用户不存在/密码错误"这类可枚举信息泄漏给客户端。细节进审计日志。
package main

import "fmt"

// AppError 业务错误：稳定 code + 用户可读 message + HTTP 状态码。
type AppError struct {
	Code    string
	Message string
	Status  int
	Extra   map[string]any
}

func (e *AppError) Error() string {
	return fmt.Sprintf("%s(%d): %s", e.Code, e.Status, e.Message)
}

// Body 响应体中除 ok 外的部分：{ code, message, ...extra }。
func (e *AppError) Body() map[string]any {
	out := map[string]any{"code": e.Code, "message": e.Message}
	for k, v := range e.Extra {
		out[k] = v
	}
	return out
}

// E 错误工厂，与旧版 errors.js 逐项对应。
var E = struct {
	NotInitialized    func() *AppError
	AlreadyInitialized func() *AppError
	Unauthorized      func() *AppError
	BadCredentials    func() *AppError
	Locked            func(retryAfterSec int) *AppError
	Throttled         func(retryAfterSec int) *AppError
	WeakPassword      func(problems []string) *AppError
	PasswordMismatch  func() *AppError
	PasswordRequired  func() *AppError
	BadRequest        func(message string) *AppError
	TooLarge          func(message string) *AppError
	Conflict          func(message string) *AppError
	NotFound          func(message string) *AppError
}{
	NotInitialized: func() *AppError {
		return &AppError{"not_initialized", "服务尚未初始化，请先在服务器上运行 twische init", 503, nil}
	},
	AlreadyInitialized: func() *AppError {
		return &AppError{"already_initialized", "该实例已完成初始化", 409, nil}
	},
	Unauthorized: func() *AppError {
		return &AppError{"unauthorized", "登录状态已失效，请重新登录", 401, nil}
	},
	BadCredentials: func() *AppError {
		return &AppError{"bad_credentials", "密码不正确", 401, nil}
	},
	Locked: func(retryAfterSec int) *AppError {
		return &AppError{"locked",
			fmt.Sprintf("尝试次数过多，请在 %d 秒后重试", retryAfterSec), 429,
			map[string]any{"retryAfterSec": retryAfterSec}}
	},
	Throttled: func(retryAfterSec int) *AppError {
		return &AppError{"too_many_requests",
			fmt.Sprintf("请求过于频繁，请在 %d 秒后重试", retryAfterSec), 429,
			map[string]any{"retryAfterSec": retryAfterSec}}
	},
	WeakPassword: func(problems []string) *AppError {
		return &AppError{"weak_password", "密码强度不足", 400, map[string]any{"problems": problems}}
	},
	PasswordMismatch: func() *AppError {
		return &AppError{"password_mismatch", "当前密码不正确", 403, nil}
	},
	// PasswordRequired 会话提权已过期。客户端据此弹出密码输入并重试，
	// 而不是把操作直接失败掉。
	PasswordRequired: func() *AppError {
		return &AppError{"password_required", "该操作需要重新输入密码确认", 403, nil}
	},
	BadRequest: func(message string) *AppError {
		if message == "" {
			message = "请求参数不合法"
		}
		return &AppError{"bad_request", message, 400, nil}
	},
	TooLarge: func(message string) *AppError {
		if message == "" {
			message = "请求体过大"
		}
		return &AppError{"payload_too_large", message, 413, nil}
	},
	Conflict: func(message string) *AppError {
		return &AppError{"conflict", message, 409, nil}
	},
	NotFound: func(message string) *AppError {
		if message == "" {
			message = "资源不存在"
		}
		return &AppError{"not_found", message, 404, nil}
	},
}

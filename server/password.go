// 密码哈希与强度评估。
//
// 硬性约束：
// - bcrypt 只取前 72 字节。对多字节中文密码来说，32 个汉字就超了。
//   若不显式拒绝，两个不同的长密码会哈希成同一个值 —— 静默的安全漏洞，
//   所以这里直接拒绝超长密码，而不是悄悄截断。
// - 校验一律走 bcrypt 自身，不手写比较。
// - 强度评估在服务端执行；客户端的即时提示只是体验优化，不作数。
//
// 兼容性：旧版 Node 服务端用 bcryptjs 生成 $2a$/$2b$ 哈希，
// golang.org/x/crypto/bcrypt 可直接校验，存量密码无需迁移。
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

// BcryptMaxBytes bcrypt 的算法上限，不可逾越。
const BcryptMaxBytes = 72

func byteLength(s string) int { return len(s) } // Go 字符串即 UTF-8 字节

func hashPassword(plain string, rounds int) string {
	if rounds <= 0 {
		rounds = Auth.BcryptRounds
	}
	b, err := bcrypt.GenerateFromPassword([]byte(plain), rounds)
	if err != nil {
		panic("twische: bcrypt hash 失败: " + err.Error())
	}
	return string(b)
}

// verifyPassword 校验密码；超长输入直接拒绝（与旧版行为一致）。
func verifyPassword(plain, hash string) bool {
	if hash == "" || byteLength(plain) > BcryptMaxBytes {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}

var reBcryptCost = regexp.MustCompile(`^\$2[aby]\$(\d{2})\$`)

// needsRehash 哈希是否需要按当前代价因子重算（登录时透明升级）。
func needsRehash(hash string) bool {
	m := reBcryptCost.FindStringSubmatch(hash)
	if m == nil {
		return true
	}
	var cost int
	fmt.Sscanf(m[1], "%d", &cost)
	return cost != Auth.BcryptRounds
}

var commonPasswords = map[string]bool{
	"password": true, "password1": true, "password123": true, "12345678": true,
	"123456789": true, "1234567890": true, "qwertyuiop": true, "qwerty123": true,
	"iloveyou": true, "admin123": true, "administrator": true, "letmein123": true,
	"twische": true, "twische123": true, "111111111": true, "000000000": true,
	"abc123456": true, "a12345678": true, "passw0rd": true, "welcome123": true,
	"changeme": true, "root1234": true, "test1234": true, "88888888": true,
}

var (
	rePureDigits = regexp.MustCompile(`^\d+$`)
	reSequence   = regexp.MustCompile(`^(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf)`)
	reNamed      = regexp.MustCompile(`(?i)twische|twilight|admin|root`)
)

type passwordAssessment struct {
	OK          bool
	Score       int
	Problems    []string
	Suggestions []string
}

// assessPassword 密码强度评估，与旧版 password.js 逐项对应。
func assessPassword(plain string) passwordAssessment {
	problems := []string{}
	suggestions := []string{}

	if plain == "" {
		problems = append(problems, "密码不能为空")
	}
	bytes := byteLength(plain)

	if bytes > BcryptMaxBytes {
		problems = append(problems,
			fmt.Sprintf("密码过长：bcrypt 只识别前 72 字节，当前为 %d 字节。中文密码请注意，一个汉字占 3 字节。", bytes))
	} else if bytes < Auth.MinPasswordLength {
		problems = append(problems,
			fmt.Sprintf("密码至少需要 %d 个字符（当前 %d 个）", Auth.MinPasswordLength, utf8.RuneCountInString(plain)))
	}

	if commonPasswords[strings.ToLower(plain)] {
		problems = append(problems, "该密码在常见弱密码列表中，极易被猜到")
	}
	// 单字符重复，如 aaaaaaaa
	if utf8.RuneCountInString(plain) >= 4 {
		first, same := rune(0), true
		for i, r := range plain {
			if i == 0 {
				first = r
			} else if r != first {
				same = false
				break
			}
		}
		if same {
			problems = append(problems, "密码不能是单一字符的重复")
		}
	}
	if rePureDigits.MatchString(plain) {
		suggestions = append(suggestions, "加入字母或符号会更安全")
	}
	if reSequence.MatchString(plain) {
		suggestions = append(suggestions, "避免使用键盘或数字的连续序列")
	}
	if reNamed.MatchString(plain) {
		suggestions = append(suggestions, "避免包含产品名或常见管理词")
	}

	var hasLower, hasUpper, hasDigit, hasSpecial bool
	score := 0
	for _, r := range plain {
		switch {
		case r >= 'a' && r <= 'z':
			hasLower = true
		case r >= 'A' && r <= 'Z':
			hasUpper = true
		case r >= '0' && r <= '9':
			hasDigit = true
		default:
			hasSpecial = true
		}
	}
	if bytes >= Auth.MinPasswordLength {
		score++
	}
	if bytes >= 12 {
		score++
	}
	if hasLower && hasUpper && hasDigit {
		score++
	}
	if hasSpecial {
		score++
	}
	if score > 3 {
		score = 3
	}
	if score < 0 {
		score = 0
	}

	return passwordAssessment{OK: len(problems) == 0, Score: score, Problems: problems, Suggestions: suggestions}
}

// generatePassword 生成高强度随机密码（`twische passwd --generate` 用）。
func generatePassword(length int) string {
	const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+"
	out := make([]byte, 0, length)
	buf := make([]byte, length*2)
	// rejection sampling 消除取模偏置
	limit := (256 / len(alphabet)) * len(alphabet)
	for len(out) < length {
		mustRandom(buf)
		for _, b := range buf {
			if int(b) >= limit {
				continue
			}
			out = append(out, alphabet[int(b)%len(alphabet)])
			if len(out) == length {
				break
			}
		}
	}
	return string(out)
}

func mustRandom(buf []byte) {
	if _, err := rand.Read(buf); err != nil {
		panic("twische: 随机数源不可用: " + err.Error())
	}
}

// safeEqualHex 恒定时间的字节比较。用于比较 sha256 摘要（长度天然一致）。
func safeEqualHex(a, b string) bool {
	ba, err1 := hex.DecodeString(a)
	bb, err2 := hex.DecodeString(b)
	if err1 != nil || err2 != nil || len(ba) == 0 || len(ba) != len(bb) {
		return false
	}
	return subtle.ConstantTimeCompare(ba, bb) == 1
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// randomToken URL 安全的高熵随机串（n 字节 → base64url）。
func randomToken(n int) string {
	b := make([]byte, n)
	mustRandom(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// randomUUID 生成 UUIDv4（instance_id 用）。
func randomUUID() string {
	b := make([]byte, 16)
	mustRandom(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return strings.Join([]string{h[0:8], h[8:12], h[12:16], h[16:20], h[20:32]}, "-")
}

// Twische —— 单用户自托管日程同步服务（Go 实现，接口与旧版完全一致）。
package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	argv := os.Args[1:]
	cmd := "help"
	if len(argv) > 0 {
		cmd = strings.ToLower(argv[0])
	}
	fl := cmdFlags{}
	if len(argv) > 1 {
		fl = parseFlags(argv[1:])
	}

	switch cmd {
	case "init":
		cmdInit(fl)
	case "serve", "start":
		cmdServe(fl)
	case "status":
		cmdStatus()
	case "passwd", "password":
		cmdPasswd(fl)
	case "devices":
		cmdDevices()
	case "reset":
		cmdReset(fl)
	case "export":
		cmdExport(fl)
	case "help", "--help", "-h":
		cmdHelp()
	case "version", "--version", "-v":
		fmt.Println(Version)
	default:
		failLine("未知命令「" + cmd + "」")
		infoLine("执行 " + cBold("twische help") + " 查看可用命令")
		os.Exit(2)
	}
}

package main

import (
	"embed"
	"io/fs"
)

// 前端产物内嵌。//go:embed 无法引用模块外目录，build.py 会在编译前把
// web/dist 同步到 server/webdist/。开发期该目录只有占位文件，
// NewApp 检测到没有 index.html 时回退到磁盘 web/dist。
//
//go:embed all:webdist
var embeddedDist embed.FS

// embeddedWebFS 返回内嵌前端的 FS；尚未填充真实产物时返回 nil。
func embeddedWebFS() fs.FS {
	sub, err := fs.Sub(embeddedDist, "webdist")
	if err != nil {
		return nil
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil
	}
	return sub
}

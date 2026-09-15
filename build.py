#!/usr/bin/env python3
"""
Twische 构建脚本：前端产物内嵌进 Go 二进制，交叉编译出单文件可执行程序。

产物内嵌原理：
  //go:embed 无法引用模块外目录，所以先把 web/dist 同步到 server/webdist/，
  再编译。运行时内嵌产物优先，磁盘 web/dist 仅作开发回退。

用法：
  python build.py                  # 完整构建（前端 + 全部目标）
  python build.py --skip-web       # 复用上一次的前端产物，只重编 Go
  python build.py --targets linux/amd64
  python build.py --clean          # 清理构建产物
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
WEB_DIST = WEB_DIR / "dist"
EMBED_DIR = ROOT / "server" / "webdist"
PLACEHOLDER = EMBED_DIR / ".placeholder"
RELEASE_DIR = ROOT / "release"

DEFAULT_TARGETS = ["windows/amd64", "linux/amd64"]

# 占位文件必须保留，否则 //go:embed 在空目录时编译失败
KEEP_FILES = {".placeholder"}


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    """执行命令，失败即终止并回显完整命令行。"""
    print(f"  $ {' '.join(cmd)}")
    proc = subprocess.run(cmd, cwd=kw.pop("cwd", ROOT), **kw)
    if proc.returncode != 0:
        sys.exit(f"构建失败：命令返回 {proc.returncode}：{' '.join(cmd)}")
    return proc


def npm_bin() -> str:
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not npm:
        sys.exit("构建失败：找不到 npm，请先安装 Node.js（>=20）")
    return npm


def build_web() -> None:
    """Vite 构建前端产物。"""
    print("==> 构建前端 (vite build)")
    run([npm_bin(), "run", "build"], cwd=WEB_DIR)
    if not (WEB_DIST / "index.html").exists():
        sys.exit(f"构建失败：{WEB_DIST / 'index.html'} 不存在")


def stamp_sw_version() -> None:
    """
    给 sw.js 的 VERSION 打上构建戳。

    sw.js 的 activate 钩子按 VERSION 前缀清理旧缓存 —— 版本号不变的话，
    新构建的产物会与旧缓存混在同一个 cache 里。用 git 短哈希（无 git
    时用时间戳）保证每次构建版本唯一，旧缓存一定被清掉。
    """
    sw = WEB_DIST / "sw.js"
    if not sw.exists():
        return
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT,
            capture_output=True, text=True,
        ).stdout.strip()
    except OSError:
        sha = ""
    if not re.fullmatch(r"[0-9a-f]{4,40}", sha or ""):
        sha = f"t{int(time.time())}"
    version = f"twische-{sha}"
    text = sw.read_text(encoding="utf-8")
    new_text, n = re.subn(
        r"const VERSION = '[^']*';",
        f"const VERSION = '{version}';",
        text,
    )
    if n != 1:
        print("  ! 未能定位 sw.js 的 VERSION 常量，跳过打戳（缓存清理依赖手工升版本）")
        return
    sw.write_text(new_text, encoding="utf-8")
    print(f"  sw.js VERSION -> {version}")


def sync_embed_dir() -> None:
    """web/dist -> server/webdist（保留占位文件）。"""
    print(f"==> 同步前端产物 {WEB_DIST.name}/ -> server/{EMBED_DIR.name}/")
    EMBED_DIR.mkdir(parents=True, exist_ok=True)
    for entry in EMBED_DIR.iterdir():
        if entry.name in KEEP_FILES:
            continue
        if entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()
    for entry in WEB_DIST.iterdir():
        if entry.name in KEEP_FILES:
            continue
        dest = EMBED_DIR / entry.name
        if entry.is_dir():
            shutil.copytree(entry, dest)
        else:
            shutil.copy2(entry, dest)


def go_build(targets: list[str]) -> None:
    """CGO_ENABLED=0 交叉编译（modernc.org/sqlite 纯 Go，无 CGO 依赖）。"""
    print("==> 交叉编译 Go 单文件")
    RELEASE_DIR.mkdir(exist_ok=True)
    rows = []
    try:
        for target in targets:
            goos, _, goarch = target.partition("/")
            if goos not in ("windows", "linux", "darwin") or goarch not in ("amd64", "arm64"):
                sys.exit(f"构建失败：不支持的目标 {target!r}（支持 windows/linux/darwin × amd64/arm64）")
            ext = ".exe" if goos == "windows" else ""
            out = RELEASE_DIR / f"twische-{goos}-{goarch}{ext}"
            env = dict(os.environ, CGO_ENABLED="0", GOOS=goos, GOARCH=goarch)
            run(
                ["go", "build", "-trimpath", "-ldflags", "-s -w", "-o", str(out), "."],
                cwd=ROOT / "server",
                env=env,
            )
            rows.append((out, target))
    finally:
        restore_embed_dir()

    print("\n==> 构建产物")
    for out, target in rows:
        size_mb = out.stat().st_size / 1024 / 1024
        digest = hashlib.sha256(out.read_bytes()).hexdigest()[:16]
        print(f"  {target:<16} {out.name:<28} {size_mb:6.1f} MB  sha256:{digest}…")
    print(f"\n产物目录：{RELEASE_DIR}")


def restore_embed_dir() -> None:
    """
    编译完成后把 server/webdist 还原为占位状态。

    二进制里已经烧进产物，源码树不留副本：开发模式的 go run 走磁盘
    web/dist（始终最新），git 也不会混入构建产物。
    """
    for entry in EMBED_DIR.iterdir():
        if entry.name in KEEP_FILES:
            continue
        if entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()


def clean() -> None:
    print("==> 清理构建产物")
    for d in (EMBED_DIR, RELEASE_DIR):
        if d.exists():
            for entry in d.iterdir():
                if entry.name in KEEP_FILES:
                    continue
                if entry.is_dir():
                    shutil.rmtree(entry)
                else:
                    entry.unlink()
            print(f"  已清理 {d}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Twische 单文件交叉编译")
    ap.add_argument("--skip-web", action="store_true", help="跳过前端构建，复用 web/dist")
    ap.add_argument("--targets", default=",".join(DEFAULT_TARGETS),
                    help="逗号分隔的 GOOS/GOARCH 列表（默认 windows/amd64,linux/amd64）")
    ap.add_argument("--clean", action="store_true", help="只清理构建产物")
    args = ap.parse_args()

    t0 = time.time()
    if args.clean:
        clean()
        return

    if not args.skip_web:
        build_web()
        stamp_sw_version()
    elif not (WEB_DIST / "index.html").exists():
        sys.exit("构建失败：--skip-web 但 web/dist/index.html 不存在，请先完整构建一次")
    sync_embed_dir()
    go_build([t.strip() for t in args.targets.split(",") if t.strip()])
    print(f"\n完成，用时 {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()

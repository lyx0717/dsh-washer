#!/bin/bash
# 启动悬浮窗。
#
# ELECTRON_RUN_AS_NODE 必须清掉：DSH 宿主自己也是 Electron，会给子进程继承这个变量，
# 一旦带进去 Electron 就退化成纯 Node，require('electron') 直接 MODULE_NOT_FOUND。
unset ELECTRON_RUN_AS_NODE
ELECTRON="${ELECTRON_PATH:-$HOME/.dsh/electron/Electron.app/Contents/MacOS/Electron}"
if [ ! -x "$ELECTRON" ]; then
  echo "找不到 Electron 运行时：$ELECTRON" >&2
  echo "用 ELECTRON_PATH 指定 Electron 可执行文件路径" >&2
  exit 1
fi
# 绝对路径 + 独立进程组：从 shell / 自动化脚本里拉起时，
# 相对路径会因工作目录不同而找不到 app 目录。
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$ELECTRON" "$APP_DIR"

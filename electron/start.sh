#!/bin/bash
# 启动悬浮窗。
#
# ELECTRON_RUN_AS_NODE 必须清掉：DSH 宿主自己也是 Electron，会给子进程继承这个变量，
# 一旦带进去 Electron 就退化成纯 Node，require('electron') 直接 MODULE_NOT_FOUND。
unset ELECTRON_RUN_AS_NODE
unset ELECTRON_NO_ATTACH_CONSOLE

# 按平台找运行时，和 index.js 的 electronBinaryCandidates() 保持一致。
# 写死 macOS 路径曾经让 Windows 用户装完插件什么都不发生。
case "$(uname -s)" in
  Darwin)
    CANDIDATES="$HOME/.dsh/electron/Electron.app/Contents/MacOS/Electron" ;;
  MINGW*|MSYS*|CYGWIN*)
    CANDIDATES="$HOME/.dsh/electron/electron.exe $HOME/.dsh/electron/Electron/electron.exe $HOME/.dsh/electron/electron/electron.exe" ;;
  *)
    CANDIDATES="$HOME/.dsh/electron/electron $HOME/.dsh/electron/Electron/electron" ;;
esac

ELECTRON="${ELECTRON_PATH:-}"
if [ -z "$ELECTRON" ]; then
  for c in $CANDIDATES; do
    if [ -x "$c" ]; then ELECTRON="$c"; break; fi
  done
fi
if [ -z "$ELECTRON" ] || [ ! -x "$ELECTRON" ]; then
  echo "找不到 Electron 运行时。试过：" >&2
  for c in $CANDIDATES; do echo "  $c" >&2; done
  echo "用 ELECTRON_PATH（或 DSH_WASHER_ELECTRON）指定 Electron 可执行文件路径" >&2
  exit 1
fi
# 绝对路径 + 独立进程组：从 shell / 自动化脚本里拉起时，
# 相对路径会因工作目录不同而找不到 app 目录。
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$ELECTRON" "$APP_DIR"

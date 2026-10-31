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

# 最低版本校验：与 index.js 的 MIN_ELECTRON_MAJOR 保持一致。
# 只在自动发现（未用 ELECTRON_PATH 覆盖）、且运行时目录带 version 文件时做——
# 自编译/其他来源的 Electron 没有 version 文件，放行别拦。
if [ -z "${ELECTRON_PATH:-}" ]; then
  MIN_MAJOR=43
  for vf in "$(dirname "$ELECTRON")/version" "$HOME/.dsh/electron/version"; do
    if [ -f "$vf" ]; then
      VER="$(cat "$vf" 2>/dev/null)"
      MAJOR="${VER%%.*}"
      case "$MAJOR" in
        ''|*[!0-9]*) : ;;  # 读不出主版本号，跳过校验
        *)
          if [ "$MAJOR" -lt "$MIN_MAJOR" ]; then
            echo "Electron 运行时版本过旧：${VER}（${vf}），至少需要 ${MIN_MAJOR}。" >&2
            echo "请升级 ~/.dsh/electron（DSH 自带的 Electron 运行时），或更新 DSH。" >&2
            exit 1
          fi
          ;;
      esac
      break
    fi
  done
fi
# 绝对路径 + 独立进程组：从 shell / 自动化脚本里拉起时，
# 相对路径会因工作目录不同而找不到 app 目录。
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$ELECTRON" "$APP_DIR"

@echo off
rem ============================================================
rem dsh-washer · 悬浮窗启动脚本（Windows）
rem
rem 对应 electron/start.sh 的 Windows 版本。宿主通常会直接 spawn
rem electron.exe，这个脚本只在"手动起一个浮窗"（调试、排查）时用。
rem
rem 两个历史坑照抄过来：
rem   1. ELECTRON_RUN_AS_NODE 必须清掉。DSH 宿主自己也是 Electron，
rem      会给子进程继承这个变量；一旦带进去 Electron 就退化成纯 Node，
rem      require('electron') 直接 MODULE_NOT_FOUND、进程秒退。
rem   2. 同样清 ELECTRON_NO_ATTACH_CONSOLE（旧版变量名，防同样的退化）。
rem ============================================================
setlocal enableextensions

set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

rem 运行时查找顺序和 index.js 的 electronBinaryCandidates() 保持一致：
rem 显式覆盖 → ~/.dsh/washer-runtime（DSH 下载/用户放置）→ ~/.dsh/electron
set "ELECTRON=%ELECTRON_PATH%"
if not defined ELECTRON set "ELECTRON=%DSH_WASHER_ELECTRON%"
if defined ELECTRON goto have_electron

for %%C in (
  "%USERPROFILE%\.dsh\washer-runtime\electron.exe"
  "%USERPROFILE%\.dsh\electron\electron.exe"
  "%USERPROFILE%\.dsh\electron\Electron\electron.exe"
  "%USERPROFILE%\.dsh\electron\electron\electron.exe"
) do (
  if exist "%%~C" if not defined ELECTRON set "ELECTRON=%%~C"
)

:have_electron
if not defined ELECTRON goto missing
if not exist "%ELECTRON%" goto missing

rem 最低版本校验：和 index.js 的 MIN_ELECTRON_MAJOR 一致。
rem 只在自动发现（未用 ELECTRON_PATH 覆盖）且运行时目录带 version 文件时做，
rem 自编译/其他来源的 Electron 没有 version 文件，放行别拦。
if defined ELECTRON_PATH goto run
if defined DSH_WASHER_ELECTRON goto run

set "MIN_MAJOR=43"
for %%D in ("%ELECTRON%\..") do set "ELECTRON_DIR=%%~fD"
if exist "%ELECTRON_DIR%\version" (
  set "VER="
  set /p VER=<"%ELECTRON_DIR%\version"
  if defined VER (
    for /f "tokens=1 delims=." %%V in ("%VER%") do set "MAJOR=%%V"
    if defined MAJOR (
      set /a "MAJOR_NUM=MAJOR" 2>nul
      if not errorlevel 1 (
        if %MAJOR_NUM% LSS %MIN_MAJOR% (
          echo Electron 运行时版本过旧：%VER%（%ELECTRON_DIR%\version^），至少需要 %MIN_MAJOR%。 1>&2
          echo 请升级 ~/.dsh/washer-runtime，或设置 DSH_WASHER_ELECTRON 指向新版 electron.exe。 1>&2
          exit /b 1
        )
      )
    )
  )
)

:run
rem 绝对路径 + 独立的 app 目录：从别的目录调用时相对路径会找不到 float.html
"%ELECTRON%" "%APP_DIR%"
exit /b %errorlevel%

:missing
echo 找不到 Electron 运行时。试过： 1>&2
echo   %USERPROFILE%\.dsh\washer-runtime\electron.exe 1>&2
echo   %USERPROFILE%\.dsh\electron\electron.exe 1>&2
echo 用 ELECTRON_PATH（或 DSH_WASHER_ELECTRON）指定 electron.exe 的路径 1>&2
exit /b 1
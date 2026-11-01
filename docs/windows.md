# Windows 悬浮窗

0.10.0 起悬浮窗支持 Windows。本文是**平台事实、运行时来源、行为差异与调试手册**；
设计动机与分阶段计划见仓库外的开发方案，实现细节以 `electron/main.cjs`、`electron/win32.cjs` 为准。

## 平台矩阵

| 平台 | 悬浮窗 | 依据 |
|---|---|---|
| macOS | ✅ | 透明置顶、跨 Space、点击穿透、右键菜单、`afplay`、`osascript` 兜底 |
| Windows | ✅ 0.10.0+ | 透明置顶、点击穿透、右键菜单、托盘、WebAudio 音效、原生 toast |
| Linux | ❌ | `overlayPlatformSupported()` 不认；`overlayReason: 'platform'`，设置页整节隐藏 |

dock（宿主渲染进程里的那块）**全平台**，与本文无关。悬浮窗是独立 Electron 进程，
必须有本机 Electron 运行时——这是与 macOS 最大的结构差异：macOS 上这个运行时由用户
自行安装到 `~/.dsh/electron/`，Windows 上多了一条自动下载的路。

## 运行时

查找顺序（第一个能用的胜出）：

| 平台 | 顺序 |
|---|---|
| macOS | `DSH_WASHER_ELECTRON` → `~/.dsh/electron/Electron.app/Contents/MacOS/Electron` |
| Windows | `DSH_WASHER_ELECTRON` → `%USERPROFILE%\.dsh\washer-runtime\electron.exe` |

两个平台都要求运行时目录根部有 `version` 文件（Electron 发行包自带，内容形如 `43.8.6`），
主版本低于 `MIN_ELECTRON_MAJOR = 43` 视为不可用（`overlayReason: 'old'`）。

### 自动下载（Windows）

设置页在 `overlayReason === 'missing'` 且平台为 Windows 时显示「下载运行时（约 110 MB）」。
点击后：客户端 `POST /dsh-washer/electron/install` → 宿主：

1. 从 `https://npmmirror.com/mirrors/electron/<version>/electron-v<version>-win32-<arch>.zip` 流式下载；
   `arch` 为 `arm64` 或 `x64`；版本缺省 `43.8.6`
2. 先试 `tar.exe -xf`（Windows 10 1803 起自带 bsdtar），失败退 PowerShell `Expand-Archive`
3. 校验解压目录根部有 `electron.exe`，缺 `version` 就补写
4. 原子替换 `%USERPROFILE%\.dsh\washer-runtime`（旧目录先 rename 走，换失败放回）
5. 同一时刻只允许一个下载（进程内锁），结束后清理临时目录

可覆盖：

```bat
set DSH_WASHER_ELECTRON_MIRROR=https://your-mirror/electron
set DSH_WASHER_ELECTRON_VERSION=43.8.6
```

手动安装等价：把 `electron-v43.8.6-win32-x64.zip` 解压到 `%USERPROFILE%\.dsh\washer-runtime`，
要求根部同时有 `electron.exe` 与 `version`，不要多套一层版本目录。

## 启动

正常情况下不用管：宿主按 `desktopOverlayAutoLaunch` 自动 `spawn`。

手动调试：

```bat
electron\start.cmd
set ELECTRON_PATH=C:\path\to\electron.exe && electron\start.cmd
```

`start.cmd` 与 `start.sh` 等价：清掉 `ELECTRON_RUN_AS_NODE` / `NO_ATTACH_CONSOLE`，按顺序找运行时，
校验 `version` 主版本 ≥ 43，最后 `"%ELECTRON%" "%APP_DIR%"`。

> **必须清 `ELECTRON_RUN_AS_NODE`**：Electron 只判断这个变量**存不存在**，不看的它的值。
> 从 DSH 终端启动时它一定被继承，设成空串也没用——进程会退化成纯 Node，`require('electron')`
> 直接 `MODULE_NOT_FOUND`，100ms 退出。宿主 `spawnOverlay` 里是 `delete`，不是设空串。

## 行为差异（相对 macOS）

| 行为 | macOS | Windows |
|---|---|---|
| 关闭窗口 | 隐藏，Dock 图标还在 | 隐藏，**托盘**可恢复 / 退出 |
| 不进 Alt+Tab | 天然（Accessory 应用） | `type: 'toolbar'` → `WS_EX_TOOLWINDOW`；`skipTaskbar` 不够 |
| 全 Space 可见 | `setVisibleOnAllWorkspaces(true)` | 跳过（API 无意义）；全屏应用前需额外层级，见下 |
| 音效 | `afplay /System/Library/Sounds/*.aiff` | 页面 WebAudio 合成，IPC `washer:play-sound` |
| 通知 | Electron toast，失败退 `osascript` | Electron toast（AUMID `com.dsh.washer.float`），无第二通道 |
| 打开 Harness 客户端 | `open -a "DeepSeek Harness"` | `spawn(process.env.DSH_WASHER_HOST_EXE)` |
| 恢复穿透快捷键 | ⌥⌘W | Ctrl+Alt+W（真实加速键 `Alt+CommandOrControl+W`；托盘也有勾选项） |
| 托盘 | 无 | 有：显示/隐藏、查看详情、鼠标穿透、打开客户端、退出 |

### 已知限制

- **全屏应用之上**：Windows 没有跨 Space 语义。浮窗用普通 topmost 层级，独占全屏的游戏/播放器
  仍可能盖住它。接受，不打算引入 `WS_EX_NOACTIVATE` 之外的层级 hack。
- **多屏 / 150% DPI 未实测**：开发机是 2560×1440 @125% 单屏；代码用 DIP 坐标（`screen.getAllDisplays`、
  `clampToVisible`），理论上跨屏正确，但没在拔插屏与 150% 下验证过。
- **任务栏自动隐藏**：不处理（与 macOS 无关项）。
- **通知权限**：Windows 10 上 Electron toast 走系统通知中心，未在"关闭通知"的系统状态下实测。

## 调试

- 起窗加 `--remote-debugging-port=9222`，页面可 CDP 查（`tools/cdp-eval.mjs` 是个最小示例：
  Node 24 自带 `fetch`/`WebSocket`，无依赖）。
- 主进程用 `--inspect=9230`；注意 inspector 的求值上下文里没有 `require`，不能直接调 Electron API，
  窗口行为要用 Win32 外部探针（`EnumWindows` + `GetWindowLong` 看 `ExStyle`、`IsWindowVisible`、
  `WindowFromPoint`）或离屏 `capturePage()`。
- 查 `WS_EX_TOOLWINDOW`：`ExStyle & 0x80`；查置顶：`ExStyle & 0x8`。
- 查穿透：`ExStyle & 0x20`（`WS_EX_TRANSPARENT`），`WindowFromPoint(窗口中心)` 应返回下层窗口。
- 截图别用 DPI-unaware 的 `CopyFromScreen`：125% 缩放下窗口坐标会被虚拟化成 `物理/1.25`。
  要么先 `SetProcessDPIAware()`，要么直接看 `capturePage()`。

## 验证记录

本机（Windows 10 22H2，Electron 43.8.6，125% 单屏）实测：

- [x] 页面渲染 + preload 桥：`window.washerHost` 存在，132×240 CSS 尺寸、`dpr=1.25`，状态条正常
- [x] 透明 + 置顶：叠在 DSH 主窗之上（z 序与 topmost 双确认）
- [x] 点击穿透：`WS_EX_TRANSPARENT | WS_EX_LAYERED`，`WindowFromPoint` 落到下层
- [x] 不进 Alt+Tab：`WS_EX_TOOLWINDOW`
- [x] 单实例：二次启动立即退出，原窗口重新显示
- [x] 关闭 = 隐藏：`WM_CLOSE` 后 `IsWindowVisible = false`，进程存活
- [x] 托盘：图标注册成功、菜单可点、可恢复窗口
- [x] 吸附：拖动结束 `snapToEdges` 生效（`SNAP_DISTANCE = 24`）
- [x] 音效：失焦状态 `notify('done')` → WebAudio 合成 3 音；前台静音生效
- [x] 通知：`Notification.isSupported() = true`，系统通知中心出现条目
- [ ] 多屏 / 150% / 拔屏（无硬件）
- [ ] 全屏应用之上

自动化：`npm test` = 144 项 `node --test` + 83 项 render 断言，全绿（Windows 本机）。
CI 见 `.github/workflows/test.yml`。

## 迁移注意

- 从 0.9.x 升级：设置页新增悬浮窗开关（Windows 上此前整节隐藏），无需迁移操作；
  偏好文件 `~/.dsh/dsh-washer-float-prefs.json` 字段未变。
- 运行时不是 npm 依赖，升级插件不会自动下载——首次开启悬浮窗时按设置页提示下载即可。
- 卸载插件不会删 `%USERPROFILE%\.dsh\washer-runtime`（约 250 MB），需要时手动删。
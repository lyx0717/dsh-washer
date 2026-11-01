# Windows 悬浮窗 spike（P0 验证记录）

日期：2025-11-01　环境：Windows 10 22H2 (19045)，2560×1440 物理屏 / 125% 缩放（DIP 2048×1152，workArea 2048×1112）
运行时：Electron **43.8.6**（官方 win32-x64 包，放在 `~/.dsh/washer-runtime/`，未进仓库）
被测代码：HEAD 0facb0d + `feat/windows-overlay` 分支上的最小改动（index.js 放行 win32 / 运行时候选 / 版本探测根 / `DSH_WASHER_HOST_EXE`）

## 目的与结论

用最小改动确认 B 类（平台相关但可能直接可用）假设。**结论：Windows 上 Electron 浮窗可行**，
页面渲染、透明、置顶、穿透、吸附、DPI、单实例、与宿主实时联调全部实测通过；
真正需要补的是系统集成层（音效 / 通知 / 打开宿主 / Finder 定位 / 托盘 / 关闭语义）。

## 验证项与结果

| # | 假设 | 结果 | 证据 |
|---|------|------|------|
| 1 | 能起窗并渲染完整洗衣机 | ✅ | `electron.exe electron/ --remote-debugging-port=9222` 起窗；CDP 读到 `document.title=dsh-washer`、`typeof window.washerHost === 'object'`、`readyState=complete`、`innerWidth=135 innerHeight=240 dpr=1.25`，截图有圆形舱、气泡、状态条 |
| 2 | 透明置顶盖在其他窗口上 | ✅ | 窗口 `ex` 含 `WS_EX_TOPMOST`，z 序在 DSH 主窗之上；DPI-aware 整屏截图可见浮窗压在 DSH 的 Markdown 预览工具栏上 |
| 3 | 透明区点击穿透 | ✅ | 主进程调 `setIgnoreMouseEvents(true,{forward:true})` 后窗口 `ex=0x80028`（`WS_EX_TRANSPARENT\|WS_EX_LAYERED`）；`WindowFromPoint` 在浮窗中心返回下层 DSH 窗口（pid 21304）→ 点击落到宿主 |
| 4 | 边缘吸附 | ✅ | Windows 上 `moved` 在**拖动结束时只触发一次**（记录到 `["25,400"]`），无拖动中抖动；`setPosition(10,400)` 后触发 `moved` → 吸附到 `x=0`（SNAP_DISTANCE=24 生效） |
| 5 | 125% DPI 下尺寸/位置正确 | ✅ | 135×240 DIP ↔ 169×300 物理，`defaultPosition()` 落在 workArea 右上角，坐标无偏移 |
| 6 | 单实例 | ✅ | 再起一个 `electron.exe` 进程 4s 内退出，exit code 0 |
| 7 | 与真实宿主联调 | ✅ | 页面经端点文件连上正在运行的 DSH 宿主，读到实时状态（漂洗中 / 8:48 / 「咕噜咕噜…转不动了」气泡） |
| 8 | `skipTaskbar` 能藏住 Alt+Tab | ❌ 需处理 | `skipTaskbar: true` **不会**设置 `WS_EX_TOOLWINDOW`（ex 仅 0x8），Windows 上仍会出现在 Alt+Tab；改用 `type: 'toolbar'`（实测 ex 含 `WS_EX_TOOLWINDOW`，且与 `transparent:true, frame:false` 共存、页面正常渲染） |
| 9 | 多屏 / 150% / 拔屏 | ⚠️ 本机不可测 | 单显示器、125% 缩放；代码路径（`getDisplayMatching`、`clampToVisible`、`display-removed`）与 macOS 完全同源，留待真机矩阵 |
| 10 | 关闭语义 | ⏳ P2 | 当前 `close` 直接销毁；Windows 无 Dock、无菜单栏常驻入口 → 必须 `close → hide` + 托盘退出（D7） |

## 运行方式（spike 期）

```powershell
$env:ELECTRON_RUN_AS_NODE = $null   # 必须清掉，否则 electron.exe 退化成纯 Node 立即退出
& "$env:USERPROFILE\.dsh\washer-runtime\electron.exe" "C:\Users\Administrator\Desktop\洗衣机\dsh-washer\electron"
```

调试辅助（临时脚本，不属于仓库）：`tools/cdp-probe.mjs`（渲染进程 CDP）、`tools/cdp-main.mjs`（主进程 `--inspect`）。

## 对方案的影响

- D7 必须提前到 P1/P2：没有托盘时 `skipTaskbar` + 隐藏窗口 = 用户无法找回窗口。
- 窗口构造在 win32 上加 `type: 'toolbar'`（等价 macOS 的 `skipTaskbar` + 不占 Alt+Tab）。
- `setVisibleOnAllWorkspaces` 在 win32 上无意义，需平台判定后跳过（避免未知行为）。
- 音效 / 通知 / 打开宿主 / 定位会话这四件事走 `electron/win32.cjs`，macOS 分支逐字不动。
# 更新日志

本项目的版本语义：`0.x` 期间每个 minor 都可能有破坏性配置变化，patch 只做修复。
发布到插件市场的是固定 commit，所以线上版本可复现。

## 0.10.0

**新增：Windows 悬浮窗**
- 悬浮窗从 macOS 专属扩展到 Windows：`overlayPlatformSupported()` 认 `darwin` 与 `win32` 两个平台
- 运行时发现：`DSH_WASHER_ELECTRON` → `%USERPROFILE%\.dsh\washer-runtime\electron.exe`（要求同目录 `version` 主版本 ≥ 43）
- 设置页缺少运行时时显示「下载运行时（约 110 MB）」按钮，走宿主新增的 `POST /dsh-washer/electron/install`：
  从 npmmirror 镜像拉 `electron-v43.8.6-win32-x64.zip`，`tar.exe` 解压（失败退 PowerShell `Expand-Archive`），
  校验 `electron.exe` + `version` 后原子替换受管目录；镜像/版本可用
  `DSH_WASHER_ELECTRON_MIRROR` / `DSH_WASHER_ELECTRON_VERSION` 覆盖
- Windows 窗口用 `type: 'toolbar'`（`WS_EX_TOOLWINDOW`，不进 Alt+Tab / 任务栏）；关闭 = 隐藏，托盘可恢复与退出
- 托盘菜单新增「鼠标穿透」勾选；穿透恢复快捷键文案按平台显示（Windows `Ctrl+Alt+W` / macOS `⌥⌘W`，
  真实加速键仍是 `Alt+CommandOrControl+W`）
- 音效：Windows 由浮窗页面 WebAudio 合成（IPC `washer:play-sound`），macOS 继续 `afplay`
- 通知：Windows 走 Electron 原生 toast（AUMID `com.dsh.washer.float`），不设 osascript 第二通道
- 新增 `electron/win32.cjs`、`electron/start.cmd`、`electron/tray.png`（图标由 `tools/gen-tray-icon.mjs` 生成）

**兼容性**
- macOS 行为零变化：透明置顶、跨 Space、afplay、osascript 兜底、⌥⌘W 全部保留；
  `setVisibleOnAllWorkspaces` 只在非 Windows 调用
- Linux 仍不支持悬浮窗（`overlayReason: 'platform'`，设置页整节隐藏）
- `sound` 能力从「仅 macOS」改为「macOS 或 Windows」；`overlayReason: 'missing'` 在 Windows 上表示缺运行时，
  可通过下载按钮修复，不再只提示"找不到 Electron"
- `spawnOverlay` 额外注入 `DSH_WASHER_HOST_EXE`（宿主可执行文件），Windows 上「打开 Harness 客户端」用它拉起

**测试 / CI**
- host / render 测试按平台分层：Windows 断言缺运行时下载入口、运行时候选路径、安装路由、音效链路；
  macOS 断言保持原样
- 新增断言：安装路由仅 win32 注册、`spawnOverlay` 清掉 `ELECTRON_RUN_AS_NODE` 后注入宿主路径、
  Windows 音效链路（main IPC → preload `onPlaySound` → 页面 `playChime`）
- 新增 `.github/workflows/test.yml`：ubuntu / macos / windows 三平台矩阵跑 `npm run build && npm test`

**修复**
- 设置页悬浮窗开关拨了没反应：偏好文件被 PowerShell 5.1 `Set-Content -Encoding UTF8`（或记事本另存）
  写入 UTF-8 BOM 后，宿主 `readPrefsFile` 的 `JSON.parse` 直接抛错，整份偏好被判成"读不出来"——
  `GET /dsh-washer/prefs` 只剩 `{}`、`POST` 回 400。现在宿主与浮窗两侧解析前都会剥掉 BOM
- 客户端写入偏好失败不再完全静默：`console.warn` 出一条 `[dsh-washer] 悬浮窗偏好写入失败：HTTP xxx`，
  并重新拉取宿主偏好把 UI 拉回真相

## 0.9.1

- 文档同步：README 更新四套皮肤表、皮肤清单、液态玻璃通知气泡、右键「皮肤」菜单与 `desktopOverlayDnd`
- 新增本 CHANGELOG，README 增加「版本记录」段
- 插件市场介绍与关键词更新（四套皮肤 / 详情面板 / 皮肤切换）
- 无代码行为变化

## 0.9.0

**新增皮肤**
- 复古奶油（`cream`）、工笔重彩（`gongbi`）、太空舱（`capsule`）三套皮肤，与精密家电并列；
  设置页「外观」与悬浮窗右键菜单「皮肤」都能切换，立即生效
- 每套皮肤有自己的机身材质与黑条风格，但「状态 / 计数 / 计时」三段结构一致
- 像素皮肤代码仍在注册表里，只是不再暴露入口

**代码结构**
- 新增 `src/skins.json` 作为皮肤清单唯一事实源：尺寸、CSS、机身实现、中英文名都在这里；
  `build.mjs`、`build-float.mjs`、`electron/main.cjs`、设置页与测试全部从它派生
- 新增皮肤从「改 10 处」降到「3 步」：清单加一条 → 新建 `<name>.css` + `<name>.body.js` → 补两行文案
- 精密家电 / 复古奶油的机身实现单源化（`src/skin-*.body.js`），React 与浮窗不再各写一套

**修复**
- 精密家电衣物类名无效（`.clothes-c` 没有样式）：统一为 `.clothes i`，件数跟随运行会话数
- 精密家电待机 / 运行没有气泡：调整气泡门控与可见度
- 切换皮肤后浮窗要等下一次状态变化才重绘：现在立即重建

**移除**
- 彩蛋的金牌与失败徽章（右上角奖牌、左上角感叹号）及相关连击统计

## 0.8.0

- 悬浮窗 UI 改版：文字全部收进机身内嵌黑条（状态 ｜ 待/动/错计数 ｜ 耗时）
- 滚筒里的彩色衣物 = 正在运行的会话数，最多 6 件，启动逐件淡入、洗完清空
- 四档尺寸：紧凑 0.8 / 标准 1.0 / 大 1.2 + 极简
- 通知气泡改为液态玻璃质感、从机顶向上冒出；窗口顶部留透明气泡通道（不参与拖拽）
- 宿主端实现 `draining`（上下文压缩时显示「排水换水中」）

## 0.7.4 及更早

见 `git log --oneline`。

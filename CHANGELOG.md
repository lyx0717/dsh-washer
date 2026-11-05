# 更新日志

本项目的版本语义：`0.x` 期间每个 minor 都可能有破坏性配置变化，patch 只做修复。
发布到插件市场的是固定 commit，所以线上版本可复现。

## 0.10.5

**省电：不洗东西的时候真的不动了**
- 静止即停：只有真正闲下来（`idle` / `off`，且没有别的会话在跑）才挂起皮肤动画；
  切换后留 1.2s 宽限窗口让一次性动画播完，指针进窗临时放开
- 忙态限帧：浮窗、停靠条、覆盖层都不再按屏幕刷新率出帧，改成 30fps 手动驱动
  CSS 动画。隔离页实测：浮窗洗涤中 GPU 38% → 20%、渲染 16% → 7%；
  停靠条忙态 GPU 两成多 → 约 13%。
- 停靠条补上「静止即停」：待机时水位波、气泡、指示灯呼吸不再一直播，
  宿主聊天页因此不必按刷新率出帧（隔离页实测 GPU 21% → 0.1%）。
- 停靠条的精密家电右侧被裁掉一截：`zoom` 放大之前机身是 content-box，
  300 + 30 内边距再 ×1.1 = 363，超出 330 的缩放框被 `overflow:hidden` 切掉。
  补上 `.dw-pw,.dw-pw * { box-sizing: border-box }`，与另外三套皮肤一致。
- 关掉浮窗再打开会变回「太空舱 + 极简」：拉窗前重新读偏好文件。
  之前用的是插件 init 时种下的 `cfg` 快照，用户后来在设置页改的尺寸/造型被忽略
- 静止即停别误伤在跑的任务：跟随的会话洗完后，别的会话还在跑时画面继续动——
  滚筒 7 秒一圈慢转、机器 0.6px 轻微起伏（`data-shake="3"`）；
  `waiting` / `error` / `done` 也保留各自的闪动信号（等你确认的闪、故障红灯、收尾星星）
- 修 `data-hidden` 暂停选择器：原来只暂停了容器，皮肤内部的 `::before` / `::after`
  动画照跑（`animation-play-state` 不从容器继承），窗口被遮住时仍在烧 CPU；
  现在落到 `*::before` / `*::after`
- 打盹不再给整机叠 `filter: saturate(.5) brightness(.85)`，只降透明度：
  整机滤镜压在持续动画上等于每帧多做一次离屏合成，越打盹越费
- 重绘型关键帧改合成型：呼吸灯 / 闪烁动 `opacity`（原是 `box-shadow`）、水面动
  `translateX`（原是 `background-position`）、扫光动 `transform`（原是 `left`）、
  拖影去掉 `filter: blur` 与 `drop-shadow`
- 忙态去滤镜：玻璃高光、接地阴影 `filter: blur` → 渐变台阶；衣物调色滤镜删除。
  滤镜挂在持续动画的整机上，每帧离屏重算，是忙态最大的一笔。状态光晕与缩放框投影
  都保留 `drop-shadow`——换 `box-shadow` 会贴元素矩形框而不是机身剪影画，
  四个圆角外、右下空处会多出一圈方形光/影（0.10.5 试过，当天报「一圈白边」退回）
- 精密家电比其他皮肤小一圈：机身按比例放大到 330（`.dw-pw` 加 `zoom:1.1`），
  不再缩在外框左上角；原来露出的一截缩放框投影（右侧、右下的「边款」）随之消失
- 实测（132×238 透明置顶窗、探针页面）：静止待机 GPU 38% → 1.7%、渲染 16% → 0.4%；
  洗涤中 GPU 41% → 21%、渲染 17% → 7.5%
- 已知未解：忙态下每帧仍要合成整个窗口（这是固定成本，跟动的是哪个元素无关）；
  30fps 已经把它砍半，再往上压只能继续降帧或停掉动画，都会损掉「它在动」的信息，
  暂时保留

**测试**
- 新增护栏：静止即停覆盖伪元素、hidden 覆盖伪元素、忙碌态清单、别的会话在跑不许冻结、
  宽限窗口、打盹不带 filter、关键帧只用 opacity / transform、浮窗与停靠条的 30fps 限帧、
  停靠条待机停帧、精密家电机身放大与 border-box
- 148 项 node 测试 + 91 项 render 全绿

## 0.10.4

**修复：「卡住了」提醒太吵**
- 工具在跑（`rinsing`）不再判卡住：副标题已经写着在跑哪个工具，两分钟的构建 / 测试
  不该被报「转不动了」。现在只有 `washing` / `spinning` 计时
- 阈值 45 秒 → 90 秒，宿主与停靠条两端同步：长思考安静几十秒是常态，
  误报一多这个信号就没人信了
- 修「任务一开始就报卡住」：开新轮时清空 token 采样，不再把上一轮的静默时长
  算到新一轮开局（用户隔一分钟再提问，第一帧就报「已经 1:05 没动静」）
- 卡住文案去掉永远为空的「卡在哪个动作」前缀，只说多久没动静
- 顺手删掉只写不读的 `lastUsage` 快照

**测试**
- 新增断言：工具在跑不判卡住、开新轮清空采样、两端阈值同值（90 秒）
- 147 项 node 测试 + 87 项 render 全绿

## 0.10.3

**尺寸合并成三档：极简 / 标准 / 大**
- 设置页「悬浮窗大小」与「缩放」合并为一行「尺寸」，和浮窗右键菜单的「尺寸」子菜单是同一组值；
  「紧凑 80%」下线，标准档就是基准宽 132px，大档 130%（选项文案只说档名，不带百分比与注释）
- 修「设置页缩放无效」：宿主 `writeOverlayPrefs` 只认 `size`、不认客户端发来的 `scale`，值一直被丢弃——
  现在只保留 `desktopOverlaySize` 一个字段，tiny / standard / large 三档真正生效
- 旧偏好文件自动迁移：`size:'normal'` + `scale:'large'` → `'large'`，其余 `'normal'` → `'standard'`
- 悬浮窗收到的页面档位仍只有「极简 / 正常」两态（缩放靠窗口物理尺寸，机身等比放大），行为不变

## 0.10.2

**文案与检索：搜「桌宠」也要能找到**
- 市场标题补上「桌面宠物」，描述开头改成「常驻桌面的桌面宠物」，让列表页和搜索结果第一眼能认出这是桌宠
- 市场关键词（参与模糊搜索，权重仅次于包名与标题）新增 `桌宠` / `桌面宠物` / `挂件` / `桌面挂件` / `宠物` /
  `desktop pet` / `pet` / `mascot` / `widget` / `desktop widget`；npm `keywords` 同步补齐
- README 开篇说明可当桌宠使用，安装段补一句「搜桌宠 / 桌面宠物 / 挂件 / 悬浮窗都能找到」

## 0.10.1

**修复：Windows 悬浮窗的几处边界问题**
- 托盘建不起来时不再拦截 close：图标读不出、`Tray` 构造失败都会返回 null，此时关闭窗口照常退出，
  不再出现「窗口藏起来了，任务栏 / Alt+Tab / 托盘都没有入口，只能重启客户端」
- 运行时下载加空闲超时：60 秒收不到新数据就中止并提示重试，网络挂住时按钮不再永远停在「正在下载」
- 安装运行时前先关掉正在运行的悬浮窗并等它退出（最多 4 秒），装完再自动拉回；
  顺带解决 Windows 上运行中的 `electron.exe` 锁住目录、覆盖安装报 500 的问题
- 运行时版本过旧时的提示按平台给出正确目录（Windows `~/.dsh/washer-runtime`，macOS `~/.dsh/electron`）；
  设置页把「版本过旧」和「没有运行时」分开显示，旧版在 Windows 上同样给覆盖安装按钮
- 安装成功后隐藏「下载运行时」按钮，避免误点重复下载 110MB
- 修复 `existsSync(null)` 在 Node 24 上打印 DEP0187 弃用警告

**测试**
- 新增断言：托盘不可用时 close 必须放行（否则窗口叫不回来）；AUMID `com.dsh.washer.float` 与 `docs/windows.md` 保持一致
- 145 host + 86 render 全绿

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

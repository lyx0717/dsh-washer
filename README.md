# dsh-washer · 滚筒洗衣机

**不用盯着屏幕，也知道 Agent 跑到哪了。**

一台永远置顶的桌面悬浮窗，把 Agent 的运转状态显示成滚筒洗衣机的动作。
也可以把它当**桌宠**（桌面宠物）用：它会转、会叫、会打盹，你忙你的，它替你盯着。
洗完、卡住、等你确认——三个你真需要抬头的时刻，它会主动叫你。
其余时间它安静地转，你去做别的事。

<p>
<img src="docs/float-washing.png" width="132" alt="精密家电 · 洗涤中：模型在出字">
<img src="docs/float-rinsing.png" width="132" alt="复古奶油 · 漂洗中：工具在跑">
<img src="docs/float-waiting.png" width="132" alt="工笔重彩 · 等你确认：在等你批准或回答">
<img src="docs/float-done.png" width="132" alt="太空舱 · 洗完了：本轮结束">
</p>

<sub>四套皮肤（依次）：精密家电 · 洗涤中 ｜ 复古奶油 · 漂洗中 ｜ 工笔重彩 · 等你确认 ｜ 太空舱 · 洗完了（带液态玻璃气泡）</sub>

## 为什么值得装

跑长任务时人不能干等着，切走又怕错过。窗口里那个小停靠条，切到浏览器另一页就看不见了。

| 痛点 | 它怎么解决 |
|---|---|
| 想知道跑完没，得一直切回来 | **悬浮窗永远置顶**，在哪个 App 前面都在 |
| 跑完了没注意，白等十分钟 | 完成时 `Glass` 一声 + 系统通知，人不在也能叫回来 |
| 卡住了看着却在转，不知道死没死 | 45 秒没有可见变化就报「卡住了」，不再谎报已运行时长 |
| 同时开三个会话，画面乱跳 | 一排小圆点显示全部（超过 3 个折叠成 `+N`），**点一颗钉住**就不跳了 |

不是装饰：洗衣机的每一个动作都对应一个**可验证**的宿主信号。
洗涤 = 模型在出字，漂洗 = 工具在跑，脱水 = 收尾，暂停 = 在等你批准。

```
待机     ▁▁▁▁▁▁▁▁ 筒空、灯暗
注水     ●●●○○○○○ 启动、水位上升
洗涤     ●●●●●●●● 滚筒慢转、气泡翻滚、模型在出字
漂洗     ●●●●●●○○ 反转、工具在跑（气泡里显示工具名）
脱水     ○○●●●○○○ 高速抖动、模糊、收尾
等你     ◐◐◐◐◐◐◐◐ 灯闪琥珀色、盯着你（等你批准/回答）
排水     ▁▁▁▁▁▁▁▁ 换水、水位降到底（上下文压缩中）
洗完了   ✓✓✓✓✓✓✓✓ 绿灯、停 `doneHoldMs` 后回待机
故障     ✕✕✕✕✕✕✕✕ 红灯快闪 + E 码
```

## 状态映射

| 状态 | 洗衣机在做什么 | 触发条件（宿主信号） |
|---|---|---|
| `idle` | 待机，筒空 | 会话存在但没在跑 |
| `starting` | 注水、筒开始转 | `running` 且本轮**还没有任何节点**（模型在出第一个字） |
| `washing` | 洗涤，泡多水满 | `running` 且正在流式出字（`partial` 非空），或上一步是工具 |
| `rinsing` | 漂洗，反转 | `running` 且有工具在跑（`runningCalls` 非空） |
| `spinning` | 脱水，高速抖动 | `running` 且无工具无流式，本轮最后一个节点是模型输出（收尾） |
| `waiting` | 暂停，灯闪琥珀 | 网页端：`sessionStatus.pendingInteraction` 有值；桌面悬浮窗：宿主 `approval/request` 事件。批准 / 拒绝 / 取消后自动恢复 |
| `draining` | 排水换水 | 上下文压缩进行中（`useTrajectory` 快照里最后一条 `purpose: 'compaction'` 的 request 状态为 `running`） |
| `done` | 洗完了 | 本轮正常结束，停 `doneHoldMs` 后自动回 `idle` |
| `error` | 故障 | `turn-error` 节点、或**本轮最后一条**工具 `isError` |
| `off` | 关机 | 会话被移除 / 不可用 |

错误码：`E-10` 模型/账号、`E-20` 工具失败、`E-21` 审批被拒、`E-30` 上下文/长度、`E-40` 中断、`E-50` 策略拦截、`E-00` 未知。

> 只认**本轮最后一条**节点的成败：Agent 工具失败后自己重试成功，不报故障——避免假警报。

## 面板形态

主界面里只有一个**固定形态的停靠条**：32px 机器小图 + 一行状态 + 计时/件数。
不展开、不点击、不循环档位——它要回答的是"洗到哪了"，不是"打开看看"。
要看得更全，用**桌面悬浮窗**（见下方「悬浮窗」）。

造型（`skin`）内置四套：**精密家电**（`'precision'`，默认）、**复古奶油**（`'cream'`）、
**工笔重彩**（`'gongbi'`）、**太空舱**（`'capsule'`）。设置页「外观」和浮窗右键菜单都能切，
选完立即生效。像素皮肤的代码仍在注册表里（`defineSkin('pixel')`），只是不再提供入口。

皮肤清单统一放在 `src/skins.json`（尺寸 / CSS / 机身实现 / 中英文名），构建脚本、
设置页、浮窗主进程都从它派生——加一套皮肤不用再改一串平行列表。

> 曾经有过 S/M/L 三档可展开卡片（L 档带工具流水和 token/成本）。
> 已整体删除：一个状态条不需要点开，详情交给了悬浮窗。
> 老配置里的 `size` / `expandedByDefault` / `skinBySize` / `showCost` /
> `costPerKToken` / `costCurrency` / `toolHistoryLimit` 现在**完全不被读取**，
> 留着也不会报错，但没有任何效果。

### 关于 `mode: 'overlay'`

网页内的浮层座位。它没有 `useChat`，拿不到节点和轨迹，所以**只报它确实知道的两件事**：
有待处理交互 → `waiting`（在等你），在跑 → `starting`（在忙，不猜细分阶段）。

「等你确认」时它一定会出现（那正是唯一需要看它的时候）；其余情况由 `overlayOnlyWhenBusy` 控制。

## 无进展提示

机器在转，不代表它在干活。`washing` / `rinsing` / `spinning` 状态下，
如果连续 **45 秒**没有任何可见变化（节点数、流式文本长度、在跑的工具数都不动），
副标题会从「已运行时长」换成卡住提示——用户真正想问的是"它是不是死了"，
只报时长等于没回答。

阈值故意偏保守：模型长思考、跑一个大构建/测试都可能安静几十秒，报假警比不报更烦人。

## 为什么没有预计剩余时间

做过，去掉了。按这个会话最近 8 轮耗时的中位数估「还要 1:20」，用户反馈
「不准确」，而且不准确是结构性的——一轮跑多久取决于这轮要调几次工具、
每次有多慢，历史中位数对这件事几乎没有预测力。给一个错的时间比不给更糟：
用户会信它，然后按它安排自己的事。

留下的是**卡住时长**（`0:52`）：那不是估算，是「已经这么久没有新产出」
的实测值，回答的是「它是不是死了」。

## 外观

机器底部是一条**内嵌黑色显示屏**：左边状态文字、中间「待/动/错」计数、右边计时，
全部收进机身黑条，不再在机身外飘一个气泡。黑条用深色玻璃质感 + 浅绿/白像素字，
状态色只染文字，不整条变色。

| 皮肤 | 材质 | 黑条 |
|---|---|---|
| 精密家电 `'precision'` | 白珐琅机身 + 镀铬门圈 + 蓝玻璃 | 深色玻璃屏，浅绿像素字 |
| 复古奶油 `'cream'` | 胡桃木控制带 + 镀铬门圈 | 琥珀色屏，暖白字 |
| 工笔重彩 `'gongbi'` | 熟宣纸底 + 铁线描 + 朱砂落款 | 宣纸浅屏，墨字 |
| 太空舱 `'capsule'` | 拉丝钛灰 + 冷黑舷窗 + 警示条纹 | 青蓝 HUD，扫描线 |

四套都保持「状态 / 计数 / 计时」三段结构不变，切换只换机身与黑条风格，不动信息布局。

机器本身也是有厚度的：一圈贴边投影把剪影从底色里勾出来，一层接地投影
让它像是坐在台面上。这两层**不能画在机身里**——机身是按宽度整体
`transform: scale()` 缩的，停靠条那台只有 32px 宽，按 300px 画的影子会跟着
缩到零点几像素，白机身贴在白底上就只剩一个玻璃圆。所以它们挂在缩放框
`.dw-frame` 上，那里的 px 就是屏幕 px，缩到多小都不掉。

这里只打投影，不再在框上描一圈内阴影。试过：机身并不跟着缩放框走
（浮窗里它只占框的左上部分，右边空 9%、底部空 9.6%；停靠条里又是另一套），
照框描的那圈线，右边和底部就落在机器外面，看着像外头多套了一个边框。

## 多会话

用户经常同时跑两三个 agent。状态文字和计时跟着**当前跟随的会话**（默认最近活动，可钉住）；
中间计数区汇总全部会话：**待 = 等你确认、动 = 在运行、错 = 出故障**，0 项不显示。

滚筒里的彩色衣物 = **正在运行的会话数**，最多 6 件，每件挂真实 sessionId；
启动中逐件淡入，洗完了清空。会话排序仍按「等审批 / 故障优先，其次最近活动」，
钉住的会话不会被挤掉。

## 通知

设置页可开，默认关。只在四个需要你抬头的时刻报：**「洗完了」**、**「出故障了」**、**「等你确认」**、**「卡住了」**。

- 窗口在前台时不弹（人就在看，还弹是打扰），4 秒内不重复弹。
- **卡住**（45 秒无可见变化）也会主动弹一次，并说卡在哪个动作上；一轮只提醒一次。
- **等你确认**如果一直没人理，约 30 秒后会再敲一次，别让唯一的提醒石沉大海。
- **多会话**：不是当前显示的那台跑完/故障/等你确认，同样会弹系统通知（只是不在窗口里弹横幅）。
- 点通知把浮窗调到前面。
- **浮窗内另有本地气泡**：从机身顶向上冒出一条液态玻璃气泡（一句拟声标题 + 一行说明，
  最多两行、超出省略），停留 2.2–3.2 秒按字数自适应。这条不经过系统通知中心，
  所以即使通知权限被拒也一定有反馈。

| 时刻 | 气泡标题 | 说明行 |
|---|---|---|
| 洗完了 | 叮——洗好啦 | 用时 · 工具数 |
| 出故障了 | 咔哒…我罢工了 | 错误码 + 人话解释 |
| 等你确认 | 喂——该你啦 | 等待批准 / 需要选择 |
| 卡住了 | 咕噜咕噜…转不动了 | 卡在哪个动作 · 多久没动静 |
- 系统通知发不出来时会自动退回 `osascript`（详见 `electron/main.cjs` 里
  `showScriptNotification` 的注释：adhoc 签名的 Electron 拿不到 macOS 通知权限）。
- Windows 上用 Electron 的原生 toast（AUMID `com.dsh.washer.float`），点击通知会把浮窗
  显示出来。没有第二条通道可退——页面在同一个时刻已经弹过窗内横幅，不再重复弹一次。

## 状态音效

设置页可开，默认关，和「通知」是**两个独立开关**——通知弹横幅、声音响一声，
你大可以只要声音不要通知（浮窗就在眼前，通知只会挡别的窗口）。

只在这个三个时刻响，中间运转一律静音：

| 时刻 | 音 | 为什么 |
|---|---|---|
| 洗完了 | `Glass` 明亮上行 | 事情办完了，叫你回来看 |
| 出故障 | `Basso` 低沉 | 和完成听觉上区分开，一听就知道要去处理 |
| 等你确认 | `Tink` 最轻一声 | 卡在这儿等着，不叫你看不到 |

**为什么不给每个状态都加声音**：一次任务会依次经过
`starting → washing → rinsing → spinning → done`，每个都响的话一轮七八声，
比闹钟还烦；然后用户会把开关关掉——连最重要的那声「洗完了」也一起没了。
只留**用户需要行动**的三个时刻，其余交给画面本身（转速、水位、泡沫都在动，
本来就不需要声音告诉你它还活着）。

### macOS 用系统音，Windows 用页面合成

macOS 上宿主用自带的 `afplay` 播 `/System/Library/Sounds/*.aiff`：不打包音频、
不做解码、不引入许可问题，而且**跟着你系统自己的音量和静音键走**——
自己塞个 mp3 进来反而会出现「系统静音了它还在响」。

Windows 没有这套系统音，浮窗页面用 WebAudio 现场合成三个和弦（`done` 上行三音、
`error` 下行、`waiting` 轻点），由主进程通过 IPC `washer:play-sound` 触发。
两边的开关、节流（2 秒）、前台静音规则完全一致；宿主通过
`/dsh-washer/capabilities` 的 `sound` 字段告诉客户端这台机器有没有音效能力——
`sound` 覆盖 macOS 与 Windows，Linux 上整行隐藏，不留拨了没反应的开关。

开关、节流、前台静音和通知共用一套判断：窗口在前台时静音（人就在看），
2 秒内不重复响（状态抖动时不连响）。

## 安装

```bash
# 从 npm 安装（推荐）
dsh plugin --profile desktop add @lyx0717/dsh-washer

# 或者从 GitHub 固定 commit 安装（跟最新发布但可复现）
dsh plugin --profile desktop add github:lyx0717/dsh-washer#<commit>

# 或者本地目录安装（开发用，改完即时生效）
dsh plugin --profile desktop add /path/to/dsh-washer
```

装完在 profile 的 `package.json` 里会多出一条依赖。改完重启 Harness（替换已装包需要重启，新装包由 HMR 接管）。

> 在插件市场里搜「**桌宠**」「**桌面宠物**」「**挂件**」「**悬浮窗**」「洗衣机」，都能找到它。
> 搜不到通常是市场索引没刷新到最新版本：索引在 <https://lyx0717.github.io/dsh-washer/index.json>。

**卸载**：

```bash
dsh plugin --profile desktop remove @lyx0717/dsh-washer
```

> ### 从 0.2.x（旧包名 `dsh-washer`）升级
>
> 0.3.0 起包名改为 `@lyx0717/dsh-washer`。`cordis.patch.yml` 里防止重复挂载的
> `disabled` 表达式**只认新包名**，所以旧包名和新包名同时装会在两个
> entry 上都挂出 `id: washer`，插件被初始化两次（监听器重复注册、SSE 推送翻倍）。
>
> 升级必须**先卸旧的再装新的**：
>
> ```bash
> dsh plugin --profile desktop remove dsh-washer
> dsh plugin --profile web     remove dsh-washer
> dsh plugin --profile desktop add @lyx0717/dsh-washer
> ```
>
> 偏好文件 `~/.dsh/dsh-washer-float-prefs.json` 和浏览器 `localStorage` 的
> key 都没变，卸载不会丢设置。

## 配置

两条路，互相配合：

1. **默认值**写在 `cordis.patch.yml` 的 `washer` 行 `config:` 下（全部可选，见下表）。
2. **用户改动**在 GUI 里做——**设置 → 洗衣机**。改动存进浏览器 `localStorage`（key `dsh-washer:prefs`），读取顺序是 `内置默认` ← `patch config` ← `localStorage`。

> 为什么不走宿主统一的设置持久化（`ctx.configForms`）：那套 store 只服务挂在 loader `include` 行下的插件，第三方 bundle 走 `- insert:` 拿到的控制器永远是 `unavailable`（写进去读不回来）。已装的 `dsh-better-sidebar` 同样绕开它、自存 `localStorage`。
>
> 代价：桌面悬浮窗读不到浏览器 `localStorage`。浮窗的偏好因此走宿主写到 `~/.dsh/dsh-washer-float-prefs.json` 的文件，并通过 `/dsh-washer/prefs` 与设置页双向同步。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时完全不挂载（连样式都不注册） |
| `mode` | `'dock'` | `'dock'` 挂在输入框上方。`'overlay'` 挂到 `shell.overlay`（网页内浮层，与桌面悬浮窗无关） |
| `overlayOnlyWhenBusy` | `true` | 仅 `overlay` 形态有效。`pending` 时无视此开关，一定出现 |
| `skin` | `'precision'` | `'precision'` / `'cream'` / `'gongbi'` / `'capsule'`；`'pixel'` 代码保留但不再暴露入口，不认识的值回退 `'pixel'` |
| `hideWhenIdle` | `false` | 待机时整个隐藏 |
| `doneHoldMs` | `6000` | 「洗完了」停留时长 |
| `desktopOverlay` | `true` | 是否开本地 HTTP+WS 服务（浮窗的数据源） |
| `desktopOverlayPort` | `0` | `0` = 系统分配，避免抢端口；日志里打印实际地址 |
| `desktopOverlayAutoLaunch` | `true` | 宿主启动时是否自动拉起浮窗进程。关掉后端口还在，只是不自动开窗 |
| `desktopOverlaySize` | `'normal'` | `'normal'` / `'tiny'`（极简：机器缩到 64px，正文不可读，只留灯与造型） |
| `desktopOverlayScale` | `'standard'` | 正常档的缩放：`'compact'`(0.8) / `'standard'`(1.0) / `'large'`(1.2)；极简档不受影响 |
| `desktopOverlayClickThrough` | `false` | 鼠标穿透，点穿到底下应用；`⌥⌘W` 恢复 |
| `desktopOverlayNotify` | `false` | 弹系统通知（完成 / 故障 / 等你确认 / 卡住） |
| `desktopOverlaySound` | `false` | 状态音效（完成 / 故障 / 等你确认） |
| `desktopOverlayDnd` | `false` | 勿扰：临时静音全部通知与音效，浮窗照常显示 |

示例：

```yaml
- insert:
    - id: washer
      name: '@lyx0717/dsh-washer'
      config:
        skin: 'precision'
        hideWhenIdle: true
        doneHoldMs: 8000
```

## 设计约束

- **只读**：不往会话里写任何事件，不改其他插件的 DOM。
- **不抢焦点**：停靠条是静态 `<div role="status">`，不进 tab 序列、不响应点击——
  它不是可交互控件，读屏只把它当状态播报。
- **尊重动效偏好**：`prefers-reduced-motion: reduce` 时全部动画降到 0.001ms。
- **颜色**：容器/文字走宿主 `--dsw-alias-*` token；只有机身材质用自有 `--dw-*`（暗色由 `[data-ds-dark-theme]` 切换）。
- **零依赖**：不打包 React，直接 `require('react')` 用宿主那一份。

## 开发

```bash
npm run build     # src/ → client.js + debug/float.machines.js（约 140KB）
npm test          # core 38 + host 71 + build 4 = 113 条
node test/render.mjs           # 61 条行为测试 + 生成 /tmp/washer-render 截图素材
node test/render.mjs --no-shots   # 只跑用例不写盘
node debug/e2e.mjs             # 端到端：起真服务 + 模拟事件流，逐行打印状态迁移
```

- `src/core.js` 纯函数状态机，node 下可直接测。
- `src/client.template.js` 组件源码，`build.mjs` 把 core/CSS/SVG 内联成单文件 `client.js`。
- `build-float.mjs` 生成浮窗用的独立造型脚本 `debug/float.machines.js`，
  在构建期把 `NATURAL` 求值成纯常量（浮窗脚本够不到主界面的 `SKIN_REGISTRY`）。
- `test/render.mjs` 是最小 React hooks 运行时：真跑 hooks、真 re-render，能测到时间轴行为。
  **加 `--no-shots` 只是跳过截图写盘，用例照跑满 56 条**（别在中间 `process.exit()`，
  否则后面的用例没跑也显示通过）。

> `test/host.test.mjs` 会起本地 HTTP 服务且不主动关闭，所以 test 脚本带 `--test-force-exit`。
> 手动单跑时也要带上，否则进程不退出：
> `node --test --test-force-exit test/host.test.mjs`。

### 测试的规矩

**每条回归测试都要先还原旧实现，确认它会变红。** 不这样做的测试是在给自己发假的安心。

两个真实踩过的坑：

- 断言片段里包含了被删代码的**函数定义**，删掉调用点测试照样绿。
  要精确切到函数体范围再断言。
- 断言片段里包含注释中引用的旧写法，得先 strip 注释再匹配。

### ⚠️ 改包名时的唯一硬约束

`src/client.template.js` 里的模块 id **必须等于 `package.json` 的 `name`**：

```js
window.__ModuleLoader__.load({
  id: '@lyx0717/dsh-washer',   // ← 必须 == package.json 的 name
```

宿主按 `insert.name`（即包名）去 `__ModuleLoader__` 的注册表里查客户端模块。两者不一致时，**查不到的那一边不会报任何错**：服务端半照常工作、日志干净，只是 dock 座位不出现、`settings.section` 不注册——用户在界面上看到的是「插件装了但设置页里连入口都没有」。

`build.mjs` 已加构建期硬断言：模块 id 与包名不符直接构建失败并指出该改哪一行。

改包名时还要同步（`grep -rn "dsh-washer" src/ cordis.patch.yml` 能全部列出来）：

| 位置 | 字段 |
|---|---|
| `package.json` | `name` |
| `cordis.patch.yml` | `insert.name`、`disabled` 表达式里的 `options.name` |
| `src/client.template.js` | `__ModuleLoader__.load` 的 `id`、插件对象的 `name`、各处 `registrant` |

另外，npm 与插件市场是两套东西，别混：

- **npm 包名**改了就是 breaking change，必须**先卸旧包再装新包**。
- **插件市场**（`awesome-dsh-plugin`）那条 `lyx0717__dsh-washer.yml` 的 `url` 字段**只能填 GitHub 仓库地址**，不要改成 npm 链接。npm 源是官方 CI 的 `probe-npm.mjs` 自动探测的：它读仓库根 `package.json` 的 `name`，再核对 npm 上该包的 `repository.url` 是否指回同一个 GitHub 仓库。所以只要 `name` 和 `repository` 都对，不用提 PR 改任何东西，等流水线跑一轮即可。

### 发布到插件市场

改代码 → 刷新索引 → push，一步别少：

```bash
node scripts/refresh-market.mjs && git add docs/index.json && \
  git commit -m "docs: 刷新市场索引" && git push
```

pre-push 钩子会在"代码变了但索引没刷"时拦下并自动重写 `docs/index.json`。

### 宿主半（`index.js`）与客户端的数据通道

Web 端的 `deriveState` 吃的是宿主渲染进程里的投影，独立的桌面窗口（Electron）拿不到那些东西。所以宿主半在 Node 侧监听同一批事件、喂给**同一个** `src/core.js`，再通过本地 HTTP+WS 把快照推出去——两边判定只有一份实现，不会各写一套然后对不上。

- 只绑 `127.0.0.1`，每次启动生成随机 token，`/dsh-washer/state`、`/dsh-washer/health`、`WS /dsh-washer/stream` 全部要 token（query 或 Bearer）。
- 启动后端点信息写到 `~/.dsh/dsh-washer-overlay.json`（0600，进程退出即删）：

  ```json
  { "url": "http://127.0.0.1:61491/dsh-washer/state?token=...",
    "port": 61491, "token": "...", "pid": 68298 }
  ```

- 调试端：`debug/overlay.html?port=端口&token=令牌`，浏览器直接打开就能看状态流转，断线会自动指数退避重连。

## 悬浮窗

独立的桌面悬浮窗，常驻屏幕角落看 Agent 在干什么。

- 透明无边框、置顶、跨 Space 可见、不抢焦点
- 拖动可改位置，退出后记住
- **鼠标穿透**在设置页或右键菜单里开关（穿透时半透明，点击落到下面应用）；
  原先的「双击切换」已不再有效——整机是拖拽区，dblclick 被拖拽吞掉
- **右键**菜单：查看详情 / 打开 Harness 客户端 / 尺寸（紧凑·标准·大·极简）/ 皮肤（精密家电·复古奶油·工笔重彩·太空舱）/ 透明度 / 穿透开关 / 重连刷新 / 暂停监听 / 退出
- **详情面板**（右键「查看详情」）：模型、速度、本轮耗时、token 与缓存命中、工具耗时排行，
  外加「最近几轮」回看（每轮成败 / 用时 / 工具数）和故障时一键复制错误码
- 画面节奏跟着负载走：读单个文件慢悠悠，批量重构 / 跑命令转得更快、水花更旺
  （负载来自最近几个工具的动作类型，是可解释的权重，不是随机动画）
- 黑条一次显示三块：状态文字 ｜ 待/动/错计数 ｜ 本轮耗时；屏幕下沿留一段白边当机身下巴
- 完成 / 故障 / 等你确认 / 卡住时，机顶会冒出一个**液态玻璃气泡**（一句标题 + 一行说明，
  最多两行自动省略，不会顶出窗口）。窗口顶部为此留了一条透明「气泡通道」，它不参与拖拽，
  拖拽区仍然只有机身；极简档放不下气泡，不外露
- **暂停监听**只冻结实时同步、画面停在最后一帧，不影响可见性，也不改配置
- 穿透状态下窗口收不到任何鼠标事件，用 **⌥⌘W** 恢复（不要用 ⌘⇧W，那是系统关窗口的键）

**平台矩阵**（0.10.0 起 Windows 上线）：

| 平台 | 悬浮窗 | 说明 |
|---|---|---|
| macOS | ✅ | 独立 Electron 进程：透明置顶、跨 Space、点击穿透、右键菜单、afplay / osascript |
| Windows | ✅ 0.10.0 起 | 独立 Electron 进程：`type: 'toolbar'` 不进 Alt+Tab；托盘常驻；关闭 = 隐藏；音效由页面合成；通知走原生 toast |
| Linux | ❌ | 设置页整节隐藏（`overlayReason: 'platform'`），装运行时也没用 |

dock 是全平台的（跑在宿主渲染进程里），悬浮窗则是独立 Electron 进程，必须有本机运行时。

**运行时从哪来**：宿主按下面的顺序找，第一个能用的胜出。

| 平台 | 顺序 |
|---|---|
| macOS | `DSH_WASHER_ELECTRON` → `~/.dsh/electron/Electron.app/Contents/MacOS/Electron` |
| Windows | `DSH_WASHER_ELECTRON` → `%USERPROFILE%\.dsh\washer-runtime\electron.exe`（同目录 `version` 文件主版本 ≥ 43） |

Windows 上缺运行时时，设置页的悬浮窗整节照常显示，多出一个**「下载运行时（约 110 MB）」**
按钮：宿主从 `npmmirror.com/mirrors/electron` 拉 `electron-v43.8.6-win32-x64.zip`
（可用 `DSH_WASHER_ELECTRON_MIRROR` / `DSH_WASHER_ELECTRON_VERSION` 覆盖版本与镜像），
先 `tar.exe -xf`、失败退 PowerShell `Expand-Archive`，解到临时目录校验 `electron.exe`
与 `version` 后原子替换 `%USERPROFILE%\.dsh\washer-runtime`。

手动装也行——把 zip 解压到 `%USERPROFILE%\.dsh\washer-runtime`，要求目录根部同时有
`electron.exe` 和 `version`（Electron 发行包自带），不要套一层 `electron-v43.8.6-win32-x64/`。

**Windows 上的行为差异**（都是有意的）：

- **关闭 = 隐藏**：点窗口关闭按钮只是 `hide()`，进程和托盘留着；退出请走托盘菜单
  「退出悬浮窗」或右键菜单「退出悬浮窗」。
- **鼠标穿透**：右键菜单或托盘「鼠标穿透」勾选；穿透状态用 **Ctrl+Alt+W** 恢复
  （macOS 是 ⌥⌘W；真实加速键仍是 `Alt+CommandOrControl+W`，界面文案按平台显示）。
  穿透时窗口收不到任何鼠标事件，托盘勾选项是快捷键之外的唯一出路。
- **不进 Alt+Tab / 任务栏**：窗口带 `type: 'toolbar'`（`WS_EX_TOOLWINDOW`）。
  `skipTaskbar: true` 在 Windows 上不够——它只隐藏任务栏按钮，Alt+Tab 里还在。
- **跨 Space / 全屏**：`setVisibleOnAllWorkspaces` 是 macOS 专属，Windows 上跳过；
  普通桌面的置顶照常生效，全屏应用前需要额外层级处理，详见 [docs/windows.md](docs/windows.md)。
- **音效 / 通知**：Windows 没有 `afplay` / `osascript`，分别换成页面 WebAudio 合成
  与 Electron 原生 toast（AUMID `com.dsh.washer.float`）。

**两种"起不来"要分清**，设置页据此给不同处理：

| `overlayReason` | 含义 | 设置页 |
|---|---|---|
| `platform` | 这个平台不支持（Linux） | 整节隐藏，装 Electron 也没用 |
| `missing` | 平台支持，但这台机器没装运行时 | 开关照常显示；macOS 提示缺运行时，Windows 给下载按钮 |
| `null` | 正常可用 | 正常显示 |

```bash
./electron/start.sh          # macOS 手动起（调试用）
ELECTRON_PATH=/path/to/Electron ./electron/start.sh   # 指定 Electron 运行时
```

```bat
electron\start.cmd           # Windows 手动起（调试用）
set ELECTRON_PATH=C:\path\to\electron.exe && electron\start.cmd
```

> 从 DSH 的终端里启动时，`ELECTRON_RUN_AS_NODE=1` 会被继承，Electron 会退化成纯 Node。
> `electron/start.sh` / `electron/start.cmd` 已经帮你清掉了。正常情况下不需要手动起——宿主会按 `desktopOverlayAutoLaunch` 自己拉。

### 浮窗看不到？按这个顺序查

1. **偏好文件里的 `show` 是不是 false**：`~/.dsh/dsh-washer-float-prefs.json`。
   这是"用户点了关闭"的记录，进程被强杀时可能被误写成 false。
2. **进程在不在**：`ps aux | grep 'dsh-washer/electron'`。
3. **画面空白但进程在**：多半是 `debug/float.machines.js` 坏了。
   跑 `node --check debug/float.machines.js`，有语法错就重新 `npm run build`。
   （`build-float.mjs` 曾经因为正则截断生成过残缺文件，`test/build.test.mjs` 现在盯着这件事。）

> 调试别靠猜窗口坐标截图——用离屏 Electron 的 `capturePage()` 直接出图。

## 版本记录

### 0.10.2
- 市场标题 / 描述 / 关键词补上「桌宠」「桌面宠物」「挂件」，搜这些词也能找到；npm `keywords` 同步
- README 开篇与安装段补桌宠说法；纯文案改动，功能零变化
- 详细变更见 [CHANGELOG.md](CHANGELOG.md)

### 0.10.1
- 修复 Windows 上几处边界问题：托盘建不起来时关闭窗口不再「藏起来叫不回来」
- 运行时下载 60 秒无数据即中止并提示重试；安装前自动关浮窗、装完拉回（避开 exe 占目录导致覆盖安装失败）
- 「版本过旧」与「没有运行时」分开提示，旧版提示按平台给正确目录；装好后隐藏下载按钮
- 详细变更见 [CHANGELOG.md](CHANGELOG.md)

### 0.10.0
- **Windows 悬浮窗上线**：设置页可在 Windows 上开关浮窗；不进 Alt+Tab / 任务栏；托盘常驻；关闭 = 隐藏
- 运行时：`%USERPROFILE%\.dsh\washer-runtime\electron.exe`（`version` ≥ 43）；
  缺运行时可在设置页一键下载（npmmirror 镜像，约 110 MB，下载失败退手动放置）
- 音效改为「macOS `afplay` / Windows 页面 WebAudio 合成」，`sound` 能力覆盖两个桌面平台
- Windows 通知走 Electron 原生 toast（AUMID `com.dsh.washer.float`）；穿透用 Ctrl+Alt+W 或托盘恢复
- 窗口加 `type: 'toolbar'`（不出现于 Alt+Tab），`setVisibleOnAllWorkspaces` 在 Windows 上跳过
- **macOS 行为零变化**：透明置顶、跨 Space、afplay、osascript 兜底、快捷键 ⌥⌘W 全部保留
- 新增 `electron/win32.cjs`、`electron/start.cmd`、`electron/tray.png`；测试按平台分层
- 详细变更见 [CHANGELOG.md](CHANGELOG.md)

### 0.9.0
- 新增三套皮肤：**复古奶油** / **工笔重彩** / **太空舱**，设置页「外观」与浮窗右键菜单都能切
- `src/skins.json` 成为皮肤清单唯一来源，构建、设置页、浮窗主进程、测试全部从它派生
- 精密家电 / 复古奶油机身单源化，React 主界面与浮窗共用同一份实现
- 修复精密家电衣物类名无效、待机与运行都没有气泡
- 移除彩蛋金牌/失败徽章；通知气泡改为液态玻璃、从机顶向上冒出，窗口顶部留出气泡通道
- 详细变更见 [CHANGELOG.md](CHANGELOG.md)

## 许可

MIT。图标与像素 sprite 均为原创（脚本生成，见 `src/machine.svg`、`src/sprite.svg`）。

## 本地开发

装法用 **`link:`**，不要用版本号：

```bash
dsh plugin --profile desktop add link:/Users/liyongxuan/Downloads/AI/washer/dsh-washer
```

用版本号装（`"@lyx0717/dsh-washer": "0.5.0"`）时，宿主读的是
`~/.dsh/profiles/desktop/node_modules/@lyx0717/` 下那份**拷贝**，不是源码。
改了代码、`npm run build` 也测过，页面却一点变化没有——因为那份拷贝压根没动。
这个坑真踩过：一份 26 小时前的拷贝让「CSS 明明测过是对的、用户那边就是不变」。

链接装好之后，改代码只需要三步：

```bash
npm run build        # 1. 重新生成 client.js（改了 src/ 必做）
                     # 2. 重启插件（改了 index.js / client.js 都必须，进程要重读）
                     # 3. 浏览器 Cmd+Shift+R —— client.js 会被 HTTP 缓存住
```

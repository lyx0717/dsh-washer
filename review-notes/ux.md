# dsh-washer · 用户体验评审（功能/体验缺陷与优化）

评审范围：只写用户可感知的功能/体验缺陷，不写代码风格（可维护性/可读性/简洁性已由 `CODE_REVIEW.md` 覆盖）。
所有 `file:line` 均为本人逐行 read/grep 核实过，路径相对 `dsh-washer/` 项目根。
共 10 条，按优先级 P0 → P1 → P2 排序；末尾附「刻意舍弃的功能，不要重提」。

---

## P0

### 1. 「等你确认」是三大叫人时刻之一，却永远不弹系统通知

- **现象**：用户把「洗完通知」开关打开后，`洗完了`、`出故障了` 都会弹系统通知；但 Agent 停在「等你确认」时，**系统通知一次都不弹**（只有一声 Tink 音，而音效是另一个默认关闭的开关）。离开座位回来才发现任务早卡在等你拍板。
- **位置**：
  - `electron/main.cjs:1066-1079`：`ipcMain.on('washer:notify', ...)` 里先 `playSound(kind)`，随后只有 `if (kind === 'done') notify('洗完了', …)` 和 `else if (kind === 'error') notify('出故障了', …)` —— **缺 `waiting` 分支**。
  - `debug/float.html:1031`：页面确实以 `kind='waiting'` 发出了 IPC（`host.notify(s, text)`，`s` 含 `'waiting'`，见 `:1025`）。
  - `electron/main.cjs:561-585`：`notify()` 本身不按 kind 过滤，是否发由调用方决定，所以失败点就是上面的 handler。
  - **页面那头其实期望 waiting 也发通知**：`debug/float.html:1032-1041` 注释明确写"横幅和系统通知**同时**出…让两边的触发条件保持一致（都只看状态边沿）"——但主进程把 waiting 吞了，页面这份设计落空。
  - 文档现状也自相矛盾：`README.md:246`（`desktopOverlayNotify`）写"只报完成和故障"，而 `README.md:247`（`desktopOverlaySound`）写音效含"等你确认"——等于承认 notification 这条路唯独漏了 waiting。
  - 佐证默认值：`electron/main.cjs:88`（`notifyPref` 默认 false）、`electron/main.cjs:100`（`soundPref` 默认 false）。
- **用户影响**：产品核心承诺是「只有洗完 / 卡住 / 等你确认三个时刻主动叫人」。其中唯一需要用户**立刻动手**的「等你确认」，即使用户已主动开启「洗完通知」，也永远收不到系统通知（只有默认关闭的音效音）；离开座位就等于白等。这不是"少一条通知"，是把最该叫人的那一次丢了。
- **优化方案**：在 `electron/main.cjs:1066` 的 handler 里补 `else if (kind === 'waiting') notify('等你确认', text || '需要你拍板');`。若担心 waiting 高频打扰（`SOUNDS.waiting` 注释："高频场景，不能吵"），给它单独的节流窗口（比如 30s）或独立开关，而不是直接不发；至少当窗口不在前台（`!win.isFocused()`，`notify` 已有该判断）时必须发系统通知。**若维护者判定"只报完成/故障"是刻意取舍**，则必须改齐两处：要么删掉 `float.html:1032-1041` 对 waiting 的通知期待并改 `README.md:246` 的措辞，要么补上分支——不能像现在这样"页面发、主进程丢、文档两说"。
- **优先级**：P0（若确认"只报完成/故障"是有意为之，可降 P1，但仍属确定的实现/文档不一致，须修齐）

---

## P1

### 2. 多会话时，浮窗只对「当前显示的那个会话」报警，其它会话完成/故障/等你确认全静音

- **现象**：同时跑 2-3 个 Agent 时，浮窗只显示其中一个会话的状态。其它会话进入 `洗完了 / 出故障了 / 等你确认`，浮窗既不弹横幅、不响、也不发通知，只有一排彩色圆点变个颜色。
- **位置**：
  - `debug/float.html:1012-1042` `maybeNotify(snap)` 只读 `snap.state`（`var s = snap.state || 'off'`，:1013），`sessions` 数组只用于画圆点（`renderDots`）。
  - `index.js:1267-1360` `snapshot()` 的顶层 `state` 只取 `viewSessionId()`（`index.js:1230-1233`、`:1294`、`:1310`）这一个会话；其余会话只在 `:1355` 的 `sessionSummaries(now)` 里以数组形式给出。
- **用户影响**：README「多会话」一节宣称的「只显示一个等于看不见其它两个」正是要解决的问题，但真正需要抬头的三个时刻，后台会话根本没叫到人——多会话下这个功能价值打折最明显。
- **优化方案**：在 `debug/float.html` 的 `maybeNotify` 里改为**按会话检测边沿**：维护 `Map<sessionId, lastState>`，遍历 `snap.sessions`，任一非当前会话从其它状态跳进 `done/error/waiting` 就触发 `host.notify` + `showFlash`，文案带上会话短 id/名（`String(sessionId).slice(0,8)` 或 sessionSummaries 里的标题）。或在 `index.js` 的 `snapshot()` 里直接算一个 `alert` 字段下发，前端只管播，避免两边各存一份"上次状态"。
- **优先级**：P1

### 3. 第 4 个及以后的会话在悬浮窗里彻底不可达，「+N」看得到点不到

- **现象**：会话数 > 3 时，浮窗圆点区显示 2 颗点 + `+N`。`+N` 只是文本，鼠标点不了、也不能展开，被折叠的会话没法在悬浮窗上切过去或钉住。
- **位置**：
  - `debug/float.html:935` `MAX_DOTS = 3`；`:978-985` 溢出时追加的是 `<span class="more">+N</span>`，无 `role=button`、无点击处理。
  - `debug/float.html:411-419` `.dots .more { pointer-events: none; }` —— 明确屏蔽了鼠标事件。
- **用户影响**：多会话下，如果被折叠的会话正好是「等你确认/出故障」，用户在悬浮窗上根本点不到它，只能回到网页主界面去切；而这台悬浮窗的卖点恰恰是"不用回到网页"。属于可发现性硬伤：用户知道"还有 N 个"，却无能为力。
- **优化方案**：把 `+N` 做成可用入口（`role=button`、`tabIndex=0`、`pointer-events:auto`，`:click` 打开一个会话切换菜单）。菜单可复用主进程已有的 `Menu` 机制（`electron/main.cjs:897 showMenu()` 附近）：新增 IPC `washer:show-session-menu`，主进程按 `snap.sessions` 动态列出「状态 · 会话名」，点击即 POST `/dsh-washer/pin`；这样折叠会话也能被切到浮窗上。
- **优先级**：P1

### 4. 读屏用户被状态条的计时每秒播报一次（`role=status` 套在了会走秒的整条上）

- **现象**：网页停靠条整条是 `role="status"`（隐式 `aria-live="polite"`），它的无障碍名和可见文字里含随时长每秒变化的 `elapsed`。任务运行期间，辅助技术会**每秒**播报一次状态条，读屏用户基本无法使用。
- **位置**：
  - `src/client.template.js:534-545` `StripBar`：根节点 `role:'status'`（:537），`aria-label: label + ': ' + title + ' · ' + sub`（:538），`title` 同串（:539），并且可见的 `dw-t2` 内就是 `sub`（:544）。
  - `src/client.template.js:915-934`：`sub` 由 `sub.washing`/`sub.rinsing`/`sub.stalled` 等填入，文案带 `{elapsed}`（locale `:145` `'sub.washing': '{elapsed} · 第 {n} 件'`、`:147`、`:146`）。
  - `src/client.template.js:847-853`：运行/保持期每 1000ms `setTick` 重渲染一次，`elapsed` 每秒变。
- **用户影响**：这是"信息看得见但读屏用不了"的典型。视觉用户在 32px 小条上读秒没问题，但 `aria-live` 每秒刷屏会让语音助手失去可用性，也会盖掉同页其它更该听的提示。
- **优化方案**：把 `role="status"`（或 `aria-live="polite"`）从含计时的整条挪到一个**只包状态标题 `dw-t1`** 的节点；给计时/副标题（`dw-t2` 与 `screenTime`）加 `aria-hidden="true"`；live 文本只在 `state` 变化时更新（标题本身已是 `tr('state.'+state)`），不要随秒变化。这样原来"状态变化时播报"的设计意图保留，计时噪音消失。
- **优先级**：P1

### 5. 网页 overlay 在整个任务运行期间都显示「启动中」，跑再久也是

- **现象**：网页内的浮层胶囊，只要 Agent 在跑，标题恒为「启动中」；跑 5 分钟也还是「启动中」，看起来像卡在起跑线。
- **位置**：
  - `src/client.template.js:1165-1167` `WasherOverlay`：`const state = pending !== undefined ? 'waiting' : 'starting';` / `const title = tr('state.' + state);`。
  - `src/client.template.js:133` `'state.starting': '启动中'`。
- **用户影响**：overlay 是"抬头一瞥"的形态，标题就是唯一大字。用「启动中」表达"正在跑"，语义错了——用户会以为还没开始干活。不做细分状态（`pending?waiting:starting`）是为了不猜，这个取舍可以保留，但**文案不该复用 starting**。
- **优化方案**：给 overlay 一个中性忙碌词，不新增状态机、不猜细分：新增 locale key（如 `overlay.busy` = "处理中"/"在忙"），`title = pending !== undefined ? tr('state.waiting') : tr('overlay.busy')`；机器造型继续复用 `starting` 动画即可。这样既忠于"只有可验证信号"，又不撒谎。
- **优先级**：P1

### 6. 悬浮窗位置记忆不校验显示器，拔掉副屏后窗口可能永久落在屏幕外

- **现象**：窗口位置记在偏好文件里，启动时原样读回。如果上次是放在副显示器、后来副屏被拔掉/分辨率变了，窗口会开在已不存在的坐标上，屏幕上什么都看不到，也没有任务栏图标可点。
- **位置**：
  - `electron/main.cjs:316-322` `readPosition()`：直接 `JSON.parse` 返回 `{x,y}`，**不做任何屏幕范围校验**。
  - `electron/main.cjs:447-448` `createWindow()`：`const pos = readPosition() || defaultPosition();` 原样用作窗口坐标。
  - `electron/main.cjs:372-379` `defaultPosition()` 只在没有位置文件时用；`electron/main.cjs:333-358` `snapToEdges()` 只在窗口 `moved` 事件后触发，启动时不跑。
- **用户影响**：这是"多屏/多显示器"用户会遇到的一次性致命体验——窗口还在（进程没崩），但人找不到。右键菜单 `showMenu()`（`electron/main.cjs:897`）挂在窗口自身上，窗口在屏幕外就无从右键，只能手动删偏好文件。
- **优化方案**：在 `createWindow()` 里把 `pos` 交给 `screen.getDisplayMatching({ x, y, width, height })`（`snapToEdges` 已用同一 API）取值；若该点不在任何显示器 `workArea` 内，则按 `defaultPosition()` 同款算法 clamp 到最近屏的 `workArea`（x/y 各自夹入 `[a.x, a.x+a.width-width]`）。可在 `screen.on('display-removed'|'display-metrics-changed')` 里再校正一次。
- **优先级**：P1

---

## P2

### 7. 「等你确认」横幅两行近义重复，没说清在等什么

- **现象**：横幅大字「等你确认」，副行「等你回答」，两行几乎同义（截图 `docs/float-waiting.png` 就是这样），用户看了仍不知道到底在等你确认哪个工具/哪一步。
- **位置**：
  - `debug/float.html:1062-1064` `showFlash`：waiting 时 `t.textContent = '等你确认'`，`sub.textContent = text`。
  - `debug/float.html:1028-1030`：waiting 的 `text` 来自 `snap.tools.length > 0 ? '等你确认' : '等你回答'`。
- **用户影响**：占了两行位置却没提供新信息。恰恰在需要用户决策的时刻，最关键的信息（等的是批准 bash？还是回答一个问题？）缺失。
- **优化方案**：让 waiting 的副行说具体内容——`snapshot()` 里已有 `pending` 的 kind（网页端 `client.template.js:737-739` 会算 `pendingKind`，可一并下发给浮窗），据此显示「等待批准 · {工具}」或「需要选择：{问题摘要}」；拿不到具体信息就单行显示、别放同义副行。
- **优先级**：P2

### 8. 多会话圆点只有 6×6px，鼠标用户点不稳、也认不出是哪台

- **现象**：会话指示灯是 6px 的彩色小点，点击热区就是这 6px；鼠标要精准点中很难。而且它只有颜色和（读屏用）`aria-label`，鼠标悬停没有任何文字说明这是哪个会话、什么状态。
- **位置**：
  - `debug/float.html:393-394` `.dots i { width:6px; height:6px; }`；`:400` 仅 `:hover{transform:scale(1.5)}` 视觉放大，热区不变。
  - `debug/float.html:969` `aria-label` 只服务读屏，无 `title`、无悬停浮层。
- **用户影响**：多会话切换是高频操作，6px 命中率低（Fitts 定律）；颜色对应状态还得靠记忆，鼠标用户没有可读提示。
- **优化方案**：视觉保持 6px，但用 `::before`（或外层 `padding`）把可点击热区扩到 ≥18×18px，不影响 132px 布局；给每颗点加 `title`（如「洗涤中 · 会话 a1b2c3d4」）。要更完整可右键圆点弹会话小菜单（复用第 3 条的会话切换菜单）。
- **优先级**：P2

### 9. 小尺寸下次级文字 10px 且对比不足，极简档又完全没有文字

- **现象**：停靠条副行（计时/件数/工具）是 10px，颜色回退值 `#8f9ba8` 在浅色条上对比约 2.8:1，达不到 WCAG AA 的 4.5:1；窗口 <520px 时整段文字被隐藏，只剩一台小机器。
- **位置**：
  - `src/style.css:219-227` `.dw-t2 { font-size:10px; color:var(--dw-t2); }`；`src/style.css:22` `--dw-t2: var(--dsw-alias-label-secondary, #8f9ba8);`。
  - `src/style.css:242-243` 窄档（≤719）`dw-t2` 仍 10px。
  - `src/style.css:251-254`（≤519）`.dw-text { display:none; }`，文字全隐。
- **用户影响**：产品专门要求 32px 小尺寸可读，但最关键的时间/件数恰恰是 10px 低对比灰字；极简档直接把"洗到哪"的文字证据删掉，只剩需要会看机器造型才能猜。
- **优化方案**：`dw-t2` 提到 11px，颜色改用保证 ≥4.5:1 的更深次级 token（如 `#5c6875`，或依赖宿主 `label-secondary` 时校验一次对比）；极简档至少在 `:hover`/`:focus` 时以浮层或 `title` 补出完整状态（当前 `title` 已有完整串，可考虑悬停时可见地展示）。不要求恢复被删的大卡片，只让最小档仍能读到状态词。
- **优先级**：P2

### 10. README 说「双击切换鼠标穿透」，但代码早已移除双击入口，用户会以为坏了

- **现象**：README「悬浮窗」一节仍写「**双击**切换鼠标穿透」，而实际实现因为"整机可拖、拖拽区吞 dblclick"把入口移到了设置页，双击没有任何反应。
- **位置**：
  - `README.md:359` "**双击**切换鼠标穿透（穿透时半透明，点击落到下面应用）"。
  - 实际：`src/client.template.js:337`、`src/client.template.js:1279-1282`（注释："双击进穿透…拖拽区会吞掉 dblclick…入口挪到设置页"）；`electron/main.cjs:978-979`；`debug/float.html:130`（"别往这层挂双击"）。
  - 同在 README：`:245` 和 `:360` 已正确写"设置页/右键菜单 + ⌥⌘W 恢复"，与 `:359` 自相矛盾。
- **用户影响**：用户按文档双击没反应，第一反应是"插件坏了/没生效"，是纯粹的文档误导（不要求恢复双击——拖拽区冲突是硬约束）。
- **优化方案**：把 `README.md:359` 改为"在设置页或右键菜单切换鼠标穿透；穿透后 `⌥⌘W` 恢复"，与 `:245`/`:360` 统一。属文档修正，不涉及源码。
- **优先级**：P2

---

## 刻意舍弃的功能，不要重提

以下都是产品**有意**去掉的，评审中不当作缺陷报（README 已写明理由）：

- **ETA / 预计剩余时间**：结构性估不准，给错的时间比不给更糟（README「为什么没有预计剩余时间」；代码 `src/client.template.js:910-914`）。不要再建议加回。
- **S / M / L 三档可展开卡片**（含工具流水、token、成本）：已整体删除，只保留小停靠条（`src/client.template.js:868-875`）。详情去悬浮窗右键「查看详情」或详情面板看。
- **reduce-motion 三态设置**（跟随系统/始终减弱/不减弱）：改为只跟随系统 `prefers-reduced-motion`，不再给独立三态开关（`locale/zh.json:6-10`）。
- **Windows 支持 / 非 macOS 的整节悬浮窗设置**：0.6.2 已撤回，非 macOS 平台整节隐藏（`src/client.template.js:1075` 的 `overlayReason !== 'platform'` 门控）。
- **双击切换鼠标穿透**：如第 10 条，是"整机可拖"与"dblclick 被拖拽区吞掉"的硬冲突下**有意移除**的，入口迁到设置页；只需修文档，**不要建议恢复双击**。

---

## 一句话总览（给 Lead）

- **P0**：`washer:notify` 缺 `waiting` 分支 → 三大叫人时刻里最需要动手的「等你确认」永远不弹系统通知（`electron/main.cjs:1066-1079`）。
- **P1 重点**：多会话只对当前显示会话报警（`float.html:1012-1042` + `index.js:1267-1310`）；溢出会话 `+N` 不可点（`float.html:411-419`）；`role=status` 每秒刷读屏（`client.template.js:534-545`）；overlay 全程「启动中」（`:1165-1167`）；位置记忆不校验显示器（`main.cjs:316-322,447-448`）。
- **P2**：等你确认横幅两行同义、圆点 6px 热区、10px 次级文字对比、README 双击说明过期。

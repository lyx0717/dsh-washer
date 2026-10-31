# dsh-washer 功能评审：功能优化 + 新功能建议

- 评审对象：`@lyx0717/dsh-washer` v0.7.4（`index.js` host 半、`src/core.js` 状态机、`src/client.template.js` 前端座位、`electron/main.cjs` + `debug/float.html` 桌面浮窗）。
- 评审方法：三名评审分头精读 + Lead 逐条回原文核对 `file:line`（本文所有行号均已在本仓库当前代码上 `read`/`grep` 复核，`CODE_REVIEW.md` 曾出过假阳性，故一律以原件为准）。
- 与 `CODE_REVIEW.md`（v0.7.2）的边界：那份只覆盖**可维护性/可读性/简洁性**（抽函数、拆 `apply`、状态常量对象化等）。本文只谈**用户可感知的功能/体验**，不重复其纯结构重构项。
- **刻意舍弃、不再重提**（README 已写明理由，评审中不当缺陷报）：ETA 预计剩余时间、S/M/L 三档可展开卡片、reduce-motion 三态独立开关、Windows 支持、双击切换穿透。
- 结论先行：**最严重的是 1 个状态正确性硬伤（P0）——纯文本轮次里桌面浮窗永远停在「启动中」，且和网页 dock 显示两个状态**；其次是「通知口径在 waiting 上不一致」「多会话漏报」「浮窗健壮性（穿透/换屏）」三类 P1。新功能里最该先做的是补齐定位三大时刻里唯一没实现的「卡住主动提醒」。

---

## 一、功能优化（现有功能的体验与实现缺陷）

### A. 状态正确性（最优先）

| 优先级 | 问题 | 一句话 |
|---|---|---|
| **P0** | 纯文本轮浮窗卡「启动中」，与 dock 分叉 | node-kind 白名单不匹配，`spinning` 恒不可达 |
| P1 | 桌面浮窗永远不显示「排水/整理中」 | 宿主硬编码 `trajectory: undefined`，`draining` 死路 |

**P0-A1　纯文本轮次里浮窗永远停在「启动中」，且与 dock 状态分叉**
- 现象：Agent 当前 turn 没有工具调用（纯问答/纯推理/最后一条是 assistant 文本）时，桌面浮窗一直显示「启动中/进水」，直到 turn 结束才跳「完成」；而同一会话在 web dock 上是正常转动/脱水的——同一时刻两处显示两个状态。
- 根因：`index.js:554` 折叠 assistant 消息时写 `{ kind: 'assistant-message', ... }`，但纯状态机白名单 `src/core.js:30-33` 的 `OUTPUT_NODE_KINDS` 只有 `'assistant'`、**没有 `'assistant-message'`**；`deriveState` 在 `src/core.js:349-352` 把不认识的 kind 判为 `'starting'`，`'spinning'` 永远走不到。连带 `src/core.js:344` 的 `partial != null → washing` 在宿主路径上是**死分支**（`state.partial` 全仓库只在 `index.js:165/424/464/490/553/562` 被赋 `null`，从无非空来源）。
- 影响：命中产品命门「状态不许撒谎」，且是**最常见交互（一次普通文字回复）上的 100% 错误**，还让 dock 与浮窗互相矛盾。
- 修法（二选一，推荐 2）：① 把 `index.js:554` 的 `kind` 改成 `'assistant'`（与 dock 的 useChat 节点口径一致）；② 在 `src/core.js:30-33` 的 `OUTPUT_NODE_KINDS` 加 `'assistant-message'`（更稳，不影响其它调用方）。同时决定 `partial` 去留：要么接入流式增量真正驱动 washing，要么删掉 `src/core.js:344` 死分支。补单测：`foldEvent(assistant/message)` 后 `deriveState` 必须是 `spinning`；纯文本 turn 断言不出现与 running 不符的静止态。

**P1-A2　桌面浮窗永远不显示「排水/整理中（draining）」**
- 现象：状态表（README 列了 draining）里的排水态，在桌面浮窗上永远不会出现。
- 根因：`index.js:1197` 的 `deriveInputOf` 里 `trajectory` 被硬编码为 `undefined`（`index.js:1208`），而 `deriveState` 判 `draining` 依赖 `compactionRunning(trajectory)`（`src/core.js`）；没有 trajectory 就永远检测不到 compaction。
- 修法：宿主把真实的 trajectory/compaction 信号接进 `deriveInputOf`；若确定桌面形态拿不到该信号，则从 README 状态表里去掉 draining，避免文档承诺了实现给不出的状态。
- 关联（顺手清）：`index.js:1303-1318` 仍在算并下发 `typicalMs`/`remainingMs`，但 README「没有 ETA」已删该功能——属于死输出，一并删除，减少快照噪音。

### B. 通知与多会话（漏报）

| 优先级 | 问题 | 一句话 |
|---|---|---|
| P1 | 「等你确认」不弹系统通知 | 页面发了 waiting，主进程只 playSound 吞掉 |
| P1 | 多会话只对「当前显示会话」报警 | 后台会话 done/error/waiting 全静音 |
| P2 | 后台会话指示灯延迟/漏报 | push 去重签名漏了 sessions 维度 |

**P1-B1　「等你确认」是三大叫人时刻里最需动手的一个，却永远不弹系统通知（实现/文档不一致，需决策）**
- 现象：用户开了「洗完通知」后，洗完了/出故障了都会弹系统通知；但 Agent 停在「等你确认」时系统通知一次都不弹（只有默认关闭的音效）。离开座位回来才发现任务早卡在等你拍板。
- 根因：`electron/main.cjs:1066-1079` 的 `washer:notify` handler 先 `playSound(kind)`，随后只有 `if (kind === 'done') notify(...)` / `else if (kind === 'error') notify(...)`，**缺 waiting 分支**；而 `debug/float.html:1025/1031` 确实以 `kind='waiting'` 发 IPC，`:1032-1041` 注释还写「横幅和系统通知同时出」。文档也两说：`README.md:246` 写通知「只报完成和故障」，`:247` 又写音效含「等你确认」。
- 判定：`README.md:246` 表明「只报完成/故障」可能是**刻意取舍**，故不按 P0 缺陷算；但「页面发、主进程丢、文档两说」是**确定的实现/文档不一致**，必须收口。
- 修法（二选一，别维持现状）：① 在 `electron/main.cjs:1066` 补 `else if (kind === 'waiting') notify('等你确认', text || '需要你拍板');`，给独立节流（如 30s）或独立开关，至少窗口不在前台（`!win.isFocused()`，`notify` 已有该判断）时必须发；② 若确认「只报完成/故障」是有意为之，就删掉 `float.html:1032-1041` 对 waiting 的通知期待、改齐 `README.md:246`，并接受「waiting 只有窗口内 1.8s 横幅」。

**P1-B2　多会话时只对「当前显示的那个会话」报警**
- 现象：同时跑 2–3 个 Agent，只有当前显示的会话完成/故障/等你会弹横幅+响+通知；其它会话这三态全静音，只有一排圆点变色。
- 根因：`debug/float.html:1012-1042` 的 `maybeNotify(snap)` 只读 `snap.state`（顶层=当前视图会话）；`index.js:1267-1360` 的 `snapshot()` 顶层 `state` 只取 `viewSessionId()`（`index.js:1230-1233/1294/1310`），其它会话只在 `:1355` 的 `sessionSummaries` 数组里。
- 修法：`maybeNotify` 改为按会话检测边沿——维护 `Map<sessionId, lastState>`，遍历 `snap.sessions`，任一非当前会话跳进 done/error/waiting 就 `host.notify` + `showFlash`，文案带会话短 id；或在 `snapshot()` 里直接算一个 `alert` 字段下发，前端只播，避免两边各存一份「上次状态」。

**P2-B3　后台会话指示灯延迟/漏报（push 去重签名漏会话维度）**
- 根因：`index.js:1421-1428` 的 `pushNow` 去重签名不含 `sessionId`/`pinnedSessionId`/`sessions` 数组；`ensureTick`（`index.js:1513-1554`）每 500ms 只跟 `viewSessionId`（`:1517`），不遍历后台会话；`/pin`（`index.js:1664-1682`）用非强制 `schedulePush`。
- 修法：把 `sessions` 概览折进签名（如 `sessions.map(s=>s.sessionId+':'+s.state).join(',')`）并加 `sessionId`/`pinnedSessionId`；`/pin` 改 `schedulePush(true)` 强制推一次。

### C. 浮窗健壮性

| 优先级 | 问题 | 一句话 |
|---|---|---|
| P1 | 鼠标穿透开不了 + 偏好文件 400ms 无限回写 | 快捷键注册失败时不回写文件，watchPrefs 每 400ms 重试成死循环 |
| P1 | 换屏/改分辨率后浮窗整窗跑到屏外 | readPosition 零边界校验，启动不校正 |

**P1-C1　鼠标穿透开不了 + 偏好文件被 400ms 无限回写（磁盘连写/POST 环）**
- 现象：勾选「鼠标穿透」后实际没穿透、开关可能反复跳回「关」；后台持续 400ms 写一次文件+POST 一次 host。触发条件：逃生键 `⌥⌘W` 被别处占用导致 `globalShortcut.register` 返回 false。
- 根因：`electron/main.cjs:393-412` `setClickThrough` 先 `writeFloatPrefs({clickThrough:true}) + notifyHost(...)`，再 `updateEscapeShortcut()`；后者（`main.cjs:427-445`）注册失败时只把内存 `clickThrough=false`、`setIgnoreMouseEvents(false)`，**不回写文件也不 notifyHost**；`watchPrefs`（`main.cjs:949-1001`，每 400ms `fs.watchFile`）读到文件仍是 true（`:982/995`）→ 再 `setClickThrough(true)` → 又失败 → 永不收敛。
- 修法：注册失败分支里必须 `writeFloatPrefs({clickThrough:false}) + notifyHost({clickThrough:false})`，把失败落盘终止环路；或 `setClickThrough` 先调 `updateEscapeShortcut()` 确认逃生键可用再决定是否持久化（让 `updateEscapeShortcut` 返回布尔）。

**P1-C2　换显示器/改分辨率后浮窗整窗跑到屏幕外（看不见、点不到）**
- 现象：上次在副屏拖到某处，拔掉副屏或改分辨率再启动，浮窗完全在屏幕外，用户以为没起来，右键菜单也够不到，只能手删配置文件。
- 根因：`main.cjs:316-322` `readPosition()` 直接返回 `{x,y}` 无边界校验；`createWindow`（`main.cjs:447-448/450-454/481-494`）原样使用不校正；`snapToEdges`（`main.cjs:333-358`）只在距边 ≤24pt 时吸附、启动流程不调。
- 修法：建窗前用 `screen.getDisplayMatching({x,y,width,height})`（或 `getAllDisplays`）命中校验，不在任何 `display.workArea` 内则 clamp 回 `defaultPosition`；`snapToEdges` 增加「远离所有屏 → 拉回」兜底；监听 `display-removed`/`display-metrics-changed` 再校正。

### D. 交互、可达性与无障碍

| 优先级 | 问题 | 一句话 |
|---|---|---|
| P1 | 第 4+ 会话「+N」看得到点不到 | 折叠会话在浮窗上不可达 |
| P1 | 读屏每秒播报 | `role=status` 套在带秒表的整条上 |
| P2 | overlay 全程「启动中」 | 文案复用了 starting，语义错 |
| P2 | 「等你确认」横幅两行同义 | 占了位置没说清在等什么 |
| P2 | 圆点 6px 热区太小 | Fitts 定律，点不稳 |
| P2 | 小尺寸次级文字 10px 低对比 | 关键计时看不清 |

- **P1-D1　第 4 个及以后会话彻底不可达**：`debug/float.html:935` `MAX_DOTS=3`，`:978-985` 溢出追加的是 `<span class="more">+N</span>` 无 `role=button`/无点击（`:411-419` 还 `pointer-events:none`）。多会话下被折叠的会话若正「等你确认/出故障」，浮窗上点不到。修法：`+N` 做可用入口（`role=button`、`pointer-events:auto`、点击弹会话切换菜单，菜单复用 `main.cjs:897 showMenu` 的 Menu，新增 IPC `washer:show-session-menu`，点击 POST `/dsh-washer/pin`）。
- **P1-D2　读屏用户被状态条计时每秒播报**：`src/client.template.js:534-545` `StripBar` 根 `role='status'`（:537）+ `aria-label` 含 `sub`（:538，`sub` 带 `{elapsed}` 每秒变，:847-853 每秒 tick）。修法：live region 只包状态标题 `dw-t1`，计时/副标题加 `aria-hidden`，只在 state 变化时播报。
- **P2-D3　网页 overlay 全程「启动中」**：`src/client.template.js:1165-1167` `state = pending!=='waiting':'starting'`、`title = tr('state.'+state)`、`:133` `'state.starting'='启动中'`。不猜细分是对的，但文案不该复用 starting。修法：加中性忙碌词 `overlay.busy`（「处理中/在忙」），造型仍复用 starting 动画。
- **P2-D4　「等你确认」横幅两行同义**：`debug/float.html:1062-1064` 大字「等你确认」、副行 `text` 在 `snap.tools.length>0 ? '等你确认' : '等你回答'`（`:1028-1030`），常常两行同义。修法：把 `pending.kind` 下发给浮窗，副行显示「等待批准 · {工具}」或「需要选择：{问题摘要}」；拿不到就单行。
- **P2-D5　多会话圆点 6×6px 热区小**：`debug/float.html:393-394` `.dots i{width:6px;height:6px}`、`:400` 只 `:hover` 视觉放大热区不变、`:969` 只有读屏用 `aria-label` 无 `title`。修法：视觉仍 6px，用 `::before`/`padding` 把热区扩到 ≥18×18px，加点 `title`（状态+会话短 id）。
- **P2-D6　小尺寸次级文字 10px 低对比**：`src/style.css:219-227` `.dw-t2{font-size:10px;color:var(--dw-t2)}`、`:22` 回退 `#8f9ba8`（浅色条约 2.8:1，未达 AA 4.5:1）、`:251-254`（≤519 宽）`.dw-text{display:none}` 文字全隐。修法：`dw-t2` 提到 11px、换 ≥4.5:1 的更深次级 token；极简档至少 hover/focus 用浮层或 `title` 补出完整状态词。

### E. 遗留小问题（可随手带）

- **P2-E1　running「复活」逻辑失效（待验证）**：`index.js:2065` 的 `before = state.nodes` 存的是数组引用，`pushNode`（`index.js:303-307`）原地 `push`，同 turn 内 `state.nodes === before` 恒 true，使 `index.js:2072` 的条件退化为 `if (state.running)`；叠加 `agent/status`（`index.js:2104`）把 running 置 false，可能漏报。修法：用 `state.rev++` 或 foldEvent 返回「是否有变化」布尔来决定置 running=true。验证：打点同 turn 内 running 被置 false 后后续事件是否恢复。
- **P2-E2　审批中途关 dock → 永久「等待确认」+ clientPending 泄漏**：`clientPending`（`index.js:1146`）无 TTL、`session/disposed`（`index.js:2086-2095`）不清，且 `pendingFor` 里它优先级最高（reported-wins）。修法：加 ~30s TTL，过期跳过；`session/disposed` 里 `delete`。
- **P2-E3　切会话瞬间用旧会话颜色（待验证）**：`settleState`（`index.js:1371-1400`）用模块级全局 `shownState` 而非按 `sessionId`。修法：按 `sessionId` 维护 `shownBySession`，或会话切换时跳过 hold 判定。
- **P2-E4　README 文档过期**：`README.md:359`「双击切换鼠标穿透」已过期（实际因整机可拖、拖拽区吞 dblclick，入口移到设置页/右键菜单 + `⌥⌘W` 恢复，见 `README.md:245/360` 自身已写对）。属文档修正，不恢复双击。

---

## 二、新功能建议

定位三时刻：**洗完 / 卡住 / 等你确认**。现状：洗完、故障、等你确认都有通知入口（waiting 见 B1 的缺口）；**「卡住」只把副标题换成「卡住 mm:ss」，从不主动叫人**——这是定位最明显的缺口，列 P0。以下全部只读宿主信号、符合洗衣机隐喻、零依赖、最简实现。

| 优先级 | 功能 | 信号来源 | 复杂度 |
|---|---|---|---|
| **P0** | 1 卡住主动提醒（补齐三时刻的「卡住」） | `snapshot.stalledMs`（`stalledForOf`，45s 实测） | 小 |
| P1 | 2 洗完「完成小结」（通知带 耗时·工具数） | `snapshot.durationText/toolCount` | 小 |
| P1 | 5 故障一句话人话解释+建议 | `snapshot.errorCode` + locale 映射 | 小 |
| P1 | 4 卡住时显示卡在哪工具 | `core.activeTool` 导出进 `snapshot` | 小 |
| P1 | 3 等你确认的「二次提醒」 | `state==='waiting'` 持续时间 | 小 |
| P1 | 6 tiny 档关键时刻别只剩一颗灯 | state 边沿（已有） | 中 |
| P2 | 7 洗衣记录（最近 N 轮耗时/结果） | `turnTimings` + `nodes` | 中 |
| P2 | 8 本会话累计用量 | `turn/end` 累加 `tokenUsage` | 中 |
| P2 | 9 勿扰/安静模式 | 新偏好 `dndPref` | 小 |

**功能 1（P0）卡住主动提醒**
- 痛点：定位写「洗完/卡住/等你确认」主动叫人，但代码里只有 `done/error/waiting` 弹通知；`stalledMs>0` 只把计时格换成「卡住 mm:ss」（`debug/float.html` 的 `durationOf`），**不弹不响**。跑长活去吃饭，回来发现工具 30 分钟前就没进展，机器一直"在洗"却没人叫。
- 实现：① `float.html` 的 `maybeNotify`（`:1012-1042`）加「卡住边沿」：`stalledMs` 由 0/null 变为 >0 时 `host.notify('stalled', text)` + `showFlash`，用 `stalledNotifiedTurn` 按 `snap.turn` 去重，一轮只提醒一次；② `electron/main.cjs:1066-1078` 加 `kind==='stalled'` 分支（`playSound` + `notify('卡住了', …)`）；③ dock 无 Electron，在 `client.template.js` 的本地 STALL 逻辑里把停靠条 `tone` 提到警示色即可。复用现有 `desktopOverlayNotify` 开关，不新增配置。
- 风险：45s 阈值对长构建可能误报 → 只提醒一次、文案标「可能只是有点慢」。

**功能 2（P1）洗完「完成小结」**：done 通知现在只有「用时 3:20」。用 `snapshot` 里现成的 `durationText/toolCount/tokenUsage.total/model` 纯前端拼「用时 X · N 个工具」，`showFlash` 副标题同步，系统通知 body 复用同一 `text`，主进程不改。浮窗仅 132px 宽，只留时长+工具数，token/模型放详情。

**功能 5（P1）故障一句话人话解释**：`core.errorCodeOf` 已产 E-xx、`snapshot.errorCode` 已在。`locale/zh.json`+`en.json` 新增 `errorCode` 段：E-10 账号/模型不可用→重登或换模型；E-20 工具失败→可重试；E-21 审批被拒；E-30 上下文超长→清理再试；E-40 中断；E-50 策略拦截。error 副标题/横幅/详情用它替换裸 code，原 code 留在 `title`。

**功能 4（P1）卡住时告诉卡在哪工具**：`core.activeTool(runningCalls)` 已有，但 `snapshot()` 没导出。加 `activeTool: activeTool(s.runningCalls)`；卡住分支副标题拼「卡在 {toolActionOf(name)} · {dur}」。模型空转时 `activeTool===null` 就退回只显示时长。

**功能 3（P1）等你确认的二次提醒**：waiting 现在只在跳进那一刻响一次，用户离开/戴耳机就错过。用「waiting 持续时长」信号，记录 `waitingSince`，超过阈值且本轮未再提醒就再 `host.notify('waiting','还在等你确认')` 一次。新增 `desktopOverlayWaitingRemindMs`（0=关，默认 0 或 180000）。

**功能 6（P1）tiny 档关键时刻别只剩一颗灯**：`showFlash` 在 tiny 直接 `return`（`debug/float.html:1055`），开 tiny 的人几乎收不到三大时刻视觉信号。改成 tiny 时也放一个极小角标/短闪（不展开整气泡），或临时把 tiny 切 normal 几秒再切回（注意窗口定位不抖）。

**功能 7/8/9（P2）**：7 洗衣记录——`snapshot()` 增加最近 5–10 轮 `history:[{turn,ms,ok}]`（`turnTimings` 起止差 + `findTurnError`），详情新增一节；8 累计用量——`turn/end` 时把该轮 `tokenUsage`/`toolCount` 累加进 session 级 `cumulative`；9 勿扰——加 `dndPref`，`main.cjs` 的 `notify()`/`playSound()` 入口先判，只静音声音+系统通知、保留浮窗视觉。

---

## 三、建议落地顺序

1. **先止血（P0/P1 真 bug，1 天内可收）**：A1 修 node-kind（1 行 + 单测）、B1 收口 waiting 通知口径、C1 穿透回写环、C2 换屏越界。
2. **第一批新功能（P0）**：功能 1「卡住主动提醒」——补定位最大缺口，信号现成、改 `float.html`+`main.cjs` 两处小分支。
3. **P1 快赢（纯读展示增强）**：功能 2/5/4 + D1 `+N` 可达 + D2 读屏——几乎零风险。
4. **P1 体验补强**：功能 3 二次提醒、功能 6 tiny 提示、B2 多会话报警、A2 draining/清死输出。
5. **P2 锦上添花**：功能 7/8/9 + D3–D6 + E 类清尾。

> 说明：本文为只读评审，未改动任何项目源码；三条底层明细见同目录 `defects.md`、`ux.md`、`new-features.md`。行号均对应当前仓库代码。

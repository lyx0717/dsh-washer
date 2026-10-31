# dsh-washer 功能实现缺陷评审（用户可感知）

> 评审范围：`index.js`（host 半）、`src/core.js`（纯状态机）、`electron/main.cjs`、`electron/preload.cjs`。
> 只报「用户会遇到什么」的功能/边界缺陷，不重复 `CODE_REVIEW.md` 里的纯结构重构（抽函数、拆 apply、状态常量对象化等）。
> 行号均为本人在本仓库当前代码上 `read`/`grep` 亲自核实。
> 复现/验证脚本未落地到仓库（只读评审），文中给出可独立复跑的方法。

结论：共 7 条，按优先级排序（P0 → P2）。其中 3 条带「待验证」，已给出验证方法。

---

## P0-1　纯文本轮次里浮窗永远停在「启动中」，且与 dock 状态分叉

**现象 / 触发条件**
- Agent 回复里只要当前 turn 没有工具调用（纯问答、纯推理、或最后一条消息是 assistant 文本），浮窗状态就一直是「启动中 / 进水」，直到 turn 结束才跳到「完成」。
- 更严重：同样的会话在 **web 主界面 dock** 上是正常转「脱水/转动」的，**浮窗和 dock 同一时刻显示两个不同状态**。用户会以为浮窗坏了或数据不同步。

**根因（精确行号）**
- host 侧在 `index.js:554` 折叠 assistant 消息时写的是 `{ kind: 'assistant-message', turn, model }`。
- 纯状态机白名单 `src/core.js:30-33` 的 `OUTPUT_NODE_KINDS` 里**只有 `'assistant'`，没有 `'assistant-message'`**。
- `deriveState` 在 `src/core.js:349-352`：`if (last === undefined || !OUTPUT_NODE_KINDS.has(last.kind)) return 'starting';`，于是 `assistant-message` 被判为 `starting`，永远走不到 `spinning`。
- 连带：`deriveState` 的 `partial != null → 'washing'`（`src/core.js:344`）在 host 路径上是**死分支**——`state.partial` 全仓库只在 `index.js:165/424/464/490/553/562` 被赋 `null`，从没有任何事件把它置为非空。
- 直接证据（已跑）：`node` 脚本折叠 `turn/start`→`starting`、`tool/call`→`rinsing`、`tool/result`→`washing`、`assistant/message`→`starting`（期望 `spinning`）。纯问答：`turn/start` 之后一直是 `starting`。

**用户影响（严重度：高）**
- 产品命门是「状态不许撒谎」。这是最常见交互（一次普通文字回复）上的 100% 错误，并且造成 dock 与浮窗两套显示互相矛盾，直接击穿核心可信度。非崩溃，但属于正确性硬伤。

**修复方案（具体到函数/做法）**
- 二选一，推荐后者并补测试：
  1. 把 `index.js:554` 的 `kind` 改成 `'assistant'`（与 dock 的 useChat 节点口径一致）；或
  2. 在 `src/core.js:30-33` 的 `OUTPUT_NODE_KINDS` 里加入 `'assistant-message'`（更稳，不影响其它调用方）。
- 同时决定 `partial` 的去留：要么接入流式增量事件（如 delta）真正驱动 `washing`，要么删掉 `src/core.js:344` 的死分支，避免下一个维护者误以为有流式能力。
- 补单测（`test/host.test.mjs`）：`foldEvent(assistant/message)` 后 `deriveState` 必须是 `spinning`；再断言「纯文本 turn 全程不得出现 `starting` 之外的静止态」。

**优先级：P0**

---

## P1-2　穿透（click-through）开不了 + 偏好文件被无限回写（磁盘连写/通道卡死）

**现象 / 触发条件**
- 用户在设置里勾选「鼠标穿透」后，实际**没有穿透**，浮窗还在拦截点击；同时设置页里这个开关可能反复跳回「关」。
- 触发条件是「救命绳」`Alt+CommandOrControl+W` 被系统/其它 App 占用（`globalShortcut.register` 返回 false），导致注册失败。

**根因（精确行号）**
- `electron/main.cjs:393-412` `setClickThrough(on)`：先 `writeFloatPrefs({clickThrough:true}); notifyHost({clickThrough:true});`，然后 `updateEscapeShortcut()`。
- `electron/main.cjs:427-445` `updateEscapeShortcut()`：注册失败时（`ok===false`）把内存 `clickThrough=false`、`win.setIgnoreMouseEvents(false)`，但**没有回写偏好文件、也没有 notifyHost 纠正**，导致「文件里=true / 内存里=false」长期不一致。
- `electron/main.cjs:949-1001` `watchPrefs()`：每 400ms `fs.watchFile`，读到 `nextThrough===true`（`main.cjs:982`）而内存是 false → 再次 `setClickThrough(true)`（`main.cjs:995`）→ 又注册失败 → 又 revert。**这是一个持续 400ms 一次、永不收敛的写盘 + notifyHost 回环**。

**用户影响（严重度：高，触发条件少见但一旦触发持续）**
- 穿透功能实际不可用（与 UI 勾选状态不符）；浮窗设置与配置文件长期不一致；后台每 400ms 写一次文件并 POST 一次 host，造成持续磁盘/网络/日志噪音，笔记本上耗电可感知。这是「状态撒谎 + 资源泄漏」的组合。

**修复方案（具体到函数/做法）**
- 在 `updateEscapeShortcut()` 注册失败分支里，除了把内存 `clickThrough` 复位，**必须 `writeFloatPrefs({clickThrough:false})` 并 `notifyHost({clickThrough:false})`**，把失败落盘，环路自然终止。
- 或者在 `setClickThrough(on)` 里把顺序反过来：先 `updateEscapeShortcut()` 确认逃生快捷键可用，再决定是否真的进入穿透并写盘。
- 建议 `updateEscapeShortcut` 返回布尔，`setClickThrough` 依据返回值决定是否持久化，避免「先写 true 再 revert」。
- 附带：`watchPrefs` 可加一个「本进程最后写入值」比对来短路自写回跳（与 R7 思路一致，但这里是功能必要性而非纯结构）。

**优先级：P1**

---

## P1-3　换显示器 / 改分辨率后，浮窗整窗跑到屏幕外（看不见、点不到）

**现象 / 触发条件**
- 前一晚在副屏/外接显示器上把浮窗拖到某个位置；第二天拔掉外接屏或改分辨率再启动，浮窗**完全消失**（在屏幕外），用户以为它没起来。
- 触发：窗口保存的坐标在「当前所有显示器 workArea 之外」。

**根因（精确行号）**
- `electron/main.cjs:316-322` `readPosition()` 直接返回文件里的 `{x,y}`，**没有任何显示器边界校验**。
- `electron/main.cjs:448` + `450-454` `createWindow()` 用该坐标建窗；`481-494` `ready-to-show` 只按 `visible` 决定 show/hide，**同样不做离屏校正**。
- `electron/main.cjs:333-358` `snapToEdges()` 只在窗口距某显示器边缘 `≤ SNAP_DISTANCE(24)`（`main.cjs:330`）时才吸附，**离屏很远时完全不拉回**；且它只在 `moved` 事件（`main.cjs:524-527`）和 `setVisible(true)` 时调，启动流程不调。

**用户影响（严重度：高）**
- 多显示器/改分辨率是 macOS 笔记本高频场景，一旦命中就「浮窗起不来」，用户无从下手（菜单栏图标也未必好找），只能手删配置文件。

**修复方案（具体到函数/做法）**
- 在 `createWindow()` 建窗前对 `pos` 做 `screen.getAllDisplays()` 命中校验：若 `(x,y)` 不落在任何 `display.workArea` 内（考虑窗口尺寸），回退 `defaultPosition()`。
- 或在 `readPosition()` 里就做校验并返回 `null`（让上层走默认位）。
- `snapToEdges()` 增加「远离所有显示器 → 拉回主屏右上角」的兜底分支，而不只是近距离吸附。
- 建议同时监听 `screen` 的 `display-removed`/`display-metrics-changed` 事件重校验窗口位置（当前未注册，可加）。

**优先级：P1**

---

## P1-4　running 状态「复活」逻辑失效：某些事件不会把机器重新点亮（待验证）

**现象 / 触发条件**
- 会话在运行中，但中间若 `state.running` 一度为 false（例如 `agent/status` 收到非 `running` 的状态、或事件乱序/重投），后续同 turn 的 `tool/call`、`assistant/message` 等事件**无法把浮窗重新点亮**，机器停在 idle/静止，直到下一个 `turn/start`。

**根因（精确行号）**
- `index.js:2065` `const before = state.nodes;` 保存的是**数组引用**；`foldEvent` 里 `pushNode`（`index.js:303-307`）是 `state.nodes.push(...)` **原地修改同一数组**，所以同 turn 事件后 `state.nodes === before` **恒为 true**（只有 `beginTurn` 在 `index.js:441` 重新赋值 `state.nodes = []` 才会变）。
- 于是 `index.js:2072` 的 `if (state.running || state.nodes !== before) state.running = true;` 对同 turn 事件退化为 `if (state.running)`，**等于没写**。
- 叠加 `agent/status` 处理 `index.js:2104`：`state.running = status === 'running'`，任何非 `running` 状态都会把 running 置 false。

**用户影响（严重度：中高，取决于 host 是否在 turn 中途发非 running 状态）**
- 命中时浮窗「该转不转」，明明 Agent 在干活却显示静止，属于漏报。**待验证**：host 在活跃 turn 中途是否会发出非 `running` 的 `agent/status`。

**验证方法**
- 在 `index.js:2060-2074` 打点：打印每个 `session/event` 时 `state.running`、`event.type`、`state.turn`；同时打印 `agent/status` 的 `status` 取值（`index.js:2097`）。
- 用真实多轮工具会话跑一遍，若出现「同 turn 内 running 被置 false 且后续事件未恢复」，即确认。
- 也可直接单测：构造 `state.running=false`、`turn` 已存在，喂一条同 turn `tool/call`，断言 `running` 变为 true（当前会失败）。

**修复方案**
- 不要用数组引用比较。让 `foldEvent` 返回「是否有实质变化」布尔（或维护 `state.rev++` 计数器），`subscribeEvents` 依据 `rev` 变化置 `running=true`。
- 或显式：除 `turn/end` 外，凡落入已知事件类型都 `state.running = true`，并靠 `data.turn` 单调性防旧事件回拨。
- `agent/status` 只在明确的终态（如 `idle`/`complete`）才置 false，且不要覆盖正在进行的 turn。

**优先级：P1（若验证为中高影响可上 P0）**

---

## P2-5　后台会话的指示灯/完成态延迟或缺失：push 去重签名漏了会话维度

**现象 / 触发条件**
- 多会话并行时，**非当前显示会话**的状态变化（如后台会话进入 error/waiting/done）不会立刻刷新浮窗上那一排指示灯，要等当前会话恰好也发生一次签名变化才更新。
- 点击指示灯 pin 到某会话后，画面切换可能延迟（`/pin` 用非强制 `schedulePush()`）。

**根因（精确行号）**
- `index.js:1421-1428` `pushNow()` 的去重签名 = `[state, turn, toolCount, durationText, errorCode, model, round(speed), tokenSig, stalledMs?1:0]`，**完全不含 `sessionId`、`pinnedSessionId`、`sessions` 数组、`tools` 列表**。若这些变了但签名没变 → `pushNow` 直接 `return`，不发帧。
- `index.js:1513-1554` `ensureTick()` 每 500ms 只按 `viewSessionId()` 判断是否要强制推（`index.js:1517`），**不遍历其它会话**，所以后台会话的紧急态无法触发补推。
- `/pin` 路由 `index.js:1664-1682` 用 `schedulePush()`（非 force），首次 pin 也可能因签名相同被吞。

**用户影响（严重度：中）**
- 多开 agent 时核心卖点「一眼看到哪台在等/出错」会延迟甚至漏掉，用户切走后台的会话出故障看不到。属于漏报而非误报。

**修复方案**
- 把 `sessions` 概览折进签名（如 `snap.sessions.map(s=>s.sessionId+':'+s.state).join(',')`），并加入 `snap.sessionId`/`snap.pinnedSessionId`。
- 或在 `sessionSummaries()` 计算后与上次快照的 sessions 做比较，任一变化即 `schedulePush(true)`。
- `/pin` 改为 `schedulePush(true)`（强制推一次）。

**优先级：P2**

---

## P2-6　审批中途关掉 dock，会话永远卡在「等待确认」+ clientPending 泄漏

**现象 / 触发条件**
- 在 web 端弹出审批/提问、浮窗显示「等待确认」时，用户直接关掉/刷新那个 dock 页面（没有走完审批）。
- 之后该会话在浮窗上**一直显示等待**，即使审批已经不在了；要等有新的同类事件覆盖才恢复。

**根因（精确行号）**
- `clientPending`（`index.js:1146`）只有 `pending` POST 才会 set/delete（`index.js:1942-1951`），**没有 TTL，也没有在 `session/disposed` 里清理**（`index.js:2086-2095` 只删 sessions/currentId/pinnedId）。
- `pendingFor`（`index.js:1174-1175`）里 `clientPending.get(sessionId)` **优先级最高**（"reported wins"），一旦残留就长期压制真实的 approval/question 判定。
- 客户端关闭时不保证发 delete（页面卸载/断网即丢）。

**用户影响（严重度：中）**
- 卡在「等待确认」是误报——用户以为还要处理，实际没了；同时 Map 无界增长（长跑进程内存缓涨）。

**修复方案**
- 给 `clientPending` 每条记录加时间戳，超过 ~30s 未刷新即失效（等待中 dock 应周期性重报）；读取 `pendingFor` 时跳过过期项。
- `session/disposed` 里 `clientPending.delete(sessionId)`。
- 可在 WS/SSE 客户端断开（`onUpgrade` 的 close/`prefClients` 清理）时，清理该客户端名下 pending。

**优先级：P2**

---

## P2-7　切换会话瞬间，颜色/数字用旧会话的（迟滞是全局的，不是按会话）(待验证)

**现象 / 触发条件**
- 从会话 A 切到会话 B（例如 A 在 waiting、B 在 washing），浮窗有最多 ~400ms（`SWITCH_HOLD_MS`）里显示的是 **B 的数据配上 A 的状态色**，再接上 B 的真实状态。

**根因（精确行号）**
- `index.js:1371-1400` `settleState()` 用的是模块级全局 `shownState` / `shownStateAt`，**不是按 `sessionId` 记的**。它只判断「候选状态是否允许切换」，而候选状态里已经换成了 B 的内容，于是出现内容与旧色的短暂错配。

**用户影响（严重度：低-中）**
- 切会话时画面闪一下错误颜色，短促但用户可感知；多会话高频切换时观感更差。

**验证方法**
- 构造 A=`waiting`、B=`washing` 两个会话，来回 pin/触发切换，录制浮窗 1s 内帧序列，确认切换瞬间出现「B 数据 + A 颜色」。
- 或在 `settleState` 打点，打印 `shownState`、`candidate`、`sessionId`，观察切换帧。

**修复方案**
- `settleState` 改为按 `sessionId` 维护 `shownBySession: Map<id,{state,at}>`；当 `viewSessionId()` 变化时对该会话不套用上一个会话的迟滞窗口（或直接重置该会话的 shownState）。
- 或者：会话切换时跳过 `shouldSwitch` 的 hold 判定，直接接受新会话状态。

**优先级：P2**

---

## 附：优先级汇总

| 优先级 | 编号 | 一句话 |
|---|---|---|
| P0 | 1 | 纯文本轮浮窗卡「启动中」，与 dock 分叉（node-kind 白名单不匹配） |
| P1 | 2 | 穿透开不了 + 偏好文件 400ms 无限回写 |
| P1 | 3 | 换屏/改分辨率后浮窗整窗跑到屏幕外 |
| P1 | 4 | running 复活逻辑失效（数组引用比较恒等，待验证） |
| P2 | 5 | push 去重签名漏会话维度 → 后台指示灯延迟/漏报 |
| P2 | 6 | 审批中途关 dock → 永久等待 + clientPending 泄漏 |
| P2 | 7 | 切会话瞬间用旧会话颜色（迟滞全局化，待验证） |

> 说明：以上均未修改项目源码（只读评审）。第 4、7 条标注「待验证」，附了验证方法；第 1、4 条结论有本地 `node` 脚本实测支撑。

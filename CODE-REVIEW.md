# dsh-washer 代码与架构审查

审查范围：仓库全量（index.js 1224 行、client.js 1767 行、src/core.js 426 行、src/client.template.js 1342 行、electron/main.cjs 770 行、debug/*.html、build*.mjs、scripts/*）。基线：0.2.4，`core.test` 29/29 通过，`host.test` 46 项通过（但进程无法自然退出，见 P2-6）。

结论先行：**架构是干净的**——状态核心纯函数化、Host/Client 共用一套判定、偏好的双向同步通道设计明确。真正的问题集中在**边角逻辑的残留**：删除功能时留下的调用点、只在桌面端跑的那条链路上缺失的能力、以及两个进程写同一个文件时的竞态。

> ## 修复进度（第一轮已完成，未提交）
>
> **已修**：S1、S2、S3、S5、D2、D4、D5、D8、U3、U5（部分），外加「浮窗错误码可见」和补全 `err.e20.hint`。
> 测试从 71 项增到 **78 项，全绿**；新增 7 条回归测试逐条钉住本轮修复的行为。
> 下文各条保留**原始判断与证据**（它们解释了为什么，改的时候别把结论改掉），并在条目下补了「**已修**」说明实际做法。
>
> **未修（有意留着）**：S4（`waiting` 需要宿主 `pendingInteraction` 的确定接口，没查证清楚前不动）、D1、D3、D6、D7、U1、U2、U4，以及全部功能类 F1–F6。

---

## 严重 bug（会崩溃 / 功能实际不可用）

### S1 · `reportCorner()` 未定义，浮窗每次切换设置都抛 ReferenceError


> **已修**：删掉了调用点（`debug/float.html` 的 `applyPrefs` 末尾），原位置留注释说明为什么不再需要上报矩形。`grep reportCorner` 现在只剩注释。
**位置**：`debug/float.html:694`（函数体内），全文件无定义。

**实测证据**：
```
ReferenceError: reportCorner is not defined
    at applyPrefs (float.html:176:5)
```
`applyPrefs` 是 `host.onPrefs` 的回调，主进程每次 `setSizeMode` / `setSkin` / `setThemeDark` 都推 `washer:prefs` → 走到这里必抛。

**影响**：
- `applyPrefs` 后半段的 `reportCorner()` 之后的代码不执行——目前它正好是最后一行，所以**当前只表现为控制台报错**；
- 但 `applyPrefs` 前面已经改过 `document.body.dataset.size/skin/theme`，而 `notifyHost` 回传是主进程做的，所以视觉上还看不出来；
- 真正的坑：**任何人在这行之后追加逻辑都会静默失效**，而且未捕获异常会污染 `ipcRenderer` 回调栈。

**根因**：穿透的"可点角落"功能被删除（`main.cjs:271-277` 注释明确写了"那个可点的洞已删掉"），`preload.cjs` 里的 `setCornerRect` 也删了，但页面里的调用点漏了。

**修法**：删除 `debug/float.html:693-694` 两行注释与调用。这是纯粹的死代码，不需要替代实现。

---

### S2 · 桌面悬浮窗永远进不了 `done` 状态


> **已修**：`createSessionState()` 新增 `doneUntil` 字段；`foldEvent` 的 `turn/end` 在没有失败时写 `now + doneHoldMs`，`turn/start` 清零；`snapshot()` 据此返回 `sticky: { kind: 'done', turn, until }`。`doneHoldMs` 从 `cfg.doneHoldMs` 读（和主界面同一个配置项，默认 6000）。
**位置**：`index.js:742` `sticky: null`（恒为 null）。

**影响**：`core.js:328` 的 `if (sticky && sticky.kind === 'done' && now < sticky.until) return 'done';` 在桌面端**恒不成立**。悬浮窗只会在 `idle` 和运行态之间切，README 和设置页宣传的"洗完了 · 绿灯停 6 秒"在浮窗上**一次都不会出现**。

主界面端（`client.js:938`）有完整的 `setSticky({ kind: 'done', turn, until: Date.now() + mergedCfg.doneHoldMs })`，Host 侧没有对应实现。

**这个不是小瑕疵**：浮窗最核心的价值就是"干完了抬头看一眼"，绿勾那一下是唯一的完成信号。

**修法**：在 `createSessionState()` 里加 `doneUntil: 0`；`foldEvent` 的 `turn/end` 分支里 `state.doneUntil = now + doneHoldMs`；`snapshot()` 里按 `now < s.doneUntil` 构造 sticky。`doneHoldMs` 从 `cfg.doneHoldMs` 读（`cordis.patch.yml` 里是 3000，而 `client.js:616` 默认 6000，两处不一致，顺手统一）。

---

### S3 · `turn-error` 节点从未被产生，Host 侧错误态只能靠工具失败


> **已修**：解包宿主 asar 查证后确认——宿主**没有** `turn/error` 事件（原报告猜的「补 case」是错的）。真正的来源是 `turn/end` 的 `data.reason`，`dsh-agent-loop` 保证 `turn/end` 一定带 `reason`。已移植官方 `dsh-client-ui-chat` 的 `endFailure(reason)` 为 `endFailureOf()`，在 `turn/end` 里产出 `turn-error` 节点。E-10/E-30/E-40/E-50 四类从此可达。
**位置**：`index.js:355-368` 的 `hasError` / `lastErrorNode` 会检查 `node.kind === 'turn-error'`，但**全文件没有任何地方 push 这种节点**（`grep turn-error index.js` 只有这两处读取）。

**影响**：模型侧失败——账号登出（`ACCOUNT_SIGNED_OUT`）、上下文超限、被中断、策略拦截——在浮窗上**全部不会进 `error`**，最多在 `turn/end` 后掉回 `idle`。也就是说 `E-10 / E-30 / E-40 / E-50` 这四类错误码在桌面悬浮窗上是**死代码**，`explainError()` 的翻译表桌面端用不到。

**根因**：`foldEvent` 的 switch 没有 `turn/error` 或等价的 `error` case。宿主事件流里的失败是以什么事件名发出的，需要核对 `@deepseek-ai/dsh-agent-loop` 的事件表（我没读到宿主源码，这一条按"缺失"记，具体事件名待确认）。

**修法**：在 `foldEvent` 里补 `case 'turn/error'`（或宿主实际的失败事件名），`pushNode(state, { kind: 'turn-error', turn, code, message })`。

---

### S4 · 宿主能播的 `waiting` 状态，桌面端恒不可达


> **未修**：宿主 `pendingInteraction` 的确切字段和事件名还没查证，贸然接会造出第二个 `turn/error` 式的误判。
**位置**：`index.js:736` `pending: undefined, // 审批等待由宿主 pendingInteraction 给，Host 侧暂不订阅`。

**影响**：`deriveState` 的 `if (pending !== undefined && pending !== null) return 'waiting';` 在桌面端恒不成立。浮窗**永远不会显示"等你确认"**——而这恰好是用户最需要被提醒的时刻（`waiting` 在 `stateWeight` 里是 90，仅次于 error 的 100，设计上本来是最高优先级之一）。

主界面有 `conversation.session.header.utilities` 这个替补座位专门处理这个场景（`client.js:1751`），桌面端完全没接。

**修法**：订阅宿主的 `pendingInteraction`（`inject` 里已有 `sessions`，需要确认哪个事件/服务暴露它），把结果填进 `snapshot()` 的 `pending` 字段。

---

### S5 · 两个进程同时写偏好文件，读-合并-写存在丢更新竞态


> **已修**：两边都改成**原子写**（同目录 tmp + `renameSync`），读取改成三态（对象 / `undefined`=不存在 / `null`=读不出来）。`null` 时**放弃这次写入**并告警，不再拿 `{}` 当基底抹盘。`writeOverlayPrefs` 读失败会重试 3 次再决定。
**位置**：
- `index.js:502-542` `writeOverlayPrefs`：`readFileSync` → 合并 → `writeFileSync`
- `electron/main.cjs:157-163` `writeFloatPrefs`：同样三步

**影响**：宿主和 Electron 主进程是两个独立进程，都会在用户操作时立即写这个文件。若两者几乎同时写：
1. 宿主读到 `{skin:'anime', show:true}`
2. 主进程读到同一份
3. 主进程写 `{skin:'anime', show:true, clickThrough:true}`
4. 宿主写 `{skin:'pixel', show:true}` ← 覆盖，`clickThrough` 丢了

后果是**用户刚改的某个设置会静默回滚**，而且要复现得靠手速。`index.js:495` 的注释说"在同一个 tick 内完成，本机不会有竞争"——这个判断**只在单进程内成立**，跨进程不成立。

**另一条同源问题**：`main.cjs:660` 用 `watchFile({ interval: 400 })`。`writeFileSync` 不是原子写（先 truncate 再写），400ms 的窗口足够读到**半截 JSON**；`readFloatPrefs` 的 `catch { return {} }` 会把它当成空对象，随后 `writeFloatPrefs` 的合并基于 `{}` —— **一次性抹掉全部偏好**。

**修法**（两处，都不难）：
1. 写入改成原子：写 `PREFS_FILE.tmp` 再 `renameSync`（POSIX rename 是原子的），两个写入方都改；
2. 读失败时**不要返回 `{}`**，返回 `null` 并让调用方跳过本次写入，宁可不写也不能抹盘。

---

## 设计缺陷（不崩，但结构上会反复出问题）

### D1 · 缺 `turn-error` 之外的"未知事件"兜底——`step/*` 白名单是反的

**位置**：`index.js:293-296` 明确列出 `step/start` / `step/end` 不记节点。

**问题**：这是**黑名单**。宿主将来新增任何事件类型（比如 `approval/request`、`compaction/start`），`default: return state` 会让它静默丢失。而注释里详细记录了"step/end 让状态倒退"这个教训——说明作者的应对方式是"一个个排除"。

**建议**：改成白名单 + 显式忽略注释。或者在 `default` 分支里 `pushNode(state, { kind: 'unknown', type })`，让新事件至少能在流水里被看见（`OUTPUT_NODE_KINDS` 不含 `unknown`，所以不会影响状态判定）。

风险低、收益是**未来加事件时不用再踩一遍"状态倒退"**。

### D2 · `sessions` Map 永不清理


> **已修**：`turnTimings` 加 50 轮上限；接上 `ctx.on('session/disposed')` 删掉对应会话状态并清空 `currentSessionId`。
**位置**：`index.js:624` `const sessions = new Map()`，全文件无 `sessions.delete`。

**影响**：每个开过的会话留一份 `createSessionState()`，含 `nodes`（上限 200 条）、`tokenSamples`、`turnTimings`（**这个无上限**）。长时间使用（几十上百个会话）内存会单调增长。`turnTimings` 尤其危险：一轮一条 `{startTime, endTime}`，一天几十轮的话一个月就是几千条，且只增不删。

**修法**：`turn/end` 时把 `turnTimings` 只留最近 N 轮（比如 20）；监听会话关闭事件（或反过来：`sessions` 用 LRU 限制在 32 个）。

### D3 · `currentSessionId` 的"最近有事件"策略会让浮窗显示错的会话

**位置**：`index.js:1119` `currentSessionId = sessionId;`——任何会话的**任何**事件都会抢占主视图。

**影响**：后台会话（定时任务、被 fork 的子会话）触发一条事件，浮窗立刻切去显示它。用户正在看的那个会话被"偷走"焦点。多会话并行时浮窗会**随机闪烁**。

**修法**：区分"用户正在看的会话"和"后台活动"。宿主应该有前台会话的概念（`agents` 服务里大概率有），至少可以给后台会话加权重降级，只在它出错时才抢占。

### D4 · WS 无心跳，半开连接会永久堆积


> **已修**：`encodeWsText(text, opcode = 0x1)` 支持 ping(0x9)；25 秒发一次 ping，超过 50 秒没收到任何字节就 `destroy()`；`data` 回调从空函数改成刷新 `lastSeen`。实测用裸 socket 握手能在 25 秒内收到 PING 帧。
**位置**：`index.js:877-878`：`socket.on('data', () => {})` 空消费，从不发 ping，无超时。

**影响**：合盖、切网络、进程被 `SIGSTOP` 时 TCP 不会立刻报错。`clients` 集合里留着死连接，`pushNow` 每次遍历都 `try { socket.write() } catch { clients.delete() }`——但 Node 的 `socket.write()` **对已死 socket 通常不抛而是静默缓冲**，所以 `catch` 分支几乎走不到，死连接会一直留下，并且**缓冲区无限增长**。

**修法**：加 ping/pong（25s，与 SSE 心跳对齐），两次没响应 `socket.destroy()`。

### D5 · 单实例锁与端点文件写入的顺序不对


> **已修**：`requestSingleInstanceLock()` 移到 `watchPrefs()` 之前，没拿到锁的副本不会再挂上文件轮询。
**位置**：`main.cjs:722` `requestSingleInstanceLock()` 在 `ipcMain.handle` 注册之后、但在 `createWindow()` 之前；`persistEndpoint` 是**宿主**写的，不是 Electron 写。

**问题**：`SECOND_INSTANCE` 拿到锁失败时 `app.quit()`，但此时 `watchPrefs()` 已经跑过（`main.cjs:719`，在 `requestSingleInstanceLock()` **之前**）。虽然 quit 很快，但 `watchFile` 已经建立，短暂窗口内可能响应一次偏好变更并向宿主 POST。这是个小竞态，正常看不出来，但 `watchPrefs` 的调用位置应该在拿到锁之后。

**修法**：把 `watchPrefs()` 移到 `requestSingleInstanceLock()` 成功之后。

### D6 · `sandbox: false` + `nodeIntegration: false` 的组合

**位置**：`main.cjs:329` 和 `main.cjs:587`。

**影响**：`sandbox: false` 让渲染进程有完整的 Node 环境（只是 `nodeIntegration` 关着，`require` 不可用，但 preload 有完整 Node 能力）。官方推荐开 `sandbox: true`。当前页面是本地 `loadFile` 的纯静态 HTML，风险不高，但一旦将来加 `executeJavaScript` 或加载远程内容就是高危。

**建议**：先尝试 `sandbox: true`，preload 里只用 `contextBridge` + `ipcRenderer`（现在就是这样写的），大概率能直接跑。收益是纵深防御。

### D7 · 两套 HTTP 路由的鉴权模型不对称

**位置**：
- `index.js:881-946`：127.0.0.1 上的独立服务，**全部端点**（含 `/health`）都要求 token
- `index.js:1061-1111`：挂宿主 `webServer` 的同源路由，**无鉴权**，依赖同源

**问题**：同源路由无鉴权是**设计选择**（同源即登录态），但 `/dsh-washer/prefs` 是个**写接口**，且 `kind: 'prefix'` 匹配——`/dsh-washer/prefs/anything` 都会落到同一个 handler。任何能向宿主 origin 发请求的东西（比如恶意扩展、`file://` 页面通过 CORS 配置不当）都能改偏好。

**建议**：
1. `kind: 'prefix'` 改成 `exact`（和 SSE 那条一致），减少意外匹配面；
2. 校验 `Origin` / `Sec-Fetch-Site`，非同源直接 403；
3. 对 `127.0.0.1` 那条，`/health` 可以不要求 token（探活不该要凭据），但如果保留现状，就在 README 里写明。

### D8 · 端点文件的 pid 探活挡不住 pid 复用


> **已修**：改成真发一次 `GET /dsh-washer/health`（`spawnSync` + `ELECTRON_RUN_AS_NODE`，300ms 超时），200 才算活。pid 只保留作快速排除。三种情况实测：正确 token → ALIVE、错误 token → DEAD、无人监听端口 → DEAD。
**位置**：`main.cjs:93-99` `process.kill(info.pid, 0)`。

**实测**：当前 `~/.dsh/dsh-washer-overlay.json` 记的是 `pid: 95679, port: 53223`，该进程确实活着且端口在听——这条链路是好的。但 `process.kill(pid, 0)` **只验证 pid 存在，不验证是不是同一个进程**。macOS 的 pid 会复用，宿主崩溃后重启，新进程可能拿到同一个 pid，此时旧端点文件会被误判为有效，浮窗连到一个**没人监听的端口**，表现为"永远未连接"。

**修法**：文件里加 `startedAt`（进程启动时刻，可从 `/proc` 或 `psutil` 类比读，macOS 上可用 `process.uptime()` 反推），探活时比对；或者更简单——探活失败时**实际发一个 GET `/health`** 而不是只看 pid。后者最可靠，代价是多一个本地请求。

---

## 体验问题

### U1 · `error` 状态的 `E-21`（审批被拒）语义矛盾

**位置**：`core.js:243-245` 注释写"审批被拒 / 权限不足：**这是用户主动的选择，不是故障**"，但函数返回的 title 仍是 `err.e21.title`，而 `deriveState` 把它归进 `error`（红灯闪烁）。

**影响**：用户主动拒绝了一次审批，浮窗报"故障"红灯。这是**撒谎**——违背了项目第一原则（"状态不许撒谎"）。

**建议**：`APPROVAL_DENIED` 不该进 `error`，应该进 `waiting` 或直接回 `idle`。这需要状态机层面改，不只是文案。

### U2 · `finally` 里 `setTimeout(0)` 的口子没堵住

**位置**：`main.cjs:210-214` `snapToEdges` 的 `snapping` 防重入。

**问题**：`setTimeout(() => { snapping = false; }, 0)` 依赖"`moved` 事件在这一轮事件循环内派发完"，但 `moved` 是**系统异步事件**，在 macOS 上不保证。极端情况下连续两次快速拖动会在第二次被误拦（窗口不贴边）。

**影响很小**，但既然注释里写了"实测会被一路推到屏幕外"这个教训，用 `setTimeout(0)` 兜底是脆弱的。建议改成比较 `getPosition()` 后位置是否已收敛。

### U3 · `tiny` 档位下 `WIN_WIDTH/WIN_HEIGHT` 用错


> **已修**：删掉常量，改成 `winSize()` 取当前档位；`snapToEdges` / `defaultPosition` / `setSizeMode` / `openDetail` 四处全部替换。
**位置**：`main.cjs:35-36` 定义 `WIN_WIDTH/WIN_HEIGHT = SIZES.normal`，但 `snapToEdges()`（`:198`）、`setSizeMode()`（`:506`）、`openDetail()`（`:557`）都用这两个**常量**而不是当前档位的尺寸。

**影响**：切到 `tiny`（76×96）后贴边/详情面板定位仍按 132×200 算，会**偏移 56px**。用户能感觉到"极简模式下浮窗贴不到边"。

**修法**：这些函数里用 `SIZES[sizeMode]` 替代常量。

### U4 · 主进程启动了但页面没连上时，没有任何可见反馈

**位置**：`float.html:641-663` 的重连逻辑。

**问题**：`reconnect()` 失败时 `setTimeout(reconnect, 2000)` 无限重试，但**页面 UI 上只是显示"未连接"**（`setConn('lost')`）。用户分不清"宿主没起"和"端点失效"。这正是我们这两周反复踩的坑。

**建议**：`setConn` 加一个 `detail` 参数区分原因（端点文件不存在 / pid 探活失败 / WS 握手失败），右键菜单里加一行"连接诊断"。

### U5 · `debug/float.html` 里 `el('...')` 没有 null 保护

**位置**：`setConn`、`paintLamp`、`render` 等都直接 `el('st').dataset...`。

**影响**：如果 HTML 结构被改动导致 id 消失，会抛 `Cannot read properties of null`。当前 id 都存在（已核对 `st/skinHost/machine/wrap/tm` 全部存在），但配合 S1 的教训——**浮窗是有常驻进程的，一个未捕获异常会让整段渲染停止**，而且用户看不到控制台。

**建议**：`el()` 加 `if (!node) console.warn(...)` 并返回一个 no-op stub。

---

## 尚未实现、但有实际价值的功能

按"投入产出比"排序：

### F1 · 多会话总览（价值最高）

浮窗只显示一个会话（且会被后台会话抢走，见 D3）。实际上用户经常同时跑 2-3 个 agent。**机器上挂一排小指示灯**（每会话一个，颜色对应状态），点一下切主视图——这个改动不需要新数据源，`sessions` Map 里已经有全部信息。

### F2 · 完成时的系统通知

`done` 状态现在手机端（浮窗）不可达（S2），即使修好了也只在屏幕角落闪一下。macOS 原生通知（`new Notification()`）能让用户离开座位时也知道干完了。需要设置页加开关。

### F3 · 长任务的历史耗时基线

`turnTimings` 里已经有每轮的 `startTime/endTime`（虽然现在会无限增长）。在此基础上算"这个会话平均每轮多久"，浮窗可以在 `washing` 时显示**预计剩余时间**而不是单纯的已用时长。数据现成，只差聚合。

### F4 · 成本估算

`cordis.patch.yml` 里已经有 `costPerKToken: 0` 和 `costCurrency: '¥'` 两个配置项，`usage` 里也有完整的 `input/output/cacheRead/cacheWrite`。**功能没接**——配置项是死的。接上就是详情面板里加一行"本次 ¥0.03"。

### F5 · 快捷键：暂停 / 中断当前轮

`ESCAPE_ACCELERATOR` 只用于退出穿透。用户想让 agent 停下来，必须切到主界面点按钮。加一个 `⌥⌘P` 调宿主 API 中断，是很自然的延伸。需要确认宿主有对外暴露的中断接口。

### F6 · 浮窗位置按显示器记忆

`POS_FILE` 只记一组 `{x, y}`。外接显示器拔掉后再插回，窗口会跑到主屏（因为坐标还在但屏幕没了）。按显示器 id 分组存位置。

---

## 优先级排序

| 序 | 项 | 类型 | 理由 | 工作量 |
|---|---|---|---|---|
| 1 | **S1** `reportCorner` 未定义 | 严重 | 每次切换设置必抛异常，且是纯删除死代码 | 2 分钟 |
| 2 | **S5** 偏好文件跨进程竞态 + 非原子写 | 严重 | 会静默抹掉用户设置，且难复现 | 1 小时 |
| 3 | **S2** 桌面端无 `done` 状态 | 严重 | 核心体验缺失，与宣传不符 | 半天 |
| 4 | **S4** 桌面端无 `waiting` | 严重 | 最需要提醒的时刻不提醒 | 半天（依赖宿主接口确认） |
| 5 | **S3** `turn-error` 从不产生 | 严重 | 四类错误码在桌面端是死代码 | 半天（依赖事件名确认） |
| 6 | **U3** tiny 档位尺寸用错 | 体验 | 56px 偏移，用户能感觉到 | 20 分钟 |
| 7 | **D2** sessions/turnTimings 无限增长 | 设计 | 长跑必然踩到 | 1 小时 |
| 8 | **D4** WS 无心跳 | 设计 | 死连接堆积 + 缓冲泄漏 | 1 小时 |
| 9 | **D8** pid 复用误判 | 设计 | "永远未连接"的顽固来源 | 1 小时 |
| 10 | **D1** 事件黑名单改白名单 | 设计 | 预防未来踩坑 | 1 小时 |
| 11 | **D3** 当前会话被抢 | 设计 | 多会话时体验差 | 半天 |
| 12 | **U1** `E-21` 语义矛盾 | 体验 | 违背"不撒谎"原则 | 半天（要动状态机） |
| 13 | **D7** 两套路由鉴权不对称 | 安全 | 同源写接口，风险可控 | 2 小时 |
| 14 | **U5** `el()` 空指针保护 | 体验 | 防御性，配合 S1 的教训 | 30 分钟 |
| 15 | **D5/D6/U2/U4** | 杂项 | 都是小修 | 各 30 分钟 |

**建议的动手顺序**：1 → 6 → 5 → 9 → 8 → 7 → 2 → 3 → 4。前四个是"改完就能验证"的，先把能立刻验证的修掉建立信心，再动需要和宿主对齐的那几个。

**第一轮实际完成**（0.2.4 之上，未提交）：1、2、3、5、6、7、8、9 全部完成，外加 15 里的 D5。剩下 4（S4）、10（D1）、11（D3）、12（U1）、13（D7）、14（U5 的剩余部分）和 D6/U2/U4 未动。

---

## 顺带发现的测试基础设施问题

**`test/host.test.mjs` 无法自然退出**。46 个用例全部通过，但进程挂在最后不退出（`node --test` 卡住）。原因是某个用例创建的 `http.Server` 或 `setInterval` 没有在 `after` 里清理。这意味着 CI 里跑这个测试会超时。

日志里最后一条是 `✔ 偏好文件里的 show:false 不能把功能关死`——之后没有任何输出，说明卡在最后一个用例的清理阶段。修法：给涉及 `apply()` 的用例加 `t.after(() => dispose())`，并检查 `snapshot()` 里 `tickTimer` 是否 `unref`（`index.js:822` 有 `unref`，但 `pushTimer` 只在 `:839` 也 unref 了——那么嫌疑落在 `server.close()` 的异步句柄上）。

---

## 附：已经做得很好的地方

不只是挑毛病，这几处是真的扎实，改动时别破坏：

1. **状态核心纯函数化**（`src/core.js`）——无 React、无 DOM，`node` 下直接单测。Host 和 Client 共用同一份判定，这是整个架构最正确的决定。
2. **"只认本轮最后一条"的成败判定**（`core.js:113-117`）——工具失败后自愈重试不报错。这是从真实用户痛点倒推出来的规则。
3. **偏好的双向同步通道**（`index.js:1016-1111` + `client.js:1487-1493`）——设置页 ↔ 文件 ↔ 浮窗三方用 SSE 拉齐，`applyRemotePrefs` 只认认识的字段、只覆盖不删除，这个保守策略很对。
4. **注释里保留了"为什么"和踩过的坑**——`main.cjs:341-350` 那段 `onscreen=false` 的记录、`index.js:285-292` 的 `step/end` 教训，比代码本身更有价值。
5. **端点文件 0600 + pid/token 三重比对**（`index.js:434-468`）——解决了插件热重载时新旧实例互踩文件的问题。

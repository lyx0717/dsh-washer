# dsh-washer 新功能建议（产品/新功能策划）

> 依据：README 全文、`package.json`、`cordis.patch.yml`、`src/core.js`、`index.js`（Host 数据管道）、`src/client.template.js`（slots）、`electron/main.cjs` + `debug/float.html` + `debug/detail.html`（浮窗能力）。
> 硬约束逐条自检：**只读**（只消费宿主事件流与已派生快照，不往会话写事件）；**每个动作对应可验证宿主信号**（下方每条都点名信号来源）；**零依赖/不打包 React**；**最简实现**；**与洗衣机隐喻一致**。
> 已刻意删掉、不再重提：ETA 预计剩余时间、S/M/L 展开卡片。

## 现状速览（已具备，避免重复）

- 10 态状态机 + 每态视觉：`deriveState`（`src/core.js`）。
- 多会话圆点（状态色/排序/折叠/钉住）：`sessions` 摘要 + float 圆点。
- 无进展（卡住）检测：`stalledForOf` → `snapshot.stalledMs`，只在副标题显示「卡住 mm:ss」（`debug/float.html:1108` 附近）。
- 洗完/故障/等你确认三态通知+音效：`debug/float.html` `maybeNotify`（`:1011-1042`，仅 `done|error|waiting` 边沿触发）→ `electron/main.cjs` `ipcMain 'washer:notify'`（`:1066-1078`）→ `playSound`（afplay）+ 系统通知/横幅。
- 鼠标穿透、normal/tiny 档、pixel/precision 皮肤、详情面板（模型/速度/耗时/token/工具耗时，`debug/detail.html`）、设置页（`WasherSettings`）。
- 结论：**"卡住"虽然是定位里的三大时刻之一，但目前只改副标题，不主动叫人**——这是最明显的定位缺口（见功能 1）。

---

## 功能 1｜卡住主动提醒（补齐"三时刻"里的「卡住」）

- **真实痛点**：定位写死「洗完 / 卡住 / 等你确认」三时刻主动叫人，但代码里 `done / error / waiting` 才弹通知、响音；`stalledMs>0`（卡住）只把副标题换成「卡住 02:10」。真实场景：跑长任务去吃饭，回来发现某工具 30 分钟前就没进展，洗衣机一直"在洗"却没人叫，白等半天。
- **实现思路**：信号现成——Host `snapshot.stalledMs`（`stalledForOf`，washing/rinsing/spinning 连续 45s 无可见进展，实测非估算），`debug/float.html` 已拿到并在 `:1108` 渲染。
  1. `debug/float.html` 的 `maybeNotify`（`:1011-1042`）加"卡住边沿"分支：当 `stalledMs` 由 `null/0` 变为 `>0` 时触发一次 `host.notify('stalled', text)` + `showFlash`；用 `stalledNotifiedTurn` 变量按 `snap.turn` 去重，一轮只提醒一次。
  2. `electron/main.cjs` `ipcMain 'washer:notify'`（`:1066-1078`）加 `kind==='stalled'` 分支：`playSound('error')`（或新音效）+ `notify('卡住了', …)`。
  3. dock 用户（无 Electron）在 `src/client.template.js` `WasherDock` 的本地 STALL 逻辑里，卡住时把停靠条 `tone` 提到警示色即可。
  - 配置：**不新增**，复用现有 `desktopOverlayNotify` 开关（用户已关通知则不打扰）；如要独立控制再加 `desktopOverlayStallNotify`。
- **洗衣机隐喻**：滚筒突然停转、水不晃了 → 报「卡住了」，LED 琥珀慢闪。
- **优先级**：**P0**（补定位核心缺口、信号现成、改动小、性价比最高）
- **复杂度**：小
- **风险/成本**：45s 阈值对长构建/长工具可能误报（README 已注明阈值保守）。建议：只提醒一次、文案标「可能只是有点慢」，默认跟随 notify 开关，避免打扰。

## 功能 2｜洗完「完成小结」（通知/横幅带上本轮量级）

- **真实痛点**：done 通知现在只有「用时 3:20」。用户回来想知道这轮到底干了多少——几个工具、烧了多少 token、什么模型——否则还得点开详情。
- **实现思路**：纯前端拼接，信号全在 `snapshot`：`durationText / toolCount / tokenUsage.total / model`。改 `debug/float.html` `maybeNotify` 的 done 文本（`:1030` 附近）为「用时 X · N 个工具 · Y tokens」；`showFlash` 副标题同步。系统通知 body 复用同一 `text`，`electron/main.cjs` 不改。零新配置。
- **洗衣机隐喻**：洗衣结束的"取衣小票"——耗时/件数/水耗。
- **优先级**：**P1**
- **复杂度**：小
- **风险/成本**：浮窗仅 132px 宽，横幅文字过长会换行/截断，建议只留「时长 + 工具数」两项，token/模型放详情里。

## 功能 3｜等你确认的「二次提醒」（久等未应答再叫一次）

- **真实痛点**：waiting 只在跳进那一刻响一次（Tink）+ 弹一次。用户正好离开/戴耳机错过，之后浮窗一直琥珀却没有第二次声音，任务就卡在等你拍板直到你回来。
- **实现思路**：可验证信号 = `snapshot.state==='waiting'` 的持续时间。`debug/float.html` 已有 state 边沿 + 1s 心跳；记录 `waitingSince`，当 waiting 持续超过阈值且本轮未再提醒过，再 `host.notify('waiting','还在等你确认')` + 轻微音效一次（或每 N 分钟一次）。`electron/main.cjs` 已处理 `kind==='waiting'`（`:1078`），无需改。新增配置 `desktopOverlayWaitingRemindMs`（0=关闭，默认建议 0 或 180000）。
- **洗衣机隐喻**：洗衣机停在「待取衣」滴滴叫第二次。
- **优先级**：**P1**
- **复杂度**：小
- **风险/成本**：长 pending 多半是用户已离开，重复提醒可能烦。默认关闭或用 ≥3 分钟间隔，只提醒一次。

## 功能 4｜卡住时告诉「卡在哪一步 / 哪个工具」

- **真实痛点**：卡住只显示「卡住 02:10」，不知道是卡在跑命令/检索，还是卡在模型空转。要判断要不要干预，只能点开详情。
- **实现思路**：`src/core.js` 已有 `activeTool(runningCalls)`（返回 `{name,callId,turn,step}`），但 `index.js` 的 `snapshot()` 没导出它。给 `snapshot()` 增加 `activeTool: activeTool(s.runningCalls)`；`debug/float.html` 卡住分支（`:1108` 附近）副标题拼「卡在 {toolActionOf(name)} · {dur}」；`debug/detail.html` 也可复用。纯读、零依赖。
- **洗衣机隐喻**：面板指示灯指向卡住的那个洗程。
- **优先级**：**P1**
- **复杂度**：小
- **风险/成本**：卡在无工具阶段（模型空转）时 `activeTool===null`，退回只显示时长即可，别显示空动作。

## 功能 5｜故障一句话「人话解释 + 建议」

- **真实痛点**：error 现在只显示错误码（E-10/E-20…）或原始 message，普通用户看不懂是账号问题还是模型问题，不知道该重登还是重试。
- **实现思路**：`src/core.js` 已有 `errorCodeOf` 产出 E-xx，`snapshot.errorCode` 也已在。在 `locale/zh.json`、`locale/en.json` 新增 `errorCode` 段，把 E-10…E-50 各映射一句人话+建议（E-10 账号/模型不可用→重登或换模型；E-20 工具失败→可重试；E-21 审批被拒；E-30 上下文超长→清理再试；E-40 中断；E-50 策略拦截）。`debug/float.html` error subtitle（`:1125` 附近）与 `showFlash`、`debug/detail.html` 用它替换裸 code，原 code 保留在 `title` 提示里。纯文案映射。
- **洗衣机隐喻**：故障灯 + 一行「哪坏了」。
- **优先级**：**P1**
- **复杂度**：小
- **风险/成本**：映射必须与 README 错误码定义一致，避免误导；未知码仍回退显示原始 code。

## 功能 6｜tiny 档「关键时刻别只剩一颗灯」

- **真实痛点**：tiny（76×96）刻意极简，只留指示灯+角标、气泡不渲染；`showFlash` 在 tiny 直接 `return`（`debug/float.html:1056`）。于是开 tiny 的人几乎收不到「等你确认/卡住/故障」的视觉信号（系统通知常被关），三大时刻对 tiny 用户形同虚设。
- **实现思路**：信号 = state 边沿（已有）。改 `debug/float.html` `showFlash`：`done/error/waiting/stalled` 时即使 tiny 也放一个**极小角标/短闪**（不展开整气泡，保住极简定位）；或临时把 tiny 短暂切 normal 几秒再切回（`electron/main.cjs` `setSizeMode`，注意动画/位置）。
- **洗衣机隐喻**：极简机身的小灯变成"提醒灯"，亮一下。
- **优先级**：**P1**
- **复杂度**：中
- **风险/成本**：与 tiny「极简」意图冲突，务必克制（只角标不展开）；临时切尺寸要处理窗口定位，避免抖动。

## 功能 7｜「洗衣记录」——最近 N 轮耗时与结果（详情面板新增一节）

- **真实痛点**：用户想知道这台机最近几轮干得怎么样：哪轮快、哪轮失败、是不是总超时。现在详情只看当前轮，没有历史。
- **实现思路**：Host 已保留 `turnTimings`（最近 50）与 `nodes`（含 `turn-error`/`isError`）。`index.js` `snapshot()` 增加 `history: 最近 N(如 5–10) 轮 [{turn, ms, ok}]`，`ms` 用 `turnTimings` 起止差、`ok` 复用 `findTurnError/findToolFailure` 判定（排除 turn 0 与进行中轮）。`debug/detail.html` 新增「最近几轮」列表，复用现有 row 样式。
- **洗衣机隐喻**：洗衣机的"最近洗衣记录"。
- **优先级**：**P2**
- **复杂度**：中
- **风险/成本**：`turnTimings` 只有起止时间，ok 判定口径要一致；数据保留 50 轮上限，别无限增长。

## 功能 8｜「本会话累计用量」（累计 token / 工具数 / 轮数）

- **真实痛点**：单轮 token 详情里有，但用户常想知道「这次任务总共花了多少」。现在得自己心算。
- **实现思路**：Host `turn/end` 时把该轮最终 `tokenUsage`、`toolCount` 累加进 session 级累计字段（注意 usage 每轮重置，取末值再累加），`snapshot()` 增加 `cumulative{input,output,total,tools,turns}`；`debug/detail.html` 加一行「累计」。纯读、零依赖。
- **洗衣机隐喻**：累计「洗了多少件 / 用了多少水」。
- **优先级**：**P2**
- **复杂度**：中
- **风险/成本**：usage 是"同一 turn 内单调累计值"，跨轮是否重置要确认清楚，累加口径写死避免重复计数。

## 功能 9｜勿扰 / 安静模式（临时静音通知+音效）

- **真实痛点**：开会/演示/专注时需要浮窗继续显示状态，但不想弹系统通知、不想响铃。现在只能分别去关 notify、sound 两个开关，还容易忘记改回来。
- **实现思路**：纯偏好项。`src/client.template.js` `WasherSettings` 加一个「勿扰」开关 → 写 localStorage 并经 `/dsh-washer/prefs` 同步到浮窗偏好文件；`electron/main.cjs` 在 `notify()`（`:561`）和 `playSound()`（`:601`）入口先判 `dndPref` 直接 return。新增配置 `desktopOverlayDnd`（默认 false）。浮窗视觉/横幅保留。
- **洗衣机隐喻**：洗衣机「静音洗」——照样转，不出声。
- **优先级**：**P2**
- **复杂度**：小
- **风险/成本**：多一个设置项增加密度；需明确勿扰只静音「声音+系统通知」、保留浮窗视觉，否则用户以为坏了。

---

## 推荐落地顺序

1. **第一批（P0，先做）**：功能 1 卡住主动提醒 —— 补定位三大时刻缺口，信号现成、改动集中在 `debug/float.html` + `electron/main.cjs` 两处小分支。
2. **第二批（P1 快赢，纯读小改）**：功能 2 完成小结、功能 5 故障人话、功能 4 卡住位置 —— 都是快照已存数据的展示增强，几乎零风险，一天能一起收。
3. **第三批（P1 体验补强）**：功能 3 二次提醒、功能 6 tiny 关键时刻提示 —— 引入计时/尺寸切换，稍需打磨。
4. **第四批（P2 增强）**：功能 7 洗衣记录、功能 8 累计用量、功能 9 勿扰 —— 需要在 Host 侧多存一点聚合数据或加设置项，按需排期。

> 一句话总结：先补「卡住也叫人」这个定位缺口（P0），再用最便宜的快照展示增强把「关键三时刻 + 故障」讲清楚（P1），最后补历史/累计/勿扰这类锦上添花（P2）。全部只读宿主信号、零依赖、符合洗衣机隐喻。

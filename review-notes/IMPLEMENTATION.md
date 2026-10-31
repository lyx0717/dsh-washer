# 实施记录（按 FEATURE_REVIEW 落地顺序）

基线：git `v0.7.4`（提交 3a6eef7），工作区原本干净。
验证：`npm run build` 通过；`npm test` 134 passed / 0 failed；`node test/render.mjs` 82 passed / 0 failed。
所有改动**未提交** git；回滚：`git checkout -- .`（会一并丢弃本文件以外的改动，review-notes/ 是新增目录不受影响）。

## 组1 止血（P0/P1）
- **A1 纯文本轮卡「启动中」**：`index.js` 折叠 `assistant/message` 时节点 kind 由 `assistant-message` 改为 `assistant`（`core.js` 的 `OUTPUT_NODE_KINDS` 只认白名单，否则纯问答轮次永远判 starting、spinning 不可达）。新增回归测试 `test/host.test.mjs`「纯文本轮次：assistant/message 折叠后必须是 spinning」。
- **B1 「等你确认」不弹系统通知**：`electron/main.cjs` 的 `washer:notify` 补 `waiting` 分支；README 通知章节与 `desktopOverlayNotify` 说明同步为四类（完成/故障/等你确认/卡住）。
- **C1 穿透开不了 + 偏好文件 400ms 回写死循环**：`updateEscapeShortcut` 注册失败时，除复位内存，还 `writeFloatPrefs({clickThrough:false})` + `notifyHost({clickThrough:false})` 回传，终止 watchPrefs 的重触发环。
- **C2 换屏/改分辨率后窗口跑到屏外**：`electron/main.cjs` 新增 `clampToVisible()`（`screen.getAllDisplays` 相交校验，离屏回退 `defaultPosition()`）；`createWindow` 用它兜底；`app.whenReady` 后监听 `display-removed/added/metrics-changed` 重新校正。

## 组2 功能1（P0 新功能）
- **卡住主动提醒**：`float.html` 在 `maybeNotify` 用 `stalledMs` 边沿（按 turn 去重）发 `host.notify('stalled', …)` + 本地琥珀横幅；`electron/main.cjs` 的 notify 分支加 `stalled`。

## 组3 P1 快赢
- **功能2 完成小结**：done 通知文案带 `用时 · N 个工具`。
- **功能4 卡在哪工具**：`index.js` 的 `snapshot()` 增 `activeTool:{name,action}`；浮窗卡住文案前置 `卡在<动作>`。
- **功能5 故障人话**：`float.html` 加 `ERR_HUMAN`（E-10..E-50/E-00），故障横幅用中文解释（dock 仍保留错误码，符合 render 测试契约）。
- **D1「+N」可点**：`electron/main.cjs` 新增 `pinSessionAtHost` + `showSessionMenu` + IPC `washer:show-session-menu`；`preload.cjs` 暴露 `showSessionMenu`；浮窗 `+N` 改 `role=button` 点击弹会话切换菜单。
- **D2 读屏每秒播报**：`StripBar` 的 `role=status` 从整条收到 `.dw-t1`（只播状态标题），`.dw-t2` 标 `aria-hidden`。

## 组4 P1 补强
- **功能3 waiting 二次提醒**：进入 waiting 且非首帧时 `setTimeout(30s)` 再 `notify('waiting')`，离开即清。
- **P2-5 后台会话漏报**：`index.js` 的 `pushNow` 签名加入 `sessions` 概览（后台会话状态变化也会触发推送）；`/dsh-washer/pin` 改 `schedulePush(true)` 强制推。浮窗 `maybeNotify` 遍历非当前会话做边沿检测，后台 done/error/waiting 发系统通知。
- **A2 清死输出**：删除 `snapshot()` 里的 `typicalMs/remainingMs` 及无用 import（core 仍导出、core.test 仍测）。注：`draining` 在桌面浮窗仍不可达——host 侧没有 trajectory 数据源，保持 `trajectory:undefined`（dock 经 `useTrajectory` 可显示）。

## 组5 P2 打磨
- **D3** 浮窗忙碌态文案「处理中/Working」（`overlay.busy`），不再复用「启动中」。
- **D4** 浮窗 waiting 副行改「等待批准 / 需要选择」，不再与标题同义。
- **D5** 多会话圆点热区 6px→18px（`::before`）+ `title`。
- **D6** 次级文字 `--dw-t2` 回退色加深、字号 10→11px（基础 + 小屏两处）。
- **E1 running 复活失效**：`pushNode` 增 `nodesRev` 计数，`subscribeEvents` 用它（而非数组引用）判断状态是否真变。
- **E2 clientPending 泄漏/永久等待**：条目存 `{kind,at}` + 30s TTL，会话 `disposed` 时删除。
- **E3 切会话瞬间错色**：`pushNow` 发现 `sessionId` 变化时清空 `shownState/At`，迟滞按会话。
- **E4 README** 修正「双击切穿透」过期说明（入口已移到设置页/右键菜单）。
- **功能6 tiny 关键时刻**：判定为既有实现已覆盖（极简档有按状态着色的光晕/完成闪），不改。
- **功能9 勿扰模式 `desktopOverlayDnd`**：新增配置项（`cordis.patch.yml`）+ 设置页开关（`set.overlayDnd`/`set.overlayDndHint`，zh/en）+ 偏好同步映射（`OVERLAY_PREF_KEYS`/`REVERSE`）+ 主机端 `dndPref` 总闸（`notify()`/`playSound()` 入口判空，`watchPrefs`/`whenReady` 读取）。开了之后浮窗照常显示，只是不弹通知、不出声。`test/render.mjs` 两处「五个布尔开关」断言随新开关更新为六个。

## 明确未做（P2 新功能，建议下一轮，需新 UI/数据聚合，超出「修复」范围，已与粑粑确认）
- **功能7 洗衣记录**（最近 N 轮历史）：需按会话存轮次摘要 + 新增历史面板。
- **功能8 本会话累计用量**：需跨轮累加逻辑 + 详情面板新增聚合视图。

设计思路详见 `review-notes/new-features.md`。

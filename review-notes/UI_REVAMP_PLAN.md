# 洗衣机悬浮窗 UI 改版 · 实现方案（待审）

> 依据：`/Users/liyongxuan/Downloads/洗衣机桌宠悬浮UI改版需求文档.md` + 效果图 `精密家电悬浮窗 UI 效果图.png`。
> 决策已确认：①计数口径=会话级；②dock 也删像素皮肤；③「待」=等待确认；④衣物数=运行会话数。
> 本文只给方案，**未改任何代码**，审完再开工。

---

## 一、一句话结论

需求整体可落地，且和现有精机皮肤**高度契合**——机身本来就有一块 LED 屏（`.dw-pw .panel`：`state-text`+`timer`+水位条），黑条改版本质是**把外部气泡的文案搬进这块屏并加一个计数区**，不用重画机器。真正的工作量在三处：**衣物动态化**、**数据层补计数**、**下架像素皮肤（含测试）**。

---

## 二、语义定义（关键，先对齐）

| 项 | 定义 | 数据来源 |
|---|---|---|
| **黑条 · 状态文字** | 当前跟随会话（`viewSessionId`）的状态文案，和原气泡一致 | `snapshot.state` + `LABEL` |
| **黑条 · 计时** | 当前跟随会话本轮已用时 `MM:SS` | `snapshot.durationText` |
| **黑条 · 计数区** | **所有会话**的三类计数（会话级） | 新增 `snapshot.counts`（见 §三） |
| └ 待 | `state==='waiting'`（等你确认）的会话数 | `counts.waiting` |
| └ 动 | 运行态（`starting/washing/rinsing/spinning/draining`）会话数 | `counts.running` |
| └ 错 | `state==='error'` 的会话数 | `counts.error` |
| **衣物数** | **运行会话数**（= `counts.running`），上限封顶 | `counts.running` |
| **计数区为 0 的项** | 不渲染；三项全 0 则整个计数区留白 | — |
| **计数区点击** | 弹会话切换菜单（复用现有 `showSessionMenu`），替代被删的「+N」圆点 | — |

> ⚠️ 唯一残留口径：状态文字/计时用「当前跟随会话」，计数/衣物用「全部会话」。这就是效果图「洗涤中 + 待2 动1」的读法——你正盯着那台在洗，角标提示另外 2 台在等你。若你希望状态文字也反映全局（有别的会话 waiting 时也给提示），我另加一个小角标，不改变主体。**这条请审时确认。**

---

## 三、数据层改动（`index.js`）

现状：`snapshot()` 已下发 `sessions: sessionSummaries(now)`（每条含 `sessionId/state/running/elapsedMs/weight/lastAt`），但没有聚合计数字段。计划：

1. 新增一个纯函数 `countSessions(rows)`：遍历 `sessions`，按 `state` 归到 `waiting / running / error`，返回 `{ waiting, running, error }`。`running` 判定用一组运行态常量（与 `core` 的 `URGENT_STATES` 之外互补，别硬散落，抽到 `core.js` 一个 `RUNNING_STATES` 集）。
2. `snapshot()` 返回值加 `counts: countSessions(rows)`（主分支与「无会话」分支都要给，无会话时 `{waiting:0,running:0,error:0}`）。
3. 衣物需要的是数值，直接用 `counts.running`，无需另发 id 列表。
4. **不动** `state/turn/elapsedMs/durationText/activeTool/tools/toolRank/history` 等既有字段——保持前端兼容。

> 不新增宿主事件依赖，纯派生，零风险。加单元测试：构造 3 个会话（waiting/running/error）断言 `counts` 正确、无会话时全 0。

---

## 四、视觉层改动（`debug/float.html` + `debug/float.machines.js` 的生成源）

### 4.1 黑条 = 复用机身 LED 屏
精机机身本来就有 `.dw-pw .panel`（深色渐变 + 等宽字 + `.row1`(state-text/timer) + `.row2`(水位 `.bar`)）。改造：
- 把 `.panel` 从「机身内小屏」**放大成横贯机身底部的圆角黑条**（宽度贴近机身内宽，圆角~14px，深色 `#0e141c→#0a1017`，顶部一条高光描边），位置移到滚筒正下方。
- 面板内三段布局（flex）：`[状态文字]  [计数区]  [计时]`，左右两端对齐、计数居中。
- 字体：等宽/数码风（`ui-monospace` 已有），字号 12–13px；颜色按效果图：状态/计时亮青 `--dw-scr-txt`（约 `#7fe6ea`），计数同色略亮，`待/动/错` 用浅一级。**小尺寸下不放大字体**。
- 底部保留一条细进度线：**映射到现有水位 `.bar`（`--water-lvl`）**，不新造"完成百分比"（宿主没有真实进度信号，见 §七风险）。

### 4.2 删除下方独立气泡
- 删除 `float.html` 的 `.bubble` 胶囊（`#st`/`#tm`/`#dots`）：它的"洗涤中/01:12/圆点"信息全部并入黑条。
- 会话切换改由计数区点击触发（`host.showSessionMenu`）。
- 保留：本地完成横幅 `.flash`（盖在机器上方）、彩蛋徽章、拖拽/右键菜单区域不变。

### 4.3 状态文案
- 黑条状态文字沿用 `LABEL`（洗涤中/等你确认/洗完了/故障…）。「故障」可沿用或按错误码人话（`ERR_HUMAN`）短显，二选一（建议保留"故障"，错误码放详情面板）。

---

## 五、衣物动态化（工作量最大项）

现状：衣物是 `skin-precision.css` 里 **4 个写死的 `<i>`**（`_precisionBody` 里 `h('div',{className:'clothes'}, i,i,i,i)`），位置/颜色固定，不随数量变。

计划：
1. 在 `_precisionBody`（`src/client.template.js`）把衣物槽扩到 **上限 8 个 `<i>`**（多画几个空槽，DORMANT 时隐藏）。
2. `skin-precision.css` 为第 1–8 个槽定义**桶内环形坐标 + 颜色**（蓝/粉/紫/绿…），全部落在滚筒圆内（`radial` 约束，保证不溢出）。
3. 数量控制：`float.html` 的 `render()` 读 `snap.counts.running`，给机器 `.clothes` 设 `data-n="N"`；CSS 用 `[data-n="0"] .clothes i{display:none}` … 到 8 的规则（或 JS 直接切 `display`）。**0 件=空桶**。
4. 动画：现有 `.clothes{animation:spin ...}` 已让衣物随滚筒转；`spinning` 已有 blur。补：
   - `starting`：衣物依次淡入（入场，`@keyframes` 逐槽 delay）——对应文档"衣物逐步进入"。
   - `done`：衣物逐槽淡出。
   - `等待确认/空闲`：停转（已有 `--play:paused`）。
5. 上限策略：`running` 会话数可能很大 → 封顶 8 件（或 6），超出用「+」语义不体现（衣物只是氛围，不承担精确计数；精确数在计数区）。**这条请审时确认封顶值。**

---

## 六、下架像素皮肤（dock + overlay + 设置 + 主进程 + 测试）

现状像素皮肤散布：`client.template.js` 的 `defineSkin('pixel')`/`PixelMachine`/`PixelSprite`/`DEFAULT_CONFIG.skin='pixel'`/`resolveSkin` 回退 pixel；`main.cjs` 的 `SKINS=['precision','pixel']` 与右键菜单「像素」项；设置页 `skin.pixel` 选项；`test/build.test.mjs` 双皮肤断言；`test/render.mjs` 的 pixel sprite 用例。

计划（**不物理删代码，只「下架」+ 改默认，保留扩展点**，符合"保留多皮肤可扩展逻辑"）：
1. `DEFAULT_CONFIG.skin` 改 `'precision'`。
2. `resolveSkin` 的兜底从 `'pixel'` 改为 `'precision'`（脏配置回退到唯一在售皮肤）；`NATURAL`/回退逻辑同步。
3. 设置页皮肤分段：只剩一项时**整段隐藏**（不显示单选项）。
4. `main.cjs`：`SKINS` 改为 `['precision']`；右键「造型」子菜单若只剩一项则隐藏该子菜单或只列 precision；`--skin`/偏好回退改 precision。
5. `build.test.mjs`：双皮肤循环改为「遍历已注册皮肤」，并断言当前只注册 precision（或保留 pixel 但标记 dormant）。
6. `test/render.mjs`：移除/改写 pixel sprite 断言，只验 precision。
7. **保留** `PixelMachine`/`PixelSprite`/`defineSkin('pixel')` 代码（dormant），将来加皮肤零成本。

> 若你要"真删干净"，我把上述代码段一并移除——但会扩大改动面且以后加皮肤要重写，**建议只下架**。请审时定。

---

## 七、tiny 极简档降级 + 边界

- **tiny 档宽度塞不下** `洗涤中 待2 动1 01:12`。降级规则：tiny 档黑条只显示 **状态文字 + 计时**（计数区隐藏），或退化为「只亮指示灯 + 计时」。建议前者。
- **连接断开**：`wrap[data-conn="lost"]` 时黑条状态文字显示 `连接断开`、计数区清空、衣物消失（文档要求）。
- **reduced-motion**：动画关，静态水位/文字照常。
- **彩蛋**：徽章挂机身，不受黑条影响。

---

## 八、文件改动清单

| 文件 | 改动 |
|---|---|
| `src/core.js` | 增 `RUNNING_STATES` 常量集（供计数判定） |
| `index.js` | `snapshot()` 增 `counts`；新增 `countSessions()` |
| `src/client.template.js` | 衣物槽扩 8；`DEFAULT_CONFIG.skin/precision`；`resolveSkin` 兜底改 precision；`defineSkin('pixel')` 保留；设置页皮肤段仅一项时隐藏 |
| `src/skin-precision.css` | `.panel` 放大黑条样式重排；8 个衣物槽桶内坐标+颜色；计数区/状态/计时段样式；`[data-n]` 显隐 |
| `debug/float.html` | 删 `.bubble`；`render()` 写 `data-n`、填计数区、状态/计时进面板；连接断开处理 |
| `debug/float.machines.js` | 由 build-float 重新生成（不手改） |
| `electron/main.cjs` | `SKINS=['precision']`；右键造型子菜单处理；尺寸放大（SIZES 对齐新机身） |
| `test/build.test.mjs` / `test/render.mjs` / `test/host.test.mjs` | 皮肤用例调整；`counts` 新增测试 |
| `README.md` | 悬浮窗章节同步（黑条/计数/衣物/去像素） |

---

## 九、实施顺序与预估

1. **数据层**：`core.RUNNING_STATES` + `index.js countSessions` + 测试（低风险，先让计数有真数据）。
2. **黑条视觉**：`.panel` 重排 + `float.html` 去气泡/填字段（中风险，纯样式）。
3. **衣物动态化**：8 槽 + CSS 坐标 + 数量/入场/淡出（中高风险，视觉最需打磨）。
4. **下架 pixel**：默认/回退/设置/主进程/测试（中风险，面广）。
5. **收尾**：tiny 降级、连接断开、reduced-motion、README、全量 build+test+render。

每步 `npm run build` + `npm test` + `node test/render.mjs`，最后 `node --check` 语法自检。

---

## 十、风险与回滚

- 改动全在 git 工作区、**未提交**；回滚 `git checkout -- .`。所有改动可逆。
- **不做假进度**：效果图里「13% + 底部进度条」宿主没有真实"完成百分比"信号。方案选择：底部进度线映射到**水位**（真实信号），「13%」这类数字**不显示**。若你就要那个百分比，请指定它代表什么（上下文占用? 本轮进度?），我再接。
- **衣物数≠任务数**：按你确认=运行会话数，上限封顶；它是氛围指示，精确计数在黑条。
- `client.js` 是构建产物，改 `src/` 后必须 `npm run build` 再测，否则 render 测试跑的是旧产物。

---

## 十一、请审的 4 个点

1. 状态文字/计时=当前跟随会话、计数/衣物=全部会话——这个混合口径 OK 吗？
2. 衣物**封顶几件**（8 / 6）？
3. 「13% + 底部进度条」→ 只留水位条、不显示假百分比，可以吗？
4. 像素皮肤**只下架（保留代码）**，还是真删干净？

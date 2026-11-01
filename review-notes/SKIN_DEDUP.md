# 皮肤公共代码排查（5 套皮肤：precision / cream / gongbi / capsule / pixel）

## 结论

有 **6 类**可以抽公共，按「收益 ÷ 风险」排序。真正的债只有两处：**precision、cream 各写了两遍（React + 浮窗 vanilla）**，以及**皮肤清单散落在 10 个地方**。其余是叶子级 helper 的重复，抽起来便宜。

| 优先级 | 抽什么 | 现状重复量 | 风险 |
|---|---|---|---|
| **P0** | precision / cream 归一到 `body.js` 单源 | 2 套 × 约 65 行 JS（React + float 双份） | 中（视觉需逐屏比对） |
| **P1** | 皮肤清单 manifest 化 | 加一套皮肤要改 **10 处** | 低 |
| **P2** | 计数胶囊 / 状态词 / `playOf` 叶子 helper | 6 / 4 / 6 份 | 低 |
| **P3** | CSS 基础层（keyframes、reduced-motion、面板行） | 26 个关键帧里约 4 套同义副本 | 低-中 |
| **P4** | 视觉状态表（PW_WATER/SPEED/BUBBLE）下沉 core | 3 张表跨端各一份 + 正则抠 | 低 |
| — | 材质/质感层（玻璃、木纹、卡纸、HUD） | 不该抽 | 高（会做成同一张脸） |

---

## 1. P0：precision / cream 的双实现

现在每套皮肤有两种写法：

- **gongbi / capsule（好的样子）**：一份 `src/skin-<name>.body.js`，导出 `xxxBodyHtml(state, screenTime, counts, ctx)` 返回单根 HTML 字符串，构建时经 `/*__SKIN_BODIES__*/` 同时内联进 `client.js`（React 侧走 `dangerouslySetInnerHTML`）和 `debug/float.machines.js`（浮窗侧走 `innerHTML`）。**一套造型，两个运行时共用**。
- **precision / cream（要还债的）**：React 一份、浮窗一份，逐节点手写：
  - React：`_precisionBody()` `src/client.template.js:715` 起（含 `CountsNode()` `:706`）；`_creamBody()` `:666` 起（含 `CreamCounts()` `:653`）。
  - 浮窗：`precisionMachine()` `build-float.mjs:275` 起（含 `countsNode()` `:269`）；`creamMachine()` `build-float.mjs:348` 起（含 `creamCounts()` `:331`）。
  - 两边的结构是同构的：`woodtop/ctrl/doorwrap({dispenser,handle,hinge,door(glass(drum,clothes,water,bubbles))})/plinth/panel(st,counts,tm)/feet`，只在类名与材质上不同。

**抽法**：把 `precisionMachine` / `creamMachine` 的 DOM 构造改写成同签名的 HTML 串函数，落到 `src/skin-precision.body.js` 和 `src/skin-cream.body.js`；`client.template.js` 里删掉 `_precisionBody/_creamBody/CountsNode/CreamCounts`，两套皮肤改走现有 `_htmlSkinBody()`（`:783`）；`build-float.mjs` 删掉两个手工 builder，dispatch（`:412-414`）四套皮肤全部走 `htmlSkinMachine`。`ctx` 契约已经现成：`{ water, speed, play, clothes }`。

**收益**：删约 130 行重复 JS；消除「改 React 忘改浮窗」这类漂移；浮窗侧只剩一套渲染路径。
**风险**：precision/cream 是打磨最多的两套，重写要注意渐变层叠顺序与 `data-shake/data-blink` 这类外层变量（`build-float.mjs:416-420` 现在对 precision 特判）。验证要用 330px / 132px / 32px 三档 + 10 态截图逐张比。

## 2. P1：皮肤清单散在 10 处

今天加一套皮肤要同步改：

1. 新建 `src/skin-<name>.css`
2. 新建 `src/skin-<name>.body.js`
3. `client.template.js` `NATURAL` getter（`:325-327`，且三个皮肤重复写 `{w:330,h:425}`）
4. `client.template.js` `defineSkin('<name>')`（`:769/773/801/805`）
5. `client.template.js` 设置页 seg 选项（`:1199-1202`）
6. `client.template.js` locale `skin.<name>` zh（`:160-164`）
7. `client.template.js` locale en（`:234-238`）
8. `build.mjs` css 数组（`:34-41`）+ `SKIN_BODIES` 列表（`:29`）
9. `build-float.mjs` `SKIN_BODIES`（`:46`）、`skinCss`（`:168-175`）、dispatch（`:412-414`）、`shapes`（`:434`）
10. `electron/main.cjs` `SKINS`（`:920`）+ `MENU_SKINS`（`:923`）
11. `test/build.test.mjs` 循环（`:84`）

**抽法**：`src/skins.json` 作为唯一清单，字段 `{ name, w, h, labelKey, css, body }`；`main.cjs` 用 `path.join(__dirname, '../src/skins.json')` 读（记得加进 `package.json` 的 `files`），其余全部由构建派生。`NATURAL` 改成 `for` 循环按 manifest 赋值（不再需要 3 份 getter 字面量），`defineSkin` 同理走循环，设置页 seg 与 locale 也由 manifest 生成。

**顺带拆掉的雷**：`build-float.mjs` 现在靠 `grabTable()` / `grabObject()` 正则从源码抠 `PW_WATER/SPEED/BUBBLE/SCREEN_WORD/CREAM_WORD` 和 `NATURAL` getter（`:30-44`、`:54-96`）。改成读 manifest/常量后，这批易碎正则可以删——改一行格式就构建失败的问题一起消失。

## 3. P2：叶子 helper 的重复

- **计数胶囊（待/动/错）6 份实现**：`CountsNode()` `client.template.js:706`、`CreamCounts()` `:653`、`countsNode()` `build-float.mjs:269`、`creamCounts()` `:331`、`gongbiBodyHtml` 内联 `src/skin-gongbi.body.js:7-10`、`capsuleBodyHtml` 内联 `src/skin-capsule.body.js:11-14`。语义完全一致（0 项不渲染、三色、顺序不同），只有类名不同。
  → 抽一个字符串版 `skinCountsHtml(counts, { cls, order })` 给所有 body 用；React 侧如果不再有 React 皮肤，这 6 份可以收敛成 1 份。
- **10 态状态词 4 份**：`SCREEN_WORD`（`:642`，英文）、`CREAM_WORD`（`:648`，中文）、`gongbiBodyHtml` 的 `WORD`（`body.js:13-16`）、`capsuleBodyHtml` 的 `WORD`（`body.js:7-10`）。**而 locale 里已经有 `state.*` 22 条（`:133-143` 与 en 对应段）**——现成的单一来源没用上。
  → body 里统一取 `ctx.word`（由外层 `tr('state.'+state)` 注入），皮肤若要特殊措辞再覆盖。
- **`playOf` 6 份**：`SPEED[state] === '0s' ? 'paused' : 'running'` 在 `client.template.js:668/717/787`、`build-float.mjs:288/349/391`。
  → 收成 `playOf(state)` 一处。

## 4. P3：CSS 基础层

4 套皮肤共 **26 个 `@keyframes`**，语义只有约 6 种：`wave / float / cspin(clothIn) / blink(softblink) / spin / shake / sweep / led / in / drain / walk`——现在每套抄一份前缀副本（`cr-wave`、`gb-wave`、`cp-wave`…）。

- **抽法**：新增 `src/skin-base.css`，放共享 `@keyframes dw-wave / dw-float / dw-cspin / dw-blink / dw-spin` + 全局 `prefers-reduced-motion` 兜底 + `.dw-panel-row` 三栏布局（状态/计数/计时，4 套皮肤都在重复这套 flex 规则）+ 衣物动画基线。每套皮肤只保留材质层（渐变、描边、阴影、五金件）与少量 propia 覆盖。
- **注意一个真实风险**：现在 `prefers-reduced-motion` 块只有 `skin-capsule.css`、`skin-gongbi.css`、`style.css` 有，`skin-precision.css` / `skin-cream.css` **没有自己那段**。precision/cream 在「减少动态效果」下是否真停，取决于 `style.css` 的全局块有没有覆盖到它们的动画选择器——这次排查没逐条验证，属于**待确认的合规隐患**，抽基础层时正好一并收口。

## 5. P4：视觉状态表跨端重复

`PW_WATER`、`SPEED`、`BUBBLE` 定义在 `client.template.js`，`VISUAL` 定义在 `src/core.js`；浮窗构建时用正则从 `client.template.js` 抠前三张、从 `core.js` 抠 `VISUAL`。同一件事（「某状态水多高、转多快、泡沫多重、灯怎么闪」）散在两处、跨三个运行时。

**抽法**：把 `PW_WATER/SPEED/BUBBLE` 一起挪进 `src/core.js`（它已经承载 `VISUAL`，本质就是「状态 → 视觉参数」表），client 通过 `/*__CORE__*/` 内联拿到，float 构建只从一个源抠。语义上 core 从「纯状态机」变成「状态机 + 视觉参数表」，边界略变但换来真正的单一来源。

## 6. 不建议抽的：材质/质感层

玻璃折射、胡桃木纹、宣纸分染、拉丝钛、卡纸瓦楞——这些是**每套皮肤存在的理由**，共享会做出「四套同一张脸换色」的结果。原则：**只共享「结构 + 状态驱动 + 动画基础设施」，不共享「材质配方」**。同理，门/玻璃/水的 DOM 骨架也不要强行套一个带 slot 的公共模板——现在 body.js 各自写这 6 行反而更清楚、改起来更自由。

## 执行顺序建议

1. **P0**：precision/cream 单源化 → 三档尺寸 × 10 态截图对比，`npm test` + `render` 全绿。
2. **P1**：manifest → 顺手删 `grabTable/grabObject/NATURAL` 正则。
3. **P2**：叶子 helper（计数胶囊、状态词、playOf）。
4. **P3**：CSS 基础层 + 补 precision/cream 的 reduced-motion 兜底（**先补兜底，再抽**）。
5. **P4**：状态表下沉 core。

每步独立可回滚，建议一步一个 commit。

## 附带发现（与本次需求相关但独立）

- **类名前缀不统一**：precision=`dw-pw`、cream=`dw-cr`，而 gongbi/capsule 用 `gb-*` / `cp-*`。构建产物里三个命名空间并存，测试选择器和样式作用域容易串；manifest 化时顺手统一成 `dw-<abbr>`。
- **`BigMachine` 只传 `{state, screenTime}` 不传 `counts`**（`client.template.js:678` 附近）→ 32px 停靠条大机身里没有计数胶囊。属于已知取舍，但和历史注释「只在大尺寸浮窗里看得见」不一致，注释该改。
- `skin-capsule.css` 有 659 行、`skin-gongbi.css` 约 21KB，单套 CSS 已经超过 `skin-precision.css`，P3 抽基础层后应能各降 20-30%。
## 进度（本轮更新）

- **P0 已完成**：precision / cream 的机身与 CSS 单源化——`src/skin-precision.body.js`、`src/skin-cream.body.js` 成为唯一实现；React 侧和 float 侧都只调用同一份 `*BodyHtml`，原先的两套手写 DOM 已删除。
- **P1 已完成**：新增 `src/skins.json` 作为皮肤清单（name / w / h / css / body / label.zh / label.en）。现在加一套皮肤只需要：
  1. `src/skins.json` 加一条；
  2. 新建 `src/skin-<name>.css` 与 `src/skin-<name>.body.js`（函数名 `<name>BodyHtml`）；
  3. 在 `client.template.js` 的 ZH/EN 里各加一行 `skin.<name>`（构建期会校验，漏了直接报错）。
  build、build-float、`electron/main.cjs` 的 SKINS/菜单、测试循环全部从清单派生，不再有平行列表。
- **未做**：P2（每份 body 仍各自带状态词表 / 计数 HTML / play 计算）、P3（各皮肤 CSS 的 keyframes 仍有同义副本，precision/cream 缺 reduced-motion 兜底）、P4（PW_WATER / SPEED / BUBBLE 下沉 core）。

# dsh-washer · 滚筒洗衣机

用一台**滚筒洗衣机**的运转状态，实时显示 DeepSeek Harness 里 Agent 在干什么。

不是装饰：洗衣机的每一个动作都对应一个**可验证**的宿主信号。洗涤 = 模型在出字，漂洗 = 工具在跑，脱水 = 收尾，暂停 = 在等你批准。

```
待机     ▁▁▁▁▁▁▁▁ 筒空、灯暗
注水     ●●●○○○○○ 启动、水位上升
洗涤     ●●●●●●●● 滚筒慢转、气泡翻滚、模型在出字
漂洗     ●●●●●●○○ 反转、工具在跑（卡片里显示工具名）
脱水     ○○●●●○○○ 高速抖动、模糊、收尾
等你     ◐◐◐◐◐◐◐◐ 灯闪琥珀色、盯着你（等你批准/回答）
排水     ▁▁▁▁▁▁▁▁ 换水、水位降到底（上下文压缩中）
洗完了   ✓✓✓✓✓✓✓✓ 绿灯、停 6 秒后回待机
故障     ✕✕✕✕✕✕✕✕ 红灯快闪 + E 码
```

## 状态映射

| 状态 | 洗衣机在做什么 | 触发条件（宿主信号） |
|---|---|---|
| `idle` | 待机，筒空 | 会话存在但没在跑 |
| `starting` | 注水、筒开始转 | `running` 且本轮**还没有任何节点**（模型在出第一个字） |
| `washing` | 洗涤，泡多水满 | `running` 且正在流式出字（`partial` 非空），或上一步是工具 |
| `rinsing` | 漂洗，反转 | `running` 且有工具在跑（`runningCalls` 非空），卡片显示最后一个工具名 |
| `spinning` | 脱水，高速抖动 | `running` 且无工具无流式，本轮最后一个节点是模型输出（收尾） |
| `waiting` | 暂停，灯闪琥珀 | `sessionStatus.pendingInteraction` 有值（等批准 / 等回答） |
| `draining` | 排水换水 | 上下文压缩进行中（`useTrajectory` 快照里最后一条 `purpose: 'compaction'` 的 request 状态为 `running`） |
| `done` | 洗完了 | 本轮正常结束，停 `doneHoldMs` 后自动回 `idle` |
| `error` | 故障 | `turn-error` 节点、或**本轮最后一条**工具 `isError`（失败后自愈重试成功不报故障） |
| `off` | 关机 | 会话被移除 / 不可用 |

错误码：`E-10` 模型/账号、`E-20` 工具失败、`E-21` 审批被拒、`E-30` 上下文/长度、`E-40` 中断、`E-50` 策略拦截、`E-00` 未知。

> 只认**本轮最后一条**节点的成败：Agent 工具失败后自己重试成功，不报故障——避免假警报。

## 三档密度

| 档位 | 尺寸 | 内容 | 皮肤（`skin: 'auto'` 时） |
|---|---|---|---|
| `S` | 322×52 停靠条 | 32px 像素 sprite + 一行状态 + 计时 | 像素风 |
| `M` | 322×206 卡片 | 96px 精密家电 + 状态/工具流水 | 精密家电 |
| `L` | 322×343 卡片 | 176px 大机器 + 工具流水 + token/耗时/成本 | 动漫风 |

点停靠条展开 / 收起。

## 安装

```bash
# 本地目录安装（插件管理器等价命令）
dsh plugin --profile desktop add /path/to/dsh-washer
```

装完在 profile 的 `cordis.patch.yml` 里会多出一行 bundle 引用。改完重启 Harness（替换已装包需要重启，新装包由 HMR 接管）。

**卸载**：`dsh plugin --profile desktop remove dsh-washer`

## 配置

两条路，互相配合：

1. **默认值**写在 `cordis.patch.yml` 的 `washer` 行 `config:` 下（全部可选，见下表）。
2. **用户改动**在 GUI 里做——展开到 L 档卡片用分段控件切，或打开 **设置 → 洗衣机**。改动存进浏览器 `localStorage`（key `dsh-washer:prefs`），读取顺序是 `内置默认` ← `patch config` ← `localStorage`。

> 为什么不走宿主统一的设置持久化（`ctx.configForms`）：那套 store 只服务挂在 loader `include` 行下的插件，第三方 bundle 走 `- insert:` 拿到的控制器永远是 `unavailable`（写进去读不回来）。已装的 `dsh-better-sidebar` 同样绕开它、自存 `localStorage`。
>
> 代价：桌面悬浮窗（规划中）读不到 `localStorage`，到时要让 Host 半读 profile 配置或走 RPC。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时完全不挂载（连样式都不注册） |
| `mode` | `'dock'` | `'dock'` 挂在输入框上方；`'overlay'` 挂到 `shell.overlay`（全局浮层） |
| `size` | `'S'` | 初始档位 `'S'` / `'M'` / `'L'` |
| `expandedByDefault` | `false` | 等价于 `size: 'M'`（旧名，保留兼容） |
| `skin` | `'auto'` | `'auto'` / `'pixel'` / `'precision'` / `'anime'` |
| `skinBySize` | `{xs:pixel, sm:precision, md:precision, lg:anime}` | `auto` 模式下尺寸→皮肤 |
| `face` | `false` | 动漫风是否显示那双眼睛（默认关） |
| `reduceMotion` | `'auto'` | `'auto'` 跟随系统 `prefers-reduced-motion`；`'always'` / `'never'` 强制 |
| `showCost` | `false` | L 档显示成本（需配合 `costPerKToken`） |
| `costPerKToken` | `0` | 每千 token 单价 |
| `costCurrency` | `'CNY'` | `'CNY'` → `¥`，`'USD'` → `$` |
| `hideWhenIdle` | `false` | 待机时整个隐藏 |
| `doneHoldMs` | `6000` | 「洗完了」停留时长 |
| `toolHistoryLimit` | `6` | 工具流水最多显示几条 |

示例：

```yaml
- insert:
    - id: washer
      name: 'dsh-washer'
      config:
        size: 'M'
        skin: 'precision'
        face: true
        showCost: true
        costPerKToken: 0.004
```

## 设计约束

- **只读**：不往会话里写任何事件，不改其他插件的 DOM。
- **不抢焦点**：停靠条是一个 `<button>`，键盘可达，`:focus-visible` 有描边。
- **尊重动效偏好**：`prefers-reduced-motion: reduce` 时全部动画降到 0.001ms。
- **颜色**：容器/文字走宿主 `--dsw-alias-*` token；只有机身材质用自有 `--dw-*`（暗色由 `[data-ds-dark-theme]` 切换）。
- **零依赖**：不打包 React，直接 `require('react')` 用宿主那一份。

## 开发

```bash
node build.mjs                   # src/ → client.js（内联 core/css/svg，约 126KB）
node --test test/core.test.mjs   # 状态机单测（29 条）
node --test test/host.test.mjs   # 宿主半单测（15 条）
node test/render.mjs             # 行为测试（30 条）+ 生成 /tmp/washer-render 截图素材
node debug/e2e.mjs               # 端到端：起真服务 + 模拟事件流，逐行打印状态迁移
```

- `src/core.js` 纯函数状态机，node 下可直接测。
- `src/client.template.js` 组件源码，`build.mjs` 把 core/CSS/SVG 内联成单文件 `client.js`。
- `test/render.mjs` 是最小 React hooks 运行时：真跑 hooks、真 re-render，能测到时间轴行为。

### 宿主半（`index.js`）：P1b 数据管道

Web 端的 `deriveState` 吃的是宿主渲染进程里的投影，独立的桌面窗口（Electron）拿不到那些东西。所以宿主半在 Node 侧监听同一批事件、喂给**同一个** `src/core.js`，再通过本地 HTTP+WS 把快照推出去——两边判定只有一份实现，不会各写一套然后对不上。

```yaml
desktopOverlay: false        # 默认关；开了才占端口
desktopOverlayPort: 0        # 0 = 系统分配，日志里打印实际地址
```

- 只绑 `127.0.0.1`，每次启动生成随机 token，`/dsh-washer/state`、`/dsh-washer/health`、`WS /dsh-washer/stream` 全部要 token（query 或 Bearer）。
- 调试端：`debug/overlay.html?port=端口&token=令牌`，浏览器直接打开就能看状态流转，断线会自动指数退避重连。
- 两个必须守住的点，都有回归测试：**工具返回后不能还停在 rinsing**（状态撒谎比不显示更糟）；**`step/*` 不能进节点序列**——`deriveState` 用「最后一个节点是不是产出类节点」判断走到哪，`step-*` 不在白名单里，混进去会让状态从 washing 倒退成 starting。

### 调试：插件"不见了"先看这里

- **新会话里本来就不显示**。`sessionId` 为空时组件按设计返回 `null`——先打开一个会话再看。
- 判断是不是加载失败：页面若无「启动失败」卡片，说明所有 entry 都激活成功（宿主 `bZ()` 审计会在有失败时抛 `web boot: N entries did not activate` 并渲染卡片）。
- 两条激活通道别混：装进 profile 的 bundle 由启动时的 `manifest.plugins → entries.start → loader.create` 自动激活（本插件走这条）；`cordis-host-runner` 那套只服务模型用 `cordis_define` 现写的动态插件。
- 替换已装包要重启宿主；新装包可被 HMR 接管。

## 许可

个人项目，未发布。图标与像素 sprite 均为原创（脚本生成，见 `src/machine.svg`、`src/sprite.svg`）。

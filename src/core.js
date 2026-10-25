/**
 * dsh-washer 状态核心（纯函数，无 React、无 DOM）。
 *
 * 设计约束（诚实性优先）：
 * - 每个状态都必须由宿主真实数据推导，禁止猜测。
 * - 输入只有：会话快照、sessionStatus、projection、chat legacy 切片。
 * - 本文件可在 node 下直接跑单测（见 test/core.test.mjs）。
 */

/** 需要立即切换、不受最小停留时间约束的状态。 */
export const URGENT_STATES = { off: 1, waiting: 1, error: 1, idle: 1, done: 1 };

/** 不参与「当前步骤位置」判断的节点类型（宿主注入，非 Agent 产出）。 */
export const IGNORED_NODE_KINDS = new Set(['context']);

/** 代表「Agent 已经产出东西」的节点类型（dsh-client-ui-chat legacy nodes）。 */
export const OUTPUT_NODE_KINDS = new Set([
  'assistant', 'tool-call', 'tool-result', 'reasoning', 'text', 'image',
  'turn-error', 'turn-max-tokens', 'model-retry',
]);

/**
 * 从 turnOutline 取当前轮号。
 * view 形态是数组（wire.view = state.turns），也兼容 { turns } 包装。
 * @param {unknown} outline useProjection('turnOutline')
 * @returns {number} 无数据时 0
 */
export function latestTurnOf(outline) {
  const turns = Array.isArray(outline) ? outline : outline && Array.isArray(outline.turns) ? outline.turns : null;
  if (turns === null || turns.length === 0) return 0;
  const last = turns[turns.length - 1];
  return last && typeof last.turn === 'number' ? last.turn : 0;
}

/**
 * 当前轮是否已经产出了东西（有 prompt 或 response 预览）。
 * @param {unknown} outline
 * @param {number} turn
 * @returns {boolean}
 */
export function turnProduced(outline, turn) {
  const turns = Array.isArray(outline) ? outline : outline && Array.isArray(outline.turns) ? outline.turns : null;
  if (turns === null) return false;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const entry = turns[i];
    if (!entry || entry.turn !== turn) continue;
    return entry.prompt !== '' || entry.response !== '';
  }
  return false;
}

/**
 * 取当前轮里的 turn-error 节点。
 * @param {unknown} nodes useChat(s => s.legacy.nodes)
 * @param {number} [turn] 限定轮次
 * @returns {object | undefined}
 */
export function findTurnError(nodes, turn) {
  if (!Array.isArray(nodes)) return undefined;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (!node || node.kind !== 'turn-error') continue;
    if (turn !== undefined && node.turn !== turn) continue;
    return node;
  }
  return undefined;
}

/**
 * 取当前轮最后一个节点（nodes 是旧→新，所以倒着找第一个匹配的）。
 * @param {unknown} nodes useChat(s => s.legacy.nodes)
 * @param {number} [turn] 限定轮次
 * @returns {object | undefined}
 */
export function lastNodeOf(nodes, turn) {
  if (!Array.isArray(nodes)) return undefined;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (!node) continue;
    // context 是宿主注入的上下文节点（system-reminder / runtime snapshot），
    // 不代表 Agent 产出了任何东西，不能拿来判断「这一步走到哪」。
    if (IGNORED_NODE_KINDS.has(node.kind)) continue;
    if (turn !== undefined && typeof node.turn === 'number' && node.turn !== turn) continue;
    return node;
  }
  return undefined;
}

/**
 * 当前轮「因工具失败而收场」的节点：轮次最后一条就是失败的 tool/result。
 * 只认最后一条 —— 失败后 Agent 自己重试成功的话，不该报故障。
 * @param {unknown} nodes
 * @param {number} [turn]
 * @returns {object | undefined}
 */
export function findToolFailure(nodes, turn) {
  const node = lastNodeOf(nodes, turn);
  if (node === undefined || node.kind !== 'tool-result' || node.isError !== true) return undefined;
  return node;
}

/**
 * 是否正在做上下文压缩。
 *
 * 数据源：宿主标准 prop `useTrajectory(s => s)` 的 `requests`，里面
 * `{purpose:'compaction', status:'running'}` 的条目表示压缩正在跑。
 *
 * 为什么不用 chat legacy nodes：`compaction` 节点只在**落地**后出现
 * （ui-chat 的 buildViewNode 要求 state.checkpoint 存在），压缩进行中那条 request
 * 还没进 nodes，所以从 nodes 永远看不出「正在压缩」。
 *
 * @param {unknown} trajectory useTrajectory(s => s)
 * @returns {boolean}
 */
export function compactionRunning(trajectory) {
  if (trajectory === undefined || trajectory === null) return false;
  const requests = Array.isArray(trajectory)
    ? trajectory
    : Array.isArray(trajectory.requests) ? trajectory.requests : null;
  if (requests === null) return false;
  // 只看最后一条 compaction 请求：更早的失败/完成记录不代表现在还在压。
  for (let i = requests.length - 1; i >= 0; i -= 1) {
    const request = requests[i];
    if (!request || request.purpose !== 'compaction') continue;
    return request.status === 'running';
  }
  return false;
}

/**
 * 正在执行的工具调用。
 * @param {unknown} runningCalls useChat(s => s.legacy.runningCalls)
 * @returns {{name: string, callId: string, turn?: number, step?: number} | undefined}
 */
export function activeTool(runningCalls) {
  if (!Array.isArray(runningCalls) || runningCalls.length === 0) return undefined;
  const call = runningCalls[runningCalls.length - 1];
  if (!call) return undefined;
  return {
    name: typeof call.name === 'string' && call.name !== '' ? call.name : 'tool',
    callId: call.callId === undefined || call.callId === null ? '' : String(call.callId),
    ...typeof call.turn === 'number' ? { turn: call.turn } : {},
    ...typeof call.step === 'number' ? { step: call.step } : {},
  };
}

/**
 * 最近完成的工具调用（旧→新，可直接渲染）。
 * @param {unknown} nodes chat legacy nodes
 * @param {number} limit 条数上限
 * @returns {Array<{name: string, isError: boolean, ms?: number}>}
 */
export function recentTools(nodes, limit = 5) {
  const max = Math.max(1, limit);
  const collected = [];
  if (Array.isArray(nodes)) {
    for (let i = nodes.length - 1; i >= 0 && collected.length < max; i -= 1) {
      const node = nodes[i];
      if (!node || node.kind !== 'tool-result') continue;
      const started = typeof node.callTime === 'number' ? node.callTime : undefined;
      const ended = typeof node.time === 'number' ? node.time : undefined;
      collected.push({
        name: typeof node.name === 'string' && node.name !== '' ? node.name : 'tool',
        isError: node.isError === true,
        ...started !== undefined && ended !== undefined ? { ms: Math.max(0, ended - started) } : {},
      });
    }
  }
  return collected.reverse();
}

/**
 * 当前轮的工具调用总数（含子调用）。
 * @param {unknown} nodes
 * @param {number} turn
 * @returns {number}
 */
export function toolCountOf(nodes, turn) {
  if (!Array.isArray(nodes)) return 0;
  let count = 0;
  for (const node of nodes) {
    if (!node || node.kind !== 'tool-result') continue;
    if (turn !== 0 && typeof node.turn === 'number' && node.turn !== turn) continue;
    count += 1;
  }
  return count;
}

/**
 * turn-error 节点 → E 码。
 * @param {object | undefined} node
 * @returns {string} 形如 'E-20'
 */
export function errorCodeOf(node) {
  if (!node) return 'E-00';
  if (node.kind === 'tool-result' && node.isError === true) return 'E-20';
  const code = typeof node.code === 'string' ? node.code : '';
  if (code === 'ACCOUNT_SIGNED_OUT') return 'E-10';
  if (code === 'INTERRUPTED') return 'E-40';
  if (code === 'APPROVAL_DENIED' || code === 'PERMISSION_DENIED') return 'E-21';
  const message = typeof node.message === 'string' ? node.message : '';
  if (/max.?tokens|context|token limit/i.test(message)) return 'E-30';
  if (/abort|cancel|interrupt|stop/i.test(message)) return 'E-40';
  if (/block|policy|denied|refus/i.test(message)) return 'E-50';
  return 'E-10';
}

/**
 * turnTimings 是 Map<turn, {startTime, endTime?}>。
 * @param {unknown} turnTimings
 * @param {number} turn
 * @param {number} now
 * @returns {number | undefined} 毫秒
 */
export function elapsedOf(turnTimings, turn, now) {
  if (!turnTimings || typeof turnTimings.get !== 'function') return undefined;
  const timing = turnTimings.get(turn);
  if (!timing || typeof timing.startTime !== 'number') return undefined;
  const end = typeof timing.endTime === 'number' ? timing.endTime : now;
  return Math.max(0, end - timing.startTime);
}

/**
 * @param {unknown} turnTimings
 * @param {number} turn
 * @returns {number | undefined} 该轮结束时间戳
 */
export function turnEndTimeOf(turnTimings, turn) {
  if (!turnTimings || typeof turnTimings.get !== 'function') return undefined;
  const timing = turnTimings.get(turn);
  return timing && typeof timing.endTime === 'number' ? timing.endTime : undefined;
}

/**
 * 核心：由可观测输入推导洗衣机状态。
 *
 * @param {object} input
 * @param {string | undefined} input.sessionId
 * @param {boolean} input.running 会话是否在跑
 * @param {unknown} input.pending 待处理交互（审批/提问）
 * @param {unknown} input.runningCalls 正在跑的工具调用
 * @param {unknown} input.partial 正在流式生成的助手步骤
 * @param {unknown} input.nodes chat legacy nodes
 * @param {unknown} input.outline turnOutline projection
 * @param {unknown} [input.trajectory] useTrajectory 快照（判断是否在压缩上下文）
 * @param {{kind: 'done', turn: number, until: number} | null} input.sticky
 * @param {number} input.now
 * @returns {string} 状态名
 */
export function deriveState(input) {
  const { sessionId, running, pending, runningCalls, partial, nodes, outline, trajectory, sticky, now } = input;

  if (sessionId === undefined || sessionId === null || sessionId === '') return 'off';
  if (pending !== undefined && pending !== null) return 'waiting';

  const turn = latestTurnOf(outline);

  if (running) {
    // 压缩上下文是「排水换水」：先把筒里的水放掉再注新水，之后照常洗。
    // 优先级高于工具/流式：压缩期间模型本来就不在出字，报 washing 是假的。
    if (compactionRunning(trajectory)) return 'draining';
    if (activeTool(runningCalls) !== undefined) return 'rinsing';
    if (partial !== undefined && partial !== null) return 'washing';
    // 只看「这一轮最后一个节点」判断步骤位置（节点 kind 见 dsh-client-ui-chat）：
    //   没有节点 → 刚起轮，模型还在出第一个字 → starting
    //   上次是工具（tool-call/tool-result）→ 模型在想下一步 → 继续 washing
    //   上次是模型输出（assistant）→ 在收尾 → spinning
    const last = lastNodeOf(nodes, turn);
    if (last === undefined || !OUTPUT_NODE_KINDS.has(last.kind)) return 'starting';
    if (last.kind === 'tool-result' || last.kind === 'tool-call') return 'washing';
    return 'spinning';
  }

  if (findTurnError(nodes, turn) !== undefined) return 'error';
  if (findToolFailure(nodes, turn) !== undefined) return 'error';
  if (sticky && sticky.kind === 'done' && now < sticky.until) return 'done';
  return 'idle';
}

/**
 * 状态 → 32px sprite 的三个可动图层。
 * 数值是 SVG viewBox 用户单位（不是百分比——百分比按 viewBox 对角线解析，水会飞出画面）。
 * 水层 y8..y15 共 8 单位：0 = 满，7 = 见底。语义与真机一致：待机/完成时筒里基本是空的。
 */
export const VISUAL = {
  off: { water: 7, foam: 0, led: '#4a5560', blink: 0, spin: 0 },
  idle: { water: 6.5, foam: 0, led: '#7c8896', blink: 0, spin: 0 },
  starting: { water: 3.5, foam: 0.3, led: '#3aa0ff', blink: 0, spin: 5 },
  washing: { water: 0.5, foam: 1, led: '#3aa0ff', blink: 0, spin: 2.4 },
  rinsing: { water: 0.5, foam: 0.6, led: '#3aa0ff', blink: 0, spin: 2.4 },
  spinning: { water: 4, foam: 0, led: '#3aa0ff', blink: 0, spin: 0.6 },
  waiting: { water: 4.5, foam: 0.2, led: '#f5b93a', blink: 0.6, spin: 0 },
  draining: { water: 7, foam: 0, led: '#1f9aa8', blink: 0, spin: 5 },
  done: { water: 6.5, foam: 0, led: '#2ee06a', blink: 0, spin: 0 },
  error: { water: 5, foam: 0, led: '#e5484d', blink: 0.35, spin: 0 },
};

/**
 * 一个时长。
 *
 * 默认 45 秒：低于这个数多半是模型在长思考或一个大工具（构建、测试、
 * 网络请求）正在跑，报"卡住"是误报；超过它，用户盯着转圈却看不到任何
 * 输出，就是真的需要一句真话的时候。
 */
const STALL_AFTER_MS = 45000;

/**
 * 判断"看着在转、其实没动静"。
 *
 * 停靠条只显示已运行时长，于是卡住 5 分钟和正常跑 5 分钟长得一模一样。
 * 洗衣机转得再好看，回答不了用户真正想问的那句"它是不是死了"。
 *
 * 口径（宁可漏报不误报）：
 *   1. 只在真的该有产出时才判——running 且状态是 washing/rinsing/spinning。
 *      starting 是新轮刚起，draining 是压缩（本来就不出字），都不算。
 *   2. 先要求"曾经有过产出"（samples 里至少两个点）。第一轮还没吐第一个字
 *      的长思考不该被叫卡住。
 *   3. 距最后一次**有增长**的采样超过 STALL_AFTER_MS 才算。
 *
 * @returns {number | null} 卡了多久（毫秒）；没卡返回 null。
 */
export function stalledForOf(samples, state, now, thresholdMs = STALL_AFTER_MS) {
  if (state !== 'washing' && state !== 'rinsing' && state !== 'spinning') return null;
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const last = samples[samples.length - 1];
  const idleMs = now - last.at;
  if (idleMs <= thresholdMs) return null;
  return idleMs;
}

/**
 * 从历史轮次的耗时里算一个基线（毫秒），用来估"还要多久"。
 *
 * 只用**已完成**的轮次（有 endTime 的）：正在跑那一轮的 endTime 还没有，
 * 混进去会把平均值拉低，估出来的剩余时间偏乐观。
 *
 * 取中位数不取均值：一轮卡住跑了 10 分钟，均值就被它带飞了，
 * 而这恰恰是最该被忽略的离群值。
 *
 * 少于 2 轮不估——一轮的"平均值"没有意义，宁可不说也别乱说。
 *
 * @param {Map<number, {startTime?: number, endTime?: number}>} turnTimings
 * @param {number} [limit] 只看最近几轮（越久远的行为越不代表现在）
 * @returns {number | null} 典型轮时长（毫秒）；样本不够返回 null。
 */
export function typicalTurnMs(turnTimings, limit = 8) {
  if (!turnTimings || typeof turnTimings.get !== 'function') return null;
  const spans = [];
  for (const timing of turnTimings.values()) {
    if (timing === null || typeof timing !== 'object') continue;
    const { startTime, endTime } = timing;
    if (typeof startTime !== 'number' || typeof endTime !== 'number') continue;
    const span = endTime - startTime;
    if (span <= 0) continue;
    spans.push(span);
  }
  if (spans.length < 2) return null;
  const recent = spans.slice(-limit).sort((a, b) => a - b);
  const mid = recent.length >> 1;
  return recent.length % 2 === 0
    ? (recent[mid - 1] + recent[mid]) / 2
    : recent[mid];
}

/**
 * 预计还要多久。已经超过典型时长时返回 0，不返回负数。
 *
 * @param {number | null} typicalMs 典型轮时长
 * @param {number | null} elapsedMs 本轮已跑多久
 * @returns {number | null} 剩余毫秒；估不出来返回 null。
 */
export function remainingOf(typicalMs, elapsedMs) {
  if (typeof typicalMs !== 'number' || !Number.isFinite(typicalMs) || typicalMs <= 0) return null;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) return null;
  return Math.max(0, typicalMs - elapsedMs);
}

/**
 * 毫秒 → mm:ss。
 * @param {number | undefined} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '--:--';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}

/**
 * 毫秒 → 1.2s / 340ms。
 * @param {number | undefined} ms
 * @returns {string}
 */
export function formatToolMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

/**
 * token 数 → 12.4k。
 * @param {number | undefined} n
 * @returns {string}
 */
export function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  return (n / 1000).toFixed(1) + 'k';
}

/**
 * 状态 → 排序权重，用于「不要在小状态间来回抖」的迟滞判断。
 * @param {string} state
 * @returns {number}
 */
export function stateWeight(state) {
  if (state === 'error') return 100;
  if (state === 'waiting') return 90;
  if (state === 'done') return 60;
  if (state === 'rinsing' || state === 'washing' || state === 'spinning' || state === 'starting' || state === 'draining') return 50;
  if (state === 'idle') return 10;
  return 0;
}

/**
 * 迟滞窗口：降级切换要在这个状态停留多久才放行。
 *
 * 导出是因为另外两处也要用同一个数：
 *   - 悬浮窗（index.js 的 settleState）到点要重算一次，得知道等多久
 *   - 客户端 dock 的 setTimeout 补偿（src/client.template.js）同理
 * 各写一个 400 迟早会漂。
 */
export const SWITCH_HOLD_MS = 400;

/**
 * 迟滞：从旧状态切到新状态是否值得（避免 rinsing/washing 之间高频抖动）。
 * @param {string} from
 * @param {string} to
 * @param {number} heldMs 当前状态已停留时长
 * @returns {boolean}
 */
export function shouldSwitch(from, to, heldMs) {
  if (from === to) return false;
  if (URGENT_STATES[to] === 1) return true;
  if (URGENT_STATES[from] === 1) return true;
  if (stateWeight(to) > stateWeight(from)) return true;
  return heldMs >= SWITCH_HOLD_MS;
}

window.__ModuleLoader__.load({
  id: 'dsh-washer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /* ------------------------------------------------------------------ *
     * 状态核心（构建时由 src/core.js 内联；纯函数，单测见 test/core.test.mjs）
     * ------------------------------------------------------------------ */
    /**
 * dsh-washer 状态核心（纯函数，无 React、无 DOM）。
 *
 * 设计约束（诚实性优先）：
 * - 每个状态都必须由宿主真实数据推导，禁止猜测。
 * - 输入只有：会话快照、sessionStatus、projection、chat legacy 切片。
 * - 本文件可在 node 下直接跑单测（见 test/core.test.mjs）。
 */

/** 十个状态，顺序即优先级（off 最高）。 */
const STATES = [
  'off',
  'waiting',
  'error',
  'rinsing',
  'washing',
  'starting',
  'spinning',
  'draining',
  'done',
  'idle',
];

/** 需要立即切换、不受最小停留时间约束的状态。 */
const URGENT_STATES = { off: 1, waiting: 1, error: 1, idle: 1, done: 1 };

/** 不参与「当前步骤位置」判断的节点类型（宿主注入，非 Agent 产出）。 */
const IGNORED_NODE_KINDS = new Set(['context']);

/** 代表「Agent 已经产出东西」的节点类型（dsh-client-ui-chat legacy nodes）。 */
const OUTPUT_NODE_KINDS = new Set([
  'assistant', 'tool-call', 'tool-result', 'reasoning', 'text', 'image',
  'turn-error', 'turn-max-tokens', 'model-retry',
]);

/** 完成态在状态机里短暂停留的时长（毫秒）。 */
const DONE_HOLD_MS = 6000;

/**
 * 从 turnOutline 取当前轮号。
 * view 形态是数组（wire.view = state.turns），也兼容 { turns } 包装。
 * @param {unknown} outline useProjection('turnOutline')
 * @returns {number} 无数据时 0
 */
function latestTurnOf(outline) {
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
function turnProduced(outline, turn) {
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
function findTurnError(nodes, turn) {
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
function lastNodeOf(nodes, turn) {
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
function findToolFailure(nodes, turn) {
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
function compactionRunning(trajectory) {
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
function activeTool(runningCalls) {
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
function recentTools(nodes, limit = 5) {
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
function toolCountOf(nodes, turn) {
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
function errorCodeOf(node) {
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
 * 错误码 → 人类可读的解释。
 *
 * 码本身是给机器看的（E-20 之类），用户看到 "E-20 · 点开看看" 并不知道该干什么。
 * 这里把每类故障翻译成「发生了什么 + 你能做什么」，两者都用 locale key 表达，
 * 具体文案在客户端字典里。
 *
 * @param {string} code
 * @returns {{ title: string, hint: string }}
 */
function explainError(code) {
  switch (code) {
    case 'E-10':
      // 账号 / 上游服务问题，用户自己能处理
      return { title: 'err.e10.title', hint: 'err.e10.hint' };
    case 'E-20':
      // 工具执行失败：Agent 通常能自愈，提示它是在自愈还是真挂了
      return { title: 'err.e20.title', hint: 'err.e20.hint' };
    case 'E-21':
      // 审批被拒 / 权限不足：这是用户主动的选择，不是故障
      return { title: 'err.e21.title', hint: 'err.e21.hint' };
    case 'E-30':
      // 上下文超限：需要清理会话或压缩
      return { title: 'err.e30.title', hint: 'err.e30.hint' };
    case 'E-40':
      // 被中断：用户或宿主主动停止，不算出错
      return { title: 'err.e40.title', hint: 'err.e40.hint' };
    case 'E-50':
      // 策略拦截：内容/权限策略
      return { title: 'err.e50.title', hint: 'err.e50.hint' };
    default:
      return { title: 'err.e00.title', hint: 'err.e00.hint' };
  }
}

/**
 * turnTimings 是 Map<turn, {startTime, endTime?}>。
 * @param {unknown} turnTimings
 * @param {number} turn
 * @param {number} now
 * @returns {number | undefined} 毫秒
 */
function elapsedOf(turnTimings, turn, now) {
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
function turnEndTimeOf(turnTimings, turn) {
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
function deriveState(input) {
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
const VISUAL = {
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

/** 状态色（圆点 / 强调文字）。 */
const STATE_COLOR = {
  off: '#8f9ba8',
  idle: '#2f9e63',
  starting: '#2f86d6',
  washing: '#2f86d6',
  rinsing: '#2f86d6',
  spinning: '#2f86d6',
  waiting: '#d99a1f',
  draining: '#1f9aa8',
  done: '#2f9e63',
  error: '#d94a4f',
};

/**
 * 毫秒 → mm:ss。
 * @param {number | undefined} ms
 * @returns {string}
 */
function formatDuration(ms) {
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
function formatToolMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

/**
 * token 数 → 12.4k。
 * @param {number | undefined} n
 * @returns {string}
 */
function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  return (n / 1000).toFixed(1) + 'k';
}

/**
 * 状态 → 排序权重，用于「不要在小状态间来回抖」的迟滞判断。
 * @param {string} state
 * @returns {number}
 */
function stateWeight(state) {
  if (state === 'error') return 100;
  if (state === 'waiting') return 90;
  if (state === 'done') return 60;
  if (state === 'rinsing' || state === 'washing' || state === 'spinning' || state === 'starting' || state === 'draining') return 50;
  if (state === 'idle') return 10;
  return 0;
}

/**
 * 迟滞：从旧状态切到新状态是否值得（避免 rinsing/washing 之间高频抖动）。
 * @param {string} from
 * @param {string} to
 * @param {number} heldMs 当前状态已停留时长
 * @returns {boolean}
 */
function shouldSwitch(from, to, heldMs) {
  if (from === to) return false;
  if (URGENT_STATES[to] === 1) return true;
  if (URGENT_STATES[from] === 1) return true;
  if (stateWeight(to) > stateWeight(from)) return true;
  return heldMs >= 400;
}

    /* ------------------------------------------------------------------ *
     * 素材（构建时内联）
     * ------------------------------------------------------------------ */
    const SPRITE_SVG = "<svg class=\"px-sprite\" viewBox=\"0 0 16 20\" width=\"32\" height=\"40\" shape-rendering=\"crispEdges\" aria-label=\"washer small\"><defs><clipPath id=\"pxSpriteGlass\"><circle cx=\"7.5\" cy=\"11.5\" r=\"3.4\"/></clipPath></defs><path fill=\"#2b3d57\" d=\"M2 0h12v1h-12zM1 1h14v1h-14zM0 2h1v1h-1zM15 2h1v1h-1zM0 3h1v1h-1zM15 3h1v1h-1zM0 4h1v1h-1zM15 4h1v1h-1zM0 5h1v1h-1zM15 5h1v1h-1zM0 6h1v1h-1zM15 6h1v1h-1zM0 7h1v1h-1zM5 7h6v1h-6zM15 7h1v1h-1zM0 8h1v1h-1zM4 8h1v1h-1zM11 8h1v1h-1zM15 8h1v1h-1zM0 9h1v1h-1zM3 9h1v1h-1zM12 9h1v1h-1zM15 9h1v1h-1zM0 10h1v1h-1zM3 10h1v1h-1zM12 10h1v1h-1zM15 10h1v1h-1zM0 11h1v1h-1zM3 11h1v1h-1zM12 11h1v1h-1zM15 11h1v1h-1zM0 12h1v1h-1zM3 12h1v1h-1zM12 12h1v1h-1zM15 12h1v1h-1zM0 13h1v1h-1zM3 13h1v1h-1zM12 13h1v1h-1zM15 13h1v1h-1zM0 14h1v1h-1zM3 14h1v1h-1zM12 14h1v1h-1zM15 14h1v1h-1zM0 15h1v1h-1zM4 15h1v1h-1zM11 15h1v1h-1zM15 15h1v1h-1zM0 16h1v1h-1zM5 16h6v1h-6zM15 16h1v1h-1zM0 17h1v1h-1zM15 17h1v1h-1zM1 18h14v1h-14zM2 19h12v1h-12z\"/><path fill=\"#eaf1f8\" d=\"M1 2h13v1h-13z\"/><path fill=\"#dfe7f1\" d=\"M14 2h1v1h-1zM14 3h1v1h-1zM14 4h1v1h-1zM1 5h14v1h-14zM14 6h1v1h-1zM14 7h1v1h-1zM14 8h1v1h-1zM14 9h1v1h-1zM14 10h1v1h-1zM14 11h1v1h-1zM14 12h1v1h-1zM14 13h1v1h-1zM14 14h1v1h-1zM14 15h1v1h-1zM14 16h1v1h-1zM14 17h1v1h-1z\"/><path fill=\"#ffffff\" d=\"M1 3h9v1h-9zM1 4h9v1h-9zM1 6h13v1h-13zM1 7h4v1h-4zM11 7h3v1h-3zM1 8h3v1h-3zM12 8h2v1h-2zM1 9h2v1h-2zM13 9h1v1h-1zM1 10h2v1h-2zM13 10h1v1h-1zM1 11h2v1h-2zM13 11h1v1h-1zM1 12h2v1h-2zM13 12h1v1h-1zM1 13h2v1h-2zM13 13h1v1h-1zM1 14h2v1h-2zM13 14h1v1h-1zM1 15h3v1h-3zM12 15h2v1h-2zM1 16h4v1h-4zM11 16h3v1h-3zM1 17h13v1h-13z\"/><path fill=\"#111b2c\" d=\"M10 3h1v1h-1zM13 3h1v1h-1zM10 4h4v1h-4zM7 9h3v1h-3zM6 10h5v1h-5zM5 11h6v1h-6zM5 12h6v1h-6zM5 13h6v1h-6zM6 14h4v1h-4z\"/><path fill=\"#334a75\" d=\"M5 8h2v1h-2zM9 8h2v1h-2zM4 9h1v1h-1zM11 9h1v1h-1zM4 10h1v1h-1zM11 10h1v1h-1zM4 13h1v1h-1zM11 13h1v1h-1zM4 14h1v1h-1zM11 14h1v1h-1zM5 15h2v1h-2zM9 15h2v1h-2z\"/><path fill=\"#1a2740\" d=\"M7 8h2v1h-2zM10 9h1v1h-1zM4 11h1v1h-1zM11 11h1v1h-1zM4 12h1v1h-1zM11 12h1v1h-1zM5 14h1v1h-1zM10 14h1v1h-1zM7 15h2v1h-2z\"/><path fill=\"#3f5c85\" d=\"M5 9h2v1h-2zM5 10h1v1h-1z\"/><g clip-path=\"url(#pxSpriteGlass)\"><g class=\"px-water\"><path fill=\"#8fd4f5\" d=\"M4 8h8v1h-8z\"/><path fill=\"#3f9fd6\" d=\"M4 9h8v1h-8zM4 10h8v1h-8zM4 11h8v1h-8zM4 12h8v1h-8zM4 13h8v1h-8zM4 14h8v1h-8zM4 15h8v1h-8z\"/></g></g><g class=\"px-foam\"><path fill=\"#ffffff\" d=\"M6 13h1v1h-1zM8 13h1v1h-1zM7 14h1v1h-1z\"/></g><path fill=\"#2ee06a\" class=\"px-led\" d=\"M11 3h2v1h-2z\"/></svg>";
    const MACHINE_SVG = "<svg class=\"px-svg\" viewBox=\"0 0 64 78\" shape-rendering=\"crispEdges\" aria-label=\"washer\"><defs><clipPath id=\"pxGlass\"><circle cx=\"31\" cy=\"43\" r=\"16.5\"/></clipPath></defs><path fill=\"#2b3d57\" d=\"M3 1h58v1h-58zM3 2h1v1h-1zM60 2h1v1h-1zM3 3h1v1h-1zM60 3h1v1h-1zM3 4h1v1h-1zM39 4h4v1h-4zM60 4h1v1h-1zM3 5h1v1h-1zM37 5h8v1h-8zM46 5h11v1h-11zM60 5h1v1h-1zM3 6h1v1h-1zM8 6h19v1h-19zM36 6h11v1h-11zM56 6h1v1h-1zM60 6h1v1h-1zM3 7h1v1h-1zM8 7h1v1h-1zM26 7h1v1h-1zM36 7h11v1h-11zM56 7h1v1h-1zM60 7h1v1h-1zM3 8h1v1h-1zM8 8h1v1h-1zM26 8h1v1h-1zM35 8h4v1h-4zM43 8h4v1h-4zM56 8h1v1h-1zM60 8h1v1h-1zM3 9h1v1h-1zM8 9h1v1h-1zM26 9h1v1h-1zM35 9h4v1h-4zM43 9h4v1h-4zM56 9h1v1h-1zM60 9h1v1h-1zM3 10h1v1h-1zM8 10h1v1h-1zM26 10h1v1h-1zM35 10h4v1h-4zM43 10h4v1h-4zM56 10h1v1h-1zM60 10h1v1h-1zM3 11h1v1h-1zM8 11h1v1h-1zM26 11h1v1h-1zM35 11h4v1h-4zM43 11h4v1h-4zM56 11h1v1h-1zM60 11h1v1h-1zM3 12h1v1h-1zM8 12h1v1h-1zM26 12h1v1h-1zM36 12h11v1h-11zM56 12h1v1h-1zM60 12h1v1h-1zM3 13h1v1h-1zM8 13h19v1h-19zM36 13h21v1h-21zM60 13h1v1h-1zM3 14h1v1h-1zM37 14h8v1h-8zM60 14h1v1h-1zM3 15h1v1h-1zM39 15h4v1h-4zM60 15h1v1h-1zM3 16h1v1h-1zM60 16h1v1h-1zM3 17h58v1h-58zM3 18h1v1h-1zM60 18h1v1h-1zM3 19h1v1h-1zM60 19h1v1h-1zM3 20h1v1h-1zM60 20h1v1h-1zM3 21h1v1h-1zM60 21h1v1h-1zM3 22h1v1h-1zM27 22h9v1h-9zM60 22h1v1h-1zM3 23h1v1h-1zM24 23h3v1h-3zM36 23h3v1h-3zM60 23h1v1h-1zM3 24h1v1h-1zM21 24h3v1h-3zM27 24h9v1h-9zM39 24h3v1h-3zM60 24h1v1h-1zM3 25h1v1h-1zM20 25h2v1h-2zM24 25h15v1h-15zM41 25h2v1h-2zM60 25h1v1h-1zM3 26h1v1h-1zM18 26h2v1h-2zM22 26h5v1h-5zM36 26h5v1h-5zM43 26h2v1h-2zM60 26h1v1h-1zM3 27h1v1h-1zM17 27h2v1h-2zM20 27h4v1h-4zM39 27h4v1h-4zM44 27h2v1h-2zM60 27h1v1h-1zM3 28h1v1h-1zM16 28h2v1h-2zM19 28h3v1h-3zM41 28h3v1h-3zM45 28h2v1h-2zM60 28h1v1h-1zM3 29h1v1h-1zM15 29h2v1h-2zM18 29h3v1h-3zM42 29h3v1h-3zM46 29h2v1h-2zM60 29h1v1h-1zM3 30h1v1h-1zM14 30h2v1h-2zM17 30h3v1h-3zM43 30h3v1h-3zM47 30h2v1h-2zM60 30h1v1h-1zM3 31h1v1h-1zM14 31h1v1h-1zM16 31h3v1h-3zM44 31h3v1h-3zM48 31h1v1h-1zM60 31h1v1h-1zM3 32h1v1h-1zM13 32h1v1h-1zM15 32h3v1h-3zM45 32h3v1h-3zM49 32h1v1h-1zM60 32h1v1h-1zM3 33h1v1h-1zM12 33h2v1h-2zM15 33h2v1h-2zM46 33h2v1h-2zM49 33h2v1h-2zM60 33h1v1h-1zM3 34h1v1h-1zM12 34h1v1h-1zM14 34h2v1h-2zM47 34h2v1h-2zM50 34h1v1h-1zM60 34h1v1h-1zM3 35h1v1h-1zM12 35h1v1h-1zM14 35h2v1h-2zM47 35h2v1h-2zM50 35h1v1h-1zM60 35h1v1h-1zM3 36h1v1h-1zM11 36h1v1h-1zM13 36h2v1h-2zM48 36h2v1h-2zM51 36h1v1h-1zM60 36h1v1h-1zM3 37h1v1h-1zM11 37h1v1h-1zM13 37h2v1h-2zM48 37h2v1h-2zM51 37h1v1h-1zM60 37h1v1h-1zM3 38h1v1h-1zM11 38h1v1h-1zM13 38h2v1h-2zM48 38h2v1h-2zM51 38h1v1h-1zM58 38h4v1h-4zM3 39h1v1h-1zM10 39h1v1h-1zM12 39h2v1h-2zM49 39h2v1h-2zM52 39h1v1h-1zM58 39h1v1h-1zM61 39h1v1h-1zM3 40h1v1h-1zM10 40h1v1h-1zM12 40h2v1h-2zM49 40h2v1h-2zM52 40h1v1h-1zM58 40h1v1h-1zM61 40h1v1h-1zM3 41h1v1h-1zM10 41h1v1h-1zM12 41h2v1h-2zM49 41h2v1h-2zM52 41h1v1h-1zM58 41h1v1h-1zM61 41h1v1h-1zM3 42h1v1h-1zM10 42h1v1h-1zM12 42h2v1h-2zM49 42h2v1h-2zM52 42h1v1h-1zM58 42h1v1h-1zM61 42h1v1h-1zM3 43h1v1h-1zM10 43h1v1h-1zM12 43h2v1h-2zM49 43h2v1h-2zM52 43h1v1h-1zM58 43h1v1h-1zM61 43h1v1h-1zM3 44h1v1h-1zM10 44h1v1h-1zM12 44h2v1h-2zM49 44h2v1h-2zM52 44h1v1h-1zM58 44h1v1h-1zM61 44h1v1h-1zM3 45h1v1h-1zM10 45h1v1h-1zM12 45h2v1h-2zM49 45h2v1h-2zM52 45h1v1h-1zM58 45h1v1h-1zM61 45h1v1h-1zM3 46h1v1h-1zM10 46h1v1h-1zM12 46h2v1h-2zM49 46h2v1h-2zM52 46h1v1h-1zM58 46h1v1h-1zM61 46h1v1h-1zM3 47h1v1h-1zM10 47h1v1h-1zM12 47h2v1h-2zM49 47h2v1h-2zM52 47h1v1h-1zM58 47h1v1h-1zM61 47h1v1h-1zM3 48h1v1h-1zM11 48h1v1h-1zM13 48h2v1h-2zM48 48h2v1h-2zM51 48h1v1h-1zM58 48h1v1h-1zM61 48h1v1h-1zM3 49h1v1h-1zM11 49h1v1h-1zM13 49h2v1h-2zM48 49h2v1h-2zM51 49h1v1h-1zM58 49h1v1h-1zM61 49h1v1h-1zM3 50h1v1h-1zM11 50h1v1h-1zM13 50h2v1h-2zM48 50h2v1h-2zM51 50h1v1h-1zM58 50h4v1h-4zM3 51h1v1h-1zM12 51h1v1h-1zM14 51h2v1h-2zM47 51h2v1h-2zM50 51h1v1h-1zM60 51h1v1h-1zM3 52h1v1h-1zM12 52h1v1h-1zM14 52h2v1h-2zM47 52h2v1h-2zM50 52h1v1h-1zM60 52h1v1h-1zM3 53h1v1h-1zM12 53h2v1h-2zM15 53h2v1h-2zM46 53h2v1h-2zM49 53h2v1h-2zM60 53h1v1h-1zM3 54h1v1h-1zM13 54h1v1h-1zM15 54h3v1h-3zM45 54h3v1h-3zM49 54h1v1h-1zM60 54h1v1h-1zM3 55h1v1h-1zM14 55h1v1h-1zM16 55h3v1h-3zM44 55h3v1h-3zM48 55h1v1h-1zM60 55h1v1h-1zM3 56h1v1h-1zM14 56h2v1h-2zM17 56h3v1h-3zM43 56h3v1h-3zM47 56h2v1h-2zM60 56h1v1h-1zM3 57h1v1h-1zM15 57h2v1h-2zM18 57h3v1h-3zM42 57h3v1h-3zM46 57h2v1h-2zM60 57h1v1h-1zM3 58h1v1h-1zM16 58h2v1h-2zM19 58h3v1h-3zM41 58h3v1h-3zM45 58h2v1h-2zM60 58h1v1h-1zM3 59h1v1h-1zM17 59h2v1h-2zM20 59h4v1h-4zM39 59h4v1h-4zM44 59h2v1h-2zM60 59h1v1h-1zM3 60h1v1h-1zM18 60h2v1h-2zM22 60h5v1h-5zM36 60h5v1h-5zM43 60h13v1h-13zM60 60h1v1h-1zM3 61h1v1h-1zM20 61h2v1h-2zM24 61h15v1h-15zM41 61h2v1h-2zM45 61h1v1h-1zM55 61h1v1h-1zM60 61h1v1h-1zM3 62h1v1h-1zM21 62h3v1h-3zM27 62h9v1h-9zM39 62h3v1h-3zM45 62h1v1h-1zM55 62h1v1h-1zM60 62h1v1h-1zM3 63h1v1h-1zM24 63h3v1h-3zM36 63h3v1h-3zM45 63h1v1h-1zM55 63h1v1h-1zM60 63h1v1h-1zM3 64h1v1h-1zM27 64h9v1h-9zM45 64h1v1h-1zM55 64h1v1h-1zM60 64h1v1h-1zM3 65h1v1h-1zM45 65h1v1h-1zM55 65h1v1h-1zM60 65h1v1h-1zM3 66h1v1h-1zM45 66h1v1h-1zM55 66h1v1h-1zM60 66h1v1h-1zM3 67h1v1h-1zM45 67h1v1h-1zM55 67h1v1h-1zM60 67h1v1h-1zM3 68h1v1h-1zM45 68h1v1h-1zM55 68h1v1h-1zM60 68h1v1h-1zM3 69h1v1h-1zM45 69h11v1h-11zM60 69h1v1h-1zM3 70h1v1h-1zM60 70h1v1h-1zM3 71h1v1h-1zM60 71h1v1h-1zM3 72h1v1h-1zM60 72h1v1h-1zM3 73h1v1h-1zM60 73h1v1h-1zM3 74h58v1h-58zM6 75h6v1h-6zM50 75h6v1h-6zM6 76h6v1h-6zM50 76h6v1h-6z\"/><path fill=\"#eaf1f8\" d=\"M4 2h50v1h-50zM4 3h50v1h-50zM9 7h17v1h-17zM9 8h17v1h-17zM39 8h4v1h-4zM9 9h2v1h-2zM24 9h2v1h-2zM39 9h4v1h-4zM9 10h2v1h-2zM24 10h2v1h-2zM39 10h4v1h-4zM9 11h17v1h-17zM39 11h4v1h-4zM9 12h17v1h-17zM59 39h2v1h-2zM59 40h2v1h-2zM59 41h2v1h-2zM59 42h2v1h-2zM59 43h2v1h-2zM59 44h2v1h-2zM59 45h2v1h-2zM59 46h2v1h-2zM59 47h2v1h-2zM59 48h2v1h-2zM59 49h2v1h-2zM46 61h9v1h-9zM46 62h9v1h-9zM46 63h9v1h-9zM46 64h9v1h-9zM46 65h9v1h-9zM46 66h9v1h-9zM46 67h9v1h-9zM46 68h9v1h-9z\"/><path fill=\"#dfe7f1\" d=\"M54 2h6v1h-6zM54 3h6v1h-6zM54 4h6v1h-6zM57 5h3v1h-3zM57 6h3v1h-3zM57 7h3v1h-3zM57 8h3v1h-3zM57 9h3v1h-3zM57 10h3v1h-3zM57 11h3v1h-3zM57 12h3v1h-3zM57 13h3v1h-3zM54 14h6v1h-6zM54 15h6v1h-6zM54 16h6v1h-6zM54 18h6v1h-6zM54 19h6v1h-6zM54 20h6v1h-6zM54 21h6v1h-6zM54 22h6v1h-6zM54 23h6v1h-6zM54 24h6v1h-6zM54 25h6v1h-6zM54 26h6v1h-6zM54 27h6v1h-6zM54 28h6v1h-6zM54 29h6v1h-6zM54 30h6v1h-6zM54 31h6v1h-6zM54 32h6v1h-6zM54 33h6v1h-6zM54 34h6v1h-6zM54 35h6v1h-6zM54 36h6v1h-6zM54 37h6v1h-6zM54 38h4v1h-4zM54 39h4v1h-4zM54 40h4v1h-4zM54 41h4v1h-4zM54 42h4v1h-4zM54 43h4v1h-4zM54 44h4v1h-4zM54 45h4v1h-4zM54 46h4v1h-4zM54 47h4v1h-4zM54 48h4v1h-4zM54 49h4v1h-4zM54 50h4v1h-4zM54 51h6v1h-6zM54 52h6v1h-6zM54 53h6v1h-6zM54 54h6v1h-6zM54 55h6v1h-6zM54 56h6v1h-6zM54 57h6v1h-6zM54 58h6v1h-6zM54 59h6v1h-6zM56 60h4v1h-4zM56 61h4v1h-4zM56 62h4v1h-4zM56 63h4v1h-4zM56 64h4v1h-4zM56 65h4v1h-4zM56 66h4v1h-4zM56 67h4v1h-4zM56 68h4v1h-4zM56 69h4v1h-4zM54 70h6v1h-6zM54 71h6v1h-6zM54 72h6v1h-6zM54 73h6v1h-6z\"/><path fill=\"#ffffff\" d=\"M4 4h35v1h-35zM43 4h11v1h-11zM4 5h33v1h-33zM45 5h1v1h-1zM4 6h4v1h-4zM27 6h9v1h-9zM4 7h4v1h-4zM27 7h9v1h-9zM4 8h4v1h-4zM27 8h8v1h-8zM4 9h4v1h-4zM27 9h8v1h-8zM4 10h4v1h-4zM27 10h8v1h-8zM4 11h4v1h-4zM27 11h8v1h-8zM4 12h4v1h-4zM27 12h9v1h-9zM4 13h4v1h-4zM27 13h9v1h-9zM4 14h33v1h-33zM45 14h9v1h-9zM4 15h35v1h-35zM43 15h11v1h-11zM4 16h50v1h-50zM4 18h50v1h-50zM4 19h50v1h-50zM4 20h50v1h-50zM4 21h50v1h-50zM4 22h23v1h-23zM36 22h18v1h-18zM4 23h20v1h-20zM39 23h15v1h-15zM4 24h17v1h-17zM42 24h12v1h-12zM4 25h16v1h-16zM43 25h11v1h-11zM4 26h14v1h-14zM45 26h9v1h-9zM4 27h13v1h-13zM46 27h8v1h-8zM4 28h12v1h-12zM47 28h7v1h-7zM4 29h11v1h-11zM48 29h6v1h-6zM4 30h10v1h-10zM49 30h5v1h-5zM4 31h10v1h-10zM49 31h5v1h-5zM4 32h9v1h-9zM50 32h4v1h-4zM4 33h8v1h-8zM51 33h3v1h-3zM4 34h8v1h-8zM51 34h3v1h-3zM4 35h8v1h-8zM51 35h3v1h-3zM4 36h7v1h-7zM52 36h2v1h-2zM4 37h7v1h-7zM52 37h2v1h-2zM4 38h7v1h-7zM52 38h2v1h-2zM4 39h6v1h-6zM53 39h1v1h-1zM4 40h6v1h-6zM53 40h1v1h-1zM4 41h6v1h-6zM53 41h1v1h-1zM4 42h6v1h-6zM53 42h1v1h-1zM4 43h6v1h-6zM53 43h1v1h-1zM4 44h6v1h-6zM53 44h1v1h-1zM4 45h6v1h-6zM53 45h1v1h-1zM4 46h6v1h-6zM53 46h1v1h-1zM4 47h6v1h-6zM53 47h1v1h-1zM4 48h7v1h-7zM52 48h2v1h-2zM4 49h7v1h-7zM52 49h2v1h-2zM4 50h7v1h-7zM52 50h2v1h-2zM4 51h8v1h-8zM51 51h3v1h-3zM4 52h8v1h-8zM51 52h3v1h-3zM4 53h8v1h-8zM51 53h3v1h-3zM4 54h9v1h-9zM50 54h4v1h-4zM4 55h10v1h-10zM49 55h5v1h-5zM4 56h10v1h-10zM49 56h5v1h-5zM4 57h11v1h-11zM48 57h6v1h-6zM4 58h12v1h-12zM47 58h7v1h-7zM4 59h13v1h-13zM46 59h8v1h-8zM4 60h14v1h-14zM4 61h16v1h-16zM43 61h2v1h-2zM4 62h17v1h-17zM42 62h3v1h-3zM4 63h20v1h-20zM39 63h6v1h-6zM4 64h23v1h-23zM36 64h9v1h-9zM4 65h41v1h-41zM4 66h41v1h-41zM4 67h41v1h-41zM4 68h41v1h-41zM4 69h41v1h-41zM4 70h50v1h-50zM4 71h50v1h-50zM4 72h50v1h-50zM4 73h50v1h-50z\"/><path fill=\"#111b2c\" d=\"M47 6h9v1h-9zM47 7h9v1h-9zM47 8h9v1h-9zM47 9h9v1h-9zM47 10h9v1h-9zM47 11h9v1h-9zM47 12h9v1h-9zM27 27h9v1h-9zM27 28h11v1h-11zM27 29h13v1h-13zM27 30h15v1h-15zM27 31h16v1h-16zM19 32h1v1h-1zM27 32h17v1h-17zM18 33h3v1h-3zM26 33h19v1h-19zM18 34h27v1h-27zM17 35h29v1h-29zM17 36h29v1h-29zM16 37h31v1h-31zM16 38h31v1h-31zM15 39h33v1h-33zM15 40h33v1h-33zM15 41h33v1h-33zM15 42h33v1h-33zM15 43h33v1h-33zM15 44h33v1h-33zM15 45h33v1h-33zM15 46h33v1h-33zM15 47h33v1h-33zM16 48h31v1h-31zM16 49h31v1h-31zM17 50h29v1h-29zM17 51h29v1h-29zM18 52h27v1h-27zM18 53h27v1h-27zM19 54h25v1h-25zM24 55h15v1h-15zM26 56h11v1h-11zM31 57h1v1h-1z\"/><path fill=\"#cbd7e5\" d=\"M11 9h13v1h-13zM11 10h13v1h-13z\"/><path fill=\"#334a75\" d=\"M27 23h9v1h-9zM24 24h3v1h-3zM36 24h3v1h-3zM22 25h2v1h-2zM39 25h2v1h-2zM20 26h2v1h-2zM27 26h9v1h-9zM41 26h2v1h-2zM19 27h1v1h-1zM24 27h3v1h-3zM36 27h3v1h-3zM43 27h1v1h-1zM18 28h1v1h-1zM22 28h3v1h-3zM38 28h3v1h-3zM44 28h1v1h-1zM17 29h1v1h-1zM21 29h2v1h-2zM40 29h2v1h-2zM45 29h1v1h-1zM16 30h1v1h-1zM20 30h1v1h-1zM42 30h1v1h-1zM46 30h1v1h-1zM15 31h1v1h-1zM19 31h1v1h-1zM43 31h1v1h-1zM47 31h1v1h-1zM14 32h1v1h-1zM18 32h1v1h-1zM44 32h1v1h-1zM48 32h1v1h-1zM14 33h1v1h-1zM17 33h1v1h-1zM45 33h1v1h-1zM48 33h1v1h-1zM13 34h1v1h-1zM16 34h2v1h-2zM45 34h2v1h-2zM49 34h1v1h-1zM13 35h1v1h-1zM16 35h1v1h-1zM46 35h1v1h-1zM49 35h1v1h-1zM12 36h1v1h-1zM15 36h2v1h-2zM46 36h2v1h-2zM50 36h1v1h-1zM12 37h1v1h-1zM15 37h1v1h-1zM47 37h1v1h-1zM50 37h1v1h-1zM12 38h1v1h-1zM15 38h1v1h-1zM47 38h1v1h-1zM50 38h1v1h-1zM11 39h1v1h-1zM14 39h1v1h-1zM48 39h1v1h-1zM51 39h1v1h-1zM11 40h1v1h-1zM14 40h1v1h-1zM48 40h1v1h-1zM51 40h1v1h-1zM11 41h1v1h-1zM14 41h1v1h-1zM48 41h1v1h-1zM51 41h1v1h-1zM11 42h1v1h-1zM14 42h1v1h-1zM48 42h1v1h-1zM51 42h1v1h-1zM11 43h1v1h-1zM14 43h1v1h-1zM48 43h1v1h-1zM51 43h1v1h-1zM11 44h1v1h-1zM14 44h1v1h-1zM48 44h1v1h-1zM51 44h1v1h-1zM11 45h1v1h-1zM14 45h1v1h-1zM48 45h1v1h-1zM51 45h1v1h-1zM11 46h1v1h-1zM14 46h1v1h-1zM48 46h1v1h-1zM51 46h1v1h-1zM11 47h1v1h-1zM14 47h1v1h-1zM48 47h1v1h-1zM51 47h1v1h-1zM12 48h1v1h-1zM15 48h1v1h-1zM47 48h1v1h-1zM50 48h1v1h-1zM12 49h1v1h-1zM15 49h1v1h-1zM47 49h1v1h-1zM50 49h1v1h-1zM12 50h1v1h-1zM15 50h2v1h-2zM46 50h2v1h-2zM50 50h1v1h-1zM13 51h1v1h-1zM16 51h1v1h-1zM46 51h1v1h-1zM49 51h1v1h-1zM13 52h1v1h-1zM16 52h2v1h-2zM45 52h2v1h-2zM49 52h1v1h-1zM14 53h1v1h-1zM17 53h1v1h-1zM45 53h1v1h-1zM48 53h1v1h-1zM14 54h1v1h-1zM18 54h1v1h-1zM44 54h1v1h-1zM48 54h1v1h-1zM15 55h1v1h-1zM19 55h1v1h-1zM43 55h1v1h-1zM47 55h1v1h-1zM16 56h1v1h-1zM20 56h1v1h-1zM42 56h1v1h-1zM46 56h1v1h-1zM17 57h1v1h-1zM21 57h2v1h-2zM40 57h2v1h-2zM45 57h1v1h-1zM18 58h1v1h-1zM22 58h3v1h-3zM38 58h3v1h-3zM44 58h1v1h-1zM19 59h1v1h-1zM24 59h3v1h-3zM36 59h3v1h-3zM43 59h1v1h-1zM20 60h2v1h-2zM27 60h9v1h-9zM41 60h2v1h-2zM22 61h2v1h-2zM39 61h2v1h-2zM24 62h3v1h-3zM36 62h3v1h-3zM27 63h9v1h-9z\"/><path fill=\"#3f5c85\" d=\"M25 28h2v1h-2zM23 29h4v1h-4zM21 30h6v1h-6zM20 31h7v1h-7zM20 32h7v1h-7zM21 33h5v1h-5zM20 55h4v1h-4zM39 55h4v1h-4zM21 56h5v1h-5zM37 56h5v1h-5zM23 57h8v1h-8zM32 57h8v1h-8zM25 58h13v1h-13zM27 59h9v1h-9z\"/><g clip-path=\"url(#pxGlass)\"><g class=\"px-water\"><path fill=\"#8fd4f5\" d=\"M15 27h33v1h-33z\"/><path fill=\"#3f9fd6\" d=\"M15 28h33v1h-33zM15 29h33v1h-33zM15 30h33v1h-33zM15 31h33v1h-33zM15 32h33v1h-33zM15 33h33v1h-33zM15 34h33v1h-33zM15 35h33v1h-33zM15 36h33v1h-33zM15 37h33v1h-33zM15 38h33v1h-33zM15 39h33v1h-33zM15 40h33v1h-33zM15 41h33v1h-33zM15 42h33v1h-33zM15 43h33v1h-33zM15 44h33v1h-33zM15 45h33v1h-33zM15 46h33v1h-33zM15 47h33v1h-33zM15 48h33v1h-33zM15 49h33v1h-33zM15 50h33v1h-33zM15 51h33v1h-33zM15 52h33v1h-33zM15 53h33v1h-33zM15 54h33v1h-33zM15 55h33v1h-33zM15 56h33v1h-33zM15 57h33v1h-33zM15 58h33v1h-33zM15 59h33v1h-33z\"/></g><g class=\"px-wheel\"><path fill=\"#3f5c85\" d=\"M31 30h2v1h-2zM31 31h2v1h-2zM31 32h2v1h-2zM31 33h2v1h-2zM31 34h2v1h-2zM31 35h2v1h-2zM31 36h2v1h-2zM31 37h2v1h-2zM31 38h2v1h-2zM31 39h2v1h-2zM31 40h2v1h-2zM27 44h2v1h-2zM25 45h2v1h-2zM28 45h1v1h-1zM33 45h2v1h-2zM24 46h1v1h-1zM26 46h2v1h-2zM34 46h3v1h-3zM22 47h4v1h-4zM36 47h3v1h-3zM20 48h4v1h-4zM37 48h4v1h-4zM19 49h1v1h-1zM21 49h1v1h-1zM39 49h3v1h-3zM20 50h1v1h-1zM41 50h2v1h-2z\"/><path fill=\"#1a2740\" d=\"M31 41h1v1h-1zM30 42h3v1h-3zM29 43h5v1h-5zM30 44h3v1h-3zM31 45h1v1h-1z\"/></g><g class=\"px-foam\"><path fill=\"#ffffff\" d=\"M22 49h1v1h-1zM25 49h1v1h-1zM29 49h1v1h-1zM33 49h1v1h-1zM37 49h1v1h-1zM21 50h6v1h-6zM28 50h3v1h-3zM32 50h3v1h-3zM36 50h3v1h-3zM41 50h1v1h-1zM22 51h6v1h-6zM29 51h1v1h-1zM31 51h5v1h-5zM37 51h1v1h-1zM40 51h3v1h-3zM24 52h4v1h-4zM32 52h4v1h-4zM41 52h1v1h-1zM25 53h4v1h-4zM33 53h4v1h-4zM27 54h1v1h-1zM35 54h1v1h-1z\"/></g></g><path fill=\"#2ee06a\" class=\"px-led\" d=\"M39 5h4v1h-4zM37 6h8v1h-8zM37 7h8v1h-8zM36 8h10v1h-10zM36 9h10v1h-10zM36 10h10v1h-10zM36 11h10v1h-10zM37 12h8v1h-8zM37 13h8v1h-8zM39 14h4v1h-4z\"/><path fill=\"#2ee06a\" class=\"px-screen\" d=\"M49 8h5v1h-5zM49 11h3v1h-3z\"/></svg>";
    const CSS = "/* dsh-washer · style.css */\n/* dsh-washer · 容器与文字（融入宿主主题）\n *\n * 硬约束（需求文档 §8.5）：\n * - 容器、文字、边框一律走宿主 --dsw-alias-* token，不硬编码颜色。\n * - 只有洗衣机本体的材质（机身/铬圈/玻璃/水）用自己的 --dw-* 变量。\n * - 暗色靠宿主 [data-ds-dark-theme] 切换，不做 prefers-color-scheme 猜测。\n */\n\n.dsh-washer {\n  /* 根节点不撑满父容器：宽度交给内容（stop 322px / 卡片 330px）。\n     width:100% 会让 hover 区、焦点环、点击热区都比可见内容大一截。 */\n  width: max-content;\n  max-width: 100%;\n  /*\n   * 贴左：dock 座位挂在宿主的 composer.dock 行里，那一行默认可能居中或拉伸。\n   * 这里把自己的外边距吃掉并把自身靠左对齐，保证停靠条永远贴着这一行的最左侧。\n   * 只对 dock 座位生效——header 座位在右上角、overlay 座位是浮层，各有各的位置。\n   */\n  --dw-card: var(--dsw-alias-bg-layer-1, #ffffff);\n  --dw-line: var(--dsw-alias-border-l1, #d8dfe7);\n  --dw-t1: var(--dsw-alias-label-primary, #1b2430);\n  --dw-t2: var(--dsw-alias-label-secondary, #8f9ba8);\n  --dw-hover: var(--dsw-alias-interactive-bg-hover, rgba(40, 60, 84, 0.05));\n  --dw-shadow: var(--dsw-shadow-lv2, 0 1px 2px rgba(40, 60, 84, 0.06));\n  --dw-run: var(--dsw-alias-state-business-primary, #2f86d6);\n  --dw-wait: var(--dsw-alias-state-warn-primary, #d99a1f);\n  --dw-err: var(--dsw-alias-state-error-primary, #d94a4f);\n  --dw-ok: var(--dsw-alias-state-success-primary, #2f9e63);\n  --dw-off: var(--dsw-alias-label-tertiary, #9aa6b2);\n\n  /* 洗衣机材质（精密家电皮肤，亮色） */\n  --dw-body-1: #ffffff;\n  --dw-body-2: #f2f5f8;\n  --dw-body-3: #dfe5ec;\n  --dw-body-4: #c3ccd6;\n  --dw-body-edge: rgba(255, 255, 255, 0.95);\n  --dw-body-shade: rgba(96, 118, 142, 0.22);\n  --dw-chrome-1: #ffffff;\n  --dw-chrome-2: #c9d3dd;\n  --dw-chrome-3: #8e9baa;\n  --dw-chrome-4: #e8eef4;\n  --dw-glass-1: rgba(214, 238, 250, 0.92);\n  --dw-glass-2: rgba(120, 168, 196, 0.72);\n  --dw-glass-3: rgba(38, 74, 102, 0.86);\n  --dw-glass-4: rgba(12, 30, 46, 0.95);\n  --dw-water-1: #9ad9f0;\n  --dw-water-2: #4aa3cf;\n  --dw-water-3: #2a7fa8;\n  --dw-scr-1: #16232e;\n  --dw-scr-2: #0a121a;\n  --dw-scr-txt: #8ef0c6;\n  --dw-scr-txt-dim: rgba(142, 240, 198, 0.55);\n  --dw-sig-run: #2f86d6;\n  --dw-sig-wait: #d99a1f;\n  --dw-sig-err: #d94a4f;\n  --dw-sig-ok: #2f9e63;\n  --dw-sig-off: #9aa6b2;\n\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 8px;\n  font: inherit;\n  color: var(--dw-t1);\n}\n\n[data-ds-dark-theme] .dsh-washer {\n  --dw-body-1: #4c5762;\n  --dw-body-2: #39434e;\n  --dw-body-3: #28313a;\n  --dw-body-4: #1b2229;\n  --dw-body-edge: rgba(255, 255, 255, 0.16);\n  --dw-body-shade: rgba(0, 0, 0, 0.55);\n  --dw-chrome-1: #b9c4cf;\n  --dw-chrome-2: #6b7885;\n  --dw-chrome-3: #3a444f;\n  --dw-chrome-4: #8b98a5;\n  --dw-glass-1: rgba(120, 180, 215, 0.55);\n  --dw-glass-2: rgba(46, 96, 130, 0.6);\n  --dw-glass-3: rgba(14, 38, 58, 0.9);\n  --dw-glass-4: rgba(4, 12, 20, 0.97);\n  --dw-water-1: #6fc3e6;\n  --dw-water-2: #2b7ea8;\n  --dw-water-3: #17546f;\n  --dw-scr-1: #0d1720;\n  --dw-scr-2: #060c12;\n  --dw-scr-txt: #8ef0c6;\n  --dw-scr-txt-dim: rgba(142, 240, 198, 0.5);\n  --dw-sig-run: #4aa3f0;\n  --dw-sig-wait: #f0b73a;\n  --dw-sig-err: #f26064;\n  --dw-sig-ok: #3fbf7a;\n  --dw-sig-off: #4c5762;\n}\n\n/* 状态色绑定：皮肤内部引用 --dw-sig，避免每个皮肤重复写颜色 */\n.dsh-washer[data-state='idle'] { --dw-sig: var(--dw-sig-ok); }\n.dsh-washer[data-state='starting'],\n.dsh-washer[data-state='washing'],\n.dsh-washer[data-state='rinsing'],\n.dsh-washer[data-state='spinning'] { --dw-sig: var(--dw-sig-run); }\n.dsh-washer[data-state='waiting'] { --dw-sig: var(--dw-sig-wait); }\n.dsh-washer[data-state='draining'] { --dw-sig: #1f9aa8; }\n.dsh-washer[data-state='done'] { --dw-sig: var(--dw-sig-ok); }\n.dsh-washer[data-state='error'] { --dw-sig: var(--dw-sig-err); }\n.dsh-washer[data-state='off'] { --dw-sig: var(--dw-sig-off); }\n\n/* ---------- S 档：停靠条 322×52 ---------- */\n\n.dw-root {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 8px;\n  width: 100%;\n}\n\n/*\n * 停靠条三档（紧凑 / 迷你 / 极简），按窗口宽度自动切换。\n *\n * 用 @media 而不是容器查询：dock 的父容器是 fit-content（宽度由内容决定），\n * 容器查询会陷入\"宽度→换档→内容变→宽度变\"的自激循环，实测直接锁死在极简档。\n * @media 查的是窗口宽度，不依赖任何祖先尺寸，没有这个风险。\n *\n * 阈值按窗口宽度定（输入框宽度 ≈ 窗口 - 260px 侧栏 - padding）：\n *   >= 720px  紧凑：机器 + 状态 + 计时（两行，默认档，信息最全）\n *   >= 520px  迷你：机器 + 单行「状态 计时」\n *   <  520px  极简：只有机器，信息进 tooltip\n *\n * 顺带修掉一个老坑：dock 根节点原来靠 width:100% 撑满父容器，\n * 在 fit-content 父级下同样会塌缩，现在宽度只由内容决定（.dw-strip 的 max-width）。\n */\n.dw-strip {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  box-sizing: border-box;\n  /* 宽度跟着容器走：撑满可用宽度，但不超过 322px 的舒适上限 */\n  width: 100%;\n  max-width: 322px;\n  height: 52px;\n  padding: 6px 13px 6px 8px;\n  /* 无背景、无边框：停靠条要和宿主原生输入框区域融为一体，\n     不再是一张\"浮在上面的卡片\"。只留内容本身（机器 + 文字）。 */\n  border: 0;\n  border-radius: 12px;\n  background: transparent;\n  box-shadow: none;\n  color: inherit;\n  font: inherit;\n  text-align: left;\n}\n/*\n * dock 座位不再当容器查询的锚点。\n *\n * 走过一次弯路：用容器查询按容器宽度分档，容器设 width:100%。\n * 但宿主给 composer.dock 的父容器是 fit-content —— 100% 的父级宽度\n * 又由子内容决定，形成循环，浏览器把百分比容器塌缩，于是容器极窄、\n * 触发极简档、文字隐藏、内容更少、容器更窄……自激锁死在极简档\n * （实测：界面上只剩一台洗衣机图标，什么信息都不显示）。\n *\n * 改成 @media 查窗口宽度：不依赖任何祖先尺寸，不会循环。\n */\n\n\n\n.dw-sprite {\n  flex: none;\n  width: 32px;\n  height: 40px;\n  display: block;\n}\n.dw-sprite svg {\n  display: block;\n  width: 32px;\n  height: 40px;\n  image-rendering: pixelated;\n}\n.dw-sprite .px-water {\n  transition: transform 0.5s cubic-bezier(0.32, 0.86, 0.3, 1);\n}\n.dw-sprite .px-foam { transition: opacity 0.45s ease; }\n.dw-sprite[data-blink='1'] .px-led { animation: dw-blink 0.6s steps(2, end) infinite; }\n.dw-sprite[data-blink='2'] .px-led { animation: dw-blink 0.35s steps(2, end) infinite; }\n\n.dw-text {\n  flex: 1 1 auto;\n  min-width: 0;\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n}\n.dw-t1 {\n  font-size: 12px;\n  font-weight: 600;\n  line-height: 1.35;\n  color: var(--dw-t1);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.dw-t1[data-tone='warn'] { color: var(--dw-sig-wait); }\n.dw-t1[data-tone='error'] { color: var(--dw-sig-err); }\n.dw-t1[data-tone='ok'] { color: var(--dw-sig-ok); }\n.dw-t2 {\n  font-size: 10px;\n  line-height: 1.35;\n  color: var(--dw-t2);\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  font-variant-numeric: tabular-nums;\n}\n\n/*\n * 档位 2 · 迷你（窗口 < 720px）\n * 两行文字压成一行。阈值按窗口宽度定：输入框宽度 ≈ 窗口 - 侧栏 - padding，\n * 720px 窗口下输入框约 400~480px，正好放不下两行。\n */\n@media (max-width: 719px) {\n  /*\n   * 两行压成一行：状态在左、计时在右，都是同一行里最该留的两样。\n   * 不隐藏副标题——计时正是\"洗到哪了\"的核心信息，砍掉它等于本末倒置。\n   * 副标题里\"· 第 N 件\"这类次要信息靠 text-overflow 自然截断。\n   */\n  .dw-strip { height: 44px; padding: 5px 10px 5px 7px; gap: 8px; }\n  .dw-text { flex-direction: row; align-items: baseline; gap: 6px; overflow: hidden; }\n  .dw-t1 { font-size: 11px; flex: none; }\n  .dw-t2 { font-size: 10px; flex: 0 1 auto; min-width: 0; }\n}\n\n/*\n * 档位 3 · 极简（窗口 < 520px）\n * 只剩机器。文字全部让位，但状态没有丢——机器造型、水位、指示灯都还在表达，\n * 完整信息在 aria-label / title 上，鼠标悬停或读屏仍能拿到。\n */\n@media (max-width: 519px) {\n  .dw-strip { height: 40px; padding: 0; gap: 0; justify-content: center; max-width: 52px; }\n  .dw-text { display: none; }\n}\n\n@keyframes dw-blink {\n  0%, 60% { opacity: 1; }\n  61%, 100% { opacity: 0.3; }\n}\n@keyframes dw-pulse {\n  0%, 100% { opacity: 1; transform: scale(1); }\n  50% { opacity: 0.45; transform: scale(0.82); }\n}\n\n/* 降级：尊重系统「减少动态效果」\n *\n * 这里**不能**用 `.dsh-washer *` 一把梭哈：\n * checklist A4 明确要求「滚筒不转，但状态文字仍在变、指示灯和水位变化仍在」——\n * 指示灯闪烁、水位/进度条过渡是**状态信息**，不是装饰；通配停掉它们等于\n * 把「洗衣机在转」和「Agent 在干活」两个信号一起抹了，用户反而看不出状态。\n *\n * 所以只停「装饰性运动」：滚筒旋转、衣物翻滚、气泡上浮、整机抖动。\n * 指示灯（led/px-led）与水位**故意不列**，让它们继续动。\n *\n * 说明：原先还有插件配置 reduceMotion 的三态（始终/从不/跟随系统），\n * 已按用户要求整体删除窗口——「从不」会让无视系统无障碍设置的人难受，\n * 「始终」又把状态动效也冻住。现在只跟随系统，旗子保留供 data 属性使用。\n */\n@media (prefers-reduced-motion: reduce) {\n  .dsh-washer .dw-pw .drum,\n  .dsh-washer .dw-pw .clothes,\n  .dsh-washer .dw-pw .door::before,\n  .dsh-washer .dw-pw .bubbles b,\n  .dsh-washer .dw-pw[data-state='spinning'],\n  .dsh-washer .dw-aw-drum,\n  .dsh-washer .dw-aw-ring::after,\n  .dsh-washer .dw-aw-clothes i {\n    animation: none !important;\n  }\n}\n.dsh-washer[data-reduce-motion='1'] .dw-pw .drum,\n.dsh-washer[data-reduce-motion='1'] .dw-pw .clothes,\n.dsh-washer[data-reduce-motion='1'] .dw-pw .door::before,\n.dsh-washer[data-reduce-motion='1'] .dw-pw .bubbles b,\n.dsh-washer[data-reduce-motion='1'] .dw-pw[data-state='spinning'],\n.dsh-washer[data-reduce-motion='1'] .dw-aw-drum,\n.dsh-washer[data-reduce-motion='1'] .dw-aw-ring::after,\n.dsh-washer[data-reduce-motion='1'] .dw-aw-clothes i {\n  animation: none !important;\n}\n\n/* ---------- 32px 像素 sprite 的三个可动图层 ---------- */\n\n.dw-px {\n  /* 只给 svg 撑满容器，自身尺寸由 .dw-sprite 决定：\n     这里若写 width:100% 会盖掉 .dw-sprite 的 32×40（同优先级且更靠后）。 */\n  display: block;\n  line-height: 0;\n}\n.dw-px svg {\n  display: block;\n  width: 100%;\n  height: 100%;\n  image-rendering: pixelated;\n}\n.dw-px .px-water {\n  transform: translateY(calc(var(--dw-water, 7) * 1px));\n  transition: transform 0.5s cubic-bezier(0.32, 0.86, 0.3, 1);\n}\n.dw-px .px-foam {\n  opacity: var(--dw-foam, 0);\n  transition: opacity 0.45s ease;\n}\n.dw-px .px-led {\n  fill: var(--dw-led, #7c8896);\n}\n.dw-px[data-blink='1'] .px-led { animation: dw-blink 0.6s steps(2, end) infinite; }\n.dw-px[data-blink='2'] .px-led { animation: dw-blink 0.35s steps(2, end) infinite; }\n\n/* ---------- 精密家电 / 动漫风：按宽度缩放，不重排 ---------- */\n\n.dw-frame {\n  position: relative;\n  flex: none;\n  overflow: hidden;\n}\n.dw-frame-inner {\n  position: absolute;\n  left: 0;\n  top: 0;\n  width: 330px;\n  transform-origin: top left;\n  pointer-events: none;\n  user-select: none;\n}\n\n/* ------------------------------------------------------------------ *\n * header 座位（waiting 替补）\n * 审批/提问时宿主接管整个 composer，composer.dock 会随之 display:none，\n * 洗衣机在「最该看见」的一刻消失。header 座位在同一时刻顶上来。\n * 该座位位于会话标题栏右侧，高度受限：只出 52px 的停靠条，不展开卡片。\n * ------------------------------------------------------------------ */\n.dsh-washer[data-variant='dock'] {\n  /*\n   * 位置靠 order:-10 排在「性能与用量」「上下文使用量」两个药丸之前（见\n   * client.template.js 的 slot 注册）。这里只管尺寸：不参与伸缩，避免被\n   * 父行的 justify-content:center 拉伸或压缩。\n   *\n   * 曾经想用自动右外边距把它顶到行首——那是错的：这行是\n   * justify-content:center，自动边距会把它和其余药丸硬拆到两端，\n   * 打乱宿主原有布局。既然靠 order 排到最前，就不需要任何自动边距。\n   */\n  flex: 0 0 auto;\n  align-self: center;\n}\n\n.dsh-washer[data-variant='header'] {\n  align-items: center;\n  flex: 0 0 auto;\n  /* 基础规则里 .dsh-washer 是 width:100%（为 dock 座位撑满输入框宽度设计的），\n     在 header 座位上会把容器拉成父级全宽、整体右溢出 39px。这里必须显式 auto。 */\n  width: auto;\n  max-width: 100%;\n  margin-right: 4px;\n}\n.dsh-washer[data-variant='header'] .dw-strip {\n  width: auto;\n  min-width: 0;\n  max-width: 100%;\n  padding-right: 10px;\n}\n.dsh-washer[data-variant='header'] .dw-text {\n  min-width: 0;\n}\n.dsh-washer[data-variant='header'] .dw-t2 {\n  display: none;\n}\n\n/* ------------------------------------------------------------------ *\n * overlay 座位（mode:'overlay'）\n * shell.overlay 层本身是 click-through，占据者必须自己 opt-in 指针事件，\n * 否则浮层会吃掉底下所有点击。\n * ------------------------------------------------------------------ */\n.dw-overlay-root {\n  position: fixed;\n  right: 24px;\n  bottom: 24px;\n  z-index: 60;\n  width: auto;\n  pointer-events: auto;\n}\n.dw-overlay-root .dw-strip {\n  width: auto;\n  min-width: 0;\n  max-width: 280px;\n  box-shadow: 0 8px 28px rgba(12, 22, 34, 0.18), 0 2px 6px rgba(12, 22, 34, 0.12);\n}\n[data-ds-dark-theme] .dw-overlay-root .dw-strip {\n  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.4);\n}\n.dw-overlay-root .dw-t2 {\n  display: none;\n}\n\n\n\n/* ---------- 设置页 ----------\n *\n * 这一整段以前根本不存在：设置页只内联了开关和胶囊按钮的样式，\n * 容器/行/标签全是裸 div，浏览器按默认块级元素往下堆——用户看到的就是\n * \"全都挤在一起\"。下面照宿主官方设置页（ui-settings-general 的\n * DeveloperToolsRow）的规格重写：\n *\n *   .row        { display:flex; justify-content:space-between;\n *                 align-items:center; gap:24px; padding:16px 0;\n *                 border-bottom:.5px solid border-l2 }\n *   .title      { font-size:14px; line-height:20px }\n *   .description{ color:label-secondary; margin-top:4px;\n *                 font-size:12px; line-height:18px }\n *\n * 关键点：行是左右布局（标签在左、控件在右），说明文字挂在标签下面，\n * 而不是自己独占一行。以前全是一条一条竖着排，所以看着\"挤\"。\n */\n\n.dw-settings {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  padding: 2px 0 8px;\n  color: var(--dsw-alias-label-primary);\n}\n\n/* 面板标题 */\n.dw-set-title {\n  margin: 0;\n  font-size: 15px;\n  font-weight: 600;\n  line-height: 22px;\n  color: var(--dsw-alias-label-primary);\n}\n\n.dw-set-intro {\n  margin: 2px 0 8px;\n  font-size: 13px;\n  line-height: 19px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n/* 分组小标题（\"桌面悬浮窗\"）：上留白 + 与上面一条分隔线拉开层次 */\n.dw-set-sub {\n  margin: 18px 0 2px;\n  font-size: 13px;\n  font-weight: 600;\n  line-height: 20px;\n  color: var(--dsw-alias-label-primary);\n}\n\n/* 一行：左边标题（可带说明），右边控件 */\n.dw-set-row {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  gap: 24px;\n  padding: 14px 0;\n  border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, .08));\n}\n\n.dw-set-label {\n  flex: 1 1 auto;\n  min-width: 0;\n  font-size: 14px;\n  line-height: 20px;\n  color: var(--dsw-alias-label-primary);\n}\n\n/* 控件那一栏不许被标签挤扁：胶囊多的时候可以换行，但不能压缩自身 */\n.dw-set-row > .dw-seg {\n  flex: none;\n  justify-content: flex-end;\n}\n\n.dw-set-row > [role='switch'] {\n  flex: none;\n}\n\n/* 说明文字：作为行下方的小字，左边对齐、不和控件抢位置 */\n.dw-set-hint {\n  margin: 0 0 4px;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n/*\n * 说明文字紧跟在某一行后面时，视觉上属于那一行，整块是一节：\n *   - 行不再自己画下边框（否则线会压在说明文字上方/中间）。-10px 负 margin 会把\n *     说明往上拽，正好撞上行的 border-bottom，看起来像一条线横穿文字。\n *   - 分隔线交给**说明自己**承担，画在说明的下面，作为这一节的底边。\n *   - 用 0 上边距让它自然贴着上一行，不再用负 margin 制造穿线。\n */\n.dw-set-row + .dw-set-hint {\n  margin-top: 0;\n  margin-bottom: 0;\n  padding-bottom: 12px;\n  border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, .08));\n}\n\n/* 行后面紧跟说明时，行自己的下边框让位（否则行线 + 说明线两条叠着） */\n.dw-set-row:has(+ .dw-set-hint) {\n  border-bottom: 0;\n}\n\n/* 最后一条说明（重启提示）是整页收尾，不需要再画线 */\n.dw-set-hint:last-child {\n  border-bottom: 0;\n  padding-bottom: 0;\n  margin-bottom: 0;\n}\n\n/* dsh-washer · skin-precision.css */\n.dw-pw{position:relative;width:300px;padding:15px 15px 0;\n  border-radius:24px;\n  background:\n    linear-gradient(168deg,var(--dw-body-1) 0%,var(--dw-body-2) 38%,var(--dw-body-3) 78%,var(--dw-body-4) 100%);\n  box-shadow:\n    \n    0 2px 4px -1px var(--dw-body-shade),\n    0 18px 30px -14px var(--dw-body-shade),\n    0 46px 70px -40px var(--dw-body-shade),\n    \n    inset 0 1.5px 0 var(--dw-body-edge),\n    \n    inset 1.5px 0 0 rgba(255,255,255,.5),\n    inset -1.5px 0 0 rgba(90,112,136,.14),\n    \n    inset 0 -2px 0 rgba(70,92,116,.16);\n  transition:transform .45s cubic-bezier(.3,.8,.3,1);\n  z-index:2;}\n.dw-pw::before{content:\"\";position:absolute;inset:0;border-radius:inherit;pointer-events:none;\n  background:linear-gradient(180deg,rgba(255,255,255,.55),rgba(255,255,255,0) 12%);\n  mix-blend-mode:screen;opacity:.7;}\n.dw-pw[data-state=\"spinning\"]{animation:walk .24s linear infinite}\n.dw-pw .topbar{display:flex;align-items:center;justify-content:space-between;height:22px;padding:0 5px 6px;position:relative}\n.dw-pw .drawer{width:54px;height:7px;border-radius:3px;\n  background:linear-gradient(180deg,#ffffff,#c9d3dd 55%,#9aa7b4);\n  box-shadow:0 1px 2px rgba(70,92,116,.35),inset 0 .5px 0 #fff;\n  position:relative;}\n.dw-pw .drawer::after{content:\"\";position:absolute;right:7px;top:2px;width:13px;height:2.5px;border-radius:2px;background:rgba(50,70,92,.3)}\n.dw-pw .knob{width:26px;height:26px;border-radius:50%;\n  background:conic-gradient(from 205deg,\n    var(--dw-chrome-1) 0deg,var(--dw-chrome-2) 42deg,var(--dw-chrome-4) 88deg,\n    var(--dw-chrome-3) 150deg,var(--dw-chrome-1) 205deg,var(--dw-chrome-2) 250deg,\n    var(--dw-chrome-4) 300deg,var(--dw-chrome-1) 360deg);\n  box-shadow:\n    0 2px 3px rgba(60,80,102,.4),\n    0 6px 10px -6px rgba(60,80,102,.5),\n    inset 0 1px 0 rgba(255,255,255,.9),\n    inset 0 -1px 2px rgba(60,80,102,.35);\n  position:relative;}\n.dw-pw .knob::after{content:\"\";position:absolute;left:50%;top:2.5px;width:2px;height:8px;margin-left:-1px;\n  border-radius:1px;background:rgba(40,58,76,.7);}\n.dw-pw .led{position:absolute;right:4px;top:-4px;width:7px;height:7px;border-radius:50%;\n  background:var(--dw-sig-off);\n  box-shadow:0 0 0 1px rgba(70,92,116,.25),inset 0 1px 1px rgba(255,255,255,.5);\n  transition:background .35s,box-shadow .35s;z-index:4;}\n.dw-pw[data-state=\"idle\"] .led{background:var(--dw-sig-ok);box-shadow:0 0 0 1px rgba(70,92,116,.2),0 0 7px var(--dw-sig-ok);animation:breathe 4.5s ease-in-out infinite}\n.dw-pw[data-state=\"starting\"] .led,\n.dw-pw[data-state=\"washing\"] .led,\n.dw-pw[data-state=\"rinsing\"] .led,\n.dw-pw[data-state=\"spinning\"] .led,\n.dw-pw[data-state=\"draining\"] .led{background:var(--dw-sig-run);box-shadow:0 0 0 1px rgba(70,92,116,.2),0 0 8px var(--dw-sig-run)}\n.dw-pw[data-state=\"waiting\"] .led{background:var(--dw-sig-wait);box-shadow:0 0 0 1px rgba(70,92,116,.2),0 0 9px var(--dw-sig-wait);animation:blink 1.1s steps(2,end) infinite}\n.dw-pw[data-state=\"error\"] .led{background:var(--dw-sig-err);box-shadow:0 0 0 1px rgba(70,92,116,.2),0 0 9px var(--dw-sig-err);animation:blink .65s steps(2,end) infinite}\n.dw-pw[data-state=\"done\"] .led{background:var(--dw-sig-ok);box-shadow:0 0 0 1px rgba(70,92,116,.2),0 0 10px var(--dw-sig-ok)}\n.dw-pw .door{position:relative;width:270px;height:270px;margin:2px auto 0;border-radius:50%;\n  \n  background:conic-gradient(from 138deg,\n    var(--dw-chrome-1) 0deg, var(--dw-chrome-2) 28deg, var(--dw-chrome-4) 58deg,\n    var(--dw-chrome-3) 96deg, var(--dw-chrome-1) 132deg, var(--dw-chrome-2) 176deg,\n    var(--dw-chrome-4) 208deg, var(--dw-chrome-3) 244deg, var(--dw-chrome-1) 286deg,\n    var(--dw-chrome-2) 322deg, var(--dw-chrome-1) 360deg);\n  padding:9px;\n  box-shadow:\n    0 1px 1px rgba(255,255,255,.9) inset,\n    0 -1px 1px rgba(50,70,92,.35) inset,\n    0 10px 18px -10px rgba(40,60,84,.6),\n    0 22px 34px -22px rgba(40,60,84,.5);\n  isolation:isolate;}\n.dw-pw .door::before{content:\"\";position:absolute;inset:0;border-radius:50%;z-index:2;pointer-events:none;\n  background:conic-gradient(from 0deg,\n    transparent 0deg, rgba(255,255,255,.95) 26deg, rgba(255,255,255,.15) 62deg,\n    transparent 96deg, rgba(255,255,255,.7) 150deg, transparent 190deg,\n    rgba(255,255,255,.45) 250deg, transparent 300deg, transparent 360deg);\n  -webkit-mask-image:radial-gradient(circle, transparent 84%, #000 88%, #000 100%);\n  mask-image:radial-gradient(circle, transparent 84%, #000 88%, #000 100%);\n  opacity:var(--sweep-opacity,.75);\n  animation:spin var(--sweep-speed,0s) linear infinite;\n  animation-play-state:var(--sweep-play,paused);\n  mix-blend-mode:screen;}\n.dw-pw .door::after{content:\"\";position:absolute;inset:9px;border-radius:50%;z-index:3;pointer-events:none;\n  box-shadow:\n    inset 0 2px 3px rgba(50,70,92,.5),\n    inset 0 -1px 2px rgba(255,255,255,.6);}\n.dw-pw .glass{position:relative;width:100%;height:100%;border-radius:50%;overflow:hidden;\n  background:\n    radial-gradient(circle at 30% 22%, var(--dw-glass-1) 0%, var(--dw-glass-2) 26%, var(--dw-glass-3) 58%, var(--dw-glass-4) 100%);\n  box-shadow:\n    inset 0 16px 26px rgba(255,255,255,.28),\n    inset 0 -22px 34px rgba(4,18,32,.62),\n    inset 0 0 0 1px rgba(255,255,255,.32),\n    inset 0 0 46px rgba(10,40,66,.4);}\n.dw-pw .glass::before{content:\"\";position:absolute;inset:-14% -6%;z-index:4;pointer-events:none;\n  background:linear-gradient(104deg,\n    transparent 16%, rgba(255,255,255,.20) 30%, rgba(255,255,255,.05) 38%,\n    transparent 46%, transparent 62%, rgba(255,255,255,.10) 74%, transparent 84%);\n  transform:rotate(-8deg);}\n.dw-pw .glass::after{content:\"\";position:absolute;left:11%;top:5%;width:48%;height:31%;border-radius:50%;\n  z-index:5;pointer-events:none;\n  background:radial-gradient(ellipse at 42% 38%, rgba(255,255,255,.92), rgba(255,255,255,.35) 46%, transparent 72%);\n  filter:blur(4px);opacity:.85;}\n.dw-pw .drum{position:absolute;inset:-5%;border-radius:50%;z-index:1;\n  background:\n    repeating-conic-gradient(from 0deg,\n      rgba(255,255,255,.20) 0deg 1.1deg, rgba(255,255,255,0) 1.1deg 7.5deg);\n  -webkit-mask-image:radial-gradient(circle at 50% 50%, transparent 32%, #000 54%, #000 96%, transparent 100%);\n  mask-image:radial-gradient(circle at 50% 50%, transparent 32%, #000 54%, #000 96%, transparent 100%);\n  animation:spin var(--speed,0s) linear infinite;\n  animation-play-state:var(--play,paused);\n  will-change:transform;}\n.dw-pw .drum::after{content:\"\";position:absolute;inset:0;border-radius:50%;\n  background:repeating-conic-gradient(from 24deg,\n    rgba(255,255,255,.30) 0deg 3.4deg, rgba(255,255,255,0) 3.4deg 120deg);\n  mix-blend-mode:screen;opacity:.75;}\n.dw-pw[data-state=\"rinsing\"] .drum{animation-direction:reverse}\n.dw-pw[data-state=\"spinning\"] .drum{filter:blur(.7px)}\n.dw-pw[data-state=\"spinning\"] .clothes{filter:blur(1.1px)}\n.dw-pw .water{position:absolute;left:-24%;right:-24%;bottom:0;height:var(--water-lvl,0%);z-index:2;\n  background:linear-gradient(180deg,var(--dw-water-1) 0%,var(--dw-water-2) 46%,var(--dw-water-3) 100%);\n  opacity:var(--water-opacity,.78);\n  transition:height 1s cubic-bezier(.32,.86,.3,1);\n  box-shadow:inset 0 2px 3px rgba(255,255,255,.35);}\n.dw-pw .water::before{content:\"\";position:absolute;left:-8%;right:-8%;top:-9px;height:18px;\n  background:radial-gradient(ellipse at 50% 100%, var(--dw-water-1) 0 58%, transparent 62%);\n  background-size:46px 18px;background-repeat:repeat-x;\n  animation:wave 3.6s linear infinite;}\n.dw-pw .water::after{content:\"\";position:absolute;left:-8%;right:-8%;top:-5px;height:14px;\n  background:radial-gradient(ellipse at 50% 100%, rgba(255,255,255,.5) 0 50%, transparent 56%);\n  background-size:34px 14px;background-repeat:repeat-x;\n  animation:wave 2.4s linear infinite reverse;\n  opacity:.6;}\n.dw-pw .clothes{position:absolute;inset:0;z-index:3;\n  animation:spin var(--speed,0s) linear infinite;\n  animation-play-state:var(--play,paused);\n  will-change:transform;}\n.dw-pw .clothes i{position:absolute;display:block;border-radius:6px;\n  box-shadow:0 3px 6px rgba(2,20,38,.42), inset 0 1px 0 rgba(255,255,255,.55);}\n.dw-pw .clothes i:nth-child(1){width:29px;height:19px;left:33%;top:27%;transform:rotate(16deg);\n  background:linear-gradient(150deg,#b8e4ff,#5aa6d8 70%,#3f86b8)}\n.dw-pw .clothes i:nth-child(2){width:21px;height:29px;left:57%;top:44%;transform:rotate(-22deg);\n  background:linear-gradient(150deg,#ffd0dd,#ef8aa6 70%,#cf6a86)}\n.dw-pw .clothes i:nth-child(3){width:25px;height:17px;left:39%;top:62%;transform:rotate(6deg);\n  background:linear-gradient(150deg,#c8f2d8,#71c896 70%,#4fa878)}\n.dw-pw .clothes i:nth-child(4){width:17px;height:23px;left:23%;top:47%;transform:rotate(38deg);\n  background:linear-gradient(150deg,#e0d4ff,#a58ce0 70%,#8368c2)}\n.dw-pw .bubbles{position:absolute;inset:0;z-index:4;opacity:var(--bubble,0);transition:opacity .5s}\n.dw-pw .bubbles b{position:absolute;border-radius:50%;\n  background:radial-gradient(circle at 34% 30%, #fff 0 40%, rgba(255,255,255,.55) 70%, rgba(255,255,255,.15));\n  box-shadow:0 0 5px rgba(255,255,255,.55), inset 0 -1px 2px rgba(120,180,220,.4);\n  animation:float 2.6s ease-in-out infinite;}\n.dw-pw .bubbles b:nth-child(1){width:12px;height:12px;left:29%;top:70%;animation-delay:0s}\n.dw-pw .bubbles b:nth-child(2){width:8px;height:8px;left:43%;top:78%;animation-delay:.35s}\n.dw-pw .bubbles b:nth-child(3){width:15px;height:15px;left:57%;top:66%;animation-delay:.7s}\n.dw-pw .bubbles b:nth-child(4){width:7px;height:7px;left:65%;top:74%;animation-delay:1.05s}\n.dw-pw .bubbles b:nth-child(5){width:10px;height:10px;left:51%;top:58%;animation-delay:1.4s}\n.dw-pw .bubbles b:nth-child(6){width:6px;height:6px;left:37%;top:60%;animation-delay:1.75s}\n.dw-pw .handle{position:absolute;left:-6px;top:50%;transform:translateY(-50%);z-index:6;\n  width:6px;height:44px;border-radius:4px;\n  background:linear-gradient(90deg,#ffffff,#c9d3dd 40%,#8e9baa 70%,#6b7885);\n  box-shadow:0 2px 4px rgba(40,60,84,.45),inset 0 1px 0 rgba(255,255,255,.9);}\n.dw-pw .lock{position:absolute;right:0;top:50%;transform:translateY(-50%);z-index:6;\n  width:8px;height:20px;border-radius:3px;\n  background:linear-gradient(90deg,#c9d3dd,#8e9baa 60%,#6b7885);\n  box-shadow:0 1px 2px rgba(40,60,84,.4),inset 0 1px 0 rgba(255,255,255,.8);\n  transition:.3s;}\n.dw-pw[data-state=\"waiting\"] .lock{background:var(--dw-sig-wait);\n  box-shadow:0 0 10px var(--dw-sig-wait),0 0 20px rgba(217,154,31,.4);\n  animation:blink 1.1s steps(2,end) infinite;}\n.dw-pw .panel{margin:15px 2px 15px;padding:9px 11px 10px;border-radius:9px;position:relative;overflow:hidden;\n  background:linear-gradient(180deg,var(--dw-scr-1),var(--dw-scr-2));\n  box-shadow:\n    inset 0 5px 12px rgba(0,0,0,.55),\n    inset 0 -1px 0 rgba(255,255,255,.06),\n    0 1px 0 rgba(255,255,255,.7),\n    0 0 0 1px rgba(50,70,92,.35);\n  font-family:ui-monospace,SFMono-Regular,\"SF Mono\",Menlo,monospace;}\n.dw-pw .panel::before{content:\"\";position:absolute;inset:0;pointer-events:none;\n  background:repeating-linear-gradient(0deg,rgba(255,255,255,.028) 0 1px,transparent 1px 3px);}\n.dw-pw .panel::after{content:\"\";position:absolute;inset:0;pointer-events:none;border-radius:inherit;\n  background:radial-gradient(120% 80% at 50% 0%,rgba(142,240,198,.10),transparent 60%);}\n.dw-pw .row1{display:flex;align-items:baseline;justify-content:space-between;gap:8px;position:relative;z-index:1}\n.dw-pw .state-text{font-size:12px;font-weight:600;color:var(--dw-scr-txt);letter-spacing:.02em;\n  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;\n  text-shadow:0 0 8px rgba(142,240,198,.45);}\n.dw-pw .timer{font-size:11px;color:var(--dw-scr-txt-dim);font-variant-numeric:tabular-nums;letter-spacing:.04em;}\n.dw-pw .row2{display:flex;align-items:center;gap:8px;margin-top:6px;position:relative;z-index:1}\n.dw-pw .wl{font-size:9px;color:var(--dw-scr-txt-dim);letter-spacing:.04em;white-space:nowrap}\n.dw-pw .bar{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.09);overflow:hidden;\n  box-shadow:inset 0 1px 2px rgba(0,0,0,.5)}\n.dw-pw .bar i{display:block;height:100%;width:var(--water-lvl,0%);border-radius:2px;\n  background:linear-gradient(90deg,#3ad2a0,#4aa3f0);\n  box-shadow:0 0 6px rgba(74,163,240,.6);\n  transition:width 1s cubic-bezier(.32,.86,.3,1);}\n.dw-pw[data-state=\"error\"] .state-text{color:#ff9a9d;text-shadow:0 0 8px rgba(242,96,100,.5)}\n.dw-pw[data-state=\"waiting\"] .state-text{color:#ffcf6b;text-shadow:0 0 8px rgba(240,183,58,.5)}\n.dw-pw[data-state=\"done\"] .state-text{color:#8ef0c6}\n.dw-pw .feet{position:absolute;left:8%;right:8%;bottom:-7px;height:12px;border-radius:50%;\n  background:radial-gradient(ellipse at 50% 50%,var(--dw-body-shade),transparent 70%);\n  filter:blur(3px);z-index:1;opacity:.85}\n\n/* ------------------------------------------------------------------ *\n * 关键帧定义\n *\n * 这一节曾经整段丢失（只有 animation 声明、没有 @keyframes），浏览器对\n * 未定义的动画名直接忽略，表现就是滚筒、衣物、水位、气泡全部静止——\n * 「滚筒洗衣机」变成一张静态图。补回时按各处的声明反推属性：\n *   spin    → 滚筒/衣物/门圈高光      （transform: rotate）\n *   wave    → 水位线两层               （background-position 平移一格）\n *   float   → 气泡                     （上浮 + 微缩放）\n *   breathe → idle 指示灯呼吸          （box-shadow 光晕）\n *   blink   → waiting / error 指示灯   （box-shadow 骤灭，steps 用）\n *   walk    → spinning 时整机抖动      （位移，不写 rotate 以免盖掉机身自身的 transition）\n *\n * 动画只动 transform / opacity / background-position / box-shadow，\n * 不动布局属性；且都在 .dsh-washer 子树内，宿主样式不受影响。\n * ------------------------------------------------------------------ */\n@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}\n@keyframes wave{from{background-position:0 0}to{background-position:46px 0}}\n@keyframes float{\n  0%{transform:translateY(0) scale(1);opacity:0}\n  20%{opacity:1}\n  80%{opacity:1}\n  100%{transform:translateY(-18px) scale(.82);opacity:0}}\n@keyframes breathe{\n  0%,100%{box-shadow:0 0 0 1px rgba(70,92,116,.2),0 0 5px var(--dw-sig-ok)}\n  50%{box-shadow:0 0 0 1px rgba(70,92,116,.2),0 0 11px var(--dw-sig-ok)}}\n@keyframes blink{\n  0%,55%{box-shadow:0 0 0 1px rgba(70,92,116,.2),0 0 9px var(--dw-sig,var(--dw-sig-wait))}\n  56%,100%{box-shadow:0 0 0 1px rgba(70,92,116,.2),0 0 2px var(--dw-sig,var(--dw-sig-wait))}}\n/* 整机抖动：用独立的 translate3d 而不是 rotate，避免和 .dw-pw 上的 transform transition 打架 */\n@keyframes walk{\n  0%{transform:translate3d(0,0,0)}\n  25%{transform:translate3d(-.6px,-.4px,0)}\n  50%{transform:translate3d(.5px,.3px,0)}\n  75%{transform:translate3d(-.3px,.5px,0)}\n  100%{transform:translate3d(0,0,0)}}\n\n/* dsh-washer · skin-anime.css */\n/* dsh-washer · anime skin (scoped .dw-aw*) */\n.dw-aw{ --w:230px; --ring:#a9d4f0; --ring-hi:#cbe6f8; --ring-lo:#6fa9d4;\n     width:var(--w); height:calc(var(--w)*1.07); position:relative; }\n.dw-aw *{position:absolute}\n.dw-aw-body{\n  inset:0;border-radius:calc(var(--w)*.055);\n  background:linear-gradient(172deg,#ffffff 0%,#fdfeff 52%,#eaf2fb 100%);\n  box-shadow:\n    0 0 0 2px #33465f,\n    0 calc(var(--w)*.09) calc(var(--w)*.14) calc(var(--w)*-.06) rgba(70,105,145,.34),\n    inset 0 1px 0 rgba(255,255,255,1),\n    inset calc(var(--w)*-.02) 0 calc(var(--w)*.04) rgba(160,190,220,.22);\n}\n\n.dw-aw-body::before{\n  content:\"\";position:absolute;left:0;right:0;top:22%;height:1.5px;background:#cfdcea;\n}\n\n.dw-aw-body::after{\n  content:\"\";position:absolute;right:0;top:calc(var(--w)*.05);bottom:calc(var(--w)*.05);\n  width:calc(var(--w)*.045);border-radius:0 3px 3px 0;\n  background:linear-gradient(90deg,rgba(190,208,226,0),rgba(170,192,214,.55));\n}\n.dw-aw-drawer{\n  left:7%;top:6%;width:38%;height:7.5%;border-radius:2px;\n  background:linear-gradient(180deg,#e8f0f9,#d3e0ee);\n  box-shadow:inset 0 1px 0 #fff,0 0 0 1.5px #33465f;\n}\n.dw-aw-drawer::after{\n  content:\"\";position:absolute;left:10%;right:10%;top:38%;height:2px;border-radius:2px;\n  background:#a9bccf;\n}\n.dw-aw-knob{\n  left:53%;top:4.4%;width:11%;aspect-ratio:1;border-radius:50%;\n  background:radial-gradient(circle at 34% 28%,#d8ecfb,#8fc2e4 55%,#5f9ecb 100%);\n  box-shadow:0 0 0 1.5px #33465f,inset 0 1px 2px rgba(255,255,255,.9);\n}\n.dw-aw-knob::after{\n  content:\"\";position:absolute;left:46%;top:14%;width:2px;height:22%;border-radius:2px;background:#4a7ba6;\n}\n.dw-aw-screen{\n  left:68%;top:4.6%;width:25%;height:8.6%;border-radius:2.5px;\n  background:linear-gradient(180deg,#20344d,#16263c);\n  box-shadow:0 0 0 1.5px #33465f,inset 0 1px 0 rgba(255,255,255,.14);\n}\n.dw-aw-screen::after{\n  content:\"\";position:absolute;left:10%;top:30%;width:44%;height:2px;border-radius:2px;\n  background:#7fe3b0;box-shadow:0 0 5px rgba(127,227,176,.9);\n}\n.dw-aw-door{\n  left:9%;top:24%;width:82%;aspect-ratio:1;border-radius:50%;\n}\n.dw-aw-ring{\n  inset:0;border-radius:50%;\n  background:\n    conic-gradient(from 215deg,#cfe8fa 0deg,#a9d4f0 46deg,#84b9de 110deg,#6fa9d4 176deg,#a3cdea 244deg,#c6e3f6 300deg,#cfe8fa 360deg);\n  box-shadow:\n    0 0 0 2px #33465f,\n    inset 0 2px 4px rgba(255,255,255,.95),\n    inset 0 -3px 6px rgba(58,110,160,.4);\n}\n\n.dw-aw-ring::after{\n  content:\"\";position:absolute;inset:-1%;border-radius:50%;\n  background:conic-gradient(from 0deg,transparent 0deg,rgba(255,255,255,.85) 30deg,rgba(255,255,255,.1) 78deg,transparent 120deg);\n  -webkit-mask-image:radial-gradient(circle,transparent 84%,#000 88%);\n  mask-image:radial-gradient(circle,transparent 84%,#000 88%);\n  animation:aw-spin var(--speed,0s) linear infinite;animation-play-state:var(--play,paused);\n}\n.dw-aw-glass{\n  inset:11%;border-radius:50%;overflow:hidden;\n  background:radial-gradient(circle at 36% 28%,#587a9c 0%,#33506f 34%,#1b3049 68%,#0d1b2c 100%);\n  box-shadow:\n    inset 0 5px 12px rgba(0,0,0,.6),\n    inset 0 -4px 10px rgba(120,180,230,.28),\n    0 1px 0 rgba(255,255,255,.5);\n}\n\n.dw-aw-drum{\n  inset:0;border-radius:50%;\n  background:repeating-conic-gradient(from 0deg,rgba(120,170,215,.34) 0deg 22deg,transparent 22deg 120deg);\n  -webkit-mask-image:radial-gradient(circle,transparent 16%,#000 40%);\n  mask-image:radial-gradient(circle,transparent 16%,#000 40%);\n  animation:aw-spin var(--speed,0s) linear infinite;animation-play-state:var(--play,paused);\n}\n\n.dw-aw-glass::after{\n  content:\"\";position:absolute;left:50%;top:50%;width:22%;aspect-ratio:1;\n  transform:translate(-50%,-50%);border-radius:50%;\n  background:radial-gradient(circle at 36% 30%,#6f93b6,#2b4664);\n  box-shadow:inset 0 1px 2px rgba(255,255,255,.4);\n  z-index:3;\n}\n.dw-aw-clothes{inset:0;z-index:2;pointer-events:none}\n.dw-aw-clothes i{\n  position:absolute;border-radius:38% 62% 55% 45%/48% 42% 58% 52%;\n  box-shadow:inset 0 1px 2px rgba(255,255,255,.55),0 1px 3px rgba(8,26,44,.45);\n  animation:aw-tumble var(--dur,4.6s) ease-in-out infinite alternate;\n  animation-play-state:var(--play,paused);\n}\n.dw-aw-clothes i:nth-child(1){left:22%;top:52%;width:17%;height:14%;background:linear-gradient(150deg,#a8d8ef,#6fb4d8);--dur:4.1s;animation-delay:-.4s}\n.dw-aw-clothes i:nth-child(2){left:56%;top:60%;width:15%;height:13%;background:linear-gradient(150deg,#f7c9d4,#e59aad);--dur:5.2s;animation-delay:-1.7s}\n.dw-aw-clothes i:nth-child(3){left:38%;top:68%;width:16%;height:13%;background:linear-gradient(150deg,#c8e6c9,#8cc79a);--dur:4.7s;animation-delay:-2.6s}\n.dw-aw-clothes i:nth-child(4){left:64%;top:44%;width:12%;height:11%;background:linear-gradient(150deg,#e0d4f2,#b3a0d8);--dur:5.8s;animation-delay:-1.1s}\n.dw-aw-water{\n  left:-20%;right:-20%;bottom:0;height:var(--water,0%);\n  background:linear-gradient(180deg,rgba(124,196,234,.85),rgba(47,127,174,.9));\n  transition:height .9s cubic-bezier(.32,.86,.3,1);\n  z-index:2;\n}\n.dw-aw-water::before{\n  content:\"\";position:absolute;left:0;right:0;top:-3px;height:6px;\n  background:radial-gradient(ellipse at 50% 100%,rgba(190,235,255,.85),transparent 70%);\n}\n.dw-aw-foam{\n  left:8%;right:8%;bottom:8%;height:26%;z-index:2;\n  background:radial-gradient(circle at 20% 60%,#fff 0 5px,transparent 5.5px),\n             radial-gradient(circle at 40% 74%,#fff 0 6px,transparent 6.5px),\n             radial-gradient(circle at 62% 62%,#fff 0 5px,transparent 5.5px),\n             radial-gradient(circle at 80% 76%,#fff 0 4.5px,transparent 5px),\n             radial-gradient(circle at 30% 88%,#fff 0 4px,transparent 4.5px),\n             radial-gradient(circle at 55% 90%,#fff 0 3.5px,transparent 4px),\n             radial-gradient(circle at 72% 86%,#fff 0 3px,transparent 3.5px);\n  opacity:var(--bubble,0);transition:opacity .5s;\n}\n\n.dw-aw-eyes{inset:0;z-index:4;pointer-events:none}\n.dw-aw-eyes i{\n  position:absolute;top:38%;width:13%;height:19%;border-radius:50%;\n  background:radial-gradient(ellipse at 42% 38%,#ffffff 0 52%,#d6f2ff 72%,#9fdcf5 100%);\n  box-shadow:0 0 10px 3px rgba(150,225,255,.85),0 0 22px 8px rgba(110,200,245,.42);\n  transition:opacity .3s,transform .35s cubic-bezier(.34,1.4,.64,1);\n}\n.dw-aw-eyes i:nth-child(1){left:29%}\n.dw-aw-eyes i:nth-child(2){right:29%}\n\n.dw-aw-handle{\n  right:2%;top:44%;width:3.4%;height:12%;border-radius:99px;\n  background:linear-gradient(90deg,#b8cfe4,#e6f1fa);\n  box-shadow:0 0 0 1.5px #33465f;\n}\n\n.dw-aw-filter{\n  right:9%;bottom:4%;width:22%;height:11%;border-radius:3px;\n  background:linear-gradient(180deg,#fdfefe,#eaf2fb);\n  box-shadow:0 0 0 1.5px #33465f;\n}\n.dw-aw-feet{inset:0}\n.dw-aw-feet i{\n  position:absolute;bottom:-3%;width:9%;height:4%;border-radius:0 0 3px 3px;\n  background:#8fa6bd;\n}\n.dw-aw-feet i:nth-child(1){left:12%}\n.dw-aw-feet i:nth-child(2){right:12%}\n\n.dw-aw-cord{\n  position:absolute;right:2%;bottom:6%;width:22%;height:2px;border-radius:2px;\n  background:linear-gradient(90deg,#3a4a5e,#2b3d57);\n  transform:rotate(14deg);transform-origin:left center;\n}\n.dw-aw-cord::after{\n  content:\"\";position:absolute;right:-9px;top:-4px;width:11px;height:9px;border-radius:2px;\n  background:#2b3d57;\n}\n\n.dw-aw[data-state=\"idle\"]      .dw-aw-eyes i{opacity:.32;transform:scaleY(.55)}\n.dw-aw[data-state=\"starting\"]  .dw-aw-eyes i{opacity:.8;transform:scaleY(.8)}\n.dw-aw[data-state=\"washing\"]   .dw-aw-eyes i{opacity:1}\n.dw-aw[data-state=\"rinsing\"]   .dw-aw-eyes i{opacity:1;transform:scale(.88)}\n.dw-aw[data-state=\"spinning\"]  .dw-aw-eyes i{opacity:1;transform:scale(.72);filter:blur(.4px)}\n.dw-aw[data-state=\"waiting\"]   .dw-aw-eyes i{opacity:1;transform:scale(1.12)}\n.dw-aw[data-state=\"draining\"]  .dw-aw-eyes i{opacity:.75;transform:scaleY(.7)}\n.dw-aw[data-state=\"done\"]      .dw-aw-eyes i{opacity:1;transform:scaleY(.3) translateY(28%)}\n.dw-aw[data-state=\"error\"]     .dw-aw-eyes i{opacity:1;transform:scaleY(.24);filter:hue-rotate(-120deg)}\n.dw-aw[data-state=\"idle\"] .dw-aw-ring{--ring:#b9d6ea}\n.dw-aw[data-state=\"waiting\"] .dw-aw-ring{\n  background:conic-gradient(from 215deg,#ffe9b8,#f5c451 46deg,#e0a72c 110deg,#c98f18 176deg,#f0c96a 244deg,#ffeec4 300deg,#ffe9b8);\n}\n.dw-aw[data-state=\"error\"] .dw-aw-ring{\n  background:conic-gradient(from 215deg,#ffd0d2,#ef8085 46deg,#d9555c 110deg,#b93b42 176deg,#e87076 244deg,#ffdcdd 300deg,#ffd0d2);\n}\n.dw-aw[data-state=\"done\"] .dw-aw-ring{\n  background:conic-gradient(from 215deg,#c9f2dc,#7fd9a8 46deg,#4dbe83 110deg,#37a06a 176deg,#8ee0b4 244deg,#d6f7e6 300deg,#c9f2dc);\n}\n\n.dw-aw[data-face=\"off\"] .dw-aw-eyes{display:none}\n\n.dw-aw[data-size=\"xs\"]{--w:32px}\n.dw-aw[data-size=\"xs\"] .dw-aw-drawer,\n.dw-aw[data-size=\"xs\"] .dw-aw-knob,\n.dw-aw[data-size=\"xs\"] .dw-aw-screen,\n.dw-aw[data-size=\"xs\"] .dw-aw-handle,\n.dw-aw[data-size=\"xs\"] .dw-aw-filter,\n.dw-aw[data-size=\"xs\"] .dw-aw-feet,\n.dw-aw[data-size=\"xs\"] .dw-aw-cord,\n.dw-aw[data-size=\"xs\"] .dw-aw-drum,\n.dw-aw[data-size=\"xs\"] .dw-aw-foam,\n.dw-aw[data-size=\"xs\"] .dw-aw-clothes{display:none}\n.dw-aw[data-size=\"xs\"] .dw-aw-eyes i{width:17%;height:24%;top:44%}\n.dw-aw[data-size=\"xs\"] .dw-aw-eyes i:nth-child(1){left:26%}\n.dw-aw[data-size=\"xs\"] .dw-aw-eyes i:nth-child(2){right:26%}\n.dw-aw[data-size=\"sm\"]{--w:76px}\n.dw-aw[data-size=\"sm\"] .dw-aw-handle,\n.dw-aw[data-size=\"sm\"] .dw-aw-filter,\n.dw-aw[data-size=\"sm\"] .dw-aw-cord,\n.dw-aw[data-size=\"sm\"] .dw-aw-feet,\n.dw-aw[data-size=\"sm\"] .dw-aw-clothes i:nth-child(3),\n.dw-aw[data-size=\"sm\"] .dw-aw-clothes i:nth-child(4){display:none}\n.dw-aw[data-size=\"md\"]{--w:150px}\n.dw-aw[data-size=\"md\"] .dw-aw-cord{display:none}\n@media (prefers-reduced-motion:reduce){\n  .dw-aw-drum,.dw-aw-ring::after{animation:none!important}\n}\n\n/* 关键帧定义：曾整段丢失导致滚筒/门圈高光/衣物全部静止（见 skin-precision.css 同节说明） */\n@keyframes aw-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}\n@keyframes aw-tumble{\n  0%{transform:rotate(-14deg) translateY(0)}\n  100%{transform:rotate(16deg) translateY(-6%)}}\n";

    const LOCALE_NS = 'washer';
    const ENTRY_ID = 'washer';

    const ZH = {
      'state.off': '未连接',
      'state.idle': '待机',
      'state.starting': '启动中',
      'state.washing': '洗涤中',
      'state.rinsing': '漂洗中',
      'state.spinning': '脱水中',
      'state.waiting': '等你确认',
      'state.draining': '排水换水中',
      'state.done': '洗完了',
      'state.error': '故障',
      'sub.off': '没有进行中的会话',
      'sub.idle': '滚筒停着，随时可以开工',
      'sub.idleLast': '上次洗完 {time}',
      'sub.starting': '正在起转 · {elapsed}',
      'sub.washing': '{elapsed} · 第 {n} 件',
      'sub.rinsing': '{tool} · {elapsed}',
      'sub.rinsingBare': '{elapsed}',
      'sub.spinning': '收尾整理 · {elapsed}',
      'sub.waiting': '有个地方要你拍板',
      'sub.draining': '上下文压缩中 · 第 {n} 件',
      'sub.done': '用时 {dur} · 共 {n} 件',
      'sub.error': '{code} · 点开看看',
      'label.washer': '洗衣机状态',
      'overlay.running': '浮窗模式 · 想看得更全请切回 dock',
      'label.skin': '外观',
      'skin.precision': '精密家电',
      'skin.anime': '动漫',
      'skin.pixel': '像素',
      'set.title': '洗衣机',
      'set.intro': 'Agent 干活时的状态指示。改完立即生效。',
      'set.nav': '洗衣机',
      'set.hideIdle': '空闲时隐藏',
      'set.restartHint': '档位和外观改完不用重启；成本需要先配好单价才会显示金额。',
      'set.overlay': '桌面悬浮窗',
      'set.overlayOn': '显示悬浮窗',
      'set.skinHint': '主界面和桌面悬浮窗共用这一套皮肤，改这里两边一起变。',
      'set.overlayHint': '开启后随客户端启动，在桌面角落显示一台洗衣机；关掉会立刻收起。',
      'set.overlaySize': '悬浮窗大小',
      'ov.normal': '正常',
      'ov.tiny': '极简',
      'set.overlaySizeHint': '「极简」只留指示灯，不显示状态文字，占桌面空间最小。',
      'set.overlayThrough': '鼠标穿透',
      'set.overlayThroughHint': '开启后点击直接落到底下的应用，悬浮窗不再接收鼠标；按 ⌥⌘W 可以随时关掉。',
      'err.e00.title': '出了点问题',
      'err.e00.hint': '原因不明，可以重试一次',
      'err.e10.title': '账号或服务不可用',
      'err.e10.hint': '检查登录状态和网络后重试',
      'err.e20.title': '工具有一步没跑成',
      'err.e21.title': '你拒绝了这一步',
      'err.e21.hint': '需要的话重新发一次，或放宽权限',
      'err.e30.title': '上下文塞满了',
      'err.e30.hint': '开新会话，或让它先压缩一下',
      'err.e40.title': '被中断了',
      'err.e40.hint': '不是故障，重新发一次就能续上',
      'err.e50.title': '被策略拦下了',
      'err.e50.hint': '这一步触发了限制，换个说法试试',
    };

    const EN = {
      'state.off': 'Offline',
      'state.idle': 'Idle',
      'state.starting': 'Starting',
      'state.washing': 'Thinking',
      'state.rinsing': 'Running tool',
      'state.spinning': 'Finishing',
      'state.waiting': 'Waiting on you',
      'state.draining': 'Compacting',
      'state.done': 'Done',
      'state.error': 'Failed',
      'sub.off': 'No active session',
      'sub.idle': 'Drum is still, ready when you are',
      'sub.idleLast': 'Last run {time}',
      'sub.starting': 'Spinning up · {elapsed}',
      'sub.washing': '{elapsed} · {n} pcs',
      'sub.rinsing': '{tool} · {elapsed}',
      'sub.rinsingBare': '{elapsed}',
      'sub.spinning': 'Wrapping up · {elapsed}',
      'sub.waiting': 'Something needs your call',
      'sub.draining': 'Compacting context · {n} pcs',
      'sub.done': 'Took {dur} · {n} pcs',
      'sub.error': '{code} · tap to inspect',
      'label.washer': 'Washer status',
      'overlay.running': 'Overlay mode - switch back to dock for full detail',
      'label.skin': 'Skin',
      'skin.precision': 'Precision',
      'skin.anime': 'Anime',
      'skin.pixel': 'Pixel',
      'set.title': 'Washer',
      'set.intro': 'Live status while the agent works. Changes take effect immediately.',
      'set.nav': 'Washer',
      'set.hideIdle': 'Hide when idle',
      'set.restartHint': 'Skin and size apply instantly; cost only shows once a unit price is configured.',
      'set.overlay': 'Desktop overlay',
      'set.overlayOn': 'Show overlay',
      'set.skinHint': 'One skin shared by the dock bar and the desktop overlay — change it once, both update.',
      'set.overlayHint': 'Starts with the app and shows a washer in the corner of your desktop. Turning it off removes it immediately.',
      'set.overlaySize': 'Overlay size',
      'ov.normal': 'Normal',
      'ov.tiny': 'Minimal',
      'set.overlaySizeHint': '"Minimal" keeps only the indicator light with no status text - the smallest footprint.',
      'set.overlayThrough': 'Click-through',
      'set.overlayThroughHint': 'Let clicks fall through to the app underneath. Press Opt+Cmd+W to turn it off.',
      'err.e00.title': 'Something went wrong',
      'err.e00.hint': 'Unknown cause - try again',
      'err.e10.title': 'Account or service unavailable',
      'err.e10.hint': 'Check your sign-in and network, then retry',
      'err.e20.title': 'A tool step failed',
      'err.e21.title': 'You declined that step',
      'err.e21.hint': 'Send it again, or loosen the permission',
      'err.e30.title': 'Context is full',
      'err.e30.hint': 'Start a new session, or let it compact first',
      'err.e40.title': 'Interrupted',
      'err.e40.hint': 'Not a failure - send it again to continue',
      'err.e50.title': 'Blocked by policy',
      'err.e50.hint': 'This step hit a limit - rephrase and retry',
    };

    /* 每状态：水位 / 转速 / 泡沫。机型自己的表，和文案解耦 */
    const PW_WATER = { off: 0, idle: 0, starting: 15, washing: 48, rinsing: 42, spinning: 18, waiting: 35, draining: 4, done: 0, error: 26 };
    const AW_WATER = { off: 2, idle: 4, starting: 10, washing: 34, rinsing: 30, spinning: 16, waiting: 26, draining: 6, done: 2, error: 20 };
    const SPEED = { off: '0s', idle: '0s', starting: '2.2s', washing: '1.7s', rinsing: '2.6s', spinning: '0.55s', waiting: '0s', draining: '3.4s', done: '0s', error: '0s' };
    const BUBBLE = { off: 0, idle: 0, starting: 0.2, washing: 1, rinsing: 0.5, spinning: 0, waiting: 0.25, draining: 0, done: 0, error: 0 };

    // 机型的自然尺寸（headless Chrome 实测，1:1 下的像素盒）。
    // h 必须把伸出机身的部件算进去：动漫风底脚在 bottom:-3%、电源线在 right:2%/bottom:6%，
    // 所以机身本身 246 之外还要再留 12；精密家电的底脚同理，397 之外留到 412。
    const NATURAL = {
      pixel: { w: 256, h: 312 },
      precision: { w: 330, h: 412 },
      anime: { w: 230, h: 258 },
    };

    /*
     * 停靠条里那台机器的显示宽度。和 .dw-sprite 的 32px 对齐——
     * 条高 52px，机器占 32×40，右边留文字。三套造型都缩到同一宽度，
     * 换皮肤时文字位置不会跟着跳。
     */
    const WASHER_STRIP_MACHINE_W = 32;

    const DEFAULT_CONFIG = {
      enabled: true,
      mode: 'dock',
      /*
       * 停靠条只有一种形态：不再有 S/M/L 三档，也不再点击展开。
       * size / expandedByDefault 是旧字段，留着只为兼容老 config 不报错，
       * 但已经没有任何代码读它们——渲染永远是 S 档停靠条。
       */
      /*
       * 默认皮肤。以前是 'auto'（按尺寸自动挑 pixel/anime），
       * 用户要求去掉"自动"选项——那就不能留个默认值让下拉里没有任何一项被选中。
       * 直接落成 pixel：停靠条本身就是像素 sprite，视觉最连贯。
       */
      skin: 'pixel',
      /*
       * 皮肤只有一份：主界面停靠条和桌面悬浮窗共用同一个 skin。
       *
       * 早先分成 skin（主界面）和 desktopOverlaySkin（浮窗）两个字段，
       * 结果是用户改了一个另一个不变，界面上两组"精密/动漫/像素"看着一模一样
       * 却各自独立，本身就是误导。现在合并成一份，浮窗启动参数也读这个字段。
       *
       * skinBySize 只保留 xs/lg 两档宽度：停靠条里的迷你 sprite 和
       * 悬浮窗/浮层用的大图。sm/md 是旧三档时代的产物，已无人使用。
       */
      skinBySize: { xs: 'pixel', lg: 'pixel' },
      costPerKToken: 0,
      costCurrency: 'CNY',
      hideWhenIdle: false,
      overlayOnlyWhenBusy: true,
      doneHoldMs: 6000,
      toolHistoryLimit: 6,
      // 桌面悬浮窗（Electron 壳）：靠 localStorage 持久化，
      // 宿主侧 apply() 读的是 cordis 配置，所以这里只负责"设置页能改、能同步给浮窗"
      //
      // desktopOverlay 必须在默认值里显式给出：设置页读的是 cfg.desktopOverlay === true，
      // 这个键一旦缺失就比较成 undefined，"未配置"和"用户关了"会显示成同一个样子。
      // 它同时决定宿主要不要拉起 Electron，默认必须是关——装了不看的人
      // 不该莫名多一个后台进程和端口。
      desktopOverlay: false,
      desktopOverlaySize: 'normal',
      /*
       * 鼠标穿透：开启后浮窗不再接收任何鼠标事件，点击直接落到底下的应用。
       * 以前这是浮窗上双击切换的，现在挪到设置页（理由见 OVERLAY_PREF_KEYS）。
       */
      desktopOverlayClickThrough: false,
    };

    /* ------------------------------------------------------------------ *
     * 纯工具
     * ------------------------------------------------------------------ */
    function mergeConfig(patch) {
      const out = {};
      Object.keys(DEFAULT_CONFIG).forEach((key) => { out[key] = DEFAULT_CONFIG[key]; });
      if (!patch || typeof patch !== 'object') return out;
      Object.keys(patch).forEach((key) => {
        if (patch[key] !== undefined) out[key] = patch[key];
      });
      if (patch.skinBySize && typeof patch.skinBySize === 'object') {
        out.skinBySize = Object.assign({}, DEFAULT_CONFIG.skinBySize, patch.skinBySize);
      }
      return out;
    }

    function fill(template, params) {
      if (typeof template !== 'string') return '';
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (whole, key) => (
        params[key] === undefined || params[key] === null ? whole : String(params[key])
      ));
    }

    function formatClock(ts) {
      if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
      const d = new Date(ts);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }


    /**
     * 皮肤只有三个合法值。老配置里可能还留着 skin:'auto'，按 pixel 处理，
     * 免得渲染时拿到一个谁都不认识的字符串。
     */
    function pickSkin(cfg, bucket) {
      if (cfg.skin !== 'auto') return cfg.skin;
      const mapped = cfg.skinBySize ? cfg.skinBySize[bucket] : undefined;
      return mapped === 'precision' || mapped === 'anime' || mapped === 'pixel' ? mapped : 'pixel';
    }

    /**
     * 减弱动态效果：只跟随系统，不再提供设置项。
     *
     * 原先有个三态设置（始终/从不/跟随系统），但「从不」等于无视用户的
     * 无障碍设置，「始终」又让状态动效（滚筒、指示灯）也被冻住——它们本来
     * 是传达信息的手段，不是装饰。既然两头都会把人带沟里，就不该让用户选。
     *
     * 只读一次系统偏好：实时变化由 CSS 里各处的 @media 自己兜底。
     */
    function systemPrefersReducedMotion() {
      try {
        return typeof window !== 'undefined'
          && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
      } catch (_error) {
        return false;
      }
    }

    function reduceMotionFlag() {
      return systemPrefersReducedMotion() ? '1' : '0';
    }

    /* ------------------------------------------------------------------ *
     * 机型
     * ------------------------------------------------------------------ */

    /* 32px 像素 sprite：水 / 泡沫 / LED 三个可动图层靠 CSS 变量驱动 */
    function PixelSprite(state) {
      const visual = VISUAL[state] || VISUAL.idle;
      const blink = visual.blink === 0.6 ? '1' : (visual.blink === 0.35 ? '2' : '0');
      return h('span', {
        className: 'dw-sprite dw-px',
        'data-blink': blink,
        'aria-hidden': 'true',
        style: {
          '--dw-water': String(visual.water),
          '--dw-foam': String(visual.foam),
          '--dw-led': visual.led,
        },
        dangerouslySetInnerHTML: { __html: SPRITE_SVG },
      });
    }

    /**
     * 停靠条里那台小机器：按皮肤选造型。
     *
     * 宽度固定 30px。'auto'（老配置残留）走 pickSkin 落到 pixel，
     * 不认识的值也一样——不能让停靠条因为一个脏字段变空白。
     */
    function MachineStrip(skin, state, screenTime) {
      const resolved = skin === 'precision' || skin === 'anime' || skin === 'pixel' ? skin : 'pixel';
      if (resolved === 'pixel') return PixelSprite(state);
      return BigMachine(resolved, state, WASHER_STRIP_MACHINE_W, screenTime);
    }

    /* 任意机型统一放进固定尺寸 + transform 缩放的框里：重排一次都不做 */
    function MachineFrame(skin, state, width, inner) {
      const natural = NATURAL[skin];
      const scale = width / natural.w;
      return h('div', {
        className: 'dw-frame',
        style: {
          width: Math.round(natural.w * scale) + 'px',
          height: Math.round(natural.h * scale) + 'px',
        },
        'aria-hidden': 'true',
      }, h('div', {
        className: 'dw-frame-inner',
        style: { width: natural.w + 'px', transform: 'scale(' + scale + ')' },
      }, inner));
    }

    function PixelMachine(state, width) {
      return MachineFrame('pixel', state, width,
        h('div', { dangerouslySetInnerHTML: { __html: MACHINE_SVG }, style: { lineHeight: 0 } }));
    }

    /* 精密家电：机身小屏只说机器自己的话（WASH / SPIN / ERR…），不重复 UI 文案 */
    const SCREEN_WORD = {
      off: 'OFF', idle: 'READY', starting: 'START', washing: 'WASH', rinsing: 'RINSE',
      spinning: 'SPIN', waiting: 'HOLD', draining: 'DRAIN', done: 'DONE', error: 'ERR',
    };

    function PrecisionMachine(state, width, screenTime) {
      const play = SPEED[state] === '0s' ? 'paused' : 'running';
      const water = PW_WATER[state];
      return MachineFrame('precision', state, width,
        h('div', {
          className: 'dw-pw',
          'data-state': state,
          style: {
            '--water-lvl': water + '%',
            '--bubble': String(BUBBLE[state]),
            '--speed': SPEED[state],
            '--play': play,
          },
        },
        h('div', { className: 'topbar' },
          h('div', { className: 'drawer' }),
          h('div', { className: 'knob' }),
          h('div', { className: 'led' })),
        h('div', { className: 'door' },
          h('div', { className: 'handle' }),
          h('div', { className: 'lock' }),
          h('div', { className: 'glass' },
            h('div', { className: 'drum' }),
            h('div', { className: 'clothes' }, h('i'), h('i'), h('i'), h('i')),
            h('div', { className: 'water' }),
            h('div', { className: 'bubbles' }, h('b'), h('b'), h('b'), h('b'), h('b'), h('b')))),
        h('div', { className: 'panel' },
          h('div', { className: 'row1' },
            h('span', { className: 'state-text' }, SCREEN_WORD[state] || 'READY'),
            h('span', { className: 'timer' }, screenTime)),
          h('div', { className: 'row2' },
            h('span', { className: 'wl' }, water + '%'),
            h('span', { className: 'bar' }, h('i')))),
        h('div', { className: 'feet' })));
    }

    function AnimeMachine(state, width, screenTime) {
      const play = SPEED[state] === '0s' ? 'paused' : 'running';
      // 表情（眼睛）曾经可开关，现在固定为关：在 32px 的停靠条里
      // 一双眼睛只占几个像素，看不出表情，反而让机器显得脏。
      const eyes = null;
      return MachineFrame('anime', state, width,
        h('div', {
          className: 'dw-aw',
          'data-state': state,
          'data-size': 'lg',

          style: {
            '--w': Math.round(NATURAL.anime.w) + 'px',
            '--speed': SPEED[state],
            '--play': play,
            '--water': AW_WATER[state] + '%',
            '--bubble': String(BUBBLE[state]),
          },
        },
        h('div', { className: 'dw-aw-body' }),
        h('div', { className: 'dw-aw-drawer' }),
        h('div', { className: 'dw-aw-knob' }),
        h('div', { className: 'dw-aw-screen' }, screenTime),
        h('div', { className: 'dw-aw-door' },
          h('div', { className: 'dw-aw-ring' }),
          h('div', { className: 'dw-aw-glass' },
            h('div', { className: 'dw-aw-drum' }),
            h('div', { className: 'dw-aw-clothes' }, h('i'), h('i'), h('i'), h('i')),
            h('div', { className: 'dw-aw-water' }),
            h('div', { className: 'dw-aw-foam' }),
            eyes),
          h('div', { className: 'dw-aw-handle' })),
        h('div', { className: 'dw-aw-filter' }),
        h('div', { className: 'dw-aw-feet' }, h('i'), h('i')),
        h('div', { className: 'dw-aw-cord' })));
    }

    function BigMachine(skin, state, width, screenTime) {
      if (skin === 'anime') return AnimeMachine(state, width, screenTime);
      if (skin === 'pixel') return PixelMachine(state, width);
      return PrecisionMachine(state, width, screenTime);
    }

    /* ------------------------------------------------------------------ *
     * 组件
     * ------------------------------------------------------------------ */
    /**
     * 订阅偏好变化并强制重渲染。
     *
     * 多个座位（dock / overlay / settings）各自持有 props.washerConfig 的快照，
     * 其中一处改了偏好，其它处必须跟着刷新——否则设置页切了皮肤，卡片还是旧的。
     */
    function usePrefRevision(props) {
      const [rev, setRev] = React.useState(0);
      React.useEffect(() => {
        const subscribe = props.washerSubscribePrefs;
        if (typeof subscribe !== 'function') return undefined;
        return subscribe(() => setRev((n) => n + 1));
      }, [props.washerSubscribePrefs]);
      return rev;
    }

    function WasherDock(props) {
      const { sessionId, useSession, useSessionStatus, useChat, useProjection } = props;
      // 'dock' = 常规座位（输入框下方）；'header' = 审批接管输入框时的替补座位。
      const variant = props.washerVariant === 'header' ? 'header' : 'dock';
      // useTrajectory 是宿主标准 prop，但只在 conversation 相关 slot 上稳定存在；
      // 拿不到时退回一个永远返回 undefined 的 hook（压缩态自动降级，不影响其它状态）。
      const useTrajectory = typeof props.useTrajectory === 'function'
        ? props.useTrajectory
        : () => undefined;
      const cfg = (typeof props.washerGetConfig === 'function' ? props.washerGetConfig() : props.washerConfig) || DEFAULT_CONFIG;
      // 订阅全局偏好：任何一处改了配置，这里跟着重渲染
      usePrefRevision(props);
      // 本地覆盖层：点完立刻见效，不等宿主把配置回传（避免一次往返的空档）
      const [prefPatch, setPrefPatch] = React.useState(null);
      const mergedCfg = prefPatch === null ? cfg : Object.assign({}, cfg, prefPatch);
      const setPref = React.useCallback((key, value) => {
        setPrefPatch((current) => Object.assign({}, current, { [key]: value }));
        if (typeof props.washerSetPref === 'function') props.washerSetPref(key, value);
      }, [props.washerSetPref]);
      // 注册 slot 时传了 locale: LOCALE_NS，渲染器给的 t 已是本命名空间内的裸 key
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const tr = (key) => t(key);

      const running = useSession((s) => s.running === true);
      const removed = useSession((s) => s.removed === true);
      const pending = useSessionStatus((status) => {
        if (sessionId === undefined || status === undefined) return undefined;
        const row = status.get(sessionId);
        return row === undefined ? undefined : row.pendingInteraction;
      });
      const runningCalls = useChat((s) => s.legacy.runningCalls);
      const partial = useChat((s) => s.legacy.partial);
      const nodes = useChat((s) => s.legacy.nodes);
      const turnTimings = useChat((s) => s.legacy.turnTimings);
      const outline = useProjection('turnOutline');
      // 上下文压缩的实时信号（chat nodes 里的 compaction 节点是压缩**落地后**才有的）
      const trajectory = useTrajectory((snapshot) => snapshot);

      const [, setTick] = React.useState(0);
      const [sticky, setSticky] = React.useState(null);
      const [shown, setShown] = React.useState(null);
      const prevRunning = React.useRef(running);
      const shownRef = React.useRef(null);

      const now = Date.now();
      const candidate = deriveState({
        sessionId, running, pending, runningCalls, partial, nodes, outline, trajectory, sticky, now,
      });

      /* 迟滞：washing ↔ rinsing 之间不抖，紧急态立即切 */
      React.useEffect(() => {
        const current = shownRef.current;
        if (current === null) {
          shownRef.current = { state: candidate, at: Date.now() };
          setShown(candidate);
          return undefined;
        }
        if (current.state === candidate) return undefined;
        const held = Date.now() - current.at;
        if (shouldSwitch(current.state, candidate, held)) {
          shownRef.current = { state: candidate, at: Date.now() };
          setShown(candidate);
          return undefined;
        }
        const id = setTimeout(() => {
          shownRef.current = { state: candidate, at: Date.now() };
          setShown(candidate);
        }, Math.max(0, 400 - held));
        return () => clearTimeout(id);
      }, [candidate]);

      /* running 由 true → false 且这一轮没有错误：进入 done 保持窗口 */
      React.useEffect(() => {
        if (running === true) {
          prevRunning.current = true;
          if (sticky !== null) setSticky(null);
          return;
        }
        if (prevRunning.current === true) {
          const turn = latestTurnOf(outline);
          if (findTurnError(nodes, turn) === undefined) {
            setSticky({ kind: 'done', turn, until: Date.now() + mergedCfg.doneHoldMs });
          }
        }
        prevRunning.current = false;
      }, [running, mergedCfg.doneHoldMs, outline, nodes, sticky]);

      /* 只有「在跑」或「done 保持窗口」才走 1s 心跳；闲着时零开销 */
      const needsClock = running === true || sticky !== null;
      React.useEffect(() => {
        if (!needsClock) return undefined;
        const id = setInterval(() => setTick((n) => n + 1), 1000);
        return () => clearInterval(id);
      }, [needsClock]);

      /* done 保持窗口到期后清掉 sticky */
      React.useEffect(() => {
        if (sticky === null) return undefined;
        const left = sticky.until - Date.now();
        if (left <= 0) { setSticky(null); return undefined; }
        const id = setTimeout(() => setSticky(null), left);
        return () => clearTimeout(id);
      }, [sticky]);

      // 根节点 ref：不再用于键盘处理（没有可收起的档位了），但保留它，
      // 供测试和宿主定位"这台洗衣机的 DOM 根"，也便于将来做点击穿透之类的判断。
      const washerRootRef = React.useRef(null);

      /*
       * 停靠条固定为一种形态，不再有展开档位。
       *
       * 这里曾经有三档（S 停靠条 / M 卡片 / L 大卡片+统计），点击循环、Esc 逐级退回。
       * 用户明确要求只保留小尺寸：一个显示"洗到哪了"的状态条，不需要点开看详情——
       * 详情该去悬浮窗右键菜单或详情面板看。于是 level 状态、cycle、
       * document 级 Esc 捕获、M/L 两档的整棵卡片 DOM 全部删除。
       */
      if (mergedCfg.enabled === false) return null;
      if (sessionId === undefined || sessionId === null || removed) return null;

      const state = shown === null ? candidate : shown;
      if (mergedCfg.hideWhenIdle === true && state === 'idle') return null;
      // 审批/提问会由宿主接管整个 composer（连同 composer.dock 一起 display:none），
      // 于是「等你确认」恰好在最该看见的时候消失。补救：header 座位只在 waiting 顶上来，
      // dock 座位在 waiting 主动让位，任何时刻只有一个实例在渲染。
      if (variant === 'header' && state !== 'waiting') return null;
      if (variant === 'dock' && state === 'waiting') return null;

      const turn = latestTurnOf(outline);
      const elapsed = elapsedOf(turnTimings, turn, now);
      const toolCount = toolCountOf(nodes, turn);
      const lastEnd = turnEndTimeOf(turnTimings, turn);
      const errorNode = findTurnError(nodes, turn) || findToolFailure(nodes, turn);
      const code = errorCodeOf(errorNode);
      const active = activeTool(runningCalls);
      const dur = formatDuration(elapsed);

      const title = tr('state.' + state);
      const toolName = active === undefined ? '' : active.name;

      const parts = { elapsed: dur, dur, n: String(toolCount), code, tool: toolName };
      let sub = tr('sub.' + state);
      if (state === 'idle') {
        sub = lastEnd === undefined ? tr('sub.idle') : fill(tr('sub.idleLast'), { time: formatClock(lastEnd) });
      } else if (state === 'rinsing' && toolName === '') {
        sub = fill(tr('sub.rinsingBare'), parts);
      } else if (state !== 'off' && state !== 'waiting') {
        sub = fill(tr('sub.' + state), parts);
      }

      const tone = state === 'error' ? 'error' : (state === 'waiting' ? 'warn' : (state === 'done' ? 'ok' : undefined));

      /*
       * 停靠条从 <button> 改成静态 <div>：它不再可点开，就不是可交互控件。
       * 继续用 button 会让读屏把它念成"可按下按钮"，键盘也会给它 tab 焦点，
       * 按下去却什么都不会发生——比不给焦点更让人困惑。
       * 状态信息改用 role="status" 传达，读屏会主动播报状态变化。
       */
      const strip = h('div', {
        className: 'dw-strip',
        role: 'status',
        'aria-label': tr('label.washer') + ': ' + title + ' · ' + sub,
        title: tr('label.washer') + ': ' + title + ' · ' + sub,
      },
      /*
       * 皮肤要真的生效。
       *
       * 删掉 M/L 展开卡时，这里跟着变成了写死的 PixelSprite——条上永远是像素小图，
       * 用户改设置页皮肤当然一点变化没有。三台机器本来都在（BigMachine 还在），
       * 只是没人调用它们了。
       *
       * 停靠条里机器只占 30px 宽，三套造型在这个尺寸下都还能认出来，
       * 所以按 skin 直接选；老配置里的 'auto' 由 pickSkin 兜底成 pixel。
       */
      /*
       * 三档自适应靠 CSS @media 窗口宽度查询（见 style.css，别用 @container——
       * 宿主父容器是 fit-content，容器查询会自激锁死在极简档）。
       * 这里只管把三份信息都吐出去，由宽度决定露多少：
       *   紧凑 —— 机器 + 状态 + 计时/件数（两行）
       *   迷你 —— 机器 + 状态 + 计时（一行）
       *   极简 —— 只留机器
       *
       * dw-dot 已删除：机器造型、水位、指示灯都在表达状态，
       * 再挂一颗圆点是同一件事说三遍，而且窄档位里它是最先该让位的。
       */
      MachineStrip(mergedCfg.skin, state, dur),
      h('span', { className: 'dw-text' },
        h('span', { className: 'dw-t1', 'data-tone': tone }, title),
        h('span', { className: 'dw-t2', 'data-hide': 'compact' }, sub)));

      return h('div', {
        className: 'dsh-washer',
        ref: washerRootRef,
        'data-state': state,
        'data-level': 'S',
        'data-variant': variant,
        'data-reduce-motion': reduceMotionFlag(),
      }, strip);
    }

    /* ------------------------------------------------------------------ *
     * 设置页（settings.section）
     *
     * 手编 cordis.patch.yml 不是普通用户能干的事，这里给一个真正的设置面板。
     * 写路径走 localStorage（不用 ctx.configForms 的原因见下方 apply 内注释），
     * 读路径 = 默认配置 ← 插件行 config ← localStorage 里的用户改动。
     * ------------------------------------------------------------------ */
    function WasherSettings(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const tr = (key) => t(key);
      const cfg = (typeof props.washerGetConfig === 'function' ? props.washerGetConfig() : props.washerConfig) || DEFAULT_CONFIG;
      usePrefRevision(props);
      const setPref = (key, value) => {
        if (typeof props.washerSetPref === 'function') props.washerSetPref(key, value);
      };

      /*
       * 一行 = 左（标题，必要时带说明）+ 右（控件）。
       * 这是宿主官方设置页的结构（ui-settings-general 的 DeveloperToolsRow）：
       * 行用 flex + space-between，标签占左边，控件贴右边。
       * 以前标签是普通 span 直接排在 div 里，没有 flex，所以全挤成一片。
       */
      const row = (labelKey, control) => h('div', { className: 'dw-set-row' },
        h('span', { className: 'dw-set-label' }, tr(labelKey)),
        h('span', { className: 'dw-set-control' }, control));

      /* 真正的 iOS 风格开关（role="switch"）。
         为什么不用分段按钮：设置页里一排小方块图形上还是"文字按钮"，用户要的是明确的开/关。
         轨道 + 滑块都用内联样式画，不依赖 className 命中——宿主的设置页容器会覆盖
         button 的 border/background（实测算出来 border 0px、透明背景），靠 class 样式不可靠。 */
      // 注意：设置页挂在 settings.section 里，**不在** .dsh-washer 范围内，
      // 所以拿不到插件自己的 --dw-* 变量（实测 --dw-run 算出空串）。而 var(--x, fallback)
      // 只在"变量无效"时回退，空串算"已定义"，于是整条背景色失效、开关变成透明方块。
      // 这里直接用宿主 token，并且不再套一层自家变量。
      /*
       * 选中态主色。原来用 state-business-primary（深蓝 #4176e6），
       * 和宿主设置页其它控件对不上——用户反馈"选择按钮得是黑色"。
       * 宿主自己的激活态（勾选框、页面 tab 下划线）用的是 label-primary，
       * 浅色主题下是 #0f1115（近黑），深色主题下自动翻成浅色。
       * 跟着它走就和整套设置页一致了。
       */
      const BRAND = 'var(--dsw-alias-label-primary)';
      const BRAND_FG = 'var(--dsw-alias-label-primary-inverted)';
      const LINE = 'var(--dsw-alias-border-l1)';
      const sw = (key, on, ariaLabel) => h('button', {
        key,
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': ariaLabel,
        className: 'dw-switch',
        'data-on': on ? '1' : '0',
        style: {
          position: 'relative',
          display: 'inline-block',
          flex: '0 0 auto',
          width: '40px',
          height: '22px',
          padding: '0',
          border: '0',
          borderRadius: '11px',
          background: on ? BRAND : LINE,
          cursor: 'pointer',
          transition: 'background-color 0.18s ease',
          verticalAlign: 'middle',
        },
        onClick: () => setPref(key, !on),
      }, h('span', {
        'aria-hidden': 'true',
        style: {
          position: 'absolute',
          top: '2px',
          left: on ? '20px' : '2px',
          width: '18px',
          height: '18px',
          borderRadius: '50%',
          // 宿主自己的开关滑块色；写死 #fff 在深色主题下会突兀
          background: 'var(--dsw-alias-switch-thumb, #fff)',
          boxShadow: '0 1px 2px rgba(0,0,0,.28)',
          transition: 'left 0.18s cubic-bezier(.32,.72,0,1)',
        },
      }));

      /* 少数只能多选一的项（皮肤 / 初始档位）保留成"胶囊按钮"，
         同样内联样式，选中态用实心色块——跟开关拉开视觉层次。 */
      const seg = (groupLabel, options, current, onPick) => h('span', {
        className: 'dw-seg', role: 'group', 'aria-label': groupLabel,
        style: { display: 'inline-flex', gap: '4px', flexWrap: 'wrap' },
      }, options.map(([value, text]) => {
        const on = String(current) === String(value);
        return h('button', {
          key: groupLabel + '-' + value,
          type: 'button',
          className: 'dw-seg-btn',
          'data-on': on ? '1' : '0',
          'aria-pressed': on ? 'true' : 'false',
          style: {
            appearance: 'none',
            border: '1px solid ' + (on ? BRAND : LINE),
            background: on ? BRAND : 'transparent',
            // 选中态底色是黑（深色主题是白），字必须反着来，不能写死 #fff
            color: on ? BRAND_FG : 'var(--dsw-alias-label-secondary)',
            borderRadius: '999px',
            padding: '4px 11px',
            font: 'inherit',
            fontSize: '11px',
            lineHeight: '1.3',
            fontWeight: on ? '600' : '400',
            cursor: 'pointer',
            transition: 'background-color .14s ease, color .14s ease, border-color .14s ease',
          },
          onClick: () => onPick(value),
        }, text);
      }));

      return h('div', { className: 'dw-settings' },
        h('h3', { className: 'dw-set-title' }, tr('set.title')),
        h('p', { className: 'dw-set-intro' }, tr('set.intro')),

        row('set.hideIdle', sw('hideWhenIdle', cfg.hideWhenIdle === true, tr('set.hideIdle'))),

        row('label.skin', seg(tr('label.skin'), [
          ['precision', tr('skin.precision')],
          ['anime', tr('skin.anime')],
          ['pixel', tr('skin.pixel')],
        ], cfg.skin, (value) => setPref('skin', value))),
        h('p', { className: 'dw-set-hint' }, tr('set.skinHint')),

        h('h4', { className: 'dw-set-sub' }, tr('set.overlay')),
        h('p', { className: 'dw-set-hint' }, tr('set.overlayHint')),
        row('set.overlayOn', sw('desktopOverlay', cfg.desktopOverlay === true, tr('set.overlayOn'))),
        row('set.overlaySize', seg(tr('set.overlaySize'), [
          ['normal', tr('ov.normal')],
          ['tiny', tr('ov.tiny')],
        ], cfg.desktopOverlaySize === undefined ? 'normal' : cfg.desktopOverlaySize,
        (value) => setPref('desktopOverlaySize', value))),
        h('p', { className: 'dw-set-hint' }, tr('set.overlaySizeHint')),
        row('set.overlayThrough',
          sw('desktopOverlayClickThrough', cfg.desktopOverlayClickThrough === true, tr('set.overlayThrough'))),
        h('p', { className: 'dw-set-hint' }, tr('set.overlayThroughHint')),
        h('p', { className: 'dw-set-hint' }, tr('set.restartHint')));
    }

    /* ------------------------------------------------------------------ *
     * overlay 座位（mode:'overlay'）
     *
     * shell.overlay 是 frame 级浮层，拿不到 sessionId / useChat / useProjection
     * （标准 props 只有 useSessions + useSessionStatus），因此这里只做**最轻的一层**：
     *   - 从 useSessions 里找当前主视图会话（宿主 ui-layout 的官方写法）
     *   - 只读 running + pendingInteraction，只渲染一张停靠条
     * 想看完整卡片请用默认的 dock 模式。
     * ------------------------------------------------------------------ */
    function WasherOverlay(props) {
      const { useSessions, useSessionStatus } = props;
      const cfg = (typeof props.washerGetConfig === 'function' ? props.washerGetConfig() : props.washerConfig) || DEFAULT_CONFIG;
      usePrefRevision(props);
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const tr = (key) => t(key);

      // 与宿主 DocumentTitle 同一套取法：retainedBy.mainView > 0 的那个就是当前会话
      const sessionId = useSessions((state) => {
        const current = Object.values(state.byId).find((session) => (session.retainedBy.mainView ?? 0) > 0);
        return current === undefined ? undefined : current.id;
      });
      const running = useSessions((state) => {
        if (sessionId === undefined) return false;
        const row = state.byId[sessionId];
        return row !== undefined && row.running === true;
      });
      const pending = useSessionStatus((status) => {
        if (sessionId === undefined || status === undefined) return undefined;
        const row = status.get(sessionId);
        return row === undefined ? undefined : row.pendingInteraction;
      });

      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        if (running !== true) return undefined;
        const id = setInterval(() => setTick((n) => n + 1), 1000);
        return () => clearInterval(id);
      }, [running]);

      if (cfg.enabled === false) return null;
      if (sessionId === undefined) return null;
      if (pending !== undefined) return null;           // 等你确认由 composer 区自己说
      // 浮层会盖住内容，空闲时不该出现。这是浮层独有的默认，
      // 不复用 hideWhenIdle（那个在 dock 下默认 false，语义相反）。
      if (running !== true && cfg.overlayOnlyWhenBusy !== false) return null;

      const state = 'washing';                           // 浮层不推导细分阶段，只表示「在忙」
      const title = tr('state.washing');
      const sub = tr('overlay.running');

      return h('div', {
        className: 'dsh-washer dw-overlay-root',
        'data-state': state,
        'data-level': 'S',
        'data-variant': 'overlay',
        'data-reduce-motion': reduceMotionFlag(),
      },
      h('button', {
        type: 'button',
        className: 'dw-strip',
        'aria-label': tr('label.washer') + ': ' + title + ' · ' + sub,
      },
      PixelSprite(state),
      h('span', { className: 'dw-text' },
        h('span', { className: 'dw-t1' }, title),
        h('span', { className: 'dw-t2' }, sub))));
    }

    /* ------------------------------------------------------------------ *
     * CSS：带 data-plugin / data-plugin-css 两个标记，卸载时由框架按归属清理
     * ------------------------------------------------------------------ */
    function ensureStyles() {
      if (typeof document === 'undefined') return;
      const tagId = 'dsh-washer/washer.css';
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-washer';
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ------------------------------------------------------------------ *
     * 插件
     * ------------------------------------------------------------------ */
    return {
      name: 'dsh-washer',
      // 只要 slots 与 locale：配置改动存 localStorage，不再依赖 configForms。
      inject: ['slots', 'locale'],
      /**
       * 默认值清单。客户端合并配置的骨架就是它，
       * 测试也拿它钉「设置页能写的字段一个都不能漏」：
       * 漏了的字段在骨架里没有格子，设置页读出来就是 undefined，
       * "从没配过"和"用户亲手关了"就分不出来了。
       */
      __defaults: DEFAULT_CONFIG,
      apply(ctx, config) {
        const cfg = mergeConfig(config);
        ensureStyles();

        // ---------- 偏好持久化 ----------
        //
        // 为什么不用 ctx.configForms：那套 store 只服务挂在 loader `include` 行下的
        // 插件（dsh-config-editor 的 entries() 硬过滤 `fiber.entry?.id === "include"`）。
        // 第三方 bundle 走的是 `insert`，parent 不是 include，所以 describe 不会带
        // 上它，控制器永远停在 `status: 'unavailable'`——写进去也读不回来。
        // 同一路子 dsh-better-sidebar 也是绕开 configForms、自己存 localStorage。
        //
        // 语义：
        //   - 默认值 = cordis.patch.yml 的 config（由插件行传进来，mergeConfig 兜底）
        //   - 用户在设置页/卡片里改的值 → localStorage，覆盖默认值
        //   - 多个座位的组件共享同一份 pref，靠订阅同步
        const PREF_KEY = 'dsh-washer:prefs';
        const prefs = {};
        const prefListeners = new Set();
        const storage = (() => {
          try {
            if (typeof localStorage === 'undefined') return null;
            // 隐私模式 / 被禁用时 setItem 会抛，先探一次
            localStorage.setItem('dsh-washer:probe', '1');
            localStorage.removeItem('dsh-washer:probe');
            return localStorage;
          } catch { return null; }
        })();
        try {
          const raw = storage === null ? null : storage.getItem(PREF_KEY);
          if (raw) Object.assign(prefs, JSON.parse(raw) || {});
        } catch { /* 坏数据就当没有 */ }

        const notifyPrefs = () => { for (const fn of prefListeners) { try { fn(); } catch { /* noop */ } } };
        const liveConfig = () => mergeConfig(Object.assign({}, config, prefs));
        const writePref = (key, value) => {
          if (prefs[key] === value) return;
          prefs[key] = value;
          try { if (storage !== null) storage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 存不了也要让本次生效 */ }
          notifyPrefs();
          syncOverlayPrefs(key, value);
        };

        /*
         * 悬浮窗的三个偏好要额外告诉宿主一声。
         *
         * 为什么不能只写 localStorage：悬浮窗是独立的 Electron 进程，它的主进程
         * 读不到浏览器的 localStorage。宿主把值落进偏好文件，浮窗主进程 watch
         * 那个文件后自己改窗口大小/换造型——否则用户改完设置得重启宿主才生效，
         * 看起来就是"设置改了没反应"。
         *
         * 失败不打扰用户：设置本身已经在 localStorage 里生效了，只是浮窗要等下次启动。
         */
        /*
         * 只有两项往返同步：显不显示、浮窗大小。
         *
         * 皮肤曾经也在这里（desktopOverlaySkin ↔ skin），合并成单一 skin 后
         * 它仍然要同步，但走的不是这条通道——skin 是本地偏好，改它时
         * writePref 会额外把值推给宿主，见下方 syncSkinToOverlay。
         */
        const OVERLAY_PREF_KEYS = {
          desktopOverlay: 'show',
          desktopOverlaySize: 'size',
          /*
           * 鼠标穿透从浮窗的双击挪到设置页。
           * 双击进穿透原本是浮窗上唯一的鼠标入口，但用户要求"整个机器都能拖"——
           * Chromium 的拖拽区（-webkit-app-region: drag）会吞掉 dblclick，
           * 两者不能共存。于是拖拽优先，穿透改由设置页开关控制。
           */
          desktopOverlayClickThrough: 'clickThrough',
          /*
           * skin 现在同时是主界面皮肤和浮窗造型，所以改它必须推一份给宿主，
           * 否则浮窗要等下次重启才换。反方向由 SSE 回灌（见 applyRemotePrefs）。
           */
          skin: 'skin',
        };
        /** 宿主用 ctx.webServer 注册的同源路由，页面直接相对路径请求即可。 */
        const OVERLAY_PREFS_PATH = '/dsh-washer/prefs';
        /*
         * 注意：这里必须用**同源相对路径**。
         *
         * 之前写成 props.washerEndpoint().url + 拼 token —— 那个注入项在客户端
         * 插件里根本不存在，首行就 return，POST 一次都没发出去，功能看着写了
         * 实际静默不工作。宿主那边已经用 ctx.webServer 注册了同源路由
         * /dsh-washer/prefs，页面和它是同一个 origin，直接相对路径打过去即可：
         * 不用端口、不用 token、不受 connect-src 的 CSP 限制。
         */
        const syncOverlayPrefs = (key, value) => {
          const field = OVERLAY_PREF_KEYS[key];
          if (field === undefined) return;
          try {
            fetch(OVERLAY_PREFS_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ [field]: value }),
            }).catch(() => { /* 宿主没接这条路就算了，不影响设置本身 */ });
          } catch { /* 同上 */ }
        };
        // 组件一律通过 washerGetConfig() 现取，而不是吃 inject 给的快照：
        // inject 回调只在注册时跑一次，重渲染不会重新求值。
        const subscribePrefs = (fn) => {
          prefListeners.add(fn);
          return () => { prefListeners.delete(fn); };
        };

        /*
         * ---------------- 悬浮窗偏好：反方向同步 ----------------
         *
         * 到此为止全是「设置页 → 悬浮窗」：页面写 localStorage，再 POST 给宿主，
         * 宿主落文件，Electron 主进程 watch 文件改窗口。
         *
         * 缺的一半是反过来的：用户在悬浮窗右键菜单里换造型/切极简，
         * 那个改动只到 Electron 主进程和偏好文件。设置页读的是 localStorage，
         * **没有任何东西告诉它变了**——于是两边长期不一致，要手动刷新页面
         * 才"看起来"同步上。
         *
         * 现在补上：
         *   1) 打开设置页时先从宿主拉一次当前值（偏好文件才是真相源，
         *      localStorage 只是缓存，它不知道右键菜单里改过什么）
         *   2) 长连 SSE，宿主只要推过来就合并进 prefs 并重渲染
         */
        const OVERLAY_PREFS_EVENTS_PATH = '/dsh-washer/prefs/events';

        /**
         * 把宿主给的字段并进本地 prefs。
         *
         * 只认认识的字段、只做覆盖不删除：宿主那边少了某个 key 不代表
         * 用户要清空它，多半只是从没写过。返回值表示到底有没有变化，
         * 没变化就不重渲染，免得 SSE 心跳把整页刷一遍。
         */
        const applyRemotePrefs = (remote) => {
          if (remote === null || typeof remote !== 'object') return;
          // skin 从浮窗菜单改也要回灌到主界面皮肤，所以反向映射保留 skin → skin
          const REVERSE = {
            show: 'desktopOverlay', size: 'desktopOverlaySize', skin: 'skin',
            clickThrough: 'desktopOverlayClickThrough',
          };
          let changed = false;
          for (const field of Object.keys(REVERSE)) {
            if (remote[field] === undefined) continue;
            const key = REVERSE[field];
            let value = remote[field];
            // 本地字段名和文件字段名眼瞅着一样，但类型不同：
            // 文件里 size 是 'tiny'/'normal'，页面里是 desktopOverlaySize
            if ((key === 'desktopOverlay' || key === 'desktopOverlayClickThrough') && typeof value !== 'boolean') continue;
            if (prefs[key] === value) continue;
            prefs[key] = value;
            changed = true;
          }
          if (!changed) return;
          try { if (storage !== null) storage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 存不了也要让本次生效 */ }
          notifyPrefs();
        };

        /** 拉一次当前值。失败静默——宿主没起时页面照样能用旧的 localStorage 值。 */
        const pullOverlayPrefs = () => {
          try {
            fetch(OVERLAY_PREFS_PATH, { headers: { accept: 'application/json' } })
              .then((r) => (r.ok ? r.json() : null))
              .then((data) => applyRemotePrefs(data))
              .catch(() => { /* 宿主没接这条路就算了 */ });
          } catch { /* 同上 */ }
        };

        /*
         * 长连 SSE。EventSource 断线会自己重连（默认 3 秒左右），
         * 所以不用写重试逻辑；页面关掉时 EventSource 随文档销毁。
         *
         * 为什么不用 WebSocket：那是给 Electron 用的、带 token 的端口，
         * 页面这边同源 HTTP 就够，还不用碰 CSP 的 connect-src 名单。
         */
        let prefEvents = null;
        const startPrefEvents = () => {
          if (prefEvents !== null) return;
          if (typeof EventSource === 'undefined') {
            // 极老的浏览器没有 EventSource：退化成只拉一次，至少打开时不显示旧值
            pullOverlayPrefs();
            return;
          }
          try {
            prefEvents = new EventSource(OVERLAY_PREFS_EVENTS_PATH);
          } catch {
            prefEvents = null;
            return;
          }
          prefEvents.addEventListener('message', (event) => {
            try { applyRemotePrefs(JSON.parse(event.data)); } catch { /* 坏帧跳过，等下一帧 */ }
          });
          // error 事件里不用做任何事：EventSource 自己会重连。
          // 真正断网时它会一直重试，这正是想要的——用户切回来就自动恢复。
        };

        ctx.effect(() => {
          pullOverlayPrefs();
          startPrefEvents();
          return () => {
            if (prefEvents !== null) { try { prefEvents.close(); } catch { /* noop */ } prefEvents = null; }
          };
        }, 'dsh-washer: overlay prefs sync');

        /*
         * ---------------- 明暗主题 → 悬浮窗 ----------------
         *
         * 目的：浮窗（独立 Electron 页面）的明暗要和 dock 一样，跟随宿主 GUI。
         *
         * 走过两次弯路（都有真机证据）：
         *   1) 靠 documentElement 上有没有 data-ds-dark-theme 属性——不生效。
         *   2) 只从 html/documentElement 读设计 token——拿到空串，一次都推不出去。
         *
         * 根因（从宿主 app.asar 里的 design_platform_css 读到的铁证）：
         * 宿主的设计 token 和暗色开关**全挂在 body 上**，html 上什么都没有：
         *   body{--dsw-alias-bg-layer-1:...; background-color:var(--dsw-alias-bg-base)}
         *   body[data-ds-dark-theme]{--dsw-alias-bg-layer-1:...暗色值}
         *
         * 所以探测按可靠度从高到低：
         *   1) body[data-ds-dark-theme] —— 宿主自己的暗色开关（它的 CSS 选择器
         *      用的就是这个属性），最权威；
         *   2) body 计算后的 background-color —— 宿主直接写好了绝对色；
         *   3) 设计 token --dsw-alias-bg-layer-1 / --dsw-alias-bg-base。
         * 插件也可能跑在没有宿主样式的表面里（读不到任何东西），此时返回
         * null——宁可不改浮窗，也不瞎猜。
         *
         * 触发时机有三条，覆盖全部换主题路径：
         *   1) 挂载时读一次；
         *   2) MutationObserver 盯 documentElement / body 的 class/style/属性变化；
         *   3) prefers-color-scheme 媒体查询变化（跟随系统主题的场景）。
         * 三条都只调同一个 pushTheme，重复推送是幂等的（宿主侧比对后不重复写）。
         */
        const THEME_BG_TOKEN = '--dsw-alias-bg-layer-1';
        const THEME_BG_TOKEN_ALT = '--dsw-alias-bg-base';

        /** body / html 上有没有宿主的暗色开关属性；没有该方法或不支持时返回 false。 */
        const hasDarkAttr = (el) => {
          if (el === null || el === undefined || typeof el.hasAttribute !== 'function') return false;
          try { return el.hasAttribute('data-ds-dark-theme') === true; } catch { return false; }
        };

        /**
         * 把 "rgb(r, g, b)" / "rgba(...)" / "#rgb" / "#rrggbb" 解析成亮度 0..1。
         * 解析不了、或 alpha < 0.5（比如 getComputedStyle 的默认透明黑
         * rgba(0,0,0,0)——它不是"黑"，是"没画"）返回 null。
         * 用相对的感知亮度（sRGB 加权），比简单平均更贴近人眼对明暗的判断。
         */
        const parseBrightness = (color) => {
          if (typeof color !== 'string') return null;
          const text = color.trim();
          let r, g, b, a = 1;
          let m = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i);
          if (m !== null) {
            r = Number(m[1]); g = Number(m[2]); b = Number(m[3]);
            if (m[4] !== undefined) {
              a = m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
            }
          } else if ((m = text.match(/^#([0-9a-f]{3})$/i)) !== null) {
            const h = m[1];
            r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16);
          } else if ((m = text.match(/^#([0-9a-f]{6})$/i)) !== null) {
            r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16);
          } else {
            return null;
          }
          if (![r, g, b, a].every((v) => Number.isFinite(v))) return null;
          if (a < 0.5) return null; // 透明色不算数，避免把"没画背景"误判成纯黑
          return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        };

        /** 单个元素上取亮度：先算好的背景色，再设计 token；拿不到返回 null。 */
        const readBrightnessFrom = (el) => {
          if (el === null || el === undefined || typeof getComputedStyle !== 'function') return null;
          try {
            const style = getComputedStyle(el);
            const bg = parseBrightness(style.backgroundColor);
            if (bg !== null) return bg;
            for (const token of [THEME_BG_TOKEN, THEME_BG_TOKEN_ALT]) {
              const v = parseBrightness(style.getPropertyValue(token));
              if (v !== null) return v;
            }
          } catch { /* 这个元素读不了，换下一个 */ }
          return null;
        };

        /** 宿主现在是不是暗色；环境里读不出主题（无属性也无颜色）时返回 null。 */
        const readIsDark = () => {
          try {
            const body = typeof document !== 'undefined' ? document.body : null;
            const rootEl = typeof document !== 'undefined' ? document.documentElement : null;
            // 1) 宿主自己的暗色开关（body[data-ds-dark-theme] 用的就是它）
            if (hasDarkAttr(body) || hasDarkAttr(rootEl)) return true;
            // 2) 没挂开关就看颜色：token 和背景色全挂在 body 上，先试 body
            const fromBody = readBrightnessFrom(body);
            if (fromBody !== null) return fromBody < 0.5;
            const fromRoot = readBrightnessFrom(rootEl);
            if (fromRoot !== null) return fromRoot < 0.5;
            return null;
          } catch { return null; }
        };

        /* 上一次推过的值：避免观察器在每次无关的 DOM 变化上都发请求 */
        let lastPushedDark = null;
        let lastPushedProbe = null;

        /**
         * 诊断用：描述"这次探测到底看见了什么"，随 dark 一起落盘。
         *
         * 排查"切了主题浮窗不动"时，只看 dark 布尔值无法区分"读到了浅色"
         * 和"根本没读到东西"——曾经因为这个把"探测正常工作"误判成
         * "残留旧值"，白白多折腾一轮。这个字段必须和 readIsDark 看同一批
         * 信源，否则又是撒谎的诊断。
         */
        const describeProbe = () => {
          try {
            const body = typeof document !== 'undefined' ? document.body : null;
            const rootEl = typeof document !== 'undefined' ? document.documentElement : null;
            if (hasDarkAttr(body)) return 'attr:body[data-ds-dark-theme]';
            if (hasDarkAttr(rootEl)) return 'attr:html[data-ds-dark-theme]';
            if (typeof getComputedStyle === 'function') {
              if (body !== null && body !== undefined) {
                const style = getComputedStyle(body);
                const bg = String(style.backgroundColor || '').trim();
                if (parseBrightness(bg) !== null) return 'body.bg=' + bg;
                const token = String(style.getPropertyValue(THEME_BG_TOKEN) || '').trim();
                if (token !== '') return 'body' + THEME_BG_TOKEN + '=' + token;
              }
              if (rootEl !== null && rootEl !== undefined) {
                const token = String(getComputedStyle(rootEl).getPropertyValue(THEME_BG_TOKEN) || '').trim();
                if (token !== '') return 'html' + THEME_BG_TOKEN + '=' + token;
              }
            }
            return '(no attr, no color)';
          } catch { return '(probe error)'; }
        };

        const pushTheme = () => {
          const dark = readIsDark();
          const probe = describeProbe();
          // 去重：同结果只发一次；读到 null 时跟着 probe 的变化走
          if (dark !== null && dark === lastPushedDark) return;
          if (dark === null && probe === lastPushedProbe) return;
          lastPushedDark = dark;
          lastPushedProbe = probe;
          try {
            const payload = dark === null ? { darkProbe: probe } : { dark, darkProbe: probe };
            fetch(OVERLAY_PREFS_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            }).catch(() => { lastPushedDark = null; lastPushedProbe = null; /* 失败下次重试 */ });
          } catch { lastPushedDark = null; lastPushedProbe = null; }
        };

        ctx.effect(() => {
          pushTheme();
          const disposers = [];
          if (typeof MutationObserver !== 'undefined') {
            try {
              const observer = new MutationObserver(() => pushTheme());
              observer.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ['class', 'style', 'data-ds-dark-theme'],
              });
              if (document.body !== null && document.body !== undefined) {
                observer.observe(document.body, {
                  attributes: true,
                  attributeFilter: ['class', 'style', 'data-ds-dark-theme'],
                });
              }
              disposers.push(() => { try { observer.disconnect(); } catch { /* noop */ } });
            } catch { /* 观察不到就只靠挂载时那一次 */ }
          }
          if (typeof matchMedia === 'function') {
            try {
              const mq = matchMedia('(prefers-color-scheme: dark)');
              const onChange = () => pushTheme();
              if (typeof mq.addEventListener === 'function') {
                mq.addEventListener('change', onChange);
                disposers.push(() => { try { mq.removeEventListener('change', onChange); } catch { /* noop */ } });
              } else if (typeof mq.addListener === 'function') {
                mq.addListener(onChange);
                disposers.push(() => { try { mq.removeListener(onChange); } catch { /* noop */ } });
              }
            } catch { /* 老浏览器没有 matchMedia 就算了 */ }
          }
          return () => { disposers.forEach((off) => { try { off(); } catch { /* noop */ } }); };
        }, 'dsh-washer: theme -> overlay');

        // 测试用把手：拉取发生在 apply() 里，比任何用例都早，而且前面几条
        // 推送用例会把 fetch 记录清空——想断言"打开时会拉一次"就没法看全程了。
        // 暴露出来让测试能开一个明确的观察窗口。
        if (typeof globalThis === 'object' && globalThis !== null) {
          globalThis.__pullOverlayPrefs = pullOverlayPrefs;
        }

        // 同一命名空间重复注册同语言会抛错（HMR / 重复挂载），逐个容错
        ctx.effect(() => {
          const disposers = [];
          for (const [locale, dict] of [['zh', ZH], ['en', EN]]) {
            try {
              disposers.push(ctx.locale.register(LOCALE_NS, locale, dict));
            } catch (error) {
              console.warn('[dsh-washer] locale register skipped:', locale, error);
            }
          }
          return () => { disposers.forEach((off) => { try { off(); } catch { /* noop */ } }); };
        }, 'dsh-washer: locale dictionaries');

        if (cfg.enabled === false) return;

        // 设置页：不管 dock / overlay 都要有入口
        const offSettings = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'washer',
          order: 80,
          label: (typeof ctx.locale.bind === 'function' ? (ctx.locale.bind(LOCALE_NS)('set.nav')) : '洗衣机'),
          locale: LOCALE_NS,
          registrant: 'dsh-washer',
          inject: () => ({ washerGetConfig: liveConfig, washerSetPref: writePref, washerSubscribePrefs: subscribePrefs }),
        }, WasherSettings));
        ctx.effect(() => () => {
          try { offSettings(); } catch { /* noop */ }
        }, 'dsh-washer: settings section');

        // mode:'overlay' → 改用 frame 级浮层，不占用输入框位置。
        if (cfg.mode === 'overlay') {
          const offOverlay = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: ENTRY_ID,
            order: 40,
            locale: LOCALE_NS,
            registrant: 'dsh-washer',
            inject: () => ({ washerGetConfig: liveConfig, washerSubscribePrefs: subscribePrefs }),
          }, WasherOverlay));
          ctx.effect(() => () => {
            try { offOverlay(); } catch { /* noop */ }
          }, 'dsh-washer: overlay occupant');
          return;
        }

        // 主座位：composer.dock 紧贴输入框，是默认位置。
        const slotName = 'conversation.composer.dock';
        const offDock = ctx.slots.inject(slotName, () => ctx.slots.register({
          name: slotName,
          id: ENTRY_ID,
          /*
           * order 用负数：这一行（conversation.composer.dock）里宿主自己还注册了两个
           * 药丸——activity「性能与用量」(order 0) 和 usage「上下文使用量」(order 1)。
           * 我们原先写 order:10，于是永远排在他俩右边。用户要求放在「性能与用量」左侧，
           * 必须排到所有宿主药丸之前，所以用 -10（留给未来宿主加负数项的空间）。
           */
          order: -10,
          locale: LOCALE_NS,
          registrant: 'dsh-washer',
          inject: () => ({ washerGetConfig: liveConfig, washerVariant: 'dock', washerSetPref: writePref, washerSubscribePrefs: subscribePrefs }),
        }, WasherDock));

        // 替补座位：审批/提问时宿主接管整个 composer，dock 会随之 display:none。
        // header 座位在同一时刻顶上来，保证「等你确认」这一格永远看得见。
        const offHeader = ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: ENTRY_ID + '-waiting',
          order: 60,
          locale: LOCALE_NS,
          registrant: 'dsh-washer',
          inject: () => ({ washerGetConfig: liveConfig, washerVariant: 'header', washerSubscribePrefs: subscribePrefs }),
        }, WasherDock));

        ctx.effect(() => () => {
          try { offHeader(); } catch { /* noop */ }
          try { offDock(); } catch { /* noop */ }
        }, 'dsh-washer: slot occupants');
      },
    };
  },
});

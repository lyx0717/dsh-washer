/**
 * dsh-washer 的 Host 半（P1b：桌面悬浮窗的数据管道）。
 *
 * 为什么 Host 侧要重算一遍状态：
 * 浏览器端的 deriveState 吃的是 useChat / useProjection 这些客户端投影，
 * 桌面悬浮窗（独立 Electron 进程）根本拿不到。所以这里用宿主公开的
 * 事件流（session/event + agent/status）重建同一份输入，再喂给**同一个**
 * 纯函数 deriveState —— 两边共用状态核心，不各写一套判定。
 *
 * 服务形态：本地 HTTP + WebSocket，只监听 127.0.0.1。
 *   GET  /dsh-washer/state   当前快照（JSON）
 *   GET  /dsh-washer/health  存活探针
 *   WS   /dsh-washer/stream  状态变化实时推送
 *
 * 安全：只绑回环地址，且带一个进程级随机 token；请求必须带
 * `?token=` 或 `Authorization: Bearer`，防止本机其它程序偷看会话状态。
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  deriveState,
  recentTools,
  toolCountOf,
  errorCodeOf,
  elapsedOf,
  turnEndTimeOf,
  latestTurnOf,
  formatDuration,
} from './src/core.js';

export const name = 'dsh-washer';

/** 宿主服务：agents 提供 agent/status，sessions 提供事件序号与 flush */
export const inject = ['agents', 'sessions'];

/** 默认端口。0 = 让系统分配，避免和别的程序抢端口。 */
const DEFAULT_PORT = 0;
/** 推送节流：一个 turn 里状态可能高频变化，100ms 够顺滑又不刷屏。 */
const PUSH_THROTTLE_MS = 100;

/* ------------------------------------------------------------------ *
 * 事件 → deriveState 输入
 *
 * 浏览器的 useChat 会给出 runningCalls / partial / nodes / turnTimings 这四样，
 * 这里从 session/event 自己攒。每个会话一份，结构对齐 core.js 的期望。
 * ------------------------------------------------------------------ */

function createSessionState() {
  return {
    /** 当前活跃的 turn 号（0 = 还没有） */
    turn: 0,
    /** 已发起的工具调用，等 tool/result 来消账 */
    runningCalls: [],
    /** 模型正在流式输出时的占位（非 null 即表示「在出字」） */
    partial: null,
    /** 最近的节点序列，用于判断 step 位置 */
    nodes: [],
    /** callId → { at, name }：tool/result 不带 name/起点时用来补全流水耗时 */
    callStartedAt: new Map(),
    /** { [turn]: { start, end } } */
    turnTimings: {},
    /** 最近一次 agent/status */
    running: false,
  };
}

function pushNode(state, node) {
  state.nodes.push(node);
  // 只留最近 200 条：deriveState 只看当前 turn 的末尾，留太多白占内存
  if (state.nodes.length > 200) state.nodes.splice(0, state.nodes.length - 200);
}

/**
 * 把一条 session/event 折叠进会话状态。
 *
 * 事件名与载荷来自 @deepseek-ai/dsh-agent-loop：
 *   turn/start  { turn }
 *   step/start  { turn, step }
 *   tool/call   { turn, step, callId, name, arguments }
 *   tool/result { turn, step, callId, ... }
 *   step/end    { turn, step }
 *   turn/end    { turn }
 */
export function foldEvent(state, event, now) {
  const data = event && event.data ? event.data : {};
  const type = event ? event.type : undefined;

  switch (type) {
    case 'turn/start': {
      const turn = typeof data.turn === 'number' ? data.turn : state.turn + 1;
      state.turn = turn;
      state.partial = null;
      state.runningCalls = [];
      state.callStartedAt.clear();
      state.turnTimings[turn] = { start: now };
      // 新 turn 开始，旧节点不再参与「这一步走到哪」的判定
      state.nodes = [];
      pushNode(state, { kind: 'turn-start', turn });
      return state;
    }
    case 'tool/call': {
      const call = {
        name: typeof data.name === 'string' ? data.name : 'tool',
        callId: data.callId === undefined ? '' : String(data.callId),
      };
      if (typeof data.turn === 'number') call.turn = data.turn;
      if (typeof data.step === 'number') call.step = data.step;
      state.runningCalls.push(call);
      state.callStartedAt.set(call.callId, { at: now, name: call.name });
      state.partial = null;
      pushNode(state, { kind: 'tool-call', turn: data.turn, name: call.name, callId: call.callId });
      return state;
    }
    case 'tool/result': {
      // 真实事件里 callId 藏在 message 里，不在 data 顶层：
      //   data = { turn, step, message: { role, source:{ kind, callId }, toolCallId, content, isError } }
      // 取错的话 callId 匹配不上，会走"弹掉最早那个"的兜底，
      // 导致工具名对不上号、耗时也算错。
      const rawCallId = data.callId !== undefined
        ? data.callId
        : (data.message && (data.message.toolCallId !== undefined
            ? data.message.toolCallId
            : data.message.source && data.message.source.callId));
      const callId = rawCallId === undefined ? '' : String(rawCallId);
      // 按 callId 消账；callId 缺失时退化成弹掉最早那个，
      // 至少不会永远卡在 rinsing（状态撒谎比不显示更糟）。
      const index = state.runningCalls.findIndex((c) => c.callId === callId);
      const started = index >= 0 ? state.callStartedAt.get(state.runningCalls[index].callId) : undefined;
      if (index >= 0) {
        state.callStartedAt.delete(state.runningCalls[index].callId);
        state.runningCalls.splice(index, 1);
      } else if (state.runningCalls.length > 0) {
        const oldest = state.runningCalls.shift();
        state.callStartedAt.delete(oldest.callId);
      }
      state.partial = null;
      pushNode(state, {
        kind: 'tool-result',
        turn: data.turn,
        // tool/result 常不带 name，从调用侧补回来，否则流水里全叫 "tool"
        name: typeof data.name === 'string' && data.name !== '' ? data.name : (started && started.name) || 'tool',
        callId,
        // core.js 的 recentTools 认这两个字段算耗时，不是 ms
        ...started !== undefined ? { callTime: started.at } : {},
        time: now,
        isError: data.isError === true || data.error !== undefined
          || (data.message && data.message.isError === true),
      });
      return state;
    }
    /**
     * step/start 与 step/end **故意不入 nodes**。
     * core.js 的 deriveState 用「最后一个节点是不是 OUTPUT_NODE_KINDS」判断
     * 模型走到哪了；step-* 不在这个白名单里，一旦记进去，lastNodeOf 命中它
     * 就会被判成「这一轮还没产出东西」→ 状态倒退成 starting。
     * 实测：工具结果之后来一条 step/end，状态从 washing 掉回 starting。
     * 这两步只影响内部节拍，不改变「有没有产出」这个事实。
     */
    case 'step/start':
    case 'step/end': {
      return state;
    }
    case 'turn/end': {
      const turn = typeof data.turn === 'number' ? data.turn : state.turn;
      state.turn = turn;
      state.runningCalls = [];
      state.callStartedAt.clear();
      state.partial = null;
      if (state.turnTimings[turn] !== undefined && state.turnTimings[turn].end === undefined) {
        state.turnTimings[turn].end = now;
      }
      pushNode(state, { kind: 'turn-end', turn });
      return state;
    }
    default:
      return state;
  }
}

/** 这一轮有没有出过错（tool-result 带 isError 或 turn-error 节点） */
function hasError(nodes) {
  return lastErrorNode(nodes) !== undefined;
}

function lastErrorNode(nodes) {
  if (!Array.isArray(nodes)) return undefined;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (!node) continue;
    if (node.kind === 'tool-result' && node.isError === true) return node;
    if (node.kind === 'turn-error') return node;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * HTTP + WS
 * ------------------------------------------------------------------ */

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 极简 WebSocket 帧编码：只发文本、只支持单帧（状态快照远小于 64KB）。 */
export function encodeWsText(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    // 超大快照：不该发生，真发生了就丢掉，别让单条消息把连接搞乱
    return null;
  }
  header[0] = 0x81; // FIN + opcode=1 (text)
  return Buffer.concat([header, payload]);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 端点信息落地位置。
 *
 * 为什么需要这个文件：token 是启动时随机的，宿主日志走 Electron 管道不落盘，
 * 用户拿不到 token 就打不开调试页/桌面窗——安全做到了，可用性没了。
 * 折中：写到用户 home 下的 0600 文件，只有本机同一用户能读，进程退出即删。
 *
 * @returns {string}
 */
function endpointFile() {
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return join(home, '.dsh', 'dsh-washer-overlay.json');
}

/**
 * 删除端点文件时**必须先确认它是自己的**。
 *
 * 早期版本用模块级变量记路径，插件被重新加载时新旧两个实例会互相踩：
 * 旧实例的 disposer 后跑一步，就把新实例刚写的文件删了——服务还在跑，
 * 但用户找不到端口和 token 了。改成比对文件里的 pid + token。
 *
 * @param {number} port
 * @param {string} token
 */
function clearEndpointFile(port, token) {
  try {
    const file = endpointFile();
    if (!existsSync(file)) return;
    const info = JSON.parse(readFileSync(file, 'utf8'));
    // 不是自己写的就别动
    if (info.pid !== process.pid || info.token !== token || info.port !== port) return;
    rmSync(file, { force: true });
  } catch {
    // 尽力而为，删不掉也不该影响卸载流程
  }
}

function persistEndpoint(port, token) {
  try {
    const file = endpointFile();
    mkdirSync(dirname(file), { recursive: true });
    // 先写再改权限，避免文件在被 chmod 前的极短窗口里可被他人读
    // url 字段直接给全，省得人从 port/pid 里挑错一个（俩都是五位数，极易混）
    const url = 'http://127.0.0.1:' + port + '/dsh-washer/state?token=' + token;
    writeFileSync(
      file,
      JSON.stringify({ url, port, token, pid: process.pid }, null, 2),
      { mode: 0o600 },
    );
    chmodSync(file, 0o600);
  } catch {
    // 落盘失败不影响服务本身，只是用户得自己从别处拿 token
  }
}

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {};
  // 桌面悬浮窗默认关着——装了不看的人不该莫名多一个后台端口
  const enabled = cfg.desktopOverlay === true;

  /** sessionId → 会话状态 */
  const sessions = new Map();
  /** 当前主视图会话（取最近有事件的那个） */
  let currentSessionId = null;
  /** 已连接的 WS 客户端 */
  const clients = new Set();
  let port = 0;
  const token = randomBytes(24).toString('base64url');
  let lastPushed = '';
  let lastPushAt = 0;
  let pushTimer = null;

  function resolveSessionId(subject) {
    if (subject === undefined || subject === null) return null;
    if (typeof subject === 'string') return subject;
    if (typeof subject.id === 'string') return subject.id;
    if (typeof subject.sessionId === 'string') return subject.sessionId;
    return null;
  }

  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = createSessionState();
      sessions.set(sessionId, state);
    }
    return state;
  }

  /** 把 Host 侧攒的状态映射成 deriveState 的输入，产出给渲染端的快照 */
  function snapshot() {
    const sessionId = currentSessionId;
    const now = Date.now();
    if (sessionId === null) {
      return {
        version: 1,
        sessionId: null,
        state: 'off',
        turn: 0,
        elapsedMs: 0,
        durationText: '--:--',
        tools: [],
        toolCount: 0,
        tokenUsage: null,
        errorCode: null,
        lastEndedAt: null,
        updatedAt: now,
      };
    }
    const s = stateFor(sessionId);
    const outline = s.turn > 0 ? [{ turn: s.turn }] : [];
    const derived = deriveState({
      sessionId,
      running: s.running,
      pending: undefined, // 审批等待由宿主 pendingInteraction 给，Host 侧暂不订阅
      runningCalls: s.runningCalls,
      partial: s.partial,
      nodes: s.nodes,
      outline,
      trajectory: undefined,
      sticky: null,
      now,
    });

    const turn = latestTurnOf(outline);
    const elapsedMs = elapsedOf(s.turnTimings, turn, now) || 0;
    return {
      version: 1,
      sessionId,
      state: derived,
      turn,
      elapsedMs,
      durationText: formatDuration(elapsedMs),
      tools: recentTools(s.nodes, 6).map((t) => ({
        name: t.name,
        ms: t.ms === undefined ? null : t.ms,
        isError: t.isError === true,
      })),
      toolCount: toolCountOf(s.nodes, turn),
      tokenUsage: null,
      // errorCodeOf(null) 会返回 'E-00'，所以只在确实有错误节点时才问它
      errorCode: hasError(s.nodes) ? errorCodeOf(lastErrorNode(s.nodes)) : null,
      lastEndedAt: turnEndTimeOf(s.turnTimings, turn) || null,
      updatedAt: now,
    };
  }

  function pushNow() {
    const text = JSON.stringify(snapshot());
    if (text === lastPushed) return;
    lastPushed = text;
    const frame = encodeWsText(text);
    if (frame === null) return;
    for (const socket of clients) {
      try {
        socket.write(frame);
      } catch {
        clients.delete(socket);
      }
    }
  }

  /** 节流推送：连续工具调用时不让每条事件都走一遍序列化 */
  function schedulePush() {
    if (clients.size === 0) return;
    if (pushTimer !== null) return;
    const now = Date.now();
    const wait = Math.max(0, PUSH_THROTTLE_MS - (now - lastPushAt));
    pushTimer = setTimeout(() => {
      pushTimer = null;
      lastPushAt = Date.now();
      pushNow();
    }, wait);
    if (typeof pushTimer.unref === 'function') pushTimer.unref();
  }

  function authorized(req, url) {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      if (safeEqual(header.slice(7), token)) return true;
    }
    const query = url.searchParams.get('token');
    return query !== null && safeEqual(query, token);
  }

  function onUpgrade(req, socket) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/dsh-washer/stream' || !authorized(req, url)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + WS_MAGIC).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    clients.add(socket);
    // 连上先给一份当前快照，省得渲染端干等下一次变化
    const hello = encodeWsText(JSON.stringify(snapshot()));
    if (hello !== null) socket.write(hello);
    const drop = () => { clients.delete(socket); };
    socket.on('close', drop);
    socket.on('error', drop);
    // 这是单向推送通道，客户端帧一律忽略，但必须消费掉，否则 TCP 反压
    socket.on('data', () => {});
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!authorized(req, url)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (url.pathname === '/dsh-washer/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(snapshot()));
      return;
    }
    if (url.pathname === '/dsh-washer/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.on('upgrade', onUpgrade);

  if (enabled) {
    server.listen(cfg.desktopOverlayPort ?? DEFAULT_PORT, '127.0.0.1', () => {
      port = server.address().port;
      // token 随机、只在内存里，宿主日志又不落盘 —— 光打印的话用户根本拿不到，
      // 调试页等于打不开。落地一个 0600 的运行时文件，进程退出时删掉。
      persistEndpoint(port, token);
      // 把带 token 的调试地址打出来，否则用户拿不到 token，也就打不开调试页。
      // token 只进本机日志，不进任何网络响应。
      ctx.logger?.info?.(`[dsh-washer] overlay: http://127.0.0.1:${port}/dsh-washer/state?token=${token}`);
      // debug/ 不进 npm 分发（只在仓库里），装了包的人没有这个文件，
      // 所以只在文件确实存在时才打印，别给人一个打不开的链接。
      // index.js 就在包根目录，debug/ 是它的同级目录——别写成 ../debug（会跑出包外）
      const debugPage = new URL('./debug/overlay.html', import.meta.url);
      if (existsSync(debugPage)) {
        ctx.logger?.info?.(
          `[dsh-washer] debug page (浏览器直接打开): `
          + `file://${debugPage.pathname}?port=${port}&token=${token}`,
        );
      }
    });
    server.on('error', (error) => {
      ctx.logger?.warn?.(`[dsh-washer] overlay service failed: ${error.message}`);
    });
  }

  // ---------- 事件订阅 ----------
  ctx.on('session/event', (subject, event) => {
    const sessionId = resolveSessionId(subject);
    if (sessionId === null || !event) return;
    currentSessionId = sessionId;
    const state = stateFor(sessionId);
    const before = state.nodes;
    foldEvent(state, event, Date.now());
    // turn/end 之后 Agent 不再忙；其余事件说明这一轮还在跑。
    // 但重复投递（宿主重放、订阅重复）不该把已结束的轮又点成 running，
    // 否则状态会在 idle/done 之间抖。只有真正改变了状态的事件才翻转。
    if (event.type === 'turn/end') state.running = false;
    else if (event.type === 'turn/start') state.running = true;
    else if (state.running || state.nodes !== before) state.running = true;
    schedulePush();
  });

  ctx.on('agent/status', (payload) => {
    const status = payload && payload.status;
    const agent = payload && payload.agent;
    const sessionId = resolveSessionId(agent && agent.session ? agent.session : agent);
    if (sessionId === null) return;
    currentSessionId = sessionId;
    const state = stateFor(sessionId);
    state.running = status === 'running';
    schedulePush();
  });

  // 卸载：先断连接再关端口，顺序反了会让已连的悬浮窗挂在半开状态
  ctx.effect(() => () => {
    if (pushTimer !== null) clearTimeout(pushTimer);
    clearEndpointFile(port, token);
    for (const socket of clients) {
      try { socket.destroy(); } catch { /* noop */ }
    }
    clients.clear();
    if (server.listening) server.close();
  }, 'dsh-washer: overlay service');

  /** 给测试用的内省口（导出在 apply 之外拿不到，挂到闭包上） */
  return { port: () => port, snapshot };
}

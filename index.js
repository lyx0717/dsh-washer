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
import { existsSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  stalledForOf,
  stateWeight,
  typicalTurnMs,
  remainingOf,
  shouldSwitch,
  SWITCH_HOLD_MS,
  toolActionOf,
} from './src/core.js';

export const name = 'dsh-washer';

/**
 * 宿主服务：agents 提供 agent/status，sessions 提供事件序号与 flush，
 * webServer 用来挂一个同源路由给网页端写悬浮窗偏好。
 *
 * 为什么偏好要走 webServer 而不是自己那个带 token 的 HTTP 服务：
 * 网页端是宿主的同源页面，`fetch('/dsh-washer/prefs')` 是相对路径请求，
 * 不用知道端口、不用带 token、不受 connect-src 的 CSP 限制。
 * 自己那套 127.0.0.1:随机端口 + token 是给**独立 Electron 进程**用的，
 * 网页端根本没有那套凭据（之前想靠 props.washerEndpoint 拿，那注入项不存在，
 * 于是每次都在第一行静默 return，功能看着写了实际一次都没发出去）。
 */
export const inject = ['agents', 'sessions', 'webServer'];

/** 默认端口。0 = 让系统分配，避免和别的程序抢端口。 */
const DEFAULT_PORT = 0;
/** 推送节流：一个 turn 里状态可能高频变化，100ms 够顺滑又不刷屏。 */
const PUSH_THROTTLE_MS = 100;
/** 无事件时刷新时长的节拍（毫秒） */
const TICK_MS = 500;

/**
 * 宿主同源路由：网页端写悬浮窗偏好走的路径。
 * 网页端用 fetch('/dsh-washer/prefs') 相对路径请求，不需要端口和 token。
 */
const WEB_PREFS_PATH = '/dsh-washer/prefs';
/** 偏好请求体上限。就三个字段，4KB 已经非常宽松。 */
const PREF_BODY_LIMIT = 4096;
/**
 * 偏好变化推送（SSE）。悬浮窗右键菜单改了造型/尺寸，设置页要跟着变。
 *
 * 为什么是 SSE 不是 WebSocket：
 *   - 只需要服务端 → 浏览器单向推，SSE 天生就是这个
 *   - 走普通 HTTP，同源相对路径就能连，不用端口、不用 token、不过 CSP 的
 *     connect-src（EventSource 同源是允许的）
 *   - EventSource 断线自动重连，不用自己写重试
 * WebSocket 那边已经有一套带 token 的（给 Electron 用），别混。
 */
const WEB_PREFS_EVENTS_PATH = '/dsh-washer/prefs/events';
/** SSE 心跳。中间层（各种代理/休眠）会掐掉长时间无数据的连接。 */
const SSE_HEARTBEAT_MS = 25000;
/**
 * 客户端上报「这个会话现在到底在不在等人」。
 *
 * 为什么需要它：悬浮窗的 pending 是自己推断的（approval/request 计数 +
 * ask_user_question 在不在跑），dock 用的是宿主投影 pendingInteraction。
 * 两边判据不同，时序上差几十毫秒——用户看到的就是「dock 说等你确认、
 * 浮窗还在漂洗」。
 *
 * 频次：只在 pending 真的变化时发一次，一次任务两次（弹出、回答）。
 * 没有定时器、没有轮询，所以不存在性能问题。
 */
const WEB_PENDING_PATH = '/dsh-washer/pending';
/** 平台能力探测：客户端拿不到 process.platform，只能问宿主 */
const WEB_CAPABILITIES_PATH = '/dsh-washer/capabilities';
/** 客户端问「这一轮是不是被用户按停的」——它拿不到 turn/end 的 reason */
const WEB_STOP_PATH = '/dsh-washer/stop';
/** 上报体上限。就两个字段，1KB 已经非常宽松。 */
const PENDING_BODY_LIMIT = 1024;

/**
 * 统一的请求体读取：收 body → 超限回 413 → JSON 解析（可选）。
 *
 * 此前每个 POST 路由各自手搓 `req.on('data'/'end')`，阈值三套（4096/10240/1024），
 * `/pin` 超限只 `req.destroy()` 不返响应，客户端拿到的是断连而非明确错误。
 * 收口到一处：所有路由用同一个上限语义（超限 413、坏 JSON 400）。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {number} limit 字节上限
 * @param {{ json?: boolean }} [opts] json=true 时把 body 解析成对象
 * @returns {Promise<{ok: true, value: any} | {ok: false}>}
 *   ok:false 表示已经由本函数写过响应（413/400），调用方直接 return 即可。
 */
function readBody(req, res, limit, opts = {}) {
  const wantJson = opts.json !== false;
  return new Promise((resolve) => {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      body += chunk;
      if (body.length > limit) {
        tooBig = true;
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return resolve({ ok: false });
      if (!wantJson) return resolve({ ok: true, value: body });
      let value;
      try {
        value = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad json' }));
        return resolve({ ok: false });
      }
      resolve({ ok: true, value });
    });
    // 连接中途断了：别再 resolve 挂起，直接放弃（res 多半也已断）
    req.on('error', () => { if (!tooBig) resolve({ ok: false }); });
  });
}

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
    // core.js 的 elapsedOf/turnEndTimeOf 要的是 Map<turn, {startTime, endTime}>，
    // 早期写成普通对象 + {start,end}，导致计时永远 00:00、lastEndedAt 永远 null。
    turnTimings: new Map(),
    /**
     * 「洗完了」的保持窗口（毫秒时间戳）。
     *
     * 主界面端靠 React state 里的 sticky 做这件事，桌面端没有 React，
     * 早先 snapshot() 里写死 `sticky: null`，于是 deriveState 的分支
     * `sticky.kind === 'done'` 恒不成立 —— 悬浮窗永远进不了 done，
     * 绿灯停 6 秒这个核心反馈在桌面上一次都不会出现。
     * 需要一个不依赖渲染进程存活的时间点，所以存在这里。
     */
    doneUntil: 0,
    /**
     * 最近一次被用户自己按停的轮次号（没有则 -1）。
     *
     * 为什么要单独记：浏览器端的 dock 从 useChat legacy 里拿不到 turn/end
     * 的 reason（只有 nodes / turnTimings / turnEnds / partial / runningCalls），
     * 于是它只能靠"running 从 true 变 false 且没有错误"推断"洗完了"——
     * 用户按停也会命中这个条件，dock 就点了个绿勾。宿主这边判得准
     * （isUserAbort），所以把这个事实存下来，让 dock 拉一次对齐。
     */
    stoppedTurn: -1,
    /** 最近一次 agent/status */
    running: false,
    /**
     * 最新的 usage 快照（来自 assistant/message.data.usage）。
     * 注意：这些数字是**累加**的（同一 turn 内单调增长），不是每条消息各自的量，
     * 所以要拿它算速度必须看前后两次的差值。
     */
    usage: null,
    /** 模型名，来自 assistant/message.data.message.source.model */
    model: null,
    /** 上一份 usage 与对应时刻，用来算增量速度 */
    lastUsage: null,
    /** 最近的 (时间, 累计输出 token) 采样，用于滑动窗口算速度 */
    tokenSamples: [],
  };
}

/** 速度滑动窗口（毫秒）。取 5 秒：太短抖得看不清，太长反应迟钝。 */
const SPEED_WINDOW_MS = 5000;

/**
 * 「洗完了」绿灯保持多久（毫秒）。
 * 和 client.js 的默认值保持一致——同一个 config 项，两边默认值不同会让
 * 主界面和悬浮窗对"完成"这件事的持续时间不一样，看着像两个 bug。
 */
const DEFAULT_DONE_HOLD_MS = 6000;

/** turnTimings 最多留几轮。超出就丢最旧的，见 foldEvent 的 turn/start。 */
const TURN_TIMINGS_LIMIT = 50;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 从 token 采样里算输出速度（token/秒）。
 *
 * 用**累计输出 token 的差值**除以时间差，不是"有几次采样"。
 *
 * 早先这里是死板的"窗口内至少两个采样点"，结果速度永远不显示：
 * 一次工具调用动辄几秒，中间只有工具结果事件、没有 assistant/message，
 * 5 秒窗口里常常就一个采样点。而采样点是**有增长才记**的，
 * 所以相邻两点的差值天然就是真实产出，不必非得落在同一个窗口里。
 *
 * 现在的口径：
 *   1. 取窗口内最早的采样做起点；
 *   2. 窗口内没有两个点时，退到"最近两个有效采样"，跨度不超过
 *      SPEED_STALE_MS——再久就不是"当前速度"而是历史平均了；
 *   3. 输出完全没增长（空闲）仍然返回 null，不编 0。
 */
const SPEED_STALE_MS = 15000;

export function speedOf(samples, now, windowMs = SPEED_WINDOW_MS) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const last = samples[samples.length - 1];
  // 最近一次采样已经很旧了，说明这段时间没有新产出，别再报陈年速度
  if (now - last.at > SPEED_STALE_MS) return null;

  const from = now - windowMs;
  let first = null;
  for (const sample of samples) {
    if (sample.at >= from) { first = sample; break; }
  }
  // 窗口内不足两点：退到最近两个采样
  if (first === null || first === last) {
    first = samples.length >= 2 ? samples[samples.length - 2] : null;
  }
  if (first === null || first === last) return null;
  // 兜底窗口跨度：两点隔得太远，算出来的是平均速度不是当前速度
  if (last.at - first.at > SPEED_STALE_MS) return null;

  const dt = last.at - first.at;
  if (dt <= 0) return null;
  const dTokens = last.output - first.output;
  // 累计值回退说明开了新会话或计数被重置，这种样本没法用
  if (dTokens < 0) return null;
  // 没有增长就是闲置，返回 null 让前端显示 —，而不是骗人的 0
  if (dTokens === 0) return null;
  return dTokens / (dt / 1000);
}

/**
 * 按耗时倒序聚合本轮的工具调用。
 *
 * 同一工具多次调用合并成一条，取最大耗时——面板要回答的是
 * "哪个工具在拖后腿"，逐次罗列反而看不清。
 */
export function rankTools(nodes, turn, limit = 6) {
  if (!Array.isArray(nodes)) return [];
  const byName = new Map();
  for (const node of nodes) {
    // 耗时记在 tool-result 上（callTime = 调用发起时刻，time = 结果返回时刻），
    // 和 core.js 的 recentTools 同源，别改成读 node.ms —— 那是另一套字段，这里没有。
    if (node.kind !== 'tool-result') continue;
    if (turn !== undefined && node.turn !== turn) continue;
    if (typeof node.callTime !== 'number' || typeof node.time !== 'number') continue;
    const ms = node.time - node.callTime;
    const prev = byName.get(node.name);
    if (prev === undefined) {
      byName.set(node.name, { name: node.name, ms, calls: 1, isError: node.isError === true });
    } else {
      prev.calls += 1;
      if (ms > prev.ms) prev.ms = ms;
      if (node.isError) prev.isError = true;
    }
  }
  return [...byName.values()].sort((a, b) => b.ms - a.ms).slice(0, limit);
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
/**
 * 模块级可变的一次性配置。
 *
 * foldEvent 是导出的纯函数（测试直接调），签名里没有 config；
 * 为了不改测试和调用方，用一个模块级的"当前值"承接。apply 时设、
 * 卸载时还原，多实例（热重载并存的那一小段）会互相覆盖——但那段时间
 * 本来只有一个实例在收事件，可以接受。
 */
let doneHoldMs = DEFAULT_DONE_HOLD_MS;

/** 测试和 apply 用：设定「洗完了」保持多久 */
export function setDoneHoldMs(ms) {
  doneHoldMs = Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_DONE_HOLD_MS;
}

/**
 * 从 turn/end 的 data.reason 里提取失败信息。
 *
 * 端口自 dsh-client-ui-chat 的 endFailure()（宿主 lib/types/client/
 * conversation-nodes/turn-error.js），三种 reason 才算失败：
 *   { kind:'error',       error:{ code, message } }  模型/工具链路报错
 *   { kind:'aborted',     reason:{ kind:'hook', reason:'deepseek-account/signed-out' } }
 *                                                    登出导致的中止
 *   { kind:'interrupted' }                           宿主进程在一轮中途退出
 * 其余（completed / blocked / max-tokens / aborted-by-user）都不算错误：
 * 用户自己按停不该报红灯。
 *
 * 注意：aborted-by-user 返回 undefined **不代表它不用管**。它只是不是失败，
 * 但也不是干完了——「按停」和「洗完了」是两回事，see isUserAbort()。
 * turn/end 里必须两头都判：这里判失败（报红灯），isUserAbort 判按停（不亮绿勾）。
 * 只判这里会漏掉按停，用户掐断任务却看到「洗完了」。
 *
 * 早先这里根本不存在——turn-error 节点从来没人写，deriveState 里
 * `findTurnError(...) === 'error'` 那条分支在桌面端是死代码，
 * 账号登出、上下文超限、进程被中断，悬浮窗一律掉回 idle 装没事。
 */
export function endFailureOf(reason) {
  if (reason === null || typeof reason !== 'object') return undefined;
  if (reason.kind === 'error') {
    const e = reason.error;
    if (e && typeof e === 'object') {
      return { code: typeof e.code === 'string' ? e.code : 'E-00', message: typeof e.message === 'string' ? e.message : '' };
    }
    return { code: 'E-00', message: '' };
  }
  if (reason.kind === 'aborted') {
    const r = reason.reason;
    if (r && r.kind === 'hook' && r.reason === 'deepseek-account/signed-out') {
      return { code: 'ACCOUNT_SIGNED_OUT', message: 'Stopped because you signed out of DeepSeek.' };
    }
    return undefined;
  }
  if (reason.kind === 'interrupted') {
    return { code: 'INTERRUPTED', message: 'The DSH process exited before this turn finished.' };
  }
  return undefined;
}

/**
 * 这一轮是不是被用户自己按停的。
 *
 * 和 endFailureOf 分开判，因为两者语义不同：按停**不是失败**（不该报红灯），
 * 但也**不是干完了**（不该亮绿勾「洗完了」）。之前只有 endFailureOf，
 * aborted-by-user 落在"不是失败"这边，于是 turn/end 里顺手点亮了洗完了
 * ——用户掐断任务，洗衣机说它洗完了，这是错的。
 *
 * 只认 reason.kind === 'aborted'，并且不是登出那种被动中止
 * （登出走 endFailureOf 的 ACCOUNT_SIGNED_OUT，是错误，这里不掺和）。
 *
 * @param {unknown} reason turn/end 的 data.reason
 * @returns {boolean}
 */
export function isUserAbort(reason) {
  if (reason === null || typeof reason !== 'object') return false;
  if (reason.kind !== 'aborted') return false;
  const r = reason.reason;
  if (r && typeof r === 'object' && r.kind === 'hook' && r.reason === 'deepseek-account/signed-out') {
    return false;
  }
  return true;
}

export function foldEvent(state, event, now) {
  const data = event && event.data ? event.data : {};
  const type = event ? event.type : undefined;

  /*
   * 别只盯着 `turn/start`——宿主根本不发它。
   *
   * 插件装在 Host 侧，收到的是**已经落盘**的 session/event。实测 71 条事件里
   * `turn/start` 出现 0 次，而 `step/start`、`tool/call`、`assistant/message`
   * 这些的 `data.turn` 都明明白白带着轮号（一轮里永远是同一个数，例如 13）。
   *
   * 原实现只在 `case 'turn/start'` 里写 `state.turn`，那条分支永远走不到，
   * 于是 state.turn 恒为 0，连带整条链路失效：
   *   - outline 靠 `s.turn > 0` 构造，恒为空 → 快照里找不到"当前轮"
   *   - elapsedOf / turnEndTimeOf 拿到 turn 0 → elapsedMs 恒 0、durationText 恒 00:00
   *   - 浮窗永远显示"待机"，哪怕正在跑工具
   *
   * 所以改成：任何一个带着**比当前更大**的 turn 号的事件，都当成新一轮开始。
   * 用"大于"而不是"不等于"，是因为乱序或重复投递的旧事件不该把轮次往回拨。
   */
  function beginTurn(state, turn, now) {
    state.turn = turn;
    state.partial = null;
    state.runningCalls = [];
    state.callStartedAt.clear();
    state.turnTimings.set(turn, { startTime: now });
    // 新一轮开始了，「洗完了」必须立刻让位，否则转起来的机器还挂着绿勾
    state.doneUntil = 0;
    /*
     * turnTimings 只增不删，长跑会话下会无界增长（一轮一条，一个月几千条）。
     * 实际只有两个消费者：elapsedOf/turnEndTimeOf 看当前轮，
     * 外加详情面板的历史。留最近 50 轮足够，多的直接丢。
     */
    while (state.turnTimings.size > TURN_TIMINGS_LIMIT) {
      const oldest = state.turnTimings.keys().next();
      if (oldest.done) break;
      state.turnTimings.delete(oldest.value);
    }
    // 新 turn 开始，旧节点不再参与「这一步走到哪」的判定
    state.nodes = [];
    pushNode(state, { kind: 'turn-start', turn });
  }

  if (type !== 'turn/start' && typeof data.turn === 'number' && data.turn > state.turn) {
    beginTurn(state, data.turn, now);
  }

  switch (type) {
    case 'turn/start': {
      const turn = typeof data.turn === 'number' ? data.turn : state.turn + 1;
      beginTurn(state, turn, now);
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
    case 'assistant/message': {
      /*
       * 一次模型回复结束（不是每个流式分片）。
       * data 结构（实测）：
       *   { turn, step, message: { role, content, source: { provider, model, ... }, id },
       *     usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens },
       *     stream: [...] }
       *
       * usage 是**累加值**：同一 turn 内第二条消息的 totalTokens 比第一条大。
       * 直接拿去当"本条用了多少"是错的，要存快照再算差值。
       */
      const src = data.message && data.message.source;
      if (src && typeof src.model === 'string') state.model = src.model;
      const u = data.usage;
      if (u && typeof u.outputTokens === 'number') {
        state.lastUsage = state.usage === null ? null : { usage: state.usage, at: now };
        state.usage = {
          input: num(u.inputTokens),
          output: num(u.outputTokens),
          cacheRead: num(u.cacheReadTokens),
          cacheWrite: num(u.cacheWriteTokens),
          total: num(u.totalTokens),
        };
        // 只在输出真的涨了才记采样：平白多记一个"和上一条一样"的点，
        // 会让速度被稀释成偏低的数。
        const prev = state.tokenSamples.length === 0
          ? null : state.tokenSamples[state.tokenSamples.length - 1];
        if (prev === null || state.usage.output > prev.output) {
          state.tokenSamples.push({ at: now, output: state.usage.output });
        }
        // 采样留得比速度窗口长一些：窗口内点数不够时要靠更早的点兜底
        const cutoff = now - SPEED_STALE_MS * 2;
        while (state.tokenSamples.length > 2 && state.tokenSamples[0].at < cutoff) {
          state.tokenSamples.shift();
        }
      }
      state.partial = null;
      pushNode(state, { kind: 'assistant-message', turn: data.turn, model: src ? src.model : null });
      return state;
    }
    case 'turn/end': {
      const turn = typeof data.turn === 'number' ? data.turn : state.turn;
      state.turn = turn;
      state.runningCalls = [];
      state.callStartedAt.clear();
      state.partial = null;
      if (state.turnTimings.has(turn) && state.turnTimings.get(turn).endTime === undefined) {
        state.turnTimings.get(turn).endTime = now;
      }
      /*
       * 失败信息藏在 data.reason 里（宿主的 turn/end 一定带 reason）。
       * 先记 turn-error 节点，再决定要不要亮「洗完了」——顺序不能反，
       * hasError 看的是节点序列。
       */
      const failure = endFailureOf(data.reason);
      if (failure !== undefined) {
        pushNode(state, { kind: 'turn-error', turn, code: failure.code, message: failure.message });
      }
      /*
       * 只有这一轮没出错、也不是用户按停的，才亮「洗完了」。
       * 按停既不算失败也不算干完：不记 turn-error（不报红灯），
       * 也不点 doneUntil（不亮绿勾），画面自然回落到 idle 待机。
       */
      const abortedByUser = isUserAbort(data.reason);
      if (abortedByUser) {
        // 记下来：浏览器端的 dock 判断不了按停，会自己点绿勾，靠这个字段对齐
        state.stoppedTurn = turn;
      }
      if (failure === undefined && !abortedByUser && !hasError(state.nodes)) {
        state.doneUntil = now + (Number.isFinite(doneHoldMs) ? doneHoldMs : DEFAULT_DONE_HOLD_MS);
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

/**
 * 极简 WebSocket 帧编码：只发文本/空 ping、只支持单帧（状态快照远小于 64KB）。
 *
 * @param {string} text 帧内容
 * @param {number} [opcode] 1 = text（默认），9 = ping。ping 帧内容为空，
 *   payload 长度 0，浏览器收到会自动回一个 pong——不需要我们解析任何入站帧。
 */
export function encodeWsText(text, opcode = 0x1) {
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
  header[0] = 0x80 | opcode; // FIN + opcode
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
  // 支持覆盖，测试用——否则跑单测会创建/删除真实的端点文件，
  // 把正在运行的宿主服务的端点信息一起踩没了。
  if (process.env.DSH_WASHER_ENDPOINT_FILE) return process.env.DSH_WASHER_ENDPOINT_FILE;
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
/**
 * 判断一份端点信息是不是当前这个进程写的。
 * 分开成函数是为了测试能直接喂数据，不用真起服务。
 */
export function isOwnEndpoint(info, port, token, pid) {
  if (info === null || typeof info !== 'object') return false;
  return info.pid === pid && info.token === token && info.port === port;
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

/**
 * 拉起 Electron 悬浮窗。
 *
 * 之前是人工 `./electron/start.sh`，导致「重启宿主后悬浮窗没了」——
 * 用户以为它会跟着走，其实一直是手动起的。这里改成宿主负责生命周期：
 * apply 时 spawn，disposer 里 kill。
 *
 * 三条限制：
 *   1. 只起一次：单实例锁在 electron 那边，重复起也只是把窗口提到前面。
 *   2. 崩了不自动重试：无限重启会刷屏，而且崩多半是环境问题（Electron 被删、
 *      权限没了），自动重试治不了根。用户可以从设置里关掉再打开重试。
 *   3. 宿主退出时 kill 掉整个进程组，否则 Electron 会变成孤儿还在跑。
 */
/**
 * 子进程（悬浮窗）异常退出前的最后几行 stderr。
 *
 * 宿主里没法把子进程的输出转给用户看，但「起不来」必须有个原因。
 * 失败时把它拼进 overlayLaunchError，设置页才说得清是哪里不对。
 */
let lastChildStderr = '';

/**
 * 悬浮窗依赖的平台是不是 macOS。
 *
 * **悬浮窗只支持 macOS，dock 不限平台。**
 *
 * dock 走的是宿主渲染进程里的 React + CSS，任何能开 Web UI 的平台都能用；
 * 悬浮窗是一个独立的 Electron 进程，要透明置顶、跨 Space、点击穿透、
 * 双击切态、右键菜单——每一项在 Windows 上都有各自的差异，逐个实测的
 * 成本远超收益。所以这里划一条明确的线：非 macOS 直接判定"不支持"，
 * 而不是"碰巧找不到 Electron 所以起不来"。
 *
 * 这个区别对用户是实打实的：前者设置页根本不该出现悬浮窗选项，
 * 后者会让用户以为装上 Electron 就能用，然后一直试。
 */
function overlayPlatformSupported() {
  return process.platform === 'darwin';
}

/**
 * 候选的 Electron 可执行文件路径。
 *
 * 只有 macOS 会走到这里——非 macOS 在 overlayPlatformSupported() 就返回了。
 * 仍然保留 DSH_WASHER_ELECTRON 覆盖：用户可能把运行时放在别处
 * （多版本共存、自己编译的、brew 装的）。
 */
function electronBinaryCandidates() {
  const fromEnv = process.env.DSH_WASHER_ELECTRON;
  if (typeof fromEnv === 'string' && fromEnv !== '') return [fromEnv];

  // macOS：Electron.app bundle 里的主可执行文件
  return [join(homedir(), '.dsh', 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')];
}

/**
 * 找出能用的 Electron 可执行文件。找不到返回 null。
 *
 * 返回 null 的原因要能说清楚——早先 spawnOverlay 拿到 null 就静默 return，
 * 用户分不清是「没装」还是「装了但路径不对」。调用方据此提示用户。
 */
function electronBinary() {
  // 非 macOS 不找——不是"没找到"，是这个平台就没有
  if (!overlayPlatformSupported()) return null;
  for (const candidate of electronBinaryCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 悬浮窗偏好文件：设置页 → 宿主 → 主进程 的唯一通道。
 *
 * 主进程读不到浏览器的 localStorage，只能靠这个文件传话。反过来
 * 主进程也会在用户点右键菜单时改这个文件，所以两边都可能写——
 * 用整份覆盖（而不是增量 merge）会让两边互相抹掉对方刚改的字段。
 * 这里读-合并-写。
 *
 * 早先注释写的是「在同一个 tick 内完成，本机不会有竞争」——那只对
 * **单进程内**成立。实际有宿主编排进程和 Electron 主进程两个进程在写：
 *   宿主读 {skin} → 主进程读 {skin} → 主进程写 {skin, clickThrough}
 *   → 宿主写 {skin, show}，clickThrough 就这么被抹了。
 * 窗口小、难复现，但用户会看到"刚改的某个设置自己回去了"。
 *
 * 三个措施，都是廉价且必须的：
 *   1. 写入原子化（临时文件 + rename）。rename 在同一文件系统内是原子的，
 *      读的一方永远只会看到完整的旧版本或完整的新版本，不会是半截 JSON；
 *   2. 读到的内容解析失败时**放弃这次写入**，不要当成空对象继续——
 *      以前 catch 里回退成 {}，下一次写就把整个偏好文件清空了；
 *   3. 合并前重复读几次，降低两进程同时进入窗口的概率（不能根除，
 *      根除要文件锁，不值得为几十字节的配置引入依赖）。
 */
function overlayPrefsFile() {
  return process.env.DSH_WASHER_PREFS_FILE
    || join(homedir(), '.dsh', 'dsh-washer-float-prefs.json');
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖。
 * 同目录是必须的——跨文件系统 rename 会退化成复制+删除，不再原子。
 */
export function writeFileAtomic(file, content, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, { mode });
    // writeFileSync 的 mode 只在新建时生效，已存在的老文件权限不会自动收紧
    chmodSync(tmp, mode);
    renameSync(tmp, file);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* 清不掉就算了，下次覆盖 */ }
    return false;
  }
}

/**
 * 读偏好文件。
 * 返回 `undefined` = 文件不存在（可以安全地全新创建）；
 * 返回 `null` = 文件存在但读不出来（坏了/正在被写），**这次不要写**；
 * 返回对象 = 正常读到的内容。
 */
function readPrefsFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return undefined;
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readOverlayPrefs() {
  const parsed = readPrefsFile(overlayPrefsFile());
  return parsed === undefined || parsed === null ? {} : parsed;
}

export function writeOverlayPrefs(patch) {
  if (patch === null || typeof patch !== 'object') return null;
  const file = overlayPrefsFile();
  /*
   * 读 3 次、每次隔 15ms：给对面进程的 rename 一个落地窗口。
   * 前两次可能是半截数据（虽然原子写之后不该发生，但历史文件可能是
   * 非原子写留下的），第三次仍读不出来就认定文件坏了，直接放弃写入。
   * 返回 null 让调用方知道"这次没写成"，而不是假装成功。
   */
  let current;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    current = readPrefsFile(file);
    if (current !== null) break;
    const until = Date.now() + 15;
    while (Date.now() < until) { /* 极短自旋；这段只在读失败时才走到 */ }
  }
  if (current === null) return null;
  if (current === undefined) current = {};
  const next = Object.assign({}, current);
  // 只接受认识且类型对的字段，防止页面传脏数据把窗口搞成 0 宽
  if (patch.size === 'normal' || patch.size === 'tiny') next.size = patch.size;
  if (typeof patch.skin === 'string' && /^[a-z]{3,12}$/.test(patch.skin)) next.skin = patch.skin;
  if (patch.show === true || patch.show === false) next.show = patch.show;
  /*
   * 鼠标穿透。以前只能靠双击浮窗切换，但双击和"整机可拖"是互斥的
   * （Chromium 的拖拽区会吞掉 dblclick），所以把入口挪到设置页。
   */
  if (patch.clickThrough === true || patch.clickThrough === false) next.clickThrough = patch.clickThrough;
  // 洗完弹系统通知。默认关，用户显式开了才写进去。
  if (patch.notify === true || patch.notify === false) next.notify = patch.notify;
  // 状态音效。和通知是两个独立开关，可以只要其中一个。
  if (patch.sound === true || patch.sound === false) next.sound = patch.sound;
  /*
   * 暗色主题：Web 端量出宿主的实际明暗（读背景色亮度）再 POST 过来，
   * 浮窗据此切浅/深，做到「跟 dock 同步」。宿主（Node）读不到渲染进程的
   * 主题，只能由页面量一次再送过来。
   */
  if (patch.dark === true || patch.dark === false) next.dark = patch.dark;
  /*
   * 探测诊断字段：页面把"读到了什么颜色"一起发过来，落盘后方便排查。
   * 曾经出现过页面一次都没推、只看 dark 值完全看不出原因的情况。
   * 只收短字符串，避免被塞大内容把偏好文件撑大。
   */
  if (typeof patch.darkProbe === 'string' && patch.darkProbe.length <= 120) {
    next.darkProbe = patch.darkProbe;
  }
  return writeFileAtomic(file, JSON.stringify(next), 0o600) ? next : null;
}

/**
 * 读当前偏好。同步、纯读，失败返回空对象。
 *
 * 单独抽出来是因为它现在有两个消费者：设置页的初始状态、SSE 推送的载荷。
 * 两边必须看到同一份数据，不能一边用文件、一边用内存副本。
 */
function spawnOverlay(ctx, opts) {
  const binary = electronBinary();
  if (!existsSync(binary)) return null;
  const appDir = join(dirname(fileURLToPath(import.meta.url)), 'electron');
  if (!existsSync(join(appDir, 'main.cjs'))) return null;
  const args = [appDir];
  if (opts.size) args.push('--size', opts.size);
  if (opts.skin) args.push('--skin', opts.skin);
  let child = null;
  try {
    /*
     * 这两个变量必须是**真的不存在**，不能设成空字符串。
     *
     * Electron 判断 ELECTRON_RUN_AS_NODE 只看它有没有被定义，不看值——
     * 设成 '' 照样让它退化成纯 Node，require('electron') 直接
     * MODULE_NOT_FOUND，进程 100ms 就退出。
     *
     * 宿主自己就是 Electron，一定带着这个变量，所以子进程百分百继承它。
     * 早先的写法是把这个键设成空字符串（见 0.6.x 之前的历史），
     * 看着像"清掉了"，实际只是改了个值，等于没清——Windows 上就是被这一行
     * 卡住的：Electron 装好了、路径也对，窗口依然起不来。
     *
     * ELECTRON_NO_ATTACH_CONSOLE 同理，留着会让 Windows 上不分配控制台。
     */
    const childEnv = Object.assign({}, process.env);
    delete childEnv.ELECTRON_RUN_AS_NODE;
    delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
    child = spawn(binary, args, {
      detached: false,
      /*
       * stderr 不能丢。
       *
       * 早先是 'ignore'：子进程怎么死的、报什么错，宿主一个字都拿不到，
       * 用户看到的就是「开关拨了，什么都没发生」。留最后几行错误到
       * overlayLaunchError 里，设置页才有话可说。
       */
      stdio: ['ignore', 'ignore', 'pipe'],
      env: childEnv,
    });
  } catch {
    return null;
  }

  /*
   * 收着 stderr 的最后一行，等它异常退出时用作诊断。
   *
   * 只留一个尾巴：Electron 自己会往 stderr 刷大量与失败无关的噪音
   * （GPU 进程告警、Mach 端口之类），攒全量没意义还漏内存。
   */
  if (child !== null && child.stderr !== null && child.stderr !== undefined) {
    let tail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      tail = (tail + chunk).slice(-4000);
    });
    child.stderr.on('error', () => { /* 管道断了就算了，不影响主流程 */ });
    child.on('exit', (code) => {
      if (code !== 0 && tail !== '') {
        lastChildStderr = tail.trim().split('\n').slice(-3).join(' | ');
      }
    });
  }
  // 子进程退出后不留句柄，否则宿主退出会被它拖住
  child.on('error', () => { child = null; });
  child.unref();
  return child;
}

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {};
  /**
   * 启动时用偏好文件里的**外观**设置覆盖静态 config。
   *
   * 这是「启动客户端时初始状态没同步」的根因：静态 config 里写的是默认
   * 皮肤，而用户在设置页改成 pixel 后，那个值落在偏好文件里，启动路径
   * 压根没读它——于是每次启动都先冒出一台默认造型的洗衣机，过几百毫秒
   * 被 watchPrefs 纠正成像素。用户看到的就是"启动时状态不对"。
   *
   * 皮肤现在只有一份（主界面和悬浮窗共用），字段名就是 skin。
   *
   * ⚠️ 只覆盖 size / skin，**不要覆盖 show**。
   *
   * 这两类字段语义不同：
   *   - size / skin：纯粹的显示偏好，用户改成什么就该是什么
   *   - show / desktopOverlay：config 里是"我要不要这个功能"（装了插件就开），
   *     偏好文件里是"当前这一刻窗口是不是显示着"。用后者去覆盖前者，
   *     等于用户在运行中把窗口藏一次，功能就永久关闭了——重启也不回来。
   *     实测踩过：运行中拨到关 → 文件留下 show:false → 重启后服务根本不 listen。
   *
   * show 的处理交给 Electron 侧：main.cjs 启动时自己读 prefs.show 决定
   * 窗口要不要 show（见 electron/main.cjs 的 whenReady）。宿主只负责把
   * 进程拉起来，显不显示不归它管。
   */
  /*
   * 「洗完了」保持时长跟主界面共用同一个 config 项。
   * 桌面端原来完全没有这一档（见 createSessionState 的 doneUntil 注释），
   * 这里的默认值也和 client.js 的 6000 对齐；cordis.patch.yml 里写的是
   * 3000，落在 cfg 上会覆盖默认值——两边读同一个字段，行为一致。
   */
  setDoneHoldMs(Number(cfg.doneHoldMs));

  const savedPrefs = readOverlayPrefs();
  if (savedPrefs.size === 'normal' || savedPrefs.size === 'tiny') cfg.desktopOverlaySize = savedPrefs.size;
  if (typeof savedPrefs.skin === 'string' && /^[a-z]{3,12}$/.test(savedPrefs.skin)) cfg.skin = savedPrefs.skin;

  /*
   * 桌面悬浮窗默认关着——装了不看的人不该莫名多一个后台端口。
   *
   * 这里用 let 不用 const：设置页的开关是运行时能拨的，用户在运行中把它打开
   * 也应该立刻起悬浮窗，不能等下次重启宿主才生效。
   */
  let enabled = cfg.desktopOverlay === true;

  /** sessionId → 会话状态 */
  const sessions = new Map();
  /** 当前主视图会话（取最近有事件的那个） */
  let currentSessionId = null;
  /** 已连接的 WS 客户端 */
  const clients = new Set();
  /** socket → 最近一次收到字节的时间（心跳判定用，见 ensureHeartbeat） */
  const lastSeen = new Map();
  let port = 0;
  const token = randomBytes(24).toString('base64url');
  let lastPushed = '';
  /** 上一次真正写进推送流的状态名（心跳据此发现「状态自己变了但没人说」） */
  let lastPushedState = null;
  /*
   * 迟滞：两边（dock / 悬浮窗）都要用 shouldSwitch，否则工具一结束，
   * 悬浮窗立刻跳到 washing、dock 还在 rinsing 等它那 400ms 防抖。
   * 用户看到的就是两块屏幕不一致。
   *
   * 这里记两个东西：真正显示出去的那个状态，以及它是什么时候变的。
   */
  let shownState = null;
  let shownStateAt = 0;
  /** 迟滞窗口到点重算用的定时器（见 settleState 末尾） */
  let pendingSwitchTimer = null;
  let lastPushAt = 0;
  let pushTimer = null;
  /** 由宿主拉起的 Electron 悬浮窗进程 */
  let overlayChild = null;
  /**
   * 上次拉悬浮窗失败的原因（null 表示没失败过）。
   *
   * 要送到客户端才能让设置页把「打开了却什么都没发生」说清楚。
   * 早先只有一行 logger.warn，落在宿主日志里，用户根本看不到。
   */
  let overlayLaunchError = null;
  /** 订阅了偏好推送（SSE）的网页客户端。设置页开一个、关一个。 */
  const prefClients = new Set();

  /**
   * 把当前偏好推给所有 SSE 订阅者。
   *
   * 任何一方改了偏好都要调它：设置页自己改的（那次没意义但无害，
   * 幂等）、悬浮窗右键菜单改的（这是关键的一条）。
   * 直接推整份而不是增量：字段只有三个，计算增量不值当，
   * 而且整份能顺便纠正客户端上任何漂移的值。
   */
  function pushPrefs() {
    if (prefClients.size === 0) return;
    const payload = `data: ${JSON.stringify(readOverlayPrefs())}\n\n`;
    for (const client of prefClients) client.write(payload);
  }

  /**
   * 拉起悬浮窗。集中在一处，方便"运行时开关"和"启动"两条路径复用。
   * 返回是否真的拉起来了。
   *
   * 这里不再检查 server.listening：调用方保证。以前自己检查过，结果是
   * 「启动时关 → 运行中拨开」时服务还没起来，直接 return false，
   * 于是开关永远拉不起窗口（服务由 startService 负责，见那里的注释）。
   */
  function launchOverlay() {
    if (overlayChild !== null) return true;
    if (cfg.desktopOverlayAutoLaunch === false) return false;
    overlayChild = spawnOverlay(ctx, {
      size: cfg.desktopOverlaySize,
      /*
       * skin 可能是 'auto'——那是主界面的"按尺寸自动挑"策略，浮窗没有这个
       * 概念（它只有一个固定尺寸）。这里落成具体造型，避免把 'auto'
       * 传给浮窗后它不认识、回落到 precision 而和设置页显示的不一致。
       */
      skin: cfg.skin === 'precision' || cfg.skin === 'pixel'
        ? cfg.skin
        : 'precision',
    });
    if (overlayChild === null) {
      /*
       * 说清楚是哪个原因。早先只有一句「找不到 Electron 或 electron/main.cjs」，
       * 用户分不清是没装运行时还是路径不对——Windows 用户就是这样装了插件
       * 之后什么都不发生，日志里也看不出所以然。
       */
      const candidates = electronBinaryCandidates().join(' / ');
      const why = electronBinary() === null
        ? `找不到 Electron 运行时，试过：${candidates}`
        : '找不到 electron/main.cjs';
      ctx.logger?.warn?.(`[dsh-washer] 悬浮窗没起来：${why}`);
      overlayLaunchError = why;
      return false;
    }
    overlayLaunchError = null;
    /*
     * 进程自己退了就把引用清掉，否则下次拨开关会以为它还活着，永远不再拉起。
     *
     * 顺便把非正常退出的原因留下来。Electron 起不来时最常见的形态就是
     * 「spawn 成功、进程存在、100ms 后就没了」——spawn 本身不报错，
     * 只能从这里知道它为什么死。
     */
    overlayChild.on('exit', (code) => {
      overlayChild = null;
      if (code !== 0 && code !== null) {
        overlayLaunchError = lastChildStderr === ''
          ? `悬浮窗进程退出了（code ${code}）`
          : `悬浮窗进程退出了（code ${code}）：${lastChildStderr}`;
        ctx.logger?.warn?.(`[dsh-washer] ${overlayLaunchError}`);
      }
      lastChildStderr = '';
    });
    return true;
  }

  /** 关掉悬浮窗进程。用户把开关拨到关时要真退出，不能只是隐藏。 */
  function shutdownOverlay() {
    if (overlayChild === null) return;
    try { overlayChild.kill(); } catch { /* 已经退出就算了 */ }
    overlayChild = null;
  }

  function resolveSessionId(subject) {
    if (subject === undefined || subject === null) return null;
    if (typeof subject === 'string') return subject;
    if (typeof subject.id === 'string') return subject.id;
    if (typeof subject.sessionId === 'string') return subject.sessionId;
    return null;
  }

  /** sessionId -> 挂起中的审批数（snapshot() 要读，声明必须在它之前） */
  const pendingApprovals = new Map();
  /**
   * 客户端报上来的待人工状态：sessionId -> { kind } | null。
   * 与 pendingApprovals 并存而不是合并：一个是"宿主侧看到的审批请求数"，
   * 一个是"浏览器那边渲染时认定在等"，来源不同，判据要能分别看。
   */
  const clientPending = new Map();

  /*
   * 正在等人回答的提问工具。
   *
   * 宿主的 `user-questions/request` 走 ctx.remote 转发到浏览器端消费，
   * Host 侧 ctx.on 收不到（实测挂上监听、弹了三次确认框，日志一条没有）。
   * 但 `session/event` 里能实实在在看到这个工具在跑——它挂多久，
   * 人就犹豫了多久，正好就是"等你确认"的时长。
   *
   * 所以退一步：直接看 runningCalls 里有没有在跑的提问工具。
   * 这条路不依赖 scope、不依赖 waterfall，宿主怎么改转发都漏不掉。
   */
  function awaitingAnswer(state) {
    return state.runningCalls.some((c) => c.name === 'ask_user_question');
  }

  /**
   * 这个会话是不是在等人。三处调用点（快照、总览、推送）必须同一套判断，
   * 否则会出现"浮窗亮着、总览说在洗"这种自相矛盾。
   * 审批优先：它比提问更需要人立刻动手。
   */
  function pendingFor(sessionId, state) {
    /*
     * 客户端报上来的最准——它就是 dock 手上那份 pendingInteraction。
     * 但只在"报在等"时采信：它报 null 不代表本地看到的提问工具可以忽略，
     * 那边可能只是还没收到。取并集才不会被一边的滞后熄灭。
     */
    const reported = clientPending.get(sessionId);
    if (reported !== undefined && reported !== null) return reported;
    if ((pendingApprovals.get(sessionId) || 0) > 0) return { kind: 'approval' };
    return awaitingAnswer(state) ? { kind: 'question' } : undefined;
  }

  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = createSessionState();
      sessions.set(sessionId, state);
    }
    return state;
  }

  /**
   * 把一份会话状态摊成 deriveState 的入参。
   *
   * 这个入参对象此前在 sessionSummaries / snapshot / ensureTick 三处各抄一遍，
   * 九字段完全一样，只有 outline 一度被写成 [{ turn }] 而不是真实 outline——
   * 于是三端给 latestTurnOf 的输入悄悄分叉，正是历史上「两端状态不一致」的根因。
   * 集中到一处产出，改字段只改这里。
   */
  function deriveInputOf(sessionId, s, now) {
    return {
      sessionId,
      running: s.running,
      // 有审批挂在等人类回答就是 waiting。没订阅时这里恒 undefined，
      // 浮窗永远不会亮"等你确认"——最该提醒的时刻不提醒。
      pending: pendingFor(sessionId, s),
      runningCalls: s.runningCalls,
      partial: s.partial,
      nodes: s.nodes,
      outline: s.turn > 0 ? [{ turn: s.turn }] : [],
      trajectory: undefined,
      // 主界面用 React state 记这件事，桌面端没有 React，只能从会话状态里取。
      // 到期不用清：deriveState 自己比 now < until，过期自然失效。
      sticky: s.doneUntil > 0 ? { kind: 'done', turn: s.turn, until: s.doneUntil } : null,
      now,
    };
  }

  /**
   * 钉住的会话。null = 跟着最近活动走。
   *
   * 为什么要这个：Host 侧不知道哪个会话在前台。客户端靠
   * `retainedBy.mainView > 0` 判断，但那是纯客户端的引用计数，
   * Node 进程里没有。于是浮窗只能"谁最后一个动就显示谁"，
   * 多开会话时画面随机跳，用户根本认不出在看哪一台。
   *
   * 与其猜，不如给一个明确的锚点：用户点一下指示灯就钉住那个会话，
   * 不点了就回到跟随。猜错了比不猜更烦人。
   */
  let pinnedSessionId = null;

  /** 浮窗要显示哪个会话：钉住的优先，否则最近活动的。 */
  function viewSessionId() {
    if (pinnedSessionId !== null && sessions.has(pinnedSessionId)) return pinnedSessionId;
    return currentSessionId;
  }

  /**
   * 所有还活着的会话的一句话概览。
   *
   * 浮窗一行指示灯用它画：每个会话一颗，颜色对应状态。
   * 用户经常同时跑两三个 agent，只显示一个等于看不见其它两个。
   *
   * 不排序的话每次 Map 遍历顺序不同会让指示灯乱跳，所以按
   * "紧急的在前，其次最近的在前"固定下来——这本身就是有用的信息。
   */
  function sessionSummaries(now) {
    const rows = [];
    for (const [id, s] of sessions) {
      const outline = s.turn > 0 ? [{ turn: s.turn }] : [];
      const state = deriveState(deriveInputOf(id, s, now));
      const turn = latestTurnOf(outline);
      rows.push({
        sessionId: id,
        state,
        turn,
        running: s.running,
        elapsedMs: elapsedOf(s.turnTimings, turn, now) || 0,
        // 排序用：越大越靠前。紧急态（等待/故障）永远在最前面，
        // 因为那才是需要人动手的。
        weight: stateWeight(state),
        lastAt: turnEndTimeOf(s.turnTimings, turn) || 0,
      });
    }
    rows.sort((a, b) => (b.weight - a.weight) || (b.lastAt - a.lastAt) || a.sessionId.localeCompare(b.sessionId));
    return rows;
  }

  /** 把 Host 侧攒的状态映射成 deriveState 的输入，产出给渲染端的快照 */
  function snapshot() {
    const sessionId = viewSessionId();
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
        toolRank: [],
        toolCount: 0,
        model: null,
        speed: null,
        tokenUsage: null,
        errorCode: null,
        lastEndedAt: null,
        // 即使当前没有主视图会话，后台可能还有在跑的——总览要照样给
        sessions: sessionSummaries(now),
        pinnedSessionId,
        updatedAt: now,
      };
    }
    const s = stateFor(sessionId);
    const outline = s.turn > 0 ? [{ turn: s.turn }] : [];
    const derived = deriveState(deriveInputOf(sessionId, s, now));

    const turn = latestTurnOf(outline);
    const elapsedMs = elapsedOf(s.turnTimings, turn, now) || 0;
    const speed = speedOf(s.tokenSamples, now);
    /*
     * 预计还要多久。只有「正在跑」才有意义：已经结束的一轮说"还剩 2 分钟"
     * 是胡话。超过典型时长显示 0，前端据此换成"该好了"而不是负数。
     */
    const typicalMs = typicalTurnMs(s.turnTimings);
    const remainingMs = derived !== 'done' && derived !== 'idle' && derived !== 'off'
      ? remainingOf(typicalMs, elapsedMs)
      : null;
    return {
      version: 1,
      sessionId,
      state: derived,
      turn,
      elapsedMs,
      durationText: formatDuration(elapsedMs),
      // 看着在转、其实没动静。没卡是 null，前端据此决定要不要改副标题。
      stalledMs: stalledForOf(s.tokenSamples, derived, now),
      // 预计剩余。基于这个会话自己最近几轮的中位数，不跨会话借数据。
      typicalMs,
      remainingMs,
      /*
       * action 是中文动作说明（toolActionOf），name 保留技术名。
       * 两个都给：状态条和浮窗显示 action（用户看得懂"跑命令"，
       * 看不懂"bash"），详情面板这类诊断场景要 name（对得上日志）。
       */
      tools: recentTools(s.nodes, 6).map((t) => ({
        name: t.name,
        action: toolActionOf(t.name),
        ms: t.ms === undefined ? null : t.ms,
        isError: t.isError === true,
      })),
      // 详情面板要的是"谁最慢"，按耗时倒序；上面的 tools 是时间序给流水用的。
      // 同一工具多次调用在这里合并成一个，取最大耗时——面板里关心的是
      // "哪个工具在拖后腿"，不是每一次调用。
      toolRank: rankTools(s.nodes, turn).map((t) => ({
        name: t.name,
        action: toolActionOf(t.name),
        ms: t.ms,
        calls: t.calls,
        isError: t.isError,
      })),
      toolCount: toolCountOf(s.nodes, turn),
      /*
       * 最近被用户按停的轮次号。浏览器端 dock 拿不到 turn/end 的 reason，
       * 靠这个字段判断"这轮是停了，不是洗完了"，不点绿勾。见 stoppedTurn 注释。
       */
      stoppedTurn: s.stoppedTurn,
      // 详情面板用：模型、速度、token 用量。tokenUsage 早先是恒 null，
      // 现在 assistant/message 的 usage 能填上了。
      model: s.model,
      speed,
      tokenUsage: s.usage,
      // errorCodeOf(null) 会返回 'E-00'，所以只在确实有错误节点时才问它
      errorCode: hasError(s.nodes) ? errorCodeOf(lastErrorNode(s.nodes)) : null,
      lastEndedAt: turnEndTimeOf(s.turnTimings, turn) || null,
      // 其余会话的概览：浮窗画一排指示灯，用户才知道另外两台在干嘛
      sessions: sessionSummaries(now),
      // 非 null 表示用户钉住了某一台，浮窗据此显示/隐藏「回到跟随」
      pinnedSessionId: viewSessionId() === pinnedSessionId ? pinnedSessionId : null,
      updatedAt: now,
    };
  }

  /**
   * 把「算出来的」状态按迟滞规则落到「显示出去的」状态。
   *
   * 规则本身在 core.js 的 shouldSwitch 里，和网页端 dock 一字不差：
   * 紧急态立即切，权重升高立即切，只有权重下降才等满 400ms。
   *
   * 悬浮窗早先没有这一层，于是 rinsing→washing 这类降级切换它秒变、
   * dock 要等 400ms，工具一结束两块屏就对不上。
   */
  function settleState(candidate, now) {
    if (shownState === null) {
      shownState = candidate;
      shownStateAt = now;
      return candidate;
    }
    if (candidate === shownState) return shownState;
    if (shouldSwitch(shownState, candidate, now - shownStateAt)) {
      shownState = candidate;
      shownStateAt = now;
      return shownState;
    }
    /*
     * 还不能切，但迟早要切 —— 补一个到点重算的定时器。
     *
     * 没有这一步，迟滞会变成"可能永远不切"：settleState 只在推送时被调，
     * 而推送有签名去重，窗口期内状态没别的变化就不会再推一次，
     * 于是"等满 400ms 该切了"这一刻根本没人来采样。
     * dock 那边是 setTimeout 补偿的（src/client.template.js:544），这里对齐。
     */
    if (pendingSwitchTimer === null) {
      const delay = Math.max(0, SWITCH_HOLD_MS - (now - shownStateAt));
      pendingSwitchTimer = setTimeout(() => {
        pendingSwitchTimer = null;
        schedulePush(true);
      }, delay + 16);
      if (typeof pendingSwitchTimer.unref === 'function') pendingSwitchTimer.unref();
    }
    return shownState;
  }

  /**
   * 快照里 updatedAt 每次都变，拿它做去重等于永不命中——等于没有去重。
   * 只比较真正会变的部分：状态、轮次、时长、工具流水。
   * 但时长每秒都在走，所以纯状态去重会让"秒数"停住。
   * 折中：状态变化必推；状态没变时最多每 PUSH_THROTTLE_MS 推一次，
   * 让时长秒数能跟上（渲染端看到的是活的计时器，不是冻住的）。
   */
  function pushNow() {
    const snap = snapshot();
    /*
     * 迟滞在推送出口做，不在 snapshot() 里做——snapshot() 还被
     * /dsh-washer/state 直接读，那是"宿主当下算出来什么"的诊断口径，
     * 掺进迟滞就查不出真问题了。
     */
    snap.state = settleState(snap.state, Date.now());
    // 面板数据（模型/速度/token）也要进签名，否则它们变了却不推——
    // 洗衣机本体不变不代表详情没变。
    const usage = snap.tokenUsage;
    const tokenSig = usage === null ? '' : `${usage.input}/${usage.output}/${usage.cacheRead}`;
    const signature = [
      snap.state, snap.turn, snap.toolCount, snap.durationText, snap.errorCode,
      snap.model, Math.round(snap.speed === null ? -1 : snap.speed), tokenSig,
      // 卡住与否是个开关，不是时长：把秒数进签名会让推送节流失效
      snap.stalledMs === null ? 0 : 1,
    ].join('|');
    const text = JSON.stringify(snap);
    if (signature === lastPushed) return;
    lastPushed = signature;
    lastPushedState = snap.state;
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

  /*
   * ---------------------- 心跳 ----------------------
   *
   * 没有心跳时，"连接还活着"唯一的证据是 TCP 自己报错。而合盖、切网络、
   * 对端进程被 SIGSTOP 时，TCP 不会立刻报——那条 socket 会一直待在
   * clients 里，pushNow 每次遍历都往它缓冲区里写，缓冲区无限增长，
   * 而 catch { clients.delete() } 分支几乎走不到（write 对已死 socket
   * 通常是静默缓冲，不抛）。
   *
   * 做法：每 25 秒给所有连接发一个空 ping；浏览器自动回 pong，
   * 我们只管更新 lastSeen。超过 2 个周期一点动静都没有的连接直接 destroy。
   * 入站帧是浏览器自己生成的（带掩码），我们不解码，只当作心跳证据。
   */
  const HEARTBEAT_MS = 25000;
  /** 连续两个周期没动静就认为死了 */
  const HEARTBEAT_IDLE_MS = HEARTBEAT_MS * 2;
  let heartbeatTimer = null;
  function ensureHeartbeat() {
    if (heartbeatTimer !== null) return;
    heartbeatTimer = setInterval(() => {
      if (clients.size === 0) {
        if (heartbeatTimer !== null) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        return;
      }
      const now = Date.now();
      const ping = encodeWsText('', 0x9);
      for (const socket of clients) {
        const seen = lastSeen.get(socket) ?? 0;
        if (now - seen > HEARTBEAT_IDLE_MS) {
          // 两个周期完全没动静：半开连接，留着只会积压缓冲
          try { socket.destroy(); } catch { /* noop */ }
          clients.delete(socket);
          lastSeen.delete(socket);
          continue;
        }
        if (ping !== null) {
          try {
            // 写不动也说明连接坏了，直接摘掉，别等下一轮
            if (socket.write(ping) === false && socket.writableLength > 256 * 1024) {
              socket.destroy();
              clients.delete(socket);
              lastSeen.delete(socket);
            }
          } catch {
            clients.delete(socket);
            lastSeen.delete(socket);
          }
        }
      }
    }, HEARTBEAT_MS);
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  /** 节流推送：连续工具调用时不让每条事件都走一遍序列化 */
  /**
   * 心跳：没有任何事件时也把快照推下去。
   *
   * 有两条理由必须推，早先只认了第一条：
   *
   * 1. 轮次进行中，时长每秒在变，渲染端得看得到秒数。
   * 2. **「洗完了」是个会自己过期的状态**（doneUntil）——
   *    到期那一刻没有任何事件，全靠时间是推手。
   *
   * 第二条漏掉会出一个很难查的 bug：turn/end 之后 running 变 false，
   * 心跳直接 return，于是浮窗永远停在最后收到的 done 上；而网页端有
   * React 自己的定时器清 sticky，照常回到 idle。两边状态就此分叉，
   * 用户看到的是「悬浮窗说洗完了、dock 说待机」。
   *
   * 空闲且没有保持窗口时完全不占 CPU：那时状态不会自己变。
   */
  let tickTimer = null;
  function ensureTick() {
    if (tickTimer !== null) return;
    tickTimer = setInterval(() => {
      if (clients.size === 0) return;
      const sessionId = viewSessionId();
      if (sessionId === null) return;
      const s = sessions.get(sessionId);
      if (s === undefined) return;
      const now = Date.now();
      /*
       * 「洗完了」是个**会自己过期**的状态（doneUntil 到点回 idle）。
       * 到点那一刻没有任何事件——全靠心跳把它推出去。
       *
       * 早先这里写的是 `if (!s.running) return;`，于是 turn/end 之后
       * 心跳直接跳过，浮窗永远停在最后收到的 done 上；网页端有 React
       * 自己的定时器清 sticky，照常回 idle。两边就此分叉，
       * 用户看到的就是「悬浮窗说洗完了、dock 说待机」。
       *
       * 现在的判据不再是「我这一拍是不是在保持窗口里」（那样会漏掉
       * 两个心跳之间就过期完的情况——比如 doneHoldMs 比 TICK_MS 还短），
       * 而是**当前算出来的状态和上次真正推出去的不一样就补推**。
       * 这个判据不依赖任何时序巧合。
       */
      const current = deriveState(deriveInputOf(sessionId, s, now));
      /*
       * 比的是**迟滞后**的状态，不是刚算出来的那个。
       *
       * 早先这里直接拿 current 比 lastPushedState，可 lastPushedState 记的
       * 是渲染端手上那份（已经过迟滞）。迟滞窗口里两者必然不等，心跳就会
       * 每一拍都认定"状态变了"去补推，把迟滞彻底废掉——等于没加。
       */
      const settled = settleState(current, now);
      if (settled === lastPushedState) {
        // 状态没变。只在「会自己变」的窗口里继续推（秒数在走）
        if (s.running || s.doneUntil > now) schedulePush(true);
        return;
      }
      // 状态和渲染端手上那份不一样了 —— 立刻补推，别让浮窗停在旧状态上
      schedulePush(true);
    }, TICK_MS);
    if (typeof tickTimer.unref === 'function') tickTimer.unref();
  }

  function schedulePush(force = false) {
    if (clients.size === 0) return;
    if (force) {
      // 心跳走的路径：不受「已有 timer 在排队」限制，但也别猛推
      if (pushTimer !== null) return;
    }
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
    /*
     * 心跳账面。浏览器收到 ping 会自动回 pong，我们只需要知道
     * "最近有没有收到过任何字节"来判断这条连接还活着。
     */
    lastSeen.set(socket, Date.now());
    ensureTick();
    ensureHeartbeat();
    // 连上先给一份当前快照，省得渲染端干等下一次变化
    const hello = encodeWsText(JSON.stringify(snapshot()));
    if (hello !== null) socket.write(hello);
    const drop = () => {
      clients.delete(socket);
      lastSeen.delete(socket);
      // 最后一条连接断了就别再让心跳空转
      if (clients.size === 0 && heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
    socket.on('close', drop);
    socket.on('end', drop);
    socket.on('error', drop);
    /*
     * 这是单向推送通道，客户端帧内容一律忽略，但必须消费掉，否则 TCP 反压。
     * 之前这里是个空函数，顺带把"连接是否还活着"也一起丢了——见下面的心跳。
     */
    socket.on('data', () => {
      lastSeen.set(socket, Date.now());
      // 半关闭：对端已经说了再见，往上写不会再有人收
      if (socket.readableEnded) drop();
    });
  }

  /*
   * 带 token 的 127.0.0.1 服务路由表。
   *
   * 此前是一个 handler 里 4 条 `if (url.pathname === ...) { ... return; }` 瀑布，
   * 加端点要在中间插、还得记得每条自己写 405/404。改成 pathname → 方法 → 处理器
   * 的表：新增端点只加一项，鉴权/404/405 由下面的派发器统一兜。
   *
   * 每个处理器签名 (req, res, url)。方法不匹配时回 405 并带 allow 头。
   */
  function createOverlayServer() {
    const STATE_PATH = '/dsh-washer/state';
    const PIN_PATH = '/dsh-washer/pin';
    const HEALTH_PATH = '/dsh-washer/health';
    const PREFS_PATH = '/dsh-washer/prefs';

    const routes = {
      [STATE_PATH]: {
        GET: (req, res) => {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(snapshot()));
        },
      },
      /*
       * 钉住/放开某个会话。
       *
       * GET 一个会改状态的接口会被浏览器预取误触发，所以只收 POST。
       * body 是 {sessionId: string | null}：null 表示回到「跟随最近活动」。
       * 不校验 sessionId 是否已存在——会话可能是刚创建、Host 还没来得及处理的，
       * 钉一个还不存在的 id 不会出事（viewSessionId 会自己回退）。
       */
      [PIN_PATH]: {
        POST: async (req, res) => {
          const read = await readBody(req, res, PREF_BODY_LIMIT);
          if (!read.ok) return;
          const patch = read.value;
          const want = patch && patch.sessionId;
          if (want === null || want === undefined) {
            pinnedSessionId = null;
          } else if (typeof want === 'string' && want.length > 0 && want.length <= 200) {
            pinnedSessionId = want;
          } else {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'sessionId must be a short string or null' }));
            return;
          }
          schedulePush();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ pinnedSessionId }));
        },
      },
      [HEALTH_PATH]: {
        GET: (req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        },
      },
      /*
       * 设置页改悬浮窗大小/皮肤/开关时 POST 到这里。
       * 宿主自己管不了 Electron 窗口，只负责把值落到偏好文件，
       * 主进程 watch 那个文件后自己改窗口——这样不必为改个皮肤重启宿主。
       *
       * 只收 POST 改状态；GET 给设置页读当前值（偏好文件才是真相源，
       * localStorage 只是缓存——用户在浮窗右键菜单里改过的东西，localStorage 不知道）。
       * GET 一个会改状态的接口会被浏览器预取和链接预览误触发。
       */
      [PREFS_PATH]: {
        GET: (req, res) => {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(readOverlayPrefs()));
        },
        POST: async (req, res) => {
          const read = await readBody(req, res, PREF_BODY_LIMIT, { json: false });
          if (!read.ok) return;
          let patch = null;
          try { patch = JSON.parse(read.value); } catch { patch = null; }
          // 走 syncOverlayPrefs 而不是直接写文件：拨开关时要拉起/杀掉进程
          const saved = syncOverlayPrefs(patch);
          if (saved === null) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'bad request' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(saved));
        },
      },
    };

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!authorized(req, url)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const route = routes[url.pathname];
      if (route === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const handler = route[req.method ?? ''];
      if (handler === undefined) {
        const allow = Object.keys(route).join(', ');
        res.writeHead(405, { 'content-type': 'application/json', allow });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      await handler(req, res, url);
    });
    server.on('upgrade', onUpgrade);
    return server;
  }
  const server = createOverlayServer();

  /**
   * 起 HTTP+WS 服务。抽成函数是因为它现在有两条触发路径：
   *   - 启动时桌面悬浮窗配置为开（下面 if (enabled)）
   *   - 运行中用户把「显示悬浮窗」拨到开（syncOverlayPrefs）
   *
   * 早先只有一条，且 launchOverlay() 里写着 `if (!server.listening) return false;`，
   * 于是「启动时关、运行中打开」这条路径永远拉不起进程：服务从没 listen 过，
   * 前置条件直接失败，开关看着就是坏的。
   */
  function startService() {
    if (server.listening) {
      // 已经在听：可能只是用户把开关拨回来了，服务一直在
      launchOverlay();
      return;
    }
    server.once('error', (error) => {
      ctx.logger?.warn?.(`[dsh-washer] overlay service failed: ${error.message}`);
    });
    server.listen(cfg.desktopOverlayPort ?? DEFAULT_PORT, '127.0.0.1', () => {
      port = server.address().port;
      // token 随机、只在内存里，宿主日志又不落盘 —— 光打印的话用户根本拿不到，
      // 调试页等于打不开。落地一个 0600 的运行时文件，进程退出时删掉。
      // 只在服务确实 listen 起来之后才落盘。
      // 早期写法在 listen 回调外调用，port 还可能是探活阶段的临时值，
      // 结果文件里记着一个没人监听的端口——悬浮窗连上去永远是"未连接"。
      if (server.listening && port > 0) persistEndpoint(port, token);
      // 悬浮窗跟着宿主一起活：服务起来了才拉，否则页面连上也是"未连接"。
      // 崩溃不自动重启（见 spawnOverlay 注释）。
      launchOverlay();
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
  }

  if (enabled) {
    startService();
  }

  /*
   * 网页端 → 悬浮窗偏好：走宿主自己的 webServer，同源相对路径。
   *
   * 这条路由跟上面那个 127.0.0.1:随机端口 的服务不是一回事，别混：
   *   - 上面那个：给**独立 Electron 进程**用，必须带 token（其它本机程序也连得上）
   *   - 这条：给**宿主自己的网页**用，同源 fetch，天然只对登录态页面开放
   *
   * 只收 POST：GET 会被链接预取、页面预览之类的自动请求命中，
   * 那种请求不该有副作用。
   */
  if (ctx.webServer !== undefined) {

    /*
     * 偏好变化推送（SSE）：设置页长连着这条，收到就重渲染。
     *
     * 痛点：用户在悬浮窗右键菜单里换了造型。那个改动只到主进程 -> 偏好文件，
     * 设置页读的是 localStorage，它永远不知道文件变了，于是两边长期不一致，
     * 得手动刷新页面才"看起来"同步上——这就是用户报的问题本身。
     */
    ctx.effect(() => ctx.webServer.register({
      /*
       * 必须是 exact 而不是 prefix。
       *
       * 上面那条 /dsh-washer/prefs 是 prefix 匹配，它会把 /dsh-washer/prefs/events
       * 也吃掉——实测连 SSE 收到的是 405 method not allowed，因为事件流用 GET，
       * 而 prefs 那条路（POST-only 时代）只让 POST 过。改成精确匹配把两条路分开。
       */
      kind: 'exact',
      path: WEB_PREFS_EVENTS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' });
          res.end(JSON.stringify({ error: 'method not allowed' }));
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store, no-transform',
          // 关掉 nginx 之类的缓冲，否则事件会攒着不发
          'x-accel-buffering': 'no',
          connection: 'keep-alive',
        });
        // 连上先推一份当前值：页面不用另外发一次 GET，也就没有
        // "先 GET 再连 SSE"中间漏掉一次变更的窗口期。
        res.write(`data: ${JSON.stringify(readOverlayPrefs())}\n\n`);

        const client = { write: (payload) => { try { res.write(payload); } catch { /* 客户端已断 */ } } };
        prefClients.add(client);
        const beat = setInterval(() => {
          // SSE 注释行，客户端不解析，纯粹防连接被中间层掐掉
          client.write(': ping\n\n');
        }, SSE_HEARTBEAT_MS);
        beat.unref?.();

        const drop = () => {
          clearInterval(beat);
          prefClients.delete(client);
        };
        req.on('close', drop);
        req.on('error', drop);
        res.on('error', drop);
      },
    }), 'dsh-washer: web overlay-prefs events');

    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: WEB_PREFS_PATH,
      handler: async (req, res) => {
        /*
         * GET 给设置页：它进页面时要拿当前值。
         *
         * 注意这条是**另一个 handler**，跟上面 127.0.0.1 那个服务里的
         * /dsh-washer/prefs 不是同一份代码——那个是给 Electron 用的、带 token 的。
         * 早先只在那边加了 GET，页面这边一直是 POST-only，
         * 于是设置页拉不到当前值、只能显示 localStorage 里的旧缓存。
         */
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(readOverlayPrefs()));
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, POST' });
          res.end(JSON.stringify({ error: 'method not allowed' }));
          return;
        }
        const read = await readBody(req, res, PREF_BODY_LIMIT, { json: false });
        if (!read.ok) return;
        let patch = null;
        try { patch = JSON.parse(read.value); } catch { patch = null; }
        // 走 syncOverlayPrefs：拨「显示悬浮窗」时要拉起/杀掉进程，
        // 光写文件那段代码走不到，用户看到的就是"开关没反应"
        const saved = syncOverlayPrefs(patch);
        if (saved === null) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad request' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(saved));
      },
    }), 'dsh-washer: web overlay-prefs route');

    /*
     * 客户端 → 宿主：这个会话现在在不在等人。
     *
     * 走同源 HTTP，和 /dsh-washer/prefs 一套路子：不加端口、不加 token、
     * 不碰 CSP。客户端只在 pending **变化**时 POST 一次（一次任务两次），
     * 没有定时器、没有轮询，所以这个端点的负载按 0 算。
     */
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: WEB_PENDING_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
          res.end(JSON.stringify({ error: 'method not allowed' }));
          return;
        }
        const read = await readBody(req, res, PENDING_BODY_LIMIT);
        if (!read.ok) return;
        const payload = read.value;
        if (payload === null || typeof payload !== 'object') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad request' }));
          return;
        }
        const rawId = payload.sessionId;
        if (typeof rawId !== 'string' || rawId === '') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'sessionId required' }));
          return;
        }
        // kind 只认两种；null/undefined 表示"不等了"
        const rawKind = payload.kind;
        if (rawKind !== null && rawKind !== undefined && rawKind !== 'approval' && rawKind !== 'question') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad kind' }));
          return;
        }
        const next = rawKind === null || rawKind === undefined ? null : { kind: rawKind };
        const prev = clientPending.get(rawId);
        const changed = next === null
          ? prev !== undefined
          : (prev === undefined || prev.kind !== next.kind);
        /*
         * 值没变就不写、不推。客户端已经保证了只在变化时发，
         * 这里再挡一道：重复投递不该让浮窗白闪一下。
         */
        if (next === null) clientPending.delete(rawId);
        else clientPending.set(rawId, next);
        if (changed) schedulePush(true);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, changed }));
      },
    }), 'dsh-washer: client pending route');

    /*
     * 告诉客户端「这台机器能做什么」。
     *
     * 用户的诉求是「Windows 上音效暂不支持，设置页隐藏」——但客户端跑在浏览器里，
     * 拿不到 process.platform。所以由宿主把平台事实报上去，页面只负责按它显示。
     *
     * 同一份数据也带上悬浮窗的启动失败原因：Windows 用户装上插件后
     * 面板打开了开关却什么都没发生，早先只在宿主日志里留一行警告，
     * 用户看不到。现在设置页能直接说清楚。
     */
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: WEB_CAPABILITIES_PATH,
      handler: async (req, res) => {
        /*
         * 三个字段各答各的问题，别混：
         *   dock      —— 永远可用。它是宿主渲染进程里的 React，不看平台。
         *   sound     —— 只有 macOS 有（afplay + /System/Library/Sounds）。
         *   overlay   —— 只有 macOS 支持，**且**要找到 Electron 运行时。
         *                前者是平台事实，后者是环境事实，两件事。
         *   overlayReason —— 不可用时说清是哪一种，设置页照它出文案。
         */
        const isMac = process.platform === 'darwin';
        const overlaySupported = overlayPlatformSupported();
        const overlayBinary = overlaySupported ? electronBinary() : null;
        const payload = {
          platform: process.platform,
          dock: true,
          sound: isMac,
          overlay: overlaySupported && overlayBinary !== null,
          overlayReason: !overlaySupported
            ? 'platform'
            : (overlayBinary === null ? 'missing' : null),
          overlayError: overlayLaunchError,
        };
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(payload));
      },
    }), 'dsh-washer: capabilities route');

    /*
     * 客户端问「这一轮是不是被用户按停的」。
     *
     * 为什么需要：dock 跑在浏览器里，useChat legacy 只给
     * nodes / turnTimings / turnEnds / partial / runningCalls，
     * turnEnds 里只有 seq、没有 reason —— 判断不了"按停"和"干完了"。
     * 宿主这边 isUserAbort() 判得准，所以客户端在 running 从 true 变 false
     * 那一刻来问一次，拿到的是这一轮的最终裁决。
     *
     * 同源、无 token、GET，只回 { stoppedTurn }，不含任何会话内容。
     */
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: WEB_STOP_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' });
          res.end(JSON.stringify({ error: 'method not allowed' }));
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const sessionId = url.searchParams.get('sessionId');
        const s = sessionId === null ? undefined : sessions.get(sessionId);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ stoppedTurn: s === undefined ? -1 : s.stoppedTurn }));
      },
    }), 'dsh-washer: stop query route');

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

  /*
   * 会话关掉就把它的状态丢掉。
   *
   * 早先 sessions 只 set 不 delete：每开过一个会话就永久留一份
   * createSessionState()（含最近 200 条节点、token 采样、最多 50 轮计时）。
   * 一天开几十个会话，几天下来内存单调增长，而且没有任何东西会回收它。
   *
   * 不接这个事件也不会崩（地图上限就那么点），但接了才是对的：
   * 会话生命周期结束，它攒的那一份状态就没有读者了。
   */
  ctx.on('session/disposed', (session) => {
    const sessionId = resolveSessionId(session);
    if (sessionId === null) return;
    sessions.delete(sessionId);
    if (currentSessionId === sessionId) currentSessionId = null;
    // 钉住的会话没了就自动放开，否则 viewSessionId 会一直回退到跟随，
    // 但 UI 上还显示着"已钉住"——那是在骗人。
    if (pinnedSessionId === sessionId) pinnedSessionId = null;
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

  /*
   * 「在等你」这件事有**两条**独立的事件，别只接一条。
   *
   * 网页端从 `useSessionStatus().pendingInteraction` 就能知道在等用户，
   * 但那是**客户端** uiSession 的投影：客户端插件分别靠
   * `ctx.remote.$on('approval/request')` 和 `ctx.remote.$on('user-questions/request')`
   * 拦截到请求才有值。Host 侧没有那个投影，浮窗这一路原本写死
   * `pending: undefined`，最该提醒的时刻反而不提醒。
   *
   * 两条的语义不一样，用户都要看到：
   *   approval/request       —— 工具授权，批不批
   *   user-questions/request —— ask_user_question 在向你提问
   *
   * 只接审批那条的话，模型一提问，浮窗就会显示"漂洗中"继续转，
   * 而网页端明明停在"等你确认"——两边打架。
   *
   * 两条都是 **waterfall**：必须把 `next()` 的结果原样返回，
   * 否则审批/提问链在这里断掉，整个会话卡死。所以我们只做观察，不做决策。
   *
   * 生命周期：请求进来记一条，promise settle（回答/批准/拒绝/取消/中断都算）
   * 就删掉。用计数而不是布尔，是因为同一会话可能同时挂着多个。
   */
  function bumpPending(sessionId, delta) {
    const next = (pendingApprovals.get(sessionId) || 0) + delta;
    if (next <= 0) pendingApprovals.delete(sessionId);
    else pendingApprovals.set(sessionId, next);
    schedulePush();
  }

  /**
   * 挂一个只观察、不干预的 waterfall 监听。
   *
   * 两条事件的结构一致（请求对象上都带 `agent`，见宿主里
   * `{...request, agent}` 的构造），所以共用这一段。
   */
  function watchPendingRequest(eventName) {
    ctx.on(eventName, (request, next) => {
      const sessionId = resolveSessionId(request && request.agent && request.agent.session)
        ?? resolveSessionId(request && request.agent && request.agent.id)
        ?? resolveSessionId(request && request.agent)
        ?? currentSessionId;
      if (sessionId === null) return next();
      bumpPending(sessionId, 1);
      let result;
      try {
        result = next();
      } catch (error) {
        bumpPending(sessionId, -1);
        throw error;
      }
      // next() 正常会返回 promise；万一返回同步值也要收尾，不能少减一次
      return Promise.resolve(result).finally(() => bumpPending(sessionId, -1));
    });
  }

  watchPendingRequest('approval/request');
  watchPendingRequest('user-questions/request');


  // 卸载：先断连接再关端口，顺序反了会让已连的悬浮窗挂在半开状态
  ctx.effect(() => () => {
    if (pushTimer !== null) clearTimeout(pushTimer);
    if (tickTimer !== null) clearInterval(tickTimer);
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    /*
     * 插件热重载时，disposer 跑的是**旧实例**，但文件里记的是新实例的 pid+token，
     * isOwnEndpoint 会拦住不删——这是对的。
     * 真正要命的是另一种情况：新实例启动稍晚，旧实例先删了文件，
     * 之后新实例因为端口复用失败或别的原因没写成，端点信息就彻底没了。
     * 所以卸载时不主动删，留给下次启动覆盖写。文件内容是 0600 的本地端点信息，
     * 残留一份不影响安全，但丢了就没法开悬浮窗。
     */
    for (const socket of clients) {
      try { socket.destroy(); } catch { /* noop */ }
    }
    clients.clear();
    lastSeen.clear();
    // SSE 客户端集合也要断干净：每个 client 背后是一条 keep-alive 连接，
    // clear 掉 Set 只是丢了引用，连接本身得靠 server.close 收；这里顺带清空，
    // 避免卸载后残留的引用让 pushPrefs 还往已关的端口写。
    prefClients.clear();
    if (server.listening) server.close();
    /*
     * 宿主走了悬浮窗也该走，否则它连着一个已经关闭的端口，
     * 永远显示"未连接"——比没有还糟。
     * 只在自己拉起过的时候杀：手动 ./electron/start.sh 起的那个由用户自己管。
     */
    shutdownOverlay();
  }, 'dsh-washer: overlay service');

  /*
   * 设置页改了悬浮窗偏好：先落盘，再让运行中的东西跟着动。
   *
   * 落盘之后 Electron 侧还有两件事要做，分两条路：
   *   - size / skin：主进程在 watch 偏好文件，自己就会跟上（见 electron/main.cjs）
   *   - show：进程根本不在的时候没人 watch，只能宿主自己处理——
   *       开 → 拉起进程；关 → 杀掉进程
   *
   * 这也是"显示悬浮窗开关没生效"的根因：早期版本 enabled 是 apply 时算一次的
   * 常量，运行中拨开关只会写文件，拉起/杀进程那段代码根本走不到。
   */
  const syncOverlayPrefs = (patch) => {
    const saved = writeOverlayPrefs(patch);
    if (saved === null) return null;
    if (patch !== null && typeof patch === 'object' && typeof patch.show === 'boolean') {
      enabled = patch.show;
      if (enabled) {
        /*
         * 先起服务再拉窗口。顺序不能反：窗口一起来就连 HTTP+WS，
         * 服务还在 listen 的路上，页面会先渲染一帧"未连接"。
         *
         * 关于"关掉时要不要停服务"：不停。这条 Web 路由本身就挂在宿主
         * 的 webServer 上，跟这个 127.0.0.1 服务无关；而服务停了之后
         * 下次打开要重新 listen + 落端点文件，白白多一段竞态。
         * 服务很小（一个 http server + 零连接），留着比反复起停稳。
         */
        startService();
      } else {
        shutdownOverlay();
      }
    }
    /*
     * 广播给所有设置页。这里覆盖了「悬浮窗右键菜单改了 → 设置页跟着变」
     * 那条反向路径：主进程改完文件会 POST 回这里，走到这一行。
     * 设置页自己改的时候也会推一次，客户端拿到同样的值，幂等。
     */
    pushPrefs();
    return saved;
  };

  /*
   * 给测试用的内省口（导出在 apply 之外拿不到，挂到闭包上）
   *
   * syncOverlayPrefs 是设置页和悬浮窗之间唯一的桥。
   * 之前客户端那边想用 props.washerEndpoint 自己拼 HTTP 请求，但客户端插件
   * 根本没有这个注入项，首行就 return 了，POST 一次都没发出去——功能看着写了，
   * 实际静默不工作。改成宿主直接给函数：不用端点、不用端口、不过 CSP，
   * 也不会把 token 暴露给页面。
   */
  return {
    port: () => port,
    snapshot,
    syncOverlayPrefs,
  };
}

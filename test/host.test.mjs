/**
 * Host 半的单元测试。
 *
 * 重点不是「函数能跑」，而是 B3 那条产品命门：
 * **状态不许撒谎**——工具回来后必须回到 washing，不能卡在 rinsing。
 * 这条偏偏是离线的浏览器测试覆盖不到的，因为 Host 侧是另一套事件来源。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';

import {
  foldEvent, encodeWsText, apply, isOwnEndpoint, speedOf, rankTools,
  endFailureOf, isUserAbort, writeOverlayPrefs,
} from '../index.js';
import { deriveState } from '../src/core.js';

/**
 * 测试专用端点路径：绝不能碰 ~/.dsh 下的真实文件（宿主服务在用它）。
 *
 * 这里在**模块加载时**就设好，而不是靠每个用例记得调 useTestEndpoint()。
 * 曾经是后者：新增用例忘了调，apply() 一跑就把运行中宿主的端点文件
 * 覆盖成测试实例的 pid/端口，测试退出后那份记录成了死数据，
 * 悬浮窗只能显示"未连接"。忘一次就踩一次，所以改成加载即生效。
 */
const TEST_ENDPOINT = '/tmp/dsh-washer-test-endpoint.json';
process.env.DSH_WASHER_ENDPOINT_FILE = TEST_ENDPOINT;

/**
 * 同理，偏好文件也必须隔离。
 *
 * 这份文件是设置页和悬浮窗之间唯一的桥，运行中的宿主和真实的 Electron
 * 进程都在 watch 它。跑单测时往里面写真数据有两个后果：
 *   1) 用户开着悬浮窗时跑一次测试，窗口会被测试的偏好改掉；
 *   2) 测试写进去的值留在真实文件里，看起来像"用户自己改的"。
 * 和端点文件一样，模块加载时就钉死路径，不靠用例记得调。
 */
const TEST_PREFS = '/tmp/dsh-washer-test-prefs.json';
process.env.DSH_WASHER_PREFS_FILE = TEST_PREFS;

function useTestEndpoint() {
  process.env.DSH_WASHER_ENDPOINT_FILE = TEST_ENDPOINT;
  process.env.DSH_WASHER_PREFS_FILE = TEST_PREFS;
}

function freshState() {
  return {
    turn: 0,
    runningCalls: [],
    partial: null,
    nodes: [],
    callStartedAt: new Map(),
    turnTimings: new Map(),
    running: false,
    usage: null,
    model: null,
    lastUsage: null,
    tokenSamples: [],
    doneUntil: 0,
  };
}

const ev = (type, data) => ({ type, data, seq: 1 });
const NOW = 1_700_000_000_000;

test('turn/start 开新轮：清空上一轮的节点与进行中的调用', () => {
  const s = freshState();
  foldEvent(s, ev('tool/call', { turn: 1, name: 'bash', callId: 'a' }), NOW);
  assert.equal(s.runningCalls.length, 1, '调用应该记上');

  foldEvent(s, ev('turn/start', { turn: 2 }), NOW + 100);
  assert.equal(s.turn, 2);
  assert.deepEqual(s.runningCalls, [], '新一轮不该继承上一轮的运行中调用');
  assert.deepEqual(s.nodes.map((n) => n.kind), ['turn-start'], '节点只留新一轮的');
  assert.equal(s.turnTimings.get(2).startTime, NOW + 100, '要记下起轮时间');
});

test('tool/call 后 tool/result 必须消账（否则永远卡在 rinsing）', () => {
  const s = freshState();
  foldEvent(s, ev('turn/start', { turn: 1 }), NOW);
  foldEvent(s, ev('tool/call', { turn: 1, name: 'bash', callId: 'c1' }), NOW + 10);
  assert.equal(s.runningCalls.length, 1);

  foldEvent(s, ev('tool/result', { turn: 1, callId: 'c1' }), NOW + 50);
  assert.equal(s.runningCalls.length, 0, '结果回来必须把调用从运行中移除');
  assert.equal(s.nodes[s.nodes.length - 1].kind, 'tool-result');
});

test('多个工具并发时按 callId 精确消账，不乱序', () => {
  const s = freshState();
  foldEvent(s, ev('turn/start', { turn: 1 }), NOW);
  foldEvent(s, ev('tool/call', { turn: 1, name: 'read', callId: 'c1' }), NOW + 1);
  foldEvent(s, ev('tool/call', { turn: 1, name: 'grep', callId: 'c2' }), NOW + 2);
  foldEvent(s, ev('tool/result', { turn: 1, callId: 'c1' }), NOW + 3);

  assert.deepEqual(s.runningCalls.map((c) => c.callId), ['c2'], 'c1 结束不该误删 c2');
});

test('callId 缺失时退化成 FIFO，不会永久卡住', () => {
  const s = freshState();
  foldEvent(s, ev('turn/start', { turn: 1 }), NOW);
  foldEvent(s, ev('tool/call', { turn: 1, name: 'bash', callId: 'x' }), NOW + 1);
  // 宿主老版本/异常路径可能不带 callId
  foldEvent(s, ev('tool/result', { turn: 1 }), NOW + 2);
  assert.equal(s.runningCalls.length, 0, '没有 callId 也必须能消账');
});

test('turn/end 收口：清空运行中调用并记下结束时间', () => {
  const s = freshState();
  foldEvent(s, ev('turn/start', { turn: 1 }), NOW);
  foldEvent(s, ev('tool/call', { turn: 1, name: 'bash', callId: 'c1' }), NOW + 5);
  foldEvent(s, ev('turn/end', { turn: 1 }), NOW + 500);

  assert.deepEqual(s.runningCalls, []);
  assert.equal(s.turnTimings.get(1).endTime, NOW + 500);
});

test('未知事件不炸，也不改状态', () => {
  const s = freshState();
  foldEvent(s, ev('turn/start', { turn: 1 }), NOW);
  const before = JSON.stringify(s);
  foldEvent(s, ev('something/new', { foo: 1 }), NOW + 1);
  assert.equal(JSON.stringify(s), before, '不认识的事件必须原样放过');
});

test('step/end 不能让状态倒退成 starting（渲染端会看到「又启动了」）', () => {
  // 实测过：core.js 只认 OUTPUT_NODE_KINDS 判断「走到哪」，
  // step-* 不在白名单里。若把它记进 nodes，工具结果之后来一条 step/end，
  // 状态就从 washing 掉回 starting——看上去像重新开始洗，是在撒谎。
  const s = freshState();
  foldEvent(s, ev('turn/start', { turn: 1 }), NOW);
  foldEvent(s, ev('tool/call', { turn: 1, name: 'bash', callId: 'c1' }), NOW + 1);
  foldEvent(s, ev('tool/result', { turn: 1, callId: 'c1' }), NOW + 2);
  const kindsBefore = s.nodes.map((n) => n.kind);

  foldEvent(s, ev('step/end', { turn: 1, step: 1 }), NOW + 3);
  assert.deepEqual(s.nodes.map((n) => n.kind), kindsBefore, 'step-* 不该进节点序列');
});

test('节点上限 200：长任务不会无限吃内存', () => {
  const s = freshState();
  foldEvent(s, ev('turn/start', { turn: 1 }), NOW);
  // 用 tool-result 灌（step-* 现在故意不记节点，灌不动了）
  for (let i = 0; i < 500; i += 1) {
    foldEvent(s, ev('tool/call', { turn: 1, name: 'bash', callId: 'c' + i }), NOW + i);
    foldEvent(s, ev('tool/result', { turn: 1, callId: 'c' + i }), NOW + i);
  }
  assert.equal(s.nodes.length, 200, '节点应被裁到 200 条');
});

test('WS 帧编码：短文本、中等文本都带正确的 FIN+opcode', () => {
  const short = encodeWsText('hi');
  assert.equal(short[0], 0x81, 'FIN + text opcode');
  assert.equal(short[1], 2, 'payload 长度');
  assert.equal(short.subarray(2).toString(), 'hi');

  const medium = encodeWsText('x'.repeat(300));
  assert.equal(medium[0], 0x81);
  assert.equal(medium[1], 126, '超过 125 字节要用 16 位长度');
  assert.equal(medium.readUInt16BE(2), 300);
  assert.equal(medium.length, 4 + 300);
});

test('WS 帧编码：超过 64KB 返回 null（不静默截断）', () => {
  assert.equal(encodeWsText('x'.repeat(70000)), null);
});

/* ------------------------------------------------------------------ *
 * apply()：起服务、鉴权、可卸载
 * ------------------------------------------------------------------ */

/**
 * 每个用例开工前把偏好文件清干净。
 *
 * apply() 现在启动时会读偏好文件当作用户真实设置（否则每次启动都先
 * 冒出默认造型，几百毫秒后才被 watchPrefs 纠正）。副作用是：上一个
 * 用例留下的 {"show":true} 会被下一个用例当成用户配置读走，
 * 于是「desktopOverlay:false 不该起服务」这种断言莫名其妙失败。
 *
 * 这种污染靠"记得在用例里清理"是防不住的——一定会漏。放在 makeCtx
 * 里统一清，因为它几乎是所有用例的入口。
 */
let PRESERVE_PREFS = false;
function resetPrefsFile() {
  if (PRESERVE_PREFS) { PRESERVE_PREFS = false; return; }
  try {
    rmSync(TEST_PREFS, { force: true });
  } catch { /* 没有就没有 */ }
}

function makeCtx() {
  resetPrefsFile();
  /*
   * 端点文件是**上一轮实例**留下的：里面记着旧进程的 pid 和旧 token。
   * 不删的话，本用例去读它会拿到过期 token —— 请求直接 401，
   * 但这个 401 跟被测逻辑毫无关系，排查时会一路找错方向。
   */
  try { rmSync(TEST_ENDPOINT); } catch { /* 本来就没有 */ }
  const handlers = new Map();
  const disposers = [];
  /*
   * 假的 webServer：只把注册的路由收着，测试自己调 handler。
   *
   * 真实宿主里这些路由挂在页面同源服务上，没有 token，所以测试也不该
   * 拿 token 去打——那测的就不是同一条路了。routes 用 path 索引，
   * 同一个 path 重复注册以最后一次为准（和真实 webServer 行为一致）。
   */
  const routes = new Map();
  const webServer = {
    register: (spec) => {
      routes.set(spec.path, spec);
      return () => { routes.delete(spec.path); };
    },
  };
  return {
    handlers,
    routes,
    webServer,
    dispose: () => { for (const d of disposers) d(); },
    on: (name, fn) => { handlers.set(name, fn); },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); },
    logger: { info: () => {}, warn: () => {} },
  };
}

/**
 * 直接调一个已注册的同源路由 handler。
 *
 * 造最小的 req/res 鸭子对象：handler 只用到 method / on('data'|'end') /
 * writeHead / end / destroy，照着它要的形状给就行。
 */
function callRoute(ctx, path, method, body) {
  // path 可以带查询串（如 /dsh-washer/stop?sessionId=s1）：
  // 路由是按 pathname 精确注册的，所以查表用去掉查询串那一段；
  // 但 handler 里读 req.url / req.url.searchParams，所以要原样带上。
  const queryIndex = path.indexOf('?');
  const routeKey = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const spec = ctx.routes.get(routeKey);
  assert.ok(spec !== undefined, `路由 ${routeKey} 必须注册过`);
  const chunks = [];
  const req = {
    method,
    url: path,
    headers: {},
    destroy: () => {},
    on: (event, fn) => {
      if (event === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body)));
      if (event === 'end') fn();
    },
  };
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: null,
      writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
      end(payload) {
        let parsed = null;
        try { parsed = payload === undefined ? null : JSON.parse(payload); } catch { parsed = payload; }
        chunks.push({ status: this.statusCode, body: parsed });
        resolve({ status: this.statusCode, body: parsed });
      },
    };
    spec.handler(req, res);
  });
}

function get(port, path, token) {
  return new Promise((resolve, reject) => {
    const query = token === undefined ? '' : `?token=${encodeURIComponent(token)}`;
    const req = httpRequest(
      { host: '127.0.0.1', port, path: path + query, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 开一条 WebSocket 读推送流。
 *
 * 测试里要用真实的 WS 客户端，不能直接调 api.snapshot()：
 * snapshot() 是按时间现算的，它一直是对的；出问题的是"没人去推"。
 * 只断言 snapshot 会漏掉整类 bug（用户报的悬浮窗/dock 打架就是这种）。
 */
async function openWs(port, onText) {
  const info = JSON.parse(readFileSync(TEST_ENDPOINT, 'utf8'));
  const socket = new WebSocket(`ws://127.0.0.1:${port}/dsh-washer/stream?token=${info.token}`);
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') onText(event.data);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return socket;
}

async function waitForPort(api, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    const p = api.port();
    if (p > 0) return p;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('服务没有起来');
}

test('apply：desktopOverlay 关闭时不监听端口', () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false });
  assert.equal(api.port(), 0, '默认不该占端口');
  ctx.dispose();
});

test('apply：开启后能取到快照，且无请求头时拒绝未授权访问', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  const port = await waitForPort(api);
  assert.ok(port > 0);

  // 不带 token 一律 401
  const denied = await get(port, '/dsh-washer/state');
  assert.equal(denied.status, 401);

  const healthDenied = await get(port, '/dsh-washer/health');
  assert.equal(healthDenied.status, 401, '健康探针也要鉴权，别给探测留口子');

  ctx.dispose();
});

test('apply：鉴权通过后 state 返回合法快照，无会话时为 off', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  const port = await waitForPort(api);

  // 用内部快照直接取（token 是私有的，HTTP 侧鉴权已在上一条验过）
  const snap = api.snapshot();
  assert.equal(snap.version, 1);
  assert.equal(snap.state, 'off', '没有会话时应是 off');
  assert.ok(Array.isArray(snap.tools));

  ctx.dispose();
});

test('apply：事件能把状态推到 washing（B3 不撒谎）', () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false });

  const onEvent = ctx.handlers.get('session/event');
  assert.ok(typeof onEvent === 'function', '必须订阅 session/event');

  // 起轮 + 模型在出字（running 由事件推导）
  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));
  let snap = api.snapshot();
  // turn/start 的瞬间还没有产出节点 → starting，这是对的
  assert.ok(['starting', 'washing'].includes(snap.state), `起轮态应合理，实际 ${snap.state}`);

  // 工具调用 → rinsing。此刻工具还在跑，流水里当然还没有它（recentTools 只收已完成的结果）
  onEvent({ id: 's1' }, ev('tool/call', { turn: 1, name: 'bash', callId: 'c1' }));
  snap = api.snapshot();
  assert.equal(snap.state, 'rinsing', '调工具时必须切 rinsing');

  // 工具返回 → 必须回到 washing，且流水里能查到这一步
  onEvent({ id: 's1' }, ev('tool/result', { turn: 1, callId: 'c1', name: 'bash' }));
  snap = api.snapshot();
  assert.notEqual(snap.state, 'rinsing', '工具回来后不能还停在 rinsing（状态撒谎）');
  assert.equal(snap.tools.length, 1, '完成的工具要进流水');
  assert.equal(snap.tools[0].name, 'bash', '流水里必须有工具名');
  assert.equal(typeof snap.tools[0].ms, 'number', '要有耗时（callTime→time 算出来）');
  assert.equal(snap.toolCount, 1);

  ctx.dispose();
});

test('端点信息落盘：文件权限 0600，卸载后自动删除', async () => {
  const { readFileSync, statSync, existsSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  useTestEndpoint();
  const file = TEST_ENDPOINT;

  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  const port = await waitForPort(api);
  assert.ok(port > 0);

  assert.equal(existsSync(file), true, '服务起来后要落地端点文件，否则用户拿不到 token');
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `token 文件必须是 0600，实际 ${mode.toString(8)}`);

  const info = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(info.port, port);
  assert.equal(typeof info.token, 'string');
  assert.ok(info.token.length >= 20, 'token 不能太短');
  // port 和 pid 都是五位数，人很容易挑错；给个拼好的 url
  assert.equal(
    info.url,
    `http://127.0.0.1:${port}/dsh-washer/state?token=${info.token}`,
    '要给现成的 url，别让人自己拼',
  );

  ctx.dispose();
  await new Promise((r) => setTimeout(r, 50));
  /*
   * 卸载后**故意不删**。
   * 早先的实现在这里 rm，结果插件热重载时旧实例先把文件删了、
   * 新实例又因为各种原因没写成，端点信息就彻底丢了——实测发生过一次，
   * 悬浮窗只能显示"未连接"。文件是 0600 的本地端点，留一份不影响安全，
   * 丢了却没法开悬浮窗，所以宁可留。
   */
  assert.equal(existsSync(file), true, '卸载后要留着，否则悬浮窗找不到端口和 token');
  const leftover = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(typeof leftover.port, 'number');
  assert.equal(typeof leftover.token, 'string');
});

test('拿落盘的 token 真的能访问 state（证明这条路是通的）', async () => {
  const { readFileSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');

  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  const port = await waitForPort(api);

  useTestEndpoint();
  const { token } = JSON.parse(readFileSync(TEST_ENDPOINT, 'utf8'));
  const ok = await get(port, '/dsh-washer/state', token);
  assert.equal(ok.status, 200, '拿文件里的 token 必须能过鉴权');
  const snap = JSON.parse(ok.body);
  assert.equal(snap.version, 1);

  ctx.dispose();
});

test('tool/result 的真实结构：callId 藏在 message 里，也能对上号', () => {
  // 真实事件长这样（从会话日志里拷的）：
  // { type:'tool/result', data:{ turn, step, message:{ role:'tool',
  //   source:{ kind:'tool', callId }, toolCallId, content, isError } } }
  // 早期实现只读 data.callId，取不到就走"弹掉最早那个"的兜底，
  // 结果工具名全变成 'tool'、耗时也算错。
  const s = freshState();
  foldEvent(s, ev('turn/start', { turn: 1 }), NOW);
  foldEvent(s, ev('tool/call', { turn: 1, name: 'bash', callId: 'call_ABC' }), NOW + 10);
  foldEvent(s, ev('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId: 'call_ABC' },
      toolCallId: 'call_ABC',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    },
  }), NOW + 60);

  const last = s.nodes[s.nodes.length - 1];
  assert.equal(last.kind, 'tool-result');
  assert.equal(last.callId, 'call_ABC', '必须从 message 里取到 callId');
  assert.equal(last.name, 'bash', '名字要从调用侧回填，不能是 tool');
  assert.equal(last.callTime, NOW + 10);
  assert.equal(last.ms === undefined, true, 'ms 不是 core.js 认的字段');
});

test('tool/result 的 message.isError 要能识别成错误', () => {
  const s = freshState();
  foldEvent(s, ev('turn/start', { turn: 1 }), NOW);
  foldEvent(s, ev('tool/call', { turn: 1, name: 'bash', callId: 'c1' }), NOW + 1);
  foldEvent(s, ev('tool/result', {
    turn: 1,
    message: { toolCallId: 'c1', isError: true },
  }), NOW + 2);
  const last = s.nodes[s.nodes.length - 1];
  assert.equal(last.isError, true, '错误状态在 message 里，别漏了');
});

test('两个实例交替卸载：后启动的那个的文件不能被先启动的删掉', async () => {
  // 插件被热重载时会出现两个实例短暂共存。
  // 早期用模块级变量记文件路径，旧实例的 disposer 会把新实例写的文件删掉，
  // 表现为「服务在跑但用户找不到端口和 token」。
  const { existsSync, readFileSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  useTestEndpoint();
  const file = TEST_ENDPOINT;

  const ctxA = makeCtx();
  const a = apply(ctxA, { desktopOverlay: true, desktopOverlayPort: 0 });
  const portA = await waitForPort(a);

  // 第二个实例覆盖了文件（真实场景里它会拿到另一个端口）
  const ctxB = makeCtx();
  const b = apply(ctxB, { desktopOverlay: true, desktopOverlayPort: 0 });
  const portB = await waitForPort(b);
  assert.notEqual(portA, portB, '两个实例应该拿到不同端口');

  // A 卸载——不能影响 B 的文件
  ctxA.dispose();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(existsSync(file), true, 'A 卸载不该删掉 B 的文件');
  const info = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(info.port, portB, '文件应该还是 B 写的');

  ctxB.dispose();
  await new Promise((r) => setTimeout(r, 50));
  // 同样不删：留着 B 的端点信息，下次启动覆盖写
  assert.equal(existsSync(file), true, '卸载不再删文件，留给下次启动覆盖');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).port, portB, '留下的还是 B 写的那份');
});

test('计时真的会走：turnTimings 必须用 core.js 认的结构', () => {
  // elapsedOf 读的是 Map.get(turn).startTime，写成普通对象就永远返回 undefined，
  // 表现为页面上时长一直是 00:00。
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false });

  const started = Date.now();
  ctx.handlers.get('session/event')({ id: 's1' }, ev('turn/start', { turn: 1 }));
  let snap = api.snapshot();
  assert.notEqual(snap.durationText, '--:--', `解析不到时长，durationText=${snap.durationText}`);

  // 制造 100ms 时间差后再取一次，时长应明显变大
  const spin = Date.now() + 100;
  while (Date.now() < spin) { /* busy wait，避免引入假定时器 */ }
  snap = api.snapshot();
  assert.ok(snap.elapsedMs >= 100, `时长应该走了至少 100ms，实际 ${snap.elapsedMs}`);

  ctx.handlers.get('session/event')({ id: 's1' }, ev('turn/end', { turn: 1 }));
  snap = api.snapshot();
  assert.equal(typeof snap.lastEndedAt, 'number', 'lastEndedAt 要有值，否则 UI 判断不了"刚洗完"');
  assert.ok(snap.lastEndedAt >= started);

  ctx.dispose();
});

test('端点文件里记的端口必须是真正 listen 的那个', async () => {
  // 早期在 listen 回调外落盘，port 可能还是探活阶段的临时值，
  // 文件里记着一个没人监听的端口，悬浮窗连上去永远"未连接"。实测踩过一次。
  useTestEndpoint();
  const file = TEST_ENDPOINT;
  const { rmSync, readFileSync } = await import('node:fs');
  rmSync(file, { force: true });

  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  const livePort = await waitForPort(api);

  const info = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(info.port, livePort, '文件记的端口必须和真正 listen 的一致');
  // 拿文件里的端口真去访问一次，能通才说明这个端口是对的
  const res = await fetch(`http://127.0.0.1:${info.port}/dsh-washer/health?token=${info.token}`);
  assert.equal(res.status, 200, '文件里的 port 必须能真的连上');
  ctx.dispose();
  rmSync(file, { force: true });
});

test('assistant/message 的 usage 要记录下来（详情面板的数据源）', () => {
  const state = freshState();
  const usage = { inputTokens: 8081, outputTokens: 1270, cacheReadTokens: 16640, cacheWriteTokens: 0, totalTokens: 25991 };
  foldEvent(state, {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' }, id: 'x' },
      usage,
    },
  }, 1000);
  assert.equal(state.usage.input, 8081);
  assert.equal(state.usage.output, 1270);
  assert.equal(state.usage.cacheRead, 16640);
  assert.equal(state.model, 'deepseek-flash');
});

test('速度按累计 token 的差值算，不是按采样次数', () => {
  // usage 是累加值：第二条 2000 表示累计到 2000，不是"这条用了 2000"。
  // 拿它当每条的量会算出 3 倍速度。
  const samples = [
    { at: 0, output: 0 },
    { at: 1000, output: 500 },
    { at: 2000, output: 1000 },
  ];
  const speed = speedOf(samples, 2000, 5000);
  assert.equal(speed, 500, '2000ms 内累计 1000 token → 500 tok/s');
});

test('工具排行按耗时倒序，同名工具合并取最大值', () => {
  // 面板要回答"哪个工具在拖后腿"，逐次罗列反而看不清。
  const nodes = [
    { kind: 'tool-result', turn: 1, name: 'bash', callTime: 0, time: 1200, isError: false },
    { kind: 'tool-result', turn: 1, name: 'read', callTime: 0, time: 300, isError: false },
    { kind: 'tool-result', turn: 1, name: 'bash', callTime: 0, time: 3500, isError: true },
  ];
  const ranked = rankTools(nodes, 1);
  assert.equal(ranked.length, 2, '两个不同工具');
  assert.equal(ranked[0].name, 'bash');
  assert.equal(ranked[0].ms, 3500, '同名取最大耗时');
  assert.equal(ranked[0].calls, 2);
  assert.equal(ranked[0].isError, true, '任一次出错就标记');
});

test('工具排行只看当前轮', () => {
  const nodes = [
    { kind: 'tool-result', turn: 1, name: 'bash', callTime: 0, time: 9000, isError: false },
    { kind: 'tool-result', turn: 2, name: 'read', callTime: 0, time: 100, isError: false },
  ];
  const ranked = rankTools(nodes, 2);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].name, 'read');
});

test('采样点不足或时间差为零时速度返回 null，不编数字', () => {
  assert.equal(speedOf([], 1000), null);
  assert.equal(speedOf([{ at: 0, output: 100 }], 1000), null);
  assert.equal(speedOf([{ at: 500, output: 100 }, { at: 500, output: 200 }], 500), null);
});

test('窗口内只有一个采样点时，退到最近两次采样算速度（否则速度永远不显示）', () => {
  // 真实场景：一次工具调用要好几秒，中间没有 assistant/message，
  // 5 秒窗口里常常只有一个采样点。旧实现这时返回 null，速度就永远显示 —。
  const samples = [
    { at: 0, output: 100 },
    { at: 8000, output: 900 },   // 8 秒后才来第二条
  ];
  const speed = speedOf(samples, 8000, 5000);
  assert.equal(speed, 100, '800 增量 / 8 秒 = 100 tok/s');
});

test('最近一次采样太旧时不算速度（陈年数据不是当前速度）', () => {
  const samples = [
    { at: 0, output: 100 },
    { at: 1000, output: 900 },
  ];
  // 20 秒没新产出，还报 800 tok/s 就是骗人
  assert.equal(speedOf(samples, 21000, 5000), null);
});

test('输出没有增长时速度返回 null，不编 0', () => {
  const samples = [
    { at: 0, output: 500 },
    { at: 1000, output: 500 },
  ];
  assert.equal(speedOf(samples, 1000, 5000), null);
});

test('累计值回退时速度返回 null（会话切换或计数重置）', () => {
  const samples = [
    { at: 0, output: 5000 },
    { at: 1000, output: 100 },
  ];
  assert.equal(speedOf(samples, 1000, 5000), null);
});

test('端点文件只由自己的进程删（pid/token/port 三项都要对上）', () => {
  // 这个文件是悬浮窗和用户找端口/token 的唯一入口。
  // 早期实现用模块级变量记住路径，插件重载时新旧实例互相踩，
  // 旧实例卸载时把新实例刚写的文件删了 —— 服务还在跑但端点信息没了。
  const mine = { pid: 100, token: 'abc', port: 1234 };
  assert.equal(isOwnEndpoint(mine, 1234, 'abc', 100), true, '三项全对上才允许删');

  assert.equal(isOwnEndpoint(mine, 1234, 'abc', 200), false, '换了进程就別删——这是重载后的新实例');
  assert.equal(isOwnEndpoint(mine, 1234, 'zzz', 100), false, 'token 不同说明是别的实例');
  assert.equal(isOwnEndpoint(mine, 9999, 'abc', 100), false, '端口不同说明是别的实例');

  assert.equal(isOwnEndpoint(null, 1234, 'abc', 100), false, '文件不存在或读坏了，没得删');
  assert.equal(isOwnEndpoint('garbage', 1234, 'abc', 100), false, '解析出乱七八糟的东西也不该删');
});

test('推送去重不能按整份快照比（updatedAt 每次都变 = 永不命中）', () => {
  // 早期拿整份 JSON 字符串做去重，快照里有 updatedAt/耗时，
  // 于是永远"不相同"→ 每次事件都推，等于没去重；
  // 反过来若只看 state，时长秒数又会冻住。这里锁住后者。
  const s = freshState();
  foldEvent(s, ev('turn/start', { turn: 1 }), NOW);
  foldEvent(s, ev('tool/call', { turn: 1, name: 'bash', callId: 'c1' }), NOW + 10);
  foldEvent(s, ev('tool/result', { turn: 1, message: { toolCallId: 'c1' } }), NOW + 60);
  // 同一状态下，过一会儿时长就该变——这决定了推不推
  const sig = (snap) => [snap.state, snap.turn, snap.toolCount, snap.durationText].join('|');
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false });
  ctx.handlers.get('session/event')({ id: 's1' }, ev('turn/start', { turn: 1 }));
  const a = sig(api.snapshot());
  const until = Date.now() + 1100;
  while (Date.now() < until) { /* 等一秒 */ }
  const b = sig(api.snapshot());
  assert.notEqual(a, b, '同一状态下时长变了，签名必须跟着变，否则页面计时是冻的');
  ctx.dispose();
});

test('apply：卸载后服务关闭，端口释放', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  const port = await waitForPort(api);
  assert.ok(port > 0);

  ctx.dispose();
  await new Promise((r) => setTimeout(r, 50));

  // 端口释放后再访问应该连不上
  await assert.rejects(
    () => get(port, '/dsh-washer/health'),
    '卸载后端口不该还在监听',
  );
});

/* ------------------------------------------------------------------ *
 * 悬浮窗开关：运行中拨动必须真的拉进程 / 杀进程
 * ------------------------------------------------------------------ */

test('悬浮窗开关：运行中拨到关，必须杀掉 Electron 进程（不能只写文件）', async () => {
  /*
   * 用户报的「显示悬浮窗设置没生效」根因就在这里：
   * enabled 原本是 apply 时算一次的常量，运行中拨开关只写了偏好文件，
   * 拉起/杀进程那段代码根本走不到。偏好文件写着 show:false，
   * 进程却还活着——看起来就是开关坏了。
   */
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  await waitForPort(api);

  // 拉起是不是真的发生取决于本机有没有 Electron，这里不强求；
  // 关键是「关」这一侧必须把进程清干净、偏好必须落盘。
  const saved = api.syncOverlayPrefs({ show: false });
  assert.ok(saved !== null, '偏好应当写成功');
  assert.equal(saved.show, false, '偏好文件里要记下 show:false');

  ctx.dispose();
});

test('悬浮窗开关：只认布尔值，脏数据不改存在的那一份', () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false });

  // 先写一个干净的值
  const first = api.syncOverlayPrefs({ show: false });
  assert.equal(first.show, false, '布尔值才认');

  // 字符串 'false' 不能当成 false 写进去——否则页面传错类型会静默关掉窗口
  const dirty = api.syncOverlayPrefs({ show: 'false' });
  assert.equal(dirty.show, false, '脏值应当被忽略，保留原来的 false 而不是被字符串覆盖');

  // 完全不认识的字段也别把整份文件写坏
  const junk = api.syncOverlayPrefs({ size: 'huge' });
  assert.notEqual(junk.size, 'huge', '非法 size 不落盘');
  assert.equal(junk.show, false, '已有的 show 保留');

  // 传 null 直接拒绝
  assert.equal(api.syncOverlayPrefs(null), null);

  ctx.dispose();
});

test('apply：desktopOverlayAutoLaunch:false 时不拉进程，但服务照开', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0, desktopOverlayAutoLaunch: false });
  const port = await waitForPort(api);
  assert.ok(port > 0, '关掉自动拉起不该影响服务');
  ctx.dispose();
});

test('悬浮窗开关：启动时关、运行中拨到开，必须能把服务起起来', async () => {
  /*
   * 这是「设置改了没反应」的第二层根因，比 enabled 常量更隐蔽：
   * 启动时 desktopOverlay:false → server.listen 根本没被调用；
   * 之后拨开关走 syncOverlayPrefs → 旧实现只调 launchOverlay()，
   * 而它里头有 if (!server.listening) return false;  于是永远拉不起窗口。
   *
   * 用户在设置页看到的现象就是：开关拨过去、文件也写对了，窗口就是不出现。
   */
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false, desktopOverlayPort: 0 });
  assert.equal(api.port(), 0, '启动时关着，不该占端口');

  const saved = api.syncOverlayPrefs({ show: true });
  assert.ok(saved !== null);
  assert.equal(saved.show, true);

  const port = await waitForPort(api);
  assert.ok(port > 0, '拨到开后服务必须真的 listen 起来，否则悬浮窗没东西可连');

  ctx.dispose();
});

test('偏好双向同步：POST 进来的偏好要能通过 GET 读回（浮窗 → 设置页的回程）', async () => {
  /*
   * 悬浮窗右键菜单改完 → notifyHost() POST 到 /dsh-washer/prefs →
   * 宿主写文件 → 设置页 GET 到新值。
   * 这条断言"写进去的能读出来"，是整条回程的地基。
   */
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  const port = await waitForPort(api);

  const saved = api.syncOverlayPrefs({ size: 'tiny', skin: 'precision' });
  assert.equal(saved.size, 'tiny');

  // 走真实 HTTP GET（端点带 token，从闭包里拿不到，直接用内部函数比
  // 更贴近实际使用：设置页读的就是这一份）
  const { readOverlayPrefs } = await import('../index.js');
  const current = readOverlayPrefs();
  assert.equal(current.size, 'tiny', '写进去的要能读回来');
  assert.equal(current.skin, 'precision');

  ctx.dispose();
});

test('偏好双向同步：鼠标穿透状态也要能往返（浮窗菜单 ←→ 设置页）', async () => {
  /*
   * 用户报：「点悬浮窗菜单里的功能，设置页对应开关不同步」。
   * 穿透开关在设置页有镜像，所以浮窗菜单改完必须回传宿主，否则两边分叉。
   * 这条锁住 clickThrough 这个字段的往返——之前 setClickThrough 只改内存，
   * 既没写本地文件也没通知宿主，两边永远对不上。
   */
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  await waitForPort(api);

  const saved = api.syncOverlayPrefs({ clickThrough: true });
  assert.equal(saved.clickThrough, true, '穿透开要存下来');

  const { readOverlayPrefs } = await import('../index.js');
  assert.equal(readOverlayPrefs().clickThrough, true, '设置页读回来也应是开');

  api.syncOverlayPrefs({ clickThrough: false });
  assert.equal(readOverlayPrefs().clickThrough, false, '关也要能存下来');

  // 脏值不该覆盖
  api.syncOverlayPrefs({ clickThrough: 'yes' });
  assert.equal(readOverlayPrefs().clickThrough, false, '非布尔值不该改掉合法值');

  ctx.dispose();
});

test('偏好双向同步：非法值写不进去，读回来的仍是上一个合法值', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  await waitForPort(api);

  api.syncOverlayPrefs({ size: 'normal', skin: 'pixel' });
  // 塞一堆脏东西
  api.syncOverlayPrefs({ size: 'huge', skin: 'DROP TABLE', show: 'yes' });

  const { readOverlayPrefs } = await import('../index.js');
  const current = readOverlayPrefs();
  assert.equal(current.size, 'normal', '非法 size 不该覆盖合法值');
  assert.equal(current.skin, 'pixel', '非法 skin 不该覆盖合法值');

  ctx.dispose();
});

test('启动时读偏好文件的 size/skin（否则每次启动都先闪默认造型）', () => {
  /*
   * 用户报「启动客户端时初始状态没同步」：
   * 静态 config 写 desktopOverlaySkin: precision，用户设置页改成 pixel 后
   * 存在偏好文件里。启动路径不读文件的话，每次都会先冒出一台精密家电，
   * 几百毫秒后才被 watchPrefs 纠正成像素——看着就是"启动时不对"。
   */
  writeFileSync(TEST_PREFS, JSON.stringify({ size: 'tiny', skin: 'pixel', show: true }));

  PRESERVE_PREFS = true;
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0, desktopOverlayAutoLaunch: false });
  assert.ok(api !== null);
  ctx.dispose();
});

test('偏好文件里的 show:false 不能把功能关死（重启后服务必须照常起）', () => {
  /*
   * 这条是我自己踩出来的坑：起初让偏好文件里所有字段都覆盖 cfg，
   * 包括 show。于是用户在运行中把窗口藏一次 → 文件留下 show:false →
   * 重启后 apply() 读到它，enabled 变 false，连 server.listen 都不执行，
   * 悬浮窗再也起不来，只能去改文件或重装。
   *
   * 正确语义：config.desktopOverlay 是"要不要这个功能"，偏好文件的 show
   * 只是"窗口此刻显不显示"，归 Electron 主进程管。
   */
  writeFileSync(TEST_PREFS, JSON.stringify({ show: false, size: 'normal', skin: 'precision' }));

  PRESERVE_PREFS = true;
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0, desktopOverlayAutoLaunch: false });
  assert.ok(api !== null);
  ctx.dispose();
});

/* ---------- 本轮审查修复的回归保护 ---------- */

test('turn/end 带 reason:error → 亮 error，且不亮「洗完了」', () => {
  /*
   * 审查发现的 S3：turn-error 节点从来没人写，deriveState 里
   * findTurnError 那条分支在桌面端是死代码——模型报错、账号登出、
   * 进程被中断，悬浮窗一律掉回 idle 装没事。
   * 宿主的失败信息藏在 turn/end.data.reason 里，见 endFailureOf。
   */
  const s = freshState();
  foldEvent(s, ev('turn/start', { turn: 1 }), NOW);
  foldEvent(s, ev('assistant/message', { turn: 1, message: { source: { model: 'm' } } }), NOW + 100);
  foldEvent(s, ev('turn/end', {
    turn: 1,
    reason: { kind: 'error', error: { code: 'CONTEXT_OVERFLOW', message: 'too long' } },
  }), NOW + 200);

  assert.equal(s.doneUntil, 0, '出错的轮次不能同时亮「洗完了」');
  const err = s.nodes.filter((n) => n.kind === 'turn-error');
  assert.equal(err.length, 1, '必须记下 turn-error 节点');
  assert.equal(err[0].code, 'CONTEXT_OVERFLOW');

  const derived = deriveState({
    sessionId: 's1', running: false, pending: undefined, runningCalls: [],
    partial: null, nodes: s.nodes, outline: [{ turn: 1 }], trajectory: undefined,
    sticky: null, now: NOW + 300,
  });
  assert.equal(derived, 'error');
});

test('endFailureOf：只有 error / 登出中止 / interrupted 才算失败', () => {
  assert.equal(endFailureOf({ kind: 'error', error: { code: 'X', message: 'm' } }).code, 'X');
  assert.equal(endFailureOf({ kind: 'error', error: { message: 'no code' } }).code, 'E-00');
  assert.equal(
    endFailureOf({ kind: 'aborted', reason: { kind: 'hook', reason: 'deepseek-account/signed-out' } }).code,
    'ACCOUNT_SIGNED_OUT',
  );
  assert.equal(endFailureOf({ kind: 'interrupted' }).code, 'INTERRUPTED');
  // 下面这些不是故障：用户自己按停、正常完成、审批拒绝、到 max tokens
  assert.equal(endFailureOf({ kind: 'aborted', reason: { kind: 'user' } }), undefined);
  assert.equal(endFailureOf({ kind: 'completed' }), undefined);
  assert.equal(endFailureOf({ kind: 'blocked' }), undefined);
  assert.equal(endFailureOf({ kind: 'max-tokens' }), undefined);
  assert.equal(endFailureOf(null), undefined);
});

test('turn/end 正常完成 → 桌面端也能进 done（不再恒为 null）', () => {
  /*
   * 审查发现的 S2：snapshot() 里写死 sticky:null，deriveState 的
   * done 分支在桌面端恒不成立，绿灯停几秒这个核心反馈一次都不出现。
   */
  const s = freshState();
  foldEvent(s, ev('turn/start', { turn: 1 }), NOW);
  foldEvent(s, ev('assistant/message', { turn: 1, message: { source: { model: 'm' } } }), NOW + 100);
  foldEvent(s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }), NOW + 200);
  assert.ok(s.doneUntil > NOW + 200, '完成后必须写下保持窗口');

  const at = (now) => deriveState({
    sessionId: 's1', running: false, pending: undefined, runningCalls: [],
    partial: null, nodes: s.nodes, outline: [{ turn: 1 }], trajectory: undefined,
    sticky: s.doneUntil > 0 ? { kind: 'done', turn: 1, until: s.doneUntil } : null, now,
  });
  assert.equal(at(NOW + 300), 'done');
  assert.equal(at(s.doneUntil + 1), 'idle', '保持窗口过了就该回 idle');
});

test('用户手动按停：不亮「洗完了」，也不报故障', () => {
  /*
   * 用户按停时宿主给的是 { kind:'aborted', reason:{ kind:'user' } }。
   * endFailureOf 按设计返回 undefined（按停不是失败，不该报红灯），
   * 但早先 turn/end 顺手点亮了 doneUntil —— 用户掐断任务，
   * 洗衣机却说「洗完了」。按停既不是失败也不是干完，画面该回 idle。
   */
  const s = freshState();
  foldEvent(s, ev('turn/start', { turn: 1 }), NOW);
  foldEvent(s, ev('assistant/message', { turn: 1, message: { source: { model: 'm' } } }), NOW + 100);
  foldEvent(s, ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }), NOW + 200);

  assert.equal(s.doneUntil, 0, '按停不能点亮洗完了');
  assert.ok(
    !s.nodes.some((n) => n.kind === 'turn-error'),
    '按停不是故障，不能记 turn-error',
  );

  const derived = deriveState({
    sessionId: 's1', running: false, pending: undefined, runningCalls: [],
    partial: null, nodes: s.nodes, outline: [{ turn: 1 }], trajectory: undefined,
    sticky: s.doneUntil > 0 ? { kind: 'done', turn: 1, until: s.doneUntil } : null, now: NOW + 300,
  });
  assert.equal(derived, 'idle', '按停后应回待机，不显示洗完了');
});

test('isUserAbort：只认主动按停，登出和普通错误不算', () => {
  assert.equal(isUserAbort({ kind: 'aborted', reason: { kind: 'user' } }), true);
  // 没带 reason 的 aborted 也算按停
  assert.equal(isUserAbort({ kind: 'aborted' }), true);
  // 登出是被动中止，走 endFailureOf 的红灯，不算按停
  assert.equal(
    isUserAbort({ kind: 'aborted', reason: { kind: 'hook', reason: 'deepseek-account/signed-out' } }),
    false,
  );
  assert.equal(isUserAbort({ kind: 'completed' }), false);
  assert.equal(isUserAbort({ kind: 'error', error: { code: 'X' } }), false);
  assert.equal(isUserAbort(null), false);
});

test('新一轮开始立刻清掉 done（转起来的机器不能还挂绿勾）', () => {
  const s = freshState();
  foldEvent(s, ev('turn/start', { turn: 1 }), NOW);
  foldEvent(s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }), NOW + 100);
  assert.ok(s.doneUntil > 0);
  foldEvent(s, ev('turn/start', { turn: 2 }), NOW + 200);
  assert.equal(s.doneUntil, 0);
});

test('turnTimings 有上界（长跑会话不能无界增长）', () => {
  const s = freshState();
  for (let i = 1; i <= 200; i += 1) {
    foldEvent(s, ev('turn/start', { turn: i }), NOW + i * 1000);
    foldEvent(s, ev('turn/end', { turn: i, reason: { kind: 'completed' } }), NOW + i * 1000 + 500);
  }
  assert.ok(s.turnTimings.size <= 50, `turnTimings 应被裁剪到 50 以内，实际 ${s.turnTimings.size}`);
  // 裁剪后当前轮必须还在，否则计时会归零
  assert.ok(s.turnTimings.has(200), '当前轮不能被裁掉');
});

test('偏好文件损坏时拒绝写入，不能拿空对象抹盘', () => {
  /*
   * 审查发现的 S5：writeOverlayPrefs 以前 catch 里回退成 {}，
   * 于是「读到半截 JSON」→「以 {} 为基底合并」→「写回」= 全清。
   * 现在读失败一律返回 null（放弃这次写入），盘上的坏文件原样保留，
   * 至少用户还能看见、能修。
   */
  writeFileSync(TEST_PREFS, '{"skin":"pixel", 这里是半截');
  const before = readFileSync(TEST_PREFS, 'utf8');
  const result = writeOverlayPrefs({ size: 'tiny' });
  assert.equal(result, null, '读不出来时必须返回 null 表示没写成');
  assert.equal(readFileSync(TEST_PREFS, 'utf8'), before, '坏文件必须原样保留，不能被覆盖');
});

test('偏好写入是原子的，不会留下半截文件', () => {
  writeFileSync(TEST_PREFS, JSON.stringify({ skin: 'pixel', size: 'normal' }));
  const next = writeOverlayPrefs({ size: 'tiny' });
  assert.ok(next !== null);
  assert.equal(next.skin, 'pixel', '合并时不能丢别的字段');
  assert.equal(next.size, 'tiny');
  // 读回来必须是完整 JSON
  assert.deepEqual(JSON.parse(readFileSync(TEST_PREFS, 'utf8')), next);
  // 不能留下临时文件
  const leftovers = readdirSync('/tmp').filter((f) => f.startsWith('dsh-washer-test-prefs.json.') && f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '原子写不能留临时文件');
});

/* ------------------------------------------------------------------ *
 * 审批等待：桌面悬浮窗唯一拿不到的状态
 *
 * 网页端靠 useSessionStatus().pendingInteraction 就知道"在等你批准"，
 * 那是客户端 uiSession 的投影；Host 侧没有，于是浮窗写死 pending: undefined，
 * 最该提醒的时刻从不提醒。这条事件来自 ctx.on('approval/request')——
 * 它是 **waterfall**，少调一次 next() 整个审批链就断，会话永久卡死。
 * 所以两条都要测：状态要亮，链要通。
 * ------------------------------------------------------------------ */

test('洗完状态过期后必须推一次 idle（否则浮窗永远停在「洗完了」）', async () => {
  /*
   * 用户报的 bug：悬浮窗显示「洗完了」，dock 显示「待机」。
   *
   * 根因在心跳：turn/end 之后 running 变 false，「洗完了」是靠
   * doneUntil 倒计时自己过期的，那一刻没有任何事件。
   * 心跳早先只认 running，一过 turn/end 就 return，于是浮窗
   * 永远停在最后收到的 done 上；而网页端有 React 自己的定时器
   * 清 sticky，照常回 idle —— 两边就此分叉。
   *
   * 这条测试盯的就是分叉本身：推送序列的最后一条必须和
   * 服务端当前状态一致。只测 snapshot() 是不够的——
   * snapshot 一直是按时间现算的，它早就对了，错的是没人去推。
   */
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0, doneHoldMs: 250 });
  const port = await waitForPort(api);

  const received = [];
  const socket = await openWs(port, (text) => {
    try { received.push(JSON.parse(text)); } catch { /* 忽略心跳帧 */ }
  });

  const onEvent = ctx.handlers.get('session/event');
  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));
  await wait(120);
  onEvent({ id: 's1' }, ev('turn/end', { turn: 1, reason: { kind: 'complete' } }));

  // 等过 doneHoldMs（250ms）+ 两拍心跳（TICK_MS=500），确保过期那一下有机会推
  await wait(1600);

  const states = received.map((r) => r.state);
  assert.ok(states.includes('done'), '应该出现过 done，实际: ' + states.join(','));

  const last = states[states.length - 1];
  const actual = api.snapshot().state;
  assert.equal(last, actual,
    '最后一条推送必须是当前真实状态，否则浮窗和 dock 会打架。收到: ' + states.join(','));
  assert.equal(last, 'idle', 'done 过期后应停在 idle，实际: ' + last);

  socket.close();
  ctx.dispose();
});

test('审批挂起时浮窗亮 waiting（不再恒为 undefined）', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false });

  const onApproval = ctx.handlers.get('approval/request');
  assert.ok(typeof onApproval === 'function', '必须订阅 approval/request');

  const onEvent = ctx.handlers.get('session/event');
  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));
  assert.notEqual(api.snapshot().state, 'waiting', '没审批时不该是 waiting');

  let release;
  const gate = new Promise((r) => { release = r; });
  const handled = onApproval({ agent: { session: { id: 's1' } } }, () => gate);

  const pendingSnap = api.snapshot();
  assert.equal(pendingSnap.state, 'waiting', '审批挂起时必须亮 waiting');

  release(undefined);
  await handled;
  // 批准/拒绝/取消之后要自己恢复，不能一直挂着"等你确认"
  assert.notEqual(api.snapshot().state, 'waiting', '审批结束后必须恢复');

  ctx.dispose();
});

test('提问挂起时浮窗也要亮 waiting，不能继续显示漂洗中', async () => {
  /*
   * 用户报的问题：确认弹窗开着时，网页端 dock 显示「等你确认」，
   * 桌面悬浮窗却还在「漂洗中」。两边打架。
   *
   * 根因：宿主有**两条**独立事件，我只接了 approval/request。
   * ask_user_question 走的是 user-questions/request，浮窗完全不知道。
   */
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false });

  const onQuestion = ctx.handlers.get('user-questions/request');
  assert.ok(typeof onQuestion === 'function', '必须订阅 user-questions/request，否则提问时浮窗不知道');

  const onEvent = ctx.handlers.get('session/event');
  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));
  // 提问发生时模型还在"干活"，浮窗会算成 rinsing
  assert.notEqual(api.snapshot().state, 'waiting');

  let release;
  const gate = new Promise((r) => { release = r; });
  const handled = onQuestion({ agent: { session: { id: 's1' } }, questions: [] }, () => gate);

  assert.equal(api.snapshot().state, 'waiting', '提问挂起时必须亮 waiting');

  release(undefined);
  await handled;
  assert.notEqual(api.snapshot().state, 'waiting', '回答完必须恢复');
  ctx.dispose();
});

test('提问 waterfall：必须把 next() 的结果原样传下去', async () => {
  const ctx = makeCtx();
  apply(ctx, { desktopOverlay: false });
  const onQuestion = ctx.handlers.get('user-questions/request');

  const nextResult = { answers: [{ id: 'q1', value: 'a' }] };
  const returned = onQuestion({ agent: { session: { id: 's1' } } }, () => nextResult);
  assert.equal(await returned, nextResult, 'next() 的返回值必须原样传给宿主，否则没人收到答案');
  ctx.dispose();
});

test('审批和提问同时挂着，按两个计数算，都结束才恢复', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false });
  const onApproval = ctx.handlers.get('approval/request');
  const onQuestion = ctx.handlers.get('user-questions/request');
  const onEvent = ctx.handlers.get('session/event');
  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));

  let releaseA;
  let releaseQ;
  const gateA = new Promise((r) => { releaseA = r; });
  const gateQ = new Promise((r) => { releaseQ = r; });
  const a = onApproval({ agent: { session: { id: 's1' } } }, () => gateA);
  const q = onQuestion({ agent: { session: { id: 's1' } } }, () => gateQ);

  assert.equal(api.snapshot().state, 'waiting');

  releaseA(undefined);
  await a;
  assert.equal(api.snapshot().state, 'waiting', '提问还挂着，不能提前恢复');

  releaseQ(undefined);
  await q;
  assert.notEqual(api.snapshot().state, 'waiting', '两个都结束才恢复');
  ctx.dispose();
});

test('审批 waterfall：必须把 next() 的结果原样传下去', async () => {
  const ctx = makeCtx();
  apply(ctx, { desktopOverlay: false });
  const onApproval = ctx.handlers.get('approval/request');

  const nextResult = { ok: true };
  const returned = onApproval({ agent: { session: { id: 's1' } } }, () => nextResult);
  assert.equal(await returned, nextResult, 'next() 的返回值必须原样传给宿主，否则审批链断开');
});

test('审批 waterfall：next() 抛错时也要清掉等待态', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false });
  const onApproval = ctx.handlers.get('approval/request');

  const onEvent = ctx.handlers.get('session/event');
  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));

  assert.throws(() => {
    onApproval({ agent: { session: { id: 's1' } } }, () => { throw new Error('boom'); });
  }, /boom/);

  // 已经抛出去了，等待计数不能留在那儿——否则浮窗会永远停在"等你确认"
  assert.notEqual(api.snapshot().state, 'waiting', '异常路径也要清等待态');
  ctx.dispose();
});

test('同一会话多个审批并行时，全部结束才恢复', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false });
  const onApproval = ctx.handlers.get('approval/request');
  const onEvent = ctx.handlers.get('session/event');
  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));

  let releaseA;
  let releaseB;
  const gateA = new Promise((r) => { releaseA = r; });
  const gateB = new Promise((r) => { releaseB = r; });
  const a = onApproval({ agent: { session: { id: 's1' } } }, () => gateA);
  const b = onApproval({ agent: { session: { id: 's1' } } }, () => gateB);

  assert.equal(api.snapshot().state, 'waiting');

  releaseA(undefined);
  await a;
  assert.equal(api.snapshot().state, 'waiting', '还剩一个审批，不能提前恢复');

  releaseB(undefined);
  await b;
  assert.notEqual(api.snapshot().state, 'waiting', '全部结束才恢复');

  ctx.dispose();
});

/* ------------------------------------------------------------------ *
 * 多会话总览 + 钉住
 *
 * 用户经常同时跑两三个 agent。Host 侧不知道哪个会话在前台
 * （retainedBy.mainView 是纯客户端引用计数），所以浮窗只能"谁最后动显示谁"，
 * 多开时画面随机跳。给一个明确的锚点：钉住就不再跟随。
 * ------------------------------------------------------------------ */

function post(port, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = httpRequest({
      host: '127.0.0.1', port,
      path: path + '?token=' + encodeURIComponent(token),
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('多会话：snapshot 带上所有会话的概览', () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false });
  const onEvent = ctx.handlers.get('session/event');

  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));
  onEvent({ id: 's2' }, ev('turn/start', { turn: 1 }));

  const snap = api.snapshot();
  assert.ok(Array.isArray(snap.sessions), 'snapshot 必须带 sessions 数组');
  assert.equal(snap.sessions.length, 2, '两个会话都要在总览里');
  for (const row of snap.sessions) {
    assert.equal(typeof row.sessionId, 'string');
    assert.equal(typeof row.state, 'string');
    assert.equal(typeof row.weight, 'number');
  }
  ctx.dispose();
});

test('多会话：等待审批的排在最前面（那才是要人动手的）', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false });
  const onEvent = ctx.handlers.get('session/event');
  const onApproval = ctx.handlers.get('approval/request');

  onEvent({ id: 'busy' }, ev('turn/start', { turn: 1 }));
  onEvent({ id: 'waiting-one' }, ev('turn/start', { turn: 1 }));

  let release;
  const gate = new Promise((r) => { release = r; });
  const handled = onApproval({ agent: { session: { id: 'waiting-one' } } }, () => gate);

  const snap = api.snapshot();
  assert.equal(snap.sessions[0].sessionId, 'waiting-one', '等审批的会话必须排第一');
  assert.equal(snap.sessions[0].state, 'waiting');

  release(undefined);
  await handled;
  ctx.dispose();
});

test('钉住：钉住后不被其它会话抢占，放开后恢复跟随', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  const port = await waitForPort(api);
  const info = JSON.parse(readFileSync(TEST_ENDPOINT, 'utf8'));
  const onEvent = ctx.handlers.get('session/event');

  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));
  assert.equal(api.snapshot().sessionId, 's1');

  // 再开一个会话，跟随逻辑会把视图切过去
  onEvent({ id: 's2' }, ev('turn/start', { turn: 1 }));
  assert.equal(api.snapshot().sessionId, 's2', '没钉住时跟随最近活动');

  // 钉住 s1
  const pinned = await post(port, '/dsh-washer/pin', info.token, { sessionId: 's1' });
  assert.equal(pinned.status, 200);
  assert.equal(api.snapshot().sessionId, 's1', '钉住后视图不能被抢走');
  assert.equal(api.snapshot().pinnedSessionId, 's1');

  // s2 继续动，仍不该抢走视图
  onEvent({ id: 's2' }, ev('tool/call', { turn: 1, name: 'bash', callId: 'c1' }));
  assert.equal(api.snapshot().sessionId, 's1', '钉住后别的会话再动也不切');

  // 放开
  const cleared = await post(port, '/dsh-washer/pin', info.token, { sessionId: null });
  assert.equal(cleared.status, 200);
  assert.equal(api.snapshot().sessionId, 's2', '放开后回到跟随');

  ctx.dispose();
});

test('钉住：会话被销毁时自动放开（不留「已钉住」的假象）', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  const port = await waitForPort(api);
  const info = JSON.parse(readFileSync(TEST_ENDPOINT, 'utf8'));
  const onEvent = ctx.handlers.get('session/event');
  const onDisposed = ctx.handlers.get('session/disposed');

  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));
  onEvent({ id: 's2' }, ev('turn/start', { turn: 1 }));
  await post(port, '/dsh-washer/pin', info.token, { sessionId: 's1' });
  assert.equal(api.snapshot().pinnedSessionId, 's1', '先确认真的钉住了');

  onDisposed({ id: 's1' });
  const snap = api.snapshot();
  assert.equal(snap.pinnedSessionId, null, '会话没了必须自动放开，不能还显示已钉住');
  assert.equal(snap.sessionId, 's2', '视图应回到还活着的会话');
  ctx.dispose();
});

test('钉住接口：GET 拒绝（不能被浏览器预取误触发）', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  const port = await waitForPort(api);
  const info = JSON.parse(readFileSync(TEST_ENDPOINT, 'utf8'));

  const res = await get(port, '/dsh-washer/pin', info.token);
  assert.equal(res.status, 405, '改状态的接口只能 POST');

  ctx.dispose();
});

test('钉住接口：脏 sessionId 拒绝，不能写进去', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  const port = await waitForPort(api);
  const info = JSON.parse(readFileSync(TEST_ENDPOINT, 'utf8'));

  const tooLong = await post(port, '/dsh-washer/pin', info.token, { sessionId: 'x'.repeat(500) });
  assert.equal(tooLong.status, 400, '超长 sessionId 必须拒绝');

  const wrongType = await post(port, '/dsh-washer/pin', info.token, { sessionId: 123 });
  assert.equal(wrongType.status, 400, '非字符串必须拒绝');

  ctx.dispose();
});

test('提问工具在跑就等于在等人：不依赖 user-questions/request 也能亮 waiting', async () => {
  /*
   * 为什么要有这条兜底。
   *
   * 宿主的 user-questions/request 是 agent-scoped waterfall，且经 ctx.remote
   * 转发给浏览器端消费。实测：Host 侧 ctx.on 挂上监听、弹了三次确认框，
   * 处理器一次都没被调用（日志文件根本没生成）。
   *
   * 但 session/event 里能实实在在看到 ask_user_question 这个工具在跑，
   * 它挂多久人就犹豫了多久。所以不能只靠那条事件——
   * 宿主怎么改转发都漏不掉 session/event。
   */
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false });
  const onEvent = ctx.handlers.get('session/event');

  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));
  assert.notEqual(api.snapshot().state, 'waiting');

  // 工具调用开始：人开始对着弹窗发呆
  onEvent({ id: 's1' }, ev('tool/call', { turn: 1, step: 1, callId: 'q1', name: 'ask_user_question' }));
  assert.equal(api.snapshot().state, 'waiting', '提问工具在跑就是在等人，浮窗必须亮 waiting');

  // 人答完了
  onEvent({ id: 's1' }, ev('tool/result', { turn: 1, step: 1, message: { toolCallId: 'q1' } }));
  assert.notEqual(api.snapshot().state, 'waiting', '答完必须立刻恢复');
  ctx.dispose();
});

test('普通工具在跑不算等人：别把跑 bash 当成等你确认', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false });
  const onEvent = ctx.handlers.get('session/event');

  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));
  onEvent({ id: 's1' }, ev('tool/call', { turn: 1, step: 1, callId: 'b1', name: 'bash' }));
  assert.notEqual(api.snapshot().state, 'waiting', 'bash 在跑就是干活，不是等人');
  ctx.dispose();
});

test('三个调用点必须同一套等人判断，不能浮窗亮着总览说在洗', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false });
  const onEvent = ctx.handlers.get('session/event');

  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));
  onEvent({ id: 's1' }, ev('tool/call', { turn: 1, step: 1, callId: 'q1', name: 'ask_user_question' }));

  const snap = api.snapshot();
  assert.equal(snap.state, 'waiting', '快照说在等人');
  const row = (snap.sessions || []).find((x) => x.sessionId === 's1');
  assert.ok(row, '总览里必须有这个会话');
  assert.equal(row.state, 'waiting', '总览也得说在等人，两边不能打架');
  ctx.dispose();
});

test('迟滞：降级切换要等这个状态显示满 400ms，不是从工具结束算起', async () => {
  /*
   * 迟滞的语义是「这个状态已经显示了多久」，不是「距上一次事件多久」。
   * 早先这个测试按"工具结束之后 400ms 内不许切"来断言，是错的：
   * rinsing 在工具结束前就已经显示了近 300ms，那它只该再等 100ms 左右。
   *
   * 这里改成验两条真正要命的事：
   *   1. 状态一出现不会立刻被降级切走（工具结束的瞬间还在 rinsing）
   *   2. 窗口到了之后**必须真的切**——早先没有到点补偿，
   *      签名去重会让"该切了"那一刻根本没人来采样，状态永远卡在旧值
   */
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  const port = await waitForPort(api);

  const pushed = [];
  const socket = await openWs(port, (text) => pushed.push(JSON.parse(text)));
  const onEvent = ctx.handlers.get('session/event');

  // 冲到 rinsing：有工具在跑
  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));
  onEvent({ id: 's1' }, ev('tool/call', { turn: 1, step: 1, callId: 't1', name: 'bash' }));
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(pushed.some((f) => f.state === 'rinsing'), '先把 rinsing 推出去');

  const mark = pushed.length;
  onEvent({ id: 's1' }, ev('tool/result', { turn: 1, step: 1, message: { toolCallId: 't1' } }));

  // 切过去之后的第一帧必须是 washing —— 中途不许闪回别的
  await new Promise((r) => setTimeout(r, 600));
  const after = pushed.slice(mark).map((f) => f.state);
  assert.ok(after.includes('washing'), '迟滞窗口过了必须真的切到 washing，不能永远卡在 rinsing');
  const firstSwitch = after.findIndex((st) => st !== 'rinsing');
  assert.equal(after[firstSwitch], 'washing', '第一次状态变化必须是切到 washing，不许闪');

  socket.close();
  ctx.dispose();
});

test('迟滞：紧急态立刻切，一秒都不等', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  const port = await waitForPort(api);

  const pushed = [];
  const socket = await openWs(port, (text) => pushed.push(JSON.parse(text)));
  const onEvent = ctx.handlers.get('session/event');

  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));
  onEvent({ id: 's1' }, ev('tool/call', { turn: 1, step: 1, callId: 't1', name: 'bash' }));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(pushed.some((f) => f.state === 'rinsing'));

  // 提问工具一上来就是等人，属于紧急态，必须立刻推 waiting
  onEvent({ id: 's1' }, ev('tool/call', { turn: 1, step: 2, callId: 'q1', name: 'ask_user_question' }));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(pushed[pushed.length - 1].state, 'waiting', '紧急态必须立刻切，不能被迟滞拖住');

  socket.close();
  ctx.dispose();
});

test('客户端可以告诉宿主「现在真在等人」：优先于本地推断', async () => {
  /*
   * 悬浮窗的 pending 是自己推断的（approval/request 计数 + ask_user_question
   * 在不在跑），dock 用的是宿主投影 pendingInteraction。两边判据不同，
   * 时序上差几十毫秒，用户看到的就是「dock 说等你确认、浮窗还在漂洗」。
   *
   * 让客户端把它手上那份权威值报上来，宿主优先信它。
   */
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  await waitForPort(api);
  const onEvent = ctx.handlers.get('session/event');
  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));
  onEvent({ id: 's1' }, ev('tool/call', { turn: 1, step: 1, callId: 'b1', name: 'bash' }));

  assert.notEqual(api.snapshot().state, 'waiting', '一开始没人等');

  // 客户端报：这个会话在等审批
  const res = await callRoute(ctx, '/dsh-washer/pending', 'POST', { sessionId: 's1', kind: 'approval' });
  assert.equal(res.status, 200);
  assert.equal(api.snapshot().state, 'waiting', '客户端说在等，宿主必须亮 waiting');

  // 客户端报：不等了
  await callRoute(ctx, '/dsh-washer/pending', 'POST', { sessionId: 's1', kind: null });
  assert.notEqual(api.snapshot().state, 'waiting', '客户端说不等了，必须恢复');

  ctx.dispose();
});

test('拉悬浮窗时必须真的删掉 ELECTRON_RUN_AS_NODE，不能只设成空串', () => {
  /*
   * 这是 Windows 上「Electron 装好了、路径也对，窗口还是起不来」的真因。
   *
   * Electron 判断 ELECTRON_RUN_AS_NODE 只看它**存不存在**，不看值：
   * 设成 '' 照样退化成纯 Node，require('electron') 直接 MODULE_NOT_FOUND，
   * 进程 100ms 就退出。宿主自己就是 Electron，一定带着这个变量，
   * 子进程百分百继承。
   *
   * 早先写的是
   *   env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '' })
   * 看着像清掉了，实际等于没清。必须 delete。
   */
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  assert.ok(/delete childEnv\.ELECTRON_RUN_AS_NODE/.test(host),
    '必须 delete 掉，设空串没用');
  assert.ok(!/ELECTRON_RUN_AS_NODE:\s*''/.test(host),
    '不能再出现「设成空串就算清掉」的写法');

  // stderr 不能被 ignore：起不来时要能拿到原因
  assert.ok(!/stdio:\s*'ignore'/.test(host), "stderr 不能 'ignore'，否则报错全丢");
  assert.ok(/stdio:\s*\[\s*'ignore'\s*,\s*'ignore'\s*,\s*'pipe'\s*\]/.test(host),
    'stderr 要接到管道上，用来记失败原因');
});

test('能力探测端点报出平台事实（音效只有 macOS 有）', async () => {
  /*
   * 客户端跑在浏览器里，拿不到 process.platform。音效走的是 macOS 自带的
   * afplay + /System/Library/Sounds，所以「这台机器能不能响」只能由宿主回答。
   * 用户的诉求是「Windows 上音效开关直接隐藏」——判据就在这里。
   */
  const ctx = makeCtx();
  // 能力路由挂在 webServer 上，和 HTTP 服务无关 —— desktopOverlay:false 也要能应答
  const api = apply(ctx, { desktopOverlay: false, desktopOverlayPort: 0 });

  const res = await callRoute(ctx, '/dsh-washer/capabilities', 'GET');
  assert.equal(res.status, 200);
  assert.equal(res.body.platform, process.platform, '要如实报平台');
  assert.equal(res.body.sound, process.platform === 'darwin',
    '音效能力必须按平台算：只有 macOS 有 afplay');
  assert.equal(typeof res.body.overlay, 'boolean', '要报悬浮窗能不能起');
  /*
   * 边界（用户定的）：**悬浮窗和音效只支持 macOS，dock 全平台**。
   *
   * overlayReason 必须把两种"起不来"分开：
   *   'platform' —— 这个平台就不支持（非 macOS），装什么运行时都没用
   *   'missing'  —— 平台支持，但这台机器没装 Electron 运行时
   * 混成一个布尔，设置页就只能二选一：要么在不支持的平台上也劝用户
   * 去装 Electron（白折腾），要么在缺运行时时啥也不显示（对着开关猜）。
   *
   * 反例：把 overlayPlatformSupported() 写成恒 true，这条会红。
   */
  if (process.platform === 'darwin') {
    assert.equal(res.body.overlayReason === 'platform', false,
      'macOS 是支持平台，原因不可能是 platform');
  } else {
    assert.equal(res.body.overlay, false, '非 macOS 上悬浮窗必须报不可用');
    assert.equal(res.body.overlayReason, 'platform',
      '非 macOS 上原因必须是 platform（不是 missing——装 Electron 也没用）');
  }
  // dock 不受平台限制：它是宿主渲染进程里的 React，任何能开 Web UI 的平台都能用
  assert.equal(res.body.dock, true, 'dock 必须全平台可用');
  // 这个端点不该依赖 HTTP 服务起来，关掉悬浮窗也要能答
  assert.equal(api.port(), 0, '能力探测不该逼宿主启服务');
  ctx.dispose();
});

test('平台支持但没装运行时时，overlayReason 必须是 missing', async () => {
  /*
   * macOS 上"支持悬浮窗"和"这台机器能不能起来"是两件事：
   *   overlay        = false  —— 现在确实起不来
   *   overlayReason  = 'missing' —— 因为找不到 Electron 运行时
   * 设置页照这个在开关下面给出"缺运行时"的提示，让用户装上就能用。
   *
   * 造场景的办法：把 DSH_WASHER_ELECTRON 指到一个一定不存在的路径。
   * 那是最高优先级的候选，命不中就不会再往下找。
   * 反例：把 overlayReason 写死成 null，这条会红。
   */
  const prev = process.env.DSH_WASHER_ELECTRON;
  process.env.DSH_WASHER_ELECTRON = '/nonexistent/dsh-washer-test/electron';
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: false, desktopOverlayPort: 0 });
  try {
    const res = await callRoute(ctx, '/dsh-washer/capabilities', 'GET');
    assert.equal(res.status, 200);
    if (process.platform === 'darwin') {
      assert.equal(res.body.overlay, false, '指向不存在的运行时，必须报不可用');
      assert.equal(res.body.overlayReason, 'missing',
        '平台支持但缺运行时，原因必须是 missing（不是 platform）');
    } else {
      assert.equal(res.body.overlayReason, 'platform', '非 macOS 仍然是平台不支持');
    }
  } finally {
    if (prev === undefined) delete process.env.DSH_WASHER_ELECTRON;
    else process.env.DSH_WASHER_ELECTRON = prev;
    ctx.dispose();
  }
});

test('非 macOS 上不找 Electron 运行时（判平台，不判文件在不在）', () => {
  /*
   * overlayPlatformSupported() 必须真的按平台判。
   *
   * 这条读源码而不是跑行为：本机是 macOS，跑不出 Windows 的结果。
   * 查的是那两条硬事实：
   *   1. 函数体里是 process.platform === 'darwin'
   *   2. electronBinary() 一开头就因为平台不符返回 null，
   *      不会走到"遍历候选路径"那一步
   * 反例：把 return 改成 true，这条会红。
   */
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const fn = /function overlayPlatformSupported\(\) \{([\s\S]{0,200}?)\}/.exec(src);
  assert.ok(fn !== null, '要有 overlayPlatformSupported()');
  assert.ok(/process\.platform === 'darwin'/.test(fn[1]),
    '悬浮窗支持与否必须按 process.platform === \'darwin\' 判');
  const bin = /function electronBinary\(\) \{([\s\S]{0,300}?)\}/.exec(src);
  assert.ok(bin !== null, '要有 electronBinary()');
  assert.ok(/if \(!overlayPlatformSupported\(\)\) return null;/.test(bin[1]),
    'electronBinary 必须先判平台再找文件——不支持的平台连找都不找');
});

test('客户端报的 waiting 和本地推断能叠加，谁高算谁', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  await waitForPort(api);
  const onEvent = ctx.handlers.get('session/event');
  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));

  // 本地看到提问工具在跑
  onEvent({ id: 's1' }, ev('tool/call', { turn: 1, step: 1, callId: 'q1', name: 'ask_user_question' }));
  assert.equal(api.snapshot().state, 'waiting');

  // 客户端报"不等"——但本地判断还在等，不能就这么熄灭
  await callRoute(ctx, '/dsh-washer/pending', 'POST', { sessionId: 's1', kind: null });
  assert.equal(api.snapshot().state, 'waiting', '本地还看到提问工具在跑，不能被客户端的 null 抹掉');

  // 工具结束，本地也不等了，这时才该恢复
  onEvent({ id: 's1' }, ev('tool/result', { turn: 1, step: 1, message: { toolCallId: 'q1' } }));
  assert.notEqual(api.snapshot().state, 'waiting');
  ctx.dispose();
});

test('客户端报 pending：坏请求一律拒掉，别让脏数据污染状态', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  await waitForPort(api);

  const noSession = await callRoute(ctx, '/dsh-washer/pending', 'POST', { kind: 'approval' });
  assert.equal(noSession.status, 400, '缺 sessionId 必须 400');

  const badKind = await callRoute(ctx, '/dsh-washer/pending', 'POST', { sessionId: 's1', kind: 'whatever' });
  assert.equal(badKind.status, 400, '不认识的 kind 必须 400');

  const notPost = await callRoute(ctx, '/dsh-washer/pending', 'GET', undefined);
  assert.notEqual(notPost.status, 200, 'GET 不该给 200');

  ctx.dispose();
});

/*
 * dock 判不了"按停"，只能问宿主。这条断言整条链路：宿主记住 stoppedTurn，
 * 端点把它吐出来，客户端据此不点绿勾（客户端侧行为在 render 测试里查源码）。
 */
test('/dsh-washer/stop 回这一轮是否被用户按停，只收 GET', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  await waitForPort(api);
  const onEvent = ctx.handlers.get('session/event');
  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));
  onEvent({ id: 's1' }, ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }));

  // 宿主自己认为这一轮没点亮"洗完了"，而且记下了 stoppedTurn
  assert.equal(api.snapshot().stoppedTurn, 1, '宿主应记下被按停的轮次');

  const q = await callRoute(ctx, '/dsh-washer/stop?sessionId=s1', 'GET');
  assert.equal(q.status, 200);
  assert.equal(q.body.stoppedTurn, 1, '按停的轮次应回 1');

  // 未知会话回 -1，不报错
  const none = await callRoute(ctx, '/dsh-washer/stop?sessionId=nope', 'GET');
  assert.equal(none.status, 200);
  assert.equal(none.body.stoppedTurn, -1);

  // 只收 GET
  const wrong = await callRoute(ctx, '/dsh-washer/stop', 'POST', {});
  assert.equal(wrong.status, 405);

  ctx.dispose();
});

/*
 * 正常跑完的轮次不该被算成"按停"：stoppedTurn 必须留在 -1，
 * 否则 dock 会以为每次结束都是按停，从此再也不点绿勾。
 */
test('/dsh-washer/stop 正常跑完的一轮不算按停', async () => {
  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  await waitForPort(api);
  const onEvent = ctx.handlers.get('session/event');
  onEvent({ id: 's1' }, ev('turn/start', { turn: 1 }));
  onEvent({ id: 's1' }, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));

  assert.equal(api.snapshot().stoppedTurn, -1);
  const q = await callRoute(ctx, '/dsh-washer/stop?sessionId=s1', 'GET');
  assert.equal(q.body.stoppedTurn, -1, '正常结束不该被标记为按停');

  ctx.dispose();
});

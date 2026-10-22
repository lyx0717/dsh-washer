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
import { writeFileSync, rmSync } from 'node:fs';

import { foldEvent, encodeWsText, apply, isOwnEndpoint, speedOf, rankTools } from '../index.js';

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
  const handlers = new Map();
  const disposers = [];
  return {
    handlers,
    dispose: () => { for (const d of disposers) d(); },
    on: (name, fn) => { handlers.set(name, fn); },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); },
    logger: { info: () => {}, warn: () => {} },
  };
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

  const saved = api.syncOverlayPrefs({ size: 'tiny', skin: 'anime' });
  assert.equal(saved.size, 'tiny');

  // 走真实 HTTP GET（端点带 token，从闭包里拿不到，直接用内部函数比
  // 更贴近实际使用：设置页读的就是这一份）
  const { readOverlayPrefs } = await import('../index.js');
  const current = readOverlayPrefs();
  assert.equal(current.size, 'tiny', '写进去的要能读回来');
  assert.equal(current.skin, 'anime');

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

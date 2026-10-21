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

import { foldEvent, encodeWsText, apply } from '../index.js';

function freshState() {
  return {
    turn: 0,
    runningCalls: [],
    partial: null,
    nodes: [],
    callStartedAt: new Map(),
    turnTimings: {},
    running: false,
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
  assert.equal(s.turnTimings[2].start, NOW + 100, '要记下起轮时间');
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
  assert.equal(s.turnTimings[1].end, NOW + 500);
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

function makeCtx() {
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
  const file = join(homedir(), '.dsh', 'dsh-washer-overlay.json');

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
  assert.equal(existsSync(file), false, '卸载后必须删掉，别留一份过期 token');
});

test('拿落盘的 token 真的能访问 state（证明这条路是通的）', async () => {
  const { readFileSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');

  const ctx = makeCtx();
  const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
  const port = await waitForPort(api);

  const { token } = JSON.parse(readFileSync(join(homedir(), '.dsh', 'dsh-washer-overlay.json'), 'utf8'));
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
  const file = join(homedir(), '.dsh', 'dsh-washer-overlay.json');

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
  assert.equal(existsSync(file), false, 'B 卸载后该删');
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

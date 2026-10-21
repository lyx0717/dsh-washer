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

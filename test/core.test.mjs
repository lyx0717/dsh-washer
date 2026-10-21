/**
 * 状态核心单测（纯 node，无依赖）：node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveState, latestTurnOf, turnProduced, findTurnError, findToolFailure, activeTool, recentTools,
  toolCountOf, errorCodeOf, elapsedOf, formatDuration, formatToolMs, formatTokens,
  shouldSwitch, VISUAL, compactionRunning,
} from '../src/core.js';

const NOW = 1_700_000_000_000;

const base = {
  sessionId: 's1', running: false, pending: undefined, runningCalls: [],
  partial: null, nodes: [], outline: [], sticky: null, now: NOW,
};

test('无会话 → off', () => {
  assert.equal(deriveState({ ...base, sessionId: undefined }), 'off');
});

test('等待审批优先于一切运行态', () => {
  const state = deriveState({
    ...base, running: true, pending: { kind: 'approval' },
    runningCalls: [{ name: 'bash' }], partial: { blocks: [] },
    outline: [{ turn: 1, prompt: 'hi', response: '' }],
  });
  assert.equal(state, 'waiting');
});

test('运行中 + 有工具在跑 → rinsing', () => {
  const state = deriveState({
    ...base, running: true, runningCalls: [{ name: 'bash', callId: 'c1' }],
    partial: { blocks: [] }, outline: [{ turn: 1, prompt: 'hi', response: '' }],
  });
  assert.equal(state, 'rinsing');
});

test('运行中 + 流式生成 → washing', () => {
  const state = deriveState({
    ...base, running: true, runningCalls: [], partial: { blocks: [] },
    outline: [{ turn: 1, prompt: 'hi', response: '' }],
  });
  assert.equal(state, 'washing');
});

test('运行中 + 还没产出 → starting', () => {
  const state = deriveState({
    ...base, running: true, runningCalls: [], partial: null,
    outline: [{ turn: 1, prompt: '', response: '' }],
  });
  assert.equal(state, 'starting');
});

test('运行中 + 上一步是模型输出、当前无工具无流式 → spinning', () => {
  const state = deriveState({
    ...base, running: true, runningCalls: [], partial: null,
    outline: [{ turn: 1, prompt: 'hi', response: 'done text' }],
    nodes: [{ kind: 'assistant', turn: 1 }],
  });
  assert.equal(state, 'spinning');
});

test('运行中 + 本轮还没有任何节点 → starting（哪怕 prompt 已就位）', () => {
  const state = deriveState({
    ...base, running: true, runningCalls: [], partial: null,
    outline: [{ turn: 1, prompt: 'hi', response: '' }], nodes: [],
  });
  assert.equal(state, 'starting');
});

test('运行中 + 本轮只有宿主注入的 context 节点 → starting（context 不算产出）', () => {
  const state = deriveState({
    ...base, running: true, runningCalls: [], partial: null,
    outline: [{ turn: 1, prompt: 'hi', response: '' }],
    nodes: [{ kind: 'context', turn: 1 }, { kind: 'context', turn: 1 }],
  });
  assert.equal(state, 'starting');
});

test('运行中 + 本轮 context 之后跟了 assistant 节点 → spinning（context 被跳过）', () => {
  const state = deriveState({
    ...base, running: true, runningCalls: [], partial: null,
    outline: [{ turn: 1, prompt: 'hi', response: 'text' }],
    nodes: [{ kind: 'assistant', turn: 1 }, { kind: 'context', turn: 1 }],
  });
  assert.equal(state, 'spinning');
});

test('停止 + 当前轮有 turn-error → error', () => {
  const state = deriveState({
    ...base, running: false, outline: [{ turn: 3, prompt: 'x', response: '' }],
    nodes: [{ kind: 'turn-error', turn: 3, message: 'boom' }],
  });
  assert.equal(state, 'error');
});

test('旧轮的 error 不算当前故障', () => {
  const state = deriveState({
    ...base, running: false, outline: [{ turn: 4, prompt: 'x', response: 'y' }],
    nodes: [{ kind: 'turn-error', turn: 3, message: 'old' }],
  });
  assert.equal(state, 'idle');
});

test('done 粘滞窗口内 → done，过期 → idle', () => {
  const outline = [{ turn: 2, prompt: 'a', response: 'b' }];
  assert.equal(deriveState({ ...base, outline, sticky: { kind: 'done', turn: 2, until: NOW + 1000 } }), 'done');
  assert.equal(deriveState({ ...base, outline, sticky: { kind: 'done', turn: 2, until: NOW - 1 } }), 'idle');
});

test('latestTurnOf 兼容数组与 {turns} 包装', () => {
  assert.equal(latestTurnOf([{ turn: 1 }, { turn: 5 }]), 5);
  assert.equal(latestTurnOf({ turns: [{ turn: 7 }] }), 7);
  assert.equal(latestTurnOf(undefined), 0);
  assert.equal(latestTurnOf([]), 0);
});

test('turnProduced 只看指定轮', () => {
  const outline = [{ turn: 1, prompt: '', response: '' }, { turn: 2, prompt: 'q', response: '' }];
  assert.equal(turnProduced(outline, 1), false);
  assert.equal(turnProduced(outline, 2), true);
});

test('activeTool 取最后一个并归一化字段', () => {
  assert.equal(activeTool([]), undefined);
  assert.equal(activeTool(undefined), undefined);
  assert.deepEqual(activeTool([{ name: '' }, { name: 'edit', callId: 7 }]), { name: 'edit', callId: '7' });
});

test('recentTools 返回旧→新且带耗时', () => {
  const nodes = [
    { kind: 'tool-result', name: 'read', time: 1200, callTime: 900 },
    { kind: 'tool-result', name: 'bash', time: 5000, callTime: 3800, isError: true },
    { kind: 'assistant-step' },
  ];
  assert.deepEqual(recentTools(nodes, 2), [
    { name: 'read', isError: false, ms: 300 },
    { name: 'bash', isError: true, ms: 1200 },
  ]);
});

test('toolCountOf 按轮过滤', () => {
  const nodes = [
    { kind: 'tool-result', turn: 1 },
    { kind: 'tool-result', turn: 2 },
    { kind: 'tool-result', turn: 2 },
  ];
  assert.equal(toolCountOf(nodes, 2), 2);
  assert.equal(toolCountOf(nodes, 0), 3);
});

test('errorCodeOf 映射 E 码', () => {
  assert.equal(errorCodeOf(undefined), 'E-00');
  assert.equal(errorCodeOf({ code: 'ACCOUNT_SIGNED_OUT' }), 'E-10');
  assert.equal(errorCodeOf({ code: 'INTERRUPTED' }), 'E-40');
  assert.equal(errorCodeOf({ message: 'context too long' }), 'E-30');
  assert.equal(errorCodeOf({ message: 'request blocked by policy' }), 'E-50');
  assert.equal(errorCodeOf({ message: 'connection reset' }), 'E-10');
});

test('elapsedOf 处理未结束与已结束', () => {
  const map = new Map([[1, { startTime: 1000 }], [2, { startTime: 1000, endTime: 4000 }]]);
  assert.equal(elapsedOf(map, 1, 5000), 4000);
  assert.equal(elapsedOf(map, 2, 9000), 3000);
  assert.equal(elapsedOf(undefined, 1, 0), undefined);
});

test('格式化函数', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(134_000), '02:14');
  assert.equal(formatDuration(undefined), '--:--');
  assert.equal(formatToolMs(340), '340ms');
  assert.equal(formatToolMs(1240), '1.2s');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(400), '400');
  assert.equal(formatTokens(12_400), '12.4k');
});

test('迟滞：同类运行态切换需停留 400ms', () => {
  assert.equal(shouldSwitch('washing', 'rinsing', 100), false);
  assert.equal(shouldSwitch('washing', 'rinsing', 500), true);
  assert.equal(shouldSwitch('washing', 'waiting', 0), true);
  assert.equal(shouldSwitch('idle', 'washing', 0), true);
  assert.equal(shouldSwitch('washing', 'washing', 9999), false);
});

test('每个状态都有视觉参数且水层在 0..7', () => {
  for (const [state, v] of Object.entries(VISUAL)) {
    assert.ok(v.water >= 0 && v.water <= 7, state + ' water out of range');
    assert.match(v.led, /^#[0-9a-f]{6}$/i, state + ' led not hex');
  }
});

/* ── 步骤间 / 工具失败语义（AC4、AC7、E-20） ────────────────────────────── */

test('上一步是工具、无流式 → 还在 washing（不闪 spinning）', () => {
  const state = deriveState({
    ...base, running: true, runningCalls: [], partial: null,
    outline: [{ turn: 1, prompt: 'hi', response: '' }],
    nodes: [{ kind: 'tool-result', turn: 1, name: 'shell', isError: false }],
  });
  assert.equal(state, 'washing');
});

test('上一步是模型输出、无流式 → spinning（收尾）', () => {
  const state = deriveState({
    ...base, running: true, runningCalls: [], partial: null,
    outline: [{ turn: 1, prompt: 'hi', response: 'done text' }],
    nodes: [{ kind: 'assistant', turn: 1 }],
  });
  assert.equal(state, 'spinning');
});

test('工具失败收场 → error，E 码 E-20', () => {
  const nodes = [{ kind: 'tool-result', turn: 2, name: 'shell', isError: true, error: { code: 'EXIT_1' } }];
  const state = deriveState({
    ...base, running: false, outline: [{ turn: 2, prompt: 'x', response: '' }], nodes,
  });
  assert.equal(state, 'error');
  assert.equal(errorCodeOf(findToolFailure(nodes, 2)), 'E-20');
});

test('工具失败但之后继续跑成功 → 不算 error（不误报）', () => {
  const nodes = [
    { kind: 'tool-result', turn: 2, name: 'shell', isError: true },
    { kind: 'tool-result', turn: 2, name: 'shell', isError: false },
  ];
  const state = deriveState({
    ...base, running: false, outline: [{ turn: 2, prompt: 'x', response: 'ok' }], nodes,
  });
  assert.equal(state, 'idle');
});

test('审批被拒 → E-21', () => {
  assert.equal(errorCodeOf({ kind: 'turn-error', code: 'APPROVAL_DENIED' }), 'E-21');
});

test('compactionRunning：最后一条 compaction 请求在跑才算', () => {
  const traj = { requests: [
    { purpose: 'chat', status: 'complete' },
    { purpose: 'compaction', status: 'complete' },
    { purpose: 'compaction', status: 'running' },
  ] };
  assert.equal(compactionRunning(traj), true);
  // 最后一条 compaction 已完成 → 不再算压缩中（即使更早有 running）
  assert.equal(compactionRunning({ requests: [
    { purpose: 'compaction', status: 'running' },
    { purpose: 'compaction', status: 'complete' },
  ] }), false);
  assert.equal(compactionRunning({ requests: [] }), false);
  assert.equal(compactionRunning(undefined), false);
  assert.equal(compactionRunning({}), false);
  assert.equal(compactionRunning([{ purpose: 'compaction', status: 'running' }]), true);
});

test('压缩上下文 → draining（优先于 rinsing/washing）', () => {
  const trajectory = { requests: [{ purpose: 'compaction', status: 'running' }] };
  // 即使同时有工具在跑、也在流式出字，压缩期间报 draining
  assert.equal(deriveState({ ...base, running: true, trajectory,
    runningCalls: [{ name: 'bash', callId: 'c1' }] }), 'draining');
  assert.equal(deriveState({ ...base, running: true, trajectory,
    partial: { turn: 1, step: 1, blocks: [] } }), 'draining');
  // 压缩结束（最后一条 complete）→ 回到正常判定
  assert.equal(deriveState({ ...base, running: true,
    trajectory: { requests: [{ purpose: 'compaction', status: 'complete' }] },
    runningCalls: [{ name: 'bash', callId: 'c1' }] }), 'rinsing');
});

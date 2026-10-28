/**
 * 状态核心单测（纯 node，无依赖）：node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveState, latestTurnOf, turnProduced, findTurnError, findToolFailure, activeTool, recentTools,
  toolCountOf, errorCodeOf, elapsedOf, formatDuration, formatToolMs, formatTokens, toolActionOf,
  shouldSwitch, VISUAL, compactionRunning, stalledForOf, typicalTurnMs, remainingOf, turnMatches,
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

/* ------------------------------------------------------------------ *
 * 无进展信号（stalledForOf）
 * ------------------------------------------------------------------ */

test('stalledForOf：非产出态一律不判卡住', () => {
  const samples = [{ at: NOW - 60000, output: 10 }, { at: NOW - 60000, output: 20 }];
  for (const state of ['off', 'idle', 'starting', 'draining', 'waiting', 'done', 'error']) {
    assert.equal(stalledForOf(samples, state, NOW), null, state);
  }
});

test('stalledForOf：采样不足两点不叫卡住（长思考不误报）', () => {
  assert.equal(stalledForOf([], 'washing', NOW), null);
  assert.equal(stalledForOf([{ at: NOW - 300000, output: 5 }], 'washing', NOW), null);
});

test('stalledForOf：距最后一次产出超过阈值才叫卡住', () => {
  const fresh = [{ at: NOW - 20000, output: 1 }, { at: NOW - 5000, output: 9 }];
  assert.equal(stalledForOf(fresh, 'washing', NOW), null);

  const stale = [{ at: NOW - 40000, output: 1 }, { at: NOW - 50000, output: 9 }];
  assert.equal(stalledForOf(stale, 'washing', NOW), 50000);
});

test('stalledForOf：阈值边界（等于阈值不算卡住）', () => {
  const samples = [{ at: NOW - 90000, output: 1 }, { at: NOW - 45000, output: 9 }];
  assert.equal(stalledForOf(samples, 'rinsing', NOW), null);
  assert.equal(stalledForOf(samples, 'rinsing', NOW, 45000), null);
  assert.equal(stalledForOf(samples, 'rinsing', NOW + 1), 45001);
});

/* ------------------------------------------------------------------ *
 * 预计剩余时间
 * ------------------------------------------------------------------ */

test('typicalTurnMs：少于 2 轮不估（均值没有意义）', () => {
  assert.equal(typicalTurnMs(null), null);
  assert.equal(typicalTurnMs(new Map()), null);
  assert.equal(typicalTurnMs(new Map([[1, { startTime: 0, endTime: 5000 }]])), null);
});

test('typicalTurnMs：只算已完成的轮（跑着那轮没有 endTime）', () => {
  const t = new Map([
    [1, { startTime: 0, endTime: 10000 }],
    [2, { startTime: 10000, endTime: 20000 }],
    [3, { startTime: 20000 }],           // 正在跑
  ]);
  assert.equal(typicalTurnMs(t), 10000);
});

test('typicalTurnMs：取中位数不取均值（离群值不该带飞基线）', () => {
  // 四轮：2s / 2s / 3s / 600s。均值会被那 600s 拖到 150s，中位数仍是 2.5s
  const t = new Map([
    [1, { startTime: 0, endTime: 2000 }],
    [2, { startTime: 2000, endTime: 4000 }],
    [3, { startTime: 4000, endTime: 7000 }],
    [4, { startTime: 7000, endTime: 607000 }],
  ]);
  assert.equal(typicalTurnMs(t), 2500, '中位数不能被 600s 那轮带飞');
});

test('typicalTurnMs：坏数据直接跳过（不 NaN 传播）', () => {
  const t = new Map([
    [1, { startTime: 0, endTime: 4000 }],
    [2, { startTime: 4000, endTime: 8000 }],
    [3, { startTime: 9000, endTime: 5000 }],   // end 早于 start，非法
    [4, null],
    [5, { startTime: 'x', endTime: 1 }],
  ]);
  assert.equal(typicalTurnMs(t), 4000);
});

test('remainingOf：超时返回 0，不返回负数', () => {
  assert.equal(remainingOf(10000, 3000), 7000);
  assert.equal(remainingOf(10000, 10000), 0);
  assert.equal(remainingOf(10000, 25000), 0, '已经超时只能是 0');
  assert.equal(remainingOf(null, 1000), null);
  assert.equal(remainingOf(0, 1000), null);
});

/* ---- 工具名翻译 ----
 * 状态条上原来直接显示宿主给的技术名（bash / apply_patch），
 * 用户原话：「运行中显示的"bash"等信息是什么？英文不好的人看不懂」。
 * 翻译成动作说明，认不出来就原样返回——猜一个错的说明比不翻更糟。
 */
test('toolActionOf 把常见工具技术名归到动作类别', () => {
  // 只给类别，不给文案：文案由各端词典翻译，否则英文界面会冒出中文
  assert.equal(toolActionOf('bash'), 'command');
  assert.equal(toolActionOf('read_file'), 'read');
  assert.equal(toolActionOf('apply_patch'), 'edit');
  assert.equal(toolActionOf('grep'), 'search');
  assert.equal(toolActionOf('web_search'), 'websearch');
});

test('toolActionOf 大小写不敏感', () => {
  assert.equal(toolActionOf('BASH'), 'command');
  assert.equal(toolActionOf('Read_File'), 'read');
});

test('toolActionOf 认不出就返回空串，由调用方退回原名', () => {
  // 自定义工具 / 没收录的新工具：显示原名，总好过显示一个错的动作
  assert.equal(toolActionOf('someCustomTool'), '');
  assert.equal(toolActionOf(''), '');
  assert.equal(toolActionOf(undefined), '');
  assert.equal(toolActionOf(null), '');
});

test('toolActionOf 返回的类别必须是纯标识符', () => {
  // 类别会拼成 'tool.' + category 去查词典，带空格或中文就查不到
  for (const name of ['bash', 'read_file', 'apply_patch', 'grep', 'web_fetch', 'todo_write']) {
    assert.match(toolActionOf(name), /^[a-z]+$/);
  }
});

test('toolActionOf 能穿透 MCP 工具的命名空间', () => {
  // mcp__serverName__toolName —— 取最后一段再查一次
  assert.equal(toolActionOf('mcp__filesystem__grep'), 'search');
  // 末段也认不出就返回空串，不能只剩半截
  assert.equal(toolActionOf('mcp__server__weird'), '');
});

// —— 回归：P0 修复（stalled 防 NaN / sticky 绑轮 / 统一 turnMatches） ——

test('stalledForOf：坏采样（at 缺失/非数）不判卡住、不外泄 NaN', () => {
  // 末点 at 缺失 → now-undefined=NaN，修复前会被误判"卡住"并返回 NaN
  assert.equal(stalledForOf([{ at: NOW - 90000, output: 1 }, { at: undefined, output: 9 }], 'washing', NOW), null);
  // 末点 at 是字符串
  assert.equal(stalledForOf([{ at: NOW - 90000, output: 1 }, { at: 'oops', output: 9 }], 'washing', NOW), null);
  // now 非法 → 也得不出有限值
  assert.equal(stalledForOf([{ at: NOW - 90000, output: 1 }, { at: NOW - 80000, output: 9 }], 'washing', NaN), null);
});

test('sticky done 只粘它所属的轮：旧轮的 doneUntil 不粘到新轮', () => {
  // 当前轮是 5，sticky 记的是第 4 轮的 done —— 不能报 done
  const outline = [{ turn: 5, prompt: 'x', response: '' }];
  assert.equal(
    deriveState({ ...base, running: false, outline, sticky: { kind: 'done', turn: 4, until: NOW + 1000 } }),
    'idle',
  );
  // 同一轮（5）的 done 仍正常生效
  assert.equal(
    deriveState({ ...base, running: false, outline, sticky: { kind: 'done', turn: 5, until: NOW + 1000 } }),
    'done',
  );
});

test('turnMatches：未指定轮次不过滤；指定则须数字且相等', () => {
  assert.equal(turnMatches({ turn: 3 }, undefined), true);
  assert.equal(turnMatches({ turn: 3 }, 3), true);
  assert.equal(turnMatches({ turn: 3 }, 4), false);
  // 缺 turn 字段：指定轮次时算不匹配（不再"缺失即放行"）
  assert.equal(turnMatches({}, 3), false);
  // turn 是字符串也不算匹配（严格数字语义）
  assert.equal(turnMatches({ turn: '3' }, 3), false);
});

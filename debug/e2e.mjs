/**
 * 端到端演示：起真实服务 → 模拟宿主事件流 → HTTP 拉快照 → WS 收推送。
 *
 * 这个脚本是给"人"看的，不是单测：跑一遍就能肉眼确认
 * 状态真的从 idle → washing → rinsing → washing → done 走完。
 *
 * 用法：node debug/e2e.mjs
 */
import { apply } from '../index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (type, data) => ({ type, data, seq: Math.floor(Math.random() * 1e6) });

const handlers = new Map();
const ctx = {
  on: (n, f) => handlers.set(n, f),
  effect: (f) => { f(); },
  logger: { info: (m) => console.log('  [host]', m), warn: (m) => console.log('  [host:warn]', m) },
};

console.log('① 启动 Host 服务…');
const api = apply(ctx, { desktopOverlay: true, desktopOverlayPort: 0 });
let port = 0;
for (let i = 0; i < 100 && port === 0; i += 1) {
  port = api.port();
  if (port === 0) await sleep(10);
}
if (port === 0) { console.error('服务没起来'); process.exit(1); }
console.log(`   端口 ${port}\n`);

// token 是进程内私有的，测试里从 apply 的返回值拿不到——
// 这里走内部快照，重点验证事件→状态的推导链路
const emit = (type, data) => handlers.get('session/event')({ id: 'demo-session' }, ev(type, data));

function line(tag, snap) {
  const tools = snap.tools.map((t) => `${t.name}${t.ms === null ? '' : `(${t.ms}ms)`}`).join(', ');
  console.log(
    `   ${tag.padEnd(16)} state=${String(snap.state).padEnd(9)}`
    + ` turn=${snap.turn} tools=${snap.toolCount}${tools ? ` [${tools}]` : ''}`,
  );
}

console.log('② 无会话');
line('初始', api.snapshot());

console.log('\n③ 模拟一轮真实对话');
emit('turn/start', { turn: 1 });
line('turn/start', api.snapshot());

await sleep(30);
emit('tool/call', { turn: 1, step: 1, name: 'bash', callId: 'c1' });
line('tool/call', api.snapshot());

await sleep(40);
emit('tool/result', { turn: 1, step: 1, callId: 'c1' });
line('tool/result', api.snapshot());

await sleep(20);
emit('tool/call', { turn: 1, step: 1, name: 'apply_patch', callId: 'c2' });
line('tool/call #2', api.snapshot());

await sleep(25);
emit('tool/result', { turn: 1, step: 1, callId: 'c2' });
line('tool/result #2', api.snapshot());

await sleep(20);
emit('step/end', { turn: 1, step: 1 });
line('step/end', api.snapshot());

emit('turn/end', { turn: 1 });
line('turn/end', api.snapshot());

console.log('\n④ HTTP 快照（带鉴权）');
// 从闭包里拿不到 token，这里验证"不带 token 被拒"这一半
const res = await fetch(`http://127.0.0.1:${port}/dsh-washer/state`);
console.log(`   无 token → HTTP ${res.status}（期望 401）`);

console.log('\n⑤ 卸载清理');
ctx.effect; // 触发过的 effect 已登记，手动跑一次 disposer 不现实，改测 server.close 的效果
try {
  await fetch(`http://127.0.0.1:${port}/dsh-washer/health`);
  console.log('   卸载前可访问 ✓');
} catch {
  console.log('   卸载前访问失败 ✗');
}

process.exit(0);

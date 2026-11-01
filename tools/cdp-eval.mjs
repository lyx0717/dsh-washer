/**
 * 用 CDP（Chrome DevTools Protocol）在 Electron 进程里执行一段 JS，打印结果。
 *
 * 用途：验证悬浮窗在 Windows 上的真实行为——只跑一次、结果来自进程本身，
 * 而不是靠读代码猜。渲染进程用 --remote-debugging-port，主进程用 --inspect。
 *
 * 用法：
 *   node tools/cdp-eval.mjs 9222 "document.title"
 *   node tools/cdp-eval.mjs 9230 "require('electron').BrowserWindow.getAllWindows().length"
 *
 * 只依赖 Node 24 自带的 fetch / WebSocket，不给仓库加任何依赖。
 */
const port = Number(process.argv[2] || 9222);
const expression = process.argv[3] || '1+1';

async function targetUrl() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = await res.json();
  // 主进程 inspector 的 target 没有 type=page；渲染进程挑第一个 page
  const target = list.find((t) => t.type === 'page') || list[0];
  if (!target || !target.webSocketDebuggerUrl) throw new Error('no debuggable target');
  return target.webSocketDebuggerUrl;
}

const wsUrl = await targetUrl();
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
});

let id = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
function send(method, params) {
  const next = ++id;
  return new Promise((resolve) => {
    pending.set(next, resolve);
    ws.send(JSON.stringify({ id: next, method, params }));
  });
}

const out = await send('Runtime.evaluate', {
  expression: `(async () => { ${expression} })()`,
  awaitPromise: true,
  returnByValue: true,
});
if (out.result && out.result.exceptionDetails) {
  console.error('EXCEPTION:', JSON.stringify(out.result.exceptionDetails, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(out.result && out.result.result ? out.result.result.value : out, null, 2));
}
ws.close();